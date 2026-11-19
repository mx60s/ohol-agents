// Deterministic low-level control: pathfinding, walking, and turning
// high-level intents ("use the bush at 3,4") into protocol commands.
// Every method resolves to a short plain-text result the LLM gets back.

import type { Connection } from "../protocol/connection.ts";
import type { World } from "./world.ts";
import { withArticle, type GameData } from "./gameData.ts";

type Pos = [number, number];

const DIRS8: Pos[] = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
const DIRS4: Pos[] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const CLOTHING_SLOTS = ["hat", "tunic", "front shoe", "back shoe", "bottom", "backpack"];
/** server.cpp minPickupBabyAge */
const MIN_PICKUP_BABY_AGE = 10;
/** server.cpp babyAge: only someone younger than this can be picked up */
const BABY_AGE = 5;
/** use, drop, swap and take out refuse a target tile farther than this (Chebyshev); "go" has no limit */
export const MAX_ACT_DIST = 24;
/** how far drop() looks for an empty tile when none is next to you */
const DROP_SEARCH_RADIUS = 3;
const MAX_STEP_RANGE = 15; // server rejects deltas beyond +/-16
/** a detour around a dangerous animal is taken if it is at most this many tiles longer */
const DANGER_DETOUR = 24;
/** how far around us dangerous animals are taken into account when pathing */
const DANGER_SCAN = 24;
/**
 * Tiles a dangerous animal can cover in one move: wolf, boar, bear and snake
 * transitions have desiredMoveDist 4 in OneLifeData7 (not in our data dump),
 * every 3 s (snake 10 s). Paths keep this far away, or attack distance + 1 if larger.
 */
export const ANIMAL_JUMP_TILES = 4;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** a tile change by someone else this recent (game ms, about two turns) is reported as "just now" */
const TILE_JUST_CHANGED_MS = 6_000;

export class Body {
  private moveSeq = 1;
  /** set by the agent: non-null = abandon a long walk or craft now (urgent event) */
  interrupt: (() => string | null) | null = null;

  constructor(private conn: Pick<Connection, "send">, private world: World, private gd: GameData) {}

  interruptReason(): string | null {
    return this.interrupt?.() ?? null;
  }

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

  /** notes about the last action (e.g. walking past a dangerous animal); read with takeNotes() */
  private notes: string[] = [];

  takeNotes(): string[] {
    const n = [...new Set(this.notes)];
    this.notes = [];
    return n;
  }

  /**
   * Tiles near known dangerous animals (within the distance they jump in one
   * move, or their attack distance + 1 if larger),
   * within DANGER_SCAN of `from`: tile key -> the animal's tile and id.
   */
  dangerZone(from: Pos, core = false): Map<string, { x: number; y: number; id: number }> {
    const m = new Map<string, { x: number; y: number; id: number }>();
    for (let dy = -DANGER_SCAN; dy <= DANGER_SCAN; dy++)
      for (let dx = -DANGER_SCAN; dx <= DANGER_SCAN; dx++) {
        const x = from[0] + dx, y = from[1] + dy;
        const id = this.world.objAt(x, y).id;
        const r = this.gd.dangerRadius(id);
        if (!r) continue;
        // core: only the tiles it can bite from (its attack distance); else also how far it can jump
        const k = core ? r : Math.max(r + 1, ANIMAL_JUMP_TILES);
        for (let ry = -k; ry <= k; ry++) for (let rx = -k; rx <= k; rx++) m.set(`${x + rx},${y + ry}`, { x, y, id });
      }
    return m;
  }

  /**
   * Path to one of `goals`, going around dangerous animals when there is a
   * way that's at most DANGER_DETOUR tiles longer (a human player sees the
   * boar and steers). Otherwise the plain shortest path.
   */
  findPath(from: Pos, goals: Pos[], maxNodes = 4000): Pos[] | null {
    const plain = this.astar(from, goals, maxNodes);
    if (!plain || !plain.length) return plain;
    const danger = this.dangerZone(from);
    if (!danger.size || !plain.some((s) => danger.has(`${s[0]},${s[1]}`))) return plain;
    // well clear of every animal, when that's not much longer (not possible if we start inside the margin)
    if (!danger.has(`${from[0]},${from[1]}`)) {
      const safe = this.astar(from, goals, maxNodes, danger);
      if (safe && safe.length <= plain.length + DANGER_DETOUR) return safe;
    }
    // at least out of biting range (starting near a swarm used to mean walking straight through it)
    const core = this.dangerZone(from, true);
    if (core.has(`${from[0]},${from[1]}`) || !plain.some((s) => core.has(`${s[0]},${s[1]}`))) return plain;
    const dodge = this.astar(from, goals, maxNodes, core);
    return dodge && dodge.length <= plain.length + DANGER_DETOUR ? dodge : plain;
  }

  /** A* over known cells. 8-way, no diagonal corner cutting. `avoid`: tiles treated as blocked (goals excepted). */
  private astar(from: Pos, goals: Pos[], maxNodes: number, avoid?: Map<string, unknown>): Pos[] | null {
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
        if (avoid?.has(nk) && !goalSet.has(nk)) continue;
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
    const start = this.pos;
    for (let leg = 0; leg < maxLegs; leg++) {
      const p = this.pos;
      if (!p) return "can't move: no body";
      if (goals.some((g) => g[0] === p[0] && g[1] === p[1])) return "arrived";
      const why = leg > 0 ? this.interruptReason() : null;
      if (why) return `stopped walking at (${p[0]},${p[1]}): ${why}`;
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
      // no way around: say which animal the path passes
      // the closest the path comes to each animal, once per animal
      const danger = this.dangerZone(p);
      const closest = new Map<string, { x: number; y: number; id: number; d: number }>();
      for (const s of legPath) {
        const a = danger.get(`${s[0]},${s[1]}`);
        if (!a) continue;
        const d = Math.max(Math.abs(s[0] - a.x), Math.abs(s[1] - a.y));
        const k = `${a.x},${a.y}`;
        if (!closest.has(k) || closest.get(k)!.d > d) closest.set(k, { ...a, d });
      }
      for (const a of closest.values())
        this.notes.push(`your path passed ${a.d === 0 ? "through" : `within ${a.d} tile${a.d === 1 ? "" : "s"} of`} ${withArticle(this.gd.name(a.id))} at (${a.x},${a.y}); no safer way around`);
      const heldBefore = this.world.self?.held.id ?? 0;
      const ok = await this.move(p, legPath);
      const wound = this.newWound(heldBefore);
      if (wound) return wound;
      if (!ok) return "movement interrupted";
    }
    const p = this.pos!;
    if (goals.some((g) => g[0] === p[0] && g[1] === p[1])) return "arrived";
    const went = start ? Math.max(Math.abs(p[0] - start[0]), Math.abs(p[1] - start[1])) : 0;
    return `still on the way (trip too long): you're now at (${p[0]},${p[1]}), ${went} tile${went === 1 ? "" : "s"} from where you started`;
  }

  /** "a Wild Boar wounded you at (3,4) (Hog Cut)" (every possible attacker if none was seen next to us) if we now hold a wound we didn't before */
  private newWound(heldBefore: number): string | null {
    const s = this.world.self;
    if (!s || s.held.id === heldBefore) return null;
    const c = this.gd.condition(s.held.id);
    if (!c || c.kind !== "wound") return null;
    return `stopped: ${this.world.woundSource() ?? "something"} wounded you at (${s.x},${s.y}) (${this.gd.name(s.held.id)})`;
  }

  private async move(start: Pos, path: Pos[]): Promise<boolean> {
    this.syncForce();
    this.moveSeq = Math.max(this.moveSeq + 1, 2);
    const seq = this.moveSeq;
    const deltas = path.map(([x, y]) => `${x - start[0]} ${y - start[1]}`).join(" ");
    this.send(`MOVE ${start[0]} ${start[1]} @${seq} ${deltas}`);
    // server-reported walking speed (follows TIME_SCALE); generous margin for babies, elders, loads
    // on the world's clock: with the turn clock a walk only progresses in act windows
    const deadline = this.world.now() + this.world.walkMs(path.length) * 3 + 3000;
    while (this.world.now() < deadline) {
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
  private async act(cmd: string, x: number, y: number): Promise<{ before: string; after: string; heldBefore: string; heldAfter: string; t0: number }> {
    this.syncForce();
    const before = this.gd.describeStack(this.world.objAt(x, y));
    const heldBefore = this.heldName();
    const t0 = this.world.now();
    const wall0 = Date.now();
    this.send(cmd);
    // wait for a self PU or a tile change, up to 2.5s (wall: the server answers even while its clock is paused)
    let lastSeen = this.world.self?.lastSeen ?? 0;
    const cellT = this.world.cell(x, y)?.t ?? 0;
    while (Date.now() - wall0 < 2500) {
      await sleep(100);
      const s = this.world.self;
      if ((s && s.lastSeen > lastSeen && s.lastSeen >= t0) || (this.world.cell(x, y)?.t ?? 0) > cellT) {
        await sleep(150); // let the rest of the frame land
        break;
      }
    }
    return { before, after: this.gd.describeStack(this.world.objAt(x, y)), heldBefore, heldAfter: this.heldName(), t0 };
  }

  heldName(): string {
    const s = this.world.self;
    if (!s) return "nothing";
    if (s.held.id < 0) {
      const b = this.world.players.get(-s.held.id);
      return `baby ${b?.name ?? "#" + -s.held.id}`;
    }
    const c = this.gd.condition(s.held.id);
    if (c && c.kind !== "mark") return `${this.gd.name(s.held.id)} (${c.kind})`;
    return this.gd.describeStack(s.held);
  }

  /** A wound or sickness in hand can't be put down, eaten or swapped. */
  private conditionBlock(): string | null {
    const s = this.world.self;
    const c = s ? this.gd.condition(s.held.id) : null;
    if (!c) return null;
    return c.kind === "mark" ? `your hands are taken by the ${this.gd.name(s!.held.id)} for now` : `your hands are taken by your ${c.kind} (${this.gd.name(s!.held.id)}); it can't be put down`;
  }

  private summarize(verb: string, x: number, y: number, r: { before: string; after: string; heldBefore: string; heldAfter: string }) {
    if (r.before === r.after && r.heldBefore === r.heldAfter) return `${verb} at (${x},${y}): nothing happened`;
    const parts: string[] = [];
    if (r.before !== r.after) parts.push(`tile (${x},${y}) ${r.before} -> ${r.after}`);
    if (r.heldBefore !== r.heldAfter) parts.push(`holding ${r.heldBefore} -> ${r.heldAfter}`);
    return `${verb}: ${parts.join("; ")}`;
  }

  /**
   * A target tile more than MAX_ACT_DIST from us: refused without moving. A model wrote (0,0) meaning
   * "next to me" and walked 130 tiles away from its baby.
   */
  private tooFar(verb: string, x: number, y: number): string | null {
    const p = this.pos;
    if (!p) return null;
    const d = Math.max(Math.abs(x - p[0]), Math.abs(y - p[1]));
    if (d <= MAX_ACT_DIST) return null;
    const near = verb === "drop" ? "drop without x,y puts it down next to you; " : "";
    return `${verb} at (${x},${y}): not done: (${x},${y}) is ${d} tiles from you at (${p[0]},${p[1]}); ${verb} works on tiles up to ${MAX_ACT_DIST} away; ${near}go there first to act on a far tile`;
  }

  /** Use held item (or bare hand) on target tile; also picks things up. */
  async use(x: number, y: number): Promise<string> {
    const far = this.tooFar("use", x, y);
    if (far) return far;
    const a = await this.approach(x, y);
    if (a !== "arrived") return `couldn't reach (${x},${y}): ${a}`;
    const target = this.world.objAt(x, y).id;
    const heldId = this.world.self?.held.id ?? 0;
    const blocked = this.conditionBlock();
    if (blocked) return `use at (${x},${y}): ${blocked}`;
    // arms full with a baby: the server ignores the click; a human sees the baby in their arms
    if (heldId < 0) return `use at (${x},${y}): nothing happened (your arms are full: you're carrying baby #${-heldId}; put the baby down first)`;
    const r = await this.act(`USE ${x} ${y}${target > 0 ? " " + target : ""}`, x, y);
    const out = this.summarize("use", x, y, r);
    // the age rule for picking things up (objects' minPickupAge) is visible in the client as a failed grab
    const me = this.world.self;
    const o = this.gd.get(target);
    if (/nothing happened$/.test(out) && me && me.held.id === 0 && o && !o.permanent && this.world.currentAge(me) < o.minPickupAge)
      return `${out} (you're too young to pick up the ${this.gd.name(target)}: it needs age ${o.minPickupAge})`;
    // the game has no transition for this pair (a human sees the same: the click does nothing); say so plainly
    // the client then shows its hint for the clicked thing (what works on it); we say the first few
    const held = heldId;
    if (/nothing happened$/.test(out) && held > 0 && o && !(o.numSlots > 0) && !this.gd.transition(held, target) && !this.gd.transition(this.gd.base(held), this.gd.base(target)))
      return `${out} (${withArticle(this.gd.name(held).replace(/ \(\d+\/\d+ left\)$/, ""))} does nothing on ${withArticle(this.gd.name(target))}${this.worksOn(target, held)})`;
    if (/nothing happened$/.test(out) && held === 0 && o && o.permanent && !(o.numSlots > 0) && !this.gd.transition(0, target))
      return `${out} (bare hands do nothing on ${withArticle(this.gd.name(target))}; it's fixed in place and can't be carried${this.worksOn(target, 0)})`;
    return /nothing happened$/.test(out) ? out + this.tileNow(x, y, r.t0) : out;
  }

  /** For an unexplained "nothing happened": what the tile has now, and who changed it just before (under the turn
   * clock everyone acts in the same window, so two people going for one tile is common: the second action was
   * planned on the old picture and quietly does nothing). */
  private tileNow(x: number, y: number, since: number): string {
    const c = this.world.cell(x, y);
    // "now" only when the cell changed while the action ran
    const n = c && c.t > since ? " now" : "";
    const now = c && c.obj.id > 0 ? `the tile at (${x},${y})${n} has ${this.gd.describeStack(c.obj)}` : `the tile at (${x},${y}) is${n} empty`;
    const me = this.world.self?.id;
    if (c?.by && c.by !== me && this.world.now() - c.t < TILE_JUST_CHANGED_MS) {
      const who = this.world.players.get(c.by);
      return ` (${now}; #${c.by}${who?.name ? " " + who.name : ""} changed it just now${c.prev ? `, it had ${this.gd.name(c.prev)}` : ""})`;
    }
    return ` (${now})`;
  }

  /** "; what works on it: a Kindling (not found in the wild: it is made; it becomes Fire)", from the client's hint list for the target */
  private worksOn(target: number, held: number): string {
    const name = (id: number) => this.gd.name(id);
    const uses = this.gd.hints(target).filter((t) => t.target === target && t.actor !== held).slice(0, 3);
    if (!uses.length) return "";
    const one = (t: { actor: number; newActor: number; newTarget: number }) => {
      const r: string[] = [];
      if (t.newActor !== t.actor) r.push(t.newActor ? `you get ${name(t.newActor)}` : `uses up the ${name(t.actor)}`);
      if (t.newTarget !== target && name(t.newTarget) !== name(target)) r.push(t.newTarget ? `it becomes ${name(t.newTarget)}` : "it's gone");
      const made = t.actor > 0 && this.gd.madeOnly(t.actor) ? "not found in the wild: it is made" : "";
      const note = [made, r.join(", ")].filter(Boolean).join("; ");
      return `${t.actor ? this.gd.articleName(t.actor, target) : "bare hands"}${note ? ` (${note})` : ""}`;
    };
    return `; what works on it: ${uses.map(one).join("; ")}`;
  }

  /**
   * Walk to a tile; if something there blocks walking, walk next to it
   * instead and say so (rather than "no path found" after the fact).
   */
  async go(x: number, y: number): Promise<string> {
    if (this.world.walkable(x, y)) return this.walkTo([[x, y]]);
    const what = this.gd.name(this.world.objAt(x, y).id);
    const r = await this.approach(x, y);
    const p = this.pos;
    if (r !== "arrived" || !p) return `the ${what} at (${x},${y}) blocks walking, and you couldn't get next to it: ${r}`;
    return `the ${what} at (${x},${y}) blocks walking; you're next to it at (${p[0]},${p[1]})`;
  }

  /** the tile the last drop was sent to and what was on it just before (give reads it) */
  private lastDrop: { at: Pos; there: number } | null = null;

  /** Drop held item onto a tile (or into a container there). */
  async drop(x?: number, y?: number): Promise<string> {
    const p = this.pos;
    if (!p) return "no body";
    if (this.world.self?.held.id === 0) return "not holding anything";
    const blocked = this.conditionBlock();
    if (blocked) return `can't drop: ${blocked}`;
    if (x != null && y != null) {
      const far = this.tooFar("drop", x, y);
      if (far) return far;
    }
    if ((x == null || y == null) && (this.world.self?.held.id ?? 0) < 0) {
      // server.cpp DROP: a baby can be set down on any tile that doesn't block walking, so on your own tile
      [x, y] = p;
    }
    if (x == null || y == null) {
      // nearest empty walkable neighbor, else own tile
      let spot = [p, ...DIRS4.map(([dx, dy]) => [p[0] + dx, p[1] + dy] as Pos)].find(([sx, sy]) => this.world.objAt(sx, sy).id === 0);
      // none right here: the nearest empty, walkable tile a few steps away (a player steps aside to put a thing down)
      if (!spot) spot = this.nearestEmpty(p, DROP_SEARCH_RADIUS) ?? undefined;
      if (!spot) return `no empty spot within ${DROP_SEARCH_RADIUS} tiles to drop on`;
      [x, y] = spot;
    }
    // an item aimed at a tile with something on it (not a container): put it on the nearest empty tile
    // instead. The game would swap with a loose item there; deliberate swaps are the swap action
    let moved = "";
    const heldNow = this.world.self?.held.id ?? 0;
    const occupant = this.gd.get(this.world.objAt(x, y).id);
    if (heldNow > 0 && occupant && !(occupant.numSlots > 0)) {
      const spot = this.nearestEmpty([x, y], DROP_SEARCH_RADIUS);
      if (spot) {
        moved = ` (the tile at (${x},${y}) has ${withArticle(this.gd.name(occupant.id))}, so you put it on the empty tile at (${spot[0]},${spot[1]}))`;
        [x, y] = spot;
      }
    }
    const a = await this.approach(x, y);
    if (a !== "arrived") return `couldn't reach (${x},${y}): ${a}`;
    const heldId = this.world.self?.held.id ?? 0;
    const there = this.world.objAt(x, y).id;
    this.lastDrop = { at: [x, y], there };
    const r = await this.act(`DROP ${x} ${y} -1`, x, y);
    const out = this.summarize("drop", x, y, r) + moved;
    // server.cpp DROP: an item goes only onto an empty tile or into a container with room
    const o = this.gd.get(there);
    if (/nothing happened$/.test(out) && heldId > 0 && o && !(o.numSlots > 0)) return `${out} (the tile has ${withArticle(this.gd.name(there))}; an item can only be put on an empty tile)`;
    // a container-like thing that won't take this item (a Fresh Grave has slots, but nothing can be put in it)
    if (/nothing happened$/.test(out) && heldId > 0 && o && o.numSlots > 0) {
      const n = this.world.objAt(x, y).contained.length;
      return n >= o.numSlots
        ? `${out} (the ${this.gd.name(there)} is full: ${n} of ${o.numSlots})`
        : `${out} (the ${this.gd.name(there)} can't take the ${this.gd.name(heldId)}; an item can only be put on an empty tile or into a container that takes it)`;
    }
    if (/nothing happened$/.test(out) && heldId < 0 && o) return `${out} (the baby wasn't set down on the ${this.gd.name(there)}; drop without x,y sets it down where you stand)`;
    // dropping onto a loose item swaps them (the game's rule): say it plainly, the raw "tile A -> B; holding B -> A" was missed
    const nowHeld = this.world.self?.held.id ?? 0;
    if (heldId > 0 && there > 0 && nowHeld > 0 && nowHeld !== heldId && this.world.objAt(x, y).id === heldId)
      return `swapped at (${x},${y}): you put down the ${this.gd.name(heldId)} and picked up the ${this.gd.name(nowHeld)} that was lying there (dropping onto an item swaps them; drop without x,y finds an empty tile)`;
    return /nothing happened$/.test(out) ? out + this.tileNow(x, y, r.t0) : out;
  }

  /** Nearest empty tile that doesn't block walking, within r (by steps), or null. */
  private nearestEmpty(p: Pos, r: number): Pos | null {
    let best: Pos | null = null, bd = Infinity;
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        const x = p[0] + dx, y = p[1] + dy, d = Math.abs(dx) + Math.abs(dy);
        if (d < bd && this.world.objAt(x, y).id === 0 && this.world.walkable(x, y)) {
          bd = d;
          best = [x, y];
        }
      }
    return best;
  }

  /** Swap held item with the object on a tile. */
  /** A person standing on an empty tile: aiming an item action there means aiming it at them */
  private personInsteadOfItem(x: number, y: number): string | null {
    if (this.world.objAt(x, y).id !== 0) return null;
    const me = this.world.self?.id;
    const p = [...this.world.players.values()].find((q) => q.id !== me && Math.round(this.world.posOf(q)[0]) === x && Math.round(this.world.posOf(q)[1]) === y);
    return p ? `there is no item at (${x},${y}), only #${p.id}${p.name ? ` ${p.name}` : ""}: things can't be swapped with or taken from a person; one puts it down, the other picks it up` : null;
  }

  async swap(x: number, y: number): Promise<string> {
    const far = this.tooFar("swap", x, y);
    if (far) return far;
    const blocked = this.conditionBlock();
    if (blocked) return `can't swap: ${blocked}`;
    const person = this.personInsteadOfItem(x, y);
    if (person) return `swap at (${x},${y}): nothing happened (${person})`;
    const a = await this.approach(x, y);
    if (a !== "arrived") return `couldn't reach (${x},${y}): ${a}`;
    const heldId = this.world.self?.held.id ?? 0;
    const there = this.world.objAt(x, y).id;
    const r = await this.act(`SWAP ${x} ${y}`, x, y);
    const out = this.summarize("swap", x, y, r);
    if (!/nothing happened$/.test(out)) return out;
    // server.cpp SWAP: the held item and a loose item on the tile trade places
    const o = this.gd.get(there);
    if (heldId === 0) return `${out} (your hands are empty; a swap trades what you hold for the item on the tile)`;
    if (there === 0) return `${out} (the tile at (${x},${y}) is empty; nothing there to swap with)`;
    if (o?.permanent) return `${out} (the ${this.gd.name(there)} is fixed in place and can't be carried)`;
    return out + this.tileNow(x, y, r.t0);
  }

  /** Take an item out of a container on a tile. */
  async takeOut(x: number, y: number): Promise<string> {
    const far = this.tooFar("take out", x, y);
    if (far) return far;
    const person = this.personInsteadOfItem(x, y);
    if (person) return `take out at (${x},${y}): nothing happened (${person})`;
    const a = await this.approach(x, y);
    if (a !== "arrived") return `couldn't reach (${x},${y}): ${a}`;
    const heldId = this.world.self?.held.id ?? 0;
    const stack = this.world.objAt(x, y);
    const there = stack.id;
    const r = await this.act(`REMV ${x} ${y} -1`, x, y);
    const out = this.summarize("take out", x, y, r);
    if (!/nothing happened$/.test(out)) return out;
    // server.cpp REMV: only with empty hands, from a container with something in it
    const o = this.gd.get(there);
    const fixed = o?.permanent ? `; it's fixed in place and can't be carried` : "";
    if (heldId !== 0) return `${out} (your hands are full: you're holding ${this.heldName()}; taking something out needs empty hands)`;
    if (there === 0) return `${out} (the tile at (${x},${y}) is empty)`;
    if (o && !(o.numSlots > 0)) return `${out} (the ${this.gd.name(there)} is not a container${fixed})`;
    if (o && !stack.contained.length) return `${out} (the ${this.gd.name(there)} has nothing in it${fixed})`;
    return out + this.tileNow(x, y, r.t0);
  }

  /** Eat held food, or put on held clothing. */
  async self(): Promise<string> {
    const p = this.pos;
    if (!p) return "no body";
    const s = this.world.self!;
    if (s.held.id === 0) return "not holding anything";
    const blocked = this.conditionBlock();
    if (blocked) return `can't: ${blocked}`;
    const heldId = s.held.id;
    const o = this.gd.get(heldId);
    const wearable = !!o?.clothing && o.clothing !== "n";
    if (heldId > 0 && !this.gd.isFood(heldId) && !wearable) return `the ${this.gd.name(heldId)} is not food and can't be worn`;
    const food0 = this.world.food;
    const worn0 = s.clothing.map((c) => c.id).join(",");
    const r = await this.act(`SELF ${p[0]} ${p[1]} -1`, p[0], p[1]);
    if (this.world.food !== food0) return `ate ${r.heldBefore}; food ${food0} -> ${this.world.food}/${this.world.foodCapacity}`;
    const me = this.world.self!;
    if (wearable && me.clothing.map((c) => c.id).join(",") !== worn0) {
      const slot = me.clothing.findIndex((c) => c.id === heldId);
      const where = slot >= 0 ? ` (${CLOTHING_SLOTS[slot]})` : "";
      return `you put on the ${this.gd.name(heldId)}${where}${me.held.id ? `; now holding ${this.heldName()}` : ""}`;
    }
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
   * Put what we hold down on an empty tile next to a person, for them to pick up (the game has no
   * direct handover: a player sets it at the other's feet). Returns the result and where it landed.
   */
  async give(id: number): Promise<{ text: string; at: Pos | null; item: string | null }> {
    const held = this.world.self?.held.id ?? 0;
    if (held === 0) return { text: "not holding anything to give", at: null, item: null };
    const blocked = this.conditionBlock();
    if (blocked) return { text: `can't give: ${blocked}`, at: null, item: null };
    const item = this.heldName();
    const n = await this.nearPlayer(id);
    if (typeof n === "string") return { text: n, at: null, item: null };
    const spot = [n.p, ...DIRS8.map(([dx, dy]) => [n.p[0] + dx, n.p[1] + dy] as Pos)].find(([x, y]) => this.world.objAt(x, y).id === 0 && this.world.walkable(x, y)) ?? this.nearestEmpty(n.p, DROP_SEARCH_RADIUS);
    if (!spot) return { text: `no empty tile next to #${id} to put the ${item} down`, at: null, item: null };
    this.lastDrop = null;
    const r = await this.drop(spot[0], spot[1]);
    // drop may have put it on another empty tile; the result says what happened to the tile and the hand
    const d = this.lastDrop as { at: Pos; there: number } | null;
    const at = d?.at ?? spot;
    const nowHeld = this.world.self?.held.id ?? 0;
    const onTile = this.world.objAt(at[0], at[1]).id;
    if (nowHeld === 0) return { text: `put the ${item} down next to #${id} at (${at[0]},${at[1]}); they can pick it up`, at, item };
    // the tile had a loose item by the time we dropped: the game swapped them
    if (held > 0 && nowHeld !== held && onTile === held)
      return {
        text: `swapped next to #${id} at (${at[0]},${at[1]}): you put down the ${item} and picked up the ${this.gd.name(nowHeld)} that was lying there (dropping onto an item swaps them); they can pick up the ${item}`,
        at,
        item,
      };
    if (nowHeld === held && (!d || onTile === d.there)) return { text: `couldn't put the ${item} down next to #${id}: ${r}`, at: null, item: null };
    return { text: `give to #${id}: ${r}`, at: null, item: null };
  }

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

  /**
   * Walk to a hand-pickable food (nearest, or the one at tx,ty), get it and
   * eat it. Whatever is in hand comes along: next to the food it is set down
   * for a moment (a baby too, so it is never left behind) and picked back up
   * right after eating.
   */
  async forage(tx?: number, ty?: number, maxDist = 20): Promise<string> {
    const s = this.world.self;
    if (!s) return "no body";
    if (this.world.currentAge(s) < 3) return `you're a baby: you can't feed yourself yet. Say "F" so a woman picks you up and nurses you`;
    const full = this.world.food >= this.world.foodCapacity;
    const blocked = this.conditionBlock();
    if (blocked) return `can't pick food: ${blocked}`;
    if (full && s.held.id !== 0) return `you're full (food ${this.world.food}/${this.world.foodCapacity}), so you can't eat; to pick food to carry, empty your hands and forage or use bare hands on the plant`;
    if (!full && s.held.id > 0 && this.gd.isFood(s.held.id)) return await this.self();
    // pick the food source before doing anything, so a bad target costs nothing
    const sources = this.foodSources(maxDist);
    let best: { x: number; y: number; gives: number } | null = null;
    if (tx != null && ty != null) {
      best = sources.find((f) => f.x === tx && f.y === ty) ?? null;
      if (!best) {
        // name the thing: "nothing gives food" at a coordinate was missed (an agent kept trying to eat wild cabbage)
        const there = this.world.objAt(tx, ty).id;
        const nearest = sources[0];
        const other = nearest ? ` The nearest food by hand: ${this.gd.name(nearest.id)} at (${nearest.x},${nearest.y}).` : ` No food you can pick by hand within ${maxDist} tiles.`;
        return there > 0 ? `the ${this.gd.name(there)} at (${tx},${ty}) is not food: nothing there can be eaten by hand.${other}` : `nothing at (${tx},${ty}) gives food by hand.${other}`;
      }
    } else best = sources[0] ?? null;
    if (!best) return `no food you can pick by hand within ${maxDist} tiles`;
    const babyId = s.held.id < 0 ? -s.held.id : null;
    const toolId = s.held.id > 0 ? s.held.id : 0;
    const toolName = toolId ? this.gd.name(toolId) : "";
    const a = await this.approach(best.x, best.y);
    if (a !== "arrived") return `couldn't reach the food at (${best.x},${best.y}): ${a}`;
    const parts: string[] = [];
    let toolAt: Pos | null = null;
    if (this.world.self?.held.id !== 0) {
      const r = await this.drop();
      if (this.world.self?.held.id !== 0) return `couldn't free your hands next to the food: ${r}`;
      if (toolId) toolAt = this.findNear(toolId, 1);
    }
    const got = await this.use(best.x, best.y);
    const held = this.world.self?.held.id ?? 0;
    // full: a click on the plant picks the food into your hands (as in the game); nothing is eaten
    if (full) return held > 0 ? `you're full, so you didn't eat: you picked ${withArticle(this.gd.name(held))} and are holding it` : `you're full; ${got}`;
    if (held > 0 && this.gd.isFood(held)) parts.push(await this.self());
    else parts.push(`tried to get food at (${best.x},${best.y}): ${got}`);
    // leftovers in hand (Banana Peel, husks) would block picking the baby or tool back up
    const left = this.world.self?.held.id ?? 0;
    if ((babyId != null || toolId) && left > 0 && left !== toolId) {
      const leftName = this.heldName();
      const r = await this.drop();
      parts.push(this.world.self?.held.id === 0 ? `dropped the ${leftName}` : `couldn't drop the ${leftName} (${r})`);
    }
    // pick back up what we set down
    if (babyId != null) {
      const r = await this.pickUpBaby(babyId);
      if (this.world.self?.held.id === -babyId) parts.push(`${r} again`);
      else {
        const b = this.world.players.get(babyId);
        parts.push(`COULDN'T PICK THE BABY BACK UP (${r})${b ? `; baby #${babyId} is at (${this.world.posOf(b)[0]},${this.world.posOf(b)[1]})` : ""}`);
      }
    } else if (toolId) {
      const at = toolAt ?? this.findNear(toolId, 2);
      if (this.world.self?.held.id !== 0) parts.push(`${toolName} left at ${at ? `(${at[0]},${at[1]})` : "the spot"} (your hands are full)`);
      else if (!at) parts.push(`${toolName} not found to pick back up`);
      else {
        await this.use(at[0], at[1]);
        parts.push(this.world.self?.held.id === toolId ? `picked ${toolName} back up` : `couldn't pick ${toolName} back up; it's at (${at[0]},${at[1]})`);
      }
    }
    return parts.join("; ");
  }

  /** nearest tile within r of us holding object id */
  private findNear(id: number, r: number): Pos | null {
    const p = this.pos;
    if (!p) return null;
    let best: Pos | null = null;
    let bd = Infinity;
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        if (this.world.objAt(p[0] + dx, p[1] + dy).id !== id) continue;
        const d = Math.abs(dx) + Math.abs(dy);
        if (d < bd) {
          bd = d;
          best = [p[0] + dx, p[1] + dy];
        }
      }
    return best;
  }

  /** Pick up a baby (or anyone small enough). */
  async pickUpBaby(id: number): Promise<string> {
    // the server only accepts BABY with empty hands, and says nothing otherwise
    const held = this.world.self?.held.id ?? 0;
    if (held === -id) return `you're already carrying #${id}`;
    if (held < 0) return `tried to pick up #${id}: your arms are full (carrying ${this.heldName()}); put them down first`;
    const blocked = this.conditionBlock();
    if (blocked) return `tried to pick up #${id}: ${blocked}`;
    if (held > 0) return `tried to pick up #${id}: your hands are full (holding ${this.heldName()}); drop it first`;
    // server.cpp minPickupBabyAge: the BABY message is ignored below age 10
    const me = this.world.self;
    if (me && this.world.currentAge(me) < MIN_PICKUP_BABY_AGE) return `tried to pick up #${id}: you're ${Math.floor(this.world.currentAge(me))}: you can carry a baby from ${MIN_PICKUP_BABY_AGE}`;
    const n = await this.nearPlayer(id);
    if (typeof n === "string") return n;
    const r = await this.act(`BABY ${n.p[0]} ${n.p[1]} ${id}`, n.p[0], n.p[1]);
    for (let i = 0; i < 10 && this.world.self?.held.id !== -id; i++) await sleep(100);
    if (this.world.self?.held.id === -id) return `picked up ${this.heldName()}`;
    if (r.heldBefore !== r.heldAfter) return `picked up ${r.heldAfter}`;
    return `tried to pick up #${id}: nothing happened${this.babyPickupWhy(id)}`;
  }

  /** Why a BABY pickup did nothing, when the world shows it (server.cpp BABY: age under babyAge, not held, next to us). */
  private babyPickupWhy(id: number): string {
    const o = this.world.players.get(id);
    const me = this.world.self;
    if (!o || !me) return "";
    const age = this.world.currentAge(o);
    if (age >= BABY_AGE) return ` (#${id} is ${Math.floor(age)}: only someone under ${BABY_AGE} can be carried)`;
    const c = this.world.carrierOf(o);
    if (c && c.id !== me.id) return ` (#${id} is being carried by #${c.id})`;
    if ((me.held.id ?? 0) > 0) return ` (your hands are full: you're holding ${this.heldName()})`;
    const [ox, oy] = this.world.posOf(o);
    const d = Math.max(Math.abs(ox - me.x), Math.abs(oy - me.y));
    if (d > 1) return ` (#${id} is at (${ox},${oy}), ${d} tiles from you; a baby can be picked up only from your tile or next to it)`;
    return "";
  }

  /** Use held item on another person: feed them food, clothe a baby, heal a wound. */
  async useOnPerson(id: number): Promise<string> {
    // server.cpp UBABY/SELF: holding a baby, the action isn't let through (targetPlayer stays NULL)
    if ((this.world.self?.held.id ?? 0) < 0) return `used held item on #${id}: nothing happened (your arms are full: you're carrying ${this.heldName()}; put the baby down first)`;
    const blocked = this.conditionBlock();
    if (blocked) return `can't feed or help #${id}: ${blocked}`;
    const n = await this.nearPlayer(id);
    if (typeof n === "string") return n;
    const heldId = this.world.self?.held.id ?? 0;
    const r = await this.act(`UBABY ${n.p[0]} ${n.p[1]} -1 ${id}`, n.p[0], n.p[1]);
    if (r.heldBefore !== r.heldAfter) return `gave/used ${r.heldBefore} on #${id}; now holding ${r.heldAfter}`;
    // server.cpp: a baby under 3 (defaultActionAge) refuses food above babyFeedingLevel (2); the client shows the refusal
    const o = this.world.players.get(id);
    if (o && heldId > 0 && this.gd.isFood(heldId) && this.world.currentAge(o) < 3) return `#${id} refused the ${this.gd.name(heldId)}: a baby under 3 only takes food when starving (2 food or less); a woman aged 14-40 nurses a baby by holding it`;
    if (heldId === 0) return `used bare hands on #${id}: nothing happened (you're holding nothing)`;
    // server.cpp UBABY: on another person a held item can heal a wound, feed or clothe; nothing else
    const kind = heldId > 0 && !this.gd.isFood(heldId) && this.gd.objects.get(heldId)?.clothing === "n" ? ` (${withArticle(this.gd.name(heldId))} is not food or clothing, so it can't be fed to or put on #${id})` : "";
    return `used held item on #${id}: nothing happened${kind}`;
  }

  say(text: string): string {
    // printable ASCII only: '#' ends a protocol message, and the game font has nothing else
    const upper = text.toUpperCase().replace(/[^\x20-\x22\x24-\x7E]/g, " ").replace(/\s+/g, " ").trim();
    // the game removes numbers from speech (the echo comes back without them): say what was really said
    const clean = upper.replace(/[0-9]/g, "").replace(/\s+/g, " ").trim();
    const lostNumbers = clean !== upper;
    if (!clean) return lostNumbers ? "said nothing (numbers can't be spoken)" : "said nothing";
    const s = this.world.self;
    const limit = s ? sayLimit(this.world.currentAge(s)) : 10;
    this.send(`SAY 0 0 ${clean}`);
    const nums = lostNumbers ? " (numbers can't be spoken: they were left out)" : "";
    // server.cpp: "ORDER," is an order only from someone with followers (FW, as the observation's "Your followers")
    const followers = s ? [...this.world.leaders.values()].filter((l) => l === s.id).length : 0;
    const order = /^ORDER,/.test(clean) && !followers ? " (you have no followers: it was heard as plain speech, not as an order)" : "";
    return clean.length > limit ? `said "${clean.slice(0, limit)}" (cut off: at your age you can only say ${limit} letters)${nums}${order}` : `said "${clean}"${nums}${order}`;
  }

  /** Baby: jump out of arms / wiggle. */
  jump(): string {
    const me = this.world.self;
    const carrier = me ? this.world.carrierOf(me) : null;
    if (me && !carrier) return "you aren't being held; wriggling does nothing";
    this.send("JUMP 0 0");
    // server.cpp: a baby under 1 can't wriggle out of its own mother's arms (it only wiggles)
    if (me && carrier && this.world.currentAge(me) < 1 && me.ancestors[0] === carrier.id) return "wiggled, but a baby under 1 can't get out of its mother's arms";
    return "wiggled out of their arms";
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

/**
 * Max characters a player of this age can say: a port of the server's
 * getSayLimit (OneLife/commonSource/sayLimit.cpp:3-38; server.cpp ~24626
 * truncates SAY text to it). age+1 under 8, a sigmoid from 9 to 66 between 8
 * and 16, then 66 plus one per two years.
 */
export function sayLimit(age: number): number {
  const floorAge = Math.floor(age);
  const adultBase = 50;
  if (floorAge >= 16) return 16 + Math.trunc((floorAge - 16) / 2) + adultBase;
  if (floorAge > 8) {
    const fullIncrease = adultBase + 16 - 9;
    const fraction = (floorAge - 8) / 8;
    const curved = 1 / (1 + Math.pow(2, -12 * (fraction - 0.5)));
    return 9 + Math.floor(fullIncrease * curved);
  }
  return floorAge + 1;
}
