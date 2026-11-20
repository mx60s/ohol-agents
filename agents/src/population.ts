// Keeps N agent slots running, and assembles the run-wide view for the API.

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Agent, type SpeechSink } from "./agent/agent.ts";
import { Llm, type LlmHealth, type SpendGate } from "./agent/llm.ts";
import type { GameData } from "./game/gameData.ts";
import type { Config } from "./config.ts";
import type { EventLog } from "./events.ts";
import type { LifeStore } from "./lifestore.ts";
import type { LeadershipResponse, MapCellTuple, MapResponse, MinimapResponse, PlayerView, StateResponse } from "./api-types.ts";
import { buildLeadership } from "./leadership.ts";
import { GraveBook, type Player, type TriedNothing, type World } from "./game/world.ts";
import { LoginScheduler, type LoginDeps } from "./logins.ts";
import { LANGUAGES_MIN_PLAYERS } from "./agent/observe.ts";
import { FileClockPort, TurnCoordinator, type ClockPort } from "./turnclock.ts";
import { LiveTesterGoals, taskFor } from "./agent/tester.ts";

/** positions.jsonl without the turn clock: one snapshot this often */
export const POSITIONS_INTERVAL_MS = 10_000;

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
  /** TURN_CLOCK=1: the game server's clock files (default: FileClockPort in cfg.clockDir) */
  clockPort?: ClockPort;
  /** the server's mtsBirthReady.txt (default: read from cfg.clockDir); null = not available */
  birthReady?: () => BirthReady | null;
}

/** mtsBirthReady.txt (server/patches/wait-for-mothers.patch): women who could take a baby now, soonest cooldown end (game s, 0 = none) */
export interface BirthReady {
  ready: number;
  soonest: number;
}

/** the server rewrites it at least every 3 s; older than this = the server isn't writing it (setting off, or down) */
export const BIRTH_READY_STALE_MS = 30_000;

/** Reads `<dir>/mtsBirthReady.txt`; null when missing, unreadable or stale. */
export function readBirthReady(dir: string, nowMs = Date.now()): BirthReady | null {
  try {
    const f = path.join(dir, "mtsBirthReady.txt");
    if (nowMs - statSync(f).mtimeMs > BIRTH_READY_STALE_MS) return null;
    const [r, s] = readFileSync(f, "utf8").trim().split(/\s+/).map(Number);
    if (!Number.isFinite(r)) return null;
    return { ready: r, soonest: Number.isFinite(s) ? s : 0 };
  } catch {
    return null;
  }
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

/** a try that did nothing is relayed only from people this old or older (a baby's flailing is not news) */
export const TRIED_MIN_AGE = 3;

/**
 * A try by `from`'s character that changed nothing (Body.lastNoop): every other
 * living agent's World gets it (World.seeTried shows it if the actor is within
 * its view). Nothing from a baby under TRIED_MIN_AGE.
 */
export function relayTried(agents: readonly { status: string; world: World | null }[], from: { world: World | null }, t: TriedNothing) {
  const w = from.world, me = w?.self;
  if (!w || !me || w.dead || w.currentAge(me) < TRIED_MIN_AGE) return;
  for (const a of agents) {
    if (a === from || a.status !== "alive" || !a.world || a.world.selfId === me.id) continue;
    try {
      a.world.seeTried(me.id, t);
    } catch (e) {
      console.error("relayTried", e);
    }
  }
}

export const agentIdOf = (i: number) => `a${String(i + 1).padStart(2, "0")}`;

/** cells kept in the run's merged map (~100 bytes each) */
export const MAP_MAX_CELLS = 200_000;
const MAP_CACHE_MS = 2000;
/** the minimap overview: samples sent at most, and how long one is reused */
const MINIMAP_MAX_BLOCKS = 15_000;
const MINIMAP_CACHE_MS = 10_000;
/** how often the never-forgotten explored map is written to disk */
const EXPLORED_SAVE_MS = 60_000;

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
  /** tester mode task lists, editable live (TESTER_GOALS_FILE) */
  private testerGoalsLive: LiveTesterGoals | null = null;
  private get testerGoals(): LiveTesterGoals {
    return (this.testerGoalsLive ??= new LiveTesterGoals(
      this.cfg.testerGoals ?? [],
      this.cfg.testerGoals?.length ? this.cfg.testerGoalsFile || path.join(this.cfg.logDir, "research", "tester-goals.json") : null,
    ));
  }
  private births = 0;
  private deaths = 0;
  private pendingSays = new Map<string, PendingSay>();
  /** what each of our characters actually said lately (the server's echo), for speechScrambled */
  private recentSpoken = new Map<number, { t: number; text: string }[]>();
  halted = false;
  haltReason: string | null = null;
  private limitTimer: NodeJS.Timeout | null = null;
  private positionsTimer: NodeJS.Timeout | null = null;
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
  /** TURN_CLOCK=1: paces every agent in lockstep turns (turnclock.ts) */
  turns: TurnCoordinator | null = null;

  constructor(private cfg: Config, private gd: GameData, private log: EventLog, private extras: PopulationExtras = {}) {
    this.llm = new Llm(cfg, extras.spend, extras.llmHealth);
    // narrator, story, director: their own endpoint when it differs from the agents' (self-hosted agents, OpenRouter overhead)
    this.overheadLlm =
      cfg.overheadBaseUrl === cfg.llmBaseUrl && cfg.overheadApiKey === cfg.llmApiKey
        ? this.llm
        : new Llm({ ...cfg, llmBaseUrl: cfg.overheadBaseUrl, llmApiKey: cfg.overheadApiKey }, extras.spend);
    this.logins = new LoginScheduler(
      cfg,
      { paused: () => this.outage != null || (extras.holdLogins?.() ?? false), familyRoom: () => this.familyRoom(), motherComing: () => this.motherComing(), ...extras.loginDeps },
      extras.resume?.slots ?? [],
    );
    log.on("event", (e) => {
      // a reconnect to a still-open life (agent.ts): the slot is in the world, but nobody was born
      if (e.kind === "system" && e.data?.reconnect === true && e.agentId) return this.logins.onBorn(e.agentId, false);
      if (e.kind === "birth" && e.agentId) {
        if (e.data?.eve === true && this.logins.phase !== "burst") this.lastEveAt = Date.now();
        this.logins.onBorn(e.agentId, e.data?.eve === true);
      }
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
        turnClock: c.turnClock ? { turnGameS: c.turnGameS, decideTimeoutMs: c.turnDecideTimeoutMs, babyIdleTurns: c.babyIdleTurns } : null,
        personalities: c.personalities?.length ? c.personalities : null,
        memorySummary: c.memorySummary ? "notes" : c.memoryYears ? "years" : null, noNewEves: this.noNewEves(),
      },
    });
    this.limitTimer = setInterval(() => this.checkLimits(), 5000);
    if (c.turnClock) {
      this.turns = new TurnCoordinator(this.extras.clockPort ?? new FileClockPort(c.clockDir), () => this.agents, {
        turnGameS: c.turnGameS,
        timeScale: c.timeScale ?? 1,
        decideTimeoutMs: c.turnDecideTimeoutMs,
        babyIdleTurns: c.babyIdleTurns,
        paused: () => !this.playing,
        // the model failing for everyone: hold the world instead of letting it run unplayed
        // (starving reflexes alone don't count as playing)
        holdWhen: (plans) => !this.llm.health.status().ok && !plans.some((p) => (p as { kind?: string } | null)?.kind === "reply"),
        onActEnd: (n, gameTime) => this.logPositions(n, gameTime),
        warn: (text) => {
          this.log.emitEvent("system", { text });
          console.error(text);
        },
      });
    }
    // every slot starts now; the login scheduler decides when each one actually logs in
    this.graves.flowerOf = (pid: number) => this.extras.lives?.flowerLabel(pid) ?? null;
    const hooks = {
      beforeLogin: (a: Agent) => this.logins.beforeLogin(a.id, a.lifeIndex === 0),
      flowerOf: (pid: number) => this.extras.lives?.flowerLabel(pid) ?? null,
      graves: this.graves,
      reconnect: (a: Agent, playerId: number, age: number) => {
        const lives = this.extras.lives;
        if (!lives) return undefined;
        const l = lives.book.reconnectOf(this.cfg.runId, a.id, playerId, Date.now(), age);
        return l ? { lifeIndex: l.lifeIndex } : null;
      },
      lastLifeIndex: (a: Agent) => this.extras.lives?.book.lastLifeIndex(this.cfg.runId, a.id) ?? 0,
      takenSurnames: () => this.extras.lives?.takenSurnames() ?? [],
      familyFirstNames: (playerId: number) => this.extras.lives?.familyFirstNames(this.cfg.runId, playerId) ?? [],
      speechScrambled: (speakerId: number, text: string) => this.speechScrambled(speakerId, text),
      // tester mode: each family's task list, by its founding position in this run (agent/tester.ts)
      ...(c.personalities?.length ? { personality: (playerId: number) => taskFor(c.personalities, this.extras.lives?.founderIndexOf(this.cfg.runId, playerId) ?? null) } : {}),
      ...(c.testerGoals?.length ? { testTask: (playerId: number) => taskFor(this.testerGoals.get(), this.extras.lives?.founderIndexOf(this.cfg.runId, playerId) ?? null) } : {}),
      lifeOf: (a: Agent, playerId: number) => {
        const f = this.extras.lives?.agentFields(this.cfg.runId, a.id, playerId);
        return { lifeId: f?.lifeId ?? null, lineageId: f?.lineageId ?? null };
      },
      turns: this.turns?.link(),
      // a try that did nothing: our other agents nearby see it (beyond human: no client learns of it)
      triedNothing: (from: Agent, t: TriedNothing) => relayTried(this.agents, from, t),
      // the receiver sees the item land at their feet: a notice in their next observation
      gave: (from: Agent, toPlayerId: number, item: string, at: [number, number]) => {
        const to = this.agents.find((x) => x.status === "alive" && x.world?.selfId === toPlayerId);
        const me = from.world?.self;
        if (!to || !me) return;
        // as the receiver knows the giver (a stranger by description)
        const who = to.personRef(me.id);
        to.noteSalient({ reason: `${who} put ${/^[AEIOU]/i.test(item) ? "an" : "a"} ${item} down next to you at (${at[0]}, ${at[1]})`, urgent: false, t: Date.now() });
      },
    };
    for (let i = 0; i < c.agentCount && !this.halted; i++) {
      const a = new Agent(agentIdOf(i), c, this.gd, this.llm, this.log, this, hooks);
      this.agents.push(a);
      void a.run();
    }
    this.turns?.start();
    if (!this.turns) this.positionsTimer = setInterval(() => this.logPositions(null, null), POSITIONS_INTERVAL_MS);
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
    // the clock stays paused at the last target (nothing new is written)
    void this.turns?.stop();
    if (this.positionsTimer) clearInterval(this.positionsTimer);
    this.positionsTimer = null;
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
   * living characters, with ages from the game. When the server writes
   * mtsBirthReady.txt (wait-for-mothers.patch) and no woman can take a baby
   * now: false while one is only on cooldown (a login would be an Eve), true
   * when none is coming (then an Eve is what the server would make anyway).
   */
  familyRoom(): boolean {
    // a login just came out as an Eve: hold joins for a while (we can't see cooldowns; no Eve floods)
    if (this.cfg.eveMinGapMs > 0 && Date.now() < this.lastEveAt + this.cfg.eveMinGapMs) return false;
    let babies = 0, moms = 0, total = 0;
    for (const a of this.agents) {
      const me = a.status === "alive" ? a.world?.self : null;
      if (!me || !a.world) continue;
      const age = a.world.currentAge(me);
      total++;
      if (age < 3) babies++;
      else if (me.female && age >= 14 && age <= 40 && !this.atBirthCap(me.id)) moms++;
    }
    // the server's readiness file (mtsNoCooldownBypass=1): it knows cooldowns. No woman ready but one coming
    // off cooldown: wait for her (a login now would be an Eve). No woman ready or coming: an Eve is right.
    const br = this.birthReady();
    const noEves = this.noNewEves();
    if (br && br.ready <= 0) return br.soonest <= 0 && !noEves;
    if (moms === 0) return !noEves;
    return babies < moms && babies < total - babies;
  }

  /** NO_NEW_EVES, or the live flag file LOG_DIR/research/no-new-eves: a login that would be an Eve keeps waiting */
  noNewEves(): boolean {
    return this.cfg.noNewEves || existsSync(path.join(this.cfg.logDir, "research", "no-new-eves"));
  }

  /** the server's readiness file says no woman can take a baby now, but one comes off cooldown later */
  motherComing(): boolean {
    const br = this.birthReady();
    return !!br && br.ready <= 0 && br.soonest > 0;
  }

  private birthReady(): BirthReady | null {
    return (this.extras.birthReady ?? (() => readBirthReady(this.cfg.clockDir)))();
  }

  /** the server's early birth cap: generation <= earlyMaxGenerations and earlyMaxBabies children already */
  private atBirthCap(playerId: number): boolean {
    if (!(this.cfg.earlyMaxBabies > 0)) return false;
    const lifeId = this.extras.lives?.playerFields(playerId).lifeId;
    const life = lifeId ? this.extras.lives?.get(lifeId) : null;
    if (!life || life.generation > this.cfg.earlyMaxGenerations) return false;
    return (life.childLifeIds?.length ?? 0) >= this.cfg.earlyMaxBabies;
  }
  private lastEveAt = -Infinity;

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
    const said = (this.recentSpoken.get(id) ?? []).filter((s) => now - s.t < this.spokenKeepMs);
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
    const said = (this.recentSpoken.get(speakerId) ?? []).filter((s) => now - s.t < this.spokenKeepMs);
    if (!said.length) return null;
    return !said.some((s) => s.text === text);
  }

  /** turn clock: heard lines stay in observations for 12 turns, which can be minutes of wall time */
  private get spokenKeepMs() {
    return this.cfg.turnClock ? SPOKEN_KEEP_MS * 10 : SPOKEN_KEEP_MS;
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
        // the biome never changes: take it from any view that knows it, even an older one (a newer
        // object-only update from another agent used to leave the cell "unexplored" for good)
        else if (m.biome < 0 && c.biome >= 0) m.biome = c.biome;
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
    // everything ever seen in this world, never evicted (the merged map keeps only recent cells and
    // starts over when the agents service restarts): biomes at 2-tile resolution, saved per run
    this.loadExplored();
    for (const [k, c] of this.merged) {
      if (!(c.biome >= 0)) continue;
      const [x, y] = k.split(",").map(Number);
      const key = `${Math.floor(x / 2) * 2},${Math.floor(y / 2) * 2}`;
      if (!this.explored.has(key)) {
        this.explored.set(key, { biome: c.biome });
        this.exploredDirty = true;
      }
    }
    if (this.exploredDirty && now - this.exploredSavedAt > EXPLORED_SAVE_MS) this.saveExplored(now);
    const body: MinimapResponse = { ...coarseMap(this.explored, MINIMAP_MAX_BLOCKS), runId: this.cfg.runId };
    if (body.block < 2) body.block = 2;
    this.minimapCache = { at: now, body };
    return body;
  }
  /** fresh graves and whose body each is, shared by our agents in this world and saved per run (world.ts GraveBook) */
  private gravesBook: GraveBook | null = null;
  get graves(): GraveBook {
    return (this.gravesBook ??= new GraveBook(path.join(this.cfg.logDir, "research", `graves-${this.cfg.runId}.json`)));
  }
  private explored = new Map<string, { biome: number }>();
  private exploredLoaded = false;
  private exploredDirty = false;
  private exploredSavedAt = 0;
  private get exploredFile() {
    return path.join(this.cfg.logDir, "research", `explored-${this.cfg.runId}.json`);
  }
  private loadExplored() {
    if (this.exploredLoaded) return;
    this.exploredLoaded = true;
    try {
      const arr = JSON.parse(readFileSync(this.exploredFile, "utf8")) as [string, number][];
      for (const [k, b] of arr) if (typeof k === "string" && Number.isFinite(b)) this.explored.set(k, { biome: b });
    } catch {
      // first time for this run (or unreadable): start empty
    }
  }
  private saveExplored(now: number) {
    try {
      mkdirSync(path.dirname(this.exploredFile), { recursive: true });
      const tmp = `${this.exploredFile}.tmp`;
      writeFileSync(tmp, JSON.stringify([...this.explored].map(([k, v]) => [k, v.biome])));
      renameSync(tmp, this.exploredFile);
      this.exploredDirty = false;
      this.exploredSavedAt = now;
    } catch (e) {
      console.error("explored map save failed", e);
    }
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
    const body: MapResponse = { cells, names, runId: this.cfg.runId };
    this.mapCache = { at: now, radius, body };
    return body;
  }

  /** GET /api/leadership: who follows whom among the living, merged across the living agents' views (leadership.ts) */
  leadership(now = Date.now()): LeadershipResponse {
    const views = this.agents.flatMap((a) => (a.status === "alive" && a.world ? [a.world] : []));
    const body = buildLeadership(this.cfg.runId, views, this.extras.lives, now);
    if (!this.cfg.personalities?.length) return body;
    const personalityOf = this.personalityCache();
    const lineageOf = (pid: number) => this.extras.lives?.playerFields(pid).lineageId ?? null;
    return { ...body, people: body.people.map((p) => ({ ...p, personality: personalityOf(lineageOf(p.id)) })) };
  }

  /**
   * Every player some living agent sees, merged across their views: per player id, the
   * freshest sighting (highest lastSeen) and the world that saw it. /api/state and positions.jsonl.
   */
  private mergedPlayers(): Map<number, { p: Player; w: World }> {
    const out = new Map<number, { p: Player; w: World }>();
    for (const a of this.agents) {
      const w = a.world;
      if (!w || a.status !== "alive") continue;
      for (const p of w.players.values()) {
        const prev = out.get(p.id);
        if (prev && prev.p.lastSeen >= p.lastSeen) continue;
        out.set(p.id, { p, w });
      }
    }
    return out;
  }

  /**
   * One compact line in positions.jsonl (docs/data-format.md): after each turn's act window, or
   * every POSITIONS_INTERVAL_MS without the turn clock.
   * {t, turn, gameTime, players: [[id, x, y, age, heldId, moving 0|1], ...]}
   */
  logPositions(turn: number | null, gameTime: number | null) {
    try {
      const players: [number, number, number, number, number, 0 | 1][] = [];
      for (const { p, w } of this.mergedPlayers().values()) {
        const [x, y] = w.posOf(p);
        players.push([p.id, x, y, Math.round(w.currentAge(p) * 10) / 10, p.held.id, w.isWalking(p) ? 1 : 0]);
      }
      if (!players.length) return;
      players.sort((a, b) => a[0] - b[0]);
      this.log.write("positions.jsonl", { t: Date.now(), turn, gameTime, players });
    } catch (e) {
      console.error("positions log failed", e);
    }
  }

  /**
   * The prompted personality (PERSONALITIES) of a family of this run, by lineage id: each Eve's
   * descriptor in founding order, inherited by her descendants. Null when the feature is off or
   * the family isn't one of this run's.
   */
  personalityOfLineage(lineageId: string | null): string | null {
    if (!this.cfg.personalities?.length || !lineageId) return null;
    return taskFor(this.cfg.personalities, this.extras.lives?.founderIndexOfLineage?.(this.cfg.runId, lineageId) ?? null);
  }

  /** personalityOfLineage, memoized for one response (founderIndex walks every life) */
  private personalityCache(): (lineageId: string | null) => string | null {
    const memo = new Map<string, string | null>();
    return (id) => {
      if (!id || !this.cfg.personalities?.length) return null;
      if (!memo.has(id)) memo.set(id, this.personalityOfLineage(id));
      return memo.get(id)!;
    };
  }

  state(): StateResponse {
    const personalityOf = this.personalityCache();
    const agentsByPlayer = new Map<number, string>();
    for (const a of this.agents) if (a.status === "alive" && a.world?.selfId != null) agentsByPlayer.set(a.world.selfId, a.id);

    const players = new Map<number, PlayerView>();
    for (const { p, w } of this.mergedPlayers().values()) {
      let held: string | null = null;
      if (p.held.id < 0) held = `baby #${-p.held.id}`;
      else if (p.held.id > 0) held = this.gd.describeStack(p.held);
      // a wound or sickness is held like an item (it takes the hands)
      const c = p.held.id > 0 ? this.gd.condition(p.held.id) : null;
      const condition = c && c.kind !== "mark" ? { kind: c.kind, name: this.gd.name(p.held.id) } : null;
      const pf = this.extras.lives?.playerFields(p.id) ?? { lifeId: null, lineageId: null, flower: null };
      players.set(p.id, {
        id: p.id, x: w.posOf(p)[0], y: w.posOf(p)[1], age: Math.round(w.currentAge(p) * 10) / 10, female: p.female,
        name: p.name ?? w.names.get(p.id) ?? null, held, agentId: agentsByPlayer.get(p.id) ?? null, dying: p.dying, condition,
        moving: w.isWalking(p), displayId: p.displayId,
        ...pf,
        personality: personalityOf(pf.lineageId),
      });
    }
    // homesick is known only to the character's own agent (the server's private +HOMESICK+ / +HOME+ cues)
    for (const a of this.agents) {
      const self = a.status === "alive" && a.world?.selfId != null ? players.get(a.world.selfId) : undefined;
      if (self && a.world?.homesick) self.homesick = true;
    }
    const lives = this.extras.lives;
    const views = this.agents.map((a) => {
      const v = a.view();
      const f = lives?.agentFields(this.cfg.runId, v.agentId, v.playerId) ?? { lifeId: null, lineageId: null, traits: null, flower: null };
      return { ...v, ...f, personality: personalityOf(f.lineageId) };
    });
    const alive = views.filter((v) => v.status === "alive");
    const dailyPause = this.halted ? null : this.llm.pausedReason;
    const outage = this.halted ? null : this.outage;
    const pauseReason = outage?.reason ?? dailyPause;
    const pauseKind = !this.started ? null : outage ? "llm-outage" : dailyPause ? "daily-cap" : null;
    return {
      run: {
        id: this.cfg.runId, label: this.cfg.runLabel ?? "", startedAt: this.startedAt, model: this.cfg.llmModelName, memoryMode: this.cfg.memoryMode,
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
        ...(this.turns ? { turn: this.turns.info() } : {}),
        personalities: this.cfg.personalities?.length ? [...this.cfg.personalities] : null,
      },
      traitDims: this.cfg.traitDims,
      traitSource: this.cfg.traitSource,
      now: Date.now(),
      agents: views,
      players: [...players.values()],
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
