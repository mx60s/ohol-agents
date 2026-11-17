// Per-person flowers: every life wears one flower in its hair, so individuals within a family
// (same hairstyle and face, similar inherited hair colour) can be told apart, by viewers and by
// the agents themselves. Not in the original game: a declared intervention (README).
//
// ONE authoritative assignment: the agents service picks a life's flower at birth (lives.ts) and
// stores it on the LifeRecord; the viewer draws record.flower. This file is the shared catalogue
// and picker. agents/src/flowers.ts is copied verbatim to viewer/src/flowers.ts (a viewer test
// checks that they match), like api-types.ts. Pure, no imports.
//
// Variant = shape x colour (11 x 7 = 77). The colours are saturated flower hues plus white and
// yellow, chosen to sit away from the hair-colour space (hair: OKLCH L 0.66, chroma <= 0.17, any
// hue, greyed toward #e6e3dc with age): every flower colour is >= 0.07 OKLab from every hair tint (orange, the closest, 0.072)
// (viewer test), by being much darker+more saturated (red, pink, purple, blue) or much lighter
// (orange, yellow, white). A flower never reads as a personality colour.

export interface FlowerShape {
  id: string;
  /** what agents and viewers call it */
  name: string;
}

export interface FlowerColor {
  id: string;
  name: string;
  /** petal tint "#rrggbb" */
  hex: string;
}

/** A life's flower (LifeRecord.flower). */
export interface Flower {
  /** FlowerShape.id */
  shape: string;
  /** FlowerColor.id */
  color: string;
  /** "red rose" */
  label: string;
}

/**
 * Shapes. The first five are drawn from real OHOL sprites, the other six are AI-generated sprites
 * in the OHOL style (viewer/public/flowers/, see its README; art in viewer/src/ohol/flower.ts).
 */
export const FLOWER_SHAPES: readonly FlowerShape[] = [
  { id: "rose", name: "rose" },
  { id: "wildrose", name: "wild rose" },
  { id: "milkweed", name: "milkweed" },
  { id: "cactus", name: "cactus flower" },
  { id: "squash", name: "squash blossom" },
  { id: "daisy", name: "daisy" },
  { id: "tulip", name: "tulip" },
  { id: "poppy", name: "poppy" },
  { id: "iris", name: "iris" },
  { id: "lily", name: "lily" },
  { id: "forgetmenot", name: "forget-me-not" },
];

/**
 * Retired shape ids -> their replacement, so stored records still render. "daisy" and "tulip"
 * kept their ids (new art); the hand-drawn bellflower ("bell") became the lily, the other
 * bell/trumpet-shaped flower.
 */
export const LEGACY_FLOWER_SHAPES: Readonly<Record<string, string>> = { bell: "lily" };

export const FLOWER_COLORS: readonly FlowerColor[] = [
  { id: "red", name: "red", hex: "#db000f" },
  { id: "orange", name: "orange", hex: "#ffb334" },
  { id: "yellow", name: "yellow", hex: "#ffec35" },
  { id: "white", name: "white", hex: "#fdfcf5" },
  { id: "pink", name: "pink", hex: "#ee008e" },
  { id: "purple", name: "purple", hex: "#771acc" },
  { id: "blue", name: "blue", hex: "#1844e2" },
];

export const FLOWER_VARIANTS = FLOWER_SHAPES.length * FLOWER_COLORS.length;

export function flowerLabel(shape: string, color: string): string {
  const s = FLOWER_SHAPES.find((x) => x.id === shape)?.name ?? shape;
  const c = FLOWER_COLORS.find((x) => x.id === color)?.name ?? color;
  return `${c} ${s}`;
}

/** Variant index v -> flower (shape = v div colours, colour = v mod colours). */
export function flowerOfVariant(v: number): Flower {
  const n = FLOWER_COLORS.length;
  const shape = FLOWER_SHAPES[Math.floor(v / n) % FLOWER_SHAPES.length].id;
  const color = FLOWER_COLORS[v % n].id;
  return { shape, color, label: flowerLabel(shape, color) };
}

/** 32-bit hash (FNV-1a + murmur3 finaliser). */
function hash(s: string): number {
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

/** Deterministic preference order over all variants for one life (seeded by its lifeId). */
export function flowerPreferences(lifeId: string): number[] {
  let a = hash(`flower:${lifeId}`);
  const rnd = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const order = Array.from({ length: FLOWER_VARIANTS }, (_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

/**
 * The flower for a new life, given the flowers already worn by the living members of its family.
 * Takes the first variant in the life's own seeded order that shares neither shape nor colour with
 * a living relative; failing that (7+ relatives), one whose colour is new; then any variant nobody
 * wears; with more living relatives than variants (77), its first preference (a repeat is unavoidable).
 * Deterministic: the same lifeId and the same `taken` always give the same flower.
 */
export function pickFlower(lifeId: string, taken: readonly Pick<Flower, "shape" | "color">[] = []): Flower {
  const prefs = flowerPreferences(lifeId).map(flowerOfVariant);
  const shapes = new Set(taken.map((t) => t.shape));
  const colors = new Set(taken.map((t) => t.color));
  const pairs = new Set(taken.map((t) => `${t.shape}|${t.color}`));
  return (
    prefs.find((f) => !shapes.has(f.shape) && !colors.has(f.color)) ??
    prefs.find((f) => !colors.has(f.color) && !pairs.has(`${f.shape}|${f.color}`)) ??
    prefs.find((f) => !shapes.has(f.shape) && !pairs.has(`${f.shape}|${f.color}`)) ??
    prefs.find((f) => !pairs.has(`${f.shape}|${f.color}`)) ??
    prefs[0]
  );
}

/**
 * A stored flower in today's catalogue: a retired shape id becomes its replacement (with a fresh
 * label); anything else unchanged. Returns null for a flower that is still unknown afterwards.
 */
export function canonicalFlower(f: unknown): Flower | null {
  if (isKnownFlower(f)) return f;
  const x = f as Flower | null;
  if (!x || typeof x !== "object") return null;
  const shape = LEGACY_FLOWER_SHAPES[x.shape];
  if (!shape) return null;
  const out = { shape, color: x.color, label: flowerLabel(shape, x.color) };
  return isKnownFlower(out) ? out : null;
}

/** Is this a flower the catalogue knows (shape and colour ids)? */
export function isKnownFlower(f: unknown): f is Flower {
  const x = f as Flower | null;
  return !!x && typeof x === "object" && FLOWER_SHAPES.some((s) => s.id === x.shape) && FLOWER_COLORS.some((c) => c.id === x.color);
}
