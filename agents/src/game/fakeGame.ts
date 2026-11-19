// A tiny in-process stand-in for the OHOL server, for tests: it accepts the
// commands Body sends (MOVE, USE, DROP, SELF, BABY; SWAP and REMV change nothing) and answers with the
// messages a real server would send (PU, MX, FX), applying transitions from
// the real game data. Movement is instant; replies arrive after a few ms.
// Not a faithful server: just enough to test skills end to end.

import type { GameData } from "./gameData.ts";
import { World } from "./world.ts";
import type { ObjStack, PlayerUpdate, ServerMessage } from "../protocol/types.ts";

const EMPTY: ObjStack = { id: 0, contained: [] };

export interface FakePlayer {
  id: number;
  x: number;
  y: number;
  age: number;
  held: number; // negative = carrying baby -id
  female: boolean;
  motherId?: number;
  /** worn object per slot (0 hat .. 5 backpack) */
  clothing?: number[];
}

export class FakeGame {
  readonly world: World;
  readonly sent: string[] = [];
  readonly players = new Map<number, FakePlayer>();
  readonly tiles = new Map<string, number>();
  food = 10;
  /** what is left in hand after eating a food (Banana -> Banana Peel) */
  readonly eatLeaves = new Map<number, number>();
  cap = 20;
  /** ms timeline of when each baby was set down / picked up: [t, babyId, "down"|"up"] */
  readonly babyLog: [number, number, "down" | "up"][] = [];
  private moveSeqDone = 0;
  /** dropping onto a loose item swaps them, as the real server does (off by default: older tests expect a refusal) */
  dropSwaps = false;

  constructor(private gd: GameData, readonly selfId = 1, private delayMs = 5, now?: () => number) {
    this.world = new World(gd, {}, now);
  }

  /** Body's connection */
  get conn() {
    return { send: (cmd: string) => this.onCommand(cmd) };
  }

  addPlayer(p: FakePlayer) {
    this.players.set(p.id, p);
  }

  setTile(x: number, y: number, id: number) {
    if (id) this.tiles.set(`${x},${y}`, id);
    else this.tiles.delete(`${x},${y}`);
  }

  tile(x: number, y: number) {
    return this.tiles.get(`${x},${y}`) ?? 0;
  }

  /** Send the initial state (map around self, all players, food). Call after setup. */
  start(radius = 24) {
    const me = this.players.get(this.selfId)!;
    const w = radius * 2 + 1;
    const cells = [];
    for (let cy = 0; cy < w; cy++)
      for (let cx = 0; cx < w; cx++) {
        const id = this.tile(me.x - radius + cx, me.y - radius + cy);
        cells.push({ biome: 0, floor: 0, obj: id ? { id, contained: [] } : EMPTY });
      }
    // self must be last in the first PU batch (client convention)
    const others = [...this.players.values()].filter((p) => p.id !== this.selfId);
    this.world.handle({ type: "MC", chunk: { x: me.x - radius, y: me.y - radius, w, h: w, cells } });
    this.world.handle({ type: "PU", updates: [...others, me].map((p) => this.pu(p)) });
    this.world.handle({ type: "LN", lineages: [...this.players.values()].filter((p) => p.motherId).map((p) => ({ id: p.id, ancestors: [p.motherId!], eveId: p.motherId! })) });
    this.world.handle(this.fx());
  }

  private pu(p: FakePlayer, over: Partial<PlayerUpdate> = {}): PlayerUpdate {
    return {
      id: p.id, displayId: p.female ? 19 : 347, facing: 0, action: false, actionTarget: [0, 0],
      held: { id: p.held, contained: [] }, heldOriginValid: false, heldOrigin: [0, 0], heldTransitionSourceId: 0,
      heat: 0.07, doneMovingSeq: 0, forced: false, x: p.x, y: p.y, age: p.age, ageRate: 60, moveSpeed: 3.75,
      clothing: (p.clothing ?? [0, 0, 0, 0, 0, 0]).map((c) => (c ? { id: c, contained: [] } : EMPTY)), justAte: false, lastAteId: 0, responsibleId: -1,
      heldYum: false, heldLearned: false, ...over,
    };
  }

  private fx(lastAteId = 0): ServerMessage {
    return { type: "FX", food: { food: this.food, capacity: this.cap, lastAteId, lastAteFillMax: 0, moveSpeed: 3.75, responsibleId: -1, yumBonus: 0, yumMultiplier: 1 } };
  }

  private later(...msgs: ServerMessage[]) {
    setTimeout(() => {
      for (const m of msgs) this.world.handle(m);
    }, this.delayMs);
  }

  private mx(x: number, y: number): ServerMessage {
    const id = this.tile(x, y);
    return { type: "MX", changes: [{ x, y, floor: 0, obj: id ? { id, contained: [] } : EMPTY, responsibleId: this.selfId }] };
  }

  private near(me: FakePlayer, x: number, y: number) {
    return Math.max(Math.abs(me.x - x), Math.abs(me.y - y)) <= 1;
  }

  private onCommand(cmd: string) {
    this.sent.push(cmd);
    const me = this.players.get(this.selfId)!;
    const [verb, ...a] = cmd.split(" ");
    const n = a.map(Number);
    switch (verb) {
      case "MOVE": {
        const seq = Number(a[2].slice(1));
        const d = n.slice(3);
        me.x = n[0] + d[d.length - 2];
        me.y = n[1] + d[d.length - 1];
        this.moveSeqDone = seq;
        const carried = me.held < 0 ? this.players.get(-me.held) : null;
        if (carried) [carried.x, carried.y] = [me.x, me.y];
        this.later({ type: "PU", updates: [this.pu(me, { doneMovingSeq: seq })] });
        break;
      }
      case "USE": {
        const [x, y] = n;
        if (!this.near(me, x, y)) return this.later({ type: "PU", updates: [this.pu(me)] });
        const target = this.tile(x, y);
        const t = this.gd.transition(me.held > 0 ? me.held : 0, target);
        let changed = true;
        if (t && me.held >= 0) {
          me.held = t.newActor;
          this.setTile(x, y, t.newTarget > 0 ? t.newTarget : 0);
        } else if (me.held === 0 && target && !this.gd.isPermanent(target)) {
          me.held = target;
          this.setTile(x, y, 0);
        } else changed = false;
        // like the server: a click that changes nothing sends no map change
        if (changed) this.later(this.mx(x, y), { type: "PU", updates: [this.pu(me)] });
        else this.later({ type: "PU", updates: [this.pu(me)] });
        break;
      }
      case "DROP": {
        const [x, y] = n;
        const there = this.tile(x, y);
        if (this.dropSwaps && this.near(me, x, y) && me.held > 0 && there && !this.gd.isPermanent(there)) {
          // server.cpp DROP onto a loose item: the two trade places
          this.setTile(x, y, me.held);
          me.held = there;
          return this.later(this.mx(x, y), { type: "PU", updates: [this.pu(me)] });
        }
        if (!this.near(me, x, y) || there) return this.later({ type: "PU", updates: [this.pu(me)] });
        if (me.held < 0) {
          const b = this.players.get(-me.held)!;
          [b.x, b.y] = [x, y];
          me.held = 0;
          this.babyLog.push([Date.now(), b.id, "down"]);
          this.later({ type: "PU", updates: [this.pu(me), this.pu(b)] });
        } else if (me.held > 0) {
          this.setTile(x, y, me.held);
          me.held = 0;
          this.later(this.mx(x, y), { type: "PU", updates: [this.pu(me)] });
        }
        break;
      }
      case "SELF": {
        const f = this.gd.get(me.held)?.food ?? 0;
        if (f > 0 && this.food < this.cap) {
          const ate = me.held;
          this.food = Math.min(this.cap, this.food + f);
          me.held = this.eatLeaves.get(ate) ?? 0;
          this.later(this.fx(ate), { type: "PU", updates: [this.pu(me)] });
        } else if (me.held > 0 && "htsbp".includes(this.gd.get(me.held)?.clothing ?? "n")) {
          const slot = { h: 0, t: 1, s: 2, b: 4, p: 5 }[this.gd.get(me.held)!.clothing as "h"]!;
          (me.clothing ??= [0, 0, 0, 0, 0, 0])[slot] = me.held;
          me.held = 0;
          this.later({ type: "PU", updates: [this.pu(me)] });
        } else this.later({ type: "PU", updates: [this.pu(me)] });
        break;
      }
      case "BABY": {
        const id = n[2];
        const b = this.players.get(id);
        // server.cpp BABY: only someone under babyAge (5) whom nobody holds
        if (!b || me.held !== 0 || !this.near(me, b.x, b.y) || b.age >= 5 || [...this.players.values()].some((q) => q.held === -id)) return this.later({ type: "PU", updates: [this.pu(me)] });
        me.held = -id;
        [b.x, b.y] = [me.x, me.y];
        this.food = Math.max(0, this.food - 1); // nursing pickup cost
        this.babyLog.push([Date.now(), id, "up"]);
        this.later({ type: "PU", updates: [this.pu(me)] }, this.fx());
        break;
      }
      case "SWAP":
      case "REMV":
        // not simulated: the server's answer when nothing changes
        this.later({ type: "PU", updates: [this.pu(me)] });
        break;
      default:
        break;
    }
  }
}
