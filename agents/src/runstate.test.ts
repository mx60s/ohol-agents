// Stable run identity in CONTINUOUS mode (runstate.ts, runs.ts) and
// reconnect-not-birth across an agents-service restart (lives.ts, lifestore.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { decideRun, readLastSeq, RunStateFile, type RunRecord } from "./runstate.ts";
import { LifeStore } from "./lifestore.ts";
import { LifeBook } from "./lives.ts";
import { LoginScheduler } from "./logins.ts";
import { RunController } from "./runs.ts";
import { config, type Config } from "./config.ts";
import type { GameData } from "./game/gameData.ts";
import { seededRng } from "./traits.ts";
import { FakeEvents } from "./test-helpers.ts";
import type { RunEvent } from "./api-types.ts";

const NOW = 1_800_000_000_000;
const rec = (over: Partial<RunRecord> = {}): RunRecord => ({
  runId: "as-r3-abc", runCount: 3, createdAt: NOW - 1e6, startedAt: NOW - 1e6, halted: false,
  gameServerEpoch: "100", eventsDir: null, updatedAt: NOW - 1000, ...over,
});
const input = (over: Partial<Parameters<typeof decideRun>[0]> = {}) => ({
  continuous: true, base: "as", prev: rec(), newRun: false, gameServerEpoch: "100", resumeAcrossServerRestart: false, now: NOW, ...over,
});

test("decideRun: CONTINUOUS resumes the previous run id", () => {
  const d = decideRun(input());
  assert.deepEqual([d.runId, d.runCount, d.resumed], ["as-r3-abc", 3, true]);
  // unknown epochs (local runs without start.sh) don't block a resume
  assert.equal(decideRun(input({ gameServerEpoch: null })).resumed, true);
  assert.equal(decideRun(input({ prev: rec({ gameServerEpoch: null }) })).resumed, true);
});

test("decideRun: fresh run when asked, halted, renamed, first boot, server restarted, or not continuous", () => {
  const fresh = (over: Partial<Parameters<typeof decideRun>[0]>) => decideRun(input(over));
  const n = fresh({ newRun: true });
  assert.equal(n.resumed, false);
  assert.equal(n.runCount, 4);
  assert.equal(n.runId, `as-r4-${NOW.toString(36)}`);
  assert.equal(fresh({ prev: rec({ halted: true }) }).resumed, false);
  const renamed = fresh({ base: "other" });
  assert.deepEqual([renamed.resumed, renamed.runCount], [false, 1]);
  assert.deepEqual([fresh({ prev: null }).resumed, fresh({ prev: null }).runCount], [false, 1]);
  assert.equal(fresh({ gameServerEpoch: "200" }).resumed, false);
  assert.equal(fresh({ gameServerEpoch: "200", resumeAcrossServerRestart: true }).resumed, true);
  assert.equal(fresh({ continuous: false }).resumed, false);
});

test("RunStateFile round trip, one-shot new-run flag, last event seq", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "runstate-"));
  try {
    const f = new RunStateFile(dir);
    assert.equal(f.load(), null);
    f.save(rec());
    assert.equal(f.load()!.runId, "as-r3-abc");
    writeFileSync(f.file, "{torn");
    const err = console.error;
    console.error = () => {};
    try {
      assert.equal(f.load(), null);
    } finally {
      console.error = err;
    }
    assert.equal(f.takeNewRunFlag(), false);
    writeFileSync(f.flagFile, "");
    assert.equal(f.takeNewRunFlag(), true);
    assert.equal(existsSync(f.flagFile), false);

    const ev = path.join(dir, "run-x");
    mkdirSync(ev);
    assert.equal(readLastSeq(ev), 0);
    writeFileSync(path.join(ev, "events.jsonl.1"), '{"seq":7,"t":1}\n');
    assert.equal(readLastSeq(ev), 7);
    // just rotated to a stamped name: the newest generation, not the legacy one
    writeFileSync(path.join(ev, "events.20261118T194512Z.jsonl"), '{"seq":30,"t":1}\n');
    writeFileSync(path.join(ev, "events.jsonl"), "");
    assert.equal(readLastSeq(ev), 30);
    writeFileSync(path.join(ev, "events.jsonl"), '{"seq":41,"t":1}\n{"seq":42,"t":2}\n{"seq":4');
    assert.equal(readLastSeq(ev), 42);
    assert.equal(readLastSeq(null), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** what agent.ts emits when the server hands back a still-living body */
function reconnect(f: FakeEvents, agentId: string, playerId: number, age: number, lifeIndex = 1): RunEvent {
  return f.ev("system", agentId, playerId, { reconnect: true, playerId, motherId: null, eve: true, generation: 1, lifeIndex, x: 0, y: 0, age, female: true, displayId: 19 });
}

test("restart of a resumed run: open lives stay alive and a reconnect is not a birth", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "resume-"));
  const f = new FakeEvents();
  const mk = () => new LifeStore({ logDir: dir, dims: ["a"], mutationSd: 0.1, traitSource: "mock", rng: seededRng(3), now: () => f.t });
  try {
    const runDir = path.join(dir, "R-1");
    const a = mk();
    a.load();
    a.handle("old", path.join(dir, "old-1"), f.eve("a01", 3)); // an older run's open life
    a.handle("R", runDir, f.eve("a01", 10));
    a.handle("R", runDir, f.child("a02", 11, 10));
    a.handle("R", runDir, f.ev("thought", "a01", 10));
    a.flush(); // crash: no close(), nothing marked lost
    const before = a.get("R:10")!;

    f.wait(2 * 60_000); // two game years while the service restarts
    const b = mk();
    b.load((l) => l.runId === "R");
    assert.equal(b.get("R:10")!.status, "alive");
    assert.equal(b.get("R:11")!.status, "alive");
    assert.equal(b.get("old:3")!.status, "lost"); // not the resumed run
    assert.deepEqual(b.book.resumeRun("R"), ["a01", "a02"]);
    // the agents log back in and get the same bodies, two years older
    assert.ok(b.book.reconnectOf("R", "a01", 10, f.t, 16.1));
    assert.equal(b.book.reconnectOf("R", "a01", 10, f.t, 0), null); // a recycled id comes with a newborn's age
    assert.equal(b.book.reconnectOf("R", "a02", 10, f.t, 16.1), null); // another slot
    b.handle("R", path.join(dir, "R-2"), reconnect(f, "a01", 10, 16.1));
    b.handle("R", path.join(dir, "R-2"), f.ev("thought", "a01", 10));
    const eve = b.get("R:10")!;
    assert.equal(b.book.lives.size, 3, "no new life");
    assert.equal(eve.status, "alive");
    assert.equal(eve.lostAt, null);
    assert.equal(eve.validForStudy, true);
    assert.equal(eve.bornAt, before.bornAt);
    assert.deepEqual(eve.traits, before.traits);
    assert.equal(eve.activity.thoughts, 2);
    assert.equal(b.book.get("R:10")!.logPath, a.book.get("R:10")!.logPath, "events keep going to the same per-life log");
    const log = b.readLog("R:10", null, 10)!;
    assert.deepEqual(log.events.map((e) => e.kind), ["thought", "system", "thought", "birth"]);

    // a02's character died while the service was down: its login gets a new body -> the old life is lost, not dead
    f.wait(1000);
    b.handle("R", path.join(dir, "R-2"), f.child("a02", 12, 10));
    assert.equal(b.get("R:11")!.status, "lost");
    assert.equal(b.get("R:12")!.status, "alive");
    assert.equal(b.get("R:12")!.motherLifeId, "R:10");

    // and after a clean stop + restart the history is intact
    b.close();
    const c = mk();
    c.load((l) => l.runId === "R");
    assert.equal(c.get("R:10")!.status, "alive");
    assert.equal(c.get("R:10")!.activity.thoughts, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("LifeBook: a same-process reconnect event resumes the life (outage pause)", () => {
  const b = new LifeBook({ dims: ["a"], mutationSd: 0.1, traitSource: "mock", rng: seededRng(1) });
  const f = new FakeEvents();
  b.apply("R", f.eve("a01", 10));
  b.markLost((l) => l.runId === "R", f.t); // e.g. the old shutdown path
  f.wait(30_000);
  const r = b.apply("R", reconnect(f, "a01", 10, 14.6));
  assert.equal(r.created, false);
  assert.equal(b.get("R:10")!.lostAt, null);
  assert.equal(b.lives.size, 1);
});

test("LoginScheduler: a resumed run's living slots log in at once, others wait their stagger", async () => {
  let now = 0;
  const sleeps: number[] = [];
  const s = new LoginScheduler(
    { agentCount: 3, initialEves: 2, joinStaggerMs: 90_000, joinJitter: 0, respawnDelayMinMs: 30_000, respawnDelayMaxMs: 30_000 },
    { now: () => now, random: () => 0.5, sleep: (ms) => (sleeps.push(ms), (now += ms), Promise.resolve()) },
    ["a01", "a02"],
  );
  assert.equal(s.phase, "join"); // no starting burst: the families already exist
  await s.beforeLogin("a01", true);
  await s.beforeLogin("a02", true);
  assert.deepEqual(sleeps, []);
  await s.beforeLogin("a03", true);
  assert.deepEqual(sleeps, [90_000]);
  assert.deepEqual(s.admissions.map((a) => a.agentId), ["a01", "a02", "a03"]);
});

test("RunController: CONTINUOUS keeps the run id across restarts; NEW_RUN and halts start fresh; non-continuous never persists", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "runctl-"));
  const gd = { name: () => "x" } as unknown as GameData;
  const cfg = (over: Partial<Config> = {}): Config => ({
    ...config, logDir: dir, runId: "as", continuous: true, narratorIntervalMs: 0, directorIntervalMs: 0, storyIntervalMs: 0,
    llmApiKey: "", newRun: false, gameServerEpoch: "", agentCount: 2, oholPort: 9, ...over,
  });
  const quiet = console.log;
  console.log = () => {};
  try {
    const a = new RunController(cfg(), gd);
    const id = a.runId!;
    assert.match(id, /^as-r1-/);
    a.shutdown();
    const file = path.join(dir, "research", "current-run.json");
    assert.equal(JSON.parse(readFileSync(file, "utf8")).runId, id);

    const b = new RunController(cfg(), gd);
    assert.equal(b.runId, id, "restart resumes the same run");
    b.shutdown();

    const c = new RunController(cfg({ newRun: true }), gd);
    assert.notEqual(c.runId, id);
    assert.match(c.runId!, /^as-r2-/);
    const id2 = c.runId!;
    c.start();
    c.halt("test");
    c.shutdown();
    assert.equal(JSON.parse(readFileSync(file, "utf8")).halted, true);

    const d = new RunController(cfg(), gd);
    assert.match(d.runId!, /^as-r3-/, "a halted run is not resumed");
    d.shutdown();
    assert.notEqual(d.runId, id2);

    const e = new RunController(cfg({ gameServerEpoch: "999" }), gd);
    const id4 = e.runId!;
    e.shutdown();
    const g = new RunController(cfg({ gameServerEpoch: "1000" }), gd);
    assert.notEqual(g.runId, id4, "the game server restarted: its characters are gone");
    g.shutdown();

    rmSync(file);
    const h = new RunController(cfg({ continuous: false }), gd);
    h.shutdown();
    assert.equal(existsSync(file), false);
  } finally {
    console.log = quiet;
    rmSync(dir, { recursive: true, force: true });
  }
});
