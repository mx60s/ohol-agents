// Research endpoints: lives, lineages, deaths, per-life logs.
// Contract (LivesResponse etc.) in api-types.ts. Mounted by api.ts.

import type http from "node:http";
import type { DeathsResponse, LifeLogResponse, LineageRecord, LineagesResponse, LivesResponse } from "./api-types.ts";
import type { LifeStore } from "./lifestore.ts";

export const LIVES_DEFAULT_LIMIT = 1000;
export const LIVES_MAX_LIMIT = 5000;
export const LOG_DEFAULT_LIMIT = 100;
export const LOG_MAX_LIMIT = 500;
export const DEATHS_DEFAULT_LIMIT = 50;
export const DEATHS_MAX_LIMIT = 500;

/** lifeId = `${runId}:${playerId}` (or `${runId}.<n>:${playerId}` for a recycled id); runIds come from RUN_ID + "-r<n>-<base36>" */
const LIFE_ID_RE = /^[A-Za-z0-9_.-]{1,120}:\d{1,12}$/;

class BadRequest extends Error {}

/** Each lineage with its family's prompted personality, when the run has them (else unchanged). */
function withPersonalities(lineages: LineageRecord[], personalityOf?: (lineageId: string) => string | null): LineageRecord[] {
  if (!personalityOf) return lineages;
  return lineages.map((l) => {
    const personality = personalityOf(l.lineageId);
    return personality ? { ...l, personality } : l;
  });
}

/** Non-negative integer query param, absent = default, capped at max. */
function intParam(url: URL, name: string, def: number | null, max = Number.MAX_SAFE_INTEGER): number | null {
  const raw = url.searchParams.get(name);
  if (raw == null || raw === "") return def;
  if (!/^\d{1,16}$/.test(raw)) throw new BadRequest(`${name} must be a non-negative integer`);
  return Math.min(Number(raw), max);
}

function limitParam(url: URL, def: number, max: number): number {
  const n = intParam(url, "limit", def, max)!;
  if (n < 1) throw new BadRequest("limit must be at least 1");
  return n;
}

/**
 * Handles /api/lives*, /api/lineages and /api/deaths. Returns false for any
 * other path. Errors never echo request input.
 */
export function handleResearchApi(url: URL, res: http.ServerResponse, store: LifeStore, personalityOf?: (lineageId: string) => string | null): boolean {
  const p = url.pathname;
  if (!(p === "/api/lives" || p.startsWith("/api/lives/") || p === "/api/lineages" || p === "/api/deaths")) return false;
  const send = (status: number, body: unknown) => {
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(body));
  };
  try {
    const now = Date.now();
    if (p === "/api/lives") {
      const since = intParam(url, "since", 0)!;
      const limit = limitParam(url, LIVES_DEFAULT_LIMIT, LIVES_MAX_LIMIT);
      const { lives, more } = store.livesSince(since, limit);
      const body: LivesResponse = { now, traitDims: store.dims, traitSource: store.traitSource, lives, more };
      send(200, body);
      return true;
    }
    if (p === "/api/lineages") {
      const body: LineagesResponse = { now, traitDims: store.dims, traitSource: store.traitSource, lineages: withPersonalities(store.lineages(), personalityOf) };
      send(200, body);
      return true;
    }
    if (p === "/api/deaths") {
      const body: DeathsResponse = { now, traitSource: store.traitSource, deaths: store.deaths(limitParam(url, DEATHS_DEFAULT_LIMIT, DEATHS_MAX_LIMIT)) };
      send(200, body);
      return true;
    }
    // /api/lives/<lifeId> or /api/lives/<lifeId>/log
    const rest = p.slice("/api/lives/".length);
    const parts = rest.split("/");
    if (parts.length > 2 || (parts.length === 2 && parts[1] !== "log")) {
      send(404, { error: "not found" });
      return true;
    }
    let lifeId: string;
    try {
      lifeId = decodeURIComponent(parts[0]);
    } catch {
      send(400, { error: "bad life id" });
      return true;
    }
    if (!LIFE_ID_RE.test(lifeId)) {
      send(404, { error: "unknown life" });
      return true;
    }
    if (parts.length === 1) {
      const life = store.get(lifeId);
      if (!life) send(404, { error: "unknown life" });
      else send(200, life);
      return true;
    }
    const before = intParam(url, "before", null);
    const limit = limitParam(url, LOG_DEFAULT_LIMIT, LOG_MAX_LIMIT);
    const log: LifeLogResponse | null = store.readLog(lifeId, before, limit);
    if (!log) send(404, { error: "unknown life" });
    else send(200, log);
    return true;
  } catch (e) {
    if (e instanceof BadRequest) send(400, { error: e.message });
    else {
      console.error("research api error", e);
      send(500, { error: "internal error" });
    }
    return true;
  }
}
