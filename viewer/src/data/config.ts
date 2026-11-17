// Where the site's data comes from. Resolved once per page load.
//
//   ?fixture=<name>          serve viewer/fixtures/<name>/*.json (no API calls at all)
//   ?api=<url>               live agents service at <url>
//   VITE_API_URL=<url>       build-time default (same as the dashboard's api.ts)
//   VITE_API_URL=same-origin the site is served by the agents service itself
//   VITE_API_URL=fixture:<name>  build-time fixture default
// Fallback: http://localhost:8787.
//
// "replay" / "mock" values (dashboard-only modes) are ignored here and fall back to localhost.

export type DataMode = { kind: "http"; base: string } | { kind: "fixture"; name: string };

export function resolveDataMode(search: string, envUrl: string | undefined): DataMode {
  const q = new URLSearchParams(search);
  const fixture = q.get("fixture")?.trim();
  if (fixture) return { kind: "fixture", name: fixture };
  const raw = (q.get("api") ?? envUrl ?? "").trim();
  if (raw.startsWith("fixture:")) return { kind: "fixture", name: raw.slice("fixture:".length) };
  if (raw === "same-origin") return { kind: "http", base: "" };
  if (/^https?:\/\//i.test(raw)) return { kind: "http", base: raw.replace(/\/+$/, "") };
  return { kind: "http", base: "http://localhost:8787" };
}

const search = typeof window !== "undefined" ? window.location.search : "";
const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;

export const dataMode: DataMode = resolveDataMode(search, env?.VITE_API_URL);

/** Query params that select the data source; carried over on every internal link. */
const CARRY = ["fixture", "api"] as const;

export type SitePage = "home" | "stream" | "agent" | "study" | "replay" | "people" | "families" | "about" | "agents";
const FILES: Record<SitePage, string> = {
  home: "index.html",
  stream: "stream.html",
  agent: "agent.html",
  study: "study.html",
  replay: "replay.html",
  people: "people.html",
  families: "families.html",
  about: "about.html",
  agents: "agents.html",
};

/**
 * Relative link to another page of the static site, keeping ?fixture= / ?api=.
 *   pageHref("agent", { life: lifeId })  ->  "agent.html?fixture=live1&life=..."
 *   pageHref("home", {}, "families")      ->  "index.html#families"
 */
export function pageHref(page: SitePage, params: Record<string, string | number | null | undefined> = {}, hash?: string): string {
  const cur = new URLSearchParams(search);
  const out = new URLSearchParams();
  for (const k of CARRY) {
    const v = cur.get(k);
    if (v) out.set(k, v);
  }
  for (const [k, v] of Object.entries(params)) if (v != null && v !== "") out.set(k, String(v));
  const qs = out.toString();
  return `${FILES[page]}${qs ? `?${qs}` : ""}${hash ? `#${hash}` : ""}`;
}

/** Read a query param of the current page (e.g. "life" on agent.html). */
export function queryParam(name: string): string | null {
  return new URLSearchParams(search).get(name);
}
