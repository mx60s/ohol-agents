#!/usr/bin/env node
// Snapshot every API endpoint of a running agents service into viewer/fixtures/<name>/,
// for deterministic tests and offline dev (open any page with ?fixture=<name>).
//
//   node scripts/capture-fixture.mjs [name=live1] [--api http://localhost:8787] [--logs 8] [--log-limit 500]
//
// Writes: state.json map.json events.json objects.json lives.json lineages.json deaths.json
//         story-history.json meta.json life/<id>.json log/<id>.json (ids: non [A-Za-z0-9._-] -> "_")
// Read-only: only GETs, never touches the run.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : d;
};
const name = args.find((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--"))) ?? "live1";
const api = opt("--api", process.env.API_URL ?? "http://localhost:8787").replace(/\/+$/, "");
const nLogs = Number(opt("--logs", "8"));
const logLimit = Number(opt("--log-limit", "500"));
if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error(`bad fixture name ${name}`);
const out = path.join(HERE, "..", "fixtures", name);

export const fileId = (lifeId) => lifeId.replace(/[^A-Za-z0-9._-]/g, "_");

async function get(p) {
  const res = await fetch(api + p);
  if (!res.ok) throw new Error(`GET ${p} -> ${res.status}`);
  return res.json();
}
async function write(rel, data) {
  const f = path.join(out, rel);
  await fs.mkdir(path.dirname(f), { recursive: true });
  await fs.writeFile(f, JSON.stringify(data) + "\n");
  return f;
}

await fs.rm(out, { recursive: true, force: true });
const state = await get("/api/state");
await write("state.json", state);
await write("map.json", await get("/api/map"));
await write("objects.json", await get("/api/objects"));

// every event of the current run (paged, 500 per call)
const events = [];
for (let since = 0; ; ) {
  const r = await get(`/api/events?since=${since}`);
  events.push(...r.events);
  if (r.events.length < 500) break;
  since = r.events[r.events.length - 1].seq;
}
await write("events.json", { events });

// every life (paged by updatedAt)
const byId = new Map();
let livesMeta = null;
for (let since = 0, guard = 0; guard < 1000; guard++) {
  const r = await get(`/api/lives?since=${since}&limit=500`);
  livesMeta = r;
  for (const l of r.lives) byId.set(l.lifeId, l);
  if (!r.more || !r.lives.length) break;
  since = r.lives[r.lives.length - 1].updatedAt;
}
const lives = [...byId.values()].sort((a, b) => a.updatedAt - b.updatedAt);
await write("lives.json", { now: livesMeta.now, traitDims: livesMeta.traitDims, traitSource: livesMeta.traitSource, lives, more: false });
await write("lineages.json", await get("/api/lineages"));
await write("deaths.json", await get("/api/deaths?limit=500"));
await write("story-history.json", await get("/api/story/history?limit=200"));

// several lives in full: the focused one, the living, then the busiest of the rest
const focusLife = state.focus?.lifeId;
const ranked = [...lives].sort(
  (a, b) =>
    (b.lifeId === focusLife) - (a.lifeId === focusLife) ||
    (b.status === "alive") - (a.status === "alive") ||
    b.activity.thoughts - a.activity.thoughts,
);
const picked = [];
for (const l of ranked.slice(0, nLogs)) {
  await write(`life/${fileId(l.lifeId)}.json`, await get(`/api/lives/${encodeURIComponent(l.lifeId)}`));
  const evs = [];
  let before = null;
  for (let guard = 0; guard < 50 && evs.length < logLimit; guard++) {
    const r = await get(`/api/lives/${encodeURIComponent(l.lifeId)}/log?limit=200${before != null ? `&before=${before}` : ""}`);
    evs.push(...r.events);
    before = r.nextBefore;
    if (before == null) break;
  }
  await write(`log/${fileId(l.lifeId)}.json`, { lifeId: l.lifeId, events: evs.slice(0, logLimit), nextBefore: null });
  picked.push(l.lifeId);
}

await write("meta.json", { name, capturedAt: Date.now(), api, runId: state.run?.id ?? null, lives: lives.length, events: events.length, logs: picked });
console.log(`fixture ${name}: ${lives.length} lives, ${events.length} events, ${picked.length} logs, map ${state ? "ok" : "?"} -> ${path.relative(process.cwd(), out)}`);
