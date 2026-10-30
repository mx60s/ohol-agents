// Deterministic low-level control: pathfinding, walking, and turning
// high-level intents ("use the bush at 3,4") into protocol commands.
// Every method resolves to a short plain-text result the LLM gets back.

import type { Connection } from "../protocol/connection.ts";
import type { World } from "./world.ts";
import type { GameData } from "./gameData.ts";

type Pos = [number, number];

const DIRS8: Pos[] = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
const DIRS4: Pos[] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const MAX_STEP_RANGE = 15; // server rejects deltas beyond +/-16
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Body {
  private moveSeq = 1;

  constructor(private conn: Connection, private world: World, private gd: GameData) {}

  get pos(): Pos | null {
    const s = this.world.self;
    return s ? [s.x, s.y] : null;
  }

  private send(cmd: string) {
    this.conn.send(cmd);
  }

  /** Ack a forced position if the server demanded one. */
  syncForce() {
    const f = this.world.forcedPos;
    if (f) {
      this.send(`FORCE ${f[0]} ${f[1]}`);
      this.world.forcedPos = null;
    }
  }

  /** A* over known cells within a box. 8-way, no diagonal corner cutting. */
  findPath(from: Pos, goals: Pos[], maxNodes = 4000): Pos[] | null {
    if (!goals.length) return null;
    const goalSet = new Set(goals.map((g) => `${g[0]},${g[1]}`));
    if (goalSet.has(`${from[0]},${from[1]}`)) return [];
    const h = (x: number, y: number) => Math.min(...goals.map((g) => Math.max(Math.abs(g[0] - x), Math.abs(g[1] - y))));
    const open: { x: number; y: number; g: number; f: number }[] = [{ x: from[0], y: from[1], g: 0, f: h(from[0], from[1]) }];
    const came = new Map<string, string>();
    const gScore = new Map<string, number>([[`${from[0]},${from[1]}`, 0]]);
    let n = 0;
    while (open.length && n++ < maxNodes) {
      let bi = 0;
      for (let i = 1; i < open.length; i++) if (open[i].f < open[bi].f) bi = i;
      const cur = open.splice(bi, 1)[0];
      const ck = `${cur.x},${cur.y}`;
      if (goalSet.has(ck)) {
        const path: Pos[] = [];
        let k: string | undefined = ck;
        while (k && k !== `${from[0]},${from[1]}`) {
          const [x, y] = k.split(",").map(Number);
          path.unshift([x, y]);
          k = came.get(k);
        }
        return path;
      }
      for (const [dx, dy] of DIRS8) {
        const nx = cur.x + dx, ny = cur.y + dy;
        // server rule: can't walk "down" (y-1) out of a blocking object you stand in
        if (dy === -1 && cur.x === from[0] && cur.y === from[1] && !this.world.walkable(from[0], from[1])) continue;
        if (!this.world.walkable(nx, ny)) continue;
        if (dx && dy && (!this.world.walkable(cur.x + dx, cur.y) || !this.world.walkable(cur.x, cur.y + dy))) continue;
        const nk = `${nx},${ny}`;
        const g = cur.g + (dx && dy ? 1.4 : 1);
        if (g >= (gScore.get(nk) ?? Infinity)) continue;
        gScore.set(nk, g);
        came.set(nk, ck);
        open.push({ x: nx, y: ny, g, f: g + h(nx, ny) });
      }
    }
    return null;
  }

  /** Walk until standing on one of `goals`. Handles long trips in legs. */
  async walkTo(goals: Pos[], maxLegs = 8): Promise<string> {
    for (let leg = 0; leg < maxLegs; leg++) {
      const p = this.pos;
      if (!p) return "can't move: no body";
      if (goals.some((g) => g[0] === p[0] && g[1] === p[1])) return "arrived";
      let path = this.findPath(p, goals);
      if (!path) {
        // head toward the nearest goal in a straight-ish line
        const g = goals[0];
        const tx = p[0] + clamp(g[0] - p[0], -MAX_STEP_RANGE, MAX_STEP_RANGE);
        const ty = p[1] + clamp(g[1] - p[1], -MAX_STEP_RANGE, MAX_STEP_RANGE);
        path = this.findPath(p, [[tx, ty]], 2000) ?? this.findPath(p, ring(tx, ty, 2), 2000);
        if (!path || !path.length) return "no path found";
      }
      // cut path to stay within delta range of start
      const legPath: Pos[] = [];
      for (const s of path) {
        if (Math.abs(s[0] - p[0]) > MAX_STEP_RANGE || Math.abs(s[1] - p[1]) > MAX_STEP_RANGE) break;
        legPath.push(s);
      }
      if (!legPath.length) return "no path found";
      const ok = await this.move(p, legPath);
      if (!ok) return "movement interrupted";
    }
    const p = this.pos!;
    return goals.some((g) => g[0] === p[0] && g[1] === p[1]) ? "arrived" : "still on the way (trip too long)";
  }

  private async move(start: Pos, path: Pos[]): Promise<boolean> {
    this.syncForce();
    this.moveSeq = Math.max(this.moveSeq + 1, 2);
    const seq = this.moveSeq;
    const deltas = path.map(([x, y]) => `${x - start[0]} ${y - start[1]}`).join(" ");
    this.send(`MOVE ${start[0]} ${start[1]} @${seq} ${deltas}`);
    // ~3.75 tiles/s for an adult; generous margin for babies, elders, loads
    const deadline = Date.now() + (path.length / 3.75) * 1000 * 3 + 3000;
    while (Date.now() < deadline) {
      await sleep(100);
      if (this.world.dead) return false;
      if (this.world.forcedPos) {
        this.syncForce();
        return false;
      }
      if (this.world.doneMovingSeq >= seq) return true;
    }
    return false;
  }

  /** Get orthogonally adjacent to (or onto, if walkable) a target tile. */
  async approach(x: number, y: number): Promise<string> {
    const p = this.pos;
    if (!p) return "no body";
    if (isAdj4(p, [x, y]) || (p[0] === x && p[1] === y)) return "arrived";
    const goals: Pos[] = DIRS4.map(([dx, dy]) => [x + dx, y + dy] as Pos).filter(([gx, gy]) => this.world.walkable(gx, gy));
    if (this.world.walkable(x, y)) goals.push([x, y]);
    if (!goals.length) return "target is surrounded, can't reach it";
    const r = await this.walkTo(goals);
    const q = this.pos!;
    return isAdj4(q, [x, y]) || (q[0] === x && q[1] === y) ? "arrived" : r;
  }

  /** Send an action and wait for the server to update us or the tile. */
  private async act(cmd: string, x: number, y: number): Promise<{ before: string; after: string; heldBefore: string; heldAfter: string }> {
    this.syncForce();
    const before = this.gd.describeStack(this.world.objAt(x, y));
    const heldBefore = this.heldName();
    const t0 = Date.now();
    this.send(cmd);
    // wait for a self PU or a tile change, up to 2.5s
    let lastSeen = this.world.self?.lastSeen ?? 0;
    const cellT = this.world.cell(x, y)?.t ?? 0;
    while (Date.now() - t0 < 2500) {
      await sleep(100);
      const s = this.world.self;
      if ((s && s.lastSeen > lastSeen && s.lastSeen >= t0) || (this.world.cell(x, y)?.t ?? 0) > cellT) {
        await sleep(150); // let the rest of the frame land
        break;
      }
    }
    return { before, after: this.gd.describeStack(this.world.objAt(x, y)), heldBefore, heldAfter: this.heldName() };
  }

  heldName(): string {
    const s = this.world.self;
    if (!s) return "nothing";
    if (s.held.id < 0) {
      const b = this.world.players.get(-s.held.id);
      return `baby ${b?.name ?? "#" + -s.held.id}`;
    }
    return this.gd.describeStack(s.held);
  }

  private summarize(verb: string, x: number, y: number, r: { before: string; after: string; heldBefore: string; heldAfter: string }) {
    if (r.before === r.after && r.heldBefore === r.heldAfter) return `${verb} at (${x},${y}): nothing happened`;
    const parts: string[] = [];
    if (r.before !== r.after) parts.push(`tile (${x},${y}) ${r.before} -> ${r.after}`);
    if (r.heldBefore !== r.heldAfter) parts.push(`holding ${r.heldBefore} -> ${r.heldAfter}`);
    return `${verb}: ${parts.join("; ")}`;
  }

  /** Use held item (or bare hand) on target tile; also picks things up. */
  async use(x: number, y: number): Promise<string> {
    const a = await this.approach(x, y);
    if (a !== "arrived") return `couldn't reach (${x},${y}): ${a}`;
    const target = this.world.objAt(x, y).id;
    const r = await this.act(`USE ${x} ${y}${target > 0 ? " " + target : ""}`, x, y);
    return this.summarize("use", x, y, r);
  }

  /** Drop held item onto a tile (or into a container there). */
  async drop(x?: number, y?: number): Promise<string> {
    const p = this.pos;
    if (!p) return "no body";
    if (this.world.self?.held.id === 0) return "not holding anything";
    if (x == null || y == null) {
      // nearest empty walkable neighbor, else own tile
      const spot = [p, ...DIRS4.map(([dx, dy]) => [p[0] + dx, p[1] + dy] as Pos)].find(([sx, sy]) => this.world.objAt(sx, sy).id === 0);
      if (!spot) return "no empty spot nearby to drop on";
      [x, y] = spot;
    }
    const a = await this.approach(x, y);
    if (a !== "arrived") return `couldn't reach (${x},${y}): ${a}`;
    const r = await this.act(`DROP ${x} ${y} -1`, x, y);
    return this.summarize("drop", x, y, r);
  }

  /** Swap held item with the object on a tile. */
  async swap(x: number, y: number): Promise<string> {
    const a = await this.approach(x, y);
    if (a !== "arrived") return `couldn't reach (${x},${y}): ${a}`;
    const r = await this.act(`SWAP ${x} ${y}`, x, y);
    return this.summarize("swap", x, y, r);
  }

  /** Take an item out of a container on a tile. */
  async takeOut(x: number, y: number): Promise<string> {
    const a = await this.approach(x, y);
    if (a !== "arrived") return `couldn't reach (${x},${y}): ${a}`;
    const r = await this.act(`REMV ${x} ${y} -1`, x, y);
    return this.summarize("take out", x, y, r);
  }

  /** Eat held food, or put on held clothing. */
  async self(): Promise<string> {
    const p = this.pos;
    if (!p) return "no body";
    const s = this.world.self!;
    if (s.held.id === 0) return "not holding anything";
    const food0 = this.world.food;
    const r = await this.act(`SELF ${p[0]} ${p[1]} -1`, p[0], p[1]);
    if (this.world.food !== food0) return `ate ${r.heldBefore}; food ${food0} -> ${this.world.food}/${this.world.foodCapacity}`;
    return this.summarize("use on self", p[0], p[1], r);
  }

  /** Remove a piece of own clothing into hand. slot 0 hat 1 tunic 2/3 shoes 4 bottom 5 backpack */
  async undress(slot: number): Promise<string> {
    const p = this.pos;
    if (!p) return "no body";
    const r = await this.act(`SELF ${p[0]} ${p[1]} ${slot}`, p[0], p[1]);
    return this.summarize("take off clothing", p[0], p[1], r);
  }

  private async nearPlayer(id: number): Promise<{ p: Pos } | string> {
    const o = this.world.players.get(id);
    if (!o) return `person #${id} isn't nearby`;
    const a = await this.approach(o.x, o.y);
    if (a !== "arrived") return `couldn't reach person #${id}: ${a}`;
    const o2 = this.world.players.get(id);
    if (!o2) return `person #${id} left`;
    return { p: [o2.x, o2.y] };
  }

  /**
   * Find the nearest food we can get with bare hands (loose food item, or a
   * plant/bush that yields food when harvested by hand), get it, and eat it.
   * If carrying a baby, puts it down first and picks it back up after.
   */
  /** Hand-pickable food near us: loose food, or things that yield food by hand. */
  foodSources(maxDist = 20): { x: number; y: number; d: number; id: number; gives: number }[] {
    const s = this.world.self;
    if (!s) return [];
    const out: { x: number; y: number; d: number; id: number; gives: number }[] = [];
    for (let dy = -maxDist; dy <= maxDist; dy++)
      for (let dx = -maxDist; dx <= maxDist; dx++) {
        const x = s.x + dx, y = s.y + dy;
        const id = this.world.objAt(x, y).id;
        if (!id) continue;
        const t = this.gd.transition(0, id);
        let gives = 0;
        if (t && this.gd.isFood(t.newActor)) gives = t.newActor;
        else if (!t && this.gd.isFood(id) && !this.gd.isPermanent(id)) gives = id;
        if (gives) out.push({ x, y, d: Math.max(Math.abs(dx), Math.abs(dy)), id, gives });
      }
    return out.sort((a, b) => a.d - b.d);
  }

  async forage(tx?: number, ty?: number, maxDist = 20): Promise<string> {
    const s = this.world.self;
    if (!s) return "no body";
    if (this.world.food >= this.world.foodCapacity) return "you're full";
    const babyId = s.held.id < 0 ? -s.held.id : null;
    if (s.held.id > 0 && this.gd.isFood(s.held.id)) return await this.self();
    // pick the food source before freeing hands, so a bad target costs nothing
    const sources = this.foodSources(maxDist);
    let best: { x: number; y: number } | null = null;
    if (tx != null && ty != null) {
      best = sources.find((f) => f.x === tx && f.y === ty) ?? null;
      if (!best) return `nothing at (${tx},${ty}) gives food by hand`;
    } else best = sources[0] ?? null;
    if (!best) return `no food you can pick by hand within ${maxDist} tiles`;
    const notes: string[] = [];
    if (s.held.id !== 0) {
      notes.push(await this.drop());
      if (this.world.self?.held.id !== 0) return `couldn't free hands: ${notes.join("; ")}`;
    }
    const got = await this.use(best.x, best.y);
    const held = this.world.self?.held.id ?? 0;
    let result: string;
    if (held > 0 && this.gd.isFood(held)) result = await this.self();
    else result = `tried to get food at (${best.x},${best.y}): ${got}`;
    if (babyId != null) {
      const b = this.world.players.get(babyId);
      if (b) result += `; ${await this.pickUpBaby(babyId)}`;
    }
    return [...notes, result].join("; ");
  }

  /** Pick up a baby (or anyone small enough). */
  async pickUpBaby(id: number): Promise<string> {
    const n = await this.nearPlayer(id);
    if (typeof n === "string") return n;
    const r = await this.act(`BABY ${n.p[0]} ${n.p[1]} ${id}`, n.p[0], n.p[1]);
    for (let i = 0; i < 10 && this.world.self?.held.id !== -id; i++) await sleep(100);
    if (this.world.self?.held.id === -id) return `picked up ${this.heldName()}`;
    return r.heldBefore !== r.heldAfter ? `picked up ${r.heldAfter}` : `tried to pick up #${id}: nothing happened`;
  }

  /** Use held item on another person: feed them food, clothe a baby, heal a wound. */
  async useOnPerson(id: number): Promise<string> {
    const n = await this.nearPlayer(id);
    if (typeof n === "string") return n;
    const r = await this.act(`UBABY ${n.p[0]} ${n.p[1]} -1 ${id}`, n.p[0], n.p[1]);
    return r.heldBefore !== r.heldAfter ? `gave/used ${r.heldBefore} on #${id}; now holding ${r.heldAfter}` : `used held item on #${id}: nothing happened`;
  }

  say(text: string): string {
    const clean = text.replace(/[#\n\r]/g, " ").toUpperCase().trim();
    if (!clean) return "said nothing";
    const s = this.world.self;
    const limit = s ? Math.floor(this.world.currentAge(s)) + 1 : 10;
    this.send(`SAY 0 0 ${clean}`);
    return clean.length > limit ? `said "${clean.slice(0, limit)}" (cut off: at your age you can only say ${limit} letters)` : `said "${clean}"`;
  }

  /** Baby: jump out of arms / wiggle. */
  jump(): string {
    this.send("JUMP 0 0");
    return "wiggled";
  }

  emote(e: number): string {
    this.send(`EMOT 0 0 ${e}`);
    return "emoted";
  }
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

function isAdj4(a: Pos, b: Pos) {
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) === 1;
}

function ring(x: number, y: number, r: number): Pos[] {
  const out: Pos[] = [];
  for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) out.push([x + dx, y + dy]);
  return out;
}
