// Lives and lineages: a pure, in-memory reducer over RunEvents (no I/O).
// Persistence lives in lifestore.ts. Contract types are in api-types.ts.
//
// A life = one character, birth to death; lifeId = `${runId}:${playerId}`, or
// `${runId}.<n>:${playerId}` when the game server restarted and recycled the id.
// Traits attach to a life (not to an agent slot). They are MOCK: assigned and
// inherited per the study design but never used to steer behaviour.

import type { DeathRecord, LifeActivity, LifeRecord, LineageRecord, RunEvent, TraitSource, Traits } from "./api-types.ts";
import { config } from "./config.ts";
import { canonicalFlower, isKnownFlower, pickFlower, type Flower } from "./flowers.ts";
import { inheritTraits, sampleEveTraits, type Rng } from "./traits.ts";
import { cueOfSay } from "./cues.ts";

/** OHOL: one in-game year per real minute, death of old age at 60. */
export const LIFESPAN_YEARS = 60;
/** wall ms per game year at stock speed (TIME_SCALE 1) */
export const BASE_YEAR_MS = 60_000;
/** wall ms per game year of this life: the game clock ran timeScale x slower when it was born (old records: 1) */
export function yearMsOf(l: Pick<LifeCore, "timeScale">): number {
  const k = l.timeScale;
  return BASE_YEAR_MS * (typeof k === "number" && k > 0 ? k : 1);
}
/** an Eve appears at about this age */
const EVE_AGE = 14;

/** What we store: the public record minus derived fields, plus the per-life log path. */
export type LifeCore = Omit<LifeRecord, "status" | "presumedEndAt"> & {
  /** per-life event log, relative to LOG_DIR; never exposed by the API */
  logPath: string | null;
};

export const LOGGED_KINDS = new Set(["birth", "death", "thought", "say", "action", "craft"]);

export function emptyActivity(): LifeActivity {
  return {
    thoughts: 0, actions: 0, failedActions: 0, moves: 0, tilesWalked: 0, maxDistFromBirth: 0, forage: 0, reflexForage: 0,
    eat: 0, pickUp: 0, drop: 0, craft: 0, wear: 0, babyPickups: 0, feeds: 0, says: 0, saysHeard: 0,
  };
}

/** Ages are 0..60 in OHOL; anything above is wall-clock drift (stalled server, sleeping host). */
export function clampAge(age: number): number {
  return Math.round(Math.min(LIFESPAN_YEARS, Math.max(0, age)) * 100) / 100;
}

export function lifeIdOf(runId: string, playerId: number) {
  return `${runId}:${playerId}`;
}

/**
 * Wall time per game year is only known without the turn clock: with it (TURN_CLOCK=1) the game
 * clock stands still while agents think, so a life lasts longer in wall time. setLifespanWallFactor
 * (from LifeBook, gameClockLags) stretches the wall-clock estimates by this much.
 */
let lifespanWallFactor = 1;
export function setLifespanWallFactor(f: number) {
  lifespanWallFactor = f > 0 ? f : 1;
}

/** Latest time a character that we stopped watching can still be alive. */
export function presumedEndAt(l: LifeCore): number {
  const age0 = l.ageAtBirth ?? (l.generation === 1 ? EVE_AGE : 0);
  return l.bornAt + Math.max(0, LIFESPAN_YEARS - age0) * yearMsOf(l) * lifespanWallFactor;
}

/** Alive anywhere in the world, as far as we know. */
export function possiblyAlive(l: LifeCore, now: number): boolean {
  if (l.diedAt != null) return false;
  if (l.lostAt == null) return true;
  return now < presumedEndAt(l);
}

export function toRecord(l: LifeCore): LifeRecord {
  const { logPath, ...rest } = l;
  return {
    ...rest,
    timeScale: yearMsOf(l) / BASE_YEAR_MS,
    status: l.diedAt != null ? "dead" : l.lostAt != null ? "lost" : "alive",
    presumedEndAt: l.diedAt == null && l.lostAt != null ? presumedEndAt(l) : null,
    outage: l.outage === true,
    validForStudy: validForStudy(l),
  };
}

/** false = exclude from study analyses (alive during an LLM outage that paused the run) */
export function validForStudy(l: Pick<LifeCore, "outage" | "validForStudy">): boolean {
  return l.validForStudy ?? l.outage !== true;
}

export function toDeath(l: LifeCore): DeathRecord {
  return {
    lifeId: l.lifeId, lineageId: l.lineageId, agentId: l.agentId, name: l.name, female: l.female, generation: l.generation,
    bornAt: l.bornAt, diedAt: l.diedAt!, timeScale: yearMsOf(l) / BASE_YEAR_MS, ageAtDeath: l.ageAtDeath, deathReason: l.deathReason, traits: l.traits, inherited: l.inherited,
    validForStudy: validForStudy(l),
  };
}

// ---------------------------------------------------------------------------
// activity classification

const FAIL_RE =
  /nothing happened|^couldn't|^can't|not holding|no path|isn't nearby|left$|^error|unknown action|^need |^no food|^nothing at|you're full|^no body|^no empty|surrounded|^said nothing/;

type Pos = [number, number];
const asPos = (v: unknown): Pos | null =>
  Array.isArray(v) && v.length === 2 && Number.isFinite(v[0]) && Number.isFinite(v[1]) ? [Number(v[0]), Number(v[1])] : null;
const cheb = (a: Pos, b: Pos) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));
const isEmptyHand = (s: string) => s === "nothing";
const isBaby = (s: string) => s.startsWith("baby");

/**
 * Activity deltas for one "action" event (see LifeActivity docs). Action
 * events have text "<action> -> <result>" and data { action: {type,...},
 * reflex?, from?, to?, heldBefore?, heldAfter? }.
 */
export function classifyAction(ev: Pick<RunEvent, "text" | "data">): Partial<LifeActivity> {
  const d = ev.data ?? {};
  // a "remember" for the notes is logged as an action event but is not a game action
  if (typeof d.remember === "string") return {};
  const reflex = d.reflex === true;
  const type = reflex ? "forage" : String((d.action as { type?: unknown } | undefined)?.type ?? "");
  const i = ev.text.indexOf(" -> ");
  const result = i >= 0 ? ev.text.slice(i + 4) : "";
  const failed = FAIL_RE.test(result);
  const out: Partial<LifeActivity> = { actions: 1 };
  if (failed) out.failedActions = 1;
  const ate = /(^|; )ate /.test(result);
  if (ate) out.eat = 1;
  // held before/after: from data (agent records them), else parsed from "holding A -> B"
  const hm = result.match(/holding (.+?) -> (.+?)(;|$)/);
  const heldBefore = typeof d.heldBefore === "string" ? d.heldBefore : hm ? hm[1] : null;
  const heldAfter = typeof d.heldAfter === "string" ? d.heldAfter : hm ? hm[2] : null;
  const placed = /tile \([^)]*\) nothing -> /.test(result) && heldAfter != null && isEmptyHand(heldAfter);
  switch (type) {
    case "go":
      out.moves = 1;
      break;
    case "forage":
      out.forage = 1;
      if (reflex) out.reflexForage = 1;
      break;
    case "use":
    case "pick_up":
      if (failed) break;
      if (heldBefore != null && isEmptyHand(heldBefore) && heldAfter != null && !isEmptyHand(heldAfter) && !isBaby(heldAfter)) out.pickUp = 1;
      else if (placed) out.drop = 1;
      else if (type === "use" && heldBefore != null && !isEmptyHand(heldBefore) && !isBaby(heldBefore)) out.craft = 1;
      break;
    case "drop":
      if (!failed) out.drop = 1;
      break;
    case "wear":
    case "use_on_self":
      if (!failed && !ate) out.wear = 1;
      break;
    case "pick_up_baby":
      if (/^picked up baby/.test(result)) out.babyPickups = 1;
      break;
    case "feed":
    case "use_on_person":
      if (/^gave\/used/.test(result)) out.feeds = 1;
      break;
  }
  return out;
}

function addActivity(a: LifeActivity, delta: Partial<LifeActivity>) {
  for (const [k, v] of Object.entries(delta) as [keyof LifeActivity, number][]) a[k] += v;
}

// ---------------------------------------------------------------------------

export interface LifeBookOptions {
  dims: string[];
  mutationSd: number;
  traitSource: TraitSource;
  rng: Rng;
  /** game clock slowdown k stamped on new lives (default config.timeScale) */
  timeScale?: number;
  /**
   * TURN_CLOCK=1: the game clock is paused while agents think, so ages lag the
   * wall-time expectation (they never run ahead of it). See sameBody.
   */
  gameClockLags?: boolean;
}

export interface ApplyResult {
  /** life the event belongs to, if any */
  life: LifeCore | null;
  /** every record that changed (the life itself, a mother gaining a child, a slot's previous life marked lost) */
  changed: LifeCore[];
  /** births, deaths, names, lost: worth persisting right away */
  important: boolean;
  /** goes into the per-life log */
  loggable: boolean;
  created: boolean;
}

const NOTHING: ApplyResult = { life: null, changed: [], important: false, loggable: false, created: false };

export class LifeBook {
  readonly lives = new Map<string, LifeCore>();
  private byPlayer = new Map<number, string[]>();
  /** `${runId}|${playerId}` -> that run's latest life with this player id (ids repeat after a game-server restart) */
  private runPid = new Map<string, string>();
  /** highest player id born so far (the game server hands out increasing ids until it restarts) */
  private maxPid = -Infinity;
  /** bornAt of the first birth after the latest detected game-server restart; older lives can't be alive after it */
  epochStart = -Infinity;
  /** `${runId}|${agentId}` -> current lifeId */
  private slotLife = new Map<string, string>();

  constructor(readonly opts: LifeBookOptions) {
    // turn clock: game time runs well behind wall time (11-15 turns of 2.4 game s per wall minute ~ 0.5x)
    setLifespanWallFactor(opts.gameClockLags ? 4 : 1);
  }

  /** Insert or replace a stored record (rebuild from disk). Children links are taken as stored. */
  load(l: LifeCore) {
    // records written before lives carried their time scale ran at stock speed
    if (!(typeof l.timeScale === "number" && l.timeScale > 0)) l.timeScale = 1;
    // records written before ages were capped
    if (l.ageAtDeath != null && l.ageAtDeath > LIFESPAN_YEARS) l.ageAtDeath = LIFESPAN_YEARS;
    const prev = this.lives.get(l.lifeId);
    this.lives.set(l.lifeId, l);
    if (!prev) {
      const ids = this.byPlayer.get(l.playerId) ?? [];
      ids.push(l.lifeId);
      this.byPlayer.set(l.playerId, ids);
    }
    const k = `${l.runId}|${l.playerId}`;
    const cur = this.lives.get(this.runPid.get(k) ?? "");
    if (!cur || cur.bornAt <= l.bornAt) this.runPid.set(k, l.lifeId);
  }

  /**
   * Recompute game-server epochs from the stored lives (after loading from
   * disk): player ids only grow while one server runs, so a birth with an id
   * at or below an earlier one means the server restarted in between.
   */
  rebuildEpochs() {
    this.maxPid = -Infinity;
    this.epochStart = -Infinity;
    for (const l of [...this.lives.values()].sort((a, b) => a.bornAt - b.bornAt)) this.noteBirth(l.playerId, l.bornAt);
  }

  private noteBirth(playerId: number, t: number) {
    if (playerId <= this.maxPid) {
      this.epochStart = t;
      this.maxPid = playerId;
    } else this.maxPid = playerId;
  }

  /** The run's current life for a player id. */
  byRunPlayer(runId: string, playerId: number): LifeCore | null {
    const id = this.runPid.get(`${runId}|${playerId}`) ?? lifeIdOf(runId, playerId);
    return this.lives.get(id) ?? null;
  }

  get(lifeId: string) {
    return this.lives.get(lifeId) ?? null;
  }

  current(runId: string, agentId: string): LifeCore | null {
    const id = this.slotLife.get(`${runId}|${agentId}`);
    return id ? this.lives.get(id) ?? null : null;
  }

  /** Our life with this player id that is (or may be) alive at `t`; latest-born wins. */
  findByPlayer(playerId: number, t: number): LifeCore | null {
    let best: LifeCore | null = null;
    for (const id of this.byPlayer.get(playerId) ?? []) {
      const l = this.lives.get(id)!;
      if (l.bornAt > t + 1000) continue;
      // born before the game server last restarted: that character is gone, the id now belongs to someone else
      if (t >= this.epochStart && l.bornAt < this.epochStart) continue;
      // alive at t: no death before t, and not past the max lifespan
      if (l.diedAt != null && l.diedAt < t - 60_000) continue;
      // turn clock: an open life (no death or loss seen) is alive whatever the wall clock says
      const open = this.opts.gameClockLags && l.diedAt == null && l.lostAt == null;
      if (!open && t > presumedEndAt(l) + 5 * 60_000) continue;
      if (!best || l.bornAt > best.bornAt) best = l;
    }
    return best;
  }

  /** highest lifeIndex this slot has had in the run (0 = none), so a restarted process keeps counting */
  lastLifeIndex(runId: string, agentId: string): number {
    let n = 0;
    for (const l of this.lives.values()) if (l.runId === runId && l.agentId === agentId && l.lifeIndex != null) n = Math.max(n, l.lifeIndex);
    return n;
  }

  /**
   * Would a login of `agentId` that landed in `playerId` at age `age` be the
   * run's still-open life again (a reconnect, e.g. after an agents-service
   * restart) rather than a new character? Same test as birth().
   */
  reconnectOf(runId: string, agentId: string, playerId: number, t: number, age: number | null): LifeCore | null {
    const l = this.byRunPlayer(runId, playerId);
    if (!l || l.bornAt < this.epochStart || !sameBody(l, agentId, t, age, this.opts.gameClockLags)) return null;
    return l;
  }

  /**
   * Resume a run after a restart: its open lives become their slots' current
   * lives again (so a slot that gets a new body marks the old one lost).
   * Returns the agent ids that have an open life.
   */
  resumeRun(runId: string): string[] {
    const latest = new Map<string, LifeCore>();
    for (const l of this.lives.values()) {
      if (l.runId !== runId || l.diedAt != null || l.lostAt != null) continue;
      const cur = latest.get(l.agentId);
      if (!cur || cur.bornAt < l.bornAt) latest.set(l.agentId, l);
    }
    for (const [agentId, l] of latest) this.slotLife.set(`${runId}|${agentId}`, l.lifeId);
    return [...latest.keys()].sort();
  }

  apply(runId: string, ev: RunEvent): ApplyResult {
    if (!ev.agentId) return NOTHING;
    // a reconnect (system event with data.reconnect) goes through birth(), which resumes the open life
    if (ev.kind === "birth" || (ev.kind === "system" && ev.data?.reconnect === true)) return this.birth(runId, ev);

    const pid = Number(ev.data?.playerId ?? ev.playerId);
    const life = (Number.isFinite(pid) ? this.byRunPlayer(runId, pid) : null) ?? this.current(runId, ev.agentId);
    if (!life) return NOTHING;
    let important = false;
    if (ev.name && ev.name !== life.name) {
      life.name = ev.name;
      important = true;
    }
    switch (ev.kind) {
      case "death":
        if (life.diedAt == null) {
          life.diedAt = ev.t;
          const age = Number(ev.data?.age);
          life.ageAtDeath = Number.isFinite(age) ? clampAge(age) : null;
          const reason = ev.data?.reason;
          life.deathReason = typeof reason === "string" ? reason.replace(/^reason_/, "") : null;
          important = true;
        }
        break;
      case "thought":
        life.activity.thoughts++;
        break;
      case "say": {
        if (cueOfSay(ev.text)) break; // an emote, not speech
        life.activity.says++;
        const heard = ev.data?.heardBy;
        if (Array.isArray(heard) && heard.length > 0) life.activity.saysHeard++;
        break;
      }
      case "craft":
        life.activity.craft++;
        break;
      case "action": {
        addActivity(life.activity, classifyAction(ev));
        const from = asPos(ev.data?.from);
        const to = asPos(ev.data?.to);
        if (from && to) life.activity.tilesWalked += cheb(from, to);
        if (to && life.birthX != null && life.birthY != null)
          life.activity.maxDistFromBirth = Math.max(life.activity.maxDistFromBirth, cheb(to, [life.birthX, life.birthY]));
        break;
      }
      default:
        if (!important) return NOTHING;
    }
    life.updatedAt = ev.t;
    return { life, changed: [life], important, loggable: LOGGED_KINDS.has(ev.kind), created: false };
  }

  private birth(runId: string, ev: RunEvent): ApplyResult {
    const d = ev.data ?? {};
    const playerId = Number(d.playerId ?? ev.playerId);
    if (!Number.isFinite(playerId)) return NOTHING;
    const agentId = ev.agentId!;
    const slotKey = `${runId}|${agentId}`;
    const changed: LifeCore[] = [];
    const num = (v: unknown) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));
    const age = num(d.age);

    // Same player id in this run: the same body again (a reconnect with the same login), or, after a
    // game-server restart, a different character that was handed a recycled id. Merging the latter into
    // the old record corrupted it (activity, lineage and children piled onto a dead Eve).
    let existing = this.byRunPlayer(runId, playerId);
    if (existing && (existing.bornAt < this.epochStart || !sameBody(existing, agentId, ev.t, age, this.opts.gameClockLags))) existing = null;
    let lifeId = existing?.lifeId ?? lifeIdOf(runId, playerId);
    for (let n = 2; !existing && this.lives.has(lifeId); n++) lifeId = `${runId}.${n}:${playerId}`;

    // the slot moved on from a life we never saw die -> lost
    const prevId = this.slotLife.get(slotKey);
    if (prevId && prevId !== lifeId) {
      const prev = this.lives.get(prevId);
      if (prev && prev.diedAt == null && prev.lostAt == null) {
        prev.lostAt = ev.t;
        prev.updatedAt = ev.t;
        changed.push(prev);
      }
    }
    this.slotLife.set(slotKey, lifeId);

    if (existing) {
      // same body again (reconnect with the same login)
      existing.lostAt = null;
      existing.agentId = agentId;
      existing.updatedAt = ev.t;
      changed.push(existing);
      return { life: existing, changed, important: true, loggable: true, created: false };
    }

    this.noteBirth(playerId, ev.t);
    const motherPlayerId = d.motherId == null ? null : Number(d.motherId);
    const mother = motherPlayerId != null && Number.isFinite(motherPlayerId) ? this.findByPlayer(motherPlayerId, ev.t) : null;
    const { traits, inherited } = mother?.traits
      ? inheritTraits(mother.traits, this.opts.dims, this.opts.mutationSd, this.opts.rng)
      : inheritTraits(null, this.opts.dims, this.opts.mutationSd, this.opts.rng);
    const gen = num(d.generation);
    const lineageId = mother ? mother.lineageId : lifeId;
    // a flower no living relative wears (lost relatives count until their presumed end)
    const taken: Flower[] = [];
    for (const l of this.lives.values()) if (l.lineageId === lineageId && l.flower && possiblyAlive(l, ev.t)) taken.push(l.flower);
    const life: LifeCore = {
      lifeId, runId, agentId,
      lifeIndex: num(d.lifeIndex),
      playerId,
      name: ev.name ?? null,
      female: typeof d.female === "boolean" ? d.female : null,
      displayId: num(d.displayId),
      lineageId,
      motherLifeId: mother?.lifeId ?? null,
      motherPlayerId: motherPlayerId != null && Number.isFinite(motherPlayerId) ? motherPlayerId : null,
      generation: gen ?? (mother ? mother.generation + 1 : 1),
      traits, inherited, traitSource: this.opts.traitSource,
      bornAt: ev.t,
      timeScale: this.opts.timeScale ?? config.timeScale,
      ageAtBirth: age != null ? clampAge(age) : null,
      birthX: num(d.x), birthY: num(d.y),
      diedAt: null, ageAtDeath: null, deathReason: null, lostAt: null,
      childLifeIds: [],
      activity: emptyActivity(),
      flower: pickFlower(lifeId, taken),
      updatedAt: ev.t,
      logPath: null,
    };
    this.load(life);
    changed.push(life);
    if (mother) {
      mother.childLifeIds.push(lifeId);
      mother.updatedAt = ev.t;
      changed.push(mother);
    }
    return { life, changed, important: true, loggable: true, created: true };
  }

  /**
   * Bring stored flowers up to date with the catalogue. A retired shape id (flowers.ts
   * LEGACY_FLOWER_SHAPES, e.g. the old bellflower) becomes its replacement, same colour. Lives
   * still without a valid flower (records from before flowers existed) get one, oldest birth first:
   * one no same-lineage life wore that was born at or before it and still alive at its birth (lost
   * lives count until their presumed end). Returns the changed lives.
   */
  assignMissingFlowers(): LifeCore[] {
    const all = [...this.lives.values()].sort((a, b) => a.bornAt - b.bornAt);
    const out: LifeCore[] = [];
    for (const l of all) {
      if (l.flower == null || isKnownFlower(l.flower)) continue;
      const migrated = canonicalFlower(l.flower);
      if (!migrated) continue;
      l.flower = migrated;
      out.push(l);
    }
    for (const l of all) {
      if (isKnownFlower(l.flower)) continue;
      const taken: Flower[] = [];
      for (const o of all) {
        if (o.bornAt > l.bornAt) break;
        if (o === l || o.lineageId !== l.lineageId || !isKnownFlower(o.flower)) continue;
        const end = o.diedAt ?? (o.lostAt != null ? presumedEndAt(o) : Infinity);
        if (end > l.bornAt) taken.push(o.flower);
      }
      l.flower = pickFlower(l.lifeId, taken);
      out.push(l);
    }
    return out;
  }

  /**
   * Flag every life of `runId` that was alive at some point in [from, to]
   * (born by `to`, not dead or lost before `from`) as outage / not valid for
   * study. Returns the newly flagged lives.
   */
  markOutage(runId: string, from: number, to: number): LifeCore[] {
    const out: LifeCore[] = [];
    for (const l of this.lives.values()) {
      if (l.runId !== runId || l.outage === true || l.bornAt > to) continue;
      if ((l.diedAt ?? Infinity) < from || (l.lostAt ?? Infinity) < from) continue;
      l.outage = true;
      l.validForStudy = false;
      l.updatedAt = Math.max(l.updatedAt, to);
      out.push(l);
    }
    return out;
  }

  /**
   * Merge lives split by a missed reconnect back into one. Before the ghost
   * fix in sameBody(), a ghost's reconnect after an agents-service restart
   * counted as a birth; its low player id then looked like a game-server
   * restart, and every later reconnect became a new, motherless life
   * "<run>.<n>:<pid>" while the real one was marked lost at that moment.
   * A split copy: same run, player id and slot as a life marked lost within
   * 2 min of the copy's birth, with the age that life had then (or a ghost's 60).
   * The copy's death and activity move to the original, its children point to
   * the original, and motherless lives born after the split get their mother
   * (the run's life with that player id) and her lineage back. Returns the
   * changed lives; removed copies are dropped from the book.
   */
  healSplitReconnects(): { changed: LifeCore[]; removed: string[] } {
    const changed = new Set<LifeCore>();
    const removed: string[] = [];
    const ren = new Map<string, string>();
    const all = [...this.lives.values()].sort((a, b) => a.bornAt - b.bornAt);
    for (const dup of all) {
      if (!/\.\d+:\d+$/.test(dup.lifeId)) continue;
      const orig = all.find(
        (o) =>
          o !== dup && !ren.has(o.lifeId) && o.runId === dup.runId && o.playerId === dup.playerId && o.agentId === dup.agentId &&
          o.bornAt < dup.bornAt && o.diedAt == null && o.lostAt != null && Math.abs(o.lostAt - dup.bornAt) <= 120_000 &&
          (dup.ageAtBirth == null || o.ageAtBirth == null ||
            Math.abs(dup.ageAtBirth - Math.min(LIFESPAN_YEARS, o.ageAtBirth + (dup.bornAt - o.bornAt) / yearMsOf(o))) <= 3),
      );
      if (!orig) continue;
      ren.set(dup.lifeId, orig.lifeId);
      orig.lostAt = dup.lostAt;
      orig.diedAt = dup.diedAt;
      orig.ageAtDeath = dup.ageAtDeath;
      orig.deathReason = dup.deathReason;
      for (const k of Object.keys(orig.activity) as (keyof LifeActivity)[])
        orig.activity[k] = k === "maxDistFromBirth" ? Math.max(orig.activity[k], dup.activity[k]) : orig.activity[k] + dup.activity[k];
      orig.outage = orig.outage || dup.outage;
      orig.validForStudy = orig.validForStudy && dup.validForStudy;
      orig.updatedAt = Math.max(orig.updatedAt, dup.updatedAt);
      changed.add(orig);
      this.lives.delete(dup.lifeId);
      const ids = this.byPlayer.get(dup.playerId);
      if (ids) this.byPlayer.set(dup.playerId, ids.filter((i) => i !== dup.lifeId));
      const k = `${dup.runId}|${dup.playerId}`;
      if (this.runPid.get(k) === dup.lifeId) this.runPid.set(k, orig.lifeId);
      for (const [sk, id] of this.slotLife) if (id === dup.lifeId) this.slotLife.set(sk, orig.lifeId);
      removed.push(dup.lifeId);
    }
    if (!ren.size) return { changed: [], removed };
    const splitAt = Math.min(...[...ren.values()].map((id) => this.lives.get(id)!.lostAt ?? Infinity).filter(Number.isFinite), ...all.filter((l) => ren.has(l.lifeId)).map((l) => l.bornAt));
    for (const l of [...this.lives.values()].sort((a, b) => a.bornAt - b.bornAt)) {
      let mother = l.motherLifeId ? this.lives.get(ren.get(l.motherLifeId) ?? l.motherLifeId) ?? null : null;
      if (!mother && l.motherPlayerId != null && l.bornAt >= splitAt - 120_000) {
        const m = this.byRunPlayer(l.runId, l.motherPlayerId);
        if (m && m.bornAt < l.bornAt) mother = m;
      }
      if (!mother) continue;
      const lineageId = mother.lineageId;
      if (l.motherLifeId !== mother.lifeId || l.lineageId !== lineageId) {
        if (l.motherLifeId !== mother.lifeId) {
          const old = l.motherLifeId ? this.lives.get(l.motherLifeId) : null;
          if (old) old.childLifeIds = old.childLifeIds.filter((c) => c !== l.lifeId);
          if (!mother.childLifeIds.includes(l.lifeId)) mother.childLifeIds.push(l.lifeId);
          changed.add(mother);
        }
        l.motherLifeId = mother.lifeId;
        l.lineageId = lineageId;
        changed.add(l);
      }
    }
    for (const l of this.lives.values()) {
      const kids = l.childLifeIds.map((c) => ren.get(c) ?? c).filter((c, i, a) => this.lives.has(c) && a.indexOf(c) === i);
      if (kids.length !== l.childLifeIds.length || kids.some((c, i) => c !== l.childLifeIds[i])) {
        l.childLifeIds = kids;
        changed.add(l);
      }
    }
    return { changed: [...changed], removed };
  }

  /** Mark open lives matching `pred` as lost at time t (or at their last update if t is null). */
  markLost(pred: (l: LifeCore) => boolean, t: number | null): LifeCore[] {
    const out: LifeCore[] = [];
    for (const l of this.lives.values()) {
      if (l.diedAt != null || l.lostAt != null || !pred(l)) continue;
      l.lostAt = t ?? l.updatedAt;
      l.updatedAt = Math.max(l.updatedAt, l.lostAt);
      out.push(l);
    }
    for (const [k, id] of this.slotLife) if (out.some((l) => l.lifeId === id)) this.slotLife.delete(k);
    return out;
  }
}

/**
 * Is a birth event for a known player id the same character again? Only if
 * that life is still open, in the same slot, and the reported age matches the
 * age it should have reached by now (a recycled id comes with a newborn/Eve age).
 */
function sameBody(l: LifeCore, agentId: string, t: number, age: number | null, gameClockLags = false): boolean {
  if (l.diedAt != null || l.agentId !== agentId) return false;
  // with a reported age the age test below decides: a ghost (allowGhosts) stays at 60 past the usual end
  if (age == null && t > presumedEndAt(l) + 5 * 60_000) return false;
  if (age != null && l.ageAtBirth != null) {
    const expected = Math.min(LIFESPAN_YEARS, l.ageAtBirth + (t - l.bornAt) / yearMsOf(l));
    // turn clock: anywhere from the age at birth up to the wall-time expectation
    if (gameClockLags ? age < l.ageAtBirth - 0.5 || age > expected + 3 : Math.abs(age - expected) > 3) return false;
  }
  return true;
}

/** Lineages derived from lives. Pure; extinction depends on `now` because lost characters may still be alive. */
export function computeLineages(lives: Iterable<LifeCore>, dims: string[], now: number): LineageRecord[] {
  const groups = new Map<string, LifeCore[]>();
  for (const l of lives) {
    const g = groups.get(l.lineageId);
    if (g) g.push(l);
    else groups.set(l.lineageId, [l]);
  }
  const out: LineageRecord[] = [];
  for (const [lineageId, members] of groups) {
    const founder = members.find((m) => m.lifeId === lineageId) ?? members.reduce((a, b) => (a.bornAt <= b.bornAt ? a : b));
    const living = members.filter((m) => possiblyAlive(m, now));
    const meanTraits: Traits = {};
    const traitDims = new Set(dims);
    for (const m of members) if (m.traits) for (const k of Object.keys(m.traits)) traitDims.add(k);
    for (const k of traitDims) {
      const vals = members.map((m) => m.traits?.[k]).filter((v): v is number => Number.isFinite(v));
      if (vals.length) meanTraits[k] = Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 1e4) / 1e4;
    }
    out.push({
      lineageId,
      eveLifeId: founder.lifeId,
      eveName: founder.name,
      founderIsEve: founder.motherPlayerId == null,
      foundedAt: founder.bornAt,
      extinctAt: living.length ? null : Math.max(...members.map((m) => m.diedAt ?? presumedEndAt(m))),
      living: living.length,
      livingLifeIds: living.map((m) => m.lifeId),
      totalLives: members.length,
      maxGeneration: Math.max(...members.map((m) => m.generation)),
      meanTraits,
    });
  }
  return out.sort((a, b) => b.foundedAt - a.foundedAt);
}
