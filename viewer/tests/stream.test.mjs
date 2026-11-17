// Stream overlay pure logic (node --test, .ts via type stripping).
import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_WALK_MS,
  SNAP_TILES,
  biomeName,
  cameraStep,
  fanOut,
  focusTransition,
  latestNarrations,
  objectIdsByName,
  parseHeld,
  recentOf,
  retarget,
  runTimeParts,
  sampleMotion,
  selectTicker,
  shortAgo,
  tickerItem,
  traitTags,
  warmthLabel,
} from "../src/stream/logic.ts";

const DIMS = ["openness", "conscientiousness", "extraversion", "agreeableness", "neuroticism"];
let seq = 0;
const ev = (kind, extra = {}) => ({ seq: ++seq, t: seq * 1000, kind, agentId: null, playerId: null, name: null, text: "", ...extra });

test("traitTags: 2-4 chips from the most extreme traits", () => {
  assert.deepEqual(traitTags({ openness: 0.1, conscientiousness: 0.2, extraversion: 1.1, agreeableness: 1.8, neuroticism: -0.9 }, DIMS), [
    "very agreeable",
    "chatty",
    "steady",
  ]);
  // everything mild: still two chips, hedged
  assert.deepEqual(traitTags({ openness: 0.1, conscientiousness: -0.3, extraversion: 0, agreeableness: 0.05, neuroticism: 0.2 }, DIMS), [
    "a bit carefree",
    "a bit anxious",
  ]);
  // at most 4
  assert.equal(traitTags({ openness: 2, conscientiousness: -2, extraversion: 2, agreeableness: -2, neuroticism: 2 }, DIMS).length, 4);
  assert.deepEqual(traitTags(null, DIMS), []);
  // unknown dims and junk values
  assert.deepEqual(traitTags({ boldness: -1, x: Number.NaN }, []), ["low boldness"]);
});

test("motion: walks between polls, keeps facing, snaps on long jumps", () => {
  let m = retarget(undefined, 0, 0, 0);
  assert.deepEqual(sampleMotion(m, 50), { x: 0, y: 0 });
  m = retarget(m, 3, 0, 1000);
  assert.equal(m.facingLeft, false);
  assert.ok(m.dur > 0 && m.dur <= MAX_WALK_MS);
  const mid = sampleMotion(m, 1000 + m.dur / 2);
  assert.ok(mid.x > 0.5 && mid.x < 2.5, `mid ${mid.x}`);
  assert.deepEqual(sampleMotion(m, 1000 + m.dur + 1), { x: 3, y: 0 });
  // same target: unchanged object
  assert.equal(retarget(m, 3, 0, 5000), m);
  // vertical move keeps facing; walking left flips it
  const up = retarget(m, 3, 4, 6000);
  assert.equal(up.facingLeft, false);
  const left = retarget(up, 1, 4, 9000);
  assert.equal(left.facingLeft, true);
  // retarget mid-walk starts from the current sampled point (no jump)
  const a = retarget(retarget(undefined, 0, 0, 0), 4, 0, 0);
  const at = sampleMotion(a, 300);
  const b = retarget(a, 4, 3, 300);
  assert.deepEqual(sampleMotion(b, 300), at);
  // teleport
  const far = retarget(a, 0, SNAP_TILES + 5, 400);
  assert.equal(far.dur, 0);
  assert.deepEqual(sampleMotion(far, 400), { x: 0, y: SNAP_TILES + 5 });
});

test("camera: frame-rate independent smoothing, converges and snaps", () => {
  const t = { x: 10, y: -4 };
  let one = { x: 0, y: 0 };
  one = cameraStep(one, t, 100);
  let two = { x: 0, y: 0 };
  two = cameraStep(two, t, 50);
  two = cameraStep(two, t, 50);
  assert.ok(Math.abs(one.x - two.x) < 1e-9);
  let c = { x: 0, y: 0 };
  for (let i = 0; i < 400; i++) c = cameraStep(c, t, 16);
  assert.deepEqual(c, t);
  assert.equal(focusTransition(null, t), "snap");
  assert.equal(focusTransition({ x: 8, y: -4 }, t), "pan");
  assert.equal(focusTransition({ x: 80, y: -4 }, t), "fade");
});

test("fanOut spreads people who share a tile", () => {
  const o = fanOut([
    { id: 7, x: 1, y: 1 },
    { id: 4, x: 1, y: 1 },
    { id: 6, x: 1, y: 1 },
    { id: 9, x: 5, y: 1 },
  ]);
  assert.equal(o.get(9), 0);
  assert.equal(o.get(4), -0.45);
  assert.equal(o.get(6), 0);
  assert.equal(o.get(7), 0.45);
});

test("held strings", () => {
  assert.equal(parseHeld(null), null);
  assert.equal(parseHeld("nothing"), null);
  assert.deepEqual(parseHeld("baby #9"), { kind: "baby", playerId: 9, name: null });
  assert.deepEqual(parseHeld("baby MAYA DAWOD"), { kind: "baby", playerId: null, name: "MAYA DAWOD" });
  assert.deepEqual(parseHeld("Sharp Stone"), { kind: "object", name: "Sharp Stone" });
  const ids = objectIdsByName({ 34: "Sharp Stone", 9: "Sharp Stone", 30: "Wild Gooseberry Bush" });
  assert.equal(ids.get("sharp stone"), 9);
});

test("display helpers", () => {
  assert.equal(biomeName(0), "Grassland");
  assert.equal(biomeName(-1), "Unexplored");
  assert.equal(warmthLabel(0.5), "ok");
  assert.equal(warmthLabel(0.07), "freezing");
  assert.equal(warmthLabel(null), "?");
  assert.deepEqual(runTimeParts((41 * 60 + 12) * 1000), ["41", ":12"]);
  assert.deepEqual(runTimeParts((5 * 3600 + 7 * 60) * 1000), ["5", "h 07"]);
  assert.deepEqual(runTimeParts((3 * 24 + 4) * 3600 * 1000), ["3", "d 4 h"]);
  assert.equal(shortAgo(1000, 9000), "8 s");
  assert.equal(shortAgo(0, 9000), "");
});

test("ticker: births, deaths, namings, crafts; newest first, crafts capped, deduped", () => {
  const players = { 4: "DAWN HOPE" };
  const ctx = { playerName: (id) => players[id], knownFirstNames: new Set(["GRACE"]) };
  const events = [
    ev("birth", { data: { eve: true } }),
    ev("say", { name: "EVE DAWOD", text: "I AM EVE DAWOD" }),
    ev("say", { name: "EVE DAWOD", text: "I AM HUNGRY" }),
    ev("birth", { data: { eve: false, motherId: 4 } }),
    ev("say", { name: "DAWN HOPE", text: "YOU ARE GRACE" }),
    ev("say", { name: "DAWN HOPE", text: "YOU ARE LATE" }),
    ev("thought", { text: "hmm" }),
    ...[1, 2, 3, 4, 5].map((i) => ev("action", { name: "JOY HOPE", text: `use (-11, -118) -> use: tile (-11,-118) Sapling${i} -> Cut Sapling${i}` })),
    ev("action", { name: "JOY HOPE", text: "drop (-14, -151) -> drop: tile (-14,-151) nothing -> Sharp Stone; holding Sharp Stone -> nothing" }),
    ev("death", { name: "FAITH HOPE", data: { age: 11.6, reason: "reason_hunger" } }),
    ev("death", { name: "FAITH HOPE", data: { age: 11.6, reason: "reason_hunger" } }),
  ];
  const t = selectTicker(events, ctx, { max: 10 });
  assert.deepEqual(
    t.map((x) => x.text),
    [
      "Faith Hope, 11, starved",
      "Joy Hope turned sapling5 into cut sapling5",
      "Joy Hope turned sapling4 into cut sapling4",
      "Joy Hope turned sapling3 into cut sapling3",
      "Dawn Hope has named a baby Grace",
      "Dawn Hope has had a baby",
      "Eve Dawod has founded the Dawod family",
      "A new Eve has appeared in the wild",
    ],
  );
  assert.equal(selectTicker(events, ctx, { max: 2 }).length, 2);
  assert.equal(tickerItem(ev("narration", { text: "x" })), null);
});

test("narrations and per-agent recents", () => {
  const events = [ev("narration", { text: "one" }), ev("say", { agentId: "a1", text: "HI" }), ev("narration", { text: " " }), ev("narration", { text: "two" }), ev("say", { agentId: "a2", text: "YO" }), ev("say", { agentId: "a1", text: "BYE" })];
  assert.deepEqual(latestNarrations(events).map((e) => e.text), ["two", "one"]);
  assert.deepEqual(recentOf(events, "a1", "say", 0, 4).map((e) => e.text), ["BYE", "HI"]);
  assert.deepEqual(recentOf(events, "a1", "say", events[3].t, 4).map((e) => e.text), ["BYE"]);
  assert.deepEqual(recentOf(events, null, "say", 0, 4), []);
});
