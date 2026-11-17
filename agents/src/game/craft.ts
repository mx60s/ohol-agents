// `craft <item>`: plan over the transition graph from what is held and what
// is lying around, then run the steps with the ordinary body skills.
//
// TEMPORARY intervention (CRAFT_MACRO=1, README "Interventions"). It is the
// equivalent of a human with the crafting wiki open who also lets the game
// click for them. It only uses objects the character can see, and every step
// is a normal protocol action (pick up, drop, use).
//
// Planning:
// 1. A static cost per object id: 0 if it is in view (or held), else the
//    cheapest transition that makes it, 1 + cost(actor) + cost(target)
//    (Bellman-Ford until it settles).
// 2. Extraction: from the goal, take the cheapest producing transition,
//    obtain its target first (it must lie on the ground), then its actor (it
//    must end up in hand), counting copies so "2 Reed Bundles" needs two.
// 3. Perishables (Leaf, Juniper Tinder: 2 minutes) are gathered as late as
//    possible, right before the step that uses them (gatherPerishablesLate).
// The executor runs only the FIRST transition, then re-plans from the live
// world, so surprises (someone took the stone) are handled by the next plan.

import type { GameData, Transition } from "./gameData.ts";
import type { World } from "./world.ts";

export type Pos = [number, number];

export interface CraftStep {
  t: Transition;
  /** wait for a timed change (actor -1) instead of using something */
  wait: boolean;
}

export interface Inventory {
  held: number;
  /** id -> positions within reach, nearest first */
  ground: Map<number, Pos[]>;
}

export interface CraftPlan {
  goal: number;
  steps: CraftStep[];
}

export type PlanResult = { ok: true; plan: CraftPlan } | { ok: false; reason: string };

const MAX_DECAY_WAIT_S = 60;
const MAX_DEPTH = 14;

export class CraftPlanner {
  /** producing transitions per product id */
  private producers = new Map<number, Transition[]>();

  private all: Transition[] = [];
  /** cost of making each object from things that occur in nature (mapChance > 0): the "usual" recipe */
  private natural: Map<number, number>;

  constructor(private gd: GameData) {
    for (const t of gd.allTransitions()) {
      if (!this.usable(t)) continue;
      this.all.push(t);
      for (const p of products(t)) {
        const a = this.producers.get(p);
        if (a) a.push(t);
        else this.producers.set(p, [t]);
      }
    }
    this.natural = this.costs([...gd.objects.values()].filter((o) => o.mapChance > 0).map((o) => o.id));
  }

  /** Bellman-Ford: cost 0 for `free` ids, else the cheapest 1 + cost(actor) + cost(target). */
  private costs(free: Iterable<number>): Map<number, number> {
    const cost = new Map<number, number>();
    for (const id of free) cost.set(id, 0);
    const c = (id: number) => (id > 0 ? cost.get(id) ?? Infinity : 0);
    for (let iter = 0; iter < 40; iter++) {
      let changed = false;
      for (const t of this.all) {
        const tc = 1 + (t.actor > 0 ? c(t.actor) : 0) + (t.target > 0 ? c(t.target) : 0);
        if (!Number.isFinite(tc)) continue;
        for (const p of products(t))
          if (tc < c(p)) {
            cost.set(p, tc);
            changed = true;
          }
      }
      if (!changed) break;
    }
    return cost;
  }

  /** The usual way to make an object (cheapest from natural materials). */
  private usualRecipe(id: number): Transition | undefined {
    const n = (x: number) => (x > 0 ? this.natural.get(x) ?? Infinity : 0);
    let best: Transition | undefined;
    let bk = Infinity;
    for (const t of this.producers.get(id) ?? []) {
      const k = n(t.actor) + n(t.target) + (t.actor === -1 ? 0.5 : 0);
      if (k < bk) {
        bk = k;
        best = t;
      }
    }
    return best;
  }

  private usable(t: Transition): boolean {
    const gd = this.gd;
    if (t.actor === -1) {
      // timed change of something lying on the ground (Smoldering Tinder -> Burning Tinder)
      if (!(t.target > 0) || !(t.autoDecaySeconds > 0 && t.autoDecaySeconds <= MAX_DECAY_WAIT_S)) return false;
    } else if (t.actor < 0) return false;
    if (t.actor === 0 && t.target <= 0) return false;
    if (t.target === 0 || t.target < -1) return false;
    for (const id of [t.actor, t.target, t.newActor, t.newTarget]) if (id > 0 && (gd.isPlaceholder(id) || gd.isPerson(id))) return false;
    if (t.actor > 0 && gd.isPermanent(t.actor)) return false; // can't hold it
    if (t.newActor === t.actor && t.newTarget === t.target) return false;
    return true;
  }

  /** Resolve a free-text item name to an object id, or explain. */
  resolve(name: string): { id: number } | { error: string } {
    const want = name.trim().replace(/\s+/g, " ").toLowerCase();
    if (!want) return { error: "say which item to craft, e.g. {\"type\":\"craft\",\"item\":\"Sharp Stone\"}" };
    const exact = this.gd.idByName(want);
    if (exact && this.producers.has(exact)) return { id: exact };
    // forgiving match: singular/plural and partial names, among things that can be made
    const cands: { id: number; name: string }[] = [];
    for (const id of this.producers.keys()) {
      const o = this.gd.get(id);
      if (!o || o.parent) continue;
      const n = this.gd.name(id).toLowerCase();
      if (n === want || n === want.replace(/s$/, "") || n.includes(want)) cands.push({ id, name: this.gd.name(id) });
    }
    cands.sort((a, b) => a.name.length - b.name.length);
    if (cands.length && (cands[0].name.toLowerCase() === want || cands[0].name.toLowerCase() === want.replace(/s$/, ""))) return { id: cands[0].id };
    if (cands.length === 1) return { id: cands[0].id };
    if (cands.length) return { error: `"${name}" is ambiguous; did you mean ${[...new Set(cands.slice(0, 6).map((c) => c.name))].join(", ")}?` };
    if (exact) return { error: `${this.gd.name(exact)} can't be made by hand; it's found in the world` };
    return { error: `no item called "${name}" can be crafted` };
  }

  /** true if the object turns into something else on its own within 30 s */
  decaysFast(id: number): boolean {
    if (!(id > 0)) return false;
    return this.gd.transition(-1, id) != null && this.gd.transition(-1, id)!.autoDecaySeconds > 0 && this.gd.transition(-1, id)!.autoDecaySeconds <= 30;
  }

  plan(goal: number, inv: Inventory): PlanResult {
    const gd = this.gd;
    const have = new Map<number, number>();
    for (const [id, ps] of inv.ground) have.set(id, ps.length);
    if (inv.held > 0) have.set(inv.held, (have.get(inv.held) ?? 0) + 1);

    // 1. static costs
    const cost = this.costs(have.keys());
    const c = (id: number) => (id > 0 ? cost.get(id) ?? Infinity : 0);

    // 2. extraction with counted inventory
    let budget = 3000;
    const extract = (id: number, asActor: boolean, avail: Map<number, number>, depth: number, root: boolean): CraftStep[] | null => {
      if (--budget < 0) return null;
      if (!root && (avail.get(id) ?? 0) > 0 && (!asActor || !gd.isPermanent(id))) {
        avail.set(id, avail.get(id)! - 1);
        return [];
      }
      if (asActor && gd.isPermanent(id)) return null;
      if (depth > MAX_DEPTH) return null;
      const options = (this.producers.get(id) ?? [])
        .map((t) => ({ t, k: 1 + (t.actor > 0 ? c(t.actor) : 0) + (t.target > 0 ? c(t.target) : 0) }))
        .filter((o) => Number.isFinite(o.k))
        // the product must end up where it's needed: in hand (newActor) for an actor
        .filter((o) => !asActor || o.t.newActor === id || !gd.isPermanent(id))
        .sort((a, b) => a.k - b.k)
        .slice(0, 3);
      for (const { t } of options) {
        const sub = new Map(avail);
        const steps: CraftStep[] = [];
        // normally lay the target out first, then get the actor into hand; but if the
        // target burns out quickly (Burning Tinder, Ember Shaft), prepare the actor first
        const parts: [number, boolean][] = [[t.target, false], [t.actor, true]];
        if (this.decaysFast(t.target)) parts.reverse();
        let failed = false;
        for (const [id2, asA] of parts) {
          if (!(id2 > 0)) continue;
          const s = extract(id2, asA, sub, depth + 1, false);
          if (!s) {
            failed = true;
            break;
          }
          steps.push(...s);
        }
        if (failed) continue;
        steps.push({ t, wait: t.actor === -1 });
        // what the step leaves behind becomes available (a kept tool, the rock, by-products)
        for (const p of [t.newActor, t.newTarget]) if (p > 0 && p !== id) sub.set(p, (sub.get(p) ?? 0) + 1);
        avail.clear();
        for (const [k, v] of sub) avail.set(k, v);
        return steps;
      }
      return null;
    };

    const steps = extract(goal, false, new Map(have), 0, true);
    if (!steps) return { ok: false, reason: this.explainMissing(goal, cost, have) };
    return { ok: true, plan: { goal, steps: this.gatherPerishablesLate(steps, have) } };
  }

  /** Game seconds until `id` turns into something else on its own (0 = it doesn't, or only after hours). */
  decaySeconds(id: number): number {
    const t = id > 0 ? this.gd.transition(-1, id) : null;
    return t && t.autoDecaySeconds > 0 ? t.autoDecaySeconds : 0;
  }

  /**
   * Extraction builds each ingredient's whole subtree before the next one, so
   * something gathered early (Leaf, Juniper Tinder: 120 s, held or not) can
   * rot before the step that uses it. Move each step that makes a perishable
   * ingredient as late as it can go: just before the step that consumes it,
   * when the estimated time in between is not well inside its decay time. It
   * never moves past a step that makes a fast-decaying thing (that order is
   * deliberate, see decaysFast) and every reordering is checked by replaying
   * the plan against what is in view.
   */
  private gatherPerishablesLate(steps: CraftStep[], have: Map<number, number>): CraftStep[] {
    const out = [...steps];
    for (let i = out.length - 2; i >= 0; i--) {
      const s = out[i];
      const made = products(s.t).filter((p) => this.decaySeconds(p) > 0);
      if (!made.length) continue;
      const j = out.findIndex((u, k) => k > i && made.some((p) => u.t.actor === p || u.t.target === p));
      if (j < 0) continue;
      const d = Math.min(...made.filter((p) => out[j].t.actor === p || out[j].t.target === p).map((p) => this.decaySeconds(p)));
      if (estimateGameSeconds(j - i - 1) * PERISHABLE_SAFETY < d) continue;
      // latest slot before j that doesn't jump over a fast-decay step
      let at = j;
      while (at - 1 > i && products(out[at - 1].t).some((p) => this.decaysFast(p))) at--;
      for (; at - 1 > i; at--) {
        const moved = [...out.slice(0, i), ...out.slice(i + 1, at), s, ...out.slice(at)];
        if (replays(moved, have)) {
          out.splice(0, out.length, ...moved);
          break;
        }
      }
    }
    return out;
  }

  /** "missing: Long Straight Shaft (none in view)" style explanation. */
  private explainMissing(goal: number, cost: Map<number, number>, have: Map<number, number> = new Map()): string {
    const gd = this.gd;
    // walk the usual recipe (from natural materials); name the raw materials not in view
    const missing = new Set<string>();
    const seen = new Set<number>();
    const visit = (id: number, depth: number) => {
      if (id <= 0 || seen.has(id) || depth > 8) return;
      seen.add(id);
      if (cost.get(id) === 0) return;
      const best = this.natural.get(id) === 0 ? undefined : this.usualRecipe(id);
      if (!best) {
        // "Maple Tree#Branch" and a bare "Maple Tree" share a name; say which one is needed
        const tag = (gd.get(id)?.name ?? "").match(/#\s*([A-Za-z]+)\s*$/)?.[1];
        missing.add(tag && !/\(with /.test(gd.name(id)) ? `${gd.name(id)} (${tag.toLowerCase()})` : gd.name(id));
        return;
      }
      visit(best.target, depth + 1);
      visit(best.actor, depth + 1);
    };
    visit(goal, 0);
    // everything is in view, but not enough of it: walk the usual recipe again counting what each step uses up
    // (Rope = 2 Thread = 4 Milkweed Stalks; one stalk in view is not enough)
    if (!missing.size) {
      const avail = new Map(have);
      const short = new Set<string>();
      let budget = 400;
      const need = (id: number, depth: number, consumed: boolean) => {
        if (id <= 0 || --budget < 0 || depth > 8) return;
        const n = avail.get(id) ?? 0;
        if (n > 0) {
          if (consumed) avail.set(id, n - 1);
          return;
        }
        const best = this.natural.get(id) === 0 ? undefined : this.usualRecipe(id);
        if (!best) {
          short.add(gd.name(id));
          return;
        }
        need(best.target, depth + 1, best.newTarget !== best.target);
        need(best.actor, depth + 1, best.newActor !== best.actor);
      };
      need(goal, 0, true);
      for (const n of short) missing.add(`more ${n}`);
    }
    const recipe = this.recipeText(goal);
    const m = [...missing].slice(0, 4);
    return `can't make ${gd.name(goal)} from what you can see${m.length ? `; missing${m.some((x) => !x.startsWith("more ")) ? " (none in view)" : ""}: ${m.join(", ")}` : ""}${recipe ? `. Recipe: ${recipe}` : ""}`;
  }

  /** One-line recipe for an item: "Stone on Big Hard Rock". */
  recipeText(goal: number): string {
    const gd = this.gd;
    const t = this.usualRecipe(goal);
    if (!t) return "";
    if (t.actor === -1) return `${gd.name(t.target)} turns into it after a while`;
    if (t.target === -1) return `use ${gd.name(t.actor)} on empty ground`;
    return t.actor === 0 ? `bare hands on ${gd.name(t.target)}` : `${gd.name(t.actor)} on ${gd.name(t.target)}`;
  }

  describeStep(s: CraftStep): string {
    const gd = this.gd;
    const { t } = s;
    if (s.wait) return `wait for ${gd.name(t.target)} to become ${gd.name(t.newTarget)}`;
    const out = [t.newActor, t.newTarget].filter((p) => p > 0 && p !== t.actor && p !== t.target).map((p) => gd.name(p));
    const what = t.target === -1 ? `${gd.name(t.actor)} on the ground` : t.actor === 0 ? `bare hands on ${gd.name(t.target)}` : `${gd.name(t.actor)} on ${gd.name(t.target)}`;
    return `${what}${out.length ? ` -> ${out.join(" + ")}` : ""}`;
  }
}

/** game seconds one planned transition takes: ~2 protocol actions plus walking (techtree-audit: ~0.8 s walking per action) */
const STEP_GAME_S = 4;
/** game seconds lost between two macro calls (one decision, at TIME_SCALE 1 the worst case) */
const CALL_GAP_GAME_S = 10;
/** gather a perishable late unless the estimated wait is under 1/PERISHABLE_SAFETY of its decay time */
const PERISHABLE_SAFETY = 2;

/** Estimated game seconds for `n` planned transitions, including the decisions between macro calls of 12 steps. */
export function estimateGameSeconds(n: number): number {
  return n * STEP_GAME_S + Math.floor(n / 12) * CALL_GAP_GAME_S;
}

/** Can the steps run in this order from what is in view (each actor and target present when needed)? */
function replays(steps: CraftStep[], have: Map<number, number>): boolean {
  const n = new Map(have);
  for (const { t } of steps) {
    for (const id of [t.actor, t.target]) {
      if (!(id > 0)) continue;
      const k = n.get(id) ?? 0;
      if (k <= 0) return false;
      n.set(id, k - 1);
    }
    for (const p of [t.newActor, t.newTarget]) if (p > 0) n.set(p, (n.get(p) ?? 0) + 1);
  }
  return true;
}

function products(t: Transition): number[] {
  const out: number[] = [];
  if (t.newActor > 0 && t.newActor !== t.actor) out.push(t.newActor);
  if (t.newTarget > 0 && t.newTarget !== t.target) out.push(t.newTarget);
  return out;
}

/** Everything the character can see within `radius` tiles, nearest first. */
export function inventoryOf(w: World, radius = 20): Inventory {
  const me = w.self;
  const ground = new Map<number, Pos[]>();
  if (!me) return { held: 0, ground };
  const [mx, my] = w.posOf(me);
  const cells: { id: number; p: Pos; d: number }[] = [];
  for (let dy = -radius; dy <= radius; dy++)
    for (let dx = -radius; dx <= radius; dx++) {
      const id = w.objAt(mx + dx, my + dy).id;
      if (id > 0) cells.push({ id, p: [mx + dx, my + dy], d: Math.max(Math.abs(dx), Math.abs(dy)) });
    }
  cells.sort((a, b) => a.d - b.d);
  for (const c of cells) {
    const a = ground.get(c.id);
    if (a) a.push(c.p);
    else ground.set(c.id, [c.p]);
  }
  return { held: me.held.id > 0 ? me.held.id : 0, ground };
}

// ---------------------------------------------------------------- executor

/** The body skills the executor needs (Body implements these). */
export interface CraftBody {
  use(x: number, y: number): Promise<string>;
  drop(x?: number, y?: number): Promise<string>;
  /** non-null = stop now, with the reason (urgent event, starving, ...) */
  interruptReason(): string | null;
}

export interface CraftOptions {
  /** max transitions to perform in one call */
  maxSteps?: number;
  /** max real ms for one call */
  maxMs?: number;
  /** real ms to wait for a timed change of `gameSeconds` */
  waitMs?: (gameSeconds: number) => number;
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Real ms one craft call may take: 8 decision cycles (at least 30 s) of GAME
 * time. Walking and timed changes run timeScale x slower in wall time
 * (TIME_SCALE), so an unscaled budget runs out on walking alone at k > 1.
 */
export function craftBudgetMs(cycleMs: number, timeScale: number): number {
  return Math.max(30_000, 8 * cycleMs) * timeScale;
}

/**
 * Make `goal` from what is around, one transition at a time, re-planning
 * after each. Returns a plain-text report for the model.
 */
export async function runCraft(body: CraftBody, w: World, gd: GameData, planner: CraftPlanner, goal: number, opts: CraftOptions = {}): Promise<string> {
  const maxSteps = opts.maxSteps ?? 12;
  const maxMs = opts.maxMs ?? 90_000;
  const sleep = opts.sleep ?? realSleep;
  const waitMs = opts.waitMs ?? ((s: number) => s * 1000);
  const name = gd.name(goal);
  const me = w.self;
  if (!me) return "no body";
  if (w.currentAge(me) < 3) return "you're too young to craft";
  if (me.held.id < 0) return `can't craft ${name} while carrying a baby: crafting needs your hands. Put the baby down first (drop), or craft later.`;
  // the world's clock: with the turn clock it only runs in act windows
  const t0 = w.now();
  const startPos = w.posOf(me);
  const startHeld = me.held.id;
  // where crafting took us, and where what we were holding ended up
  const aftermath = () => {
    const notes: string[] = [];
    const self = w.self;
    if (!self) return "";
    const p = w.posOf(self);
    const d = Math.max(Math.abs(p[0] - startPos[0]), Math.abs(p[1] - startPos[1]));
    if (d > 3) notes.push(`you are now at (${p[0]}, ${p[1]}), ${d} tiles from where you started`);
    if (startHeld > 0 && self.held.id !== startHeld) {
      const at = nearest(w, startHeld);
      notes.push(at ? `your ${gd.name(startHeld)} is at (${at[0]}, ${at[1]})` : `your ${gd.name(startHeld)} was used up`);
    }
    return notes.length ? `. Note: ${notes.join("; ")}` : "";
  };
  const done: string[] = [];
  let failures = 0;
  let stopped = "";
  for (let i = 0; i < maxSteps * 2 && done.length < maxSteps; i++) {
    const why = body.interruptReason();
    if (why) {
      stopped = `interrupted: ${why}`;
      break;
    }
    if (w.now() - t0 > maxMs) {
      stopped = "out of time for this turn";
      break;
    }
    if (w.dead || !w.self) return "you died";
    const r = planner.plan(goal, inventoryOf(w));
    if (!r.ok) {
      stopped = r.reason;
      break;
    }
    const step = r.plan.steps[0];
    const res = await doStep(body, w, gd, step, sleep, waitMs);
    if (res.ok) {
      failures = 0;
      done.push(planner.describeStep(step));
      // finished when this step produced the goal (in hand or on the ground)
      const made = [step.t.newActor, step.t.newTarget].some((p) => p > 0 && gd.base(p) === goal);
      const heldNow = w.self?.held.id ?? 0;
      const onTile = res.pos ? gd.base(w.objAt(res.pos[0], res.pos[1]).id) === goal : false;
      if (made && (gd.base(heldNow) === goal || onTile)) {
        const where = gd.base(heldNow) === goal ? "it's in your hands" : `it's at (${res.pos![0]}, ${res.pos![1]})`;
        return `crafted ${name} in ${done.length} step${done.length === 1 ? "" : "s"} (${done.join("; ")}); ${where}${aftermath()}`;
      }
    } else {
      failures++;
      if (failures >= 2) {
        stopped = `step failed: ${planner.describeStep(step)}: ${res.why}`;
        break;
      }
    }
  }
  if (!stopped) stopped = `reached the limit of ${maxSteps} steps for one action`;
  const left = planner.plan(goal, inventoryOf(w));
  const next = left.ok ? ` ${left.plan.steps.length} step${left.plan.steps.length === 1 ? "" : "s"} left; next: ${planner.describeStep(left.plan.steps[0])}. Use craft again to continue.` : "";
  const did = done.length ? `did ${done.length}: ${done.slice(-6).join("; ")}${done.length > 6 ? " (and earlier steps)" : ""}. ` : "made no progress. ";
  return `craft ${name}: ${did}Stopped (${stopped}).${next}${aftermath()}`;
}

type StepResult = { ok: true; pos: Pos | null } | { ok: false; why: string };

function nearest(w: World, id: number): Pos | null {
  return inventoryOf(w).ground.get(id)?.[0] ?? null;
}

async function doStep(body: CraftBody, w: World, gd: GameData, step: CraftStep, sleep: (ms: number) => Promise<void>, waitMs: (s: number) => number): Promise<StepResult> {
  const { t } = step;
  const held = () => w.self?.held.id ?? 0;
  if (step.wait) {
    const p = nearest(w, t.target);
    if (!p) return { ok: false, why: `${gd.name(t.target)} is gone` };
    const until = w.now() + waitMs(t.autoDecaySeconds) + 1500;
    while (w.now() < until && w.objAt(p[0], p[1]).id === t.target) {
      if (body.interruptReason()) return { ok: false, why: "interrupted while waiting" };
      await sleep(250);
    }
    return w.objAt(p[0], p[1]).id !== t.target ? { ok: true, pos: p } : { ok: false, why: `${gd.name(t.target)} didn't change in time` };
  }
  // 1. the target must lie on the ground
  if (t.target > 0 && !nearest(w, t.target)) {
    if (held() !== t.target) return { ok: false, why: `no ${gd.name(t.target)} in view` };
    const r = await body.drop();
    if (held() === t.target) return { ok: false, why: `couldn't put down ${gd.name(t.target)}: ${r}` };
  }
  // 2. the actor must be in hand (bare hands for actor 0)
  if (held() !== t.actor) {
    if (held() !== 0) {
      const r = await body.drop();
      if (held() !== 0) return { ok: false, why: `couldn't free your hands: ${r}` };
    }
    if (t.actor > 0) {
      const p = nearest(w, t.actor);
      if (!p) return { ok: false, why: `no ${gd.name(t.actor)} in view` };
      const r = await body.use(p[0], p[1]);
      if (held() !== t.actor) return { ok: false, why: `couldn't pick up ${gd.name(t.actor)}: ${r}` };
    }
  }
  // 3. use it on the target (or on empty ground next to us)
  let p: Pos | null;
  if (t.target === -1) {
    const [x, y] = w.posOf(w.self!);
    p = ([[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]] as Pos[]).find(([a, b]) => w.objAt(a, b).id === 0 && w.walkable(a, b)) ?? null;
    if (!p) return { ok: false, why: "no empty ground next to you" };
  } else {
    p = nearest(w, t.target);
    if (!p) return { ok: false, why: `${gd.name(t.target)} disappeared` };
  }
  const before = w.objAt(p[0], p[1]).id;
  const heldBefore = held();
  const r = await body.use(p[0], p[1]);
  if (w.objAt(p[0], p[1]).id === before && held() === heldBefore) return { ok: false, why: r };
  return { ok: true, pos: p };
}
