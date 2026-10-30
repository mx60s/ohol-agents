// What one agent knows about the world: map cells it has been sent, players
// in range, its own body state. Built purely from server messages that agent's
// connection received, so it's exactly what that character could perceive.

import type { ServerMessage, ObjStack, PlayerUpdate } from "../protocol/types.ts";
import type { GameData } from "./gameData.ts";

export interface Cell {
  biome: number;
  floor: number;
  obj: ObjStack;
  t: number; // ms when last updated
}

export interface Player {
  id: number;
  displayId: number;
  x: number;
  y: number;
  /** destination if moving */
  moving: boolean;
  moveEndsAt: number;
  age: number;
  ageAt: number; // ms when age was reported
  ageRate: number;
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
  private firstPU = true;

  constructor(private gd: GameData, private ev: WorldEvents = {}) {}

  get self(): Player | undefined {
    return this.selfId == null ? undefined : this.players.get(this.selfId);
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

  /** Position, accounting for being carried (carried babies move with the carrier). */
  posOf(p: Player): [number, number] {
    const c = this.carrierOf(p);
    return c ? [c.x, c.y] : [p.x, p.y];
  }

  currentAge(p: Player): number {
    if (!p.ageRate) return p.age;
    return p.age + (Date.now() - p.ageAt) / 1000 / p.ageRate;
  }

  handle(m: ServerMessage) {
    const now = Date.now();
    switch (m.type) {
      case "MC": {
        const { chunk } = m;
        for (let cy = 0; cy < chunk.h; cy++)
          for (let cx = 0; cx < chunk.w; cx++) {
            const c = chunk.cells[cy * chunk.w + cx];
            if (c) this.cells.set(`${chunk.x + cx},${chunk.y + cy}`, { biome: c.biome, floor: c.floor, obj: c.obj, t: now });
          }
        break;
      }
      case "MX":
        for (const ch of m.changes) {
          const k = `${ch.x},${ch.y}`;
          const prev = this.cells.get(k);
          this.cells.set(k, { biome: prev?.biome ?? -1, floor: ch.floor, obj: ch.obj, t: now });
          if (ch.from) {
            // moving object (animal) left its old cell
            const fk = `${ch.from.x},${ch.from.y}`;
            const fc = this.cells.get(fk);
            if (fc && fc.obj.id === ch.obj.id) this.cells.set(fk, { ...fc, obj: EMPTY, t: now });
          }
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
          p.moveEndsAt = now + mv.etaSec * 1000;
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
          const h: Heard = { t: now, speakerId: s.id, x: p?.x ?? 0, y: p?.y ?? 0, text: s.text };
          this.pushHeard(h);
        }
        break;
      case "LS":
        for (const s of m.says) this.pushHeard({ t: now, speakerId: null, x: s.x, y: s.y, text: s.text });
        break;
      case "FX":
        if (m.food.lastAteId > 0 && this.food !== m.food.food) this.ev.onAte?.(m.food.lastAteId);
        this.food = m.food.food;
        this.foodCapacity = m.food.capacity;
        this.yumBonus = m.food.yumBonus;
        break;
      case "HX":
        this.heat = m.heat.heat;
        this.foodTime = m.heat.foodTime;
        break;
      case "NM":
        for (const n of m.names) {
          const p = this.players.get(n.id);
          if (p) p.name = [n.first, n.last].filter(Boolean).join(" ");
          this.names.set(n.id, [n.first, n.last].filter(Boolean).join(" "));
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
    }
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
        this.ev.onSelfDied?.(reason, p ? this.currentAge(p) : u.age);
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
        age: u.age, ageAt: now, ageRate: u.ageRate, held: u.held, clothing: u.clothing, heat: u.heat,
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
    p.held = u.held;
    p.clothing = u.clothing;
    p.heat = u.heat;
    p.lastSeen = now;
    if (u.doneMovingSeq > 0 || u.forced) {
      p.x = u.x;
      p.y = u.y;
      p.moving = false;
    } else if (!p.moving) {
      p.x = u.x;
      p.y = u.y;
    }
    if (u.id === this.selfId) {
      if (u.doneMovingSeq > 0) this.doneMovingSeq = u.doneMovingSeq;
      if (u.forced) this.forcedPos = [u.x, u.y];
      this.ev.onSelfUpdate?.(u);
    }
    if (isNew && u.id !== this.selfId) this.ev.onPlayerAppeared?.(p);
  }
}
