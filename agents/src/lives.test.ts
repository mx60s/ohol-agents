import { test } from "node:test";
import assert from "node:assert/strict";
import { LifeBook, classifyAction, computeLineages, presumedEndAt, toDeath, toRecord, yearMsOf } from "./lives.ts";
import { seededRng } from "./traits.ts";
import { FakeEvents } from "./test-helpers.ts";

const DIMS = ["a", "b"];
const book = () => new LifeBook({ dims: DIMS, mutationSd: 0.15, traitSource: "mock", rng: seededRng(1) });
const R = "run1";

test("Eve, child of our agent, child of an unknown mother", () => {
  const b = book();
  const f = new FakeEvents();
  b.apply(R, f.eve("a01", 10));
  const eve = b.get("run1:10")!;
  assert.equal(eve.lineageId, "run1:10");
  assert.equal(eve.generation, 1);
  assert.equal(eve.inherited, false);
  assert.equal(eve.traitSource, "mock");
  assert.deepEqual(Object.keys(eve.traits!), DIMS);
  assert.equal(eve.ageAtBirth, 14);

  b.apply(R, f.child("a02", 11, 10));
  const kid = b.get("run1:11")!;
  assert.equal(kid.inherited, true);
  assert.equal(kid.motherLifeId, "run1:10");
  assert.equal(kid.lineageId, "run1:10");
  assert.equal(kid.generation, 2);
  assert.deepEqual(eve.childLifeIds, ["run1:11"]);
  for (const d of DIMS) assert.ok(Math.abs(kid.traits![d] - eve.traits![d]) < 1);

  b.apply(R, f.child("a03", 12, 999, 4));
  const orphan = b.get("run1:12")!;
  assert.equal(orphan.inherited, false);
  assert.equal(orphan.motherLifeId, null);
  assert.equal(orphan.motherPlayerId, 999);
  assert.equal(orphan.lineageId, "run1:12");
  assert.equal(orphan.generation, 4);

  const lin = computeLineages(b.lives.values(), DIMS, f.t);
  const founded = lin.find((l) => l.lineageId === "run1:12")!;
  assert.equal(founded.founderIsEve, false);
  assert.equal(lin.find((l) => l.lineageId === "run1:10")!.founderIsEve, true);
});

test("names, deaths, and non-agent events", () => {
  const b = book();
  const f = new FakeEvents();
  b.apply(R, f.eve("a01", 10));
  assert.equal(b.apply(R, f.ev("system", null, null)).life, null);
  const r = b.apply(R, f.ev("thought", "a01", 10, undefined, { name: "HOPE STONE" }));
  assert.equal(r.important, true);
  assert.equal(b.get("run1:10")!.name, "HOPE STONE");
  b.apply(R, f.death("a01", 10, 31.234, "reason_hunger"));
  const l = toRecord(b.get("run1:10")!);
  assert.equal(l.status, "dead");
  assert.equal(l.ageAtDeath, 31.23);
  assert.equal(l.deathReason, "hunger");
  assert.equal(l.activity.thoughts, 1);
});

test("same body again (reconnect) keeps the life; a slot's new life marks the old one lost", () => {
  const b = book();
  const f = new FakeEvents();
  b.apply(R, f.eve("a01", 10));
  const traits = { ...b.get("run1:10")!.traits };
  const again = b.apply(R, f.eve("a01", 10));
  assert.equal(again.created, false);
  assert.deepEqual(b.get("run1:10")!.traits, traits);
  b.apply(R, f.eve("a01", 20));
  assert.equal(toRecord(b.get("run1:10")!).status, "lost");
  assert.equal(toRecord(b.get("run1:20")!).status, "alive");
});

test("activity classification", () => {
  const c = (text: string, data: Record<string, unknown>) => classifyAction({ text, data });
  assert.deepEqual(c("go (3, 4) -> arrived", { action: { type: "go" } }), { actions: 1, moves: 1 });
  assert.deepEqual(c("reflex forage -> ate Gooseberry; food 2 -> 5/10", { reflex: true }), { actions: 1, eat: 1, forage: 1, reflexForage: 1 });
  assert.equal(c("use (1, 1) -> use: tile (1,1) Bush -> Bush; holding nothing -> Gooseberry", { action: { type: "use" } }).pickUp, 1);
  assert.equal(c("use (1, 1) -> x", { action: { type: "use" }, heldBefore: "Round Stone", heldAfter: "Sharp Stone" }).craft, 1);
  assert.equal(c("use (1, 1) -> use: tile (1,1) nothing -> Stone; holding Stone -> nothing", { action: { type: "use" } }).drop, 1);
  const fail = c("use (1, 1) -> use at (1,1): nothing happened", { action: { type: "use" }, heldBefore: "Stone", heldAfter: "Stone" });
  assert.equal(fail.failedActions, 1);
  assert.equal(fail.craft, undefined);
  assert.equal(c("pick_up_baby #5 -> picked up baby EVA", { action: { type: "pick_up_baby" } }).babyPickups, 1);
  assert.equal(c("feed #5 -> gave/used Berry on #5; now holding nothing", { action: { type: "feed" } }).feeds, 1);
  assert.equal(c("wear -> use on self: holding Skirt -> nothing", { action: { type: "wear" } }).wear, 1);

  const b = book();
  const f = new FakeEvents();
  b.apply(R, f.eve("a01", 10, 100, 100));
  b.apply(R, f.action("a01", 10, "go (110, 95) -> arrived", { action: { type: "go" }, from: [100, 100], to: [110, 95] }));
  b.apply(R, f.action("a01", 10, "go (104, 95) -> arrived", { action: { type: "go" }, from: [110, 95], to: [104, 95] }));
  b.apply(R, f.ev("say", "a01", 10, { playerId: 10, heardBy: ["a02"] }));
  b.apply(R, f.ev("say", "a01", 10, { playerId: 10, heardBy: [] }));
  const a = b.get("run1:10")!.activity;
  assert.equal(a.tilesWalked, 16);
  assert.equal(a.maxDistFromBirth, 10);
  assert.equal(a.moves, 2);
  assert.equal(a.says, 2);
  assert.equal(a.saysHeard, 1);
});

test("lineage extinction: living members, deaths, lost members", () => {
  const b = book();
  const f = new FakeEvents();
  b.apply(R, f.eve("a01", 10));
  b.apply(R, f.child("a02", 11, 10));
  b.apply(R, f.death("a01", 10));
  let lin = computeLineages(b.lives.values(), DIMS, f.t)[0];
  assert.equal(lin.extinctAt, null);
  assert.equal(lin.living, 1);
  assert.deepEqual(lin.livingLifeIds, ["run1:11"]);
  assert.equal(lin.totalLives, 2);
  assert.equal(lin.maxGeneration, 2);
  const eve = b.get("run1:10")!;
  const kid = b.get("run1:11")!;
  for (const d of DIMS) assert.equal(lin.meanTraits[d], Math.round(((eve.traits![d] + kid.traits![d]) / 2) * 1e4) / 1e4);

  // the child is lost (run stopped): still possibly alive until its presumed end
  b.markLost((l) => l.runId === R, f.t);
  const end = presumedEndAt(kid);
  assert.equal(toRecord(kid).presumedEndAt, end);
  assert.equal(computeLineages(b.lives.values(), DIMS, end - 1)[0].extinctAt, null);
  lin = computeLineages(b.lives.values(), DIMS, end + 1)[0];
  assert.equal(lin.extinctAt, end);
  assert.equal(lin.living, 0);
});

test("lineage extinct when every member died; extinctAt = last death", () => {
  const b = book();
  const f = new FakeEvents();
  b.apply(R, f.eve("a01", 10));
  b.apply(R, f.child("a02", 11, 10));
  b.apply(R, f.death("a02", 11));
  const kidDeath = f.t;
  assert.equal(computeLineages(b.lives.values(), DIMS, f.t)[0].extinctAt, null);
  b.apply(R, f.death("a01", 10));
  assert.equal(computeLineages(b.lives.values(), DIMS, f.t)[0].extinctAt, f.t);
  assert.ok(f.t > kidDeath);
});

test("a lost mother from an earlier run can still pass on traits", () => {
  const b = book();
  const f = new FakeEvents();
  b.apply("old", f.eve("a01", 10));
  b.markLost((l) => l.runId === "old", f.t);
  f.wait(10 * 60_000);
  b.apply("new", f.child("a01", 11, 10));
  const kid = b.get("new:11")!;
  assert.equal(kid.motherLifeId, "old:10");
  assert.equal(kid.inherited, true);
  assert.equal(kid.lineageId, "old:10");
  // ...but not once she must be dead of old age
  f.wait(2 * 60 * 60_000);
  b.apply("new", f.child("a02", 12, 10));
  assert.equal(b.get("new:12")!.inherited, false);
});

test("game-server restart mid-run: recycled player ids become new lives, not merged into old records", () => {
  // live run dev1-r1: after the game server restarted, ids 2..70 were handed out again and every new
  // character was merged into the dead record with the same id (e.g. :2, Eve Dawn, died at 26.4)
  const b = book();
  const f = new FakeEvents();
  b.apply(R, f.eve("a01", 2));
  b.apply(R, f.child("a02", 3, 2));
  b.apply(R, f.death("a01", 2, 26.4));
  b.apply(R, f.ev("thought", "a02", 3));
  for (let p = 4; p <= 70; p++) b.apply(R, f.eve("a03", p));
  f.wait(60_000);
  // server restarted: a04 is born as a new Eve with id 2, a02 gets id 3 as her baby
  b.apply(R, f.eve("a04", 2));
  b.apply(R, f.child("a02", 3, 2));
  const oldEve = b.get("run1:2")!;
  assert.equal(oldEve.agentId, "a01", "old record untouched");
  assert.equal(oldEve.ageAtDeath, 26.4);
  assert.deepEqual(oldEve.childLifeIds, ["run1:3"]);
  const newEve = b.get("run1.2:2")!;
  assert.ok(newEve, "new life gets its own id");
  assert.equal(newEve.agentId, "a04");
  assert.equal(newEve.diedAt, null);
  const kid = b.get("run1.2:3")!;
  assert.equal(kid.motherLifeId, "run1.2:2", "baby attached to the new Eve, not the dead one");
  assert.equal(kid.lineageId, "run1.2:2");
  assert.equal(b.get("run1:3")!.lostAt != null, true, "a02's previous life (never seen dying) is marked lost");
  // later events for id 2 land on the new life; its death is recorded
  b.apply(R, f.death("a04", 2, 30));
  assert.equal(b.get("run1.2:2")!.ageAtDeath, 30);
  assert.equal(b.get("run1:2")!.ageAtDeath, 26.4);
});

test("after a game-server restart, a pre-restart life can't be a mother or a live player's identity", () => {
  const b = book();
  const f = new FakeEvents();
  b.apply("old", f.eve("a01", 50)); // alive when the old process stopped
  b.markLost((l) => l.runId === "old", f.t);
  f.wait(60_000);
  // new process, restarted game server: ids start low again
  b.apply("new", f.eve("a02", 10));
  f.wait(1000);
  // id 50 now belongs to someone else in the new world (not one of ours)
  b.apply("new", f.child("a03", 51, 50));
  const kid = b.get("new:51")!;
  assert.equal(kid.motherLifeId, null, "the old lost Eve #50 is not this baby's mother");
  assert.equal(kid.inherited, false);
  assert.equal(b.findByPlayer(50, f.t), null);
});

test("reconnect with the same login is still the same life", () => {
  const b = book();
  const f = new FakeEvents();
  b.apply(R, f.eve("a01", 10));
  b.apply(R, f.child("a02", 11, 10)); // other births in between: ids moved on
  f.wait(5 * 60_000);
  b.apply(R, f.ev("birth", "a01", 10, { playerId: 10, motherId: null, eve: true, generation: 1, age: 14 + 5.1 }));
  assert.equal(b.lives.size, 2);
  assert.equal(b.get("run1:10")!.lostAt, null);
});

test("age at death is capped at 60 (live data had 82 and 84 after a server stall); old records are repaired on load", () => {
  const b = book();
  const f = new FakeEvents();
  b.apply(R, f.eve("a01", 10));
  b.apply(R, f.death("a01", 10, 84.33868, "reason_age"));
  assert.equal(b.get("run1:10")!.ageAtDeath, 60);
  const stored = { ...b.get("run1:10")!, lifeId: "run1:11", playerId: 11, ageAtDeath: 82.06 };
  const b2 = book();
  b2.load(stored);
  assert.equal(b2.get("run1:11")!.ageAtDeath, 60);
});

test("time scale: each life keeps the k it was born under; presumedEnd and reconnect ages use it; old records = 1", () => {
  const f = new FakeEvents();
  const slow = new LifeBook({ dims: DIMS, mutationSd: 0.15, traitSource: "mock", rng: seededRng(1), timeScale: 3 });
  slow.apply("slowRun", f.eve("a01", 10));
  const eve = slow.get("slowRun:10")!;
  assert.equal(eve.timeScale, 3);
  assert.equal(yearMsOf(eve), 180_000);
  assert.equal(toRecord(eve).timeScale, 3);
  // Eve (age 14) lost: may live on for 46 more game years of 3 wall minutes each
  slow.markLost(() => true, f.t);
  assert.equal(presumedEndAt(eve), eve.bornAt + 46 * 180_000);
  assert.equal(toRecord(eve).presumedEndAt, eve.bornAt + 46 * 180_000);

  // reconnect 10 wall minutes later at k=3: 14 + 3.33 years (k=1 would expect 24)
  const b = new LifeBook({ dims: DIMS, mutationSd: 0.15, traitSource: "mock", rng: seededRng(1), timeScale: 3 });
  b.apply(R, f.eve("a01", 20));
  f.wait(10 * 60_000);
  b.apply(R, f.ev("birth", "a01", 20, { playerId: 20, motherId: null, eve: true, generation: 1, age: 17.4 }));
  assert.equal(b.lives.size, 1, "same body under the life's own clock");

  // a record written before lives carried a time scale loads as k = 1, next to a k = 3 life
  const { timeScale: _drop, ...old } = { ...eve, lifeId: "old:1", runId: "old", playerId: 1 };
  const mixed = book();
  mixed.load(old as typeof eve);
  mixed.load({ ...eve });
  assert.equal(mixed.get("old:1")!.timeScale, 1);
  assert.equal(presumedEndAt(mixed.get("old:1")!), eve.bornAt + 46 * 60_000);
  assert.equal(presumedEndAt(mixed.get("slowRun:10")!), eve.bornAt + 46 * 180_000);

  slow.apply("slowRun", f.death("a01", 10, 40));
  assert.equal(toDeath(slow.get("slowRun:10")!).timeScale, 3);
});

test("turn clock: a resumed body's age may lag wall time (never run ahead of it)", () => {
  for (const lags of [true, false]) {
    const f = new FakeEvents();
    const b = new LifeBook({ dims: DIMS, mutationSd: 0.15, traitSource: "mock", rng: seededRng(1), gameClockLags: lags });
    b.apply(R, f.eve("a01", 10));
    b.apply(R, f.child("a02", 20, 10));
    // 20 wall minutes later (20 years by wall time), the baby is 3 by the game clock
    f.wait(20 * 60_000);
    const back = b.reconnectOf(R, "a02", 20, f.t, 3);
    b.apply(R, f.ev("birth", "a02", 20, { playerId: 20, motherId: 10, eve: false, generation: 2, age: 3 }));
    if (lags) {
      assert.equal(back?.lifeId, "run1:20", "same life");
      assert.equal(b.lives.size, 2, "no new life");
      // still rejected: younger than at birth, or older than wall time allows
      assert.equal(b.reconnectOf(R, "a01", 10, f.t, 12), null);
      assert.equal(b.reconnectOf(R, "a01", 10, f.t, 40), null);
      assert.ok(b.reconnectOf(R, "a01", 10, f.t, 15));
    } else {
      assert.equal(back, null, "wall-time expectation (20) is 17 years off");
      assert.equal(b.lives.size, 3);
    }
  }
});

test("flowers: distinct among living relatives, stable for life, a dead relative's can come back, reconnect keeps it", () => {
  const b = book();
  const f = new FakeEvents();
  b.apply(R, f.eve("a01", 10));
  for (let i = 0; i < 12; i++) b.apply(R, f.child(`k${i}`, 100 + i, 10));
  const living = () => [...b.lives.values()].filter((l) => l.diedAt == null);
  const fl = (id: string) => b.get(id)!.flower!;
  const keys = living().map((l) => `${l.flower!.shape}|${l.flower!.color}`);
  assert.equal(keys.length, 13);
  assert.equal(new Set(keys).size, 13, "13 living family members, 13 flowers");
  assert.deepEqual(toRecord(b.get("run1:100")!).flower, fl("run1:100"), "on the public record");

  const before = new Map(living().map((l) => [l.lifeId, { ...l.flower! }]));
  b.apply(R, f.death("k0", 100));
  b.apply(R, f.child("k20", 200, 10));
  b.apply(R, f.ev("thought", "a01", 10, undefined, { name: "EVE ROSE" }));
  for (const [id, flower] of before) assert.deepEqual(b.get(id)!.flower, flower, `${id} kept its flower`);
  const now = living().map((l) => `${l.flower!.shape}|${l.flower!.color}`);
  assert.equal(new Set(now).size, now.length);

  // reconnect (same body again) keeps the flower
  const eveFlower = { ...fl("run1:10") };
  assert.equal(b.apply(R, f.eve("a01", 10)).created, false);
  assert.deepEqual(fl("run1:10"), eveFlower);

  // a dead relative's flower is free again: some later baby picks it (with only Eve left alive,
  // so the dead one's shape isn't still worn by a living relative)
  for (let i = 1; i < 12; i++) b.apply(R, f.death(`k${i}`, 100 + i));
  b.apply(R, f.death("k20", 200));
  const dead = fl("run1:100");
  let reused = false;
  for (let i = 0; i < 200 && !reused; i++) {
    const id = 300 + i;
    b.apply(R, f.child(`r${i}`, id, 10));
    const g = fl(`run1:${id}`);
    if (g.shape === dead.shape && g.color === dead.color) reused = true;
    b.apply(R, f.death(`r${i}`, id));
  }
  assert.ok(reused, "a later baby can wear a dead relative's flower");
});

test("assignMissingFlowers: old records get flowers distinct among contemporaries, valid ones untouched", () => {
  const b = book();
  const f = new FakeEvents();
  b.apply(R, f.eve("a01", 10));
  for (let i = 0; i < 5; i++) b.apply(R, f.child(`k${i}`, 100 + i, 10));
  const kept = { ...b.get("run1:100")!.flower! };
  for (const l of b.lives.values()) if (l.lifeId !== "run1:100") delete l.flower;
  b.get("run1:101")!.flower = { shape: "orchid", color: "teal", label: "teal orchid" };
  const changed = b.assignMissingFlowers();
  assert.equal(changed.length, 5);
  assert.deepEqual(b.get("run1:100")!.flower, kept);
  const keys = [...b.lives.values()].map((l) => `${l.flower!.shape}|${l.flower!.color}`);
  assert.equal(new Set(keys).size, 6);
  assert.equal(b.assignMissingFlowers().length, 0, "idempotent");
});

test("assignMissingFlowers: retired shapes map to their replacement (bellflower -> lily), daisy/tulip untouched", () => {
  const b = book();
  const f = new FakeEvents();
  b.apply(R, f.eve("a01", 10));
  b.apply(R, f.child("k0", 100, 10));
  b.apply(R, f.child("k1", 101, 10));
  b.get("run1:10")!.flower = { shape: "bell", color: "purple", label: "purple bellflower" };
  b.get("run1:100")!.flower = { shape: "daisy", color: "white", label: "white daisy" };
  b.get("run1:101")!.flower = { shape: "tulip", color: "red", label: "red tulip" };
  const changed = b.assignMissingFlowers();
  assert.deepEqual(changed.map((l) => l.lifeId), ["run1:10"]);
  assert.deepEqual(b.get("run1:10")!.flower, { shape: "lily", color: "purple", label: "purple lily" });
  assert.equal(b.get("run1:100")!.flower!.shape, "daisy");
  assert.equal(b.get("run1:101")!.flower!.shape, "tulip");
});

test("a ghost (age 60 past the usual end) reconnects as the same life; split records from before the fix are merged back", () => {
  // the ghost reconnect itself
  const b = book();
  const f = new FakeEvents();
  b.apply(R, f.eve("a01", 10));
  b.apply(R, f.child("a02", 11, 10));
  f.wait(50 * 60_000); // Eve (14 at birth) is past 60 by now: a ghost
  b.apply(R, f.ev("birth", "a01", 10, { playerId: 10, motherId: null, eve: true, generation: 1, age: 60 }));
  assert.equal(b.lives.size, 2, "no new life for the ghost");
  b.apply(R, f.ev("birth", "a02", 11, { playerId: 11, motherId: 10, generation: 2, age: 50 }));
  assert.equal(b.lives.size, 2, "later reconnects aren't mistaken for a server restart");

  // records split the old way: copies "<run>.2:<pid>", originals lost at the copy's birth, a later child motherless
  const s = book();
  const g = new FakeEvents();
  s.apply(R, g.eve("a01", 10));
  s.apply(R, g.child("a02", 11, 10));
  g.wait(50 * 60_000); // Eve 14 + 50 years: past 60, a ghost
  const split = g.t;
  const orig10 = s.get("run1:10")!, orig11 = s.get("run1:11")!;
  orig10.lostAt = split;
  orig11.lostAt = split;
  const copy = (o: typeof orig10, age: number) => ({ ...o, lifeId: `run1.2:${o.playerId}`, lineageId: `run1.2:${o.playerId}`, motherLifeId: null, bornAt: split, ageAtBirth: age, lostAt: null, childLifeIds: [], activity: { ...o.activity, thoughts: 5 } });
  s.load(copy(orig10, 60));
  s.load(copy(orig11, 50));
  s.load({ ...orig11, lifeId: "run1:12", playerId: 12, agentId: "a03", lineageId: "run1:12", motherLifeId: null, motherPlayerId: 11, generation: 3, bornAt: split + 60_000, ageAtBirth: 0, lostAt: null, childLifeIds: [] });
  const thoughtsBefore = orig11.activity.thoughts;
  const r = s.healSplitReconnects();
  assert.deepEqual(r.removed.sort(), ["run1.2:10", "run1.2:11"]);
  assert.equal(s.lives.size, 3);
  assert.equal(s.get("run1:10")!.lostAt, null);
  assert.equal(s.get("run1:11")!.lostAt, null);
  assert.equal(s.get("run1:11")!.activity.thoughts, thoughtsBefore + 5, "the copy's activity is added");
  const kid = s.get("run1:12")!;
  assert.equal(kid.motherLifeId, "run1:11");
  assert.equal(kid.lineageId, "run1:10");
  assert.ok(s.get("run1:11")!.childLifeIds.includes("run1:12"));
  assert.equal(s.healSplitReconnects().removed.length, 0, "idempotent");
});
