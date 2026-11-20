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

/**
 * false while the traits are placeholders: every personality display reads
 * "none" (stream, agent page, people table, home cloud). Hair colours still
 * come from the recorded traits; nothing shows their values. Build with
 * VITE_SHOW_TRAITS=1 to show the recorded numbers again.
 */
export const TRAITS_SHOWN: boolean = (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_SHOW_TRAITS === "1";

/** LifeRecord plus fields a newer backend may add. */
export type LifeWithSummary = LifeRecord & { personalitySummary?: string | null };

export function personalityText(life: Pick<LifeWithSummary, "traits" | "personalitySummary">, dims: readonly string[]): PersonalityText {
  if (!TRAITS_SHOWN) return { text: "none", source: "mock" };
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

// ---------------------------------------------------------------- prompted personalities
// PERSONALITIES (backend config): each Eve's family gets one descriptor ("sociable and
// sentimental") in founding order, inherited by her descendants, as a line in their system prompt.
// The API sends it per agent/player/lineage (`personality`) and the run's list (run.personalities).

/** "sociable and sentimental" -> "sociable · sentimental"; "a, b and c" -> "a · b · c" (compact tags) */
export function personalityShort(descriptor: string): string {
  const parts = descriptor
    .split(/\s*,\s*|\s+and\s+|\s*&\s*/i)
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length ? parts.join(" · ") : descriptor.trim();
}

/** lineage id -> descriptor, from anything that carries both (agents, players, lineages); first non-empty wins */
export function personalityByLineage(...sources: ReadonlyArray<{ lineageId?: string | null; personality?: string | null }>[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const list of sources) for (const x of list) if (x.lineageId && x.personality && !out.has(x.lineageId)) out.set(x.lineageId, x.personality);
  return out;
}

/** colour slot (0..2) of a descriptor: its position in run.personalities, so a family keeps its colour everywhere */
export function personalitySlot(descriptor: string, palette: readonly string[] | null | undefined): number {
  const i = palette?.indexOf(descriptor) ?? -1;
  if (i >= 0) return i % 3;
  // not in the list (older data): a stable slot from the text
  let h = 0;
  for (const c of descriptor) h = (h * 31 + c.charCodeAt(0)) | 0;
  return Math.abs(h) % 3;
}

/** tooltip for a tag: what it is and where it comes from */
export function personalityTitle(descriptor: string): string {
  return `Family personality (prompted): their system prompt says "You are ${descriptor}." Inherited from the family's Eve.`;
}
