// Typed client for every agents-service endpoint (contract: ../api-types.ts),
// plus a FixtureClient that serves captured JSON with no network calls to the API.
// Use getClient(); the hooks in ./hooks.ts sit on top of this.

import type {
  AgentSpecResponse,
  DeathsResponse,
  LifeLogResponse,
  LifeRecord,
  LineagesResponse,
  LivesResponse,
  MapResponse,
  MinimapResponse,
  RunEvent,
  StateResponse,
  StoryHistoryResponse,
  InventionsResponse,
} from "../api-types.ts";
import { dataMode, type DataMode } from "./config.ts";
import {
  normAgentSpec,
  normDeaths,
  normEvent,
  normEvents,
  normLife,
  normLifeLog,
  normLineages,
  normLives,
  normMap,
  normMinimap,
  normNames,
  normState,
  normStoryHistory,
  normInventions,
} from "./normalize.ts";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export type StreamStatus = "connecting" | "open" | "closed";

export interface StreamHandlers {
  onEvent: (ev: RunEvent) => void;
  /** "open" after every (re)connect: callers should backfill via events(since) */
  onStatus?: (s: StreamStatus) => void;
}

export interface ApiClient {
  readonly mode: DataMode;
  /** true for fixtures: data never changes, so hooks fetch once and skip polling */
  readonly isStatic: boolean;
  state(): Promise<StateResponse>;
  map(): Promise<MapResponse>;
  /** the whole explored world, coarse (stream inset); older services: the nearby map */
  minimap(): Promise<MinimapResponse>;
  /** events with seq > since, oldest first (server caps at 500 per call) */
  events(since?: number): Promise<RunEvent[]>;
  /** SSE /api/stream with auto-reconnect. Returns an unsubscribe function. */
  stream(h: StreamHandlers): () => void;
  /** object id -> display name, for every object */
  objects(): Promise<Record<number, string>>;
  lives(q?: { since?: number; limit?: number }): Promise<LivesResponse>;
  /** null if the life is unknown (404) */
  life(lifeId: string): Promise<LifeRecord | null>;
  /** newest first; pass the previous page's nextBefore as `before` */
  lifeLog(lifeId: string, q?: { before?: number | null; limit?: number }): Promise<LifeLogResponse>;
  lineages(): Promise<LineagesResponse>;
  deaths(q?: { limit?: number }): Promise<DeathsResponse>;
  storyHistory(q?: { limit?: number }): Promise<StoryHistoryResponse>;
  /** first time each technology item was made in the current run, newest first (empty from older servers) */
  inventions(q?: { limit?: number }): Promise<InventionsResponse>;
  /** GET /api/agent-spec (what agents are told and can do); null if the service is older than it */
  agentSpec?(): Promise<AgentSpecResponse | null>;
}

const qs = (o: Record<string, number | null | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v != null && Number.isFinite(v)) p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
};

// ------------------------------------------------------------------ HTTP

export class HttpClient implements ApiClient {
  readonly isStatic = false;
  readonly mode: DataMode;
  constructor(
    readonly base: string,
    private timeoutMs = 12_000,
  ) {
    this.mode = { kind: "http", base };
  }

  private async get(path: string, allow404 = false, raw = false): Promise<unknown> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.base}${path}`, { signal: ctl.signal, headers: { accept: "application/json" } });
      if (allow404 && res.status === 404) return null;
      if (!res.ok) throw new ApiError(`GET ${path} -> HTTP ${res.status}`, res.status);
      return raw ? await res.text() : await res.json();
    } catch (e) {
      if (e instanceof ApiError) throw e;
      throw new ApiError(`GET ${path} failed: ${(e as Error)?.message ?? e}`, null);
    } finally {
      clearTimeout(timer);
    }
  }

  async state() { return normState(await this.get("/api/state")); }
  private lastMap: { text: string; map: MapResponse } | null = null;
  /**
   * The map is re-sent whole every poll and grows all run (10^5 cells after a long run).
   * An unchanged body returns the previous object, so nothing downstream re-parses,
   * re-indexes or redraws it.
   */
  async minimap() {
    try {
      return normMinimap(await this.get("/api/minimap"));
    } catch {
      return { block: 1, cells: (await this.map()).cells };
    }
  }

  async map() {
    const text = (await this.get("/api/map", false, true)) as string;
    if (this.lastMap && this.lastMap.text === text) return this.lastMap.map;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      throw new ApiError(`GET /api/map: bad JSON (${(e as Error).message})`, null);
    }
    const map = normMap(parsed);
    this.lastMap = { text, map };
    return map;
  }
  async events(since = 0) { return normEvents(await this.get(`/api/events${qs({ since })}`)); }
  async objects() {
    const r = (await this.get("/api/objects")) as { names?: unknown } | null;
    return normNames(r?.names);
  }
  async lives(q: { since?: number; limit?: number } = {}) { return normLives(await this.get(`/api/lives${qs(q)}`)); }
  async life(lifeId: string) {
    return normLife(await this.get(`/api/lives/${encodeURIComponent(lifeId)}`, true));
  }
  async lifeLog(lifeId: string, q: { before?: number | null; limit?: number } = {}) {
    return normLifeLog(await this.get(`/api/lives/${encodeURIComponent(lifeId)}/log${qs(q)}`), lifeId);
  }
  async lineages() { return normLineages(await this.get("/api/lineages")); }
  async deaths(q: { limit?: number } = {}) { return normDeaths(await this.get(`/api/deaths${qs(q)}`)); }
  async storyHistory(q: { limit?: number } = {}) { return normStoryHistory(await this.get(`/api/story/history${qs(q)}`)); }
  async inventions(q: { limit?: number } = {}) { return normInventions(await this.get(`/api/inventions${qs(q)}`, true)); }
  async agentSpec() { return normAgentSpec(await this.get("/api/agent-spec", true)); }

  stream(h: StreamHandlers): () => void {
    let es: EventSource | null = null;
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let delay = 1000;
    const open = () => {
      if (closed) return;
      h.onStatus?.("connecting");
      es = new EventSource(`${this.base}/api/stream`);
      es.onopen = () => {
        delay = 1000;
        h.onStatus?.("open");
      };
      es.onmessage = (msg) => {
        try {
          const ev = normEvent(JSON.parse(msg.data as string));
          if (ev) h.onEvent(ev);
        } catch {
          /* ignore malformed messages */
        }
      };
      es.onerror = () => {
        // EventSource retries by itself while CONNECTING; once CLOSED (e.g. HTTP error) we retry with backoff
        h.onStatus?.(es?.readyState === EventSource.CLOSED ? "closed" : "connecting");
        if (es?.readyState === EventSource.CLOSED) {
          es = null;
          retry = setTimeout(open, delay);
          delay = Math.min(delay * 2, 30_000);
        }
      };
    };
    open();
    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      es?.close();
    };
  }
}

// ------------------------------------------------------------------ fixtures

/**
 * Files written by scripts/capture-fixture.mjs into viewer/fixtures/<name>/:
 *   state.json map.json events.json objects.json lives.json lineages.json deaths.json
 *   story-history.json inventions.json meta.json  life/<safeId>.json  log/<safeId>.json
 *   story-history.json meta.json agent-spec.json  life/<safeId>.json  log/<safeId>.json
 * They are bundled as lazy chunks (import.meta.glob), so fixture mode makes no API calls.
 */
export function fixtureFileId(lifeId: string): string {
  return lifeId.replace(/[^A-Za-z0-9._-]/g, "_");
}

type Loader = () => Promise<unknown>;
// (must stay a literal import.meta.glob call: Vite rewrites it at build time)
const FIXTURE_FILES = import.meta.glob("../../fixtures/*/**/*.json", { import: "default" }) as Record<string, Loader>;

export function fixtureNames(): string[] {
  const names = new Set<string>();
  for (const k of Object.keys(FIXTURE_FILES)) names.add(k.split("/")[3]);
  return [...names].sort();
}

export class FixtureClient implements ApiClient {
  readonly isStatic = true;
  readonly mode: DataMode;
  private cache = new Map<string, Promise<unknown>>();
  constructor(readonly name: string) {
    this.mode = { kind: "fixture", name };
  }

  private load(file: string, optional = false): Promise<unknown> {
    const key = `../../fixtures/${this.name}/${file}`;
    let p = this.cache.get(key);
    if (!p) {
      const loader = FIXTURE_FILES[key];
      p = loader
        ? loader()
        : optional
          ? Promise.resolve(null)
          : Promise.reject(new ApiError(`fixture "${this.name}" has no ${file} (have: ${fixtureNames().join(", ") || "none"})`, 404));
      this.cache.set(key, p);
    }
    return p;
  }

  async state() { return normState(await this.load("state.json")); }
  async map() { return normMap(await this.load("map.json", true)); }
  async minimap() { return { block: 1, cells: (await this.map()).cells }; }
  async events(since = 0) {
    return normEvents(await this.load("events.json", true)).filter((e) => e.seq > since).slice(0, 500);
  }
  async objects() {
    const r = (await this.load("objects.json", true)) as { names?: unknown } | null;
    return normNames(r?.names);
  }
  async lives(q: { since?: number; limit?: number } = {}) {
    const all = normLives(await this.load("lives.json"));
    const since = q.since ?? -Infinity;
    const limit = Math.max(1, Math.min(q.limit ?? 500, 2000));
    const rows = all.lives.filter((l) => l.updatedAt > since).sort((a, b) => a.updatedAt - b.updatedAt);
    return { ...all, lives: rows.slice(0, limit), more: rows.length > limit };
  }
  async life(lifeId: string) {
    const one = normLife(await this.load(`life/${fixtureFileId(lifeId)}.json`, true));
    if (one) return one;
    return normLives(await this.load("lives.json")).lives.find((l) => l.lifeId === lifeId) ?? null;
  }
  async lifeLog(lifeId: string, q: { before?: number | null; limit?: number } = {}) {
    const all = normLifeLog(await this.load(`log/${fixtureFileId(lifeId)}.json`, true), lifeId);
    const limit = Math.max(1, Math.min(q.limit ?? 50, 500));
    const rows = all.events.filter((e) => q.before == null || e.seq < q.before).sort((a, b) => b.seq - a.seq);
    const page = rows.slice(0, limit);
    return { lifeId, events: page, nextBefore: rows.length > limit ? page[page.length - 1].seq : null };
  }
  async lineages() { return normLineages(await this.load("lineages.json")); }
  async deaths(q: { limit?: number } = {}) {
    const d = normDeaths(await this.load("deaths.json", true));
    return { ...d, deaths: d.deaths.slice(0, q.limit ?? 50) };
  }
  async storyHistory(q: { limit?: number } = {}) {
    const h = normStoryHistory(await this.load("story-history.json", true));
    return { history: h.history.slice(0, q.limit ?? 20) };
  }
  async inventions(q: { limit?: number } = {}) {
    const r = normInventions(await this.load("inventions.json", true));
    return { inventions: r.inventions.slice(0, q.limit ?? 20) };
  }
  async agentSpec() { return normAgentSpec(await this.load("agent-spec.json", true)); }
  stream(h: StreamHandlers): () => void {
    // a snapshot has no live stream; report "open" so the UI shows connected
    const t = setTimeout(() => h.onStatus?.("open"), 0);
    return () => clearTimeout(t);
  }
}

// ------------------------------------------------------------------ singleton

let client: ApiClient | null = null;

export function makeClient(mode: DataMode): ApiClient {
  return mode.kind === "fixture" ? new FixtureClient(mode.name) : new HttpClient(mode.base);
}

/** The page's data client (from ?fixture= / ?api= / VITE_API_URL). */
export function getClient(): ApiClient {
  return (client ??= makeClient(dataMode));
}

/** Tests / storybook-ish pages can swap the client before any hook runs. */
export function setClient(c: ApiClient): void {
  client = c;
}
