// What one agent knows about the world: map cells it has been sent, players
// in range, its own body state. Built purely from server messages that agent's
// connection received, so it's exactly what that character could perceive.

import type { ServerMessage, ObjStack, PlayerUpdate } from "../protocol/types.ts";
import { withArticle, type Condition, type GameData } from "./gameData.ts";
import { cleanText } from "../safety.ts";
import { config } from "../config.ts";
import { turnClock } from "../agent/turns.ts";

/** names come from in-game speech; they reach the public API, the stream and prompts */
const NAME_MAX = 60;
/** heard speech, as stored (the server limits speech length by age anyway) */
const SPEECH_MAX = 200;

export interface Cell {
  biome: number;
  floor: number;
  obj: ObjStack;
  t: number; // ms when last updated
  /** player whose action last changed this cell (MX responsible id), if any */
  by?: number;
  /** the object that was here before the last map change (MX), if we saw one */
  prev?: number;
  /** wall ms since the object here has been this id (for decay timers) */
  since?: number;
  /** true if we saw it appear (MX); false if it was already there when first seen */
  sinceExact?: boolean;
}

/** When an object came to be, as far as this client knows: wall ms, and whether we saw it happen. */
export interface Since {
  t: number;
  exact: boolean;
}

/** an object that left a cell or our hands within this many ms is the same one turning up elsewhere */
const HANDOFF_MS = 3000;

export interface Player {
  id: number;
  displayId: number;
  x: number;
  y: number;
  /** x,y are the destination while moving */
  moving: boolean;
  moveEndsAt: number;
  /** the current walk (from PM): start tile, waypoints, wall ms it takes in total */
  move?: { from: [number, number]; path: [number, number][]; totalMs: number };
  age: number;
  ageAt: number; // ms when age was reported
  /** wall seconds per game year, as the server reports it (60 x TIME_SCALE) */
  ageRate: number;
  /** tiles per wall second, as the server reports it (0 = unknown) */
  moveSpeed: number;
  held: ObjStack;
  clothing: ObjStack[];
  heat: number;
  name: string | null;
  female: boolean | null;
  dying: boolean;
  lastSeen: number;
  ancestors: number[]; // mother first
  eveId: number | null;
}

export interface Heard {
  t: number;
  speakerId: number | null; // null = location speech (sign read etc.)
  x: number;
  y: number;
  text: string;
  /** a server notice (MS), not speech */
  notice?: boolean;
  /** this line named that player (see markNaming) */
  named?: number;
  /** the words as spoken, when `text` has a tag added (markNaming) */
  spoken?: string;
}

/** Our own child (we are the mother), as last seen: kept while they're out of range. */
export interface ChildRecord {
  id: number;
  name: string | null;
  female: boolean | null;
  age: number;
  ageAt: number;
  ageRate: number;
  /** where and when (World.now) we last saw them */
  x: number;
  y: number;
  t: number;
}

/** a child's record is dropped once they would be this old (the labels say woman/man from 14) */
export const CHILD_RECORD_MAX_AGE = 14;

export interface SeenDeath {
  t: number;
  id: number;
  name: string | null;
  female: boolean | null;
  age: number;
  x: number;
  y: number;
  ancestors: number[];
  eveId: number | null;
}

/** tiles: things (and animals) this close are in view (the observation's THINGS radius) */
export const VIEW_RADIUS = 12;
/** tiles: people this close are in view (the observation's PEOPLE radius) */
export const PEOPLE_RADIUS = VIEW_RADIUS + 4;
/** events kept in World.seen (the observation shows the last 10 of about 5 turns) */
const SEEN_KEEP = 50;
/** "did" lines kept per person per turn; more are counted on the last one */
const SEEN_DID_PER_TURN = 4;

/**
 * Something this character saw happen nearby (World.seen): one line of the
 * observation's WHAT YOU SAW NEARBY. `text` names people as {0}, {1}...
 * (an entry of `people`: a snapshot when it happened, or just the id), so the
 * line shows names learned later.
 */
export interface SeenEvent {
  t: number;
  kind: "view" | "born" | "died" | "baby" | "named" | "did" | "ate" | "animal_seen" | "animal_move" | "wounded";
  text: string;
  people: (Player | { id: number })[];
  /** a later event with the same key within a turn replaces this one */
  key?: string;
  /** further changes by the same person this turn, folded into this line */
  more?: number;
}

export interface WorldEvents {
  onSelfDied?(reason: string, age: number): void;
  onPlayerDied?(p: Player, reason: string): void;
  onPlayerAppeared?(p: Player): void;
  onHeard?(h: Heard): void;
  onMapChange?(x: number, y: number, before: ObjStack | null, after: ObjStack, responsibleId: number): void;
  onSelfUpdate?(u: PlayerUpdate): void;
  onAte?(foodId: number): void;
  /** a new line in World.seen (not called when one is merged into an earlier line) */
  onSeen?(e: SeenEvent): void;
  /**
   * The server's private cue over our own head ("+HOMESICK+", "+HOME+", "+FREE REIN+"):
   * a feeling the client shows with an emote, not words we said. `wasHomesick`: before this cue.
   */
  onCue?(word: string, wasHomesick: boolean): void;
}

/**
 * Feeling homesick (server.cpp, on every walk: start and end tile against
 * isBirthland): the server says "+HOMESICK+" over our head, only to us, when a
 * walk leaves the family's homeland, and "+HOME+" when one ends back inside it
 * ("+FREE REIN+": a person with no homeland, out of someone else's). Being
 * carried is no walk: a baby carried out gets no cue.
 */
export interface Homesick {
  t: number;
  /** compass word toward the homeland ("south"): back toward where the walk that left it started; null if unknown */
  toward: string | null;
}

/** "You feel homesick: ..." as the agent is told when it leaves (nothing about births: that's for it to find out) */
export function homesickNotice(h: Homesick | null): string {
  return `You feel homesick: you have left your family's homeland.${h?.toward ? ` It lies back the way you came, to the ${h.toward}.` : ""}`;
}

/** the YOU line while outside the homeland */
export const HOMESICK_LINE = "You feel homesick: you are outside your family's homeland.";

/** a +WORD+ cue in a speech line (the server's client cues: +HOMESICK+, +FREE REIN+, +FAMILY+) */
const CUE_RE = /\+([A-Z](?:[A-Z ]*[A-Z])?)\+/g;
/** a MOVE we sent this long ago (World.now ms) is the walk the server's homeland cue is about */
const CUE_MOVE_MS = 5000;

/** "south", "northeast": the compass word from `from` toward `to` (y grows north); null for the same tile */
export function compassWord(from: [number, number], to: [number, number]): string | null {
  const dx = to[0] - from[0], dy = to[1] - from[1];
  if (!dx && !dy) return null;
  const ns = Math.abs(dy) * 2 >= Math.abs(dx) ? (dy > 0 ? "north" : dy < 0 ? "south" : "") : "";
  const ew = Math.abs(dx) * 2 >= Math.abs(dy) ? (dx > 0 ? "east" : dx < 0 ? "west" : "") : "";
  return ns + ew;
}

/** OHOL: everyone dies of old age at 60 */
export const MAX_AGE = 60;

// --- time scale (TIME_SCALE; see server/patches/time-scale.patch) ---
// The server reports every duration and speed in wall seconds (PU age_r and
// move_speed, PM eta, HX food_time), so ages, move ETAs and food ETAs below
// use those numbers as-is. Only client-side constants scale with timeScale.
/** stock adult walking speed, tiles per game second */
export const STOCK_MOVE_SPEED = 3.75;
/** stock seconds per game year */
export const STOCK_SECONDS_PER_YEAR = 60;

/**
 * Wall ms to walk `tiles` at `speed` tiles per wall second (server-reported;
 * falls back to the stock speed slowed by timeScale when unknown).
 */
export function walkMs(tiles: number, speed: number, timeScale = config.timeScale): number {
  const v = speed > 0 ? speed : STOCK_MOVE_SPEED / timeScale;
  return (tiles / v) * 1000;
}

const EMPTY: ObjStack = { id: 0, contained: [] };
/** how long after a wound appears the attacker's map update is still taken as the attack (wall ms) */
const WOUND_SOURCE_MS = 3000;

export class World {
  cells = new Map<string, Cell>();
  players = new Map<number, Player>();
  heard: Heard[] = [];
  /** people who died within our view (we got their death update) */
  deaths: SeenDeath[] = [];
  selfId: number | null = null;
  food = 0;
  foodCapacity = 0;
  heat = 0.5;
  foodTime = 0;
  yumBonus = 0;
  /** when (World.now) food or yum bonus last went down: the server's next drain is foodTime after it */
  foodDropAt: number | null = null;
  /** our own living children, last seen position and time (see ChildRecord) */
  children = new Map<number, ChildRecord>();
  craving: number | null = null;
  learnedTools = new Set<number>();
  dead = false;
  deathReason: string | null = null;
  lastMoveSeq = 1;
  /** last done_moving seq the server confirmed for us */
  doneMovingSeq = 0;
  /** set when server forced our position; must FORCE-ack before acting */
  forcedPos: [number, number] | null = null;
  /**
   * Home, as the official client tracks it: the Home Marker nearest the
   * centre of the first map chunk (within 16 tiles; a child born near its
   * family's marker inherits it), or a marker this character placed itself.
   */
  home: { x: number; y: number } | null = null;
  /** where this character's body first appeared (birth spot, or where an Eve spawned) */
  birthPos: [number, number] | null = null;
  /** outside the family's homeland, as the server's cues say (see Homesick); null = not homesick */
  homesick: Homesick | null = null;
  /** the last walk we sent (Body.move), on the World clock: which way a homeland crossing went */
  lastMove: { t: number; from: [number, number]; to: [number, number] } | null = null;
  /** who carried us at the last message (a put-down ends what the homeland cues can tell) */
  private carriedBy: number | null = null;
  private firstPU = true;
  /** client-side copy of TIME_SCALE (the server's game clock slowdown) */
  timeScale = config.timeScale;
  private warnedTimeScale = false;
  private firstChunk = true;
  /** when our held object became the one we hold (decay timers; a picked-up item keeps its timer) */
  heldSince: Since | null = null;
  /**
   * Our current wound: where we stood when it appeared and the attacker seen
   * next to us then (null while none has been seen). Kept while the wound
   * changes on the body (Hog Cut -> Clean Hog Cut).
   */
  private wound: { at: [number, number]; t: number; by: string | null } | null = null;
  /** objects that just left a cell or our hands, by id: their timers carry over when they turn up again */
  private handoff = new Map<number, Since & { at: number }>();
  /** what this character saw happen nearby, oldest first (see SeenEvent); this World is one life */
  seen: SeenEvent[] = [];
  /** events with the same key within this many ms (one turn of the clock `now` runs on) are one line */
  seenMergeMs = turnClock(config).cycleMs;
  /** people within PEOPLE_RADIUS at the last check; null until our own first update */
  private inView: Set<number> | null = null;
  /** others' held object before their last change, for what a map change was done with */
  private heldBefore = new Map<number, { id: number; t: number }>();
  /** a dangerous animal's coalescing key, by the cell it is on */
  private animalKeys = new Map<string, string>();
  private animalSeq = 0;

  /**
   * @param now the clock timestamps and extrapolation run on: wall time, or with
   * the turn clock (TURN_CLOCK=1) a game-paced clock that stands still while the
   * server's game clock is paused (TurnCoordinator.now), so ages, walks and
   * timers don't advance while everyone thinks
   */
  constructor(private gd: GameData, private ev: WorldEvents = {}, readonly now: () => number = Date.now) {}

  get self(): Player | undefined {
    return this.selfId == null ? undefined : this.players.get(this.selfId);
  }

  /**
   * When an object that just turned up (in a cell or in our hands) came to
   * be: if the same kind just left our hands or a cell (picked up, dropped),
   * it's that object and keeps its age; if `near` (our tile) has one next to
   * it, the pickup's map update hasn't arrived yet; else it is new now.
   */
  private arrivalOf(id: number, now: number, near?: [number, number]): Since {
    if (!(id > 0)) return { t: now, exact: true };
    const h = this.handoff.get(id);
    if (h && now - h.at < HANDOFF_MS) {
      this.handoff.delete(id);
      return { t: h.t, exact: h.exact };
    }
    const me = this.self;
    if (!near && me && me.held.id === id && this.heldSince) return { ...this.heldSince };
    if (near)
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const c = this.cells.get(`${near[0] + dx},${near[1] + dy}`);
          if (c && c.obj.id === id && c.since != null) return { t: c.since, exact: !!c.sinceExact };
        }
    return { t: now, exact: true };
  }

  /**
   * Who gave our current wound: the attacker that was next to us when it
   * appeared ("a Wild Boar"); if none was seen, every animal or weapon that
   * gives this wound ("a Wolf or a Grizzly Bear or ..."). Null if we have no
   * wound or nothing is known to give it.
   */
  woundSource(): string | null {
    const me = this.self;
    const c = me ? this.gd.condition(me.held.id) : null;
    if (!me || c?.kind !== "wound") return null;
    if (!this.wound) this.wound = { at: [me.x, me.y], t: this.now(), by: null };
    // the attacker's map update can arrive just after the wound
    if (!this.wound.by && this.now() - this.wound.t <= WOUND_SOURCE_MS) this.wound.by = this.attackerNear(this.wound.at, c);
    if (this.wound.by) return this.wound.by;
    return c.from.length ? c.from.map(withArticle).join(" or ") : null;
  }

  /** attackers that give this condition on or next to `at`, as they are now or were just before their last change */
  private attackerNear(at: [number, number], c: Condition): string | null {
    const names: string[] = [];
    const now = this.now();
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const cell = this.cell(at[0] + dx, at[1] + dy);
        if (!cell) continue;
        const ids = [cell.obj.id];
        if (cell.prev && now - cell.t <= WOUND_SOURCE_MS) ids.push(cell.prev);
        for (const id of ids) {
          if (!(id > 0) || !c.attackers.has(this.gd.base(id))) continue;
          const n = withArticle(this.gd.name(this.gd.base(id)));
          if (!names.includes(n)) names.push(n);
        }
      }
    return names.length ? names.join(" or ") : null;
  }

  /** When the object at x,y came to be (null if unknown). */
  sinceAt(x: number, y: number): Since | null {
    const c = this.cell(x, y);
    return c && c.since != null ? { t: c.since, exact: !!c.sinceExact } : null;
  }

  cell(x: number, y: number): Cell | undefined {
    return this.cells.get(`${x},${y}`);
  }

  objAt(x: number, y: number): ObjStack {
    return this.cell(x, y)?.obj ?? EMPTY;
  }

  /** Walkable as far as we know. Unknown cells count as walkable. */
  walkable(x: number, y: number): boolean {
    const c = this.cell(x, y);
    if (!c) return true;
    return !this.gd.blocksWalking(c.obj.id);
  }

  /** Who is carrying player p, if anyone we can see. */
  carrierOf(p: Player): Player | undefined {
    for (const q of this.players.values()) if (q.held.id === -p.id) return q;
    return undefined;
  }

  /** Wall ms to walk `tiles` at our own server-reported speed. */
  walkMs(tiles: number): number {
    return walkMs(tiles, this.self?.moveSpeed ?? 0, this.timeScale);
  }

  /**
   * Where someone is now: a carried baby is with its carrier; someone else
   * mid-walk is at their interpolated spot along the path (x,y already hold
   * the destination). Our own x,y is exact (actions wait for done_moving).
   */
  posOf(p: Player, now = this.now()): [number, number] {
    const c = this.carrierOf(p);
    if (c) return this.posOf(c, now);
    if (p.id === this.selfId || !this.isWalking(p, now) || !p.move) return [p.x, p.y];
    const { from, path, totalMs } = p.move;
    const left = (p.moveEndsAt - now) / Math.max(1, totalMs);
    const steps = path.length;
    const done = Math.max(0, Math.min(steps, Math.floor((1 - left) * steps)));
    return done === 0 ? from : path[done - 1];
  }

  /** someone else is walking right now (their x,y is where they're going) */
  isWalking(p: Player, now = this.now()): boolean {
    return p.moving && now < p.moveEndsAt;
  }

  /**
   * Age extrapolated from the last update, capped at OHOL's max age. Without
   * the cap a stalled server or a sleeping host (wall time passes, no updates)
   * made ages run past 60 (deaths were recorded at 82 and 84).
   */
  currentAge(p: Player): number {
    if (!p.ageRate) return Math.min(p.age, MAX_AGE);
    // ageRate is wall s/year from the server, so this already follows TIME_SCALE
    return Math.min(MAX_AGE, p.age + (this.now() - p.ageAt) / 1000 / p.ageRate);
  }

  handle(m: ServerMessage) {
    const now = this.now();
    switch (m.type) {
      case "MC": {
        const { chunk } = m;
        for (let cy = 0; cy < chunk.h; cy++)
          for (let cx = 0; cx < chunk.w; cx++) {
            const c = chunk.cells[cy * chunk.w + cx];
            if (!c) continue;
            const k = `${chunk.x + cx},${chunk.y + cy}`;
            const prev = this.cells.get(k);
            const keep = prev && prev.obj.id === c.obj.id && prev.since != null;
            this.cells.set(k, { biome: c.biome, floor: c.floor, obj: c.obj, t: now, since: keep ? prev.since : now, sinceExact: keep ? prev.sinceExact : false });
          }
        if (this.firstChunk) {
          this.firstChunk = false;
          this.findStartingHome(chunk);
        }
        break;
      }
      case "MX":
        for (const ch of m.changes) {
          const k = `${ch.x},${ch.y}`;
          const prev = this.cells.get(k);
          const by = ch.responsibleId < -1 ? -ch.responsibleId : ch.responsibleId;
          const same = prev && prev.obj.id === ch.obj.id && prev.since != null;
          if (!same && prev && prev.obj.id > 0 && prev.since != null) this.handoff.set(prev.obj.id, { t: prev.since, exact: !!prev.sinceExact, at: now });
          const since = same ? { t: prev.since!, exact: !!prev.sinceExact } : this.arrivalOf(ch.obj.id, now);
          this.cells.set(k, { biome: prev?.biome ?? -1, floor: ch.floor, obj: ch.obj, t: now, by: by > 0 ? by : undefined, prev: prev?.obj.id, since: since.t, sinceExact: since.exact });
          if (ch.from) {
            // moving object (animal) left its old cell
            const fk = `${ch.from.x},${ch.from.y}`;
            const fc = this.cells.get(fk);
            if (fc && fc.obj.id === ch.obj.id) this.cells.set(fk, { ...fc, obj: EMPTY, t: now, since: now, sinceExact: true });
          }
          this.trackPlacedHome(ch.x, ch.y, prev?.obj.id ?? 0, ch.obj.id, ch.responsibleId);
          this.seeMapChange(ch.x, ch.y, prev?.obj ?? null, ch.obj, by, ch.from ?? null);
          this.ev.onMapChange?.(ch.x, ch.y, prev?.obj ?? null, ch.obj, ch.responsibleId);
        }
        break;
      case "PU": {
        // client convention: our player is the last one in the first PU batch
        if (this.firstPU && m.updates.length && this.selfId == null) {
          this.selfId = m.updates[m.updates.length - 1].id;
        }
        this.firstPU = false;
        for (const u of m.updates) this.applyPU(u, now);
        break;
      }
      case "PM":
        for (const mv of m.moves) {
          const p = this.players.get(mv.id);
          if (!p) continue;
          const dest = mv.path.length ? mv.path[mv.path.length - 1] : mv.start;
          // track destination; PU with done_moving will confirm
          p.x = dest[0];
          p.y = dest[1];
          p.moving = true;
          p.moveEndsAt = now + mv.etaSec * 1000; // etaSec: wall seconds (TIME_SCALE applied by the server)
          p.move = { from: mv.start, path: mv.path, totalMs: Math.max(mv.totalSec, mv.etaSec) * 1000 };
          p.lastSeen = now;
        }
        break;
      case "PO":
        for (const id of m.ids) {
          if (id === this.selfId) continue;
          const p = this.players.get(id);
          if (p && this.inView?.delete(id)) this.pushSeen("view", "{0} went out of view", [this.snap(p)], `view:${id}`);
          this.players.delete(id);
        }
        break;
      case "PS":
        for (const s of m.says) {
          const p = this.players.get(s.id);
          const r = readSpeechTags(s.text);
          // a private line about someone else (your leader, a new baby, an expert...), sent as if we said it:
          // the client shows it as a pointer, not speech
          if (r.notice) {
            // where that person is, as the client's arrow shows it
            const who = r.pointerId != null ? this.players.get(r.pointerId) : undefined;
            const where = who ? ` They are at (${this.posOf(who)[0]}, ${this.posOf(who)[1]}).` : "";
            this.pushHeard({ t: now, speakerId: null, x: 0, y: 0, text: cleanText(r.notice + where, SPEECH_MAX), notice: true });
            continue;
          }
          // "+FAMILY+" (server makeOffspringSayMarker) and other +WORD+ markers are client cues, not words;
          // over our own head ("+HOMESICK+") they are a feeling, not something we said
          const cues: string[] = [];
          const words = r.text.replace(CUE_RE, (_m, w: string) => (cues.push(w), " ")).replace(/\s+/g, " ").trim();
          if (s.id === this.selfId) for (const c of cues) this.selfCue(c, now);
          if (!words) continue;
          const text = cleanText(words + (r.followerId != null && r.followerId === this.selfId && s.id !== this.selfId ? " [an order to you: you are their nearest follower]" : ""), SPEECH_MAX);
          const h: Heard = { t: now, speakerId: s.id, x: p?.x ?? 0, y: p?.y ?? 0, text };
          this.pushHeard(h);
        }
        break;
      case "LS":
        for (const s of m.says) this.pushHeard({ t: now, speakerId: null, x: s.x, y: s.y, text: cleanText(s.text, SPEECH_MAX) });
        break;
      case "FX":
        if (m.food.lastAteId > 0 && this.food !== m.food.food) this.ev.onAte?.(m.food.lastAteId);
        if (m.food.food + m.food.yumBonus < this.food + this.yumBonus) this.foodDropAt = now;
        this.food = m.food.food;
        this.foodCapacity = m.food.capacity;
        this.yumBonus = m.food.yumBonus;
        break;
      case "HX":
        this.heat = m.heat.heat;
        this.foodTime = m.heat.foodTime; // wall seconds per food pip (TIME_SCALE applied by the server)
        break;
      case "NM":
        for (const n of m.names) {
          const name = cleanText([n.first, n.last].filter(Boolean).join(" "), NAME_MAX) || null;
          const p = this.players.get(n.id);
          const wasNamed = !!(p?.name ?? this.names.get(n.id));
          const by = name && !wasNamed ? this.markNaming(n.id, name, now) : undefined;
          if (p) p.name = name;
          if (name && !wasNamed && p && by !== undefined) this.seeNaming(p, name, by);
          if (name) this.names.set(n.id, name);
          else this.names.delete(n.id);
        }
        break;
      case "FW":
        // who follows whom (server leadership; the client draws badges from this). -1 = follows no one
        for (const f of m.follows) {
          if (f.leaderId > 0) this.leaders.set(f.followerId, f.leaderId);
          else this.leaders.delete(f.followerId);
          this.leaderSeen.set(f.followerId, now);
        }
        break;
      case "LN":
        for (const l of m.lineages) {
          this.lineage.set(l.id, { ancestors: l.ancestors, eveId: l.eveId });
          const p = this.players.get(l.id);
          if (p) {
            p.ancestors = l.ancestors;
            p.eveId = l.eveId;
          }
        }
        break;
      case "DY":
        for (const id of m.ids) {
          const p = this.players.get(id);
          if (p) p.dying = true;
        }
        break;
      case "HE":
        for (const id of m.ids) {
          const p = this.players.get(id);
          if (p) p.dying = false;
        }
        break;
      case "CR":
        this.craving = m.craving.foodId;
        break;
      case "LR":
        for (const id of m.toolIds) this.learnedTools.add(id);
        break;
      case "MS":
        // shown to the player as an on-screen notice by the client
        // "**" is the client's line break ("ORDER FROM YOUR LADY:**PICK UP BABY")
        this.pushHeard({ t: now, speakerId: null, x: 0, y: 0, text: cleanText(m.text.replace(/:?\s*\*\*\s*/g, ": "), SPEECH_MAX), notice: true });
        break;
    }
    this.trackChildren(now);
    this.trackCarry();
    this.updateView(now);
  }

  /** Body: a walk was sent from `from` to `to` */
  noteMoveSent(from: [number, number], to: [number, number]) {
    this.lastMove = { t: this.now(), from: [from[0], from[1]], to: [to[0], to[1]] };
  }

  /** a +WORD+ cue the server put over our own head */
  private selfCue(word: string, now: number) {
    const was = this.homesick != null;
    if (word === "HOMESICK") {
      // the walk started inside the homeland (that's what made it a crossing): it lies back toward that start
      const m = this.lastMove && now - this.lastMove.t <= CUE_MOVE_MS ? this.lastMove : null;
      this.homesick = { t: now, toward: m ? compassWord(m.to, m.from) : null };
    } else if (word === "HOME" || word === "FREE REIN") this.homesick = null;
    this.ev.onCue?.(word, was);
  }

  /**
   * Put down after being carried: the server only checks our own walks, so a
   * carry in or out sends no cue. Whatever we felt before no longer says where
   * we are; drop it (the next walk across a border cues afresh).
   */
  private trackCarry() {
    const me = this.self;
    if (!me) return;
    const c = this.carrierOf(me)?.id ?? null;
    if (this.carriedBy != null && c == null) this.homesick = null;
    this.carriedBy = c;
  }

  /** A child's age now, extrapolated from the record (as currentAge does for a player). */
  childAge(c: ChildRecord): number {
    return c.ageRate ? c.age + (this.now() - c.ageAt) / 1000 / c.ageRate : c.age;
  }

  /** Refresh our children's records from the players in range; drop those who would be adults now. */
  private trackChildren(now: number) {
    const me = this.selfId;
    if (me == null) return;
    for (const p of this.players.values()) {
      if (p.id === me || p.ancestors[0] !== me) continue;
      const [x, y] = this.posOf(p, now);
      this.children.set(p.id, { id: p.id, name: p.name ?? this.names.get(p.id) ?? null, female: p.female, age: p.age, ageAt: p.ageAt, ageRate: p.ageRate, x, y, t: now });
    }
    for (const c of this.children.values()) {
      const n = this.names.get(c.id);
      if (n) c.name = n;
      if (this.childAge(c) >= CHILD_RECORD_MAX_AGE) this.children.delete(c.id);
    }
  }

  // LivingLifePage.cpp: "Found starting home marker" (closest to the birth chunk centre, dist^2 < 16*16)
  private findStartingHome(chunk: { x: number; y: number; w: number; h: number }) {
    const cx = chunk.x + Math.floor(chunk.w / 2), cy = chunk.y + Math.floor(chunk.h / 2);
    let best = 16 * 16;
    for (let y = chunk.y; y < chunk.y + chunk.h; y++)
      for (let x = chunk.x; x < chunk.x + chunk.w; x++) {
        if (!this.gd.isHomeMarker?.(this.objAt(x, y).id)) continue;
        const d = (x - cx) ** 2 + (y - cy) ** 2;
        if (d < best) {
          best = d;
          this.home = { x, y };
        }
      }
  }

  // the client adds a home when we place a marker, and drops it when we remove ours
  private trackPlacedHome(x: number, y: number, before: number, after: number, responsibleId: number) {
    const rid = responsibleId < -1 ? -responsibleId : responsibleId;
    if (this.selfId == null || rid !== this.selfId || !this.gd.isHomeMarker) return;
    if (this.gd.isHomeMarker(after)) this.home = { x, y };
    else if (this.gd.isHomeMarker(before) && this.home?.x === x && this.home?.y === y) this.home = null;
  }

  /** names and lineage persist even when players go out of range */
  names = new Map<number, string>();
  /** follower id -> leader id, from FW messages */
  leaders = new Map<number, number>();
  /** follower id -> when (World.now) the latest FW about them arrived, also for "follows no one" (merged views prefer the newest) */
  leaderSeen = new Map<number, number>();
  lineage = new Map<number, { ancestors: number[]; eveId: number }>();

  /**
   * Someone just got their first name: the naming line heard moments ago
   * ("YOU ARE AURORA BREEZE", the server writes the full name into it) gets
   * "[this named #7]", the text version of seeing the name appear over that
   * person in the client. Without it a bystander can't tell who was named.
   */
  private markNaming(id: number, name: string, now: number): number | null {
    const first = name.split(" ")[0];
    for (let i = this.heard.length - 1; i >= 0; i--) {
      const h = this.heard[i];
      if (now - h.t > 15_000) break;
      if (h.notice || h.named || !NAMING_LINE.test(h.text) || !new RegExp(`\\b${first.replace(/[^A-Z0-9]/gi, "")}\\b`, "i").test(h.text)) continue;
      h.named = id;
      h.spoken ??= h.text;
      h.text = `${h.text} [this named ${id === this.selfId ? "you" : `#${id}`}]`;
      return h.speakerId;
    }
    return null;
  }

  private pushHeard(h: Heard) {
    this.heard.push(h);
    if (this.heard.length > 100) this.heard.splice(0, this.heard.length - 100);
    this.ev.onHeard?.(h);
  }

  private applyPU(u: PlayerUpdate, now: number) {
    if (u.x == null || u.y == null) {
      const p = this.players.get(u.id);
      const reason = u.deathReason ?? "unknown";
      if (u.id === this.selfId) {
        this.dead = true;
        this.deathReason = reason;
        // the death update's own age is the server's (authoritative) age at death
        const age = Number.isFinite(u.age) && u.age > 0 ? Math.min(u.age, MAX_AGE) : p ? this.currentAge(p) : 0;
        this.ev.onSelfDied?.(reason, age);
      } else if (p) {
        const [dx, dy] = this.posOf(p);
        this.deaths.push({ t: now, id: p.id, name: p.name ?? this.names.get(p.id) ?? null, female: p.female, age: this.currentAge(p), x: dx, y: dy, ancestors: p.ancestors, eveId: p.eveId });
        if (this.deaths.length > 20) this.deaths.shift();
        this.inView?.delete(p.id);
        if (this.inSight([dx, dy], PEOPLE_RADIUS)) {
          const cause = deathCause(this.gd, reason);
          this.pushSeen("died", `{0} died at (${dx}, ${dy})${cause ? `: ${cause}` : ""}`, [this.snap(p)]);
        }
        this.ev.onPlayerDied?.(p, reason);
      }
      if (u.id !== this.selfId) this.players.delete(u.id);
      this.children.delete(u.id);
      return;
    }
    let p = this.players.get(u.id);
    const isNew = !p;
    if (!p) {
      const lin = this.lineage.get(u.id);
      p = {
        id: u.id, displayId: u.displayId, x: u.x, y: u.y, moving: false, moveEndsAt: 0,
        age: u.age, ageAt: now, ageRate: u.ageRate, moveSpeed: u.moveSpeed, held: u.held, clothing: u.clothing, heat: u.heat,
        name: this.names.get(u.id) ?? null, female: this.gd.isFemaleDisplay(u.displayId), dying: false,
        lastSeen: now, ancestors: lin?.ancestors ?? [], eveId: lin?.eveId ?? null,
      };
      this.players.set(u.id, p);
    }
    p.displayId = u.displayId;
    p.female = this.gd.isFemaleDisplay(u.displayId) ?? p.female;
    p.age = u.age;
    p.ageAt = now;
    p.ageRate = u.ageRate;
    p.moveSpeed = u.moveSpeed;
    // the server's seconds per year says which time scale it runs at
    if (!this.warnedTimeScale && u.ageRate > 0 && Math.abs(u.ageRate / (STOCK_SECONDS_PER_YEAR * this.timeScale) - 1) > 0.05) {
      this.warnedTimeScale = true;
      console.warn(`TIME_SCALE mismatch: server reports ${u.ageRate} s/year, client TIME_SCALE=${this.timeScale} expects ${STOCK_SECONDS_PER_YEAR * this.timeScale}`);
    }
    if (u.id === this.selfId && (isNew || p.held.id !== u.held.id || !this.heldSince)) {
      if (!isNew && p.held.id > 0 && this.heldSince) this.handoff.set(p.held.id, { ...this.heldSince, at: now });
      this.heldSince = isNew && u.held.id > 0 ? { t: now, exact: false } : this.arrivalOf(u.held.id, now, [u.x, u.y]);
    }
    if (u.id === this.selfId) {
      const c = this.gd.condition?.(u.held.id);
      if (c?.kind !== "wound") this.wound = null;
      else if (!this.wound) this.wound = { at: [u.x, u.y], t: now, by: this.attackerNear([u.x, u.y], c) };
    }
    if (u.id !== this.selfId) this.seePlayerUpdate(p, u, isNew, now);
    else if (!isNew) this.seeWound(p, u.held.id, now);
    p.held = u.held;
    p.clothing = u.clothing;
    p.heat = u.heat;
    p.lastSeen = now;
    if (u.doneMovingSeq > 0 || u.forced) {
      p.x = u.x;
      p.y = u.y;
      p.moving = false;
    } else if (!p.moving || now > p.moveEndsAt + 500) {
      // a move the server ended without done_moving (e.g. picked up mid-crawl) mustn't freeze the position
      p.x = u.x;
      p.y = u.y;
      p.moving = false;
    }
    if (u.id === this.selfId) {
      if (!this.birthPos) this.birthPos = [u.x, u.y];
      if (u.doneMovingSeq > 0) this.doneMovingSeq = u.doneMovingSeq;
      if (u.forced) this.forcedPos = [u.x, u.y];
      this.ev.onSelfUpdate?.(u);
    }
    if (isNew && u.id !== this.selfId) {
      // a newborn: logged as born, not as coming into view
      if (this.inView && u.age < 0.2 && this.inSight(this.posOf(p, now), PEOPLE_RADIUS)) {
        this.inView.add(p.id);
        this.pushSeen("born", `{0} was born at (${p.x}, ${p.y})`, [this.snap(p)]);
      }
      this.ev.onPlayerAppeared?.(p);
    }
  }

  // --- what we saw happen nearby (WHAT YOU SAW NEARBY)

  private inSight(at: [number, number], radius: number): boolean {
    const me = this.self;
    if (!me) return false;
    const [mx, my] = this.posOf(me);
    return Math.max(Math.abs(at[0] - mx), Math.abs(at[1] - my)) <= radius;
  }

  private distToMe(at: [number, number]): number {
    const [mx, my] = this.self ? this.posOf(this.self) : at;
    return Math.max(Math.abs(at[0] - mx), Math.abs(at[1] - my));
  }

  /** a person as they are now, frozen (age stops at this moment) */
  private snap(p: Player): Player {
    return { ...p, age: this.currentAge(p), ageAt: this.now(), ageRate: 0, ancestors: [...p.ancestors], name: p.name ?? this.names.get(p.id) ?? null };
  }

  private who(id: number): Player | { id: number } {
    const p = this.players.get(id);
    return p ? this.snap(p) : { id };
  }

  private pushSeen(kind: SeenEvent["kind"], text: string, people: SeenEvent["people"], key?: string) {
    const now = this.now();
    const ids = people.map((p) => p.id).join(",");
    const k = key ?? `${kind}|${ids}|${text}`;
    let i = this.seen.length - 1;
    while (i >= 0 && !((this.seen[i].key ?? `${this.seen[i].kind}|${this.seen[i].people.map((p) => p.id).join(",")}|${this.seen[i].text}`) === k && now - this.seen[i].t < this.seenMergeMs)) i--;
    if (i >= 0) {
      const [e] = this.seen.splice(i, 1);
      // a dangerous animal that came into view this turn still did, wherever it went next
      const appeared = e.kind === "animal_seen" && kind === "animal_move";
      this.seen.push({ ...e, t: now, kind: appeared ? e.kind : kind, text: appeared ? text.replace(" moved to ", " came into view at ") : text, people });
      return;
    }
    // a person busy with many things: at most SEEN_DID_PER_TURN lines a turn, the rest counted on the last
    if (kind === "did") {
      const mine = this.seen.filter((e) => e.kind === "did" && e.people[0]?.id === people[0]?.id && now - e.t < this.seenMergeMs);
      if (mine.length >= SEEN_DID_PER_TURN) {
        const last = mine[mine.length - 1];
        last.more = (last.more ?? 0) + 1;
        return;
      }
    }
    const e: SeenEvent = { t: now, kind, text, people, ...(key ? { key } : {}) };
    this.seen.push(e);
    if (this.seen.length > SEEN_KEEP) this.seen.splice(0, this.seen.length - SEEN_KEEP);
    try {
      this.ev.onSeen?.(e);
    } catch {
      // a listener must not break message handling
    }
  }

  /** people coming into and going out of view; the first check after we appear only notes who is there */
  private updateView(now: number) {
    const me = this.self;
    if (!me || this.dead) return;
    const seed = !this.inView;
    const view = (this.inView ??= new Set());
    for (const p of this.players.values()) {
      if (p.id === me.id) continue;
      const inR = this.inSight(this.posOf(p, now), PEOPLE_RADIUS);
      if (inR && !view.has(p.id)) {
        view.add(p.id);
        if (!seed) {
          const [x, y] = this.posOf(p, now);
          this.pushSeen("view", `{0} came into view at (${x}, ${y})`, [this.snap(p)], `view:${p.id}`);
        }
      } else if (!inR && view.has(p.id)) {
        view.delete(p.id);
        if (!seed) this.pushSeen("view", "{0} went out of view", [this.snap(p)], `view:${p.id}`);
      }
    }
  }

  /** another person's update: a baby picked up or put down, a wound, something eaten */
  private seePlayerUpdate(p: Player, u: PlayerUpdate, isNew: boolean, now: number) {
    if (isNew) return;
    const before = p.held.id, after = u.held.id;
    if (before !== after) this.heldBefore.set(p.id, { id: before, t: now });
    if (!this.inView?.has(p.id) && !this.inSight(this.posOf(p, now), PEOPLE_RADIUS)) return;
    if (before !== after) {
      if (after < 0) this.pushSeen("baby", "{0} picked up {1}", [this.snap(p), this.who(-after)]);
      if (before < 0) this.pushSeen("baby", "{0} put down {1}", [this.snap(p), this.who(-before)]);
    }
    this.seeWound(p, after, now);
    if (u.justAte && u.lastAteId > 0) this.pushSeen("ate", `{0} ate ${withArticle(this.gd.name(u.lastAteId))}`, [this.snap(p)]);
  }

  /** a wound appeared on someone in view (ourselves included): who or what gave it, when seen */
  private seeWound(p: Player, after: number, now: number) {
    const c = this.gd.condition?.(after);
    if (c?.kind !== "wound" || this.gd.condition?.(p.held.id)?.kind === "wound") return;
    const at = this.posOf(p, now);
    if (!this.inSight(at, PEOPLE_RADIUS)) return;
    const by = this.attackerNear(at, c);
    const name = this.gd.name(after);
    this.pushSeen("wounded", by ? `${by} attacked {0}: ${name}` : `{0} was wounded: ${name}`, [p.id === this.selfId ? { id: p.id } : this.snap(p)]);
  }

  private seeNaming(p: Player, name: string, by: number | null) {
    // no naming line heard (names of people already named, sent as we arrive): nothing seen; ours: in YOUR LAST ACTIONS
    if (by == null || by === this.selfId) return;
    const speaker = by != null ? this.players.get(by) : undefined;
    if (!this.inSight(this.posOf(p), PEOPLE_RADIUS) && !(speaker && this.inSight(this.posOf(speaker), PEOPLE_RADIUS))) return;
    const target = p.id === this.selfId ? { id: p.id } : this.snap(p);
    if (by === p.id) this.pushSeen("named", `{0} named themself ${name}`, [target]);
    else this.pushSeen("named", `{0} named {1}`, [this.who(by), target]);
  }

  /** a map change in view: another person's doing, or a dangerous animal moving */
  private seeMapChange(x: number, y: number, before: ObjStack | null, after: ObjStack, by: number, from: { x: number; y: number } | null) {
    const gd = this.gd;
    const a = before?.id ?? 0, b = after.id;
    // dangerous animals
    if (b > 0 && (gd.dangerRadius?.(b) ?? 0) > 0) {
      const fk = from ? `${from.x},${from.y}` : null;
      const key = (fk && this.animalKeys.get(fk)) || `animal:${++this.animalSeq}`;
      if (fk) this.animalKeys.delete(fk);
      this.animalKeys.set(`${x},${y}`, key);
      if (this.animalKeys.size > 200) this.animalKeys.delete(this.animalKeys.keys().next().value!);
      if (!this.inSight([x, y], VIEW_RADIUS)) return;
      const d = this.distToMe([x, y]);
      const what = withArticle(gd.name(b));
      const there = `(${x}, ${y}), ${d} tile${d === 1 ? "" : "s"} from you`;
      const wasInView = from ? this.inSight([from.x, from.y], VIEW_RADIUS) : a > 0 && gd.base(a) === gd.base(b);
      if (!wasInView && !(a > 0 && (gd.dangerRadius?.(a) ?? 0) > 0)) return this.pushSeen("animal_seen", `${what} came into view at ${there}`, [], key);
      if (!from) return;
      const merged = this.seen.some((e) => e.key === key && this.now() - e.t < this.seenMergeMs);
      // closer than it was (or already on this turn's line: the line keeps its latest position)
      if (merged || d < this.distToMe([from.x, from.y])) this.pushSeen("animal_move", `${what} moved to ${there}`, [], key);
      return;
    }
    if (!(by > 0) || by === this.selfId || from) return;
    if (!this.inSight([x, y], VIEW_RADIUS)) return;
    const actor = this.players.get(by);
    const people = [actor ? this.snap(actor) : { id: by }];
    const at = `(${x}, ${y})`;
    const n = (id: number) => withArticle(gd.name(id));
    let text: string | null = null;
    if (!a && b) text = `put down ${n(b)} at ${at}`;
    else if (a && !b) text = `picked up ${n(a)} from ${at}`;
    else if (a && b && a !== b && gd.name(a) !== gd.name(b)) {
      const hb = this.heldBefore.get(by);
      const held = hb && this.now() - hb.t <= 1000 ? hb.id : actor?.held.id ?? 0;
      const tool = held > 0 && !gd.condition?.(held) ? n(held) : null;
      text = `used ${tool ?? "bare hands"} on ${n(a)} at ${at}: it became ${gd.name(b)}`;
    } else if (a && a === b && before) {
      const count = (s: ObjStack) => {
        const m = new Map<number, number>();
        for (const c of s.contained) m.set(c.id, (m.get(c.id) ?? 0) + 1);
        return m;
      };
      const was = count(before), now = count(after);
      const added = [...now].find(([id, k]) => k > (was.get(id) ?? 0))?.[0];
      const removed = [...was].find(([id, k]) => k > (now.get(id) ?? 0))?.[0];
      if (added && added > 0) text = `put ${n(added)} into ${n(a)} at ${at}`;
      else if (removed && removed > 0) text = `took ${n(removed)} out of ${n(a)} at ${at}`;
    }
    if (text) this.pushSeen("did", `{0} ${text}`, people);
  }
}

/** a death's cause as the server reports it: "starved", "old age", "killed by a Wolf"; null if unknown */
export function deathCause(gd: GameData, reason: string): string | null {
  const r = reason.replace(/^reason_/, "");
  if (r === "hunger") return "starved";
  if (r === "age") return "old age";
  const k = /^killed_(\d+)$/.exec(r);
  if (k) return `killed by ${withArticle(gd.name(Number(k[1])))}`;
  if (!r || r === "unknown" || r === "disconnected") return null;
  return r.replace(/_/g, " ");
}


/** naming phrases (server settings babyNamingPhrases / familyNamingPhrases) at the start of a line */
const NAMING_LINE = /^(YOU ARE|YOU'RE|YOURE|YOUR NAME IS|I NAME YOU|I CALL YOU|I AM|I'M|IM|CALL ME)\b/i;

/** private-line tags (server.cpp PS "... *leader <id> *map x y"): what the line points at */
const NOTICE_TAGS: Record<string, string> = {
  leader: "your leader", baby: "a new baby in your family", mother: "your mother", expert: "an expert", owner: "the owner", visitor: "a visitor", prop: "property",
};

/**
 * Speech lines can carry client metadata the real client turns into arrows:
 * "ORDER, DIG *follower 3 *map 82 15" (public: the leader's order, marking the
 * nearest follower) or "MY LADY *leader 2 *map 82 15" (private: who your leader
 * is). Returns the spoken words without tags; for a private pointer line, a
 * plain notice instead ("Your leader is #2 (your lady)").
 */
export function readSpeechTags(raw: string): { text: string; notice: string | null; followerId: number | null; pointerId?: number | null } {
  const tags: { k: string; n: number | null }[] = [];
  const text = raw
    .replace(/\s*\*([a-z]+)((?:\s+-?\d+(?:\.\d+)?)*)/gi, (_m, k: string, nums: string) => {
      const first = nums.trim().split(/\s+/)[0];
      tags.push({ k: k.toLowerCase(), n: first ? Number(first) : null });
      return "";
    })
    .replace(/#\s*$/, "")
    .trim();
  const follower = tags.find((t) => t.k === "follower");
  const pointer = tags.find((t) => t.k in NOTICE_TAGS);
  if (!pointer) return { text, notice: null, followerId: follower?.n ?? null };
  const id = pointer.n != null && Number.isFinite(pointer.n) ? ` #${pointer.n}` : "";
  const pointerId = pointer.n != null && Number.isFinite(pointer.n) ? pointer.n : null;
  if (pointer.k === "leader") {
    const title = /^MY\s+(.+)$/i.exec(text)?.[1]?.toLowerCase();
    return { text, notice: `Your leader is${id || " someone"}${title ? ` (your ${title})` : ""}.`, followerId: null, pointerId };
  }
  return { text, notice: `${text || NOTICE_TAGS[pointer.k]}${id ? ` (${NOTICE_TAGS[pointer.k]}:${id})` : ""}`, followerId: null, pointerId };
}
