// Personality text for a life.
//
// SEAM: today traits are MOCK numbers and this file writes a tentative
// placeholder sentence from them (personalityBlurb). The plan is for the
// backend to send a summary generated from neuron readings as
// `life.personalitySummary`; personalityText() already prefers that, so pages
// should call personalityText(life, dims) and never personalityBlurb directly.

import type { LifeRecord, Traits } from "../api-types.ts";

export interface PersonalityText {
  text: string;
  /** "backend" = written by the server (future); "mock" = this placeholder */
  source: "backend" | "mock";
}

/** LifeRecord plus fields a newer backend may add. */
export type LifeWithSummary = LifeRecord & { personalitySummary?: string | null };

export function personalityText(life: Pick<LifeWithSummary, "traits" | "personalitySummary">, dims: readonly string[]): PersonalityText {
  const s = life.personalitySummary?.trim();
  if (s) return { text: s, source: "backend" };
  return { text: personalityBlurb(life.traits, dims), source: "mock" };
}

// [high phrase, low phrase] per known dimension
const WORDS: Record<string, [string, string]> = {
  openness: ["curious about new things", "fond of the familiar"],
  conscientiousness: ["careful and organised", "easygoing about plans"],
  extraversion: ["outgoing and talkative", "quiet and reserved"],
  agreeableness: ["warm and cooperative", "blunt and independent"],
  neuroticism: ["easily worried", "calm under pressure"],
};

function phrase(dim: string, v: number): string {
  const w = WORDS[dim.toLowerCase()];
  if (w) return v > 0 ? w[0] : w[1];
  const name = dim.replace(/[_-]+/g, " ").toLowerCase();
  return v > 0 ? `high in ${name}` : `low in ${name}`;
}

/**
 * MOCK placeholder: a short, tentative, plain-English line from trait z-scores.
 * Picks up to two dimensions furthest from average (|z| >= 0.5).
 *   {openness: 1.3, agreeableness: -1.2, ...} -> "Seems curious about new things, and perhaps blunt and independent."
 */
export function personalityBlurb(traits: Traits | null | undefined, dims: readonly string[]): string {
  if (!traits) return "Too early to say much about this one.";
  const keys = dims.length ? dims : Object.keys(traits);
  const ranked = keys
    .map((d) => ({ d, v: traits[d] }))
    .filter((x): x is { d: string; v: number } => typeof x.v === "number" && Number.isFinite(x.v))
    .map((x) => ({ d: x.d, v: Math.max(-3, Math.min(3, x.v)) }))
    .filter((x) => Math.abs(x.v) >= 0.5)
    .sort((a, b) => Math.abs(b.v) - Math.abs(a.v));
  if (!ranked.length) return "Seems fairly middle-of-the-road; nothing stands out yet.";
  const [a, b] = ranked;
  const lead = Math.abs(a.v) >= 1.5 ? "Seems quite" : "Seems";
  const first = phrase(a.d, a.v);
  return b ? `${lead} ${first}, and perhaps ${phrase(b.d, b.v)}.` : `${lead} ${first}.`;
}
