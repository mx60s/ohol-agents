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
    let n = o ? cleanName(o.name) : `object ${id}`;
    if (o && o.parent && o.useIndex >= 0 && o.numUses <= 1) {
      // use dummy: name comes from parent; show uses left
      const p = this.objects.get(o.parent);
      if (p) {
        n = cleanName(p.name);
        if (p.numUses > 1) n += ` (${o.useIndex + 1}/${p.numUses} left)`;
      }
    }
    this.nameCache.set(id, n);
    return n;
  }

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

  transition(actor: number, target: number): Transition | undefined {
    return this.byPair.get(`${actor},${target}`)?.[0];
  }

  usesAsActor(actor: number): Transition[] {
    return this.byActor.get(actor) ?? [];
  }

  usesAsTarget(target: number): Transition[] {
    return this.byTarget.get(target) ?? [];
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
