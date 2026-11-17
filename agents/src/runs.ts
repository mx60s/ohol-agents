// Owns the current run. A run = one EventLog + one Population + narrator.
// Starting after a halt creates a fresh run in the same process, with fresh
// login emails (so it doesn't resume the old run's abandoned characters).

import { EventEmitter } from "node:events";
import type { Config } from "./config.ts";
import type { GameData } from "./game/gameData.ts";
import { EventLog } from "./events.ts";
import { Population } from "./population.ts";
import { Narrator } from "./narrator.ts";
import type { Focus, RunEvent } from "./api-types.ts";
import { Director } from "./director.ts";
import { StoryKeeper } from "./story.ts";
import { LifeStore } from "./lifestore.ts";
import { SpendLedger } from "./spend.ts";
import { LlmHealth } from "./agent/llm.ts";
import { mkdirSync } from "node:fs";
import path from "node:path";

export class RunController extends EventEmitter {
  pop!: Population;
  log!: EventLog;
  private narrator: Narrator | null = null;
  private director: Director | null = null;
  /** "story so far": one per process, spans runs, persisted in LOG_DIR */
  readonly story: StoryKeeper;
  private runCount = 0;
  runId: string | null = null;
  private pastRunsCost = 0;
  /** lives / lineages / traits, across runs and restarts (LOG_DIR/research) */
  readonly lives: LifeStore;
  /** LLM spend, rolling 24h, across runs and restarts (LOG_DIR/research/spend.jsonl) */
  readonly spend: SpendLedger;
  /** LLM provider health/backoff, shared by every run so a restart doesn't hammer a failing provider */
  readonly llmHealth = new LlmHealth();

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
    return this.pastRunsCost + this.pop.llm.totalCost;
  }

  get openControl() {
    return this.cfg.openControl;
  }

  get maxTotalCostUsd() {
    return this.cfg.maxTotalCostUsd;
  }

  constructor(private cfg: Config, private gd: GameData) {
    super();
    const researchDir = path.join(cfg.logDir, "research");
    mkdirSync(researchDir, { recursive: true });
    this.spend = new SpendLedger({ file: path.join(researchDir, "spend.jsonl") });
    this.spend.load();
    this.lives = new LifeStore({ logDir: cfg.logDir, dims: cfg.traitDims, mutationSd: cfg.traitMutationSd, traitSource: cfg.traitSource });
    const n = this.lives.load();
    this.lives.startTimers();
    console.log(`research: ${n} lives loaded; $${this.spend.spent().toFixed(2)} spent in the last 24h${cfg.continuous ? "; CONTINUOUS mode" : ""}`);
    this.story = new StoryKeeper(
      {
        llm: () => (this.cfg.llmApiKey ? this.pop.llm : null),
        canSpend: () =>
          this.pop.started && !this.pop.halted && !(this.cfg.maxTotalCostUsd > 0 && this.totalCost >= this.cfg.maxTotalCostUsd) &&
          !this.spend.blocked(this.cfg.dailyCostUsd),
        runId: () => this.runId,
        agents: () => this.pop.state().agents,
      },
      { intervalMs: cfg.storyIntervalMs, model: cfg.storyModel, logDir: cfg.logDir },
    );
    this.on("event", (e: RunEvent) => this.story.observe(e));
    this.story.start();
    this.create();
  }

  /** New idle run. Run ids look like "pilot1-r3-lq2x9" (base-36 timestamp). */
  private create() {
    this.narrator?.stop();
    if (this.pop) this.pastRunsCost += this.pop.llm.totalCost;
    this.runCount++;
    const runId = (this.runId = `${this.cfg.runId}-r${this.runCount}-${Date.now().toString(36)}`);
    const cfg: Config = { ...this.cfg, runId };
    this.log = new EventLog(cfg.logDir, runId, Math.max(0, cfg.logMaxFileMb) * 1024 * 1024);
    this.log.on("event", (e: RunEvent) => this.emit("event", e));
    this.lives.attach(this.log, runId);
    this.pop = new Population(cfg, this.gd, this.log, {
      lives: this.lives,
      spend: this.spendGate(),
      llmHealth: this.llmHealth,
      // the run's characters stay in the world, unplayed
      onHalt: () => this.lives.markRunLost(runId),
    });
    this.narrator = cfg.narratorIntervalMs > 0 ? new Narrator(this.pop, this.log, this.pop.llm, cfg.narratorIntervalMs, cfg.narratorModel) : null;
    this.narrator?.start();
    this.director?.stop();
    this.director = cfg.directorIntervalMs > 0 ? this.makeDirector(cfg, this.pop, this.log) : null;
    console.log(`run ${runId}: logs -> ${this.log.dir}`);
  }

  private makeDirector(cfg: Config, pop: Population, log: EventLog): Director {
    const d = new Director(
      {
        state: () => pop.state(),
        // same client as the agents, so its spend counts toward the run's cost and caps
        llm: cfg.llmApiKey
          ? {
              chat: (m, o) => pop.llm.chat(m, o),
              get overBudget() {
                return pop.llm.overBudget || pop.halted;
              },
            }
          : null,
        emitFocus: (e) => log.emitEvent("focus", e),
        record: (r) => log.write("director.jsonl", r),
      },
      { intervalMs: cfg.directorIntervalMs, minDwellMs: cfg.directorMinDwellMs, deathHoldMs: cfg.directorDeathHoldMs, model: cfg.directorModel ?? cfg.llmModel },
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
    return "started";
  }

  halt(reason: string): string {
    if (!this.pop.started || this.pop.halted) return "not running";
    this.pop.halt(reason);
    return "halted";
  }

  shutdown() {
    this.log.emitEvent("system", { text: "process stopping" });
    this.pop.stop();
    this.narrator?.stop();
    this.director?.stop();
    this.story.stop();
    if (this.runId) this.lives.markRunLost(this.runId);
    this.lives.close();
  }
}
