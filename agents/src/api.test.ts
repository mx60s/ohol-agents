// API endpoints against an in-process server with fake data.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type http from "node:http";
import net, { type AddressInfo } from "node:net";
import { startApi } from "./api.ts";
import { LifeStore } from "./lifestore.ts";
import { seededRng } from "./traits.ts";
import { FakeEvents } from "./test-helpers.ts";
import type { RunController } from "./runs.ts";
import { GameData } from "./game/gameData.ts";
import { InventionLog } from "./inventions.ts";
import type { DeathsResponse, FieldNotesResponse, FlowersResponse, InventionsResponse, LifeLogResponse, LifeRecord, LineagesResponse, LivesResponse } from "./api-types.ts";
import { FLOWER_COLORS, FLOWER_SHAPES } from "./flowers.ts";

let dir: string;
let server: http.Server;
let base: string;

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "api-"));
  const f = new FakeEvents();
  const lives = new LifeStore({ logDir: dir, dims: ["openness", "neuroticism"], mutationSd: 0.15, traitSource: "mock", rng: seededRng(5), now: () => f.t });
  lives.load();
  const runDir = path.join(dir, "run1-x");
  lives.handle("run1", runDir, f.eve("a01", 10));
  lives.handle("run1", runDir, f.child("a02", 11, 10));
  for (let i = 0; i < 600; i++) lives.handle("run1", runDir, f.ev("thought", "a01", 10, undefined, { text: `thought ${i}` }));
  for (let i = 0; i < 3; i++) lives.handle("run1", runDir, f.eve(`b0${i}`, 100 + i));
  for (let i = 0; i < 3; i++) lives.handle("run1", runDir, f.death(`b0${i}`, 100 + i, 20 + i));

  // inventions: one in an older run, two in run1 (newest last), plus a pickup that isn't one
  let currentRun = "run0";
  const inventions = new InventionLog(new GameData(), { runId: () => currentRun, lifeOf: (_r, agentId) => (agentId === "a01" ? "run1:10" : null) }, { logDir: dir });
  const KNAP = "use (1, 2) -> use: tile (1,2) Big Hard Rock -> Big Hard Rock; holding Stone -> Sharp Stone";
  inventions.observe(f.action("a01", 10, KNAP, {}));
  currentRun = "run1";
  inventions.observe({ ...f.action("a01", 10, KNAP, {}), name: "EVE ROSE" });
  inventions.observe(f.action("a01", 10, "use (3, 2) -> use: tile (3,2) Rope -> nothing; holding nothing -> Rope", {}));
  inventions.observe(f.action("a02", 11, "use (1, 2) -> use: tile (1,2) Reed Bundle -> Reed Skirt; holding Rope -> nothing", {}));

  const runs = Object.assign(new EventEmitter(), {
    lives,
    inventions,
    pop: { state: () => ({ run: { id: "run1", status: "running" }, agents: [], players: [] }), map: () => ({ cells: [], names: {} }), minimap: () => ({ block: 1, cells: [] }), leadership: () => ({ runId: "run1", at: 5, edges: [{ follower: 2, leader: 1 }], people: [] }) },
    log: { since: (n: number) => [{ seq: n + 1, kind: "system" }] },
    openControl: false,
    maxTotalCostUsd: 0,
    totalCost: 0,
    focus: () => ({ agentId: null, lifeId: null, since: 0, reason: null }),
    story: { current: () => null, history: () => [] },
    fieldNotes: {
      list: (limit: number) =>
        [3, 2, 1].map((i) => ({ t: i * 1000, runId: "run1", windowStart: (i - 1) * 1000, windowEnd: i * 1000, text: `note ${i}`, model: "m" })).slice(0, Math.max(1, Math.min(500, Math.floor(limit) || 50))),
    },
  }) as unknown as RunController;
  const gd = { allNames: () => ({ 1: "Stone" }) } as unknown as GameData;
  server = startApi(0, runs, gd, "secret");
  if (!server.listening) await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

async function get(p: string, init?: RequestInit) {
  const res = await fetch(base + p, init);
  const text = await res.text();
  return { status: res.status, text, body: JSON.parse(text), cors: res.headers.get("access-control-allow-origin") };
}

test("existing endpoints still work", async () => {
  assert.equal((await get("/health")).body.ok, true);
  const st = await get("/api/state");
  assert.equal(st.status, 200);
  assert.equal(st.body.run.id, "run1");
  assert.equal(st.cors, "*");
  assert.equal((await get("/api/events?since=4")).body.events[0].seq, 5);
  assert.deepEqual((await get("/api/map")).body.cells, []);
  assert.deepEqual((await get("/api/minimap")).body, { block: 1, cells: [] });
  assert.equal((await get("/api/objects")).body.names[1], "Stone");
  assert.equal((await get("/api/halt", { method: "POST" })).status, 403);
  assert.equal((await get("/api/nope")).status, 404);
});

test("GET /api/fieldnotes: the current run's notes, newest first, limit", async () => {
  const r = await get("/api/fieldnotes");
  assert.equal(r.status, 200);
  const body = r.body as FieldNotesResponse;
  assert.deepEqual(body.notes.map((n) => n.text), ["note 3", "note 2", "note 1"]);
  assert.equal(body.notes[0].windowStart, 2000);
  assert.deepEqual((await get("/api/fieldnotes?limit=1")).body.notes.map((n: { text: string }) => n.text), ["note 3"]);
  assert.equal((await get("/api/fieldnotes?limit=junk")).body.notes.length, 3);
});

test("GET /api/leadership: the population's merged view", async () => {
  const r = await get("/api/leadership");
  assert.equal(r.status, 200);
  assert.equal(r.cors, "*");
  assert.deepEqual(r.body, { runId: "run1", at: 5, edges: [{ follower: 2, leader: 1 }], people: [] });
});

test("GET /api/flowers: the flower catalogue", async () => {
  const r = await get("/api/flowers");
  assert.equal(r.status, 200);
  const body = r.body as FlowersResponse;
  assert.deepEqual(body.shapes, FLOWER_SHAPES);
  assert.deepEqual(body.colors, FLOWER_COLORS);
  assert.equal(body.shapes.length * body.colors.length, 77);
});

test("GET /api/inventions: newest first, current run by default, limit, all runs", async () => {
  const r = await get("/api/inventions");
  assert.equal(r.status, 200);
  const body = r.body as InventionsResponse;
  assert.deepEqual(body.inventions.map((x) => x.item), ["Reed Skirt", "Sharp Stone"]);
  const [skirt, stone] = body.inventions;
  assert.equal(stone.name, "EVE ROSE");
  assert.equal(stone.lifeId, "run1:10");
  assert.equal(stone.runId, "run1");
  assert.equal(stone.objectId, 34);
  assert.equal(skirt.lifeId, null);
  assert.ok(skirt.t > stone.t);
  assert.deepEqual((await get("/api/inventions?limit=1")).body.inventions.map((x: { item: string }) => x.item), ["Reed Skirt"]);
  assert.equal((await get("/api/inventions?run=all")).body.inventions.length, 3);
  assert.equal((await get("/api/inventions?run=run0")).body.inventions[0].item, "Sharp Stone");
  assert.equal((await get("/api/inventions?limit=junk")).body.inventions.length, 2);
});

test("GET /api/lives: all, since, limits", async () => {
  const r = await get("/api/lives");
  const body = r.body as LivesResponse;
  assert.equal(r.status, 200);
  assert.equal(body.lives.length, 5);
  assert.equal(body.traitSource, "mock");
  assert.deepEqual(body.traitDims, ["openness", "neuroticism"]);
  assert.equal(body.more, false);
  assert.ok(body.lives.every((l, i, a) => i === 0 || a[i - 1].updatedAt <= l.updatedAt));
  const kid = body.lives.find((l) => l.lifeId === "run1:11")!;
  assert.equal(kid.inherited, true);
  assert.equal(kid.lineageId, "run1:10");
  assert.equal((kid as unknown as Record<string, unknown>).logPath, undefined, "internal path not exposed");
  assert.ok(body.lives.every((l) => l.flower && typeof l.flower.label === "string" && l.flower.shape && l.flower.color), "every record carries its flower");
  const eve = body.lives.find((l) => l.lifeId === "run1:10")!;
  assert.notEqual(`${eve.flower!.shape}|${eve.flower!.color}`, `${kid.flower!.shape}|${kid.flower!.color}`, "mother and child differ");

  const page = (await get("/api/lives?limit=2")).body as LivesResponse;
  assert.equal(page.lives.length, 2);
  assert.equal(page.more, true);
  const rest = (await get(`/api/lives?since=${page.lives[1].updatedAt}`)).body as LivesResponse;
  assert.equal(rest.lives.length, 3);
  const latest = Math.max(...body.lives.map((l) => l.updatedAt));
  assert.equal(((await get(`/api/lives?since=${latest}`)).body as LivesResponse).lives.length, 0);

  assert.equal((await get("/api/lives?limit=99999999999")).status, 200, "huge limit is capped");
  for (const q of ["limit=abc", "limit=0", "limit=-1", "limit=1.5", "since=-5", "since=1e3", "since=123456789012345678901"]) {
    const bad = await get(`/api/lives?${q}`);
    assert.equal(bad.status, 400, q);
    assert.ok(typeof bad.body.error === "string");
  }
});

test("GET /api/lives/<id>: known, unknown, malformed, traversal", async () => {
  const ok = await get(`/api/lives/${encodeURIComponent("run1:10")}`);
  assert.equal(ok.status, 200);
  assert.equal((ok.body as LifeRecord).childLifeIds[0], "run1:11");
  assert.equal((await get("/api/lives/run1:10")).status, 200, "unencoded colon works too");
  for (const p of [
    "/api/lives/run1:999",
    "/api/lives/nope",
    "/api/lives/..%2F..%2Fetc%2Fpasswd",
    "/api/lives/%2e%2e%2fresearch%2flives.snapshot.json:1",
    "/api/lives/run1:10/../../etc/passwd",
    "/api/lives/run1:10/log/extra",
    "/api/lives/run1:10/other",
    "/api/lives/",
  ]) {
    const r = await get(p);
    assert.equal(r.status, 404, p);
    assert.equal(r.body.error.includes("etc"), false);
  }
  assert.equal((await get("/api/lives/%E0%A4%A")).status, 400);
  const xss = await get("/api/lives/%3Cscript%3Ealert(1)%3C%2Fscript%3E");
  assert.equal(xss.status, 404);
  assert.ok(!xss.text.includes("<script>") && !xss.text.includes("alert"));
  const xssQ = await get("/api/lives?limit=%3Cscript%3E");
  assert.ok(!xssQ.text.includes("<script>"));
});

test("GET /api/lives/<id>/log: default, paging, caps, unknown", async () => {
  const id = encodeURIComponent("run1:10");
  const first = (await get(`/api/lives/${id}/log`)).body as LifeLogResponse;
  assert.equal(first.events.length, 100);
  assert.equal(first.events[0].text, "thought 599");
  assert.ok(first.nextBefore != null);
  const second = (await get(`/api/lives/${id}/log?before=${first.nextBefore}&limit=50`)).body as LifeLogResponse;
  assert.equal(second.events[0].text, "thought 499");
  assert.equal(second.events.length, 50);
  const big = (await get(`/api/lives/${id}/log?limit=100000`)).body as LifeLogResponse;
  assert.equal(big.events.length, 500);
  const all = (await get(`/api/lives/${id}/log?before=200&limit=500`)).body as LifeLogResponse;
  assert.equal(all.events.at(-1)!.kind, "birth");
  assert.equal(all.nextBefore, null);
  assert.equal((await get(`/api/lives/${id}/log?before=x`)).status, 400);
  assert.equal((await get(`/api/lives/${id}/log?limit=0`)).status, 400);
  assert.equal((await get("/api/lives/run1:999/log")).status, 404);
});

test("GET /api/lineages and /api/deaths", async () => {
  const lin = (await get("/api/lineages")).body as LineagesResponse;
  assert.equal(lin.lineages.length, 4);
  const fam = lin.lineages.find((l) => l.lineageId === "run1:10")!;
  assert.equal(fam.totalLives, 2);
  assert.equal(fam.extinctAt, null);
  assert.equal(lin.lineages.filter((l) => l.extinctAt != null).length, 3);

  const d = (await get("/api/deaths")).body as DeathsResponse;
  assert.equal(d.deaths.length, 3);
  assert.ok(d.deaths[0].diedAt >= d.deaths[1].diedAt);
  assert.ok(d.deaths[0].traits && d.deaths[0].deathReason === "hunger");
  assert.equal(((await get("/api/deaths?limit=1")).body as DeathsResponse).deaths.length, 1);
  assert.equal((await get("/api/deaths?limit=1000000")).status, 200);
  assert.equal((await get("/api/deaths?limit=nope")).status, 400);
});

/** Raw HTTP/1.1 request (fetch can't send absolute-form or malformed targets). Resolves with the status line. */
function raw(target: string): Promise<string> {
  const port = (server.address() as AddressInfo).port;
  return new Promise((resolve) => {
    const s = net.connect(port, "127.0.0.1", () => s.write(`GET ${target} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`));
    let buf = "";
    s.on("data", (d) => (buf += d));
    s.on("error", () => resolve(buf.split("\r\n")[0]));
    s.on("close", () => resolve(buf.split("\r\n")[0]));
  });
}

test("malformed request targets don't crash the process", async () => {
  // "GET http://a:99999/x" used to throw from new URL() outside any try and kill the service
  for (const t of ["http://a:99999/x", "http://[::1/x", "https://x/api/state", "//evil/x", "/%", "/api/lives/%E0%A4%A"]) {
    const line = await raw(t);
    assert.match(line, /^HTTP\/1\.1 \d{3}/, t);
  }
  assert.equal((await raw("http://a:99999/api/state")).startsWith("HTTP/1.1 200"), true, "absolute-form targets are served by path");
  assert.equal((await get("/health")).body.ok, true, "still alive");
});

test("GET /api/agent-spec is mounted (no run dir: no example)", async () => {
  const r = await get("/api/agent-spec");
  assert.equal(r.status, 200);
  assert.ok(r.body.systemPrompt.includes("You are a person in a world"));
  assert.ok(Array.isArray(r.body.actions) && r.body.actions.length > 5);
  assert.equal(r.body.example, null);
});
