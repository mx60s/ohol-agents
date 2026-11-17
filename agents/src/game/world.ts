// What one agent knows about the world: map cells it has been sent, players
// in range, its own body state. Built purely from server messages that agent's
// connection received, so it's exactly what that character could perceive.

import type { ServerMessage, ObjStack, PlayerUpdate } from "../protocol/types.ts";
import type { GameData } from "./gameData.ts";
import { cleanText } from "../safety.ts";
import { config } from "../config.ts";

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
}

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

export interface WorldEvents {
  onSelfDied?(reason: string, age: number): void;
  onPlayerDied?(p: Player, reason: string): void;
  onPlayerAppeared?(p: Player): void;
  onHeard?(h: Heard): void;
  onMapChange?(x: number, y: number, before: ObjStack | null, after: ObjStack, responsibleId: number): void;
  onSelfUpdate?(u: PlayerUpdate): void;
  onAte?(foodId: number): void;
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
  private firstPU = true;
  /** client-side copy of TIME_SCALE (the server's game clock slowdown) */
  timeScale = config.timeScale;
  private warnedTimeScale = false;
  private firstChunk = true;
  /** when our held object became the one we hold (decay timers; a picked-up item keeps its timer) */
  heldSince: Since | null = null;
  /** objects that just left a cell or our hands, by id: their timers carry over when they turn up again */
  private handoff = new Map<number, Since & { at: number }>();

  constructor(private gd: GameData, private ev: WorldEvents = {}) {}

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
  posOf(p: Player, now = Date.now()): [number, number] {
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
  isWalking(p: Player, now = Date.now()): boolean {
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
    return Math.min(MAX_AGE, p.age + (Date.now() - p.ageAt) / 1000 / p.ageRate);
  }

  handle(m: ServerMessage) {
    const now = Date.now();
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
          if (id !== this.selfId) this.players.delete(id);
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
          const text = cleanText(r.text + (r.followerId != null && r.followerId === this.selfId && s.id !== this.selfId ? " [an order to you: you are their nearest follower]" : ""), SPEECH_MAX);
          const h: Heard = { t: now, speakerId: s.id, x: p?.x ?? 0, y: p?.y ?? 0, text };
          this.pushHeard(h);
        }
        break;
      case "LS":
        for (const s of m.says) this.pushHeard({ t: now, speakerId: null, x: s.x, y: s.y, text: cleanText(s.text, SPEECH_MAX) });
        break;
      case "FX":
        if (m.food.lastAteId > 0 && this.food !== m.food.food) this.ev.onAte?.(m.food.lastAteId);
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
          if (p) p.name = name;
          if (name) this.names.set(n.id, name);
          else this.names.delete(n.id);
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
  lineage = new Map<number, { ancestors: number[]; eveId: number }>();

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
        this.ev.onPlayerDied?.(p, reason);
      }
      if (u.id !== this.selfId) this.players.delete(u.id);
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
    if (isNew && u.id !== this.selfId) this.ev.onPlayerAppeared?.(p);
  }
}


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
