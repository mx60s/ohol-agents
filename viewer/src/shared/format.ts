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

/** Relative time: "just now", "4 s ago", "2 min ago", "3 h ago", "2 d ago" (or "in 5 min" for the future). */
export function formatRelative(t: number | null | undefined, now: number): string {
  if (t == null || !Number.isFinite(t) || t <= 0) return "never";
  const d = now - t;
  const ab = Math.abs(d);
  const s = Math.round(ab / 1000);
  let txt: string;
  if (s < 3) return "just now";
  if (s < 60) txt = `${s} s`;
  else if (s < 3600) txt = `${Math.floor(s / 60)} min`;
  else if (s < 86400 * 2) txt = `${Math.floor(s / 3600)} h`;
  else txt = `${Math.floor(s / 86400)} d`;
  return d >= 0 ? `${txt} ago` : `in ${txt}`;
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

/** Trait value "+1.32" / "-0.40"; absurd values become "+9.9e+8" instead of breaking layouts. */
export function formatTrait(v: number | null | undefined, digits = 2): string {
  if (v == null || !Number.isFinite(v)) return "?";
  const s = Math.abs(v) >= 1000 ? v.toExponential(1) : v.toFixed(digits);
  return v > 0 ? `+${s}` : s;
}

/** Game names arrive upper-case ("EVE DAWN"): -> "Eve Dawn". Unnamed -> fallback. */
export function displayName(name: string | null | undefined, fallback = "Unnamed"): string {
  const n = (name ?? "").trim();
  if (!n) return fallback;
  return n.toLowerCase().replace(/(^|[\s\-'])(\p{L})/gu, (_m, pre: string, ch: string) => pre + ch.toUpperCase());
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
