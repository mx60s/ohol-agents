// Pure logic for the stream overlay (no DOM, no React): trait tags, motion
// interpolation, camera smoothing, crowd fan-out, held-object lookup, ticker
// selection. Tested in tests/stream.test.mjs.

import type { RunEvent, Traits } from "../api-types.ts";
import { deathReasonText, displayName } from "../shared/format.ts";

// ================================================================== trait tags

/** [positive pole, negative pole] short words per known dimension */
const TAG_WORDS: Record<string, [string, string]> = {
  openness: ["curious", "traditional"],
  conscientiousness: ["careful", "carefree"],
  extraversion: ["chatty", "quiet"],
  agreeableness: ["agreeable", "stubborn"],
  neuroticism: ["anxious", "steady"],
};

function tagWord(dim: string, v: number): string {
  const w = TAG_WORDS[dim.toLowerCase()];
  if (w) return v >= 0 ? w[0] : w[1];
  const name = dim.replace(/[_-]+/g, " ").toLowerCase();
  return v >= 0 ? `high ${name}` : `low ${name}`;
}

/**
 * 2-4 short chips from the most extreme traits: |z| >= 1.5 "very X", >= 0.5 "X",
 * else "a bit X" (only used to reach the minimum of 2). Empty for no traits.
 *   {agreeableness: 1.8, neuroticism: -0.9, ...} -> ["very agreeable", "steady", ...]
 */
export function traitTags(traits: Traits | null | undefined, dims: readonly string[], max = 4, min = 2): string[] {
  if (!traits) return [];
  const keys = dims.length ? dims : Object.keys(traits);
  const ranked = keys
    .map((d) => ({ d, v: traits[d] }))
    .filter((x): x is { d: string; v: number } => typeof x.v === "number" && Number.isFinite(x.v))
    .sort((a, b) => Math.abs(b.v) - Math.abs(a.v) || a.d.localeCompare(b.d));
  const out: string[] = [];
  for (const { d, v } of ranked) {
    const a = Math.abs(v);
    if (out.length >= max) break;
    if (a < 0.5 && out.length >= min) break;
    const word = tagWord(d, v);
    out.push(a >= 1.5 ? `very ${word}` : a >= 0.5 ? word : `a bit ${word}`);
  }
  return out;
}

// ================================================================== motion (smooth walking between polls)

export interface Motion {
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  /** ms (any monotonic clock) */
  t0: number;
  dur: number;
  facingLeft: boolean;
}

/** tiles per second used to replay a step between two polls */
export const WALK_TILES_PER_S = 3.2;
/** jumps longer than this (respawn, teleport, first sighting) snap instead of walking */
export const SNAP_TILES = 14;
/** a walk never takes longer than this, so the figure keeps up with the 2 s polls */
export const MAX_WALK_MS = 2600;

export function sampleMotion(m: Motion, now: number): { x: number; y: number } {
  if (m.dur <= 0 || now >= m.t0 + m.dur) return { x: m.toX, y: m.toY };
  if (now <= m.t0) return { x: m.fromX, y: m.fromY };
  const k = (now - m.t0) / m.dur;
  // ease in/out a little so starts and stops don't jerk
  const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
  const s = 0.35 * e + 0.65 * k;
  return { x: m.fromX + (m.toX - m.fromX) * s, y: m.fromY + (m.toY - m.fromY) * s };
}

/** New motion toward (x, y), starting from wherever `prev` currently is. */
export function retarget(prev: Motion | undefined, x: number, y: number, now: number): Motion {
  if (!prev) return { fromX: x, fromY: y, toX: x, toY: y, t0: now, dur: 0, facingLeft: false };
  if (prev.toX === x && prev.toY === y) return prev;
  const cur = sampleMotion(prev, now);
  const dist = Math.hypot(x - cur.x, y - cur.y);
  const facingLeft = x < prev.toX ? true : x > prev.toX ? false : prev.facingLeft;
  if (dist > SNAP_TILES) return { fromX: x, fromY: y, toX: x, toY: y, t0: now, dur: 0, facingLeft };
  const dur = Math.min(MAX_WALK_MS, (dist / WALK_TILES_PER_S) * 1000);
  return { fromX: cur.x, fromY: cur.y, toX: x, toY: y, t0: now, dur, facingLeft };
}

// ================================================================== camera

export interface Cam {
  x: number;
  y: number;
}

/**
 * Critically-damped-ish follow: move `cam` toward `target` with time constant `tauMs`.
 * Frame-rate independent. Snaps when within `eps` tiles.
 */
export function cameraStep(cam: Cam, target: Cam, dtMs: number, tauMs = 420, eps = 0.002): Cam {
  const k = 1 - Math.exp(-Math.max(0, dtMs) / tauMs);
  const x = cam.x + (target.x - cam.x) * k;
  const y = cam.y + (target.y - cam.y) * k;
  return Math.abs(target.x - x) < eps && Math.abs(target.y - y) < eps ? { ...target } : { x, y };
}

/** How the camera should get to a new focus: a pan if close, a crossfade if far. */
export function focusTransition(from: Cam | null, to: Cam, panMaxTiles = 12): "snap" | "pan" | "fade" {
  if (!from) return "snap";
  const d = Math.hypot(to.x - from.x, to.y - from.y);
  return d <= 0.01 ? "snap" : d <= panMaxTiles ? "pan" : "fade";
}

// ================================================================== crowding

/**
 * Screen-only x offsets (in tiles) for people sharing a tile, so they don't draw
 * on top of each other: 2 -> -0.3/+0.3, 3 -> -0.45/0/+0.45. Stable order by id.
 */
export function fanOut(people: readonly { id: number; x: number; y: number }[], spread = 0.45): Map<number, number> {
  const groups = new Map<string, number[]>();
  for (const p of people) {
    const k = `${p.x},${p.y}`;
    const g = groups.get(k);
    if (g) g.push(p.id);
    else groups.set(k, [p.id]);
  }
  const out = new Map<number, number>();
  for (const ids of groups.values()) {
    ids.sort((a, b) => a - b);
    const n = ids.length;
    const step = n > 1 ? Math.min(spread, (spread * 2) / (n - 1)) : 0;
    ids.forEach((id, i) => out.set(id, n > 1 ? (i - (n - 1) / 2) * step : 0));
  }
  return out;
}

// ================================================================== held objects

/** "baby #9" -> {babyPlayerId: 9}; "baby MAYA DAWOD" -> {babyName}; "Sharp Stone" -> {object}; "nothing"/null -> null */
export type Held = { kind: "baby"; playerId: number | null; name: string | null } | { kind: "object"; name: string };

export function parseHeld(held: string | null | undefined): Held | null {
  const s = (held ?? "").trim();
  if (!s || /^(nothing|none|empty)$/i.test(s)) return null;
  const m = /^baby\b\s*(?:#\s*(\d+)|(.*))$/i.exec(s);
  if (m) return { kind: "baby", playerId: m[1] ? Number(m[1]) : null, name: m[2]?.trim() || null };
  return { kind: "object", name: s };
}

/** Lower-cased display name -> smallest object id, for mapping `held` strings to sprites. */
export function objectIdsByName(names: Record<number, string>): Map<string, number> {
  const out = new Map<string, number>();
  for (const [k, v] of Object.entries(names)) {
    const id = Number(k);
    const key = v.trim().toLowerCase();
    const prev = out.get(key);
    if (prev === undefined || id < prev) out.set(key, id);
  }
  return out;
}

// ================================================================== small display helpers

const BIOMES: Record<number, string> = {
  0: "Grassland",
  1: "Swamp",
  2: "Yellow prairie",
  3: "Badlands",
  4: "Snowy tundra",
  5: "Desert",
  6: "Jungle",
};
export function biomeName(b: number | null | undefined): string {
  return b != null && BIOMES[b] ? BIOMES[b] : "Unexplored";
}

/** heat 0..1 (0.5 ideal) -> label */
export function warmthLabel(heat: number | null | undefined): string {
  if (heat == null || !Number.isFinite(heat)) return "?";
  if (heat < 0.2) return "freezing";
  if (heat < 0.35) return "cold";
  if (heat > 0.8) return "very hot";
  if (heat > 0.65) return "hot";
  return "ok";
}

/** Run time for the stat tile: [big, small]: 41:12 -> ["41", ":12"]; 5 h 41 -> ["5", "h 41"]; 3 d 4 h -> ["3", "d 4 h"] */
export function runTimeParts(ms: number | null | undefined): [string, string] {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return ["0", ":00"];
  const s = Math.floor(ms / 1000);
  if (s < 3600) return [String(Math.floor(s / 60)), `:${String(s % 60).padStart(2, "0")}`];
  const h = Math.floor(s / 3600);
  if (h < 48) return [String(h), `h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}`];
  return [String(Math.floor(h / 24)), `d ${h % 24} h`];
}

/** Compact "ago": "now", "8 s", "4 min", "2 h", "3 d". */
export function shortAgo(t: number | null | undefined, now: number): string {
  if (t == null || !Number.isFinite(t) || t <= 0) return "";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 3) return "now";
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h`;
  return `${Math.floor(s / 86400)} d`;
}

// ================================================================== ticker ("ALSO")

export interface TickerItem {
  key: string;
  text: string;
  kind: "birth" | "death" | "naming" | "craft";
}

const NAMING_RE = /^\s*(YOU ARE|I AM|YOUR NAME IS|MY NAME IS)\s+([A-Z][A-Z'-]*(?:\s+[A-Z][A-Z'-]*)?)\s*[.!]?\s*$/i;
/** "use: tile (-11,-118) Sapling -> Cut Sapling Skewer" or "holding Sharp Stone -> Sharp Stone Tool" */
const CRAFT_RE = /(?:tile \([^)]*\)|holding)\s+([^;>]+?)\s+->\s+([^;]+)/i;
const BORING_RESULTS = /^(nothing|empty)$/i;

export interface TickerContext {
  /** agentId -> current in-game name */
  agentNames?: Record<string, string | null | undefined>;
  /** in-game player id -> name (for mothers and babies) */
  playerName?: (playerId: number) => string | null | undefined;
  /** upper-case first names of known characters; "YOU ARE X" only counts as a naming if X is one */
  knownFirstNames?: ReadonlySet<string>;
}

function who(e: RunEvent, ctx: TickerContext): string {
  const n = e.name ?? (e.agentId ? ctx.agentNames?.[e.agentId] : null) ?? (e.playerId != null ? ctx.playerName?.(e.playerId) : null);
  return displayName(n, "Someone");
}

/** One event -> a ticker line, or null if not notable. */
export function tickerItem(e: RunEvent, ctx: TickerContext = {}): TickerItem | null {
  const key = `${e.seq}`;
  const d = (e.data ?? {}) as Record<string, unknown>;
  if (e.kind === "birth") {
    if (d.eve === true) return { key, kind: "birth", text: "A new Eve has appeared in the wild" };
    const mom = typeof d.motherId === "number" ? ctx.playerName?.(d.motherId) : null;
    return { key, kind: "birth", text: mom ? `${displayName(mom)} has had a baby` : "A baby has been born" };
  }
  if (e.kind === "death") {
    const age = typeof d.age === "number" && Number.isFinite(d.age) ? `, ${Math.floor(d.age)},` : "";
    const reason = typeof d.reason === "string" ? deathReasonText(d.reason) : "died";
    return { key, kind: "death", text: `${who(e, ctx)}${age} ${reason === "died" ? "has died" : reason === "old age" ? "died of old age" : reason}` };
  }
  if (e.kind === "say") {
    const m = NAMING_RE.exec(e.text);
    if (!m) return null;
    const words = m[2].trim().toUpperCase().split(/\s+/);
    const name = displayName(m[2]);
    const self = /^(I AM|MY NAME IS)$/i.test(m[1]);
    if (self) {
      // Eves name themselves (and so their family): "I AM EVE DAWOD"
      if (words.length < 2 || words[0] !== "EVE") return null;
      return { key, kind: "naming", text: `${name} has founded the ${displayName(words[1])} family` };
    }
    if (ctx.knownFirstNames && !ctx.knownFirstNames.has(words[0])) return null;
    return { key, kind: "naming", text: `${who(e, ctx)} has named a baby ${displayName(words[0])}` };
  }
  if (e.kind === "craft") {
    return { key, kind: "craft", text: `${who(e, ctx)} ${e.text}` };
  }
  if (e.kind === "action") {
    if (!/^(use|craft|combine)\b/i.test(e.text)) return null;
    const m = CRAFT_RE.exec(e.text);
    if (!m) return null;
    const from = m[1].trim();
    const to = m[2].trim();
    if (BORING_RESULTS.test(to) || BORING_RESULTS.test(from) || from.toLowerCase() === to.toLowerCase()) return null;
    return { key, kind: "craft", text: `${who(e, ctx)} turned ${from.toLowerCase()} into ${to.toLowerCase()}` };
  }
  return null;
}

/**
 * The ALSO ticker: newest notable events first, at most `max`, at most `maxCrafts`
 * crafts (they are frequent), identical lines deduped. Considers only the last
 * `window` events so the work per render stays bounded.
 */
export function selectTicker(events: readonly RunEvent[], ctx: TickerContext = {}, opts: { max?: number; maxCrafts?: number; window?: number } = {}): TickerItem[] {
  const max = opts.max ?? 7;
  const maxCrafts = opts.maxCrafts ?? 3;
  const win = opts.window ?? 400;
  const out: TickerItem[] = [];
  const seen = new Set<string>();
  let crafts = 0;
  for (let i = events.length - 1; i >= Math.max(0, events.length - win) && out.length < max; i--) {
    const it = tickerItem(events[i], ctx);
    if (!it || seen.has(it.text)) continue;
    if (it.kind === "craft") {
      if (crafts >= maxCrafts) continue;
      crafts++;
    }
    seen.add(it.text);
    out.push(it);
  }
  return out;
}

/** The newest `n` narration events, newest first. */
export function latestNarrations(events: readonly RunEvent[], n = 2): RunEvent[] {
  const out: RunEvent[] = [];
  for (let i = events.length - 1; i >= 0 && out.length < n; i--) if (events[i].kind === "narration" && events[i].text.trim()) out.push(events[i]);
  return out;
}

/** An agent's own events of `kind` since `sinceT`, newest first, at most n. */
export function recentOf(events: readonly RunEvent[], agentId: string | null | undefined, kind: RunEvent["kind"], sinceT: number, n: number): RunEvent[] {
  const out: RunEvent[] = [];
  if (!agentId) return out;
  for (let i = events.length - 1; i >= 0 && out.length < n; i--) {
    const e = events[i];
    if (e.t < sinceT) break;
    if (e.kind === kind && e.agentId === agentId) out.push(e);
  }
  return out;
}
