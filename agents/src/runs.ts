// Owns the current run. A run = one EventLog + one Population + narrator.
// Starting after a halt creates a fresh run in the same process, with fresh
// login emails (so it doesn't resume the old run's abandoned characters).
// CONTINUOUS: the run id survives process restarts (runstate.ts), so a
// restarted service logs back into its still-living characters.

import { EventEmitter } from "node:events";
import type { Config } from "./config.ts";
import type { GameData } from "./game/gameData.ts";
import { EventLog } from "./events.ts";
import { Population, agentIdOf } from "./population.ts";
import { RunStateFile, decideRun, newRunId, readLastSeq, type RunDecision, type RunRecord } from "./runstate.ts";
import { Narrator } from "./narrator.ts";
import type { Focus, RunEvent } from "./api-types.ts";
import { Director } from "./director.ts";
import { JevClient } from "./jev.ts";
import { StoryKeeper } from "./story.ts";
import { InventionLog } from "./inventions.ts";
import { LifeStore } from "./lifestore.ts";
import { SpendLedger } from "./spend.ts";
import { LlmHealth } from "./agent/llm.ts";
import { ExtinctionWatch, parseWorldRegenerated, regenSettingsFromEnv, requestRegen, worldRegeneratedText, type RegenSettings } from "./regen.ts";
import { mkdirSync } from "node:fs";
import path from "node:path";

export class RunController extends EventEmitter {
  pop!: Population;
  log!: EventLog;
  private narrator: Narrator | null = null;
  private director: Director | null = null;
  /** "story so far": one per process, spans runs, persisted in LOG_DIR */
  readonly story: StoryKeeper;
  /** first time each technology item was made, per run; persisted in LOG_DIR (inventions.ts) */
  readonly inventions: InventionLog;
  private runCount = 0;
  runId: string | null = null;
  private pastRunsCost = 0;
  /** lives / lineages / traits, across runs and restarts (LOG_DIR/research) */
  readonly lives: LifeStore;
  /** LLM spend, rolling 24h, across runs and restarts (LOG_DIR/research/spend.jsonl) */
  readonly spend: SpendLedger;
  /** LLM provider health/backoff, shared by every run so a restart doesn't hammer a failing provider */
  readonly llmHealth = new LlmHealth();
  /** CONTINUOUS only: LOG_DIR/research/current-run.json */
  private runState: RunStateFile | null = null;
  private record: RunRecord | null = null;
  /** world regeneration on extinction (regen.ts); null watch = off */
  readonly regen: RegenSettings;
  private watch: ExtinctionWatch | null = null;
  private watchTimer: NodeJS.Timeout | null = null;
  private regenTimeout: NodeJS.Timeout | null = null;
  /** how often the extinction watch samples (the login gate also samples on every login) */
  static readonly WATCH_MS = 5000;
  /** gap left in the event seq on resume (events emitted after the last flushed line) */
  static readonly SEQ_GAP = 1000;

  private spendGate() {
    const cap = this.cfg.dailyCostUsd;
    return {
      onCost: (usd: number) => this.spend.add(usd),
      pausedReason: () => (this.spend.blocked(cap) ? `daily spend cap: $${this.spend.spent().toFixed(2)} in the last 24h (cap $${cap})` : null),
      last24hUsd: () => this.spend.spent(),
      resumesAt: () => this.spend.resumesAt(cap),
    };
  }

  /** LLM spend across every run in this process */
  get totalCost() {
    return this.pastRunsCost + this.pop.llm.totalCost + (this.pop.overheadLlm !== this.pop.llm ? this.pop.overheadLlm.totalCost : 0);
  }

  get openControl() {
    return this.cfg.openControl;
  }

  get maxTotalCostUsd() {
    return this.cfg.maxTotalCostUsd;
  }

  constructor(private cfg: Config, private gd: GameData, regen?: RegenSettings) {
    super();
    this.regen = regen ?? regenSettingsFromEnv(process.env, cfg.continuous);
    const researchDir = path.join(cfg.logDir, "research");
    mkdirSync(researchDir, { recursive: true });
    this.spend = new SpendLedger({ file: path.join(researchDir, "spend.jsonl") });
    this.spend.load();
    this.lives = new LifeStore({ logDir: cfg.logDir, dims: cfg.traitDims, mutationSd: cfg.traitMutationSd, traitSource: cfg.traitSource, timeScale: cfg.timeScale, gameClockLags: cfg.turnClock });
    let decision: RunDecision | null = null;
    let prev: RunRecord | null = null;
    let regenerated: ReturnType<typeof parseWorldRegenerated> = null;
    if (cfg.continuous) {
      this.runState = new RunStateFile(cfg.logDir);
      prev = this.runState.load();
      const flagContent = this.runState.takeNewRunFlagContent();
      const flag = flagContent != null;
      regenerated = parseWorldRegenerated(flagContent);
      decision = decideRun({
        continuous: true, base: cfg.runId, prev, newRun: cfg.newRun || flag,
        gameServerEpoch: cfg.gameServerEpoch || null, resumeAcrossServerRestart: cfg.resumeAcrossServerRestart, now: Date.now(),
      });
      console.log(`run identity: ${decision.reason}${flag ? " (new-run flag)" : ""}`);
    }
    // a resumed run's open lives stay open: their agents log back into the same bodies
    const resumeId = decision?.resumed ? decision.runId : null;
    const slots = new Set(Array.from({ length: cfg.agentCount }, (_, i) => agentIdOf(i)));
    const n = this.lives.load(resumeId ? (l) => l.runId === resumeId && slots.has(l.agentId) : undefined);
    this.lives.startTimers();
    console.log(`research: ${n} lives loaded; $${this.spend.spent().toFixed(2)} spent in the last 24h${cfg.continuous ? "; CONTINUOUS mode" : ""}`);
    this.story = new StoryKeeper(
      {
        llm: () => (this.cfg.overheadApiKey ? this.pop.overheadLlm : null),
        canSpend: () =>
          this.pop.started && !this.pop.halted && !this.pop.outage && !(this.cfg.maxTotalCostUsd > 0 && this.totalCost >= this.cfg.maxTotalCostUsd) &&
          !this.spend.blocked(this.cfg.dailyCostUsd),
        runId: () => this.runId,
        agents: () => this.pop.state().agents,
      },
      { intervalMs: cfg.storyIntervalMs, model: cfg.storyModel, logDir: cfg.logDir },
    );
    this.inventions = new InventionLog(
      gd,
      { runId: () => this.runId, lifeOf: (runId, agentId, playerId) => this.lives.agentFields(runId, agentId, playerId).lifeId },
      { logDir: cfg.logDir },
    );
    this.on("event", (e: RunEvent) => this.story.observe(e));
    this.on("event", (e: RunEvent) => {
      try {
        this.inventions.observe(e);
      } catch (err) {
        console.error("inventions: observe failed", err);
      }
    });
    this.story.start();
    this.create(decision, decision?.resumed ? prev : null);
    if (regenerated) {
      const text = worldRegeneratedText(regenerated);
      console.log(text);
      this.log.emitEvent("system", { text, data: { ...regenerated } });
    }
    if (this.regen.enabled) console.log(`world regeneration on extinction: on (grace ${this.regen.graceMs / 1000}s${this.regen.requestFile ? "" : "; no REGEN_REQUEST_FILE, so requests will fail"})`);
  }

  private saveRecord(patch: Partial<RunRecord>) {
    if (!this.runState || !this.record) return;
    this.record = { ...this.record, ...patch, updatedAt: Date.now() };
    this.runState.save(this.record);
  }

  /**
   * New idle run. Run ids look like "pilot1-r3-lq2x9" (base-36 timestamp).
   * decision (startup, CONTINUOUS): the id to use; resume = the record of the
   * run being resumed (same id, open lives reconnect, event seq continues).
   */
  private create(decision: RunDecision | null = null, resume: RunRecord | null = null) {
    this.narrator?.stop();
    if (this.pop) this.pastRunsCost += this.pop.llm.totalCost + (this.pop.overheadLlm !== this.pop.llm ? this.pop.overheadLlm.totalCost : 0);
    if (decision) this.runCount = decision.runCount;
    else this.runCount++;
    const runId = (this.runId = decision?.runId ?? newRunId(this.cfg.runId, this.runCount, Date.now()));
    const cfg: Config = { ...this.cfg, runId };
    const startSeq = resume ? readLastSeq(resume.eventsDir) + RunController.SEQ_GAP : 0;
    this.log = new EventLog(cfg.logDir, runId, Math.max(0, cfg.logMaxFileMb) * 1024 * 1024, startSeq);
    this.log.on("event", (e: RunEvent) => this.emit("event", e));
    this.lives.attach(this.log, runId);
    const resumeSlots = resume ? this.lives.book.resumeRun(runId) : [];
    if (resume) console.log(`run ${runId}: resumed; reconnecting ${resumeSlots.length ? resumeSlots.join(", ") : "nobody (no open lives)"}; event seq from ${startSeq}`);
    this.pop = new Population(cfg, this.gd, this.log, {
      lives: this.lives,
      spend: this.spendGate(),
      llmHealth: this.llmHealth,
      resume: resume ? { startedAt: resume.startedAt, slots: resumeSlots } : undefined,
      // the run's characters stay in the world, unplayed
      onHalt: () => {
        this.lives.markRunLost(runId);
        this.saveRecord({ halted: true });
      },
      // lives alive during an LLM outage that paused the run are not valid for study
      onOutage: (from, to) => this.lives.markOutage(runId, from, to),
      holdLogins: () => this.watch?.holdLogins(Date.now()) ?? false,
    });
    this.watchExtinction(runId, this.pop);
    this.narrator = cfg.narratorIntervalMs > 0 ? new Narrator(this.pop, this.log, this.pop.overheadLlm, cfg.narratorIntervalMs, cfg.narratorModel) : null;
    this.narrator?.start();
    this.director?.stop();
    this.director = cfg.directorIntervalMs > 0 ? this.makeDirector(cfg, this.pop, this.log) : null;
    console.log(`run ${runId}: logs -> ${this.log.dir}`);
    if (this.runState) {
      const now = Date.now();
      this.record = {
        runId, runCount: this.runCount, createdAt: resume?.createdAt ?? now, startedAt: resume?.startedAt ?? null, halted: false,
        gameServerEpoch: cfg.gameServerEpoch || null, eventsDir: this.log.dir, updatedAt: now,
      };
      this.runState.save(this.record);
    }
  }

  /** A fresh extinction watch for this run (regen.ts); the old run's watch and timers stop. */
  private watchExtinction(runId: string, pop: Population) {
    this.stopWatch();
    this.watch = null;
    if (!this.regen.enabled) return;
    const watch = new ExtinctionWatch(this.regen.graceMs, () => {
      const p = this.lives.runPopulation(runId);
      return { running: pop.playing, everLived: p.total > 0, living: p.living, inWorld: pop.inWorld() };
    });
    this.watch = watch;
    this.watchTimer = setInterval(() => {
      if (watch.due(Date.now())) this.requestWorldRegen(runId, watch);
    }, RunController.WATCH_MS);
    this.watchTimer.unref();
  }

  private stopWatch() {
    if (this.watchTimer) clearInterval(this.watchTimer);
    if (this.regenTimeout) clearTimeout(this.regenTimeout);
    this.watchTimer = this.regenTimeout = null;
  }

  /** The run has been extinct for the grace period: ask the supervisor for a fresh world. */
  private requestWorldRegen(runId: string, watch: ExtinctionWatch) {
    const reason = `no living characters for ${Math.round(this.regen.graceMs / 1000)}s`;
    this.log.emitEvent("system", { text: `world extinct: ${reason}; asking the supervisor to regenerate the world`, data: { worldRegen: "requested", reason } });
    console.log(`world extinct: ${reason}; requesting world regeneration`);
    const err = requestRegen(this.regen, { reason, runId, at: Date.now() });
    if (err) {
      watch.disable();
      this.log.emitEvent("system", { text: `world regeneration unavailable: ${err}; logins resume in the old world`, data: { worldRegen: "failed", error: err } });
      console.error(`world regeneration unavailable: ${err}`);
      return;
    }
    // the supervisor stops this process within seconds; if it never does, let the run go on
    if (this.regenTimeout) clearTimeout(this.regenTimeout);
    this.regenTimeout = setTimeout(() => {
      if (this.watch !== watch) return;
      watch.disable();
      this.log.emitEvent("system", { text: `world regeneration timed out after ${Math.round(this.regen.timeoutMs / 1000)}s; logins resume in the old world`, data: { worldRegen: "timeout" } });
    }, this.regen.timeoutMs);
    this.regenTimeout.unref();
  }

  private makeDirector(cfg: Config, pop: Population, log: EventLog): Director {
    const d = new Director(
      {
        state: () => pop.state(),
        // same client as the agents, so its spend counts toward the run's cost and caps
        llm: cfg.overheadApiKey
          ? {
              chat: (m, o) => pop.overheadLlm.chat(m, o),
              get overBudget() {
                return pop.overheadLlm.overBudget || pop.halted;
              },
            }
          : null,
        // Jev decisions on the same OpenRouter account; usage.cost counts toward the run's cost and caps
        jev: cfg.overheadApiKey
          ? new JevClient({
              apiKey: cfg.overheadApiKey,
              onCost: (usd) => pop.overheadLlm.addCost(usd),
              overBudget: () => pop.overheadLlm.overBudget || pop.halted,
            })
          : null,
        emitFocus: (e) => log.emitEvent("focus", e),
        record: (r) => log.write("director.jsonl", r),
      },
      {
        engine: cfg.directorEngine,
        intervalMs: cfg.directorIntervalMs,
        minDwellMs: cfg.directorMinDwellMs,
        deathHoldMs: cfg.directorDeathHoldMs,
        model: cfg.directorModel,
        jevModel: cfg.directorJevModel,
        switchP: cfg.directorSwitchP,
        switchMargin: cfg.directorSwitchMargin,
        jevWeight: cfg.directorJevWeight,
      },
    );
    log.on("event", (e: RunEvent) => d.observe(e));
    d.start();
    return d;
  }

  /** Stream camera focus for /api/state. */
  focus(): Focus {
    return this.director?.focus ?? { agentId: null, lifeId: null, since: this.pop.startedAt, reason: null };
  }

  /** Start the current run, or a fresh one if the current run already halted. */
  start(): string {
    if (this.pop.started && !this.pop.halted) return "already running";
    if (this.cfg.maxTotalCostUsd > 0 && this.totalCost >= this.cfg.maxTotalCostUsd)
      return `refused: total spend $${this.totalCost.toFixed(2)} reached the $${this.cfg.maxTotalCostUsd} cap (restart the service to reset)`;
    if (this.pop.halted) this.create();
    void this.pop.start();
    if (this.record && this.record.startedAt == null) this.saveRecord({ startedAt: this.pop.startedAt });
    return "started";
  }

  halt(reason: string): string {
    if (!this.pop.started || this.pop.halted) return "not running";
    this.pop.halt(reason);
    return "halted";
  }

  shutdown() {
    // CONTINUOUS: a running run is resumed by the next start, so its characters are not lost, just unplayed for a moment
    const resumable = this.runState != null && !this.pop.halted;
    this.log.emitEvent("system", { text: resumable ? "process stopping (characters stay in the world; a restart reconnects)" : "process stopping" });
    this.pop.stop();
    this.stopWatch();
    this.narrator?.stop();
    this.director?.stop();
    this.story.stop();
    if (this.runId && !resumable) this.lives.markRunLost(this.runId);
    if (resumable) this.saveRecord({});
    this.lives.close();
  }
}
