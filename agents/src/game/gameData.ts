// Object + transition tables dumped from the server binary
// (server/tools/mtsDumpGameData.h -> data/game-data.json.gz).

import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { ObjStack } from "../protocol/types.ts";

export interface GameObject {
  id: number;
  name: string; // raw description, may contain "#comments" and "+tags"
  parent: number;
  useIndex: number;
  numUses: number;
  food: number;
  heat: number;
  rValue: number;
  permanent: number;
  containable: number;
  containSize: number;
  numSlots: number;
  slotSize: number;
  clothing: string; // 'n' none, h t s b p (hat tunic shoe bottom pack)
  blocksWalking: number;
  deadlyDistance: number;
  useDistance: number;
  minPickupAge: number;
  person: number;
  floor: number;
  mapChance: number;
  speedMult: number;
  writable: number;
  written: number;
  deathMarker: number;
  biomes: number[];
}

export interface Transition {
  actor: number; // 0 = bare hand, -1 = time (decay)
  target: number; // -1 = bare ground / nothing
  newActor: number;
  newTarget: number;
  autoDecaySeconds: number;
  lastUseActor: boolean;
  lastUseTarget: boolean;
  move: number;
}

const DEFAULT_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../data/game-data.json.gz");

export class GameData {
  readonly objects = new Map<number, GameObject>();
  private byPair = new Map<string, Transition[]>();
  private byActor = new Map<number, Transition[]>();
  private byTarget = new Map<number, Transition[]>();
  private nameCache = new Map<number, string>();

  constructor(file = process.env.GAME_DATA_PATH ?? DEFAULT_PATH) {
    const json = JSON.parse(gunzipSync(readFileSync(file)).toString("utf8"));
    for (const o of json.objects as GameObject[]) this.objects.set(o.id, o);
    for (const r of json.transitions as number[][]) {
      const t: Transition = {
        actor: r[0], target: r[1], newActor: r[2], newTarget: r[3],
        autoDecaySeconds: r[4], lastUseActor: !!r[5], lastUseTarget: !!r[6], move: r[7],
      };
      push(this.byPair, `${t.actor},${t.target}`, t);
      push(this.byActor, t.actor, t);
      push(this.byTarget, t.target, t);
    }
  }

  get(id: number): GameObject | undefined {
    return this.objects.get(id);
  }

  /** Human-readable name: strips "#notes", "$" tags, and use-dummy noise. */
  name(id: number): string {
    if (id === 0) return "nothing";
    if (id < 0) return `person #${-id}`;
    const cached = this.nameCache.get(id);
    if (cached) return cached;
    const o = this.objects.get(id);
    let n = o ? cleanName(o.name) + this.clashSuffix(id) : `object ${id}`;
    if (o && o.parent && o.useIndex >= 0 && o.numUses <= 1) {
      // use dummy: name comes from parent; show uses left
      const p = this.objects.get(o.parent);
      if (p) {
        n = cleanName(p.name) + this.clashSuffix(p.id);
        if (p.numUses > 1) n += ` (${o.useIndex + 1}/${p.numUses} left)`;
      }
    }
    this.nameCache.set(id, n);
    return n;
  }

  /**
   * Some food shares its name with a non-food object: the Wild Carrot plant
   * (dig it with a Sharp Stone) vs the Wild Carrot you eat, a Cooked Goose
   * still on its skewer vs the edible one. The client shows different
   * sprites; we add a suffix to the non-food one: " (plant)" if it is fixed
   * in place, " (not edible yet)" otherwise. The edible one keeps its name.
   */
  private clashSuffix(id: number): string {
    if (!this.clashCache) {
      const groups = new Map<string, GameObject[]>();
      for (const o of this.objects.values()) {
        if (o.person || (o.parent && o.useIndex >= 0) || this.isPlaceholder(o.id)) continue;
        const k = cleanName(o.name).toLowerCase();
        groups.set(k, [...(groups.get(k) ?? []), o]);
      }
      this.clashCache = new Map();
      for (const g of groups.values()) {
        if (g.length < 2 || !g.some((o) => o.food > 0)) continue;
        for (const o of g) if (!(o.food > 0)) this.clashCache.set(o.id, o.permanent ? " (plant)" : " (not edible yet)");
      }
    }
    return this.clashCache.get(id) ?? "";
  }
  private clashCache: Map<number, string> | null = null;

  /** "Basket containing 3 Gooseberry, Wild Carrot" */
  describeStack(s: ObjStack): string {
    if (s.id === 0) return "nothing";
    let out = this.name(s.id);
    if (s.contained.length) {
      const counts = new Map<string, number>();
      for (const c of s.contained) {
        let n = this.name(c.id);
        if (c.sub.length) n += ` (with ${c.sub.length} inside)`;
        counts.set(n, (counts.get(n) ?? 0) + 1);
      }
      out += " containing " + [...counts].map(([n, k]) => (k > 1 ? `${k} ${n}` : n)).join(", ");
    }
    return out;
  }

  /** Base object id (use/variable dummies map to their parent). */
  base(id: number): number {
    const o = this.objects.get(id);
    return o && o.parent ? o.parent : id;
  }

  isFood(id: number): boolean {
    return (this.objects.get(id)?.food ?? 0) > 0;
  }

  blocksWalking(id: number): boolean {
    return id > 0 && !!this.objects.get(id)?.blocksWalking;
  }

  isPermanent(id: number): boolean {
    return id > 0 && !!this.objects.get(id)?.permanent;
  }

  isPerson(id: number): boolean {
    return !!this.objects.get(id)?.person;
  }

  /** Person display objects are named "Female001 D" / "Male002 D". */
  isFemaleDisplay(displayId: number): boolean | null {
    const o = this.objects.get(displayId);
    if (!o || !o.person) return null;
    return /^female/i.test(o.name) ? true : /^male/i.test(o.name) ? false : null;
  }

  /**
   * The transition that applies to this pair. Multi-use objects have
   * "last use" variants (the last banana off a plant leaves an Empty Banana
   * Plant; a tool's last use breaks it): pick the one matching whether actor
   * and target are on their last use, as the server does.
   */
  transition(actor: number, target: number): Transition | undefined {
    const ts = this.byPair.get(`${actor},${target}`);
    if (!ts || ts.length < 2) return ts?.[0];
    const aLast = this.onLastUse(actor), tLast = this.onLastUse(target);
    return ts.find((t) => t.lastUseActor === aLast && t.lastUseTarget === tLast) ?? ts.find((t) => !t.lastUseActor && !t.lastUseTarget) ?? ts[0];
  }

  /** a multi-use object with one use left (a use dummy at index 0, or a 1-use parent of several) */
  private onLastUse(id: number): boolean {
    const o = id > 0 ? this.objects.get(id) : undefined;
    if (!o) return false;
    if (o.parent && o.useIndex >= 0) return o.useIndex === 0;
    return false;
  }

  usesAsActor(actor: number): Transition[] {
    return this.byActor.get(actor) ?? [];
  }

  usesAsTarget(target: number): Transition[] {
    return this.byTarget.get(target) ?? [];
  }

  /** Every transition (actor >= -2), in load order. */
  allTransitions(): Transition[] {
    if (!this.allCache) this.allCache = [...this.byActor.values()].flat();
    return this.allCache;
  }
  private allCache: Transition[] | null = null;

  /** Category / pattern placeholders ("@ Kindling Source") never exist in the world. */
  isPlaceholder(id: number): boolean {
    return id > 0 && (this.objects.get(id)?.name ?? "").trimStart().startsWith("@");
  }

  /** The Home Marker object (homeMarker=1 in the object file; only id 487 in OneLifeData7). */
  isHomeMarker(id: number): boolean {
    return id > 0 && /^home marker$/i.test(cleanName(this.objects.get(this.base(id))?.name ?? ""));
  }

  /** Radiant heat of an object (fire 8, hot coals 3, ...); 0 if none. */
  heatOf(id: number): number {
    return id > 0 ? this.objects.get(id)?.heat ?? 0 : 0;
  }

  /** Things an empty Clay Bowl can be filled with water from (ponds, springs, wells). */
  isWaterSource(id: number): boolean {
    if (!this.waterCache) {
      this.waterCache = new Set();
      const bowl = this.idByName("Clay Bowl");
      const water = this.idByName("Bowl of Water");
      if (bowl && water)
        for (const t of this.usesAsActor(bowl)) if (t.newActor === water && t.target > 0 && !this.isPlaceholder(t.target)) this.waterCache.add(this.base(t.target));
    }
    return id > 0 && this.waterCache.has(this.base(id));
  }
  private waterCache: Set<number> | null = null;

  /**
   * Things that sit in a player's hands but are a body condition, not an
   * item: wounds an animal or weapon gives (the newTarget of an
   * attacker -> person transition, e.g. Wild Boar -> Hog Cut), sicknesses
   * ("sick" in the object's description, as server.cpp checks), and marks
   * like tattoos. The client draws these on the body; they can't be dropped.
   */
  condition(id: number): { kind: "wound" | "sickness" | "mark"; from: string[] } | null {
    if (!(id > 0)) return null;
    if (!this.conditionCache) {
      const m = new Map<number, { kind: "wound" | "sickness" | "mark"; from: string[] }>();
      const kindOf = (o: GameObject) => (/#.*\bsick\b/i.test(o.name) ? "sickness" : /wound|bite|cut\b/i.test(cleanName(o.name)) ? "wound" : "mark");
      for (const t of this.allTransitions()) {
        if (t.target !== 0 || !(t.actor > 0) || !(t.newTarget > 0)) continue;
        const actor = this.objects.get(t.actor), o = this.objects.get(t.newTarget);
        if (!actor || !o || !(actor.deadlyDistance > 0) || !o.permanent || o.deathMarker || /grave/i.test(o.name)) continue;
        const c = m.get(o.id) ?? { kind: kindOf(o), from: [] };
        const src = cleanName(actor.name);
        if (!c.from.includes(src)) c.from.push(src);
        m.set(o.id, c);
      }
      for (const o of this.objects.values()) if (o.permanent && !o.parent && /#.*\bsick\b/i.test(o.name) && !m.has(o.id)) m.set(o.id, { kind: "sickness", from: [] });
      // what a condition turns into while still on the body (Gushing -> Stable Knife Wound, Hog Cut -> Clean Hog Cut)
      for (let changed = true; changed; ) {
        changed = false;
        for (const [id, c] of [...m]) {
          for (const t of this.usesAsTarget(id)) {
            const o = this.objects.get(t.newTarget);
            if (!o || !o.permanent || m.has(o.id) || o.deathMarker) continue;
            m.set(o.id, { kind: c.kind, from: c.from });
            changed = true;
          }
        }
      }
      this.conditionCache = m;
    }
    return this.conditionCache.get(this.base(id)) ?? null;
  }
  private conditionCache: Map<number, { kind: "wound" | "sickness" | "mark"; from: string[] }> | null = null;

  /**
   * Animals that attack people who come close (Wild Boar, Wolf, Grizzly
   * Bear, Rattle Snake, ...): deadlyDistance > 0, fixed in place (not a
   * weapon lying around), and moving on their own (or a still variant of a
   * moving one, like a resting wolf). Returns the attack distance, 0 if none.
   */
  dangerRadius(id: number): number {
    if (!(id > 0)) return 0;
    if (!this.dangerCache) {
      const m = new Map<number, number>();
      const movers = new Set<string>();
      const deadly = [...this.objects.values()].filter((o) => o.deadlyDistance > 0 && o.permanent && !o.parent);
      for (const o of deadly) if (this.usesAsTarget(o.id).some((t) => t.actor === -1 && t.move !== 0)) movers.add(cleanName(o.name));
      for (const o of deadly) if (movers.has(cleanName(o.name))) m.set(o.id, o.deadlyDistance);
      this.dangerCache = m;
    }
    return this.dangerCache.get(this.base(id)) ?? 0;
  }
  private dangerCache: Map<number, number> | null = null;

  /** Uses left on a multi-use object (a bush with 4 of 6 berries -> 4); 1 for ordinary objects. */
  usesLeft(id: number): number {
    const o = this.objects.get(id);
    if (!o) return 0;
    if (o.parent && o.useIndex >= 0) return o.useIndex + 1;
    return Math.max(1, o.numUses);
  }

  /** First real (non-placeholder, base) object whose clean name matches exactly, case-insensitive. */
  idByName(name: string): number | null {
    const want = name.trim().toLowerCase();
    let best: number | null = null;
    for (const o of this.objects.values()) {
      if (o.parent || o.person || this.isPlaceholder(o.id)) continue;
      if (cleanName(o.name).toLowerCase() !== want) continue;
      // prefer the plain object over "#variant" copies
      if (best == null || (!o.name.includes("#") && (this.objects.get(best)?.name ?? "").includes("#"))) best = o.id;
    }
    return best;
  }

  /** All object names, for the viewer. */
  allNames(): Record<number, string> {
    const out: Record<number, string> = {};
    for (const id of this.objects.keys()) out[id] = this.name(id);
    return out;
  }
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V) {
  const a = m.get(k);
  if (a) a.push(v);
  else m.set(k, [v]);
}

export function cleanName(raw: string): string {
  let n = raw.split("#")[0];
  n = n.replace(/\$\S*/g, "").replace(/\s+/g, " ").trim();
  return n || raw.trim();
}
