// Appearance rules for agents drawn with the real OHOL art.
//
//   (a) Personality -> hair colour         hairColorForTraits()  (one isolated, swappable function)
//   (b) Lineage     -> hairstyle + face     lineageLook()         (hair donor per sex + eyes/mouth donor)
//   (c) Skin/body   -> whatever displayId the server sends (untouched here)
//   (d) Person      -> a flower in the hair  record.flower (agents service), else flowerFor() (flower.ts)
//
// Players never choose their look; there is no API for it. Everything here is a pure function of
// its inputs (no assets, no DOM), so it runs in node tests as-is.

import { flowerFor } from "./flower.ts";
import type { Flower } from "./flower.ts";

// ------------------------------------------------------------------ person pool

export interface PoolPerson {
  id: number;
  female: boolean;
  race: string;
}

/**
 * The 22 spawnable person objects in OneLifeData7 OneLife_v437 (noSpawn=0). Ordered so that
 * neighbours differ in race/hairstyle; the lineage look table walks these lists.
 */
export const FEMALE_POOL: PoolPerson[] = [
  { id: 19, female: true, race: "D" }, // long brown
  { id: 2404, female: true, race: "A" },
  { id: 1628, female: true, race: "F" },
  { id: 351, female: true, race: "C" },
  { id: 350, female: true, race: "D" }, // blonde curls
  { id: 2464, female: true, race: "A" }, // line-art locks (Hair018)
  { id: 2462, female: true, race: "F" },
  { id: 353, female: true, race: "C" },
  { id: 1007, female: true, race: "D" },
  { id: 1009, female: true, race: "C" },
];

export const MALE_POOL: PoolPerson[] = [
  { id: 347, female: false, race: "D" },
  { id: 1629, female: false, race: "A" },
  { id: 2403, female: false, race: "F" },
  { id: 354, female: false, race: "C" },
  { id: 352, female: false, race: "D" },
  { id: 3078, female: false, race: "A" },
  { id: 3080, female: false, race: "F" },
  { id: 355, female: false, race: "C" },
  { id: 1008, female: false, race: "D" },
  { id: 3079, female: false, race: "A" },
  { id: 3081, female: false, race: "F" },
  { id: 1010, female: false, race: "C" },
];

/**
 * Male hairstyle donors: MALE_POOL minus the styles that cannot carry a personality colour on
 * every skin tone: Male020 (3079) is bald from 15 (beard only), Male008 (355) is a balding fringe
 * at the back of the head, Male012 (1010) is multiply-blended stubble. 9 styles remain.
 */
export const MALE_HAIR_POOL: PoolPerson[] = MALE_POOL.filter((p) => ![3079, 355, 1010].includes(p.id));

export const SPAWNABLE_PEOPLE: PoolPerson[] = [...FEMALE_POOL, ...MALE_POOL].sort((a, b) => a.id - b.id);

/** Eyes+mouth donors: everyone, interleaved F/M so neighbouring slots differ. */
const FACE_POOL: number[] = (() => {
  const out: number[] = [];
  for (let i = 0; i < Math.max(FEMALE_POOL.length, MALE_POOL.length); i++) {
    if (i < MALE_POOL.length) out.push(MALE_POOL[i].id);
    if (i < FEMALE_POOL.length) out.push(FEMALE_POOL[i].id);
  }
  return out;
})();

// ------------------------------------------------------------------ colour helpers

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** OKLCH (L 0..1, C, h degrees) -> linear sRGB. */
function oklchToLinear(L: number, C: number, hDeg: number): [number, number, number] {
  const h = (hDeg * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3;
  const m = m_ ** 3;
  const s = s_ ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

const toSrgb = (x: number) => {
  const v = clamp(x, 0, 1);
  return v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
};

export function rgbToHex(r: number, g: number, b: number): string {
  const h = (v: number) =>
    Math.round(clamp(v, 0, 1) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

export function hexToRgb(hex: string): [number, number, number] {
  const s = hex.replace("#", "");
  return [0, 2, 4].map((i) => Number.parseInt(s.slice(i, i + 2), 16) / 255) as [number, number, number];
}

/** OKLCH -> "#rrggbb"; out-of-gamut colours keep L and h and take the largest chroma that fits. */
export function oklchToHex(L: number, C: number, hDeg: number): string {
  const fits = (c: number) => oklchToLinear(L, c, hDeg).every((v) => v >= -1e-6 && v <= 1 + 1e-6);
  let c = C;
  if (!fits(c)) {
    // bisection: continuous in (L, C, h), unlike stepping chroma down
    let lo = 0;
    let hi = C;
    for (let i = 0; i < 30; i++) {
      const mid = (lo + hi) / 2;
      if (fits(mid)) lo = mid;
      else hi = mid;
    }
    c = lo;
  }
  return rgbToHex(...(oklchToLinear(L, c, hDeg).map(toSrgb) as [number, number, number]));
}

export function mixHex(a: string, b: string, t: number): string {
  const A = hexToRgb(a);
  const B = hexToRgb(b);
  return rgbToHex(A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t);
}

// ------------------------------------------------------------------ (a) personality -> hair colour

/** Tunables for hairColorForTraits, exported so the demo/tests can show them. */
export const HAIR_COLOR_PARAMS = {
  /** traits are clipped to +-clip before mapping */
  clip: 2.5,
  /** hue (OKLCH degrees) of the first dim's positive pole; the others follow evenly around */
  hueOffset: 30,
  /** OKLCH lightness of the tint. The sprite's own shading multiplies it down a little. */
  lightness: 0.66,
  /** chroma at full saturation (gamut-clipped per hue) */
  maxChroma: 0.17,
  /** saturation = 1 - exp(-k * r), r = |v| / RMS; ~0.75 for a typical personality */
  satRate: 1.4,
};

/**
 * Personality -> hair tint ("#rrggbb"). SWAP THIS FUNCTION when the trait set changes.
 *
 * Each dim i gets a fixed hue direction  theta_i = hueOffset + 360 * i / n  (in `dims` order).
 * The trait values (clipped to +-2.5, scaled to +-1) weight those unit vectors; the sum v is a
 * point in the OKLab a/b plane: angle -> hue, |v| -> chroma (saturation), lightness is fixed in
 * OKLCH so every result reads the same against skin and ground. The map is continuous (it is a
 * smooth radial squash of a linear map, chroma -> 0 as |v| -> 0), so similar personalities get
 * similar colours. |v| is normalised by its RMS for iid N(0,1) traits, sqrt(n)/2.5.
 */
export function hairColorForTraits(traits: Record<string, number>, dims: string[]): string {
  const P = HAIR_COLOR_PARAMS;
  const n = dims.length;
  if (n === 0) return oklchToHex(P.lightness, 0, 0);
  let vx = 0;
  let vy = 0;
  dims.forEach((dim, i) => {
    const t = clamp(traits[dim] ?? 0, -P.clip, P.clip) / P.clip;
    const th = ((P.hueOffset + (360 * i) / n) * Math.PI) / 180;
    vx += t * Math.cos(th);
    vy += t * Math.sin(th);
  });
  const r = Math.hypot(vx, vy) / (Math.sqrt(n) / P.clip);
  // chroma -> 0 as |v| -> 0, so the map stays continuous through the neutral personality
  const sat = 1 - Math.exp(-P.satRate * r);
  const hue = (Math.atan2(vy, vx) * 180) / Math.PI;
  return oklchToHex(P.lightness, P.maxChroma * sat, hue);
}

/**
 * How far hair goes toward grey/white with age: 0 until 35, 0.4 at 50, 0.6 from 60. Capped at 0.6 so
 * elders stay "silvery" in their personality colour (personality must stay readable at every age).
 */
export function hairGreyAmount(age: number): number {
  if (age < 35) return 0;
  if (age < 50) return (0.4 * (age - 35)) / 15;
  if (age < 60) return 0.4 + (0.2 * (age - 50)) / 10;
  return 0.6;
}

export const ELDER_HAIR = "#e6e3dc";

/** Hair tint at a given age: the personality colour blended toward grey/white for elders. */
export function hairTintAtAge(hairColor: string, age: number): string {
  return mixHex(hairColor, ELDER_HAIR, hairGreyAmount(age));
}

// ------------------------------------------------------------------ (b) lineage -> look

/** 32-bit hash (FNV-1a + murmur3 finaliser) of a lineage id. */
export function hashId(id: string | number): number {
  const s = String(id);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface LineageLook {
  /** index into the look table */
  slot: number;
  /** hairstyle donor for female members */
  femaleHairDonor: number;
  /** hairstyle (and beard) donor for male members */
  maleHairDonor: number;
  /** eyes + mouth donor, both sexes */
  faceDonor: number;
}

/** lcm(10 female, 9 male) = 90 slots; slot k uses female k%10, male k%9, face (7k)%22. */
export const LOOK_TABLE: LineageLook[] = Array.from({ length: 90 }, (_, k) => ({
  slot: k,
  femaleHairDonor: FEMALE_POOL[k % FEMALE_POOL.length].id,
  maleHairDonor: MALE_HAIR_POOL[k % MALE_HAIR_POOL.length].id,
  faceDonor: FACE_POOL[(7 * k) % FACE_POOL.length],
}));

/** Deterministic preference order over LOOK_TABLE for one lineage. */
function preferences(lineageId: string | number): number[] {
  const rnd = mulberry32(hashId(lineageId));
  const order = LOOK_TABLE.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

const compareIds = (a: string | number, b: string | number) => {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
};

const conflicts = (a: LineageLook, b: LineageLook) =>
  a.femaleHairDonor === b.femaleHairDonor || a.maleHairDonor === b.maleHairDonor || a.faceDonor === b.faceDonor;

/**
 * The look of a lineage.
 *
 * Alone, a lineage gets the first slot of its hash-seeded preference order. With `lineageIds`
 * (the lineages to keep apart), lineages claim in ascending id order (older Eves first, so a new
 * lineage never changes an older one), each taking its first preference that shares no female
 * hairstyle, male hairstyle or face with an earlier claim; up to 9 lineages are fully distinct
 * (9 male hairstyles), and beyond that it falls back to any unclaimed slot.
 *
 * Stability: pass every lineage seen this run (alive or dead) and a lineage's look never changes.
 * Pass only the living ones to maximise contrast among them; then a younger lineage's look can
 * change when an older lineage that displaced it dies out.
 */
export function lineageLook(lineageId: string | number, lineageIds?: (string | number)[]): LineageLook {
  if (!lineageIds || lineageIds.length === 0) return LOOK_TABLE[preferences(lineageId)[0]];
  const ids = [...new Set([...lineageIds, lineageId].map(String))].sort(compareIds);
  const taken: LineageLook[] = [];
  for (const id of ids) {
    const prefs = preferences(id);
    const free = prefs.map((i) => LOOK_TABLE[i]).filter((l) => !taken.some((t) => t.slot === l.slot));
    const pick = free.find((l) => !taken.some((t) => conflicts(t, l))) ?? free[0] ?? LOOK_TABLE[prefs[0]];
    if (id === String(lineageId)) return pick;
    taken.push(pick);
  }
  return LOOK_TABLE[preferences(lineageId)[0]];
}

// ------------------------------------------------------------------ public entry point

export interface Appearance {
  /** person object whose hair/beard layers replace the base's */
  hairDonorId: number;
  /** person object whose eyes + mouth layers replace the base's */
  faceDonorId: number;
  /** hair tint at age 20-35 ("#rrggbb"); greyed with age at draw time */
  hairColor: string;
  /** look-table slot (for debugging / legends) */
  lookSlot: number;
  /** the person's flower; null = none drawn (no lifeId, e.g. a family's generic look) */
  flower?: Flower | null;
}

export interface AppearanceInput {
  /** person object id from the server: skin and body stay exactly this */
  displayId: number;
  female: boolean;
  /** eve id / lineage id */
  lineageId: string | number;
  traits: Record<string, number>;
  traitDims: string[];
  /** lineages to keep visually apart (see lineageLook for the stability trade-off) */
  livingLineageIds?: (string | number)[];
  /** this life: with it (or `flower`) the person wears a flower */
  lifeId?: string | null;
  /** the record's flower (LifeRecord / AgentView / PlayerView .flower): authoritative */
  flower?: Flower | null;
  /** fallback only (record without a flower): living members of the same lineage, see flowerFor */
  livingFamilyLifeIds?: readonly string[];
}

export function appearanceFor(input: AppearanceInput): Appearance {
  const look = lineageLook(input.lineageId, input.livingLineageIds);
  return {
    hairDonorId: input.female ? look.femaleHairDonor : look.maleHairDonor,
    faceDonorId: look.faceDonor,
    hairColor: hairColorForTraits(input.traits, input.traitDims),
    lookSlot: look.slot,
    flower:
      input.flower || input.lifeId
        ? flowerFor({ lifeId: input.lifeId ?? "", lineageId: input.lineageId, flower: input.flower, livingFamilyLifeIds: input.livingFamilyLifeIds })
        : null,
  };
}
