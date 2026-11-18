// Pure logic for the stream overlay (no DOM, no React): trait tags, motion
// interpolation, camera smoothing, crowd fan-out, held-object lookup, ticker
// selection. Tested in tests/stream.test.mjs.

import type { RunEvent, Traits } from "../api-types.ts";
import { NAME_NUMERAL, cleanText, deathReasonText, displayName, truncate } from "../shared/format.ts";

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
/**
 * jumps longer than this (respawn, a new life, first sighting) snap instead of walking. With the turn
 * clock a figure can cover 15-40 tiles between two polls (a long walk over several act windows), which
 * used to snap and look like a warp; those now walk, faster (see MAX_WALK_MS).
 */
export const SNAP_TILES = 60;
/** a walk never takes longer than this, so the figure keeps up with the 2 s polls (long ones walk faster) */
export const MAX_WALK_MS = 3500;

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
  // a 200-character name would fill the whole crawl
  return truncate(displayName(n, "Someone"), 32);
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
    // "YOU ARE AURORA II": a repeated first name in the family keeps its numeral
    const first = words[1] && NAME_NUMERAL.test(words[1]) ? `${words[0]} ${words[1]}` : words[0];
    return { key, kind: "naming", text: `${who(e, ctx)} has named a baby ${displayName(first)}` };
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
    const raw = tickerItem(events[i], ctx);
    // the ticker is one line of mixed names and model text: no bidi overrides or invisible marks
    const it = raw && { ...raw, text: cleanText(raw.text) };
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

// ================================================================== headline numbers

export interface HeadlineNumbers {
  alive: number;
  births: number;
  deaths: number;
  /** deepest generation reached this run */
  generation: number;
}

/**
 * Headline tiles. Births, deaths and the deepest generation come from the run's life
 * records (one per life, the same source as the website), so the stream and the site
 * agree; the server's running counters count every birth/death *event* (re-sent events
 * included) and its maxGeneration is only the deepest among the living. Falls back to the
 * counters until the lives have loaded. `alive` is always the live count.
 */
export function headlineNumbers(
  stats: { alive: number; totalBirths: number; totalDeaths: number; maxGeneration: number } | null | undefined,
  lives: readonly { runId: string; status: string; generation: number }[],
  runId: string | null | undefined,
): HeadlineNumbers {
  const alive = stats?.alive ?? 0;
  const run = runId ? lives.filter((l) => l.runId === runId) : [];
  if (!run.length) return { alive, births: stats?.totalBirths ?? 0, deaths: stats?.totalDeaths ?? 0, generation: stats?.maxGeneration ?? 0 };
  let deaths = 0;
  let generation = 0;
  for (const l of run) {
    if (l.status === "dead") deaths++;
    if (Number.isFinite(l.generation) && l.generation > generation) generation = l.generation;
  }
  return { alive, births: run.length, deaths, generation: Math.max(generation, stats?.maxGeneration ?? 0) };
}

// ------------------------------------------------------------------ occlusion (trees in front of the focus)

/** screen box, canvas px (y down) */
export interface ScreenBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** an object in front of the focused character that hides part of them is drawn at this alpha */
export const OCCLUDER_ALPHA = 0.35;
/**
 * ...when it covers at least this share of the character's box: a bush grazing a heel or the tip
 * of a branch crossing a shoulder stays solid; a canopy over the body fades.
 */
export const OCCLUDE_MIN_SHARE = 0.12;

/** share of `target`'s area covered by `box` (0..1) */
export function coverShare(box: ScreenBox, target: ScreenBox): number {
  const w = Math.min(box.x1, target.x1) - Math.max(box.x0, target.x0);
  const h = Math.min(box.y1, target.y1) - Math.max(box.y0, target.y0);
  const area = (target.x1 - target.x0) * (target.y1 - target.y0);
  return w > 0 && h > 0 && area > 0 ? (w * h) / area : 0;
}

/**
 * Alpha to draw an object with: OCCLUDER_ALPHA if it is drawn after the focused character (in
 * front of them) and covers enough of their on-screen box, else 1 (normal drawing).
 */
export function occluderAlpha(obj: ScreenBox | null, focus: ScreenBox | null, drawnAfterFocus: boolean): number {
  if (!drawnAfterFocus || !obj || !focus) return 1;
  return coverShare(obj, focus) >= OCCLUDE_MIN_SHARE ? OCCLUDER_ALPHA : 1;
}

// ================================================================== what they did (stream "Doing" line)

const ACTION_SKIP = /^(go|walk|pick_up_baby|jump|wait|say|undress)\b/;
const an = (s: string) => (/^[AEIOU]/i.test(s) ? `an ${s}` : `a ${s}`);
const clean = (s: string) => s.replace(/\s*\(\d+\/\d+ left\)/g, "").replace(/#\S+/g, "").trim();

/**
 * One plain sentence for a hands-on action event ("use (3, 4) -> use: tile (3,4) Big Hard Rock ->
 * Big Hard Rock; holding Stone -> Sharp Stone" -> "made a Sharp Stone on the Big Hard Rock"), or null
 * for walking, speaking, babies, waiting. Failures read "tried to …: nothing happened".
 */
export function describeAction(text: string): string | null {
  const t = text.replace(/^reflex /, "");
  if (ACTION_SKIP.test(t)) return null;
  const verb = t.split(/[\s(]/)[0];
  const res = (t.split(" -> ").slice(1).join(" -> ") || "").replace(/\s*\(your path[^)]*\)\s*$/, "").trim();
  if (!res) return null;
  const m = /tile \(-?\d+,\s*-?\d+\) (.+?) -> (.+?); holding (.+?) -> (.+?)$/.exec(res);
  if (m) {
    const [a, b, c, d] = [m[1], m[2], m[3], m[4]].map(clean);
    if (verb === "drop") {
      if (a === "nothing") return `put down ${an(c)}`;
      if (d === a) return `swapped ${an(c)} for the ${a}`;
      return `put ${an(c)} into the ${a}`;
    }
    if (c === "nothing" && d !== "nothing") return a !== b ? `picked ${an(d)} from the ${a}` : `picked up ${an(d)}`;
    if (a !== b && b !== "nothing") return `used ${an(c === "nothing" ? "bare hand" : c)} on the ${a}: it became ${an(b)}${d !== c && d !== "nothing" ? `, now holding ${an(d)}` : ""}`;
    if (d !== c && d !== "nothing") return `made ${an(d)} on the ${a}`;
    if (a !== "nothing" && b === "nothing" && d !== "nothing") return `picked up ${an(d)}`;
    return `used ${an(c)} on the ${a}`;
  }
  const ate = /ate (?:an? )?([A-Z][A-Za-z' -]+?);/.exec(res);
  if (ate) return `ate ${an(clean(ate[1]))}`;
  const put = /you put on the (.+?) \(/.exec(res);
  if (put) return `put on the ${clean(put[1])}`;
  const picked = /you picked an? (.+?) and are holding it/.exec(res);
  if (picked) return `picked ${an(clean(picked[1]))} to carry`;
  const sw = /^swapped at .*?: you put down the (.+?) and picked up the (.+?) that/.exec(res);
  if (sw) return `swapped ${an(sw[1])} for the ${sw[2]}`;
  if (/nothing happened|can't|couldn't|not holding|you're full|no food|too young|blocks/.test(res)) {
    const what = { use: "use something", drop: "put something down", feed: "feed someone", forage: "find food", eat: "eat", take_out: "take something out", swap: "swap" }[verb] ?? verb;
    return `tried to ${what}: ${clean(res.replace(/^[a-z_ ]+(at \(-?\d+,\s*-?\d+\))?:\s*/, "")).slice(0, 70)}`;
  }
  return clean(res).slice(0, 90);
}
