// Keeps N agent slots running, and assembles the run-wide view for the API.

import { Agent, type SpeechSink } from "./agent/agent.ts";
import { Llm, type LlmHealth, type SpendGate } from "./agent/llm.ts";
import type { GameData } from "./game/gameData.ts";
import type { Config } from "./config.ts";
import type { EventLog } from "./events.ts";
import type { LifeStore } from "./lifestore.ts";
import type { MapCellTuple, MapResponse, MinimapResponse, PlayerView, StateResponse } from "./api-types.ts";
import { LoginScheduler, type LoginDeps } from "./logins.ts";
import { LANGUAGES_MIN_PLAYERS } from "./agent/observe.ts";

/** how long a character's own lines are kept for speechScrambled (heard lines are shown for 90 s) */
const SPOKEN_KEEP_MS = 120_000;

/** Shared across runs (owned by RunController). All optional. */
export interface PopulationExtras {
  /** lives/lineages/traits store; decorates agent and player views */
  lives?: LifeStore;
  /** rolling daily spend gate for this run's LLM */
  spend?: SpendGate & { last24hUsd(): number; resumesAt(): number | null };
  /** called once when the run halts */
  onHalt?: (reason: string) => void;
  /** an LLM outage paused the run: flag lives alive in [from, to] (LifeStore.markOutage) */
  onOutage?: (from: number, to: number) => void;
  /** LLM provider health, shared across runs (backoff survives a run restart) */
  llmHealth?: LlmHealth;
  /** test hook: timing for the login scheduler (default real timers) */
  loginDeps?: Partial<LoginDeps>;
  /**
   * CONTINUOUS: this run is being resumed after a restart (runstate.ts). Its
   * first start keeps startedAt, and the slots with an open life log in right
   * away to reconnect to their bodies instead of going through the starting setup.
   */
  resume?: { startedAt: number | null; slots: string[] };
  /** true = hold every login (the run is extinct and the world may be regenerated, regen.ts) */
  holdLogins?: () => boolean;
}

/** An LLM outage that paused the run (see checkOutage). */
export interface OutagePause {
  /** first outage-class failure */
  since: number;
  /** when the run was paused */
  pausedAt: number;
  reason: string;
}

/** agent slot ids: a01, a02, ... (login emails derive from them) */
/** Known cells ("x,y" -> biome), one sample per block x block tiles, block chosen so there are at most ~maxBlocks. */
export function coarseMap(cells: Map<string, { biome: number }>, maxBlocks: number): MinimapResponse {
  const block = Math.max(1, Math.ceil(Math.sqrt(cells.size / Math.max(1, maxBlocks))));
  const seen = new Map<string, MapCellTuple>();
  for (const [k, c] of cells) {
    if (!(c.biome >= 0)) continue;
    const [x, y] = k.split(",").map(Number);
    const bx = Math.floor(x / block) * block, by = Math.floor(y / block) * block;
    const key = `${bx},${by}`;
    if (!seen.has(key)) seen.set(key, [bx, by, c.biome, 0, 0]);
  }
  return { block, cells: [...seen.values()] };
}

export const agentIdOf = (i: number) => `a${String(i + 1).padStart(2, "0")}`;

/** cells kept in the run's merged map (~100 bytes each) */
export const MAP_MAX_CELLS = 200_000;
const MAP_CACHE_MS = 2000;
/** the minimap overview: samples sent at most, and how long one is reused */
const MINIMAP_MAX_BLOCKS = 15_000;
const MINIMAP_CACHE_MS = 10_000;

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
  /** client for the narrator, story and director (same as `llm` unless OVERHEAD_BASE_URL/keys differ) */
  readonly overheadLlm: Llm;
  startedAt = Date.now();
  started = false;
  private merged = new Map<string, { biome: number; floor: number; obj: number; t: number }>();
  /** where our living characters were last seen (map centre while nobody is alive) */
  private lastCenters: { x: number; y: number }[] = [];
  private mapCache: { at: number; radius: number; body: MapResponse } | null = null;
  private births = 0;
  private deaths = 0;
  private pendingSays = new Map<string, PendingSay>();
  /** what each of our characters actually said lately (the server's echo), for speechScrambled */
  private recentSpoken = new Map<number, { t: number; text: string }[]>();
  halted = false;
  haltReason: string | null = null;
  private limitTimer: NodeJS.Timeout | null = null;
  /** non-null while LLM calls are paused by the daily cap (for pause/resume events) */
  private pausedFor: string | null = null;
  /** true while we've announced that the LLM provider is failing */
  private llmDownAnnounced = false;
  /** non-null while the run is paused by an LLM provider outage */
  outage: OutagePause | null = null;
  private probing = false;
  /** "agentId|playerId" already counted as births (a reconnect after a pause re-announces the same body) */
  private bornPlayers = new Set<string>();
  readonly logins: LoginScheduler;

  constructor(private cfg: Config, private gd: GameData, private log: EventLog, private extras: PopulationExtras = {}) {
    this.llm = new Llm(cfg, extras.spend, extras.llmHealth);
    // narrator, story, director: their own endpoint when it differs from the agents' (self-hosted agents, OpenRouter overhead)
    this.overheadLlm =
      cfg.overheadBaseUrl === cfg.llmBaseUrl && cfg.overheadApiKey === cfg.llmApiKey
        ? this.llm
        : new Llm({ ...cfg, llmBaseUrl: cfg.overheadBaseUrl, llmApiKey: cfg.overheadApiKey }, extras.spend);
    this.logins = new LoginScheduler(
      cfg,
      { paused: () => this.outage != null || (extras.holdLogins?.() ?? false), familyRoom: () => this.familyRoom(), ...extras.loginDeps },
      extras.resume?.slots ?? [],
    );
    log.on("event", (e) => {
      // a reconnect to a still-open life (agent.ts): the slot is in the world, but nobody was born
      if (e.kind === "system" && e.data?.reconnect === true && e.agentId) return this.logins.onBorn(e.agentId, false);
      if (e.kind === "birth" && e.agentId) this.logins.onBorn(e.agentId, e.data?.eve === true);
      if (e.kind === "death" && e.agentId) this.logins.onDied(e.agentId, e.t);
      const pid = Number(e.data?.playerId ?? e.playerId);
      if (e.kind === "birth" && Number.isFinite(pid)) {
        const key = `${e.agentId}|${pid}`;
        if (this.bornPlayers.has(key)) return;
        this.bornPlayers.add(key);
      }
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
    this.startedAt = this.extras.resume?.startedAt ?? Date.now();
    const c = this.cfg;
    this.log.emitEvent("system", {
      text: `${this.extras.resume ? "run resumed after a restart" : "run started"}: ${c.agentCount} agents, model ${c.llmModelName}, memory ${c.memoryMode}, recipe hints ${c.recipeHints ? "on" : "off"}, ` +
        `decision cycle ${c.decisionCycleMs / 1000}s, ${c.initialEves} starting Eves, joins every ~${Math.round(c.joinStaggerMs / 1000)}s`,
      data: {
        agentCount: c.agentCount, model: c.llmModelName, decisionCycleMs: c.decisionCycleMs, babyDecisionIntervalMs: c.babyDecisionIntervalMs,
        initialEves: c.initialEves, joinStaggerMs: c.joinStaggerMs, joinJitter: c.joinJitter,
        respawnDelayMs: [c.respawnDelayMinMs, c.respawnDelayMaxMs], llmOutagePauseMs: c.llmOutagePauseMs,
        llmMaxTokens: c.llmMaxTokens, llmReasoningEffort: c.llmReasoningEffort || null, llmProviderSort: c.llmProviderSort || null,
        llmProviderOrder: c.llmProviderOrder, llmStream: c.llmStream, llmPromptCache: c.llmPromptCache,
        timeScale: (c as Config & { timeScale?: number }).timeScale ?? null,
      },
    });
    this.limitTimer = setInterval(() => this.checkLimits(), 5000);
    // every slot starts now; the login scheduler decides when each one actually logs in
    const hooks = {
      beforeLogin: (a: Agent) => this.logins.beforeLogin(a.id, a.lifeIndex === 0),
      flowerOf: (pid: number) => this.extras.lives?.flowerLabel(pid) ?? null,
      reconnect: (a: Agent, playerId: number, age: number) => {
        const lives = this.extras.lives;
        if (!lives) return undefined;
        const l = lives.book.reconnectOf(this.cfg.runId, a.id, playerId, Date.now(), age);
        return l ? { lifeIndex: l.lifeIndex } : null;
      },
      takenSurnames: () => this.extras.lives?.takenSurnames() ?? [],
      familyFirstNames: (playerId: number) => this.extras.lives?.familyFirstNames(this.cfg.runId, playerId) ?? [],
      speechScrambled: (speakerId: number, text: string) => this.speechScrambled(speakerId, text),
    };
    for (let i = 0; i < c.agentCount && !this.halted; i++) {
      const a = new Agent(agentIdOf(i), c, this.gd, this.llm, this.log, this, hooks);
      this.agents.push(a);
      void a.run();
    }
  }

  /** started, not halted, not paused (LLM outage or daily cap): our characters are being played */
  get playing(): boolean {
    return this.started && !this.halted && !this.outage && !this.llm.pausedReason;
  }

  /** slots with a character in the world or on their way in (a login past the gate) */
  inWorld(): number {
    return this.agents.filter((a) => a.status === "alive" || a.status === "connecting").length;
  }

  stop() {
    this.logins.close();
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
    this.checkOutage();
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

  /**
   * Would a login now be born to a mother rather than forced to be an Eve?
   * True when no fertile woman (14-40) is alive, or helpless babies (< 3)
   * are fewer than fertile women and fewer than everyone else (the server's
   * maxBabyMomRatio / maxBabyAdultRatio of 1.0; see logins.ts). Counts our
   * living characters, with ages from the game.
   */
  familyRoom(): boolean {
    let babies = 0, moms = 0, total = 0;
    for (const a of this.agents) {
      const me = a.status === "alive" ? a.world?.self : null;
      if (!me || !a.world) continue;
      const age = a.world.currentAge(me);
      total++;
      if (age < 3) babies++;
      else if (me.female && age >= 14 && age <= 40) moms++;
    }
    return moms === 0 || (babies < moms && babies < total - babies);
  }

  /**
   * LLM outage pause (every 5 s, from checkLimits). When the provider has been
   * failing with outage-class errors (401/402/403, 5xx, timeouts) for longer
   * than LLM_OUTAGE_PAUSE_S:
   * - the run goes to status "paused" (pauseKind "llm-outage") with a reason;
   * - every agent is disconnected (their characters stay in the world,
   *   unplayed) and the login scheduler holds all logins, so nobody acts on
   *   reflexes alone and no new lives start;
   * - every life of this run alive at any point since the outage began is
   *   flagged outage / validForStudy: false (onOutage -> LifeStore.markOutage).
   * While paused, one tiny probe call goes out whenever the backoff allows.
   * When a call succeeds the pause ends and agents log back in with the same
   * emails (still-living characters are resumed, as after a restart).
   * Wall-clock only: nothing here assumes a game-year length.
   */
  checkOutage(now = Date.now()) {
    if (this.halted || !this.started) return;
    const health = this.llm.health;
    if (this.outage) {
      if (health.status().ok) return this.endOutage(now);
      // flag anyone who became alive since (e.g. a reconnect that raced the pause)
      this.extras.onOutage?.(this.outage.since, now);
      if (!health.unavailable && !this.probing) void this.probe();
      return;
    }
    const since = health.outageSince;
    if (since == null || this.cfg.llmOutagePauseMs <= 0 || now - since < this.cfg.llmOutagePauseMs) return;
    const err = health.status().lastError ?? "error";
    const reason = `LLM provider outage since ${new Date(since).toISOString().slice(11, 19)} UTC (${err}); agents disconnected until it recovers`;
    this.outage = { since, pausedAt: now, reason };
    this.log.emitEvent("system", { text: `paused: ${reason}`, data: { pauseKind: "llm-outage", outageSince: since } });
    console.error(`run paused: ${reason}`);
    for (const a of this.agents) a.conn?.close();
    this.extras.onOutage?.(since, now);
    this.log.write("outages.jsonl", { t: now, event: "paused", since, reason });
  }

  private endOutage(now: number) {
    const o = this.outage!;
    this.outage = null;
    this.extras.onOutage?.(o.since, now);
    this.log.emitEvent("system", { text: `resumed: LLM provider recovered after ${Math.round((now - o.since) / 1000)}s; agents logging back in` });
    this.log.write("outages.jsonl", { t: now, event: "resumed", since: o.since, pausedAt: o.pausedAt });
  }

  /** one minimal call to see whether the provider is back (the outcome updates the shared health) */
  private async probe() {
    this.probing = true;
    try {
      await this.llm.chat([{ role: "user", content: "Reply with OK." }], { maxTokens: 16, json: false });
    } catch {
      // still down; health keeps backing off
    } finally {
      this.probing = false;
    }
  }

  // Speech: the speaker's own echo and other agents' PS messages arrive within
  // a frame or two of each other. Collect hearers for 1.5s, then emit one
  // "say" event with heardBy.
  spoke(speaker: Agent, text: string, x: number, y: number) {
    const id = speaker.world?.selfId;
    if (id == null) return;
    const now = Date.now();
    const said = (this.recentSpoken.get(id) ?? []).filter((s) => now - s.t < SPOKEN_KEEP_MS);
    said.push({ t: now, text });
    this.recentSpoken.set(id, said.slice(-10));
    const e = this.pending(id, text);
    e.speaker = speaker;
    e.x = x;
    e.y = y;
  }

  /**
   * Did the server scramble this line (family languages)? Only with
   * LANGUAGES_MIN_PLAYERS or more players on (all of them are our agents);
   * then the words differ from the speaker's own echo. null = we don't know
   * what the speaker said (not one of ours, or too long ago).
   */
  speechScrambled(speakerId: number, text: string): boolean | null {
    const alive = this.agents.filter((a) => a.status === "alive").length;
    if (alive < LANGUAGES_MIN_PLAYERS) return false;
    const now = Date.now();
    const said = (this.recentSpoken.get(speakerId) ?? []).filter((s) => now - s.t < SPOKEN_KEEP_MS);
    if (!said.length) return null;
    return !said.some((s) => s.text === text);
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
    this.outage = null;
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
  /** the whole explored world, coarse (see MinimapResponse); at most ~MINIMAP_MAX_BLOCKS samples, cached */
  minimap(now = Date.now()): MinimapResponse {
    if (this.minimapCache && now - this.minimapCache.at < MINIMAP_CACHE_MS) return this.minimapCache.body;
    this.mergeMaps();
    const body = coarseMap(this.merged, MINIMAP_MAX_BLOCKS);
    this.minimapCache = { at: now, body };
    return body;
  }
  private minimapCache: { at: number; body: MinimapResponse } | null = null;

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
        // a wound or sickness is held like an item (it takes the hands)
        const c = p.held.id > 0 ? this.gd.condition(p.held.id) : null;
        const condition = c && c.kind !== "mark" ? { kind: c.kind, name: this.gd.name(p.held.id) } : null;
        players.set(p.id, {
          id: p.id, x: w.posOf(p)[0], y: w.posOf(p)[1], age: Math.round(w.currentAge(p) * 10) / 10, female: p.female,
          name: p.name ?? w.names.get(p.id) ?? null, held, agentId: agentsByPlayer.get(p.id) ?? null, dying: p.dying, condition, seen: p.lastSeen,
          moving: p.moving && Date.now() < p.moveEndsAt, displayId: p.displayId,
          ...(this.extras.lives?.playerFields(p.id) ?? { lifeId: null, lineageId: null, flower: null }),
        });
      }
    }
    const lives = this.extras.lives;
    const views = this.agents.map((a) => {
      const v = a.view();
      return { ...v, ...(lives?.agentFields(this.cfg.runId, v.agentId, v.playerId) ?? { lifeId: null, lineageId: null, traits: null, flower: null }) };
    });
    const alive = views.filter((v) => v.status === "alive");
    const dailyPause = this.halted ? null : this.llm.pausedReason;
    const outage = this.halted ? null : this.outage;
    const pauseReason = outage?.reason ?? dailyPause;
    const pauseKind = !this.started ? null : outage ? "llm-outage" : dailyPause ? "daily-cap" : null;
    return {
      run: {
        id: this.cfg.runId, startedAt: this.startedAt, model: this.cfg.llmModelName, memoryMode: this.cfg.memoryMode,
        recipeHints: this.cfg.recipeHints, targetPopulation: this.cfg.agentCount,
        status: this.halted ? "halted" : !this.started ? "idle" : pauseReason ? "paused" : "running", haltReason: this.haltReason,
        limits: { maxGeneration: this.cfg.maxGeneration, maxLives: this.cfg.maxLives, maxRuntimeMin: this.cfg.maxRuntimeMin, maxCostUsd: this.cfg.maxCostUsd },
        continuous: this.cfg.continuous,
        pauseKind,
        pauseReason: this.started ? pauseReason : null,
        resumesAt: !this.started || !pauseKind ? null : pauseKind === "llm-outage" ? this.llm.health.status().retryAt : this.extras.spend?.resumesAt() ?? null,
        dailySpend: { last24hUsd: Math.round((this.extras.spend?.last24hUsd() ?? 0) * 10000) / 10000, capUsd: this.cfg.dailyCostUsd },
        llmStatus: this.llm.health.status(),
        timeScale: this.cfg.timeScale ?? 1,
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
