// HTTP API for the viewer. Contract: src/api-types.ts.

import http from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RunController } from "./runs.ts";
import type { GameData } from "./game/gameData.ts";

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

export function startApi(port: number, runs: RunController, gd: GameData, cfgToken = "") {
  const sseClients = new Set<http.ServerResponse>();
  runs.on("event", (e) => {
    const line = `data: ${JSON.stringify(e)}\n\n`;
    for (const c of sseClients) c.write(line);
  });
  setInterval(() => {
    for (const c of sseClients) c.write(": ping\n\n");
  }, 20000);

  let namesCache: string | null = null;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
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
          return json({ ...runs.pop.state(), control: { open: runs.openControl, totalCostUsd: Math.round(runs.totalCost * 100) / 100, maxTotalCostUsd: runs.maxTotalCostUsd } });
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
          const authed = runs.openControl || (!!cfgToken && tok === cfgToken);
          if (req.method !== "POST" || !authed) {
            res.statusCode = 403;
            return json({ error: "wrong password" });
          }
          const r = url.pathname === "/api/start" ? runs.start() : runs.halt("stopped from the dashboard");
          return json({ ok: !r.startsWith("refused"), result: r });
        }
        case "/api/stream":
          res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
          res.write(": hello\n\n");
          sseClients.add(res);
          req.on("close", () => sseClients.delete(res));
          return;
        default:
          if (!url.pathname.startsWith("/api/") && req.method === "GET" && serveStatic(url.pathname, res)) return;
          res.statusCode = 404;
          return json({ error: "not found" });
      }
    } catch (e) {
      res.statusCode = 500;
      json({ error: String(e) });
    }
  });
  server.listen(port, () => console.log(`api listening on :${port}`));
  return server;
}
