// Per-person flowers, viewer side (pure: no DOM, runs in node tests).
//
// The agents service assigns each life its flower at birth and sends it on LifeRecord /
// AgentView / PlayerView (`flower`); the catalogue and picker are shared (../flowers.ts). The
// viewer draws whatever the record says. flowerFor() is only the fallback for fixtures and old
// data without a `flower`: the same picker, run over the living family in birth order.
//
// Art: five shapes are real OHOL sprites (flower heads only, recoloured), six are AI-generated
// sprites in the OHOL style (public/flowers/, see its README), recoloured the same way
// (flowerArt.ts). Retired shape ids in stored records map to their replacement (canonicalFlower).
// Placement is in compose.ts (flowerOp).

import { canonicalFlower, FLOWER_COLORS, pickFlower } from "../flowers.ts";
import type { Flower } from "../flowers.ts";

export type { Flower } from "../flowers.ts";

export interface FlowerArt {
  /** OHOL sprite id of the flower head (exactly one of sprite / image) */
  sprite?: number;
  /** generated sprite file in public/flowers/ (white petals, ink outline, trimmed, 64 px) */
  image?: string;
  /** relative size (1 = the standard flower size) */
  scale: number;
  /** keep the sprite's yellow centre pixels (stamens, a daisy's disc) instead of tinting them */
  keepCentre?: boolean;
}

/**
 * Shape id -> art. Sprites (OneLifeData7): 1310 DomesticRoseRed (Red Rose Bush bloom), 1296 WildRose
 * (Wild Rose blossom), 242 Milkweed (Flowering Milkweed umbel), 1071 BarrelCactus (Flowering Barrel
 * Cactus bloom), 1470 SquashPlant (Blooming Squash Plant flower).
 */
export const FLOWER_ART: Record<string, FlowerArt> = {
  rose: { sprite: 1310, scale: 0.95 },
  wildrose: { sprite: 1296, scale: 1, keepCentre: true },
  milkweed: { sprite: 242, scale: 1.15 },
  cactus: { sprite: 1071, scale: 1 },
  squash: { sprite: 1470, scale: 1.1 },
  // generated (public/flowers/README.md)
  daisy: { image: "daisy.png", scale: 1.05, keepCentre: true },
  tulip: { image: "tulip.png", scale: 0.95, keepCentre: true },
  poppy: { image: "poppy.png", scale: 1, keepCentre: true },
  iris: { image: "iris.png", scale: 1, keepCentre: true },
  lily: { image: "lily.png", scale: 1.05, keepCentre: true },
  forgetmenot: { image: "forgetmenot.png", scale: 0.95, keepCentre: true },
};

export function flowerHex(color: string): string {
  return FLOWER_COLORS.find((c) => c.id === color)?.hex ?? "#ffffff";
}

/** World-unit size of a flower at a given age: smaller for babies, full from 10. */
export function flowerSizeAtAge(age: number): number {
  const FULL = 24;
  if (age >= 10) return FULL;
  if (age <= 1) return FULL * 0.62;
  return FULL * (0.62 + (0.38 * (age - 1)) / 9);
}

/** Sort key for "oldest first": the in-game player id at the end of a lifeId ("run:12", "run.2:12"). */
function birthKey(lifeId: string): [string, number] {
  const m = /^(.*):(\d+)$/.exec(lifeId);
  return m ? [m[1], Number(m[2])] : [lifeId, 0];
}

function olderFirst(a: string, b: string): number {
  const [ra, pa] = birthKey(a);
  const [rb, pb] = birthKey(b);
  if (ra !== rb) return ra < rb ? -1 : 1;
  return pa - pb;
}

export interface FlowerInput {
  lifeId: string;
  lineageId?: string | number | null;
  /** the record's flower (authoritative, from the agents service) */
  flower?: Flower | null;
  /** lifeIds of the living members of the same lineage (fallback only; may include lifeId) */
  livingFamilyLifeIds?: readonly string[];
}

/**
 * A life's flower: the record's when it has one; otherwise (fixtures, old data) the shared picker
 * run over the living family, oldest first (player ids grow with birth order), each taking its
 * first free variant. A newcomer never changes an older member's flower. Without the family, the
 * life's first preference.
 */
export function flowerFor(input: FlowerInput): Flower {
  const own = canonicalFlower(input.flower);
  if (own) return own;
  const family = [...new Set([...(input.livingFamilyLifeIds ?? []), input.lifeId])].sort(olderFirst);
  const taken: Flower[] = [];
  for (const id of family) {
    const f = pickFlower(id, taken);
    if (id === input.lifeId) return f;
    taken.push(f);
  }
  return pickFlower(input.lifeId);
}

export interface FlowerLife {
  lifeId: string;
  lineageId: string;
  bornAt: number;
  diedAt: number | null;
  /** lost lives count as alive until here (LifeRecord.presumedEndAt) */
  presumedEndAt?: number | null;
  flower?: Flower | null;
}

/**
 * Flowers for a whole set of life records, the record's own where it has one. Records without
 * one (fixtures, data from before flowers) get what the agents service gives such records on load
 * (lives.ts assignMissingFlowers): oldest birth first, the first variant no relative alive at its
 * birth wore. Stable: later births and deaths never change an earlier life's flower.
 */
export function flowersForLives(lives: readonly FlowerLife[]): Map<string, Flower> {
  const all = [...lives].sort((a, b) => a.bornAt - b.bornAt);
  const out = new Map<string, Flower>();
  const byLineage = new Map<string, FlowerLife[]>();
  for (const l of all) {
    const own = canonicalFlower(l.flower);
    if (own) out.set(l.lifeId, own);
    const g = byLineage.get(l.lineageId);
    if (g) g.push(l);
    else byLineage.set(l.lineageId, [l]);
  }
  for (const l of all) {
    if (out.has(l.lifeId)) continue;
    const taken: Flower[] = [];
    for (const o of byLineage.get(l.lineageId) ?? []) {
      if (o.bornAt > l.bornAt) break;
      const f = out.get(o.lifeId);
      if (o === l || !f) continue;
      const end = o.diedAt ?? o.presumedEndAt ?? Infinity;
      if (end > l.bornAt) taken.push(f);
    }
    out.set(l.lifeId, pickFlower(l.lifeId, taken));
  }
  return out;
}

// ------------------------------------------------------------------ recolouring real sprites

const lum = (r: number, g: number, b: number) => (0.299 * r + 0.587 * g + 0.114 * b) / 255;

/**
 * Recolour a flower sprite in place: ink (dark outline) stays, petals take `tint` with the
 * sprite's own shading (luminance normalised to its 90th percentile), so every shape reads in
 * every colour. With keepCentre, saturated yellow pixels (a wild rose's stamens) are kept; on
 * yellow/orange petals they turn brown so the centre still shows. Alpha is unchanged.
 */
export function recolorFlowerPixels(
  data: Uint8ClampedArray | Uint8Array,
  w: number,
  h: number,
  tint: [number, number, number],
  opts: { keepCentre?: boolean; warmPetals?: boolean } = {},
): void {
  const n = w * h;
  const lums: number[] = [];
  for (let i = 0; i < n; i++) if (data[i * 4 + 3] >= 64) lums.push(lum(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]));
  if (!lums.length) return;
  lums.sort((a, b) => a - b);
  const hi = Math.max(0.2, lums[Math.floor(0.9 * (lums.length - 1))]);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    if (data[o + 3] === 0) continue;
    const r = data[o] / 255;
    const g = data[o + 1] / 255;
    const b = data[o + 2] / 255;
    const L = lum(data[o], data[o + 1], data[o + 2]);
    if (L < 0.13) continue; // ink
    const mx = Math.max(r, g, b);
    const mn = Math.min(r, g, b);
    if (opts.keepCentre && mx > 0.45 && mx - mn > 0.35 && r > 0.6 && g > 0.45 && b < 0.45) {
      if (opts.warmPetals) {
        data[o] = 138;
        data[o + 1] = 74;
        data[o + 2] = 18;
      }
      continue;
    }
    // shading: 0.45..1 of the tint (petals never go muddy), outline-adjacent dark pixels a bit darker
    const v = Math.min(1, L / hi);
    const k = 0.45 + 0.55 * v ** 0.8;
    for (let c = 0; c < 3; c++) data[o + c] = Math.round(255 * tint[c] * k);
  }
}
