// Stream overlay pure logic (node --test, .ts via type stripping).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  MAX_WALK_MS,
  SNAP_TILES,
  biomeName,
  cameraStep,
  cutawayShot,
  fanOut,
  focusTransition,
  headlineNumbers,
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
  trackAnimal,
  traitTags,
  warmthLabel,
} from "../src/stream/logic.ts";
import { MAX_CELLS_READ, MIN_SPAN, biomeGrid, cameraRect, clampToBox, fitBounds, mapSignature, minimapDots, padBounds, project, worldBounds } from "../src/stream/minimap.ts";

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

test("headlineNumbers: births/deaths/generation from this run's lives, counters as fallback", () => {
  const stats = { alive: 4, totalBirths: 165, totalDeaths: 157, maxGeneration: 2 };
  const lives = [
    { runId: "r1", status: "dead", generation: 1 },
    { runId: "r1", status: "dead", generation: 4 },
    { runId: "r1", status: "alive", generation: 2 },
    { runId: "old", status: "dead", generation: 9 },
  ];
  assert.deepEqual(headlineNumbers(stats, lives, "r1"), { alive: 4, births: 3, deaths: 2, generation: 4 });
  // lives not loaded yet / other run only: the server counters
  assert.deepEqual(headlineNumbers(stats, [], "r1"), { alive: 4, births: 165, deaths: 157, generation: 2 });
  assert.deepEqual(headlineNumbers(stats, lives, "r2"), { alive: 4, births: 165, deaths: 157, generation: 2 });
  assert.deepEqual(headlineNumbers(null, [], null), { alive: 0, births: 0, deaths: 0, generation: 0 });
});

test("selectTicker: strips bidi overrides and zero-width marks from names and model text", () => {
  const evs = [ev("craft", { name: "\u202EEVE\u200B HOPE", text: "made a \u202Ebasket" })];
  const [it] = selectTicker(evs);
  assert.equal(it.text, "Eve Hope made a basket");
});

test("tickerItem: very long names are cut short", () => {
  const it = tickerItem(ev("death", { name: "A".repeat(200), data: { age: 30, reason: "reason_hunger" } }));
  assert.ok(it.text.length < 70, it.text);
  assert.ok(it.text.includes("…"));
});

test("tickerItem: a numbered repeat first name keeps its numeral", () => {
  const ctx = { knownFirstNames: new Set(["AURORA"]) };
  assert.equal(tickerItem(ev("say", { name: "MIRA DAWN", text: "YOU ARE AURORA II" }), ctx).text, "Mira Dawn has named a baby Aurora II");
  assert.equal(tickerItem(ev("say", { name: "MIRA DAWN", text: "YOU ARE AURORA" }), ctx).text, "Mira Dawn has named a baby Aurora");
});

test("occluders: objects in front of the focus that cover enough of them are faded, nothing else", async () => {
  const { coverShare, occluderAlpha, OCCLUDER_ALPHA, OCCLUDE_MIN_SHARE } = await import("../src/stream/logic.ts");
  const focus = { x0: 100, y0: 100, x1: 150, y1: 220 }; // 50 x 120
  const canopy = { x0: 60, y0: 40, x1: 200, y1: 180 }; // covers the top 80 of 120 px
  assert.equal(coverShare(canopy, focus), 80 / 120);
  assert.equal(coverShare({ x0: 0, y0: 0, x1: 10, y1: 10 }, focus), 0);
  assert.equal(coverShare(focus, focus), 1);
  assert.equal(occluderAlpha(canopy, focus, true), OCCLUDER_ALPHA);
  assert.ok(OCCLUDER_ALPHA > 0.2 && OCCLUDER_ALPHA < 0.5);
  // drawn before the focus (behind them): normal
  assert.equal(occluderAlpha(canopy, focus, false), 1);
  // grazing a heel: normal
  const heel = { x0: 140, y0: 210, x1: 170, y1: 240 };
  assert.ok(coverShare(heel, focus) < OCCLUDE_MIN_SHARE);
  assert.equal(occluderAlpha(heel, focus, true), 1);
  // unknown bounds (sprites not loaded) or no focus: normal
  assert.equal(occluderAlpha(null, focus, true), 1);
  assert.equal(occluderAlpha(canopy, null, true), 1);
  // degenerate focus box
  assert.equal(coverShare(canopy, { x0: 5, y0: 5, x1: 5, y1: 5 }), 0);
});

// ---------- minimap inset (pure layout and projection)

test("minimap: world bounds from cells, else from points, else null", () => {
  assert.equal(worldBounds([]), null);
  assert.equal(worldBounds([], []), null);
  assert.deepEqual(worldBounds([[0, 0, 0, 0, 0], [10, -4, 2, 0, 0]]), { x0: -0.5, y0: -4.5, x1: 10.5, y1: 0.5 });
  // points only when there are no cells
  assert.deepEqual(worldBounds([], [{ x: 3, y: 4 }]), { x0: 2.5, y0: 3.5, x1: 3.5, y1: 4.5 });
  assert.deepEqual(worldBounds([[0, 0, 0, 0, 0]], [{ x: 99, y: 99 }]), { x0: -0.5, y0: -0.5, x1: 0.5, y1: 0.5 });
  // junk is skipped
  assert.deepEqual(worldBounds([[NaN, 1, 0, 0, 0], [2, 2, 0, 0, 0]]), { x0: 1.5, y0: 1.5, x1: 2.5, y1: 2.5 });
});

test("minimap: padding adds a margin and a minimum span", () => {
  const b = padBounds({ x0: 0, y0: 0, x1: 100, y1: 50 });
  assert.ok(b.x0 < 0 && b.x1 > 100 && b.y0 < 0 && b.y1 > 50);
  assert.ok(Math.abs(b.x0 + 6) < 1e-9 && Math.abs(b.y0 + 3) < 1e-9, JSON.stringify(b));
  // a single tile still gets a sensible frame, centred
  const one = padBounds({ x0: 4.5, y0: 4.5, x1: 5.5, y1: 5.5 });
  assert.equal(one.x1 - one.x0, MIN_SPAN);
  assert.equal((one.x0 + one.x1) / 2, 5);
});

test("minimap: fit is uniform, centred, y up", () => {
  const W = 220;
  const H = 160;
  const b = { x0: 0, y0: 0, x1: 110, y1: 40 }; // wide: width-limited
  const f = fitBounds(b, W, H);
  assert.equal(f.scale, 2);
  const tl = project(f, 0, 40);
  const br = project(f, 110, 0);
  assert.ok(Math.abs(tl.px) < 1e-9 && Math.abs(br.px - 220) < 1e-9);
  // vertically centred: 80px of map in a 160px box
  assert.ok(Math.abs(tl.py - 40) < 1e-9 && Math.abs(br.py - 120) < 1e-9, JSON.stringify({ tl, br }));
  // y up: a higher y is nearer the top
  assert.ok(project(f, 5, 30).py < project(f, 5, 10).py);
  // tall world: height-limited
  const t = fitBounds({ x0: -10, y0: -200, x1: 10, y1: 0 }, W, H);
  assert.equal(t.scale, 0.8);
  const c = project(t, 0, -100);
  assert.ok(Math.abs(c.px - 110) < 1e-9 && Math.abs(c.py - 80) < 1e-9);
  // every padded cell of a real-looking map lands inside the box
  const cells = [];
  for (let x = -43; x <= 75; x += 3) for (let y = -197; y <= -60; y += 3) cells.push([x, y, 0, 0, 0]);
  const pb = padBounds(worldBounds(cells));
  const pf = fitBounds(pb, W, H);
  for (const [x, y] of cells) {
    const q = project(pf, x, y);
    assert.ok(q.px > 0 && q.px < W && q.py > 0 && q.py < H);
  }
});

test("minimap: clampToBox keeps far-off dots at the edge", () => {
  assert.deepEqual(clampToBox({ px: 50, py: 60 }, 220, 160), { px: 50, py: 60, clamped: false });
  assert.deepEqual(clampToBox({ px: -40, py: 999 }, 220, 160, 4), { px: 4, py: 156, clamped: true });
});

test("minimap: biome grid is coarse, bounded, and takes the majority biome", () => {
  const cells = [
    [0, 0, 2, 0, 0],
    [1, 0, 2, 0, 0],
    [0, 1, 6, 0, 0],
    [5, 5, -1, 0, 0], // unknown biome: not drawn
  ];
  const b = { x0: -0.5, y0: -0.5, x1: 5.5, y1: 5.5 };
  // 1 px per tile -> 1-tile buckets
  const g1 = biomeGrid(cells, b, { scale: 1, wx0: -0.5, wy1: 5.5 });
  assert.equal(g1.block, 1);
  const at = (g, x, y) => g.biomes[Math.floor((g.y1 - (y + 0.5)) / g.block) * g.gw + Math.floor((x + 0.5 - g.x0) / g.block)];
  assert.equal(at(g1, 0, 0), 2);
  assert.equal(at(g1, 0, 1), 6);
  assert.equal(at(g1, 5, 5), -1);
  // 0.4 px per tile -> 3-tile buckets; the 2x2 corner is mostly prairie
  const g3 = biomeGrid(cells, b, { scale: 0.4, wx0: 0, wy1: 0 });
  assert.equal(g3.block, 3);
  assert.equal(at(g3, 0, 0), 2);
  // a huge map: the grid never exceeds the box, and the read is capped
  const huge = { length: 5_000_000 };
  let reads = 0;
  const proxy = new Proxy(huge, {
    get(t, k) {
      if (k === "length") return t.length;
      reads++;
      const i = Number(k);
      return [i % 4000, Math.floor(i / 4000), i % 7, 0, 0];
    },
  });
  const hb = { x0: -0.5, y0: -0.5, x1: 3999.5, y1: 1249.5 };
  const hf = fitBounds(hb, 220, 160);
  const hg = biomeGrid(proxy, hb, hf);
  assert.ok(hg.gw <= 221 && hg.gh <= 161, `${hg.gw}x${hg.gh}`);
  assert.ok(reads <= MAX_CELLS_READ + 1, `read ${reads} cells`);
  // empty map: an empty grid
  const eg = biomeGrid([], b, { scale: 1, wx0: 0, wy1: 0 });
  assert.ok(eg.biomes.every((v) => v === -1));
});

test("minimap: map signature changes with content, not with a re-poll", () => {
  const a = [[0, 0, 1, 0, 0], [1, 0, 2, 0, 0]];
  assert.equal(mapSignature(a), mapSignature(a.map((c) => [...c])));
  assert.notEqual(mapSignature(a), mapSignature([...a, [2, 0, 0, 0, 0]]));
  assert.notEqual(mapSignature(a), mapSignature([[0, 0, 1, 0, 0], [1, 0, 3, 0, 0]]));
  assert.equal(mapSignature([]), "0");
});

test("minimap: camera rect is the view in tiles around the target, with the focus drop", () => {
  const r = cameraRect(10, 20, 1120, 560, 112, 0.5);
  assert.deepEqual(r, { x0: 5, x1: 15, y0: 18, y1: 23 });
});

test("minimap: dots for players plus agents not among them; the focus last", () => {
  const players = [
    { id: 1, x: 0, y: 0, agentId: "a01" },
    { id: 2, x: 5, y: 5, agentId: null },
    { id: 2, x: 5, y: 5, agentId: null }, // duplicate
  ];
  const agents = [
    { agentId: "a01", playerId: 1, status: "alive", x: 0, y: 0 }, // already a player
    { agentId: "a03", playerId: 3, status: "alive", x: 9, y: 9 }, // out of everyone's view
    { agentId: "a04", playerId: null, status: "waiting", x: 1, y: 1 }, // between lives
    { agentId: "a05", playerId: 5, status: "alive", x: null, y: null },
  ];
  const d = minimapDots(players, agents, 1);
  assert.deepEqual(d.map((x) => x.key), ["p2", "aa03", "p1"]);
  assert.equal(d.at(-1).focus, true);
  assert.equal(d.find((x) => x.key === "p2").agent, false);
  assert.deepEqual(minimapDots([], [], null), []);
  assert.ok(minimapDots(players, agents, null).every((x) => !x.focus));
});

test("cutawayShot: person, animal (followed on the map), tile; none when over or absent", () => {
  const players = [{ id: 7, lifeId: "r:7", x: 3, y: 4 }];
  const base = { kind: "cutaway", label: "L", reason: "animal", since: 100, until: 1000, returnTo: "a01" };
  assert.equal(cutawayShot(null, 0, players, [], {}), null);
  assert.equal(cutawayShot(undefined, 0, players, [], {}), null);
  assert.equal(cutawayShot({ ...base, target: { type: "tile", x: 1, y: 2 } }, 1000, players, [], {}), null, "over");
  assert.deepEqual(cutawayShot({ ...base, target: { type: "tile", x: 1, y: 2 } }, 500, players, [], {}), { key: "cut:100", label: "L", playerId: null, spot: { x: 1, y: 2 } });
  assert.equal(cutawayShot({ ...base, target: { type: "person", id: "a02", lifeId: "r:7", playerId: null, name: null } }, 500, players, [], {}).playerId, 7);
  assert.equal(cutawayShot({ ...base, target: { type: "person", id: "a03", lifeId: "r:9", playerId: 9, name: null } }, 500, players, [], {}), null, "not in view");
  const animal = { ...base, target: { type: "animal", objectId: 630, x: 10, y: 10, name: "Grizzly Bear" } };
  // the bear moved two tiles: the newest map cell wins over the director's last known tile
  assert.deepEqual(cutawayShot(animal, 500, players, [[12, 11, 0, 0, 630]], { 630: "Grizzly Bear" }).spot, { x: 12, y: 11 });
  assert.deepEqual(cutawayShot(animal, 500, players, [], {}).spot, { x: 10, y: 10 }, "not on the map: last known tile");
});

test("trackAnimal: same id or kind, nearest within reach", () => {
  const names = { 630: "Grizzly Bear", 631: "Attacking Grizzly Bear", 700: "Wolf" };
  const t = { objectId: 630, x: 0, y: 0, name: "Grizzly Bear" };
  assert.deepEqual(trackAnimal([[5, 0, 0, 0, 630], [1, 1, 0, 0, 631]], names, t), { x: 1, y: 1 });
  assert.equal(trackAnimal([[1, 0, 0, 0, 700]], names, t), null);
  assert.equal(trackAnimal([[20, 0, 0, 0, 630]], names, t), null);
});

test("speechBubbles: a +WORD+ cue is an emote for 4 s, not a speech bubble; speech stays 6 s", async () => {
  const { speechBubbles, EMOTE_MS, BUBBLE_MS } = await import("../src/stream/logic.ts");
  const evs = [
    { seq: 1, t: 10_000, kind: "say", agentId: "a1", playerId: 7, name: null, text: "HELLO" },
    { seq: 2, t: 11_000, kind: "say", agentId: "a2", playerId: 8, name: null, text: "+HOMESICK+" },
  ];
  assert.deepEqual(speechBubbles(evs, 12_000), [
    { key: "2", playerId: 8, text: "", emote: "HOMESICK" },
    { key: "1", playerId: 7, text: "HELLO" },
  ]);
  // after EMOTE_MS the emote is gone; the older speech line is still up
  assert.deepEqual(speechBubbles(evs, 11_000 + EMOTE_MS + 1).map((b) => b.key), ["1"]);
  assert.deepEqual(speechBubbles(evs, 10_000 + BUBBLE_MS + 1), []);
  // an expired emote doesn't hide the speaker's earlier line still on screen
  const same = [evs[0], { ...evs[1], playerId: 7 }];
  assert.deepEqual(speechBubbles(same, 12_000).map((b) => b.emote ?? b.text), ["HOMESICK"]);
  assert.deepEqual(speechBubbles(same, 15_500).map((b) => b.emote ?? b.text), ["HELLO"]);
});

test("cues are told apart from speech: +HOMESICK+, +FREE REIN+; not words around a plus", async () => {
  const { cueOfSay, cueLabel } = await import("../src/shared/format.ts");
  assert.equal(cueOfSay("+HOMESICK+"), "HOMESICK");
  assert.equal(cueLabel(cueOfSay("+FREE REIN+")), "free rein");
  assert.equal(cueLabel(cueOfSay("+HOME+")), "back home");
  assert.equal(cueLabel(cueOfSay("+HOMESICK+")), "homesick");
  assert.equal(cueOfSay("I MISS HOME"), null);
  assert.equal(cueOfSay("+HOME+ NOW"), null);
  assert.equal(cueOfSay(null), null);
});

test("the camera draws an emote bubble as a small house badge, not a speech bubble", () => {
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/stream/WorldCamera.tsx"), "utf8");
  assert.match(src, /if \(b\.emote\) \{[\s\S]*?data-kind="emote" className="cam-emote"[\s\S]*?continue;/);
});

test("card: 'Back home' badge for BACK_HOME_MS after the person's latest +HOME+, unless homesick again", async () => {
  const { backHome, BACK_HOME_MS } = await import("../src/stream/logic.ts");
  assert.equal(BACK_HOME_MS, 60_000);
  const say = (seq, t, text, playerId = 7, agentId = "a7") => ({ seq, t, kind: "say", text, playerId, agentId });
  const me = { agentId: "a7", playerId: 7 };
  const evs = [say(1, 1_000, "+HOMESICK+"), say(2, 10_000, "+HOME+"), say(3, 12_000, "HELLO"), say(4, 15_000, "+HOMESICK+", 8, "a8")];
  assert.equal(backHome(evs, me, 0, 5_000), false, "before the +HOME+");
  assert.equal(backHome(evs, me, 0, 10_000), true);
  assert.equal(backHome(evs, me, 0, 10_000 + BACK_HOME_MS), true);
  assert.equal(backHome(evs, me, 0, 10_000 + BACK_HOME_MS + 1), false, "expired");
  assert.equal(backHome(evs, { playerId: 7 }, 0, 20_000), true, "matched by player id");
  assert.equal(backHome(evs, { agentId: "a8", playerId: 8 }, 0, 20_000), false, "someone else's cue");
  assert.equal(backHome(evs, {}, 0, 20_000), false);
  assert.equal(backHome(evs, me, 11_000, 20_000), false, "a +HOME+ before this life doesn't count");
  // left again: the newer +HOMESICK+ ends it
  const left = [...evs, say(5, 30_000, "+HOMESICK+")];
  assert.equal(backHome(left, me, 0, 31_000), false);
});

test("the card shows the green 'Back home' badge, the emote keeps its house icon", () => {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const page = fs.readFileSync(path.join(dir, "../src/pages/stream.tsx"), "utf8");
  assert.match(page, /backHome\(p\.events[\s\S]*?className="condition back-home">🏠 Back home: returned to their family's homeland/);
  const css = fs.readFileSync(path.join(dir, "../src/stream/stream.css"), "utf8");
  assert.match(css, /\.side \.condition\.back-home \{ background: var\(--grad-leaf/);
  const cam = fs.readFileSync(path.join(dir, "../src/stream/WorldCamera.tsx"), "utf8");
  assert.match(cam, /b\.emote === "HOME"\) && <HomeIcon tear=\{b\.emote === "HOMESICK"\}/);
});
