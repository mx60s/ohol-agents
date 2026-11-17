// Lives and lineages: a pure, in-memory reducer over RunEvents (no I/O).
// Persistence lives in lifestore.ts. Contract types are in api-types.ts.
//
// A life = one character, birth to death; lifeId = `${runId}:${playerId}`, or
// `${runId}.<n>:${playerId}` when the game server restarted and recycled the id.
// Traits attach to a life (not to an agent slot). They are MOCK: assigned and
// inherited per the study design but never used to steer behaviour.

import type { DeathRecord, LifeActivity, LifeRecord, LineageRecord, RunEvent, TraitSource, Traits } from "./api-types.ts";
import { inheritTraits, sampleEveTraits, type Rng } from "./traits.ts";

/** OHOL: one in-game year per real minute, death of old age at 60. */
export const LIFESPAN_YEARS = 60;
const YEAR_MS = 60_000;
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

/** Latest time a character that we stopped watching can still be alive. */
export function presumedEndAt(l: LifeCore): number {
  const age0 = l.ageAtBirth ?? (l.generation === 1 ? EVE_AGE : 0);
  return l.bornAt + Math.max(0, LIFESPAN_YEARS - age0) * YEAR_MS;
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
    status: l.diedAt != null ? "dead" : l.lostAt != null ? "lost" : "alive",
    presumedEndAt: l.diedAt == null && l.lostAt != null ? presumedEndAt(l) : null,
  };
}

export function toDeath(l: LifeCore): DeathRecord {
  return {
    lifeId: l.lifeId, lineageId: l.lineageId, agentId: l.agentId, name: l.name, female: l.female, generation: l.generation,
    bornAt: l.bornAt, diedAt: l.diedAt!, ageAtDeath: l.ageAtDeath, deathReason: l.deathReason, traits: l.traits, inherited: l.inherited,
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

  constructor(readonly opts: LifeBookOptions) {}

  /** Insert or replace a stored record (rebuild from disk). Children links are taken as stored. */
  load(l: LifeCore) {
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
      if (t > presumedEndAt(l) + 5 * 60_000) continue;
      if (!best || l.bornAt > best.bornAt) best = l;
    }
    return best;
  }

  apply(runId: string, ev: RunEvent): ApplyResult {
    if (!ev.agentId) return NOTHING;
    if (ev.kind === "birth") return this.birth(runId, ev);

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
    if (existing && (existing.bornAt < this.epochStart || !sameBody(existing, agentId, ev.t, age))) existing = null;
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
    const life: LifeCore = {
      lifeId, runId, agentId,
      lifeIndex: num(d.lifeIndex),
      playerId,
      name: ev.name ?? null,
      female: typeof d.female === "boolean" ? d.female : null,
      displayId: num(d.displayId),
      lineageId: mother ? mother.lineageId : lifeId,
      motherLifeId: mother?.lifeId ?? null,
      motherPlayerId: motherPlayerId != null && Number.isFinite(motherPlayerId) ? motherPlayerId : null,
      generation: gen ?? (mother ? mother.generation + 1 : 1),
      traits, inherited, traitSource: this.opts.traitSource,
      bornAt: ev.t,
      ageAtBirth: age != null ? clampAge(age) : null,
      birthX: num(d.x), birthY: num(d.y),
      diedAt: null, ageAtDeath: null, deathReason: null, lostAt: null,
      childLifeIds: [],
      activity: emptyActivity(),
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
function sameBody(l: LifeCore, agentId: string, t: number, age: number | null): boolean {
  if (l.diedAt != null || l.agentId !== agentId) return false;
  if (t > presumedEndAt(l) + 5 * 60_000) return false;
  if (age != null && l.ageAtBirth != null) {
    const expected = Math.min(LIFESPAN_YEARS, l.ageAtBirth + (t - l.bornAt) / YEAR_MS);
    if (Math.abs(age - expected) > 3) return false;
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
