// Parsing and checking the model's reply. Every way a turn can be wasted
// gets a plain explanation that goes into the next observation, so the model
// learns what went wrong. We never guess what a malformed action meant:
// only spelling variants and a fixed list of aliases are accepted.

import { cleanText } from "../safety.ts";

export interface Action {
  type: string;
  x?: number;
  y?: number;
  person?: number;
  text?: string;
  slot?: number;
  seconds?: number;
  turns?: number;
  /** craft: the item to make */
  item?: string;
}

/** Required fields per action type (must match prompt.ts actionList). */
const SPECS: Record<string, { need?: ("xy" | "person" | "item" | "slot")[]; craft?: boolean }> = {
  use: { need: ["xy"] },
  drop: {},
  swap: { need: ["xy"] },
  take_out: { need: ["xy"] },
  eat: {},
  forage: {},
  craft: { need: ["item"], craft: true },
  undress: { need: ["slot"] },
  go: { need: ["xy"] },
  pick_up_baby: { need: ["person"] },
  feed: { need: ["person"] },
  jump: {},
  wait: {},
};

/**
 * Other spellings of the action types. "pick_up" means pick_up_baby when a
 * person is given, else use (picking up a thing is a bare-hand use).
 * Keys are normalised: lowercase, spaces and hyphens as "_".
 */
const ALIASES: Record<string, string> = {
  use_on: "use", interact: "use", apply: "use", grab: "use",
  put_down: "drop", set_down: "drop", place: "drop", put: "drop",
  exchange: "swap", swap_with: "swap",
  takeout: "take_out", take_from: "take_out", remove: "take_out",
  wear: "eat", put_on: "eat", consume: "eat", eat_held: "eat", use_on_self: "eat", dress: "eat",
  gather_food: "forage",
  make: "craft", build: "craft",
  take_off: "undress", remove_clothing: "undress",
  walk: "go", move: "go", walk_to: "go", go_to: "go", goto: "go", move_to: "go",
  pickup_baby: "pick_up_baby", pick_baby: "pick_up_baby", carry: "pick_up_baby", carry_baby: "pick_up_baby", hold_baby: "pick_up_baby", pick_up_person: "pick_up_baby",
  give: "feed", use_on_person: "feed", feed_baby: "feed",
  wiggle: "jump",
  idle: "wait",
};

export function validActionTypes(craft: boolean): string[] {
  return Object.keys(SPECS).filter((k) => craft || !SPECS[k].craft);
}

const FORMAT = `Reply with one JSON object like {"thought":"...","action":{"type":"go","x":3,"y":4}}`;

/**
 * Pull the model's JSON object out of a reply. Forgiving where it's safe:
 * <think>/<reasoning> blocks (which often draft JSON) are dropped first; then
 * every balanced {...} span is a candidate, string-aware, so prose with
 * braces around the JSON doesn't matter. The LAST top-level object with an
 * "action"/"actions" key wins (models draft, then correct themselves), else
 * the last object. Candidates that fail strict JSON get a lenient pass:
 * trailing commas, // comments, single quotes, unquoted keys.
 */
export function parseReply(text: string): { ok: true; value: Record<string, unknown> } | { ok: false; reason: string } {
  const raw = text ?? "";
  if (!raw.trim()) return { ok: false, reason: "your reply was empty" };
  const t = stripReasoning(raw);
  if (!t.trim()) return { ok: false, reason: "your reply had only reasoning and no JSON object (cut off?)" };
  const { objs, openStart } = objectSpans(t);
  // an object that never closed (cut off) contains everything after it: try closing it first
  const closed = openStart >= 0 ? closeTruncated(t.slice(openStart)) : null;
  if (closed && ("action" in closed || "actions" in closed)) return { ok: true, value: closed };
  const top = objs.filter((o) => !o.nested && o.value && (o.start < openStart || openStart < 0 || !closed));
  const withAction = top.filter((o) => "action" in o.value! || "actions" in o.value!);
  const pick = withAction.at(-1) ?? top.at(-1);
  if (pick) return { ok: true, value: pick.value! };
  if (closed) return { ok: true, value: closed };
  if (!objs.length) return { ok: false, reason: t.includes("{") ? "your reply had an unfinished JSON object (cut off?)" : "your reply had no JSON object" };
  return { ok: false, reason: "your reply's JSON was malformed" };
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Drop reasoning: <think>...</think> (also <thinking>, <reasoning>), a dangling "...</think>" prefix, an unclosed trailing <think>. */
export function stripReasoning(s: string): string {
  let t = s.replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi, " ");
  const closers = [...t.matchAll(/<\/(think|thinking|reasoning)>/gi)];
  if (closers.length) {
    const last = closers[closers.length - 1];
    t = t.slice(last.index! + last[0].length);
  }
  const open = t.search(/<(think|thinking|reasoning)>/i);
  if (open >= 0) t = t.slice(0, open);
  return t.replace(/^\s+/, "");
}

function tryJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    const fixed = lenient(s);
    if (fixed === s) return undefined;
    try {
      return JSON.parse(fixed);
    } catch {
      return undefined;
    }
  }
}

/**
 * A reply cut off just before its closing braces ("...\"y\": 130 }\n"):
 * close it, but only when the last value is clearly complete (ends in a
 * brace, bracket, quote, or a number followed by a line break). A number
 * cut mid-way ("-15" of "-154") is never completed.
 */
function closeTruncated(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  const body = text.slice(start).replace(/```\s*$/, "");
  const trimmed = body.trimEnd();
  const complete = /[}\]"]$/.test(trimmed) || (/[\d]$/.test(trimmed) && /\n\s*$/.test(body)) || /\b(true|false|null)$/.test(trimmed);
  if (!complete) return null;
  // count open braces and brackets outside strings
  const stack: string[] = [];
  let inStr = false;
  for (let i = 0; i < trimmed.length; i++) {
    const c = trimmed[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "{" || c === "[") stack.push(c === "{" ? "}" : "]");
    else if (c === "}" || c === "]") stack.pop();
  }
  if (inStr || stack.length < 1 || stack.length > 3) return null;
  const v = tryJson(trimmed + stack.reverse().join(""));
  return isObj(v) ? v : null;
}

/** JSON-ish to JSON: drop trailing commas and // comments, single-quoted strings to double, quote bare keys. */
function lenient(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"') {
      // copy a double-quoted string verbatim
      let j = i + 1;
      while (j < s.length && s[j] !== '"') j += s[j] === "\\" ? 2 : 1;
      out += s.slice(i, j + 1);
      i = j;
      continue;
    }
    if (c === "'") {
      // single-quoted string: ends at a ' followed by , : } ] (so apostrophes inside survive)
      let j = i + 1, str = "";
      while (j < s.length && !(s[j] === "'" && /^\s*[,:}\]]/.test(s.slice(j + 1)))) {
        if (s[j] === "\\" && j + 1 < s.length) {
          str += s[j + 1] === "'" ? "'" : s[j] + s[j + 1];
          j += 2;
          continue;
        }
        str += s[j] === '"' ? '\\"' : s[j];
        j++;
      }
      out += `"${str}"`;
      i = j;
      continue;
    }
    if (c === "/" && s[i + 1] === "/") {
      while (i < s.length && s[i] !== "\n") i++;
      continue;
    }
    if (c === ",") {
      let j = i + 1;
      while (j < s.length && /\s/.test(s[j])) j++;
      if (s[j] === "}" || s[j] === "]") continue;
    }
    // bare key: {type: "go"} / , x: 3
    const m = /^[A-Za-z_][A-Za-z0-9_]*(?=\s*:)/.exec(s.slice(i, i + 40));
    if (m && /[{,]\s*$/.test(out)) {
      out += `"${m[0]}"`;
      i += m[0].length - 1;
      continue;
    }
    out += c;
  }
  return out;
}

/**
 * Every balanced {...} span, string-aware (double quotes). A span that isn't
 * valid JSON(-ish) is skipped and the scan continues inside it, so stray
 * braces in prose don't hide the real object; spans inside a skipped one are
 * marked nested and never chosen as the reply. openStart: where an object
 * that never closed begins (a cut-off reply), else -1.
 */
function objectSpans(s: string): { objs: { value: Record<string, unknown> | null; nested: boolean; start: number }[]; openStart: number } {
  const objs: { value: Record<string, unknown> | null; nested: boolean; start: number }[] = [];
  let openStart = -1;
  let skippedUntil = -1;
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== "{") continue;
    const end = balancedEnd(s, i);
    if (end < 0) {
      if (openStart < 0 && i > skippedUntil) openStart = i;
      continue;
    }
    const nested = i < skippedUntil;
    const v = tryJson(s.slice(i, end + 1));
    objs.push({ value: isObj(v) ? v : null, nested, start: i });
    if (isObj(v)) {
      if (!nested) i = end; // the whole object is consumed
    } else skippedUntil = Math.max(skippedUntil, end);
  }
  return { objs, openStart };
}

/** index of the } closing the { at i, or -1 */
function balancedEnd(s: string, i: number): number {
  let depth = 0, inStr = false;
  for (let k = i; k < s.length; k++) {
    const c = s[k];
    if (inStr) {
      if (c === "\\") k++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return k;
  }
  return -1;
}

/** "Pick Up", "pick-up", " PICK_UP " -> "pick_up" */
function normType(t: string): string {
  return t.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

/** a number, or a numeric string ("12", "#12", " -3 ") */
function num(x: unknown): number | undefined {
  if (typeof x === "number" && Number.isFinite(x)) return x;
  if (typeof x === "string" && /^\s*#?-?\d{1,9}(\.\d+)?\s*$/.test(x)) return Number(x.trim().replace(/^#/, ""));
  return undefined;
}

/** coordinates from x/y, "pos":[x,y], "target":{x,y}, or "x":"(3, -4)" */
function coords(a: Record<string, unknown>): [number, number] | null {
  const x = num(a.x), y = num(a.y);
  if (x !== undefined && y !== undefined) return [x, y];
  for (const k of ["x", "pos", "position", "target", "at", "xy", "coords", "tile"]) {
    const v = a[k];
    if (Array.isArray(v) && v.length === 2 && num(v[0]) !== undefined && num(v[1]) !== undefined) return [num(v[0])!, num(v[1])!];
    if (isObj(v) && num(v.x) !== undefined && num(v.y) !== undefined) return [num(v.x)!, num(v.y)!];
    if (typeof v === "string") {
      const m = /^\s*\(?\s*(-?\d{1,9})\s*,\s*(-?\d{1,9})\s*\)?\s*$/.exec(v);
      if (m) return [Number(m[1]), Number(m[2])];
    }
  }
  return null;
}

/**
 * The model's action reduced to known fields with sane types. The type is
 * normalised (case, spaces, hyphens) and mapped through ALIASES; anything
 * else becomes "invalid" (an arbitrary string here used to flow, unquoted,
 * into action event text and from there into the narrator's prompt and the
 * stream). A bare string is a type with no arguments ("forage").
 */
export function sanitizeAction(v: unknown): Action | null {
  if (typeof v === "string") v = { type: v };
  if (!isObj(v)) return null;
  const a = typeof v.type === "string" ? v : keyedType(v);
  if (!a || typeof a.type !== "string") return null;
  const n = normType(a.type);
  const out: Action = { type: "invalid" };
  const xy = coords(a);
  if (xy) [out.x, out.y] = xy;
  const person = num(a.person) ?? num(a.person_id) ?? num(a.player) ?? num(a.id) ?? num(a.target_id) ?? num(a.baby);
  if (person !== undefined) out.person = person;
  for (const k of ["slot", "seconds", "turns"] as const) {
    const val = num(a[k]);
    if (val !== undefined) out[k] = val;
  }
  if (typeof a.item === "string") {
    // letters, digits, spaces and a little punctuation; object names are short
    const item = cleanText(a.item, 60).replace(/[^A-Za-z0-9 '\-]/g, " ").replace(/\s+/g, " ").trim();
    if (item) out.item = item;
  }
  if (typeof a.text === "string") {
    const text = cleanText(a.text, 200);
    if (text) out.text = text;
  }
  let type = n;
  if (n === "pick_up" || n === "pickup" || n === "take") type = out.person !== undefined && !xy ? "pick_up_baby" : "use";
  else if (ALIASES[n]) type = ALIASES[n];
  if (/^[a-z_]{1,24}$/.test(type) && (SPECS[type] || type === "say")) out.type = type;
  return out;
}

/**
 * {"wait":{"turns":1}}, {"drop":{"x":1,"y":2}}, {"eat":{}}: the type written as
 * the only key, its arguments as the value (Qwen does this). Only when that key
 * is a known type or alias; otherwise null.
 */
function keyedType(v: Record<string, unknown>): Record<string, unknown> | null {
  const keys = Object.keys(v);
  if (keys.length !== 1) return null;
  const k = keys[0], n = normType(k);
  if (!(SPECS[n] || ALIASES[n] || n === "pick_up" || n === "pickup")) return null;
  const val = v[k];
  if (val == null) return { type: k };
  if (isObj(val)) return { ...val, type: k };
  return null;
}

/**
 * Check a parsed reply's action. Returns the action, or a reason the turn
 * did nothing, phrased for the model. Also accepted: a bare string action
 * ("action":"forage"), and the action's fields at the top level of the reply
 * ({"type":"go","x":1,"y":2}).
 */
export function checkAction(reply: Record<string, unknown>, craft: boolean): { action: Action } | { error: string } {
  let raw: unknown = reply.action;
  if (raw == null && typeof reply.type === "string") raw = reply;
  if (raw == null) return { error: `your reply had no "action", so you did nothing. ${FORMAT}` };
  return checkOne(raw, craft, hasSay(reply));
}

/** the reply also has top-level "say" words (then {"type":"say"} without text just means "speaking is my turn") */
function hasSay(reply: Record<string, unknown>): boolean {
  return typeof reply.say === "string" && reply.say.trim().length > 0;
}

/**
 * The reply's steps: one "action", or an "actions" list (also accepted as an
 * array under "action") of up to `max` steps, run in order. Steps past `max`
 * and everything from the first invalid step on are not run; notes say so.
 */
export function checkActions(reply: Record<string, unknown>, craft: boolean, max: number): { steps: Action[]; notes: string[] } | { error: string } {
  // also {"action":{"type":"actions","actions":[...]}}: the list wrapped as one action (Qwen does this)
  // (the list key also comes as "steps" or "items")
  const wrapped = wrappedList(reply.action);
  const listed = Array.isArray(reply.actions) ? reply.actions : Array.isArray(reply.action) ? reply.action : wrapped;
  if (!listed) {
    const c = checkAction(reply, craft);
    return "error" in c ? c : { steps: [c.action], notes: [] };
  }
  if (!listed.length) return { error: `your "actions" list was empty, so you did nothing. ${FORMAT}` };
  const notes: string[] = [];
  let list = listed;
  if (list.length > max) {
    notes.push(max === 1 ? `only one action runs per turn; the other ${list.length - 1} were not done` : `only ${max} steps run per turn; the last ${list.length - max} were not done`);
    list = list.slice(0, max);
  }
  const steps: Action[] = [];
  for (let i = 0; i < list.length; i++) {
    const c = checkOne(list[i], craft, hasSay(reply));
    if ("error" in c) {
      if (i === 0) return { error: list.length > 1 ? `step 1: ${c.error}` : c.error };
      notes.push(`step ${i + 1} and later not done: ${c.error.replace(/; you did nothing$|\. You did nothing$/, "")}`);
      break;
    }
    steps.push(c.action);
  }
  return { steps, notes };
}

/** {"type":"actions","actions"|"steps"|"items":[...]}: an actions list written as one action. */
function wrappedList(a: unknown): unknown[] | null {
  if (!a || typeof a !== "object" || Array.isArray(a)) return null;
  const o = a as Record<string, unknown>;
  if (!/^actions$/i.test(String(o.type ?? "actions"))) return null;
  for (const k of ["actions", "steps", "items"]) if (Array.isArray(o[k])) return o[k] as unknown[];
  return null;
}

function checkOne(raw: unknown, craft: boolean, topSay = false): { action: Action } | { error: string } {
  const types = validActionTypes(craft);
  if (Array.isArray(raw)) return { error: `"action" must be one object like {"type":"go",...}, not a list; you did nothing` };
  const a = sanitizeAction(raw);
  if (!a) return { error: `"action" needs a "type" (one of: ${types.join(", ")}); you did nothing` };
  const given = typeof raw === "string" ? raw : (raw as { type: string }).type;
  if (a.type === "invalid" || (a.type !== "say" && SPECS[a.type].craft && !craft)) {
    const shown = cleanText(given, 24).replace(/[^A-Za-z0-9_ ]/g, "");
    return { error: `unknown action type "${shown}"; valid types: ${types.join(", ")}. You did nothing` };
  }
  if (a.type === "say" && !a.text && !topSay) return { error: `to speak, put the words in "say" (e.g. "say":"HELLO"); you did nothing` };
  for (const need of SPECS[a.type]?.need ?? []) {
    if (need === "xy" && !(Number.isFinite(a.x) && Number.isFinite(a.y))) return { error: `"${a.type}" needs numeric "x" and "y" (copy them from your observation); you did nothing` };
    if (need === "person" && !(Number.isFinite(a.person) && a.person! > 0)) return { error: `"${a.type}" needs "person": the number after # in the people list; you did nothing` };
    if (need === "item" && !a.item) return { error: `"craft" needs "item": the name of the thing to make, e.g. "Sharp Stone"; you did nothing` };
    if (need === "slot" && !(Number.isInteger(a.slot) && a.slot! >= 0 && a.slot! <= 5)) return { error: `"undress" needs "slot" 0-5; you did nothing` };
  }
  return { action: a };
}
