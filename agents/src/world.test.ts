import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { World, MAX_AGE } from "./game/world.ts";
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
