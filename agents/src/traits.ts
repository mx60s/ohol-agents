// Trait vectors for the personality study. Pure logic, no I/O.
//
// MOCK for now: traits are sampled and inherited exactly as the study design
// says, but nothing reads them when building prompts or choosing actions.
// Dimension names come from config (TRAIT_DIMS); nothing here hardcodes them
// beyond the default list.

import type { Traits } from "./api-types.ts";

export const DEFAULT_TRAIT_DIMS = ["openness", "conscientiousness", "extraversion", "agreeableness", "neuroticism"];
/** every dimension is clipped to [-TRAIT_CLIP, TRAIT_CLIP] */
export const TRAIT_CLIP = 2.5;

/** uniform [0, 1) */
export type Rng = () => number;

/** Small seedable PRNG (mulberry32), for reproducible tests. */
export function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal sample (Box-Muller). */
export function gaussian(rng: Rng): number {
  let u = 0;
  while (u <= Number.EPSILON) u = rng();
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function clipTrait(v: number): number {
  return Math.max(-TRAIT_CLIP, Math.min(TRAIT_CLIP, v));
}

const round = (v: number) => Math.round(v * 1e6) / 1e6;

/**
 * Parse TRAIT_DIMS ("a,b,c"). Names must be identifier-like (letters, digits,
 * _ or -, max 40 chars); duplicates are dropped. Empty/invalid -> default list.
 */
export function parseTraitDims(raw: string | undefined): string[] {
  if (!raw || !raw.trim()) return [...DEFAULT_TRAIT_DIMS];
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const d = part.trim();
    if (!d) continue;
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(d)) throw new Error(`TRAIT_DIMS: invalid dimension name "${d}"`);
    if (!out.includes(d)) out.push(d);
  }
  return out.length ? out : [...DEFAULT_TRAIT_DIMS];
}

/** Eve: each dimension ~ N(0, 1), clipped. */
export function sampleEveTraits(dims: string[], rng: Rng): Traits {
  const t: Traits = {};
  for (const d of dims) t[d] = round(clipTrait(gaussian(rng)));
  return t;
}

/**
 * Child: mother's value + N(0, sd) per dimension, clipped. With no mother
 * traits (unknown mother, or not one of our agents) falls back to Eve-style
 * sampling and reports inherited = false. A dimension the mother lacks (e.g.
 * TRAIT_DIMS changed between her birth and this one) is sampled fresh.
 */
export function inheritTraits(mother: Traits | null | undefined, dims: string[], sd: number, rng: Rng): { traits: Traits; inherited: boolean } {
  if (!mother) return { traits: sampleEveTraits(dims, rng), inherited: false };
  const t: Traits = {};
  for (const d of dims) {
    const m = mother[d];
    t[d] = round(clipTrait(Number.isFinite(m) ? m + sd * gaussian(rng) : gaussian(rng)));
  }
  return { traits: t, inherited: true };
}
