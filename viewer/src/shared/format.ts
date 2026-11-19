// Plain formatting helpers (no React). Pure functions, tested in tests/shared.test.mjs.

/** Game age in whole years: 51.7 -> "51 y", 0.4 -> "0 y", null -> "? y". */
export function formatAge(age: number | null | undefined, opts: { unit?: boolean; decimals?: number } = {}): string {
  const unit = opts.unit === false ? "" : " y";
  if (age == null || !Number.isFinite(age)) return `?${unit}`;
  const a = Math.max(0, age);
  const s = opts.decimals ? a.toFixed(opts.decimals) : String(Math.floor(a));
  return `${s}${unit}`;
}

export type AgeStage = "baby" | "child" | "adult" | "elder";
/** OHOL stages: baby < 3, child < 14, adult < 40, elder (hair greys from 40; death by 60). */
export function ageStage(age: number | null | undefined): AgeStage {
  const a = age ?? 0;
  return a < 3 ? "baby" : a < 14 ? "child" : a < 40 ? "adult" : "elder";
}

/** Relative time: "just now", "4 s ago", "2 min ago", "3 h ago", "2 d ago". Future times read "just now". */
export function formatRelative(t: number | null | undefined, now: number): string {
  if (t == null || !Number.isFinite(t) || t <= 0) return "never";
  // every time shown is in the past; a "future" one is server clock skew or a page clock
  // that ticks coarser than the data arrives, so it reads as "just now", never "in 13 s"
  const s = Math.round(Math.max(0, now - t) / 1000);
  if (s < 3) return "just now";
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400 * 2) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

/** Duration: "41 s", "41 min", "2 h 5 min", "3 d 4 h". */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "?";
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d} d ${h % 24} h` : `${d} d`;
}

/** Wall-clock "14:02" (24 h, viewer's timezone). */
export function formatClock(t: number | null | undefined): string {
  if (t == null || !Number.isFinite(t) || t <= 0) return "--:--";
  return new Date(t).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
}

/** Money: "$3.12", "$0.004", "$0", "$1.2k". */
export function formatMoney(usd: number | null | undefined): string {
  if (usd == null || !Number.isFinite(usd)) return "$?";
  const sign = usd < 0 ? "-" : "";
  const a = Math.abs(usd);
  if (a === 0) return "$0";
  if (a >= 10_000) return `${sign}$${(a / 1000).toFixed(0)}k`;
  if (a >= 1000) return `${sign}$${(a / 1000).toFixed(1)}k`;
  if (a >= 0.995) return `${sign}$${a.toFixed(2)}`;
  if (a >= 0.01) return `${sign}$${a.toFixed(2)}`;
  return `${sign}$${a.toPrecision(1)}`;
}

/** Integer with thousands separators: 1904 -> "1,904". */
export function formatCount(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "?";
  return Math.round(n).toLocaleString("en-US");
}

/** Trait value "+1.32" / "-0.40"; absurd values (bad data) become ">+99" / "<−99" instead of breaking layouts. */
export function formatTrait(v: number | null | undefined, digits = 2): string {
  if (v == null || !Number.isFinite(v)) return "?";
  // traits live in +-2.5; anything this big is bad data, shown short so it never overflows a column
  if (Math.abs(v) >= 100) return v > 0 ? ">+99" : "<−99";
  const s = v.toFixed(digits);
  return v > 0 ? `+${s}` : s;
}

/**
 * Bidi overrides/isolates, invisible zero-width marks and control characters. A name with an
 * unterminated U+202E would flip the rest of the line it sits in (ticker, tables), and
 * zero-width-only names would look blank. U+200D (ZWJ) stays: emoji sequences need it.
 */
// eslint-disable-next-line no-control-regex
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u200b\u200c\u200e\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;

/** Strip bidi controls and invisible characters from model/user text before display. */
export function cleanText(s: string): string {
  return s.replace(INVISIBLE, "");
}

/**
 * A "say" whose whole text is a +WORD+ cue ("+HOMESICK+", "+HOME+") is the game's emote over a
 * character's head (the server's private cue to that player), not speech. Returns the word, or null.
 */
export function cueOfSay(text: string | null | undefined): string | null {
  const m = /^\s*\+([A-Z](?:[A-Z ]*[A-Z])?)\+\s*$/.exec(text ?? "");
  return m ? m[1] : null;
}

/** "homesick", "back home", "free rein": a cue as a muted label */
export function cueLabel(word: string): string {
  if (word === "HOME") return "back home";
  return word.toLowerCase();
}

/** II..X: the numeral of a repeated first name in a family ("AURORA II DAWN"). */
export const NAME_NUMERAL = /^(II|III|IV|V|VI|VII|VIII|IX|X)$/i;

/**
 * Game names arrive upper-case ("EVE DAWN"): -> "Eve Dawn"; a numeral after
 * the first name stays upper-case ("Aurora II Dawn"). Unnamed (or nothing visible) -> fallback.
 */
export function displayName(name: string | null | undefined, fallback = "Unnamed"): string {
  const n = cleanText(name ?? "").trim();
  if (!n) return fallback;
  const titled = n.toLowerCase().replace(/(^|[\s\-'])(\p{L})/gu, (_m, pre: string, ch: string) => pre + ch.toUpperCase());
  return titled.split(" ").map((w, i) => (i > 0 && NAME_NUMERAL.test(w) ? w.toUpperCase() : w)).join(" ");
}

/** First name with its numeral, from a display name: "Aurora II Dawn" -> "Aurora II", "Joy Hope" -> "Joy". */
export function firstNameOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return name;
  return parts[1] && NAME_NUMERAL.test(parts[1]) ? `${parts[0]} ${parts[1]}` : parts[0];
}

/** Family surname of a name: the last word, ignoring a numeral ("Aurora II Dawn" -> "Dawn"); null for a lone first name. */
export function surnameOf(name: string | null | undefined): string | null {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2 || NAME_NUMERAL.test(parts[parts.length - 1])) return null;
  return parts[parts.length - 1];
}

/**
 * Display copies of lives where an unnamed person shows their family name: "UNNAMED VALLEY".
 * The game leaves babies nameless until someone names them (or the server does at age 8);
 * the family is known from the lineage, so show it. Records are not changed; named lives and
 * lives of a family nobody has named yet are returned as they are.
 */
export function withFamilyNames<T extends { name: string | null; lineageId: string; bornAt: number }>(lives: readonly T[]): T[] {
  const surname = new Map<string, string>();
  for (const l of [...lives].sort((a, b) => a.bornAt - b.bornAt)) {
    if (surname.has(l.lineageId)) continue;
    const s = surnameOf(l.name);
    if (s) surname.set(l.lineageId, s);
  }
  let changed = false;
  const out = lives.map((l) => {
    const fam = surname.get(l.lineageId);
    if (!fam) return l;
    if (!l.name) {
      changed = true;
      return { ...l, name: `UNNAMED ${fam}` };
    }
    // named before the family had a name ("LUNA", "AURORA II"): show the family surname too
    const words = l.name.trim().split(/\s+/);
    if (words.length === 1 || (words.length === 2 && NAME_NUMERAL.test(words[1]))) {
      changed = true;
      return { ...l, name: `${l.name.trim()} ${fam}` };
    }
    return l;
  });
  return changed ? out : (lives as T[]);
}

/** Truncate to n characters (by code point, so emoji are not split), adding an ellipsis. */
export function truncate(s: string, n: number): string {
  const cps = Array.from(s);
  return cps.length > n ? `${cps.slice(0, Math.max(0, n - 1)).join("")}…` : s;
}

/** Server death reason -> short phrase: "hunger" -> "starved", "age" -> "old age", "killed_123" -> "killed". */
export function deathReasonText(reason: string | null | undefined): string {
  if (!reason) return "died";
  const r = reason.replace(/^reason_/, "");
  if (r === "hunger" || r === "starvation") return "starved";
  if (r === "age" || r === "old_age") return "old age";
  if (r.startsWith("killed")) return "killed";
  if (r === "cold" || r === "froze") return "froze";
  if (r === "heat") return "overheated";
  if (r === "disconnect" || r === "disconnected") return "left the world";
  if (r === "SID" || r === "suicide") return "gave up";
  return r.replace(/_/g, " ");
}
