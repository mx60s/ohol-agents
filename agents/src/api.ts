// HTTP API for the viewer. Contract: src/api-types.ts.

import http from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RunController } from "./runs.ts";
import type { GameData } from "./game/gameData.ts";
import { handleResearchApi } from "./research-api.ts";

// Built viewer (viewer/dist), served at / when present, so one Railway URL
// is both the dashboard and its API.
const VIEWER_DIST = process.env.VIEWER_DIST ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../viewer/dist");
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml",
  ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json", ".txt": "text/plain",
};

function serveStatic(pathname: string, res: http.ServerResponse): boolean {
  if (!existsSync(VIEWER_DIST)) return false;
  let file = path.join(VIEWER_DIST, path.normalize(pathname).replace(/^(\.\.[/\\])+/, ""));
  if (!file.startsWith(VIEWER_DIST) || !existsSync(file) || statSync(file).isDirectory()) file = path.join(VIEWER_DIST, "index.html");
  res.setHeader("content-type", TYPES[path.extname(file)] ?? "application/octet-stream");
  if (file.includes(`${path.sep}assets${path.sep}`)) res.setHeader("cache-control", "public, max-age=31536000, immutable");
  res.end(readFileSync(file));
  return true;
}

export interface ApiOptions {
  /** max concurrent /api/stream clients; more get 503 (default 200) */
  maxSseClients?: number;
  /** drop an SSE client whose unsent buffer exceeds this (a stalled reader), bytes (default 1 MiB) */
  sseMaxBufferBytes?: number;
}

/** Constant-time token check (compares digests, so length doesn't leak either). */
export function tokenMatches(given: string, expected: string): boolean {
  if (!expected) return false;
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

export function startApi(port: number, runs: RunController, gd: GameData, cfgToken = "", opts: ApiOptions = {}) {
  const maxSse = opts.maxSseClients ?? 200;
  const maxBuf = opts.sseMaxBufferBytes ?? 1 << 20;
  const sseClients = new Set<http.ServerResponse>();
  const broadcast = (chunk: string) => {
    for (const c of sseClients) {
      // a client that stopped reading would otherwise buffer every event in memory forever
      if (c.writableLength > maxBuf || c.destroyed) {
        sseClients.delete(c);
        c.destroy();
        continue;
      }
      c.write(chunk);
    }
  };
  runs.on("event", (e) => broadcast(`data: ${JSON.stringify(e)}\n\n`));
  setInterval(() => broadcast(": ping\n\n"), 20000).unref();

  let namesCache: string | null = null;

  const server = http.createServer((req, res) => {
    let url: URL;
    try {
      // only path + query matter; an absolute-form target ("GET http://a:99999/x") used to throw out of the handler and kill the process
      url = new URL((req.url ?? "/").replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, "") || "/", "http://x");
    } catch {
      res.statusCode = 400;
      return void res.end('{"error":"bad request"}');
    }
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-headers", "*");
    if (req.method === "OPTIONS") return void res.end();
    const json = (body: unknown) => {
      res.setHeader("content-type", "application/json");
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    };
    try {
      switch (url.pathname) {
        case "/health":
          return json({ ok: true });
        case "/api/state":
          return json({ ...runs.pop.state(), control: { open: runs.openControl, totalCostUsd: Math.round(runs.totalCost * 100) / 100, maxTotalCostUsd: runs.maxTotalCostUsd }, focus: runs.focus(), story: runs.story.current() });
        case "/api/story/history":
          return json({ history: runs.story.history(Number(url.searchParams.get("limit") ?? 20)) });
        case "/api/map":
          return json(runs.pop.map());
        case "/api/events":
          return json({ events: runs.log.since(Number(url.searchParams.get("since") ?? 0)) });
        case "/api/objects":
          namesCache ??= JSON.stringify({ names: gd.allNames() });
          return json(namesCache);
        case "/api/start":
        case "/api/halt": {
          // token via ?token= or "authorization: Bearer <token>"
          const tok = url.searchParams.get("token") ?? (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
          const authed = runs.openControl || tokenMatches(tok, cfgToken);
          if (req.method !== "POST" || !authed) {
            res.statusCode = 403;
            return json({ error: "wrong password" });
          }
          const r = url.pathname === "/api/start" ? runs.start() : runs.halt("stopped from the dashboard");
          return json({ ok: !r.startsWith("refused"), result: r });
        }
        case "/api/stream":
          if (sseClients.size >= maxSse) {
            res.statusCode = 503;
            res.setHeader("retry-after", "30");
            return json({ error: "too many stream clients" });
          }
          res.on("error", () => sseClients.delete(res));
          res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
          res.write(": hello\n\n");
          sseClients.add(res);
          req.on("close", () => sseClients.delete(res));
          return;
        default:
          // research data: /api/lives*, /api/lineages, /api/deaths (research-api.ts)
          if (req.method === "GET" && handleResearchApi(url, res, runs.lives)) return;
          if (!url.pathname.startsWith("/api/") && req.method === "GET" && serveStatic(url.pathname, res)) return;
          res.statusCode = 404;
          return json({ error: "not found" });
      }
    } catch (e) {
      console.error("api error", e);
      res.statusCode = 500;
      json({ error: "internal error" });
    }
  });
  // slowloris: a client must send its headers / whole request promptly (SSE responses are unaffected)
  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;
  server.listen(port, () => console.log(`api listening on :${port}`));
  return server;
}
