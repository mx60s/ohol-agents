// Inventions: the first time each technology item is made in a world (run), for the stream's
// "Recent inventions" panel (GET /api/inventions). One persisted log per process, spanning runs and
// restarts: LOG_DIR/inventions.jsonl, one line per invention, appended once and never rewritten.
//
// What a "first" is: an item that APPEARED in an action's result (it wasn't on the tile or in hand
// before: a pickup or taking something out of a container is not a first), or that the craft macro
// made (its goal and every step's products). Each such item is resolved to a game object by name
// and kept only if it is technology (InventionRule below). One entry per (run, object id).
//
// InventionRule: technology vs. trivia, decided from game data alone (OneLifeData7 objects and
// transitions, gameData.ts). An object counts when ALL of these hold:
//   1. a real object: not a person or baby, not a "@" placeholder (use states such as
//      "Sharp Stone (2/3 left)" count as their base object);
//   2. not food (food > 0: berries, carrots, cooked dishes);
//   3. not the land: placed by map generation (mapChance > 0), or what such an object becomes in
//      place over time, by bare hands, or worked by a tool that stays in hand (Flowering
//      Milkweed, Milkweed Debris, Clay Pit, Harvested Tule, Tule Stumps, Dug Burdock);
//   4. not gathered: no transition picks it off untouched land by bare hands (Leaf, Straight
//      Branch, Milkweed Stalk, Clay, Juniper Tinder). Gathered once means raw, whatever else
//      also makes it;
//   5. not an intermediate "X with Y" state (one thing sitting on another: "Tule Stumps with
//      Basket");
//   6. made: some non-decay transition produces it from something else, either from things that
//      are not untouched land (Rope on Reed Bundle -> Reed Skirt; bare hands taking things apart
//      only count for what ends up in hand), or in hand by a tool used on the land (Round Stone
//      on Big Hard Rock -> Sharp Stone).

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { GameData, Transition } from "./game/gameData.ts";
import type { Invention, RunEvent } from "./api-types.ts";
import { cleanPhrase } from "./safety.ts";

export class InventionRule {
  /** wild objects and what they turn into in place (rule 3) */
  private land = new Set<number>();
  /** picked off the land by hand (rule 4) */
  private gathered = new Set<number>();
  /** made by some transition (rule 6) */
  private crafted = new Set<number>();
  private byName = new Map<string, number>();
  private cache = new Map<number, boolean>();

  constructor(private gd: GameData) {
    const all = gd.allTransitions().filter((t) => t.actor !== -2);
    const base = (id: number) => (id > 0 ? gd.base(id) : id);
    const close = (seed: Set<number>, step: (t: Transition) => boolean, skip: Set<number> = new Set()) => {
      for (let grew = true; grew; ) {
        grew = false;
        for (const t of all) {
          if (t.target <= 0 || t.newTarget <= 0 || !seed.has(base(t.target)) || !step(t)) continue;
          const nt = base(t.newTarget);
          if (!seed.has(nt) && !skip.has(nt)) {
            seed.add(nt);
            grew = true;
          }
        }
      }
      return seed;
    };
    const wild = new Set<number>();
    for (const o of gd.objects.values()) if (o.mapChance > 0 && !o.parent) wild.add(o.id);
    // untouched land: wild objects and what they become over time or by bare hands
    const land0 = close(new Set(wild), (t) => t.actor === -1 || t.actor === 0);
    // made from made things: products of a transition on something that isn't untouched land
    // (bare hands only take apart: their tile result is a remainder, not a product)
    for (const t of all) {
      if (t.actor === -1 || (t.target > 0 && land0.has(base(t.target)))) continue;
      const [a, g, na, ng] = [base(t.actor), base(t.target), base(t.newActor), base(t.newTarget)];
      if (na > 0 && na !== a && na !== g) this.crafted.add(na);
      if (t.actor !== 0 && ng > 0 && ng !== a && ng !== g) this.crafted.add(ng);
    }
    // the land: also what a tool that stays in hand turns it into (Harvested Tule, Flint Chips's
    // source, a cut sapling), unless that is made from made things too
    const kept = (t: Transition) => t.actor === -1 || t.actor === 0 || (t.actor > 0 && base(t.newActor) === base(t.actor));
    for (const id of close(new Set(wild), kept, this.crafted)) this.land.add(id);
    for (const t of all) {
      if (t.target <= 0 || t.actor === -1) continue;
      const g = base(t.target);
      const na = base(t.newActor);
      if (na <= 0 || na === g || na === base(t.actor)) continue;
      // picked off untouched land by hand; or made in hand by a tool used on the land (Sharp Stone)
      if (t.actor === 0 && land0.has(g)) this.gathered.add(na);
      else if (t.actor > 0 && this.land.has(g)) this.crafted.add(na);
    }
    // display name -> base object (the names actions report, gd.name)
    for (const o of gd.objects.values()) {
      if (o.parent || o.person || gd.isPlaceholder(o.id)) continue;
      const k = gd.name(o.id).toLowerCase();
      const prev = this.byName.get(k);
      // prefer the plain object over "#variant" copies
      if (prev == null || (!o.name.includes("#") && (gd.get(prev)?.name ?? "").includes("#"))) this.byName.set(k, o.id);
    }
  }

  /** The base object an action's item name refers to ("Sharp Stone (2/3 left)" -> Sharp Stone). */
  idOf(name: string): number | null {
    const n = name.replace(/ containing .*$/, "").replace(/ \(\d+\/\d+ left\)$/, "").trim().toLowerCase();
    return this.byName.get(n) ?? null;
  }

  /** Is this object technology (see the rule at the top of this file)? */
  isInvention(id: number): boolean {
    const hit = this.cache.get(id);
    if (hit !== undefined) return hit;
    const gd = this.gd;
    const o = gd.get(id);
    const ok =
      !!o &&
      !o.parent &&
      !o.person &&
      !gd.isPlaceholder(id) &&
      !(o.food > 0) &&
      !this.land.has(id) &&
      !this.gathered.has(id) &&
      !/\bwith\b/i.test(gd.name(id)) &&
      this.crafted.has(id);
    this.cache.set(id, ok);
    return ok;
  }
}

// ------------------------------------------------------------------ parsing events

/** Names in a stack description: "Basket containing 3 Gooseberry, Rope" -> Basket, Gooseberry, Rope. */
function stackNames(s: string): string[] {
  const m = / containing (.*)$/.exec(s);
  const head = m ? s.slice(0, m.index) : s;
  const inside = m ? m[1].split(", ").map((x) => x.replace(/^\d+ /, "").replace(/ \(with \d+ inside\)$/, "")) : [];
  return [head, ...inside].map((x) => x.trim()).filter(Boolean);
}

/**
 * Item names an action event made: afters that weren't befores in its "tile (x,y) A -> B;
 * holding C -> D" summary, counting what was inside containers as "before" (taking a stone out of
 * a basket isn't making one), plus the craft macro's goal and step products.
 */
export function madeNames(text: string): string[] {
  const out = new Set<string>();
  if (text.startsWith("craft ")) {
    const r = text.slice(text.indexOf(" -> ") + 4);
    const done = /^crafted (.+?) in \d+ steps? \((.*)\);/.exec(r);
    const partial = /^craft [^:]{1,60}: did \d+: (.*?)(?: \(and earlier steps\))?\. Stopped \(/.exec(r);
    if (done) out.add(done[1]);
    const steps = done ? done[2] : partial ? partial[1] : "";
    for (const s of steps.split("; ")) {
      const i = s.lastIndexOf(" -> ");
      if (i < 0 || s.startsWith("wait for ")) continue;
      for (const p of s.slice(i + 4).split(" + ")) out.add(p.trim());
    }
    return [...out].filter(Boolean);
  }
  const body = text.split(/ -> (?=use: |swap: |take_out: |take out: |drop: |use on self: )/)[1] ?? text;
  const before = new Set<string>();
  const after = new Set<string>();
  for (const m of body.matchAll(/(?:tile \([-\d]+,\s*[-\d]+\)|holding) (.+?) -> (.+?)(?=; |$)/g)) {
    for (const n of stackNames(m[1])) before.add(n.toLowerCase());
    after.add(stackNames(m[2])[0] ?? "");
  }
  return [...after].filter((x) => x && x !== "nothing" && !x.startsWith("baby") && !before.has(x.toLowerCase()));
}

// ------------------------------------------------------------------ the log

export interface InventionDeps {
  runId: () => string | null;
  /** the life an agent's character is living (LifeStore.agentFields) */
  lifeOf?: (runId: string, agentId: string, playerId: number | null) => string | null;
}

const MAX_LIST = 200;

export class InventionLog {
  private entries: Invention[] = [];
  private seen = new Set<string>();
  readonly file: string;
  private ruleCache: InventionRule | null = null;

  constructor(private gd: GameData, private deps: InventionDeps, opts: { logDir: string }) {
    this.file = path.join(opts.logDir, "inventions.jsonl");
    this.load();
  }

  /** built on first use (a few tens of ms over the whole transition graph) */
  private get rule(): InventionRule {
    return (this.ruleCache ??= new InventionRule(this.gd));
  }

  private key(runId: string, objectId: number) {
    return `${runId}|${objectId}`;
  }

  private load() {
    if (!existsSync(this.file)) return;
    const text = readFileSync(this.file, "utf8");
    // a torn last line (crash mid-append): end it, so the next append starts a line of its own
    if (text && !text.endsWith("\n")) appendFileSync(this.file, "\n");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as Invention;
        if (typeof r?.item !== "string" || typeof r.runId !== "string" || typeof r.t !== "number") continue;
        const k = this.key(r.runId, typeof r.objectId === "number" ? r.objectId : -1);
        if (this.seen.has(k)) continue;
        this.seen.add(k);
        this.entries.push(r);
      } catch {
        // torn last line after a crash: skip
      }
    }
    this.entries.sort((a, b) => a.t - b.t);
  }

  /** Feed every RunEvent here. Returns the new inventions it made (usually none). */
  observe(e: RunEvent): Invention[] {
    const runId = this.deps.runId();
    if (!runId || !e.agentId) return [];
    const ids = new Set<number>();
    const add = (name: string) => {
      const id = this.rule.idOf(name);
      if (id != null) ids.add(id);
    };
    if (e.kind === "action") madeNames(e.text).forEach(add);
    else if (e.kind === "craft")
      // data: { newActor, newTarget } as object ids or names
      for (const v of [e.data?.newActor, e.data?.newTarget]) {
        if (typeof v === "number" && v > 0) ids.add(this.gd.base(v));
        else if (typeof v === "string" && v) add(v);
      }
    const out: Invention[] = [];
    for (const id of ids) {
      if (!this.rule.isInvention(id)) continue;
      const k = this.key(runId, id);
      if (this.seen.has(k)) continue;
      this.seen.add(k);
      const lifeId = this.deps.lifeOf?.(runId, e.agentId, e.playerId) ?? null;
      const inv: Invention = { item: this.gd.name(id), objectId: id, lifeId, name: cleanPhrase(e.name ?? "", 40) || null, t: e.t, runId };
      this.entries.push(inv);
      out.push(inv);
      try {
        mkdirSync(path.dirname(this.file), { recursive: true });
        appendFileSync(this.file, JSON.stringify(inv) + "\n");
      } catch (err) {
        console.error("inventions: append failed", err);
      }
    }
    return out;
  }

  /** Newest first; runId: that run's (default: the current run's), "all": every run's. */
  list(limit = 20, runId: string | null = this.deps.runId()): Invention[] {
    const n = Math.max(1, Math.min(MAX_LIST, Math.floor(limit) || 20));
    const pick = runId === "all" ? this.entries : this.entries.filter((x) => x.runId === runId);
    return pick.slice(-n).reverse();
  }
}
