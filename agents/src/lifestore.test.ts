import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, appendFileSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { LifeStore } from "./lifestore.ts";
import { seededRng } from "./traits.ts";
import { FakeEvents } from "./test-helpers.ts";

const DIMS = ["openness", "neuroticism"];

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), "lifestore-"));
  const f = new FakeEvents();
  const mk = (seed = 1) => new LifeStore({ logDir: dir, dims: DIMS, mutationSd: 0.15, traitSource: "mock", rng: seededRng(seed), now: () => f.t });
  return { dir, f, mk, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("rebuild from disk after a simulated crash (journal only) and a clean restart (snapshot)", () => {
  const { dir, f, mk, cleanup } = setup();
  try {
    const runDir = path.join(dir, "runA-2026");
    const a = mk();
    a.load();
    a.handle("runA", runDir, f.eve("a01", 10));
    a.handle("runA", runDir, f.ev("thought", "a01", 10, undefined, { name: "EVE HOPE", text: "find berries" }));
    a.snapshot(); // part of the history in the snapshot...
    a.handle("runA", runDir, f.child("a02", 11, 10));
    a.handle("runA", runDir, f.ev("say", "a01", 10, { playerId: 10, heardBy: ["a02"] }));
    a.handle("runA", runDir, f.death("a01", 10));
    a.flush(); // ...the rest only in the journal; no close() = crash
    const before = a.get("runA:10")!;
    const kidBefore = a.get("runA:11")!;
    // torn last line from the crash
    appendFileSync(path.join(dir, "research", "lives.journal.jsonl"), '{"lifeId":"runA:1');

    f.wait(1000);
    const b = mk(2);
    assert.equal(b.load(), 2);
    const eve = b.get("runA:10")!;
    assert.equal(eve.name, "EVE HOPE");
    assert.deepEqual(eve.traits, before.traits);
    assert.equal(eve.status, "dead");
    assert.deepEqual(eve.childLifeIds, ["runA:11"]);
    assert.equal(eve.activity.says, 1);
    assert.equal(eve.activity.thoughts, 1);
    // the child was alive when the process died: now lost, but presumed alive for a while
    const kid = b.get("runA:11")!;
    assert.equal(kid.status, "lost");
    assert.deepEqual(kid.traits, kidBefore.traits);
    assert.equal(b.lineages()[0].extinctAt, null);
    assert.equal(b.lineages()[0].living, 1);
    // per-life log survives
    const log = b.readLog("runA:10", null, 10)!;
    assert.deepEqual(log.events.map((e) => e.kind), ["death", "say", "thought", "birth"]);
    assert.equal(b.deaths(10)[0].lifeId, "runA:10");

    // a new run continues the lineage through the lost child
    const runDir2 = path.join(dir, "runB-2026");
    f.wait(20 * 60_000);
    b.handle("runB", runDir2, f.child("a01", 12, 11, 3));
    const g = b.get("runB:12")!;
    assert.equal(g.inherited, true);
    assert.equal(g.lineageId, "runA:10");
    b.close();

    // clean restart: snapshot only
    const c = mk(3);
    assert.equal(c.load(), 3);
    assert.equal(c.get("runB:12")!.motherLifeId, "runA:11");
    assert.equal(c.lineages()[0].maxGeneration, 3);
    assert.equal(readFileSync(path.join(dir, "research", "lives.journal.jsonl"), "utf8"), "");
  } finally {
    cleanup();
  }
});

test("livesSince pages by updatedAt without splitting ties", () => {
  const { dir, f, mk, cleanup } = setup();
  try {
    const s = mk();
    const runDir = path.join(dir, "r");
    for (let i = 1; i <= 5; i++) s.handle("r", runDir, f.eve(`a0${i}`, i));
    const p1 = s.livesSince(0, 2);
    assert.equal(p1.lives.length, 2);
    assert.equal(p1.more, true);
    const p2 = s.livesSince(p1.lives[1].updatedAt, 10);
    assert.equal(p2.lives.length, 3);
    assert.equal(p2.more, false);
    // ties: same timestamp for several records
    const t = f.t + 5000;
    for (const id of ["r:1", "r:2", "r:3"]) s.book.get(id)!.updatedAt = t;
    const tie = s.livesSince(f.t, 1);
    assert.equal(tie.lives.length, 3);
  } finally {
    cleanup();
  }
});

test("readLog paginates newest first", () => {
  const { dir, f, mk, cleanup } = setup();
  try {
    const s = mk();
    const runDir = path.join(dir, "r");
    s.handle("r", runDir, f.eve("a01", 1));
    for (let i = 0; i < 30; i++) s.handle("r", runDir, f.ev("thought", "a01", 1));
    s.handle("r", runDir, f.ev("system", "a01", 1)); // not logged
    const p1 = s.readLog("r:1", null, 20)!;
    assert.equal(p1.events.length, 20);
    assert.ok(p1.events[0].seq > p1.events[19].seq);
    const p2 = s.readLog("r:1", p1.nextBefore, 20)!;
    assert.equal(p2.events.length, 11);
    assert.equal(p2.nextBefore, null);
    assert.equal(p2.events.at(-1)!.kind, "birth");
    assert.equal(s.readLog("r:999", null, 5), null);
  } finally {
    cleanup();
  }
});

test("recycled player id after a game-server restart: own log file, epoch survives a reload", () => {
  const { dir, f, mk, cleanup } = setup();
  try {
    const runDir = path.join(dir, "r-1");
    const a = mk();
    a.load();
    a.handle("r", runDir, f.eve("a01", 5));
    a.handle("r", runDir, f.death("a01", 5));
    a.handle("r", runDir, f.eve("a02", 9));
    f.wait(60_000); // the game server takes a while to come back
    a.handle("r", runDir, f.eve("a01", 5)); // restart: id 5 again
    a.handle("r", runDir, f.ev("thought", "a01", 5, undefined, { text: "new life" }));
    assert.equal(a.readLog("r:5", null, 10)!.events.length, 2, "old life: birth + death only");
    assert.deepEqual(a.readLog("r.2:5", null, 10)!.events.map((e) => e.text), ["new life", "birth"]);
    assert.ok(readdirSync(path.join(runDir, "lives")).includes("5-2.jsonl"));
    assert.equal(a.agentFields("r", "a01", 5).lifeId, "r.2:5");
    a.close();
    const b = mk();
    b.load();
    assert.equal(b.book.findByPlayer(9, f.t)?.lifeId ?? null, null, "#9 was born before the restart");
  } finally {
    cleanup();
  }
});

test("a corrupt snapshot is kept aside and the previous one used, instead of being overwritten", () => {
  const { dir, f, mk, cleanup } = setup();
  try {
    const runDir = path.join(dir, "r");
    const a = mk();
    a.load();
    for (let i = 1; i <= 5; i++) a.handle("r", runDir, f.eve(`a0${i}`, i));
    a.snapshot(); // snapshot 1: lives 1-5
    a.handle("r", runDir, f.eve("a06", 6));
    a.snapshot(); // snapshot 2: lives 1-6 (snapshot 1 becomes .prev)
    a.handle("r", runDir, f.eve("a07", 7));
    a.flush(); // life 7 only in the journal
    const research = path.join(dir, "research");
    writeFileSync(path.join(research, "lives.snapshot.json"), '[{"lifeId":"r:1", "trunc'); // bit rot / bad manual edit

    const b = mk();
    const n = b.load();
    assert.equal(n, 6, "previous snapshot (1-5) + journal (7); only 6 is lost, not everything");
    assert.ok(b.get("r:1") && b.get("r:5") && b.get("r:7"));
    assert.ok(readdirSync(research).some((x) => x.startsWith("lives.snapshot.json.corrupt-")), "corrupt file preserved for recovery");
    // the fresh snapshot is good
    const c = mk();
    assert.equal(c.load(), 6);
  } finally {
    cleanup();
  }
});

test("journal append failure (disk full): records stay dirty and a torn line doesn't swallow the next", () => {
  const { dir, f, mk, cleanup } = setup();
  try {
    const runDir = path.join(dir, "r");
    const a = mk();
    a.load();
    const journal = path.join(dir, "research", "lives.journal.jsonl");
    // make appends fail
    rmSync(journal, { force: true });
    mkdirSync(journal);
    a.handle("r", runDir, f.eve("a01", 1)); // birth is important: flushed at once -> fails
    // disk has room again; the failed write left half a line behind
    rmSync(journal, { recursive: true });
    writeFileSync(journal, '{"lifeId":"r:1","runId":"r","agen');
    a.handle("r", runDir, f.eve("a02", 2));
    const lines = readFileSync(journal, "utf8").split("\n").filter(Boolean);
    assert.equal(lines.length, 3, "torn line, then each record on its own line");
    const b = mk();
    assert.equal(b.load(), 2, "both lives recovered from the journal (no snapshot written)");
  } finally {
    cleanup();
  }
});

test("a life's time scale is persisted and survives a reload", () => {
  const { dir, f, cleanup } = setup();
  try {
    const mk = (k: number) => new LifeStore({ logDir: dir, dims: DIMS, mutationSd: 0.15, traitSource: "mock", rng: seededRng(1), now: () => f.t, timeScale: k });
    const a = mk(2);
    a.load();
    a.handle("runA", path.join(dir, "runA"), f.eve("a01", 10));
    a.close();
    const b = mk(1); // the service restarted with another TIME_SCALE
    b.load();
    b.handle("runB", path.join(dir, "runB"), f.eve("a01", 50));
    assert.equal(b.get("runA:10")!.timeScale, 2);
    assert.equal(b.get("runB:50")!.timeScale, 1);
    b.close();
  } finally {
    cleanup();
  }
});

test("flowers: persisted across save/load; old records get one on load, persisted, distinct among contemporaries", () => {
  const { dir, f, mk, cleanup } = setup();
  try {
    const runDir = path.join(dir, "runA");
    const a = mk();
    a.load();
    a.handle("runA", runDir, f.eve("a01", 10));
    for (let i = 0; i < 4; i++) a.handle("runA", runDir, f.child(`k${i}`, 20 + i, 10));
    const flowers = new Map([10, 20, 21, 22, 23].map((p) => [p, a.get(`runA:${p}`)!.flower!]));
    assert.ok([...flowers.values()].every((x) => x && x.label));
    assert.equal(a.flowerLabel(21), flowers.get(21)!.label);
    assert.deepEqual(a.playerFields(21).flower, flowers.get(21));
    assert.equal(a.flowerLabel(999), null);
    a.flush(); // journal only (crash)

    const b = mk();
    b.load();
    for (const [p, x] of flowers) assert.deepEqual(b.get(`runA:${p}`)!.flower, x, "same flower after reload");
    b.close();

    // strip the flowers from the snapshot, as in records written before flowers existed
    const snap = path.join(dir, "research", "lives.snapshot.json");
    const arr = JSON.parse(readFileSync(snap, "utf8")) as Record<string, unknown>[];
    for (const l of arr) delete l.flower;
    writeFileSync(snap, JSON.stringify(arr));

    const c = mk();
    c.load();
    const assigned = [10, 20, 21, 22, 23].map((p) => c.get(`runA:${p}`)!.flower!);
    assert.ok(assigned.every((x) => x && x.label));
    assert.equal(new Set(assigned.map((x) => `${x.shape}|${x.color}`)).size, 5, "contemporaries get distinct flowers");
    const onDisk = JSON.parse(readFileSync(snap, "utf8")) as { lifeId: string; flower?: unknown }[];
    assert.ok(onDisk.every((l) => l.flower), "persisted by the load-time snapshot");

    const d = mk();
    d.load();
    assert.deepEqual([10, 20, 21, 22, 23].map((p) => d.get(`runA:${p}`)!.flower), assigned, "same again on the next reload");
    d.close();

    // records with retired shapes (the old hand-drawn daisy / tulip / bellflower ids)
    const arr2 = JSON.parse(readFileSync(snap, "utf8")) as Record<string, unknown>[];
    const old: Record<string, { shape: string; color: string; label: string }> = {
      "runA:10": { shape: "daisy", color: "white", label: "white daisy" },
      "runA:20": { shape: "tulip", color: "red", label: "red tulip" },
      "runA:21": { shape: "bell", color: "blue", label: "blue bellflower" },
    };
    for (const l of arr2) if (old[l.lifeId as string]) l.flower = old[l.lifeId as string];
    writeFileSync(snap, JSON.stringify(arr2));
    const e = mk();
    e.load();
    assert.deepEqual(e.get("runA:10")!.flower, old["runA:10"], "daisy keeps its id (new art)");
    assert.deepEqual(e.get("runA:20")!.flower, old["runA:20"], "tulip keeps its id (new art)");
    assert.deepEqual(e.get("runA:21")!.flower, { shape: "lily", color: "blue", label: "blue lily" }, "bellflower -> lily, same colour");
    const onDisk2 = JSON.parse(readFileSync(snap, "utf8")) as { lifeId: string; flower?: { shape: string } }[];
    assert.equal(onDisk2.find((l) => l.lifeId === "runA:21")!.flower!.shape, "lily", "migration persisted");
  } finally {
    cleanup();
  }
});

test("naming rules: taken surnames across restarts (living or extinct), first names per lineage", () => {
  const { dir, f, mk, cleanup } = setup();
  try {
    const runDir = path.join(dir, "runA-2026");
    const a = mk();
    a.load();
    const named = (agentId: string, pid: number, name: string) => a.handle("runA", runDir, f.ev("thought", agentId, pid, undefined, { name, text: "hm" }));
    a.handle("runA", runDir, f.eve("a01", 10));
    named("a01", 10, "MIRA DAWN");
    a.handle("runA", runDir, f.child("a02", 11, 10));
    named("a02", 11, "AURORA DAWN");
    a.handle("runA", runDir, f.child("a03", 12, 10));
    named("a03", 12, "AURORA II DAWN");
    a.handle("runA", runDir, f.death("a01", 10));
    a.handle("runA", runDir, f.eve("a04", 20));
    named("a04", 20, "EVE SOL");
    a.handle("runA", runDir, f.child("a05", 21, 20));
    named("a05", 21, "AURORA"); // named before the family had a name: no surname
    a.close();

    const b = mk(2);
    b.load();
    assert.deepEqual(b.takenSurnames(), ["SOL", "DAWN"], "most recent first");
    assert.deepEqual(b.familyFirstNames("runA", 11).sort(), ["AURORA", "AURORA II", "MIRA"]);
    assert.deepEqual(b.familyFirstNames("runA", 21).sort(), ["AURORA", "EVE"]);
    assert.deepEqual(b.familyFirstNames("runA", 99), []);
    b.close();
  } finally {
    cleanup();
  }
});
