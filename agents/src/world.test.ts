import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { World, MAX_AGE, walkMs } from "./game/world.ts";
import type { GameData } from "./game/gameData.ts";
import type { PlayerUpdate } from "./protocol/types.ts";

const gd = { isFemaleDisplay: () => true } as unknown as GameData;

function pu(id: number, over: Partial<PlayerUpdate> = {}): PlayerUpdate {
  return {
    id, displayId: 19, facing: 0, action: false, actionTarget: [0, 0], held: { id: 0, contained: [] }, heldOriginValid: false, heldOrigin: [0, 0],
    heldTransitionSourceId: 0, heat: 0.5, doneMovingSeq: 0, forced: false, x: 0, y: 0, age: 14, ageRate: 60, moveSpeed: 3.75, clothing: [],
    justAte: false, lastAteId: 0, responsibleId: -1, heldYum: false, heldLearned: false, ...over,
  };
}

test("ages never pass 60: a stalled server / sleeping host doesn't inflate age at death", () => {
  mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  try {
    let died: number | null = null;
    const w = new World(gd, { onSelfDied: (_r, age) => (died = age) });
    w.handle({ type: "PU", updates: [pu(7, { age: 50 })] });
    // 30 real minutes pass with no update (the server was stalled; the live run recorded 82 and 84)
    mock.timers.tick(30 * 60_000);
    assert.equal(w.currentAge(w.self!), MAX_AGE, "extrapolated age is capped");
    // death update carries the server's age
    w.handle({ type: "PU", updates: [pu(7, { x: null, y: null, age: 60, deathReason: "reason_age" })] });
    assert.equal(died, 60);
  } finally {
    mock.timers.reset();
  }
});

test("death age comes from the death update when present, else the extrapolation", () => {
  mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  try {
    const ages: number[] = [];
    const w = new World(gd, { onSelfDied: (_r, age) => ages.push(age) });
    w.handle({ type: "PU", updates: [pu(7, { age: 10 })] });
    mock.timers.tick(5 * 60_000);
    w.handle({ type: "PU", updates: [pu(7, { x: null, y: null, age: 12.5, deathReason: "reason_hunger" })] });
    assert.equal(ages[0], 12.5, "server age wins over wall-clock extrapolation (15)");

    const w2 = new World(gd, { onSelfDied: (_r, age) => ages.push(age) });
    w2.handle({ type: "PU", updates: [pu(8, { age: 10 })] });
    mock.timers.tick(60_000);
    w2.handle({ type: "PU", updates: [pu(8, { x: null, y: null, age: 0, deathReason: "reason_hunger" })] });
    assert.ok(Math.abs(ages[1] - 11) < 1e-9, "no age in the death update: extrapolate");
  } finally {
    mock.timers.reset();
  }
});

test("TIME_SCALE: age, walk time and food ETA follow the server's wall-clock rates", () => {
  mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const warn = mock.method(console, "warn", () => {});
  try {
    // a server at timeScale 3 reports 180 wall s/year and 1.25 tiles per wall s
    const w = new World(gd);
    w.timeScale = 3;
    w.handle({ type: "PU", updates: [pu(7, { age: 20, ageRate: 180, moveSpeed: 1.25 })] });
    mock.timers.tick(180_000); // 3 wall minutes = 1 game year
    assert.ok(Math.abs(w.currentAge(w.self!) - 21) < 1e-9);
    assert.equal(w.walkMs(10), 8000, "10 tiles at 1.25 tiles/s");
    w.handle({ type: "HX", heat: { heat: 0.5, foodTime: 30.6, indoorBonus: 0 } });
    assert.equal(w.foodTime, 30.6, "food_time is taken as wall seconds");
    assert.equal(warn.mock.callCount(), 0, "rates match TIME_SCALE=3: no warning");
  } finally {
    warn.mock.restore();
    mock.timers.reset();
  }
});

test("TIME_SCALE: walk-time fallback scales the stock speed; mismatch with the server warns once", () => {
  assert.equal(walkMs(15, 0, 1), 4000, "stock 3.75 tiles/s");
  assert.equal(walkMs(15, 0, 3), 12000, "3x slower");
  assert.equal(walkMs(15, 2.5, 3), 6000, "server-reported speed wins");
  const warn = mock.method(console, "warn", () => {});
  try {
    const w = new World(gd);
    w.timeScale = 1;
    w.handle({ type: "PU", updates: [pu(7, { ageRate: 180 })] });
    w.handle({ type: "PU", updates: [pu(7, { ageRate: 180 })] });
    assert.equal(warn.mock.callCount(), 1);
    assert.match(String(warn.mock.calls[0].arguments[0]), /TIME_SCALE mismatch/);
  } finally {
    warn.mock.restore();
  }
});
