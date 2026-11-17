// The craft planner on the real transition graph, and the executor end to end
// against the in-process fake server.
import { test } from "node:test";
import assert from "node:assert/strict";
import { GameData } from "./gameData.ts";
import { CraftPlanner, craftBudgetMs, estimateGameSeconds, runCraft, type Inventory } from "./craft.ts";
import { Body } from "./body.ts";
import { FakeGame } from "./fakeGame.ts";

const gd = new GameData();
const planner = new CraftPlanner(gd);
const id = (n: string) => {
  const v = gd.idByName(n);
  if (!v) throw new Error(`no object ${n}`);
  return v;
};
// trees that still have a branch ("Maple Tree#Branch") share the clean name with bare ones
const MAPLE = 63, POPLAR = 65;

function inv(held: string | null, ground: (string | number)[]): Inventory {
  const g = new Map<number, [number, number][]>();
  ground.forEach((n, i) => {
    const k = typeof n === "number" ? n : id(n);
    g.set(k, [...(g.get(k) ?? []), [i, 0]]);
  });
  return { held: held ? id(held) : 0, ground: g };
}

function steps(goal: string, i: Inventory): string[] {
  const r = planner.plan(id(goal), i);
  assert.ok(r.ok, r.ok ? "" : r.reason);
  return r.plan.steps.map((s) => planner.describeStep(s));
}

const MILKWEED4 = ["Milkweed", "Milkweed", "Milkweed", "Milkweed"];

test("Sharp Stone: Stone on Big Hard Rock", () => {
  assert.deepEqual(steps("Sharp Stone", inv(null, ["Stone", "Big Hard Rock"])), ["Stone on Big Hard Rock -> Sharp Stone"]);
});

test("Reed Skirt: sharp stone, reeds, two threads into rope, rope on reed bundle", () => {
  const s = steps("Reed Skirt", inv(null, ["Stone", "Big Hard Rock", "Tule Reeds", ...MILKWEED4]));
  assert.equal(s[0], "Stone on Big Hard Rock -> Sharp Stone");
  assert.ok(s.includes("Sharp Stone on Tule Reeds -> Harvested Tule"));
  assert.equal(s.filter((x) => x === "Milkweed Stalk on Milkweed Stalk -> Thread").length, 2, "counts copies: two threads");
  assert.ok(s.includes("Thread on Thread -> Rope"));
  assert.equal(s.at(-1), "Rope on Reed Bundle -> Reed Skirt");
});

test("Basket from two patches of tule with a sharp stone in hand", () => {
  const s = steps("Basket", inv("Sharp Stone", ["Tule Reeds", "Tule Reeds"]));
  assert.ok(s.filter((x) => x.startsWith("Sharp Stone on Tule Reeds")).length === 2, "needs both reed patches");
  assert.match(s.at(-1)!, /Basket/);
});

test("Kindling: the stone hatchet chain from raw materials", () => {
  const s = steps("Kindling", inv(null, ["Stone", "Big Hard Rock", ...MILKWEED4, MAPLE, MAPLE]));
  assert.ok(s.includes("Rope on Short Shaft -> Tied Short Shaft"));
  assert.ok(s.includes("Sharp Stone on Tied Short Shaft -> Stone Hatchet"));
  assert.match(s.at(-1)!, /^Stone Hatchet on .* -> .*Kindling/);
});

test("Fire Bow Drill: bow from curved shaft + rope, then a short shaft", () => {
  const s = steps("Fire Bow Drill", inv("Sharp Stone", [...MILKWEED4, POPLAR, MAPLE]));
  assert.ok(s.includes("Rope on Small Curved Shaft -> Bow Drill Bow"));
  assert.equal(s.at(-1), "Short Shaft on Bow Drill Bow -> Fire Bow Drill");
});

test("Fire: the full chain, with kindling ready before the tinder burns out", () => {
  const s = steps("Fire", inv("Sharp Stone", [...MILKWEED4, ...MILKWEED4, POPLAR, MAPLE, MAPLE, MAPLE, MAPLE, "Juniper Tree", "Leaf", "Stone", "Big Hard Rock"]));
  const kindling = s.findIndex((x) => /-> .*Kindling$/.test(x));
  const ember = s.indexOf("Fire Bow Drill on Long Straight Shaft -> Ember Shaft");
  assert.ok(kindling >= 0 && ember >= 0);
  assert.ok(kindling < ember, "kindling is made before the ember (Burning Tinder lasts 10 s)");
  assert.equal(s.at(-2), "wait for Smoldering Tinder to become Burning Tinder");
  assert.equal(s.at(-1), "Kindling on Burning Tinder -> Fire");
  // Juniper Tinder rots 120 s after gathering: gathered right before the ember, not 20 steps earlier
  assert.equal(s[ember - 1], "bare hands on Juniper Tree -> Juniper Tinder");
});

test("Fire without a Leaf in view: Leaf and Juniper Tinder are gathered last, just before the ember", () => {
  const s = steps("Fire", inv("Sharp Stone", [...MILKWEED4, ...MILKWEED4, POPLAR, MAPLE, MAPLE, MAPLE, MAPLE, "Juniper Tree", "Stone", "Big Hard Rock"]));
  const ember = s.indexOf("Fire Bow Drill on Long Straight Shaft -> Ember Shaft");
  assert.deepEqual(s.slice(ember - 2, ember).sort(), ["bare hands on Juniper Tree -> Juniper Tinder", "bare hands on Lombardy Poplar Tree -> Leaf"]);
  assert.equal(s[ember - 3], "Short Shaft on Bow Drill Bow -> Fire Bow Drill");
  assert.equal(s[ember + 1], "Leaf on Ember Shaft -> Ember Leaf + Long Straight Shaft", "the ember chain itself is not reordered");
});

test("perishable ingredients are used well within their decay time, for any goal", () => {
  const cases: [string, Inventory][] = [
    ["Fire", inv("Sharp Stone", [...MILKWEED4, ...MILKWEED4, POPLAR, MAPLE, MAPLE, MAPLE, MAPLE, "Juniper Tree", "Stone", "Big Hard Rock"])],
    ["Fire", inv(null, [...MILKWEED4, ...MILKWEED4, POPLAR, MAPLE, MAPLE, MAPLE, MAPLE, "Juniper Tree", "Stone", "Big Hard Rock", "Stone"])],
    ["Kindling", inv(null, ["Stone", "Big Hard Rock", ...MILKWEED4, MAPLE, MAPLE])],
    ["Reed Skirt", inv(null, ["Stone", "Big Hard Rock", "Tule Reeds", ...MILKWEED4])],
  ];
  let checked = 0;
  for (const [goal, i] of cases) {
    const r = planner.plan(id(goal), i);
    assert.ok(r.ok, goal);
    const st = r.plan.steps;
    st.forEach((s, k) => {
      for (const p of [s.t.newActor, s.t.newTarget]) {
        const d = planner.decaySeconds(p);
        if (!(d > 0) || p === s.t.actor || p === s.t.target) continue;
        const use = st.findIndex((u, m) => m > k && (u.t.actor === p || u.t.target === p));
        if (use < 0) continue;
        checked++;
        assert.ok(estimateGameSeconds(use - k - 1) * 2 < d, `${goal}: ${planner.describeStep(s)} at step ${k}, used at step ${use} (decays in ${d} s)`);
      }
    });
  }
  assert.ok(checked >= 4, "the cases include perishables");
});

test("the craft time budget is game time: it scales with TIME_SCALE", () => {
  assert.equal(craftBudgetMs(8000, 1), 64_000);
  assert.equal(craftBudgetMs(8000, 3), 192_000);
  assert.equal(craftBudgetMs(2000, 2), 60_000, "at least 30 game seconds");
});

test("Home Marker: skewer from a sapling, then a stone on it", () => {
  const s = steps("Home Marker", inv(null, ["Stone", "Big Hard Rock", "Sapling", "Stone"]));
  assert.equal(s.at(-1), "Stone on Skewer -> Home Marker");
});

test("missing ingredients are named", () => {
  const r = planner.plan(id("Sharp Stone"), inv(null, ["Big Hard Rock"]));
  assert.ok(!r.ok);
  assert.match(r.reason, /missing \(none in view\): Stone/);
  assert.match(r.reason, /Recipe: Stone on Big Hard Rock/);
});

test("everything in view but too few of it: the shortage is named", () => {
  const r = planner.plan(id("Rope"), inv(null, ["Milkweed Stalk"]));
  assert.ok(!r.ok);
  assert.match(r.reason, /missing: more Milkweed/);
  assert.doesNotMatch(r.reason, /none in view/);
});

test("item names resolve forgivingly, ambiguity and natural objects are explained", () => {
  assert.deepEqual(planner.resolve("sharp stones"), { id: id("Sharp Stone") });
  assert.deepEqual(planner.resolve("FIRE"), { id: id("Fire") });
  assert.match((planner.resolve("skirt") as { error: string }).error, /ambiguous.*Reed Skirt/);
  assert.match((planner.resolve("Big Hard Rock") as { error: string }).error, /found in the world|can be crafted/);
  assert.match((planner.resolve("xyzzy") as { error: string }).error, /no item called/);
});

test("planning is fast enough to re-plan after every step", () => {
  const i = inv("Sharp Stone", [...MILKWEED4, ...MILKWEED4, POPLAR, MAPLE, MAPLE, MAPLE, "Juniper Tree", "Leaf", "Stone", "Big Hard Rock"]);
  const t0 = performance.now();
  for (let k = 0; k < 5; k++) planner.plan(id("Fire"), i);
  assert.ok((performance.now() - t0) / 5 < 400, "under 400 ms per plan");
});

// --- executor, end to end on the fake server

function camp(held = 0) {
  const g = new FakeGame(gd);
  g.addPlayer({ id: 1, x: 0, y: 0, age: 20, held, female: true });
  return g;
}

test("craft Sharp Stone end to end: picks up the stone, uses it on the rock", async () => {
  const g = camp();
  g.setTile(3, 0, id("Stone"));
  g.setTile(-4, 2, id("Big Hard Rock"));
  g.start();
  const body = new Body(g.conn, g.world, gd);
  const r = await runCraft(body, g.world, gd, planner, id("Sharp Stone"));
  assert.match(r, /^crafted Sharp Stone in 1 step/);
  assert.equal(g.world.self!.held.id, id("Sharp Stone"));
});

test("craft Reed Skirt end to end, re-planning after every step", async () => {
  const g = camp(id("Sharp Stone"));
  g.setTile(2, 0, id("Tule Reeds"));
  [[0, 3], [1, 3], [2, 3], [3, 3]].forEach(([x, y]) => g.setTile(x, y, id("Milkweed")));
  g.start();
  const body = new Body(g.conn, g.world, gd);
  const r = await runCraft(body, g.world, gd, planner, id("Reed Skirt"), { maxSteps: 20 });
  assert.match(r, /^crafted Reed Skirt/, r);
});

test("craft stops at its step limit and says what's next", async () => {
  const g = camp(id("Sharp Stone"));
  g.setTile(2, 0, id("Tule Reeds"));
  [[0, 3], [1, 3], [2, 3], [3, 3]].forEach(([x, y]) => g.setTile(x, y, id("Milkweed")));
  g.start();
  const body = new Body(g.conn, g.world, gd);
  const r = await runCraft(body, g.world, gd, planner, id("Reed Skirt"), { maxSteps: 2 });
  assert.match(r, /did 2: .*Stopped \(reached the limit of 2 steps.*steps? left; next: .*Use craft again/);
});

test("craft is interrupted by an urgent event and refuses with a baby in arms", async () => {
  const g = camp();
  g.setTile(3, 0, id("Stone"));
  g.setTile(-4, 2, id("Big Hard Rock"));
  g.start();
  const body = new Body(g.conn, g.world, gd);
  body.interrupt = () => "your baby #2 says F";
  const r = await runCraft(body, g.world, gd, planner, id("Sharp Stone"));
  assert.match(r, /Stopped \(interrupted: your baby #2 says F\)/);

  const g2 = camp(-2);
  g2.addPlayer({ id: 2, x: 0, y: 0, age: 0.3, held: 0, female: true, motherId: 1 });
  g2.start();
  const r2 = await runCraft(new Body(g2.conn, g2.world, gd), g2.world, gd, planner, id("Sharp Stone"));
  assert.match(r2, /while carrying a baby/);
});
