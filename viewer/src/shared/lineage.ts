// Family colours from the design (tokens.css --lin-1..6).
// USER RULE (design/site-feedback.md): families share a surname, which is enough.
// Use lineageColor ONLY for chart points that carry data (e.g. the personality
// cloud): no colour dots/markers on people cards, death rows or legends.

import type { LineageRecord } from "../api-types.ts";
import { displayName, surnameOf } from "./format.ts";

export interface LineageStyle {
  /** 1..6, or 0 for "other" */
  slot: number;
  /** "#rrggbb" */
  color: string;
  /** CSS variable for the same colour, e.g. "var(--lin-2)" */
  cssVar: string;
  /** palette name: clay, teal, ochre, violet, green, rose */
  name: string;
}

export const LINEAGE_PALETTE: readonly Omit<LineageStyle, "slot" | "cssVar">[] = [
  { color: "#c4573a", name: "clay" },
  { color: "#0e88a8", name: "teal" },
  { color: "#a07a1c", name: "ochre" },
  { color: "#6b5aa6", name: "violet" },
  { color: "#5f8a2e", name: "green" },
  { color: "#c2648c", name: "rose" },
];

export const OTHER_LINEAGE: LineageStyle = { slot: 0, color: "#9a917f", cssVar: "var(--lin-other)", name: "other" };

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function styleFor(slotIdx: number): LineageStyle {
  const p = LINEAGE_PALETTE[slotIdx];
  return { ...p, slot: slotIdx + 1, cssVar: `var(--lin-${slotIdx + 1})` };
}

/**
 * Stable chart colour for a lineage (chart points only; see the note at the top).
 *
 * Without `visible`, the slot is a hash of the id: the same lineage always gets the same
 * look on every page, but two lineages can collide. Pass `visible` (lineage ids shown
 * together, in founding order, e.g. useLineages().data.lineages reversed) to keep up to 6
 * apart: each takes its hashed slot, or the next free one if an older lineage holds it.
 * Lineages beyond the first 6 visible ones share their hashed slot.
 */
export function lineageColor(lineageId: string | null | undefined, visible?: readonly string[]): LineageStyle {
  if (!lineageId) return OTHER_LINEAGE;
  const n = LINEAGE_PALETTE.length;
  if (visible && visible.includes(lineageId)) {
    const taken = new Set<number>();
    for (const id of visible) {
      let s = hash(id) % n;
      if (taken.size < n) while (taken.has(s)) s = (s + 1) % n;
      if (id === lineageId) return styleFor(s);
      taken.add(s);
    }
  }
  return styleFor(hash(lineageId) % n);
}

/** Lineage ids in founding order (oldest first), the input `lineageColor` wants for `visible`. */
export function lineageOrder(lineages: readonly LineageRecord[]): string[] {
  return [...lineages].sort((a, b) => a.foundedAt - b.foundedAt || a.lineageId.localeCompare(b.lineageId)).map((l) => l.lineageId);
}

/**
 * Family display name, from the founder's surname: founder "Dawn Hope" -> "Hope".
 * Falls back to the founder's full name, then "Family <short id>".
 */
export function lineageName(l: Pick<LineageRecord, "eveName" | "lineageId"> | null | undefined): string {
  if (!l) return "Unknown family";
  const name = displayName(l.eveName, "");
  // "Aurora II Dawn" -> "Dawn"; a lone "Aurora II" (no family name yet) -> "Aurora"
  const surname = surnameOf(name);
  if (surname) return surname;
  const first = name.split(/\s+/).filter(Boolean)[0];
  if (first) return first;
  return `Family ${l.lineageId.split(":").pop() ?? l.lineageId}`;
}
