// World regeneration on extinction (regen.ts): the detector, its login gate
// against the real LoginScheduler, the request to the supervisor, and the
// "world regenerated" handoff through the new-run flag.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ExtinctionWatch, parseWorldRegenerated, regenSettingsFromEnv, requestRegen, worldRegeneratedText, type ExtinctionSample,
} from "./regen.ts";
import { LoginScheduler } from "./logins.ts";
import { RunStateFile } from "./runstate.ts";
import { RunController } from "./runs.ts";
import { LifeStore } from "./lifestore.ts";
import { config, type Config } from "./config.ts";
import type { GameData } from "./game/gameData.ts";
import type { RunEvent } from "./api-types.ts";
import { FakeEvents } from "./test-helpers.ts";
import { seededRng } from "./traits.ts";

const GRACE = 180_000;
const T0 = 1_800_000_000_000;

/** a mutable world the watch samples */
function world(over: Partial<ExtinctionSample> = {}) {
  const s: ExtinctionSample = { running: true, everLived: true, living: 0, inWorld: 0, ...over };
  const w = new ExtinctionWatch(GRACE, () => ({ ...s }));
  return { s, w };
}

test("extinct for the grace period: logins held at once, due exactly once, held after", () => {
  const { w } = world();
  assert.equal(w.holdLogins(T0), true, "held from the first look, no tick needed");
  assert.equal(w.due(T0), false);
  assert.equal(w.due(T0 + GRACE - 1), false);
  assert.equal(w.update(T0 + GRACE - 1), "extinct");
  assert.equal(w.due(T0 + GRACE), true);
  assert.equal(w.due(T0 + GRACE + 5000), false, "only once");
  assert.equal(w.update(T0 + GRACE + 5000), "requested");
  assert.equal(w.holdLogins(T0 + GRACE + 5000), true, "still held while the supervisor acts");
});

test("not extinct: someone alive, possibly alive (lost / unwatched) or on the way in", () => {
  for (const over of [{ living: 1 }, { inWorld: 1 }, { living: 2, inWorld: 0 }]) {
    const { w } = world(over);
    assert.equal(w.update(T0), "alive");
    assert.equal(w.holdLogins(T0), false);
    assert.equal(w.due(T0 + 10 * GRACE), false);
  }
});

test("a fresh run that has had no life yet is not extinct (its starting logins flow)", () => {
  const { s, w } = world({ everLived: false });
  assert.equal(w.holdLogins(T0), false);
  assert.equal(w.due(T0 + 10 * GRACE), false);
  s.everLived = true; // first Eve born and died
  assert.equal(w.holdLogins(T0 + 10 * GRACE), true);
  assert.equal(w.due(T0 + 11 * GRACE), true, "grace counts from when it became extinct");
});

test("a halted, idle or paused run is not extinction: no hold, no request", () => {
  const { s, w } = world({ running: false });
  assert.equal(w.update(T0), "inactive");
  assert.equal(w.holdLogins(T0), false);
  assert.equal(w.due(T0 + 10 * GRACE), false);
  // extinct, then the run halts mid-grace: the timer resets
  s.running = true;
  assert.equal(w.update(T0 + 1000), "extinct");
  s.running = false;
  assert.equal(w.due(T0 + 1000 + GRACE), false);
  assert.equal(w.extinctSince, null);
});

test("a birth during the grace period cancels it; the next extinction starts a new grace period", () => {
  const { s, w } = world();
  assert.equal(w.update(T0), "extinct");
  s.inWorld = 1; // a login already past the gate (connecting)
  assert.equal(w.update(T0 + 60_000), "alive");
  assert.equal(w.holdLogins(T0 + 60_000), false);
  s.inWorld = 0;
  s.living = 1; // ...born
  assert.equal(w.due(T0 + GRACE), false);
  s.living = 0; // and died
  assert.equal(w.update(T0 + GRACE + 1), "extinct");
  assert.equal(w.due(T0 + 2 * GRACE), false);
  assert.equal(w.due(T0 + 2 * GRACE + 1), true);
});

test("disable() releases the hold and stops requests (the supervisor can't regenerate)", () => {
  const { w } = world();
  w.update(T0);
  assert.equal(w.due(T0 + GRACE), true);
  w.disable();
  assert.equal(w.holdLogins(T0 + GRACE), false);
  assert.equal(w.due(T0 + 10 * GRACE), false);
});

test("the login gate holds a respawn while extinct, races no tick, and lets it through once someone is back", async () => {
  // real LoginScheduler with the watch as its pause gate (as Population wires it)
  let now = T0;
  const sleeps: number[] = [];
  const { s, w } = world({ everLived: true });
  let wakeups = 0;
  const sched = new LoginScheduler(
    { agentCount: 2, initialEves: 0, joinStaggerMs: 0, joinJitter: 0, respawnDelayMinMs: 0, respawnDelayMaxMs: 0 },
    {
      now: () => now,
      random: () => 0.5,
      familyRoom: () => true,
      paused: () => w.holdLogins(now),
      sleep: (ms) => {
        sleeps.push(ms);
        now += ms;
        // someone (a slot that got in before the run went extinct) is born after 30 s of holding
        if (++wakeups === 30) s.living = 1;
        return Promise.resolve();
      },
    },
  );
  sched.onBorn("a01", true);
  sched.onDied("a01", now); // the last character died just now: the very next login check is held
  await sched.beforeLogin("a01", false);
  assert.equal(wakeups, 30, "held until someone was alive again");
  assert.equal(w.due(now + GRACE), false, "and the grace period was cancelled");
});

test("regenSettingsFromEnv: on by default in CONTINUOUS only, REGEN_ON_EXTINCTION=0 turns it off", () => {
  assert.equal(regenSettingsFromEnv({}, true).enabled, true);
  assert.equal(regenSettingsFromEnv({}, false).enabled, false);
  assert.equal(regenSettingsFromEnv({ REGEN_ON_EXTINCTION: "1" }, false).enabled, false);
  assert.equal(regenSettingsFromEnv({ REGEN_ON_EXTINCTION: "0" }, true).enabled, false);
  const s = regenSettingsFromEnv({ EXTINCT_GRACE_S: "30", REGEN_REQUEST_FILE: "/x/req.json", SUPERVISOR_PIDFILE: "/x/pid" }, true);
  assert.deepEqual([s.graceMs, s.requestFile, s.pidFile], [30_000, "/x/req.json", "/x/pid"]);
  const d = regenSettingsFromEnv({}, true);
  assert.deepEqual([d.graceMs, d.requestFile, d.pidFile], [180_000, null, "/tmp/as-supervisor.pid"]);
});

test("requestRegen: writes the reason, then SIGUSR2s the supervisor; says why when it can't", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "regen-"));
  try {
    const requestFile = path.join(dir, "worlds", "regen-request.json");
    const pidFile = path.join(dir, "sup.pid");
    const sent: [number, string, boolean][] = [];
    const kill = (pid: number, sig: NodeJS.Signals) => void sent.push([pid, sig, existsSync(requestFile)]);
    const req = { reason: "no living characters for 180s", runId: "as-r1-x", at: T0 };

    assert.match(requestRegen({ requestFile: null, pidFile }, req, kill)!, /REGEN_REQUEST_FILE/);
    assert.match(requestRegen({ requestFile, pidFile }, req, kill)!, /no supervisor pid file/);
    writeFileSync(pidFile, "garbage\n");
    assert.match(requestRegen({ requestFile, pidFile }, req, kill)!, /bad pid/);
    assert.deepEqual(sent, []);

    writeFileSync(pidFile, "4242\n");
    assert.equal(requestRegen({ requestFile, pidFile }, req, kill), null);
    assert.deepEqual(sent, [[4242, "SIGUSR2", true]], "the request is on disk before the signal");
    assert.deepEqual(JSON.parse(readFileSync(requestFile, "utf8")), req);

    const err = requestRegen({ requestFile, pidFile }, req, () => {
      throw new Error("ESRCH");
    });
    assert.match(err!, /can't signal the supervisor \(pid 4242\): ESRCH/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("new-run flag: plain flags still work; a regeneration record comes back as the new run's event text", () => {
  assert.equal(parseWorldRegenerated(null), null);
  assert.equal(parseWorldRegenerated(""), null);
  assert.equal(parseWorldRegenerated("{oops"), null);
  assert.equal(parseWorldRegenerated('{"other":1}'), null);
  const w = parseWorldRegenerated(JSON.stringify({ worldRegenerated: true, reason: "no living characters for 180s", previousRunId: "as-r4-x", archive: "/data/worlds/archive/20261117T120000Z" }))!;
  assert.equal(
    worldRegeneratedText(w),
    "world regenerated: no living characters for 180s; previous run as-r4-x; old world archived to /data/worlds/archive/20261117T120000Z",
  );
  assert.match(worldRegeneratedText({ worldRegenerated: true, archive: null }), /old world not archived$/);
  // what start.sh writes
  const fromSupervisor = parseWorldRegenerated(
    '{"worldRegenerated":true,"at":"20261117T120000Z","archive":"/a/20261117T120000Z","request":{"reason":"no living characters for 180s (run as-r4-x)","runId":"as-r4-x","at":5}}\n',
  )!;
  assert.deepEqual(fromSupervisor, {
    worldRegenerated: true, reason: "no living characters for 180s (run as-r4-x)", previousRunId: "as-r4-x", requestedAt: 5,
    archive: "/a/20261117T120000Z", at: "20261117T120000Z",
  });
  assert.deepEqual(parseWorldRegenerated('{"worldRegenerated":true,"at":"x","archive":null,"request":operator wiped it}'), { worldRegenerated: true });

  const dir = mkdtempSync(path.join(tmpdir(), "regenflag-"));
  try {
    const f = new RunStateFile(dir);
    assert.equal(f.takeNewRunFlagContent(), null);
    writeFileSync(f.flagFile, "");
    assert.equal(f.takeNewRunFlagContent(), "");
    assert.equal(existsSync(f.flagFile), false, "one-shot");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("RunController: after a regeneration the fresh run says so in its events; the old run's lives are untouched", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "regenrun-"));
  const gd = { name: () => "x" } as unknown as GameData;
  const cfg: Config = {
    ...config, logDir: dir, runId: "as", continuous: true, narratorIntervalMs: 0, directorIntervalMs: 0, storyIntervalMs: 0,
    llmApiKey: "", newRun: false, gameServerEpoch: "", agentCount: 2, oholPort: 9,
  };
  const regen = { enabled: true, graceMs: GRACE, requestFile: null, pidFile: path.join(dir, "none.pid"), timeoutMs: 1000 };
  const quiet = console.log;
  console.log = () => {};
  try {
    const a = new RunController(cfg, gd, regen);
    const oldId = a.runId!;
    const ev = new FakeEvents();
    a.lives.handle(oldId, a.log.dir, ev.eve("a01", 10));
    a.lives.handle(oldId, a.log.dir, ev.death("a01", 10));
    assert.deepEqual(a.lives.runPopulation(oldId), { total: 1, living: 0 });
    a.shutdown();
    const before = new LifeStore({ logDir: dir, dims: cfg.traitDims, mutationSd: 0.15, traitSource: "mock", rng: seededRng(1) });
    before.load();
    const oldLife = JSON.stringify(before.get(`${oldId}:10`));

    // what start.sh leaves behind after wiping the world
    const flag = new RunStateFile(dir).flagFile;
    writeFileSync(flag, JSON.stringify({ worldRegenerated: true, reason: "no living characters for 180s", previousRunId: oldId, archive: "/w/archive/1" }));
    const b = new RunController(cfg, gd, regen);
    const events: RunEvent[] = b.log.recent;
    assert.notEqual(b.runId, oldId, "fresh run");
    assert.equal(existsSync(flag), false);
    const e = events.find((x) => x.kind === "system" && /^world regenerated: /.test(x.text));
    assert.ok(e, "world regenerated event in the new run");
    assert.match(e!.text, new RegExp(`previous run ${oldId}; old world archived to /w/archive/1`));
    assert.equal(JSON.stringify(b.lives.get(`${oldId}:10`)), oldLife, "old run's life untouched");
    b.shutdown();
  } finally {
    console.log = quiet;
    rmSync(dir, { recursive: true, force: true });
  }
});
