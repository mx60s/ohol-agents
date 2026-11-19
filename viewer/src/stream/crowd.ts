// Crowd handling for the stream camera (pure, no DOM): which speech shows as a bubble and which as a
// small pip, the chat box's lines, short name labels, and a collision pass that keeps labels from
// piling up. Tested in tests/crowd.test.mjs.

import type { RunEvent } from "../api-types.ts";
import { cleanText, cueOfSay, displayName, firstNameOf, surnameOf } from "../shared/format.ts";
import type { SpeechBubble } from "./logic.ts";

// ================================================================== crowd mode

/** this many people on screen (or more) switches the camera to compact speech: pips + the chat box */
export const CROWD_AT = 5;

/** Crowd mode with a little hysteresis: on at CROWD_AT people in view, off again only at CROWD_AT - 2. */
export function crowdMode(prev: boolean, inView: number): boolean {
  return prev ? inView > CROWD_AT - 2 : inView >= CROWD_AT;
}

export interface SpeechPlan {
  /** shown as today's bubbles (or emotes) over heads */
  full: SpeechBubble[];
  /** player ids that get a small "…" pip instead (their line is in the chat box) */
  pips: number[];
}

/**
 * Which recent speech shows in full. Not crowded: everything. Crowded: the followed person's line
 * (or emote) and the single most recent line by someone else on screen (`inView`, when given); other
 * speakers get a pip, other emotes are dropped (the chat box shows them). `bubbles` is newest first
 * (as speechBubbles gives).
 */
export function planSpeech(bubbles: readonly SpeechBubble[], crowd: boolean, focusPlayerId: number | null, inView?: ReadonlySet<number>): SpeechPlan {
  if (!crowd) return { full: bubbles.slice(), pips: [] };
  const full: SpeechBubble[] = [];
  const pips: number[] = [];
  let other = false;
  for (const b of bubbles) {
    if (b.playerId === focusPlayerId) full.push(b);
    else if (b.emote) continue;
    else if (!other && (!inView || inView.has(b.playerId))) {
      other = true;
      full.push(b);
    } else pips.push(b.playerId);
  }
  return { full, pips };
}

// ================================================================== chat box

export interface ChatLine {
  key: string;
  playerId: number;
  t: number;
  /** display name ("Ember Thorndale") */
  name: string;
  lineageId: string | null;
  /** the spoken text, or "" for an emote */
  text: string;
  /** +WORD+ cue (HOMESICK, HOME...), shown as a muted "(homesick)" line */
  emote: string | null;
  /** the speaker is not of the followed person's family (shown with their family name) */
  cross: boolean;
  /** the speaker's family name ("Thorndale"), if their name has one */
  family: string | null;
}

export interface Person {
  name?: string | null;
  lineageId?: string | null;
}

export interface ChatOptions {
  now: number;
  /** player ids on screen right now */
  inView: ReadonlySet<number>;
  /** the followed person always counts as in view */
  focusPlayerId: number | null;
  /** speaker by player id */
  who: (playerId: number) => Person | null | undefined;
  /** the followed person's family: lines by anyone else are marked as cross-family */
  focusLineageId?: string | null;
  /** most lines kept (default 9) */
  max?: number;
  /** lines older than this drop out (server ms, default 3 min) */
  windowMs?: number;
}

/** how far back the chat box looks */
export const CHAT_WINDOW_MS = 180_000;
export const CHAT_MAX = 9;

/**
 * The chat box: recent say lines by people on screen (and the followed person), oldest first so the
 * newest sits at the bottom, at most `max`. Emotes are kept as muted lines; a line repeated by the
 * same speaker back to back shows once. Events are oldest first.
 */
export function chatLines(events: readonly RunEvent[], o: ChatOptions): ChatLine[] {
  const max = o.max ?? CHAT_MAX;
  const win = o.windowMs ?? CHAT_WINDOW_MS;
  const out: ChatLine[] = [];
  for (let i = events.length - 1; i >= 0 && out.length < max; i--) {
    const e = events[i];
    if (o.now - e.t > win) break;
    if (e.kind !== "say" || e.playerId == null || e.t > o.now + 5000) continue;
    if (!o.inView.has(e.playerId) && e.playerId !== o.focusPlayerId) continue;
    const raw = cleanText(e.text ?? "").trim();
    if (!raw) continue;
    const emote = cueOfSay(raw);
    const prev = out[out.length - 1];
    if (prev && prev.playerId === e.playerId && (emote ? prev.emote === emote : prev.text === raw)) continue;
    const p = o.who(e.playerId);
    const lineageId = p?.lineageId ?? null;
    const name = displayName(p?.name ?? e.name, "Someone");
    const cross = !!lineageId && !!o.focusLineageId && lineageId !== o.focusLineageId;
    out.push({ key: String(e.seq), playerId: e.playerId, t: e.t, name, lineageId, text: emote ? "" : raw, emote, cross, family: surnameOf(name) });
  }
  return out.reverse();
}

// ================================================================== name labels

/** "Ember Thorndale" -> "Ember"; "Aurora II Dawn" -> "Aurora II"; "Unnamed Valley" and one-word names stay whole */
export function shortName(name: string): string {
  if (/^unnamed\b/i.test(name.trim())) return name.trim();
  return firstNameOf(name);
}

/** label priority, lower first: the followed person, then recent speakers, then the focus's babies, then everyone else */
export function labelPriority(p: { focus: boolean; speaking: boolean; focusBaby: boolean }): number {
  if (p.focus) return 1;
  if (p.speaking) return 4;
  if (p.focusBaby) return 5;
  return 6;
}

export interface PlaceItem {
  key: string;
  /** wanted top-left, screen px */
  x: number;
  y: number;
  w: number;
  h: number;
  /** lower places first (and wins) */
  prio: number;
  /** nudge direction when the spot is taken: 1 down (labels), -1 up (bubbles) */
  dir: 1 | -1;
  /** how many nudges to try (default 2) */
  steps?: number;
  /** hide it when no free spot is found (else it keeps its spot and overlaps) */
  optional?: boolean;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Greedy collision pass. Items are placed by priority; each tries its wanted spot, then up to `steps`
 * nudges of its own height in its direction; required items and those that nudge up (bubbles, pips) also
 * try half a width to either side. An optional item that finds no free spot is hidden (null); a required
 * one (the focus label, its bubble) takes the tried spot it overlaps least. Everything is clamped into the W x H screen with `margin`.
 */
export function placeBoxes(items: readonly PlaceItem[], W: number, H: number, opt: { margin?: number; gapX?: number; gapY?: number } = {}): Map<string, Rect | null> {
  const margin = opt.margin ?? 8;
  const gx = opt.gapX ?? 4;
  const gy = opt.gapY ?? 2;
  const placed: Rect[] = [];
  const out = new Map<string, Rect | null>();
  const overlap = (r: Rect) => {
    let sum = 0;
    for (const q of placed) {
      const w = Math.min(r.x + r.w + gx, q.x + q.w + gx) - Math.max(r.x, q.x);
      const h = Math.min(r.y + r.h + gy, q.y + q.h + gy) - Math.max(r.y, q.y);
      if (w > 0 && h > 0) sum += w * h;
    }
    return sum;
  };
  const clamp = (x: number, y: number, w: number, h: number): Rect => ({ x: Math.max(margin, Math.min(W - w - margin, x)), y: Math.max(margin, Math.min(H - h - margin, y)), w, h });
  const order = items.map((it, i) => ({ it, i })).sort((a, b) => a.it.prio - b.it.prio || a.i - b.i);
  for (const { it } of order) {
    const tries: Rect[] = [clamp(it.x, it.y, it.w, it.h)];
    const steps = it.steps ?? 2;
    for (let k = 1; k <= steps; k++) tries.push(clamp(it.x, it.y + it.dir * k * (it.h + gy + 2), it.w, it.h));
    if (!it.optional || it.dir === -1) for (const dx of [-0.55, 0.55]) for (let k = 0; k <= Math.min(1, steps); k++) tries.push(clamp(it.x + dx * it.w, it.y + it.dir * k * (it.h + gy + 2), it.w, it.h));
    let found: Rect | null = null;
    let best: Rect = tries[0];
    let least = Infinity;
    for (const r of tries) {
      const o = overlap(r);
      if (o === 0) {
        found = r;
        break;
      }
      if (o < least) {
        least = o;
        best = r;
      }
    }
    if (!found && !it.optional) found = best;
    if (found) placed.push(found);
    out.set(it.key, found);
  }
  return out;
}
