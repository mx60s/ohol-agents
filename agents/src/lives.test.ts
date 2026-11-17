import { test } from "node:test";
import assert from "node:assert/strict";
import { LifeBook, classifyAction, computeLineages, presumedEndAt, toRecord } from "./lives.ts";
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
