// Record a run from the live HTTP API into a JSONL file the viewer can replay
// (viewer ?replay=<url>). Polls /api/state every 2s, /api/map every 5s (stored
// as cell deltas), and /api/events.
//
//   npx tsx src/tools/record.ts [apiUrl] [out.jsonl]
//
// Lines: {k:"state",t,d:StateResponse} | {k:"map",t,cells,names} | {k:"event",d:RunEvent}
// Stops once the run is halted (after a final flush).

import { appendFileSync, writeFileSync } from "node:fs";
import type { MapResponse, RunEvent, StateResponse } from "../api-types.ts";

const api = (process.argv[2] ?? "http://localhost:8787").replace(/\/+$/, "");
const out = process.argv[3] ?? `recording-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`;
writeFileSync(out, "");
const write = (o: unknown) => appendFileSync(out, JSON.stringify(o) + "\n");
const get = async <T>(p: string): Promise<T> => {
  const r = await fetch(api + p);
  if (!r.ok) throw new Error(`${p} -> ${r.status}`);
  return (await r.json()) as T;
};

const cells = new Map<string, string>(); // "x,y" -> JSON of tuple
const names = new Set<number>();
let lastSeq = 0;
let started = false;
let tick = 0;

async function pollEvents() {
  for (;;) {
    const { events } = await get<{ events: RunEvent[] }>(`/api/events?since=${lastSeq}`);
    for (const e of events) write({ k: "event", d: e });
    if (events.length) lastSeq = events[events.length - 1].seq;
    if (events.length < 500) return;
  }
}

async function pollMap() {
  const m = await get<MapResponse>("/api/map");
  const changed: MapResponse["cells"] = [];
  for (const c of m.cells) {
    const key = `${c[0]},${c[1]}`;
    const s = JSON.stringify(c);
    if (cells.get(key) !== s) {
      cells.set(key, s);
      changed.push(c);
    }
  }
  const newNames: Record<number, string> = {};
  for (const [id, n] of Object.entries(m.names)) {
    if (!names.has(Number(id))) {
      names.add(Number(id));
      newNames[Number(id)] = n;
    }
  }
  if (changed.length) write({ k: "map", t: Date.now(), cells: changed, names: newNames });
}

for (;;) {
  try {
    const s = await get<StateResponse>("/api/state");
    if (s.run.status === "running") started = true;
    if (started) {
      write({ k: "state", t: Date.now(), d: s });
      await pollEvents();
      if (tick++ % 3 === 0 || s.run.status !== "running") await pollMap();
      if (s.run.status === "halted") {
        console.log(`run halted (${s.run.haltReason}); recording saved to ${out}`);
        process.exit(0);
      }
    }
  } catch (e) {
    console.error(String(e));
  }
  await new Promise((r) => setTimeout(r, 2000));
}
