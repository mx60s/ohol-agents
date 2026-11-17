// Inventions: what counts as a first (event parsing), what counts as technology (game data), the log.
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { GameData } from "./game/gameData.ts";
import { InventionLog, InventionRule, madeNames } from "./inventions.ts";
import { FakeEvents } from "./test-helpers.ts";

const gd = new GameData();
const rule = new InventionRule(gd);
const isInv = (name: string) => {
  const id = rule.idOf(name);
  assert.ok(id != null, `no object ${name}`);
  return rule.isInvention(id);
};

test("madeNames: afters that weren't befores; pickups and taking out of containers are not made", () => {
  // real action texts (fixture live1)
  assert.deepEqual(madeNames("use (41, -117) -> use: tile (41,-117) Harvested Tule -> Tule Stumps with Basket; holding Reed Bundle -> nothing"), ["Tule Stumps with Basket"]);
  assert.deepEqual(madeNames("use (41, -117) -> use: tile (41,-117) Tule Stumps with Basket -> Tule Stumps; holding nothing -> Basket"), ["Tule Stumps", "Basket"]);
  assert.deepEqual(madeNames("use (37, -113) -> use: tile (37,-113) Rope -> nothing; holding nothing -> Rope"), [], "pickup");
  assert.deepEqual(madeNames("drop (40, -119) -> drop: tile (40,-119) nothing -> Basket; holding Basket -> nothing"), [], "drop");
  assert.deepEqual(madeNames("drop (40, -119) -> drop: tile (40,-119) Basket -> Basket containing Rope; holding Rope -> nothing"), [], "into a basket");
  assert.deepEqual(madeNames("use (40, -119) -> use: tile (40,-119) Basket containing 2 Rope, Sharp Stone -> Basket containing Rope, Sharp Stone; holding nothing -> Rope"), [], "out of a basket");
  assert.deepEqual(madeNames("use (39, -110) -> use: tile (39,-110) Flint -> Flint Chips"), ["Flint Chips"]);
  assert.deepEqual(madeNames("use (5, 5) -> use: tile (5,5) Pile of Sharp Stones -> Pile of Sharp Stones (4/5 left); holding nothing -> Sharp Stone"), ["Pile of Sharp Stones (4/5 left)", "Sharp Stone"]);
  assert.deepEqual(madeNames("go (1, 2) -> arrived"), []);
  assert.deepEqual(madeNames("use (1, 1) -> use: holding nothing -> baby Hope"), [], "babies");
  assert.deepEqual(madeNames("forage (39, -118) -> drop: tile (40,-116) nothing -> Rope; holding Rope -> nothing; ate Gooseberry; food 3 -> 8/9"), []);
});

test("madeNames: the craft macro's goal and every step's products, done or stopped", () => {
  assert.deepEqual(madeNames("craft fire -> crafted Fire in 1 step (Burning Tinder on Kindling -> Fire); it's at (3, 4)"), ["Fire"]);
  assert.deepEqual(
    madeNames("craft Stone Hatchet -> crafted Stone Hatchet in 3 steps (Stone on Big Hard Rock -> Sharp Stone; Rope on Short Shaft -> Tied Short Shaft; Sharp Stone on Tied Short Shaft -> Stone Hatchet); it's in your hands"),
    ["Stone Hatchet", "Sharp Stone", "Tied Short Shaft"],
  );
  assert.deepEqual(
    madeNames("craft Reed Skirt -> craft Reed Skirt: did 2: bare hands on Harvested Tule -> Reed Bundle + Tule Stumps; wait for Milkweed to become Flowering Milkweed. Stopped (no Rope in view). 1 step left; next: Rope on Reed Bundle -> Reed Skirt. Use craft again to continue."),
    ["Reed Bundle", "Tule Stumps"],
  );
  assert.deepEqual(madeNames("craft Basket -> craft Basket: made no progress. Stopped (nothing to make it from)."), []);
});

test("rule: technology counts (crafted / transformed items)", () => {
  for (const n of ["Sharp Stone", "Kindling", "Fire Bow Drill", "Reed Skirt", "Basket", "Rope", "Thread", "Fire", "Stone Hatchet", "Clay Bowl", "Adobe", "Long Straight Shaft", "Skewer", "Reed Bundle"])
    assert.ok(isInv(n), n);
});

test("rule: food, natural objects and their states, hand-gathered raw materials, X-with-Y states don't count", () => {
  // food
  for (const n of ["Gooseberry", "Wild Carrot", "Burdock Root"]) assert.equal(isInv(n), false, n);
  // natural (map) objects and what they become in place
  for (const n of ["Big Hard Rock", "Stone", "Tule Reeds", "Flowering Milkweed", "Milkweed Debris", "Empty Wild Gooseberry Bush", "Harvested Tule", "Tule Stumps", "Dug Wild Carrot"])
    assert.equal(isInv(n), false, n);
  // picked off the land by hand
  for (const n of ["Milkweed Stalk", "Leaf", "Straight Branch", "Clay", "Juniper Tinder", "Yew Branch"]) assert.equal(isInv(n), false, n);
  // one thing sitting on another
  assert.equal(isInv("Tule Stumps with Basket"), false);
  // use states map to their base object
  assert.equal(rule.idOf("Flint Chips (2/3 left)"), rule.idOf("Flint Chips"));
  assert.equal(rule.idOf("Basket containing Rope"), rule.idOf("Basket"));
  assert.equal(rule.idOf("no such thing"), null);
});

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), "inv-"));
  const f = new FakeEvents();
  const state = { runId: "run1" as string | null };
  const mk = () => new InventionLog(gd, { runId: () => state.runId, lifeOf: (runId, _a, pid) => (pid != null ? `${runId}:${pid}` : null) }, { logDir: dir });
  return { dir, f, state, mk, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const KNAP = "use (1, 2) -> use: tile (1,2) Big Hard Rock -> Big Hard Rock; holding Stone -> Sharp Stone";

test("log: one entry per item per run, with maker, life and time; trivia and pickups ignored", () => {
  const { f, state, mk, cleanup } = setup();
  try {
    const log = mk();
    const e1 = { ...f.action("a01", 10, KNAP, {}), name: "EVE ROSE" };
    const got = log.observe(e1);
    assert.deepEqual(got, [{ item: "Sharp Stone", objectId: 34, lifeId: "run1:10", name: "EVE ROSE", t: e1.t, runId: "run1" }]);
    assert.deepEqual(log.observe(f.action("a02", 11, KNAP, {})), [], "second Sharp Stone in the same run");
    assert.deepEqual(log.observe(f.action("a02", 11, "use (1, 2) -> use: tile (1,2) Wild Gooseberry Bush -> Wild Gooseberry Bush; holding nothing -> Gooseberry", {})), [], "food");
    assert.deepEqual(log.observe(f.action("a02", 11, "use (1, 2) -> use: tile (1,2) Flowering Milkweed -> Milkweed Debris; holding nothing -> Milkweed Stalk", {})), [], "gathering");
    assert.deepEqual(log.observe(f.action("a02", 11, "use (1, 2) -> use: tile (1,2) Kindling -> nothing; holding nothing -> Kindling", {})), [], "pickup");
    assert.deepEqual(log.observe(f.ev("thought", "a02", 11, undefined, { text: "holding nothing -> Kindling" })), [], "not an action");
    // the craft macro: goal and intermediate steps, in one event
    const c = log.observe(f.action("a02", 11, "craft Stone Hatchet -> crafted Stone Hatchet in 2 steps (Rope on Short Shaft -> Tied Short Shaft; Sharp Stone on Tied Short Shaft -> Stone Hatchet); it's in your hands", {}));
    assert.deepEqual(c.map((x) => x.item).sort(), ["Stone Hatchet", "Tied Short Shaft"]);
    assert.ok(c.every((x) => x.lifeId === "run1:11" && x.name === null));
    // explicit craft events (data with object ids or names)
    assert.deepEqual(log.observe(f.ev("craft", "a01", 10, { newActor: 128, newTarget: 0 })).map((x) => x.item), ["Reed Skirt"]);
    // newest first
    assert.deepEqual(log.list(3).map((x) => x.item), ["Reed Skirt", c[1].item, c[0].item]);
    // a new run (world) starts its own firsts
    state.runId = "run2";
    assert.equal(log.observe(f.action("a01", 50, KNAP, {})).length, 1);
    assert.deepEqual(log.list(20).map((x) => x.item), ["Sharp Stone"]);
    assert.equal(log.list(20, "run1").length, 4);
    assert.equal(log.list(20, "all").length, 5);
    // no run, or no agent: nothing
    state.runId = null;
    assert.deepEqual(log.observe(f.action("a01", 50, "use (0, 0) -> use: tile (0,0) Reed Bundle -> Reed Skirt; holding Rope -> nothing", {})), []);
  } finally {
    cleanup();
  }
});

test("log: persisted in LOG_DIR/inventions.jsonl, survives a restart (no duplicates after), torn last line skipped", () => {
  const { dir, f, mk, cleanup } = setup();
  try {
    const a = mk();
    a.observe(f.action("a01", 10, KNAP, {}));
    a.observe(f.action("a01", 10, "use (0, 0) -> use: tile (0,0) Reed Bundle -> Reed Skirt; holding Rope -> nothing", {}));
    const file = path.join(dir, "inventions.jsonl");
    assert.equal(readFileSync(file, "utf8").trim().split("\n").length, 2);
    appendFileSync(file, '{"item":"Bask'); // crash mid-write

    const b = mk(); // restart / hot update
    assert.deepEqual(b.list(10).map((x) => x.item), ["Reed Skirt", "Sharp Stone"]);
    assert.deepEqual(b.observe(f.action("a02", 11, KNAP, {})), [], "still known after the restart");
    assert.equal(b.observe(f.action("a02", 11, "use (41, -117) -> use: tile (41,-117) Tule Stumps with Basket -> Tule Stumps; holding nothing -> Basket", {})).length, 1);
    assert.deepEqual(mk().list(10).map((x) => x.item), ["Basket", "Reed Skirt", "Sharp Stone"]);
  } finally {
    cleanup();
  }
});
