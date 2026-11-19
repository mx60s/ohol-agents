// One agent slot. Each "life" = one TCP connection = one character from
// birth to death. The slot then logs in again and is born as someone new.

import { Connection } from "../protocol/connection.ts";
import { parseMessage } from "../protocol/messages.ts";
import { World, GraveBook, homesickNotice, type SeenEvent, type TriedNothing } from "../game/world.ts";
import { Body } from "../game/body.ts";
import type { GameData } from "../game/gameData.ts";
import type { Config } from "../config.ts";
import type { EventLog } from "../events.ts";
import type { AgentView } from "../api-types.ts";
import { Llm, llmLogFields, type ChatMessage, type ChatOptions, type LlmResult } from "./llm.ts";
import { YearMemory, summaryMaxTokens } from "./memory.ts";
import { KEPT_MAX, KeptMemory, keptMemoryPath } from "./kept.ts";
import { buildObservation, seenText, thingName } from "./observe.ts";
import { Acquaintances, PeopleView, knownNamesPath, rememberedName } from "./people.ts";
import { foodBonusOf, systemPromptFor } from "./prompt.ts";
import { firstNameKey, mergeSurnames, namingSayAfterStep, reviewSpeech, surnameOf, type NamingContext } from "./naming.ts";
import { parseReply, parseRemember, parseForget, checkActions, sanitizeAction, type Action } from "./reply.ts";
import { stepFailed, stepLabel, seenSnapshot, staleness, type Seen } from "./steps.ts";
import { snapshot, bodyEvents, speechEvent, deathEvent, birthEvent, type Salient, type BodySnapshot } from "./salience.ts";
import { turnClock, realMs } from "./turns.ts";
import { CraftPlanner, craftBudgetMs, runCraft } from "../game/craft.ts";
import { search, searchSection, searchSummary, type SearchResult } from "../game/search.ts";
import { cleanText } from "../safety.ts";
import type { TurnAgent, TurnLink, TurnStatus } from "../turnclock.ts";

export { sanitizeAction, type Action };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** how long to wait for the server's FW (who follows whom) after saying "I FOLLOW ..." */
const FOLLOW_WAIT_MS = 1500;
/** steps whose try-that-did-nothing others nearby see (go, say, search, wait, remember and the craft macro are not) */
const RELAYED_TRIES = new Set(["use", "pick_up", "drop", "swap", "take_out", "give", "feed", "use_on_person"]);

/** Collects who heard each spoken line (see Population). */
export interface SpeechSink {
  spoke(speaker: Agent, text: string, x: number, y: number): void;
  heard(hearer: Agent, speakerPlayerId: number, text: string): void;
}

/** one planner per GameData (building it indexes every transition) */
const planners = new WeakMap<GameData, CraftPlanner>();
function plannerFor(gd: GameData): CraftPlanner {
  let p = planners.get(gd);
  if (!p) planners.set(gd, (p = new CraftPlanner(gd)));
  return p;
}

/** A new WHAT YOU SAW NEARBY line as it goes to the note-taker's transcript (an animal's every step does not: null). */
export function seenForNotes(world: World, gd: GameData, e: SeenEvent, pv?: PeopleView): string | null {
  return e.kind === "animal_move" ? null : seenText(world, gd, e, pv);
}

/**
 * The person a person-targeted action means by "x","y": whoever stands on that tile or nearest
 * to it within 1 tile (now, else where the model saw them when it looked). null = nobody there.
 */
export function personAt(w: World, x: number, y: number, seen?: Map<number, [number, number]> | null): number | null {
  const d = (a: [number, number]) => Math.max(Math.abs(a[0] - x), Math.abs(a[1] - y));
  const pick = (cands: { id: number; d: number }[]) => (cands.length ? cands.sort((a, b) => a.d - b.d || a.id - b.id)[0].id : null);
  const others = [...w.players.values()].filter((p) => p.id !== w.selfId);
  const now = pick(others.map((p) => ({ id: p.id, d: d(w.posOf(p)) })).filter((c) => c.d <= 1));
  if (now != null || !seen) return now;
  return pick(others.flatMap((p) => (seen.has(p.id) ? [{ id: p.id, d: d(seen.get(p.id)!) }] : [])).filter((c) => c.d <= 1));
}

/** Optional hooks from Population (see logins.ts). */
export interface AgentHooks {
  /** awaited before every login: starting setup, respawn delay, run paused */
  beforeLogin?(agent: Agent): Promise<void>;
  /** label of the flower a player wears ("blue daisy"), shown in observations */
  flowerOf?: (playerId: number) => string | null;
  /**
   * After login: is this body our still-open life again (the server resumed it
   * for our email, e.g. after an agents-service restart or an outage pause)?
   * Returns that life's lifeIndex, null = a new character, undefined = unknown
   * (then only a same-process reconnect to the same player id counts).
   */
  reconnect?(agent: Agent, playerId: number, age: number): { lifeIndex: number | null } | null | undefined;
  /** the highest lifeIndex this slot already had in the run (LifeStore), so a new process doesn't restart at 1 */
  lastLifeIndex?(agent: Agent): number;
  /** family surnames any of our lives ever carried, most recent first (LifeStore; naming rule 1, see naming.ts) */
  takenSurnames?(): string[];
  /** first names used in the family of our life with this player id (LifeStore; naming rule 2) */
  familyFirstNames?(playerId: number): string[];
  /** was this heard line scrambled by the server's family languages? null = unknown (see observe.ts) */
  speechScrambled?(speakerId: number, text: string): boolean | null;
  /**
   * Turn clock (TURN_CLOCK=1): the TurnCoordinator paces this agent (decideTurn /
   * actTurn) instead of its own loop; World runs on the coordinator's game-paced clock.
   */
  turns?: TurnLink;
  /** our world-acting step changed nothing (Body.lastNoop): others nearby see the try (World.seeTried) */
  triedNothing?(from: Agent, t: TriedNothing): void;
  /** we put an item down next to another player (give): tell them, if they're one of ours */
  gave?(from: Agent, toPlayerId: number, item: string, at: [number, number]): void;
  /** fresh graves and whose body each is, shared by the agents of this world (world.ts GraveBook) */
  graves?: GraveBook;
}

/** A decision waiting for the act window (turn clock): the parsed reply, or the starving reflex. */
export type TurnPlan = { kind: "reflex" } | Decision;

/** What the model said, parsed (or why it couldn't be). */
type Decision =
  | { kind: "reply"; reply: Record<string, any>; obsBuiltAt: number; obsWorldT?: number }
  | { kind: "unparseable"; reason: string; cut: boolean };

/** Per-process memory of models that ignore the reasoning cap (see cappedDecision). */
export interface CapState {
  /** models that ran out of tokens under the reasoning cap; they get the full budget from then on */
  uncapped: Set<string>;
  /** times each model ran out of tokens under the cap */
  strikes: Map<string, number>;
}
const capState: CapState = { uncapped: new Set(), strikes: new Map() };

/**
 * The call ran out of tokens: finish_reason "length" (OpenAI/OpenRouter;
 * "max_tokens" from Anthropic-style APIs), or nothing visible came back after
 * using the whole budget (some providers don't report the reason).
 */
export function ranOutOfTokens(r: LlmResult, maxTokens: number): boolean {
  if (r.finishReason === "length" || r.finishReason === "max_tokens") return true;
  return !r.text.trim() && r.completionTokens >= maxTokens;
}

/** The reasoning-cap request options for a decision (null = uncapped). */
export function capOptions(
  cfg: Pick<Config, "llmModel" | "llmReasoningCap" | "llmReasoningMaxTokens" | "llmDecisionMaxTokens"> & Partial<Pick<Config, "llmReasoningStyle">>,
  state: CapState = capState,
): ChatOptions | null {
  if (!cfg.llmReasoningCap || state.uncapped.has(cfg.llmModel)) return null;
  // vLLM (self-hosted Qwen): thinking on, budget via thinking_token_budget; OpenRouter: reasoning.max_tokens
  const extra =
    cfg.llmReasoningStyle === "vllm"
      ? { chat_template_kwargs: { enable_thinking: true }, ...(cfg.llmReasoningMaxTokens > 0 ? { thinking_token_budget: cfg.llmReasoningMaxTokens } : {}) }
      : { reasoning: cfg.llmReasoningMaxTokens > 0 ? { max_tokens: cfg.llmReasoningMaxTokens } : { effort: "low" } };
  return { maxTokens: cfg.llmDecisionMaxTokens, extra };
}

/**
 * One decision call. With LLM_REASONING_CAP=1 the model keeps some
 * reasoning, mildly capped: a reasoning budget of LLM_REASONING_MAX_TOKENS
 * (OpenRouter reasoning.max_tokens; 0 = effort "low") inside a total of
 * LLM_DECISION_MAX_TOKENS, leaving room for the visible JSON. Models that
 * ignore the cap can burn the whole budget on reasoning and return nothing
 * (an empty reply with finish_reason "length") or a cut-off reply: then the
 * call is retried once with the full budget, and after two such failures that
 * model stays uncapped. A cut-off reply that still parses is used as is.
 * vLLM style: the retry keeps thinking_token_budget (only the total grows), and
 * the model is never uncapped.
 */
export async function cappedDecision(
  llm: Pick<Llm, "chat">,
  messages: ChatMessage[],
  cfg: Pick<Config, "llmModel" | "llmReasoningCap" | "llmReasoningMaxTokens" | "llmDecisionMaxTokens"> & Partial<Pick<Config, "llmReasoningStyle">>,
  state: CapState = capState,
  onUncapped?: (model: string) => void,
): Promise<LlmResult> {
  const model = cfg.llmModel;
  const capped = capOptions(cfg, state);
  if (!capped) return llm.chat(messages);
  const extra = capped.extra!;
  const r = await llm.chat(messages, capped);
  if (!ranOutOfTokens(r, cfg.llmDecisionMaxTokens) || parseReply(r.text).ok) return r;
  if (cfg.llmReasoningStyle === "vllm") {
    // vLLM enforces thinking_token_budget, so the reply itself didn't fit: retry with the
    // same thinking budget and the full total. Never uncap: without the budget Qwen thinks
    // until LLM_MAX_TOKENS and returns nothing (r5: ~17 s empty replies for every agent,
    // turns slowed from ~8 to ~3 a minute).
    const r2 = await llm.chat(messages, { extra });
    return { ...r2, costUsd: r.costUsd + r2.costUsd, latencyMs: r.latencyMs + r2.latencyMs };
  }
  const strikes = (state.strikes.get(model) ?? 0) + 1;
  state.strikes.set(model, strikes);
  if (strikes >= 2 && !state.uncapped.has(model)) {
    state.uncapped.add(model);
    onUncapped?.(model);
  }
  const r2 = await llm.chat(messages);
  return { ...r2, costUsd: r.costUsd + r2.costUsd, latencyMs: r.latencyMs + r2.latencyMs };
}

const BABY_AGE = 3;
/** action results kept (the observation shows the last 15) */
const HISTORY_MAX = 20;
/** turn clock: wall ms between our SAY messages (the server's flood gap is 1 wall s) */
const SAY_GAP_MS = 1100;

/** thoughts shown back each turn (dated, in full up to the 400-char thought limit) */
const RECENT_THOUGHTS = 3;

export class Agent implements TurnAgent<TurnPlan> {
  status: AgentView["status"] = "waiting";
  lifeIndex = 0;
  world: World | null = null;
  conn: Connection | null = null;
  body: Body | null = null;
  goal: string | null = null;
  /** World.now() of the decision that last set or changed the goal */
  goalSetAt: number | null = null;
  lastThought: string | null = null;
  /** the last few thoughts of this life, newest last, with the World time they were had (shown dated, in full) */
  recentThoughts: { t: number; text: string }[] = [];
  lastAction: string | null = null;
  lastSaid: string | null = null;
  pastLifeNotes: string[] = [];
  history: { t: number; action: string; result: string }[] = [];
  /** the latest hint search, shown in every observation until the next search (or "" clears it), like the client's hint panel */
  lastSearch: SearchResult | null = null;
  /** the note-taker's yearly summary (MEMORY_SUMMARY=1 only; see memory.ts) */
  readonly mem: YearMemory;
  /** what this character chose to remember (the reply's "remember"; kept.ts), saved per agent for the current life */
  readonly kept: KeptMemory;
  private wake: (() => void) | null = null;
  private lastReflexAt = 0;
  private stopped = false;
  /** player id of this slot's previous login in this process, and whether it died */
  private lastPlayerId: number | null = null;
  private lastDied = false;
  /** salient events since the last decision (see salience.ts) */
  private pending: Salient[] = [];
  private lastSnap: BodySnapshot | null = null;
  private knownKids = new Set<number>();
  /** when the current action started; urgent events after this interrupt walks/crafts */
  private actionStartedAt = Infinity;
  /** tiles and people as the model last saw them (built with the observation) */
  private seen: Seen | null = null;
  /** counts lives (logins); the turn coordinator ignores work left over from an earlier one */
  private lifeSeq = 0;
  /** whom this character knows by name (people.ts), saved per agent for the current life */
  readonly acq: Acquaintances;
  /** false while a login hasn't settled which life this is (nothing is learned into the wrong one) */
  private acqLive = false;
  /** graves when no shared book is given (tests, tools) */
  private ownGraves = new GraveBook();
  private get clock() {
    return turnClock(this.cfg);
  }

  constructor(
    readonly id: string,
    private cfg: Config,
    private gd: GameData,
    private llm: Llm,
    private log: EventLog,
    private speech?: SpeechSink,
    private hooks: AgentHooks = {},
  ) {
    const clock = turnClock(cfg);
    this.acq = new Acquaintances(cfg.logDir && cfg.runId ? knownNamesPath(cfg.logDir, cfg.runId, id) : null);
    this.kept = new KeptMemory(cfg.logDir && cfg.runId ? keptMemoryPath(cfg.logDir, cfg.runId, id) : null, cfg.memoryMaxEntries ?? KEPT_MAX);
    this.mem = new YearMemory({
      everyTurns: Math.max(1, Math.floor(cfg.memorySummaryTurns ?? 25)),
      lockstep: !!clock.lockstep,
      cycleMs: clock.cycleMs,
      // the agents' own model, under the same reasoning cap as decisions; plain text, not JSON
      // max_tokens leaves room for the 8 lines after the reasoning budget
      call: (messages) => {
        const cap = capOptions(this.cfg);
        return this.llm.chat(messages, { ...(cap ? { ...cap, maxTokens: summaryMaxTokens(this.cfg.llmDecisionMaxTokens, this.cfg.llmReasoningMaxTokens) } : {}), json: false });
      },
      onDone: (r) =>
        this.log.write("llm.jsonl", {
          t: Date.now(), kind: "summary", agentId: this.id, playerId: this.world?.selfId ?? null, lifeIndex: this.lifeIndex, input: r.input,
          ...(r.ok ? { reply: r.result.text, memory: r.memory, ...llmLogFields(r.result), finishReason: r.result.finishReason } : { error: r.error }),
        }),
    });
  }

  /** this life's memory lines as the model sees them ([] with MEMORY_SUMMARY=0) */
  get memory(): string[] {
    return this.cfg.memorySummary ? this.mem.memory : [];
  }

  get email() {
    return `${this.cfg.runId}-${this.id}@mts.local`;
  }

  stop() {
    this.stopped = true;
    this.status = "waiting";
    this.conn?.close();
  }

  /** Runs lives forever. */
  async run() {
    while (!this.stopped) {
      if (this.hooks.beforeLogin) {
        await this.hooks.beforeLogin(this);
        if (this.stopped) break;
      }
      try {
        await this.live();
      } catch (e) {
        this.log.emitEvent("system", { agentId: this.id, text: `life crashed: ${(e as Error).message}` });
        console.error(this.id, e);
      }
      this.status = "waiting";
      await sleep(5000);
    }
  }

  private nameOf(): string | null {
    return this.world?.self?.name ?? null;
  }

  /** how this character sees people right now (its name rules; people.ts) */
  people(world: World | null = this.world): PeopleView | undefined {
    return world ? new PeopleView(world, this.gd, this.acq, this.hooks.flowerOf) : undefined;
  }

  /** someone as this character would mention them ("#7 AURORA", or a stranger's description) */
  personRef(playerId: number, fallback = "someone"): string {
    return this.people()?.ref(playerId, fallback) ?? fallback;
  }

  /** emit an event attributed to this agent's current character */
  emit(kind: Parameters<EventLog["emitEvent"]>[0], text: string, data?: Record<string, unknown>) {
    this.ev(kind, text, data);
  }

  private ev(kind: Parameters<EventLog["emitEvent"]>[0], text: string, data?: Record<string, unknown>) {
    this.log.emitEvent(kind, { agentId: this.id, playerId: this.world?.selfId ?? null, name: this.nameOf(), text, data });
  }

  private async live() {
    this.status = "connecting";
    this.lifeSeq++;
    const gd = this.gd;
    const turns = this.hooks.turns;
    const world = new World(gd, {
      onSelfDied: (reason, age) => {
        this.ev("death", `${this.nameOf() ?? this.id} died at age ${age.toFixed(1)} (${reason.replace("reason_", "")})`, { playerId: world.selfId, age, reason });
        this.poke();
      },
      onHeard: (h) => {
        if (h.speakerId === world.selfId) {
          // server echo of our own speech = what was actually said (age-truncated)
          this.lastSaid = h.text;
          this.speech?.spoke(this, h.text, h.x, h.y);
        } else {
          if (h.speakerId != null) this.speech?.heard(this, h.speakerId, h.text);
          // a game notice is what the game says; speech and writing are claims (kept apart in the summary)
          if (h.notice) this.mem.notice(`"${h.text}"`);
          else {
            const pv = this.people(world)!;
            const sp = h.speakerId != null ? world.players.get(h.speakerId) : undefined;
            const who = h.speakerId != null ? (sp ? pv.label(sp) : pv.ref(h.speakerId)) : `written words at (${h.x}, ${h.y})`;
            this.mem.heard(`${who}${h.speakerId != null ? " said" : ""}: "${pv.tags(h.text)}"`);
          }
          this.noteSalient(speechEvent(world, h, Date.now(), this.refIn(world)));
        }
      },
      onPlayerDied: (p) => this.noteSalient(deathEvent(world, p, Date.now(), this.refIn(world))),
      onCue: (word, wasHomesick) => this.felt(world, word, wasHomesick),
      // what was seen nearby goes to the note-taker's transcript (an animal's every step does not)
      onSeen: (e) => {
        const line = seenForNotes(world, gd, e, this.people(world));
        if (line) this.mem.saw(line);
      },
    }, turns ? () => turns.now() : undefined);
    world.graveBook = this.hooks.graves ?? this.ownGraves;
    this.acqLive = false;
    this.pending = [];
    this.lastSnap = null;
    this.knownKids = new Set();
    const conn = new Connection({ host: this.cfg.oholHost, port: this.cfg.oholPort, email: this.email });
    conn.on("message", (raw) => {
      try {
        world.handle(parseMessage(raw));
        this.checkWorld(world);
      } catch (e) {
        console.error(this.id, "handle error", raw.type, e);
      }
    });
    conn.on("close", () => this.poke());
    conn.on("error", () => {});
    const res = await conn.connect();
    if (res !== "ACCEPTED") {
      conn.close();
      throw new Error(`login ${res}`);
    }
    this.world = world;
    this.conn = conn;
    this.body = new Body(conn, world, gd);
    this.body.interrupt = () => this.urgentSinceActionStart();
    // results name people (and graves) as this character knows them
    this.body.who = (id, fallback) => this.people(world)!.ref(id, fallback ?? `#${id}`);
    this.body.tileName = (x, y) => thingName(world, gd, this.people(world)!, x, y);
    // where people walk (docs/data-format.md, positions.jsonl)
    this.body.onWalk = (from, to) => this.log.write("positions.jsonl", { t: Date.now(), kind: "walk", id: world.selfId, from, to });

    // wait for our first PU
    for (let i = 0; i < 50 && !world.self; i++) await sleep(100);
    const me = world.self;
    if (!me) throw new Error("no self PU after login");
    await sleep(500); // let lineage/name messages land

    const isEve = me.ancestors.length === 0;
    const age = world.currentAge(me);
    // the server resumed a still-living body for our email: a reconnect, not a birth
    const sameAsBefore = this.lastPlayerId === me.id && !this.lastDied;
    const hinted = this.hooks.reconnect?.(this, me.id, age);
    const resumed = hinted === undefined ? (sameAsBefore ? { lifeIndex: this.lifeIndex } : null) : hinted;
    this.lastPlayerId = me.id;
    this.lastDied = false;
    // whom this character knows: kept across a same-process reconnect, reloaded after a restart, empty for a new life
    if (!resumed) this.acq.reset(me.id);
    else if (!(sameAsBefore && this.acq.playerId === me.id)) this.acq.restore(me.id);
    this.acqLive = true;
    this.acq.sync(world);
    // what it chose to remember: kept across a same-process reconnect, reloaded after a restart (a new life resets it below)
    if (resumed && !(sameAsBefore && this.kept.playerId === me.id)) this.kept.restore(me.id);
    if (resumed) {
      this.lifeIndex = resumed.lifeIndex ?? Math.max(1, this.lifeIndex);
      this.status = "alive";
      if (!sameAsBefore) {
        // a new process: this life's earlier turns are gone from memory
        this.mem.reset();
        this.history = [];
        this.lastSearch = null;
        this.goal = null;
        this.goalSetAt = null;
      }
      this.ev("system", `${this.id} reconnected to ${this.nameOf() ?? `#${me.id}`} (age ${age.toFixed(0)})`, {
        reconnect: true, playerId: me.id, motherId: me.ancestors[0] ?? null, eve: isEve, generation: me.ancestors.length + 1, lifeIndex: this.lifeIndex,
        x: me.x, y: me.y, age: Math.round(age * 100) / 100, female: me.female, displayId: me.displayId,
      });
      this.log.write("lives.jsonl", { t: Date.now(), agentId: this.id, lifeIndex: this.lifeIndex, playerId: me.id, reconnect: true, x: me.x, y: me.y });
      await this.playLife(world, conn);
      return;
    }

    this.lifeIndex = Math.max(this.lifeIndex, this.hooks.lastLifeIndex?.(this) ?? 0) + 1;
    this.status = "alive";
    // persistent memory carries the last life's memory over: what it chose to remember (and the yearly notes if on)
    const carried = [...this.memory, ...this.kept.texts];
    if (this.cfg.memoryMode === "persistent" && carried.length) {
      this.pastLifeNotes.push(...carried);
      this.pastLifeNotes = this.pastLifeNotes.slice(-30);
    }
    this.mem.reset();
    this.kept.reset(me.id);
    this.history = [];
    this.lastSearch = null;
    this.goal = null;
    this.goalSetAt = null;
    this.lastThought = this.lastAction = this.lastSaid = null;
    this.recentThoughts = [];
    this.ev("birth", isEve ? `${this.id} appeared as an Eve (age ${age.toFixed(0)})` : `${this.id} was born to mother #${me.ancestors[0]}`, {
      playerId: me.id, motherId: me.ancestors[0] ?? null, eve: isEve, generation: me.ancestors.length + 1, lifeIndex: this.lifeIndex, x: me.x, y: me.y,
      age: Math.round(age * 100) / 100, female: me.female, displayId: me.displayId,
    });
    this.log.write("lives.jsonl", { t: Date.now(), agentId: this.id, lifeIndex: this.lifeIndex, playerId: me.id, eve: isEve, motherId: me.ancestors[0] ?? null, eveId: me.eveId, x: me.x, y: me.y });
    await this.playLife(world, conn);
  }

  /** decide/act until the character dies or the connection drops */
  private async playLife(world: World, conn: Connection) {
    if (this.hooks.turns) {
      // turn clock: the coordinator calls decideTurn / actTurn; death or a dropped connection pokes us
      while (!this.stopped && !world.dead && !conn.closed) await this.sleepInterruptible(1000);
    }
    while (!this.stopped && !world.dead && !conn.closed) {
      const t0 = Date.now();
      await this.turn();
      await this.betweenTurns(t0);
    }
    this.lastDied = world.dead;
    if (!world.dead && !this.stopped) this.ev("system", `${this.id} lost connection`);
    conn.close();
    this.status = "dead";
    await sleep(3000);
  }

  private poke() {
    this.wake?.();
  }

  private get alive() {
    return !this.stopped && !!this.world && !this.world.dead && !this.conn?.closed;
  }

  /**
   * Pause between decisions. Always at least the minimum interval
   * (decisionIntervalMs; babyDecisionIntervalMs under age 2). A baby with
   * nothing new happening then idles until a salient event or babyIdleMaxMs,
   * so babies don't poll the model for nothing.
   */
  private async betweenTurns(t0: number) {
    const w = this.world!;
    const self = w.self;
    const age = self ? w.currentAge(self) : 0;
    const minMs = age < 2 ? this.cfg.babyDecisionIntervalMs : this.cfg.decisionIntervalMs;
    while (this.alive && Date.now() - t0 < minMs) await sleep(Math.min(250, minMs - (Date.now() - t0)));
    if (age < BABY_AGE && !this.pending.length && this.alive) {
      const rest = this.cfg.babyIdleMaxMs - (Date.now() - t0);
      if (rest > 0) await this.sleepInterruptible(rest);
    }
  }

  /**
   * The server's private cue over our head (World onCue): the stream shows it as an
   * emote (a "+WORD+" say); for the agent it is a feeling, never something it said
   * (not in HEARD, not lastSaid). Homesick: told once, and why; not what it means for births.
   */
  private felt(world: World, word: string, wasHomesick: boolean) {
    const me = world.self;
    const [x, y] = me ? world.posOf(me) : [0, 0];
    this.speech?.spoke(this, `+${word}+`, x, y);
    let text: string | null = null;
    if (word === "HOMESICK") text = homesickNotice(world.homesick);
    else if (word === "HOME" && wasHomesick) text = "You no longer feel homesick: you are back in your family's homeland.";
    if (!text) return;
    this.record("(feeling)", text, false);
    this.mem.notice(text);
    if (word === "HOMESICK") this.noteSalient({ reason: text, urgent: false, t: Date.now() });
  }

  /** Queue a salient event; it wakes an idle agent (the minimum interval still applies). */
  noteSalient(s: Salient | null | undefined) {
    if (!s) return;
    this.pending.push(s);
    if (this.pending.length > 12) this.pending.shift();
    this.poke();
  }

  /** After each server message: food thresholds, being picked up / put down, our newborns. */
  private checkWorld(w: World) {
    const me = w.self;
    if (!me) return;
    if (this.acqLive) this.acq.sync(w);
    const snap = snapshot(w);
    for (const e of bodyEvents(this.lastSnap, snap, w, Date.now(), this.refIn(w))) this.noteSalient(e);
    this.lastSnap = snap;
    for (const p of w.players.values()) {
      if (p.ancestors[0] !== me.id || this.knownKids.has(p.id)) continue;
      this.knownKids.add(p.id);
      this.noteSalient(birthEvent(w, p));
    }
    if (w.dead) this.poke();
  }

  private urgentSinceActionStart(): string | null {
    const u = this.pending.find((p) => p.urgent && p.t >= this.actionStartedAt);
    return u ? u.reason : null;
  }

  private sleepInterruptible(ms: number) {
    return new Promise<void>((resolve) => {
      const t = setTimeout(done, ms);
      function done() {
        clearTimeout(t);
        resolve();
      }
      this.wake = () => {
        this.wake = null;
        done();
      };
    });
  }

  /** One observe -> decide -> act cycle (own pacing; with the turn clock see decideTurn / actTurn). */
  private async turn() {
    this.body!.syncForce();
    if (this.reflexDue() && (await this.reflex())) return;

    if (this.llm.overBudget) {
      await this.sleepInterruptible(10000);
      return;
    }
    const d = await this.think();
    if (!d) {
      // infrastructure failures (HTTP errors, outages, backoff) are logged only: they are not
      // the character's experience and must never reach the model's observation
      await this.sleepInterruptible(3000);
      return;
    }
    await this.apply(d);
  }

  // --- turn clock (TurnAgent): the coordinator decides when we think and act

  turnStatus(): TurnStatus {
    const w = this.world;
    const me = w?.self;
    const ready = this.alive && this.status === "alive" && !!me && !!this.body;
    return { ready, life: this.lifeSeq, baby: ready && w!.currentAge(me!) < BABY_AGE, news: this.pending.length > 0 };
  }

  /** Decide phase (world frozen): the starving reflex or one model call. null = nothing to do this turn. */
  async decideTurn(): Promise<TurnPlan | null> {
    if (!this.alive || !this.body || !this.world?.self) return null;
    this.body.syncForce();
    if (this.reflexDue()) return { kind: "reflex" };
    if (this.llm.overBudget) return null;
    return this.think();
  }

  /** Act phase: run the decision (its steps wait for act windows; a long walk spans several). */
  async actTurn(plan: TurnPlan): Promise<void> {
    if (!this.alive) return;
    await this.hooks.turns?.actWindow();
    if (!this.alive) return;
    this.body!.syncForce();
    if (plan.kind === "reflex") await this.reflex();
    else await this.apply(plan);
  }

  /** The decide phase ended before our reply: it is dropped. */
  tooSlow() {
    if (!this.alive) return;
    this.record("(thinking)", "you were too slow to act this turn; nothing happened");
    this.ev("system", "too slow: reply missed the decide phase and was dropped", { tooSlow: true });
  }

  /**
   * Reflex: about to starve -> grab the nearest hand-pickable food and eat (puts
   * a carried baby down and picks it back up). Logged as a reflex so analysis can
   * separate it from LLM decisions. Not more than every 20 s (world clock).
   */
  private reflexDue(): boolean {
    const world = this.world!;
    const me = world.self!;
    return world.food <= 2 && world.currentAge(me) >= 3 && world.food < world.foodCapacity && world.now() - this.lastReflexAt > 20000;
  }

  /** Runs the reflex; false = no food in reach (then the model decides, e.g. to travel). */
  private async reflex(): Promise<boolean> {
    this.lastReflexAt = this.world!.now();
    const before = this.actionContext();
    const r = await this.body!.forage();
    this.record("forage (reflex: starving)", r);
    this.ev("action", `reflex forage -> ${r}`, { reflex: true, ...this.actionData(before) });
    return !r.startsWith("no food");
  }

  /** Observe and call the model. null = the call failed (logged only). */
  private async think(): Promise<Decision | null> {
    const world = this.world!;
    const body = this.body!;
    const me = world.self!;
    // what woke us / happened since the last decision
    const alerts = this.pending.splice(0).map((s) => s.reason);
    // a year's summary in the background (fire and forget: never awaited here)
    if (this.cfg.memorySummary && !this.llm.overBudget) this.mem.tick(world.now());
    const obsWorldT = world.now();
    let obs = buildObservation(world, this.gd, {
      recipeHints: this.cfg.recipeHints,
      history: this.history,
      search: searchSection(this.lastSearch),
      pastLifeNotes: this.pastLifeNotes,
      memory: this.memory,
      kept: this.kept.entries,
      goal: this.goal,
      goalSetAt: this.goalSetAt,
      lastThought: this.lastThought,
      recentThoughts: this.recentThoughts,
      foodSources: body.foodSources(),
      clock: this.clock,
      now: world.now(),
      foodBonusS: foodBonusOf(this.cfg),
      flowerOf: this.hooks.flowerOf,
      speechScrambled: this.hooks.speechScrambled,
      takenSurnames: me.ancestors.length === 0 && !me.name ? this.takenSurnames() : undefined,
      people: this.acq,
    });
    if (alerts.length) obs += `\n\n== JUST HAPPENED ==\n${[...new Set(alerts)].map((a) => `- ${a}`).join("\n")}`;
    const obsBuiltAt = Date.now(); // turn timing for calibration: observation built -> action dispatched
    // what the model is about to see; checked again when its action runs (staleness)
    this.seen = seenSnapshot(world, world.now());
    const messages: ChatMessage[] = [
      { role: "system", content: systemPromptFor(this.cfg) },
      { role: "user", content: obs + "\n\nWhat do you do next? Reply with JSON only." },
    ];
    let llmRes: LlmResult | undefined;
    try {
      llmRes = await this.decide(messages);
    } catch (e) {
      this.log.write("llm.jsonl", { t: Date.now(), agentId: this.id, playerId: world.selfId, error: String(e) });
      return null;
    }
    this.log.write("llm.jsonl", {
      t: Date.now(), agentId: this.id, playerId: world.selfId, lifeIndex: this.lifeIndex,
      observation: obs, reply: llmRes.text, ...llmLogFields(llmRes), finishReason: llmRes.finishReason,
    });
    const parsed = parseReply(llmRes.text);
    if (!parsed.ok) return { kind: "unparseable", reason: parsed.reason, cut: llmRes.finishReason === "length" };
    return { kind: "reply", reply: parsed.value as Record<string, any>, obsBuiltAt, obsWorldT };
  }

  /** Act on a decision: thought, goal, forget, remember, speech, then the action list ("note" is ignored: the notebook is gone). */
  private async apply(d: Decision) {
    if (d.kind === "unparseable") {
      const cut = d.cut ? " (it was cut off: keep it short)" : "";
      this.record("think", `wasted turn: ${d.reason}${cut}. Reply with one JSON object like {"thought":"...","action":{"type":"go","x":3,"y":4}}`);
      this.ev("system", `unparseable reply: ${d.reason}`, { parseError: true });
      return;
    }
    // model output is untrusted: it reaches the public API, the stream and other prompts
    const reply = d.reply;
    const thought = cleanText(reply.thought, 400);
    if (thought) {
      this.lastThought = thought;
      this.recentThoughts.push({ t: d.obsWorldT ?? this.world?.now() ?? Date.now(), text: thought });
      if (this.recentThoughts.length > RECENT_THOUGHTS) this.recentThoughts.shift();
      this.ev("thought", thought);
    }
    const goal = cleanText(reply.goal, 200);
    if (goal && goal !== this.goal) {
      this.goal = goal;
      this.goalSetAt = d.obsWorldT ?? this.world?.now() ?? Date.now();
    }
    // "forget" first (so a full list can take a new entry without losing the oldest), then "remember"
    const madeAt = d.obsWorldT ?? this.world?.now() ?? Date.now();
    const forget = parseForget(reply);
    if (forget != null) {
      const label = typeof forget === "number" ? `forget ${forget}` : `forget "${forget}"`;
      const r = this.kept.forget(forget);
      const result = r.ok ? `you let go of "${r.text}"` : r.error;
      this.record(label, result, false);
      this.ev("action", `${label} -> ${result}`, { forget: String(forget), ...(r.ok ? { forgotten: r.text } : {}) });
    }
    // "remember": kept verbatim in THINGS YOU CHOSE TO REMEMBER (kept.ts)
    const remember = parseRemember(reply);
    if (remember) {
      const r = this.kept.remember(remember, madeAt);
      let result = r.kind === "already" ? "already remembered" : r.kind === "empty" ? "not kept: no words to keep" : r.dropped != null ? `kept; you forgot the oldest: "${r.dropped}"` : "kept";
      // the old note-taker (MEMORY_SUMMARY=1) still gets it for its next notes
      if (this.cfg.memorySummary) this.mem.remember(remember);
      // a name stated for someone in view ("the woman with the red rose is LIRA"): this character's own name for them
      const pv = this.people();
      const named = pv ? rememberedName(remember, pv) : null;
      if (named && this.acq.learn(named.id, named.name, true)) result += `; you'll know ${named.who} as ${named.name}`;
      this.record(`remember "${remember}"`, result, false);
      this.ev("action", `remember "${remember}" -> ${result}`, { remember, ...(r.kind === "kept" && r.dropped != null ? { dropped: r.dropped } : {}) });
    }
    const say = cleanText(reply.say, 200);
    const checked = checkActions(reply, this.cfg.craftMacro, this.cfg.actionListMax ?? 4);
    // "YOU ARE X" + pick_up_baby: spoken once the baby is in our arms (naming.ts)
    const sayAfter = say && !("error" in checked) ? namingSayAfterStep(say, checked.steps, (this.world?.self?.held.id ?? 0) < 0) : -1;
    this.spokeThisTurn = false;
    if (say && sayAfter < 0) {
      const said = await this.speakSpaced(say);
      this.spokeThisTurn = /^said "/.test(said);
      this.record(`say "${say}"`, said);
    }
    if ("error" in checked) {
      this.record("(no valid action)", checked.error);
      this.ev("system", `invalid action: ${checked.error}`, { invalidAction: true });
      return;
    }
    const deferred = say && sayAfter >= 0 ? { after: sayAfter, say } : undefined;
    await this.runSteps(checked.steps, checked.notes, d.obsBuiltAt, deferred);
  }

  /**
   * Run the reply's steps back to back (one step = a plain single action).
   * Each step's result goes to history. The rest of the list is skipped when
   * a step fails or a salient event arrives (it is listed under JUST
   * HAPPENED next turn), and the skip is recorded with its reason.
   */
  private async runSteps(steps: Action[], notes: string[] = [], obsBuiltAt = Date.now(), deferredSay?: { after: number; say: string }) {
    const listStart = Date.now();
    const n = steps.length;
    let pendingSay = deferredSay;
    const sayDeferred = async () => {
      if (!pendingSay || !this.alive) return;
      const say = pendingSay.say;
      pendingSay = undefined;
      this.record(`say "${say}"`, await this.speakSpaced(say));
    };
    for (let i = 0; i < n; i++) {
      // turn clock: a step starts only while the game clock runs (a long list spans act windows);
      // a search is a lookup, like the client's hint panel: it doesn't wait for one
      if (this.hooks.turns && steps[i].type !== "search") {
        await this.hooks.turns.actWindow();
        if (!this.alive) break;
      }
      const action = steps[i];
      const desc = describeAction(action);
      this.lastAction = desc;
      const before = this.actionContext();
      const startedAt = (this.actionStartedAt = Date.now());
      let result: string;
      try {
        const stale = this.seen ? staleness(this.world!, this.gd, this.seen, action, i === 0) : null;
        this.body?.takeNotes();
        if (this.body) this.body.lastNoop = null;
        result = stale?.skip ? stale.text : `${stale?.text ?? ""}${await this.execute(action)}`;
        const notes = this.body?.takeNotes() ?? [];
        if (notes.length) result += ` (${notes.join("; ")})`;
      } finally {
        this.actionStartedAt = Infinity;
      }
      this.record(stepLabel(desc, i, n), result);
      const noop = this.body?.lastNoop;
      if (noop && RELAYED_TRIES.has(action.type)) this.hooks.triedNothing?.(this, noop);
      // turnMs (calibration): observation built -> the reply's first action dispatched
      const timing = i === 0 ? { turnMs: startedAt - obsBuiltAt } : {};
      if (action.type !== "wait") this.ev("action", `${desc} -> ${result}`, { action, step: n > 1 ? i + 1 : undefined, steps: n > 1 ? n : undefined, ...timing, ...this.actionData(before) });
      if (pendingSay && i >= pendingSay.after) await sayDeferred();
      if (i === n - 1 || !this.alive) break;
      const rest = steps.slice(i + 1).map(describeAction).join(", ");
      const event = this.pending.find((p) => p.t >= listStart);
      const why = stepFailed(result) && action.type !== "search" ? `step ${i + 1} didn't work` : event ? `something happened: ${event.reason}` : null;
      if (why) {
        this.record(`(not done: ${rest})`, `skipped because ${why}`);
        break;
      }
    }
    // the list stopped before the pickup: still say it
    await sayDeferred();
    for (const note of notes) this.record("(actions list)", note);
  }

  /** One decision call, under the mild reasoning cap (see cappedDecision). */
  private decide(messages: ChatMessage[]): Promise<LlmResult> {
    return cappedDecision(this.llm, messages, this.cfg, capState, (model) =>
      this.log.emitEvent("system", { agentId: this.id, text: `model ${model} keeps running out of tokens under the reasoning cap; using the full budget for it from now on` }),
    );
  }

  /**
   * Turn clock: the server drops a second SAY within 1 wall second (its flood gap
   * is wall time in turn mode, docs/turn-clock.md), so space our lines out.
   */
  private async speakSpaced(text: string): Promise<string> {
    if (this.hooks.turns) {
      const gap = SAY_GAP_MS - (Date.now() - this.lastSayAt);
      if (gap > 0) await sleep(gap);
      this.lastSayAt = Date.now();
    }
    const me = this.world?.self;
    const leaderBefore = me ? this.world!.leaders.get(me.id) : undefined;
    const said = this.speak(text);
    if (!me || !/^said "I FOLLOW\b/.test(said)) return said;
    return said + (await this.followedWhom(me.id, leaderBefore));
  }

  /** After "I FOLLOW ...": whom the server's FW message says we now follow (nothing if none came). */
  private async followedWhom(myId: number, before: number | undefined): Promise<string> {
    const w = this.world!;
    const t0 = Date.now();
    while (Date.now() - t0 < FOLLOW_WAIT_MS && w.leaders.get(myId) === before) await sleep(50);
    const l = w.leaders.get(myId);
    if (l == null || l === before) return "";
    // a stranger: as they look (no #id or name)
    if (!this.acq.knows(w, l)) return `; you now follow ${this.personRef(l)}`;
    const p = w.players.get(l);
    const name = p?.name ?? w.names.get(l);
    const lin = p ?? w.lineage.get(l);
    const me = w.self;
    const rel = !lin || !me ? "" : lin.ancestors[0] === myId ? (p && w.currentAge(p) < 3 ? ", your baby" : ", your child") : me.ancestors[0] === l ? ", your mother" : "";
    const age = p ? `, age ${Math.floor(w.currentAge(p))}` : "";
    const own = this.acq.names.get(l);
    const shown = own?.own ? `${own.name} (as you know ${p?.female ? "her" : p?.female === false ? "him" : "them"})` : name;
    return `; you now follow #${l}${shown ? ` ${shown}` : ""}${age || rel ? ` (${(age + rel).slice(2)})` : ""}`;
  }
  private lastSayAt = 0;
  /** this reply's top-level "say" was spoken (a say-only reply records "spoke", not "did nothing") */
  private spokeThisTurn = false;

  /** Say something, after the naming rules (naming.ts): a refused family name isn't sent; a repeated baby name gets a numeral. */
  private speak(text: string): string {
    const r = reviewSpeech(text, this.namingContext());
    if (!r.ok) return r.reason;
    const said = this.body!.say(r.say);
    return r.note ? `${said}: ${r.note}` : said;
  }

  private namingContext(): NamingContext {
    const w = this.world!;
    const me = w.self!;
    const unnamedEve = me.ancestors.length === 0 && !me.name;
    const baby = me.held.id < 0 ? w.players.get(-me.held.id) : undefined;
    const unnamedBaby = baby && !baby.name ? { female: baby.female } : null;
    return {
      unnamedEve,
      unnamedBaby,
      takenSurnames: unnamedEve ? this.takenSurnames() : [],
      familyFirstNames: unnamedBaby ? this.familyFirstNames() : new Set(),
    };
  }

  /** Family surnames used before: our lineage records (all runs) plus every name this character has seen. */
  private takenSurnames(): string[] {
    const w = this.world!;
    const seen = [...w.names.values(), ...w.deaths.map((d) => d.name)].map(surnameOf);
    return mergeSurnames(this.hooks.takenSurnames?.() ?? [], seen);
  }

  /** First names used in this character's family: lineage records plus family members this character has seen. */
  private familyFirstNames(): Set<string> {
    const w = this.world!;
    const me = w.self!;
    const out = new Set<string>(this.hooks.familyFirstNames?.(me.id) ?? []);
    const add = (name: string | null | undefined) => {
      const k = firstNameKey(name);
      if (k) out.add(k);
    };
    add(me.name);
    for (const p of w.players.values()) if (me.eveId != null && p.eveId === me.eveId) add(p.name ?? w.names.get(p.id));
    for (const d of w.deaths) if (me.eveId != null && d.eveId === me.eveId) add(d.name);
    // out of sight now, but named into our family
    const mySurname = surnameOf(me.name);
    if (mySurname) for (const n of w.names.values()) if (surnameOf(n) === mySurname) add(n);
    return out;
  }

  private holdingClothing(): boolean {
    const id = this.world?.self?.held.id ?? 0;
    const c = id > 0 ? this.gd.get(id)?.clothing : undefined;
    return !!c && c !== "n";
  }

  // position and held item before/after an action, for the per-life activity tally (lives.ts)
  private actionContext(): { from: [number, number] | null; heldBefore: string | null } {
    const me = this.world?.self;
    return { from: me ? this.world!.posOf(me) : null, heldBefore: me ? this.body?.heldName(true) ?? null : null };
  }

  private actionData(before: { from: [number, number] | null; heldBefore: string | null }) {
    const me = this.world?.self;
    return { ...before, to: me ? this.world!.posOf(me) : null, heldAfter: me ? this.body?.heldName(true) ?? null : null };
  }

  /** an action and its result for the history; also the note-taker's transcript unless transcript is false */
  private record(action: string, result: string, transcript = true) {
    this.history.push({ t: this.world?.now() ?? Date.now(), action, result });
    if (this.history.length > HISTORY_MAX) this.history.shift();
    if (transcript) this.mem.add(`${action} -> ${result}`);
  }

  private async execute(a: Action): Promise<string> {
    const b = this.body!;
    const hasXY = Number.isFinite(a.x) && Number.isFinite(a.y);
    const x = Math.round(a.x as number), y = Math.round(a.y as number);
    try {
      switch (a.type) {
        case "go":
          if (!hasXY) return "need x,y";
          return await b.go(x, y);
        case "use":
        case "pick_up":
          if (!hasXY) return "need x,y";
          return await b.use(x, y);
        case "drop":
          return await b.drop(hasXY ? x : undefined, hasXY ? y : undefined);
        case "swap":
          if (!hasXY) return "need x,y";
          return await b.swap(x, y);
        case "take_out":
          if (!hasXY) return "need x,y";
          return await b.takeOut(x, y);
        case "eat":
        case "wear":
        case "use_on_self": {
          const w = this.world!;
          // the real client puts clothing on when you "eat" it, full or not
          // "full" only applies to food: a Banana Peel in hand got "you're full", and agents waited to get hungry to "eat" it
          const held = w.self?.held.id ?? 0;
          if (a.type === "eat" && held > 0 && this.gd.isFood(held) && w.food >= w.foodCapacity) return "you're full, can't eat now";
          return await b.self();
        }
        case "forage":
          return hasXY ? await b.forage(x, y) : await b.forage();
        case "craft": {
          if (!this.cfg.craftMacro) return `unknown action type "craft"`;
          const planner = plannerFor(this.gd);
          const goal = planner.resolve(a.item ?? "");
          if ("error" in goal) return goal.error;
          return await runCraft(b, this.world!, this.gd, planner, goal.id, {
            maxMs: craftBudgetMs(this.clock.turnGameMs ?? this.clock.cycleMs, this.clock.timeScale),
            waitMs: (s) => realMs(s, this.clock),
          });
        }
        case "undress":
          return await b.undress(Number(a.slot ?? 1));
        case "pick_up_baby": {
          const who = this.targetPerson(a, hasXY, x, y);
          return typeof who === "string" ? who : await b.pickUpBaby(who);
        }
        case "give": {
          const who = this.targetPerson(a, hasXY, x, y);
          if (typeof who === "string") return who;
          const g = await b.give(who);
          if (g.at && g.item) this.hooks.gave?.(this, who, g.item, g.at);
          return g.text;
        }
        case "feed":
        case "use_on_person": {
          const who = this.targetPerson(a, hasXY, x, y);
          return typeof who === "string" ? who : await b.useOnPerson(who);
        }
        case "jump":
          return b.jump();
        case "say":
          // accepted as an action too ({"type":"say","text":...}); speech is the whole turn.
          // Without text, the reply's top-level "say" carried the words (already spoken)
          if (!a.text) return this.spokeThisTurn ? "spoke; no other action this turn" : "nothing said; no other action this turn";
          return await this.speakSpaced(a.text);
        case "search": {
          // a lookup in the game data (the client's "/word" hint search); no game action
          const q = (a.what ?? "").trim();
          if (!q) {
            const had = this.lastSearch;
            this.lastSearch = null;
            return had ? "search cleared" : "no search to clear";
          }
          const r = search(this.gd, q);
          this.lastSearch = r;
          return searchSummary(this.gd, r);
        }
        case "wait": {
          // no model calls while waiting; a salient event (noteSalient) ends the wait early
          const turns = Math.min(Math.max(Math.round(Number(a.turns ?? 1)), 1), 4);
          const t0 = Date.now();
          if (this.pending.length) return `didn't wait: ${this.pending[0].reason}`;
          let waited: number;
          if (this.hooks.turns) {
            // turn clock: skip `turns` decide phases (a salient event ends it at the next one)
            waited = await this.hooks.turns.turns(turns, () => this.pending.length > 0 || !this.alive);
          } else {
            await this.sleepInterruptible(turns * this.clock.cycleMs);
            waited = Math.max(0, Math.round((Date.now() - t0) / this.clock.cycleMs));
          }
          const woke = this.pending[0];
          return woke ? `waited ${waited} of ${turns} turn${turns === 1 ? "" : "s"}; woken: ${woke.reason}` : `waited ${turns} turn${turns === 1 ? "" : "s"}`;
        }
        default:
          return `unknown action type "${a.type}"`;
      }
    } catch (e) {
      return `error: ${(e as Error).message}`;
    }
  }

  /** a person-targeted action's person: "person":ID, or whoever stands at (or within 1 of) "x","y"; a string = why not */
  private targetPerson(a: Action, hasXY: boolean, x: number, y: number): number | string {
    if (a.person) return Number(a.person);
    if (!hasXY) return `need "person":ID or "x","y" of where the person stands`;
    return personAt(this.world!, x, y, this.seen?.people) ?? `nobody at or next to (${x},${y})`;
  }

  /** the salience/notes mention of a person by this character's name rules */
  private refIn(world: World): (id: number) => string {
    return (id) => this.people(world)!.ref(id);
  }

  /** life/lineage/trait fields are added by Population from the LifeStore */
  view(): Omit<AgentView, "lifeId" | "lineageId" | "traits"> {
    const w = this.world;
    const me = w?.self;
    const alive = this.status === "alive" && !!me;
    return {
      agentId: this.id,
      lifeIndex: this.lifeIndex,
      status: this.status,
      playerId: alive ? me!.id : null,
      name: alive ? me!.name : null,
      x: alive ? w!.posOf(me!)[0] : null,
      y: alive ? w!.posOf(me!)[1] : null,
      age: alive ? Math.round(w!.currentAge(me!) * 10) / 10 : null,
      female: alive ? me!.female : null,
      food: alive ? w!.food : null,
      foodCapacity: alive ? w!.foodCapacity : null,
      heat: alive ? Math.round(w!.heat * 100) / 100 : null,
      held: alive ? this.body!.heldName(true) : null,
      motherId: alive ? me!.ancestors[0] ?? null : null,
      eveId: alive ? me!.eveId : null,
      generation: alive ? me!.ancestors.length + 1 : null,
      goal: this.goal,
      lastThought: this.lastThought,
      lastAction: this.lastAction,
      lastSaid: this.lastSaid,
    };
  }
}

function describeAction(a: Action): string {
  const pos = Number.isFinite(a.x) ? ` (${a.x}, ${a.y})` : "";
  const who = a.person ? ` #${a.person}` : "";
  if (a.type === "wait") return `wait ${a.turns ?? 1} turn${(a.turns ?? 1) === 1 ? "" : "s"}`;
  if (a.type === "craft") return `craft ${a.item ?? "?"}`;
  if (a.type === "search") return `search "${a.what ?? ""}"`;
  // the reply's top-level "say" carried the words (recorded on its own)
  if (a.type === "say") return a.text ? `say "${a.text}"` : "(no other action)";
  return `${a.type}${pos}${who}`;
}
