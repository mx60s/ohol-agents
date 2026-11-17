// Sanitizing for text that ends up on the public stream page, and for
// agent-sourced text that goes into prompts (in-game speech, goals, thoughts).

// C0/C1 control chars, zero-width and bidi-override/isolate chars, BOM, soft
// hyphen, Arabic letter mark, Mongolian vowel separator, Hangul fillers
// (invisible "names"), interlinear annotation chars, and Unicode tag chars
// (U+E0000-E007F, used to smuggle invisible instructions into prompts).
// \n and \t are handled separately (collapsed to spaces by cleanText).
const CONTROL =
  /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u00AD\u061C\u115F\u1160\u180E\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFEFF\uFFA0\uFFF9-\uFFFB\u{E0000}-\u{E007F}]/gu;
// lone surrogates (invalid UTF-16; some JSON consumers choke on them)
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Remove invisible/control chars (keeps \n and \t). */
export function stripControl(s: string): string {
  return s.replace(CONTROL, "").replace(LONE_SURROGATE, "");
}

/**
 * Bounded, control-char-free copy of event data: strings capped at maxStr,
 * arrays at 50 items, objects at 40 keys, nesting at depth 4. Non-JSON values
 * (functions, NaN, Infinity) become null.
 */
export function sanitizeData(v: unknown, maxStr = 500, depth = 0): unknown {
  if (typeof v === "string") return cleanText(v, maxStr);
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "boolean" || v == null) return v ?? null;
  if (depth >= 4) return null;
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => sanitizeData(x, maxStr, depth + 1));
  if (typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>).slice(0, 40)) out[cleanText(k, 40)] = sanitizeData(x, maxStr, depth + 1);
    return out;
  }
  return null;
}

/** Strip control/invisible chars, collapse whitespace, cap length (adds "…" when cut). */
export function cleanText(s: unknown, max: number): string {
  if (typeof s !== "string") return "";
  let t = stripControl(s).replace(/\s+/g, " ").trim();
  if (t.length > max) t = t.slice(0, Math.max(0, max - 1)).replace(/[\uD800-\uDBFF]$/, "").trimEnd() + "…";
  return t;
}

/**
 * Viewer-facing one-liner from a model (e.g. the director's reason): cleanText
 * plus no links, mentions, markup or wrapping quotes.
 */
export function cleanPhrase(s: unknown, max: number): string {
  if (typeof s !== "string") return "";
  const t = stripControl(s)
    .replace(/<[^>]*>/g, " ")
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, "")
    .replace(/\b\S+\.(?:com|net|org|io|gg|tv|xyz|ly|me|co)\b\S*/gi, "")
    .replace(/@\w+/g, "")
    .replace(/[<>`*_#[\]{}|\\]/g, "");
  return cleanText(t, max).replace(/^["'\s]+|["'\s]+$/g, "");
}

/** Multi-sentence model prose for the stream (narration, story). Keeps it plain. */
export function cleanProse(s: unknown, max: number): string {
  if (typeof s !== "string") return "";
  const t = stripControl(s)
    .replace(/<[^>]*>/g, " ")
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, "")
    .replace(/[<>`*#[\]{}|\\]/g, "")
    .replace(/^["']|["']$/g, "");
  return cleanText(t, max);
}

/** Cap at n words (keeps it under the limit even if the model ran long). */
export function capWords(s: string, n: number): string {
  const words = s.split(/\s+/).filter(Boolean);
  if (words.length <= n) return s;
  return words.slice(0, n).join(" ").replace(/[,;:]$/, "") + "…";
}

/**
 * Agent-sourced text as a quoted, truncated, escaped data literal for prompts.
 * JSON.stringify keeps quotes/newlines inside from breaking out of the string.
 */
export function quoteData(s: unknown, max: number): string {
  if (s == null || s === "") return "none";
  return JSON.stringify(cleanText(String(s), max));
}

/**
 * Strict JSON-object parse of a model reply. Allows surrounding whitespace and
 * a ``` code fence, nothing else. Returns null if it isn't exactly one object.
 */
export function parseJsonObjectStrict(text: unknown): Record<string, unknown> | null {
  if (typeof text !== "string") return null;
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  if (!t.startsWith("{") || !t.endsWith("}")) return null;
  try {
    const v = JSON.parse(t);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
