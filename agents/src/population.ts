// Keeps N agent slots running, and assembles the run-wide view for the API.

import { Agent, type SpeechSink } from "./agent/agent.ts";
import { Llm, type LlmHealth, type SpendGate } from "./agent/llm.ts";
import type { GameData } from "./game/gameData.ts";
import type { Config } from "./config.ts";
import type { EventLog } from "./events.ts";
import type { LifeStore } from "./lifestore.ts";
import type { MapCellTuple, MapResponse, PlayerView, StateResponse } from "./api-types.ts";

/** Shared across runs (owned by RunController). All optional. */
export interface PopulationExtras {
  /** lives/lineages/traits store; decorates agent and player views */
  lives?: LifeStore;
  /** rolling daily spend gate for this run's LLM */
  spend?: SpendGate & { last24hUsd(): number; resumesAt(): number | null };
  /** called once when the run halts */
  onHalt?: (reason: string) => void;
  /** LLM provider health, shared across runs (backoff survives a run restart) */
  llmHealth?: LlmHealth;
}

/** cells kept in the run's merged map (~100 bytes each) */
export const MAP_MAX_CELLS = 200_000;
const MAP_CACHE_MS = 2000;

interface PendingSay {
  speaker: Agent | null;
  text: string;
  x: number;
  y: number;
  hearers: Set<string>;
  timer: NodeJS.Timeout;
}

export class Population implements SpeechSink {
  readonly agents: Agent[] = [];
  readonly llm: Llm;
  startedAt = Date.now();
  started = false;
  private merged = new Map<string, { biome: number; floor: number; obj: number; t: number }>();
  /** where our living characters were last seen (map centre while nobody is alive) */
  private lastCenters: { x: number; y: number }[] = [];
  private mapCache: { at: number; radius: number; body: MapResponse } | null = null;
  private births = 0;
  private deaths = 0;
  private pendingSays = new Map<string, PendingSay>();
  halted = false;
  haltReason: string | null = null;
  private limitTimer: NodeJS.Timeout | null = null;
  /** non-null while LLM calls are paused by the daily cap (for pause/resume events) */
  private pausedFor: string | null = null;
  /** true while we've announced that the LLM provider is failing */
  private llmDownAnnounced = false;

  constructor(private cfg: Config, private gd: GameData, private log: EventLog, private extras: PopulationExtras = {}) {
    this.llm = new Llm(cfg, extras.spend, extras.llmHealth);
    log.on("event", (e) => {
      if (e.kind === "birth") {
        this.births++;
        const gen = Number(e.data?.generation ?? 0);
        // continuous mode: no generation / lives halts
        if (!cfg.continuous) {
          if (gen > cfg.maxGeneration) this.halt(`generation ${gen} was born (limit ${cfg.maxGeneration})`);
          else if (this.births >= cfg.maxLives) this.halt(`${this.births} lives (limit ${cfg.maxLives})`);
        }
      }
      if (e.kind === "death") this.deaths++;
    });
  }

  async start() {
    if (this.started || this.halted) return;
    this.started = true;
    this.startedAt = Date.now();
    this.log.emitEvent("system", {
      text: `run started: ${this.cfg.agentCount} agents, model ${this.cfg.llmModel}, memory ${this.cfg.memoryMode}, recipe hints ${this.cfg.recipeHints ? "on" : "off"}`,
    });
    this.limitTimer = setInterval(() => this.checkLimits(), 5000);
    for (let i = 0; i < this.cfg.agentCount && !this.halted; i++) {
      const a = new Agent(`a${String(i + 1).padStart(2, "0")}`, this.cfg, this.gd, this.llm, this.log, this);
      this.agents.push(a);
      a.run();
      // stagger logins: first is Eve, later ones get born to living women
      await new Promise((r) => setTimeout(r, this.cfg.loginStaggerMs));
    }
  }

  stop() {
    for (const a of this.agents) a.stop();
  }

  /** Run limits (every 5s). Continuous mode skips the runtime limit; the daily cap pauses instead of halting. */
  private checkLimits() {
    const mins = (Date.now() - this.startedAt) / 60000;
    if (!this.cfg.continuous && mins >= this.cfg.maxRuntimeMin) return this.halt(`ran ${Math.round(mins)} min (limit ${this.cfg.maxRuntimeMin})`);
    if (this.llm.overRunBudget) return this.halt(`spent $${this.llm.totalCost.toFixed(2)} (limit $${this.cfg.maxCostUsd})`);
    const paused = this.llm.pausedReason;
    if (paused && !this.pausedFor) this.log.emitEvent("system", { text: `paused: ${paused}` });
    else if (!paused && this.pausedFor) this.log.emitEvent("system", { text: "resumed: daily spend window has room again" });
    this.pausedFor = paused;
    const h = this.llm.health.status();
    if (!h.ok && h.consecutiveFailures >= 2 && !this.llmDownAnnounced) {
      this.llmDownAnnounced = true;
      this.log.emitEvent("system", { text: `LLM provider failing (${h.lastError ?? "error"}); agents are idle until it recovers` });
      console.error(`LLM provider failing: ${h.lastError}`);
    } else if (h.ok && this.llmDownAnnounced) {
      this.llmDownAnnounced = false;
      this.log.emitEvent("system", { text: "LLM provider recovered" });
    }
  }

  // Speech: the speaker's own echo and other agents' PS messages arrive within
  // a frame or two of each other. Collect hearers for 1.5s, then emit one
  // "say" event with heardBy.
  spoke(speaker: Agent, text: string, x: number, y: number) {
    const id = speaker.world?.selfId;
    if (id == null) return;
    const e = this.pending(id, text);
    e.speaker = speaker;
    e.x = x;
    e.y = y;
  }

  heard(hearer: Agent, speakerPlayerId: number, text: string) {
    this.pending(speakerPlayerId, text).hearers.add(hearer.id);
  }

  private pending(speakerPlayerId: number, text: string): PendingSay {
    const key = `${speakerPlayerId}|${text}`;
    let e = this.pendingSays.get(key);
    if (!e) {
      e = {
        speaker: null, text, x: 0, y: 0, hearers: new Set(),
        timer: setTimeout(() => {
          this.pendingSays.delete(key);
          // only lines spoken by our agents become events (no humans on this server)
          if (e!.speaker) e!.speaker.emit("say", text, { playerId: speakerPlayerId, x: e!.x, y: e!.y, heardBy: [...e!.hearers] });
        }, 1500),
      };
      this.pendingSays.set(key, e);
    }
    return e;
  }

  /** Ends the run: disconnects every agent and stops all LLM calls. */
  halt(reason: string) {
    if (this.halted) return;
    this.halted = true;
    this.haltReason = reason;
    if (this.limitTimer) clearInterval(this.limitTimer);
    this.stop();
    this.log.emitEvent("system", { text: `run halted: ${reason}` });
    console.log(`run halted: ${reason}`);
    this.extras.onHalt?.(reason);
  }

  private mergeMaps() {
    for (const a of this.agents) {
      const w = a.world;
      if (!w) continue;
      for (const [k, c] of w.cells) {
        const m = this.merged.get(k);
        if (!m || m.t < c.t) this.merged.set(k, { biome: c.biome >= 0 ? c.biome : m?.biome ?? -1, floor: c.floor, obj: c.obj.id, t: c.t });
      }
    }
    // an always-on run explores forever: keep the most recently seen cells only
    if (this.merged.size > MAP_MAX_CELLS * 1.1) {
      const keep = [...this.merged].sort((a, b) => b[1].t - a[1].t).slice(0, MAP_MAX_CELLS);
      this.merged = new Map(keep);
    }
  }

  /**
   * Union of what our agents have seen near our living characters (or, while
   * nobody is alive, near where they were last). Cached briefly: every viewer
   * polls this, and merging walks every agent's cells.
   */
  map(radius = 60, now = Date.now()): MapResponse {
    if (this.mapCache && this.mapCache.radius === radius && now - this.mapCache.at < MAP_CACHE_MS) return this.mapCache.body;
    this.mergeMaps();
    let centers: { x: number; y: number }[] = this.agents
      .filter((a) => a.status === "alive")
      .map((a) => a.world?.self)
      .filter((s): s is NonNullable<typeof s> => !!s)
      .map((s) => ({ x: s.x, y: s.y }));
    if (centers.length) this.lastCenters = centers;
    else centers = this.lastCenters;
    const cells: MapCellTuple[] = [];
    const names: Record<number, string> = {};
    for (const [k, c] of this.merged) {
      const [x, y] = k.split(",").map(Number);
      if (centers.length && !centers.some((s) => Math.abs(s.x - x) <= radius && Math.abs(s.y - y) <= radius)) continue;
      cells.push([x, y, c.biome, c.floor, c.obj]);
      if (c.obj && !names[c.obj]) names[c.obj] = this.gd.name(c.obj);
      if (c.floor && !names[c.floor]) names[c.floor] = this.gd.name(c.floor);
    }
    const body = { cells, names };
    this.mapCache = { at: now, radius, body };
    return body;
  }

  state(): StateResponse {
    const agentsByPlayer = new Map<number, string>();
    for (const a of this.agents) if (a.status === "alive" && a.world?.selfId != null) agentsByPlayer.set(a.world.selfId, a.id);

    const players = new Map<number, PlayerView & { seen: number }>();
    for (const a of this.agents) {
      const w = a.world;
      if (!w || a.status !== "alive") continue;
      for (const p of w.players.values()) {
        const prev = players.get(p.id);
        if (prev && prev.seen >= p.lastSeen) continue;
        let held: string | null = null;
        if (p.held.id < 0) held = `baby #${-p.held.id}`;
        else if (p.held.id > 0) held = this.gd.describeStack(p.held);
        players.set(p.id, {
          id: p.id, x: w.posOf(p)[0], y: w.posOf(p)[1], age: Math.round(w.currentAge(p) * 10) / 10, female: p.female,
          name: p.name ?? w.names.get(p.id) ?? null, held, agentId: agentsByPlayer.get(p.id) ?? null, dying: p.dying, seen: p.lastSeen,
          moving: p.moving && Date.now() < p.moveEndsAt, displayId: p.displayId,
          ...(this.extras.lives?.playerFields(p.id) ?? { lifeId: null, lineageId: null }),
        });
      }
    }
    const lives = this.extras.lives;
    const views = this.agents.map((a) => {
      const v = a.view();
      return { ...v, ...(lives?.agentFields(this.cfg.runId, v.agentId, v.playerId) ?? { lifeId: null, lineageId: null, traits: null }) };
    });
    const alive = views.filter((v) => v.status === "alive");
    const pauseReason = this.halted ? null : this.llm.pausedReason;
    return {
      run: {
        id: this.cfg.runId, startedAt: this.startedAt, model: this.cfg.llmModel, memoryMode: this.cfg.memoryMode,
        recipeHints: this.cfg.recipeHints, targetPopulation: this.cfg.agentCount,
        status: this.halted ? "halted" : !this.started ? "idle" : pauseReason ? "paused" : "running", haltReason: this.haltReason,
        limits: { maxGeneration: this.cfg.maxGeneration, maxLives: this.cfg.maxLives, maxRuntimeMin: this.cfg.maxRuntimeMin, maxCostUsd: this.cfg.maxCostUsd },
        continuous: this.cfg.continuous,
        pauseReason: this.started ? pauseReason : null,
        resumesAt: this.started && pauseReason ? this.extras.spend?.resumesAt() ?? null : null,
        dailySpend: { last24hUsd: Math.round((this.extras.spend?.last24hUsd() ?? 0) * 10000) / 10000, capUsd: this.cfg.dailyCostUsd },
        llmStatus: this.llm.health.status(),
      },
      traitDims: this.cfg.traitDims,
      traitSource: this.cfg.traitSource,
      now: Date.now(),
      agents: views,
      players: [...players.values()].map(({ seen, ...p }) => p),
      stats: {
        alive: alive.length,
        totalBirths: this.births,
        totalDeaths: this.deaths,
        maxGeneration: Math.max(0, ...alive.map((v) => v.generation ?? 0)),
        families: new Set(alive.map((v) => v.eveId).filter((x) => x != null)).size,
        llmCalls: this.llm.calls,
        llmCostUsd: Math.round(this.llm.totalCost * 10000) / 10000,
      },
    };
  }
}
