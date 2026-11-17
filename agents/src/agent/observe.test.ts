// Observation formatting: food drain in turns, home, water/heat/food summary.
import { test } from "node:test";
import assert from "node:assert/strict";
import { GameData } from "../game/gameData.ts";
import { FakeGame } from "../game/fakeGame.ts";
import { Body } from "../game/body.ts";
import { buildObservation, direction, foodLine } from "./observe.ts";
import { turnsFor, turnsForWall, turnsText, turnsTextWall, turnClock, turnsAgo } from "./turns.ts";
import { buildSystemPrompt, drainSecondsPerPip, newbornWindowSeconds, systemPromptFor } from "./prompt.ts";

const gd = new GameData();
const id = (n: string) => gd.idByName(n)!;

function camp() {
  const g = new FakeGame(gd);
  g.addPlayer({ id: 1, x: 10, y: 10, age: 20, held: 0, female: true });
  g.setTile(13, 10, id("Wild Gooseberry Bush"));
  g.setTile(14, 12, id("Wild Gooseberry Bush"));
  g.setTile(5, 10, id("Pond"));
  g.setTile(10, 16, id("Fire"));
  g.setTile(12, 14, id("Home Marker"));
  g.food = 9;
  g.start();
  g.world.handle({ type: "HX", heat: { heat: 0.07, foodTime: 6.8, indoorBonus: 0 } });
  return g;
}

const clock = { cycleMs: 8000, timeScale: 1 };

test("turns: one helper converts game seconds using the decision cycle and the time scale", () => {
  assert.equal(turnsFor(8, clock), 1);
  assert.equal(turnsFor(8, { cycleMs: 8000, timeScale: 2 }), 2, "a 2x slower server clock doubles the turns");
  assert.equal(turnsText(48, clock), "about 6 turns");
  assert.equal(turnsText(8, clock), "1 turn");
  assert.equal(turnsText(2, clock), "less than 1 turn");
  assert.deepEqual(turnClock({}), { cycleMs: 8000, timeScale: 1 }, "safe defaults before DECISION_CYCLE_MS / TIME_SCALE exist");
  assert.deepEqual(turnClock({ decisionCycleMs: 5000, timeScale: 3 }), { cycleMs: 5000, timeScale: 3 });
  assert.equal(turnsAgo(1000, 1000 + 16000, clock), "2 turns ago");
  // server-reported durations are already wall seconds: never scaled again
  assert.equal(turnsForWall(16, { cycleMs: 8000, timeScale: 3 }), 2);
  assert.equal(turnsTextWall(48, { cycleMs: 8000, timeScale: 2 }), "about 6 turns");
});

test("food line uses the server's drain time and speaks in turns", () => {
  const g = camp();
  const line = foodLine(g.world, clock);
  assert.match(line, /^Food: 9\/20\. Drains 1 pip per turn because you are cold \(warm it would be 1 per ~3 turns\); it runs out in about 8 turns\.$/);
  assert.doesNotMatch(line, /\d+ ?s\b|second/, "no seconds");
});

// What the patched server sends in HX: food_time = k x (4 + heat term + 18 s bonus), in WALL seconds
// (time-scale.patch mtsWallSeconds; new-player-food-bonus.patch with newPlayerFoodDecrementSecondsBonus=18).
function hxWorld(k: number, heat: number, food = 9) {
  const g = new FakeGame(gd);
  g.addPlayer({ id: 1, x: 0, y: 0, age: 20, held: 0, female: true });
  g.food = food;
  g.start();
  const foodTime = k * drainSecondsPerPip(heat, 18);
  g.world.handle({ type: "HX", heat: { heat, foodTime, indoorBonus: 0 } });
  return { w: g.world, foodTime };
}

test("food line: the server's wall-second drain is not scaled again, at k = 1, 2 and 3 (calibrated cycles)", () => {
  // cold adult (heat 0.07): 24.8 game s per pip; warm (0.5): 42 game s
  const cases = [
    { k: 1, cycleMs: 8000, rate: "~3 turns", warm: "~5 turns", left: "about 30 turns" }, // 24.8 s/pip = 3.1 turns; warm 42 s = 5.3; 9 pips 223 s = 28
    { k: 2, cycleMs: 4700, rate: "~10 turns", warm: "~20 turns", left: "about 95 turns" }, // 49.6 s = 10.6 turns; warm 84 s = 17.9; 446 s = 95
    { k: 3, cycleMs: 6000, rate: "~10 turns", warm: "~20 turns", left: "about 110 turns" }, // 74.4 s = 12.4 turns; warm 126 s = 21; 670 s = 112
  ];
  for (const c of cases) {
    const clock = { cycleMs: c.cycleMs, timeScale: c.k };
    const { w, foodTime } = hxWorld(c.k, 0.07);
    const line = foodLine(w, clock);
    assert.equal(line, `Food: 9/20. Drains 1 pip every ${c.rate} because you are cold (warm it would be 1 per ${c.warm}); it runs out in ${c.left}.`, `k=${c.k}`);
    // the turn count is wall time / cycle, nothing else
    assert.ok(Math.abs(turnsForWall(foodTime, clock) - (foodTime * 1000) / c.cycleMs) < 1e-9);
  }
  // the regression: k=2 used to show 2x the turns (k x the server's already-scaled time)
  const { w } = hxWorld(2, 0.07);
  assert.doesNotMatch(foodLine(w, { cycleMs: 4700, timeScale: 2 }), /every ~20 turns because|about 190 turns/);
});

test("food line: warm is slower than cold with the food bonus; too hot also points to heat 0.5", () => {
  for (const k of [1, 2, 3]) {
    const clock = { cycleMs: 5000, timeScale: k };
    const cold = hxWorld(k, 0.07);
    const turnsOf = (re: RegExp, s: string) => Number(re.exec(s)![1]);
    const line = foodLine(cold.w, clock);
    const now = turnsOf(/every ~(\d+) turns/, line);
    const warm = turnsOf(/warm it would be 1 per ~(\d+) turns/, line);
    assert.ok(warm > now, `k=${k}: warm (${warm}) drains slower than cold (${now}): ${line}`);
    // ideal = the server's figure with only the heat term swapped: k x (4 + 20 + 18)
    const hot = hxWorld(k, 0.9);
    const hotLine = foodLine(hot.w, clock);
    assert.match(hotLine, /because you are too hot \(1 per ~?\d+ turns? at heat 0\.5\)/);
    const t = (k * 42 * 1000) / 5000;
    assert.equal(turnsOf(/1 per ~(\d+) turns at heat/, hotLine), t < 10 ? Math.round(t) : Math.round(t / 5) * 5, `k=${k}`);
  }
});

test("a nursed baby is told its food isn't draining", () => {
  const g = new FakeGame(gd, 2);
  g.addPlayer({ id: 1, x: 0, y: 0, age: 20, held: -2, female: true });
  g.addPlayer({ id: 2, x: 0, y: 0, age: 0.5, held: 0, female: true, motherId: 1 });
  g.food = 4;
  g.cap = 4;
  g.start();
  assert.match(foodLine(g.world, clock), /being nursed by #1: your food doesn't drain/);
});

test("observation shows home marker, water, heat and food left, in turns, no seconds", () => {
  const g = camp();
  const body = new Body(g.conn, g.world, gd);
  const obs = buildObservation(g.world, gd, { recipeHints: true, history: [], notebook: [], pastLifeNotes: [], goal: null, foodSources: body.foodSources(), clock });
  assert.match(obs, /Home \(your family's Home Marker\): \(12, 14\), 4 tiles N/);
  assert.match(obs, /Water: Pond at \(5, 10\), 5 tiles W/);
  assert.match(obs, /Fire\/heat: Fire at \(10, 16\), 6 tiles N/);
  assert.match(obs, /Food by hand within 20: 12 Gooseberry \(2 spots\)/);
  assert.match(obs, /Age 20.0 of at most 60/);
  assert.doesNotMatch(obs, /\d+s ago|seconds/);
});

test("without a marker: the birth spot; home follows a marker we place", () => {
  const g = new FakeGame(gd);
  g.addPlayer({ id: 1, x: 0, y: 0, age: 20, held: 0, female: true });
  g.start();
  const o = () => buildObservation(g.world, gd, { recipeHints: false, history: [], notebook: [], pastLifeNotes: [], goal: null, clock });
  assert.match(o(), /No Home Marker known\. You appeared at \(0, 0\), here/);
  g.world.handle({ type: "MX", changes: [{ x: 2, y: 1, floor: 0, obj: { id: id("Home Marker"), contained: [] }, responsibleId: 1 }] });
  assert.match(o(), /Home \(your family's Home Marker\): \(2, 1\)/);
  // someone else's marker doesn't move our home
  g.world.handle({ type: "MX", changes: [{ x: -5, y: -5, floor: 0, obj: { id: id("Home Marker"), contained: [] }, responsibleId: 7 }] });
  assert.match(o(), /Home \(your family's Home Marker\): \(2, 1\)/);
});

test("a marker far from the birth chunk centre isn't inherited (client: within 16 tiles)", () => {
  const g = new FakeGame(gd);
  g.addPlayer({ id: 1, x: 0, y: 0, age: 0, held: 0, female: true });
  g.setTile(20, 20, id("Home Marker"));
  g.start();
  assert.equal(g.world.home, null);
});

test("your own wound is a condition, not a held thing; others' wounds are shown too", async () => {
  const g = new FakeGame(gd);
  const HOG_CUT = id("Hog Cut");
  g.addPlayer({ id: 1, x: 0, y: 0, age: 20, held: HOG_CUT, female: true });
  g.addPlayer({ id: 2, x: 2, y: 0, age: 30, held: id("Yellow Fever"), female: false });
  g.start();
  g.world.handle({ type: "DY", ids: [1] });
  const obs = buildObservation(g.world, gd, { recipeHints: true, history: [], notebook: [], pastLifeNotes: [], goal: null, clock });
  assert.match(obs, /You are WOUNDED: Hog Cut from a Wild Boar\. A wound fills your hands; it can't be dropped or eaten\. You are bleeding: you die within ~3 turns unless someone heals you \(only a Sterile Wool Pad used on you treats a Hog Cut\)\./);
  assert.match(obs, /Holding: nothing \(hands taken by a wound: Hog Cut\)/);
  assert.doesNotMatch(obs, /eat the Hog Cut/);
  assert.match(obs, /#2 .*, SICK \(Yellow Fever\)/);
  const body = new Body(g.conn, g.world, gd);
  assert.match(await body.drop(), /can't drop: your hands are taken by your wound \(Hog Cut\); it can't be put down/);
  assert.match(await body.self(), /can't: your hands are taken by your wound/);
  assert.equal(body.heldName(), "Hog Cut (wound)");
});

test("a tree with its branch and without it have different names (the client draws the branch)", () => {
  assert.equal(gd.name(63), "Maple Tree (with branch)");
  assert.equal(gd.name(48), "Maple Tree");
  assert.equal(gd.idByName("Maple Tree"), 48);
});

test("others' wounds name what treats them", () => {
  const g = new FakeGame(gd);
  g.addPlayer({ id: 1, x: 0, y: 0, age: 20, held: 0, female: true });
  g.addPlayer({ id: 2, x: 2, y: 0, age: 30, held: id("Bite Wound"), female: false });
  g.start();
  const obs = buildObservation(g.world, gd, { recipeHints: true, history: [], notebook: [], pastLifeNotes: [], goal: null, clock });
  assert.match(obs, /#2 .*, WOUNDED \(Bite Wound; treated only by a Sterile Wool Pad\)/);
});

test("a plant and the food it gives never share a name in the observation", () => {
  assert.equal(gd.name(404), "Wild Carrot (plant)");
  assert.equal(gd.name(40), "Wild Carrot");
  assert.equal(gd.name(805), "Wild Onion (plant)");
  assert.equal(gd.name(808), "Wild Onion");
  assert.equal(gd.name(4251), "Wild Garlic (plant)");
  assert.equal(gd.name(517), "Cooked Goose (not edible yet)");
  assert.equal(gd.name(518), "Cooked Goose");
  assert.equal(gd.name(id("Wild Gooseberry Bush")), "Wild Gooseberry Bush", "no clash, no suffix");
  const g = new FakeGame(gd);
  g.addPlayer({ id: 1, x: 0, y: 0, age: 20, held: 0, female: true });
  g.setTile(2, 0, 404);
  g.setTile(3, 0, 40);
  g.start();
  const obs = buildObservation(g.world, gd, { recipeHints: false, history: [], notebook: [], pastLifeNotes: [], goal: null, clock });
  assert.match(obs, /- Wild Carrot \(plant\): \(2, 0\)/);
  assert.match(obs, /- Wild Carrot: \(3, 0\)/);
});

test("people are shown where they are now: carried babies with the carrier, walkers mid-walk with their destination", () => {
  const g = new FakeGame(gd);
  g.addPlayer({ id: 1, x: 0, y: 0, age: 20, held: 0, female: true });
  g.addPlayer({ id: 3, x: 2, y: 0, age: 30, held: 0, female: false });
  g.addPlayer({ id: 4, x: 3, y: 3, age: 25, held: -5, female: true });
  g.addPlayer({ id: 5, x: 9, y: 9, age: 0.5, held: 0, female: false, motherId: 4 }); // stale pick-up spot
  g.start();
  g.world.handle({ type: "PM", moves: [{ id: 3, start: [2, 0], totalSec: 6, etaSec: 6, truncated: false, path: [[3, 0], [4, 0], [5, 0], [6, 0], [7, 0], [8, 0]] }] });
  const at = (ms: number) => buildObservation(g.world, gd, { recipeHints: false, history: [], notebook: [], pastLifeNotes: [], goal: null, clock, now: Date.now() + ms });
  assert.match(at(3000), /#3 .* at \(5, 0\), 5 away, walking to \(8, 0\)/);
  assert.match(at(0), /#3 .* at \(2, 0\), 2 away, walking to \(8, 0\)/);
  assert.match(at(7000), /#3 .* at \(8, 0\), 8 away(?!, walking)/, "arrived");
  assert.match(at(0), /#5 .* at \(3, 3\), 3 away, carried by #4/);
});

test("small observation fixes: notices, other families' language, baby hunger, baby death age, last-use hints", () => {
  const g = new FakeGame(gd, 2);
  g.addPlayer({ id: 1, x: 0, y: 0, age: 20, held: 0, female: true });
  g.addPlayer({ id: 2, x: 1, y: 0, age: 0.5, held: 0, female: false, motherId: 1 });
  g.addPlayer({ id: 7, x: 3, y: 0, age: 30, held: 0, female: false, motherId: 50 });
  g.addPlayer({ id: 3, x: 2, y: 0, age: 0.88, held: 0, female: true, motherId: 1 });
  g.food = 2;
  g.cap = 4;
  g.setTile(2, 2, 2142); // a full Banana Plant
  g.start();
  g.world.handle({ type: "LN", lineages: [{ id: 1, ancestors: [], eveId: 1 }, { id: 2, ancestors: [1], eveId: 1 }, { id: 7, ancestors: [50], eveId: 50 }] });
  g.world.handle({ type: "MS", text: "YOU INHERITED A HOME" });
  g.world.handle({ type: "PS", says: [{ id: 7, isCurse: false, text: "TOBA KEMI" }] });
  const obs = buildObservation(g.world, gd, { recipeHints: true, history: [], notebook: [], pastLifeNotes: [], goal: null, clock });
  assert.match(obs, /notice from the game: "YOU INHERITED A HOME"/);
  // 4 players: the server doesn't scramble anyone's speech below 15
  assert.match(obs, /#7 [^\n]*\): "TOBA KEMI"/);
  assert.doesNotMatch(obs, /language differs/);
  const withHook = (r: boolean | null) => buildObservation(g.world, gd, { recipeHints: false, history: [], notebook: [], pastLifeNotes: [], goal: null, clock, speechScrambled: () => r });
  assert.match(withHook(true), /#7 .*\[other family: their language differs from yours\]: "TOBA KEMI"/, "the words differed from what #7 said");
  assert.doesNotMatch(withHook(false), /language differs/);
  assert.doesNotMatch(withHook(null), /language differs/, "unknown: fall back to the visible population (4)");
  const p7 = g.world.players.get(7)!;
  for (let i = 0; i < 12; i++) g.world.players.set(100 + i, { ...p7, id: 100 + i, x: 40, y: 40 });
  assert.ok(g.world.players.size >= 15);
  assert.match(withHook(null), /language differs/, "15+ people known and nothing better known: the server is scrambling other families");
  assert.match(obs, /Food: 2\/4, STARVING - say F so a woman picks you up/);
  assert.doesNotMatch(obs, /EAT NOW/, "babies can't eat");
  assert.match(systemPromptFor({ promptBaseline: "playbook" }), /speech between families arrives as scrambled words/);
  // a full banana plant gives a banana and keeps 6 of 7 (not the last-use "Empty Banana Plant")
  assert.equal(gd.name(gd.transition(0, 2142)!.newTarget), "Banana Plant (6/7 left)");
  assert.equal(gd.name(gd.transition(0, 6953)!.newTarget), "Empty Banana Plant", "the last banana empties it");
  // a baby that died at 0.88 is not "age 1"
  g.world.handle({ type: "PU", updates: [{ id: 3, displayId: 347, facing: 0, action: false, actionTarget: [0, 0], held: { id: 0, contained: [] }, heldOriginValid: false, heldOrigin: [0, 0], heldTransitionSourceId: 0, heat: 0.5, doneMovingSeq: 0, forced: false, x: null as unknown as number, y: null as unknown as number, age: 0.88, ageRate: 60, moveSpeed: 3.75, clothing: [], justAte: false, lastAteId: 0, responsibleId: -1, heldYum: false, heldLearned: false, deathReason: "reason_hunger" }] });
  const obs2 = buildObservation(g.world, gd, { recipeHints: false, history: [], notebook: [], pastLifeNotes: [], goal: null, clock });
  assert.match(obs2, /DEATHS YOU SAW ==\n.*, age 0\.\d,/);
});

test("rule failures say why: baby refuses food, not edible, too young to pick up, wearing, go onto a blocking tile", async () => {
  const g = new FakeGame(gd);
  g.addPlayer({ id: 1, x: 0, y: 0, age: 20, held: id("Gooseberry"), female: true });
  g.addPlayer({ id: 2, x: 1, y: 0, age: 0.5, held: 0, female: false, motherId: 1 });
  const TREE = [...gd.objects.values()].find((o) => o.blocksWalking && o.permanent && /^Juniper Tree$/.test(o.name))!.id;
  g.setTile(5, 0, TREE);
  g.start();
  const body = new Body(g.conn, g.world, gd);
  assert.match(await body.useOnPerson(2), /#2 refused the Gooseberry: a baby under 3 only takes food when starving \(2 food or less\)/);
  assert.match(await body.go(5, 0), /^the Juniper Tree at \(5,0\) blocks walking; you're next to it at \(4,0\)$/);

  const g2 = new FakeGame(gd);
  g2.addPlayer({ id: 1, x: 0, y: 0, age: 20, held: id("Stone"), female: true });
  g2.start();
  const b2 = new Body(g2.conn, g2.world, gd);
  assert.equal(await b2.self(), "the Stone is not food and can't be worn");

  const g3 = new FakeGame(gd);
  g3.addPlayer({ id: 1, x: 0, y: 0, age: 20, held: id("Reed Skirt"), female: true });
  g3.start();
  assert.equal(await new Body(g3.conn, g3.world, gd).self(), "you put on the Reed Skirt (bottom)");
});

test("direction text", () => {
  assert.equal(direction([0, 0], [0, 0]), "here");
  assert.equal(direction([0, 0], [3, 3]), "3 tiles NE");
  assert.equal(direction([0, 0], [-1, 0]), "1 tile W");
  assert.equal(direction([0, 0], [1, -6]), "6 tiles S");
});

test("system prompt: static per config, durations in turns, the corrected baby facts", () => {
  const stock = systemPromptFor({ promptBaseline: "playbook", foodBonusS: 0 });
  assert.match(stock, /unheld it dies within ~3 turns/); // 3 pips x 6.8 s = 20 s
  assert.match(stock, /1 pip per 1 turn when naked and cold/);
  assert.match(stock, /cold makes you starve ~3\.5x faster/);
  const p = systemPromptFor({ promptBaseline: "playbook" });
  assert.equal(p, systemPromptFor({ promptBaseline: "playbook" }), "identical on every call (cacheable)");
  // default FOOD_BONUS_S=18 (server/settings): +18 game s on every pip
  assert.equal(newbornWindowSeconds(18), 3 * 24.8);
  assert.match(p, /unheld it dies within ~9 turns/); // 74.4 s / 8 s
  assert.match(p, /Food drains 1 pip per 5 turns at the ideal heat 0\.5, but 1 pip per 3 turns when naked and cold/);
  assert.match(p, /cold makes you starve ~1\.7x faster/);
  assert.match(p, /every pickup costs her 1 food/);
  assert.match(p, /Never stand idle holding a baby while you are hungry/);
  assert.doesNotMatch(p, /few minutes|\d+ ?s\b|seconds/);
  assert.match(p, /"type":"craft"/);
  assert.doesNotMatch(systemPromptFor({ promptBaseline: "playbook", craftMacro: false }), /craft/);
  // game constants scale with k: 74.4 game s x 4 / 8 s = 37 turns; a year (60 game s) = 30 turns
  const k4 = buildSystemPrompt({ cycleMs: 8000, timeScale: 4 }, { craft: true, baseline: "playbook" });
  assert.match(k4, /unheld it dies within ~35 turns/);
  assert.match(k4, /One year of life passes every 30 turns/);
  assert.match(buildSystemPrompt({ cycleMs: 8000, timeScale: 4 }, { craft: true, foodBonusS: 0, baseline: "playbook" }), /unheld it dies within ~10 turns/);
});

test("flowers: own flower after the identity line, each nearby person's inside their label; none without flowerOf", () => {
  const g = new FakeGame(gd);
  g.addPlayer({ id: 1, x: 0, y: 0, age: 20, held: 0, female: true });
  g.addPlayer({ id: 2, x: 2, y: 0, age: 24, held: 0, female: false });
  g.start();
  const labels: Record<number, string> = { 1: "orange rose", 2: "blue daisy" };
  const base = { recipeHints: false, history: [], notebook: [], pastLifeNotes: [], goal: null, clock };
  const obs = buildObservation(g.world, gd, { ...base, flowerOf: (pid) => labels[pid] ?? null });
  const lines = obs.split("\n");
  const idx = lines.findIndex((l) => l.startsWith("#1 "));
  assert.equal(lines[idx + 1], "You wear an orange rose in your hair.");
  assert.match(obs, /^- #2 \(no name, man, 24, blue daisy\) /m);
  labels[1] = "orange forget-me-not";
  labels[2] = "blue forget-me-not";
  const fm = buildObservation(g.world, gd, { ...base, flowerOf: (pid) => labels[pid] ?? null });
  assert.match(fm, /^You wear an orange forget-me-not in your hair\.$/m);
  assert.match(fm, /^- #2 \(no name, man, 24, blue forget-me-not\) /m);
  labels[1] = "red tulip";
  assert.match(buildObservation(g.world, gd, { ...base, flowerOf: (pid) => labels[pid] ?? null }), /^You wear a red tulip in your hair\.$/m);
  const plain = buildObservation(g.world, gd, base);
  assert.doesNotMatch(plain, /in your hair|daisy|rose/);
  assert.match(plain, /^- #2 \(no name, man, 24\) /m);
  assert.match(systemPromptFor({ promptBaseline: "playbook" }), /Everyone wears a unique flower in their hair that others can see\./);
});

// --- decay timers (a human sees the fire shrink) and the danger line

const obsAt = (g: FakeGame, now: number, clk = clock) => buildObservation(g.world, gd, { recipeHints: false, history: [], notebook: [], pastLifeNotes: [], goal: null, clock: clk, now });

test("timers: a fire we saw lit counts down in turns, in game time scaled by TIME_SCALE", () => {
  const g = new FakeGame(gd);
  g.addPlayer({ id: 1, x: 0, y: 0, age: 20, held: 0, female: true });
  g.start();
  const t0 = Date.now();
  g.world.handle({ type: "MX", changes: [{ x: 2, y: 0, floor: 0, obj: { id: id("Fire"), contained: [] }, responsibleId: 1 }] });
  // Fire -> Hot Coals after 60 game s. At k=3, 60 wall s later 20 game s have passed: 40 left = 120 wall s = 15 turns of 8 s
  const k3 = { cycleMs: 8000, timeScale: 3 };
  const obs = obsAt(g, t0 + 60_000, k3);
  assert.match(obs, /^- Fire: \(2, 0\) \(becomes Hot Coals in about 15 turns\)$/m);
  assert.match(obs, /Fire\/heat: Fire at \(2, 0\), 2 tiles E \(becomes Hot Coals in about 15 turns\)/);
  // later the coals, then ashes, each with their own timer
  g.world.handle({ type: "MX", changes: [{ x: 2, y: 0, floor: 0, obj: { id: id("Hot Coals"), contained: [] }, responsibleId: -1 }] });
  assert.match(obsAt(g, Date.now(), clock), /^- Hot Coals: \(2, 0\) \(becomes Ashes in about 15 turns\)$/m);
});

test("timers: something already there when first seen gets an upper bound; lasting things get none", () => {
  const g = new FakeGame(gd);
  g.addPlayer({ id: 1, x: 0, y: 0, age: 20, held: 0, female: true });
  g.setTile(3, 0, id("Fire"));
  g.setTile(0, 3, id("Big Hard Rock"));
  g.start();
  const obs = obsAt(g, Date.now());
  assert.match(obs, /^- Fire: \(3, 0\) \(becomes Hot Coals within 8 turns\)$/m, "60 s at 8 s per turn");
  assert.match(obs, /^- Big Hard Rock: \(0, 3\)$/m);
});

test("timers: a held Leaf keeps the age it had on the ground, and keeps it when dropped", async () => {
  const g = new FakeGame(gd);
  g.addPlayer({ id: 1, x: 0, y: 0, age: 20, held: 0, female: true });
  g.start();
  g.world.handle({ type: "MX", changes: [{ x: 1, y: 0, floor: 0, obj: { id: id("Leaf"), contained: [] }, responsibleId: 1 }] });
  g.setTile(1, 0, id("Leaf"));
  const born = Date.now() - 56_000; // pretend it appeared 56 s ago (Leaf lasts 120 s)
  g.world.cell(1, 0)!.since = born;
  const body = new Body(g.conn, g.world, gd);
  await body.use(1, 0);
  assert.equal(g.world.self!.held.id, id("Leaf"));
  assert.equal(g.world.heldSince?.t, born);
  assert.match(obsAt(g, Date.now()), /Holding: Leaf \(gone in about 8 turns\)\./, "~64 s left at 8 s per turn");
  await body.drop(1, 0);
  assert.equal(g.world.sinceAt(1, 0)?.t, born);
});

test("danger line: dangerous animals in view with distance and direction; none, no line", () => {
  const g = new FakeGame(gd);
  g.addPlayer({ id: 1, x: 0, y: 0, age: 20, held: 0, female: true });
  g.setTile(5, 0, id("Wild Boar"));
  g.setTile(-2, -9, id("Wolf"));
  g.setTile(0, 30, id("Wolf")); // out of view
  g.start();
  const obs = obsAt(g, Date.now());
  assert.match(obs, /^DANGER: Wild Boar at \(5, 0\), 5 tiles E; Wolf at \(-2, -9\), 9 tiles S \(they move up to 4 tiles at a jump; a bite wounds\)\.$/m);
  assert.doesNotMatch(obs, /Wild Boar: \(5, 0\) \(/, "no timer on a moving animal");
  const calm = new FakeGame(gd);
  calm.addPlayer({ id: 1, x: 0, y: 0, age: 20, held: 0, female: true });
  calm.start();
  assert.doesNotMatch(obsAt(calm, Date.now()), /DANGER/);
});

test("prompt facts checked against the game data: cooking, fire upkeep, regrowing bushes, food by generation", () => {
  const p = systemPromptFor({ promptBaseline: "playbook", timeScale: 1, decisionCycleMs: 8000 } as object);
  assert.doesNotMatch(p, /never regrows/);
  // Watered Wild Gooseberry Bush -> Wild Gooseberry Bush after 600 s
  assert.equal(gd.transition(-1, id("Watered Wild Gooseberry Bush"))?.autoDecaySeconds, 600);
  assert.equal(gd.transition(id("Bowl of Water"), id("Empty Wild Gooseberry Bush"))?.newTarget, id("Watered Wild Gooseberry Bush"));
  assert.match(p, /an empty wild bush fruits again ~75 turns after you water it/);
  // Fire 60 s -> Hot Coals 120 s -> Ashes; kindling refeeds fire and coals, not ashes
  assert.equal(gd.transition(-1, id("Fire"))?.autoDecaySeconds, 60);
  assert.equal(gd.transition(-1, id("Hot Coals"))?.autoDecaySeconds, 120);
  assert.equal(gd.transition(id("Kindling"), id("Hot Coals"))?.newTarget, id("Fire"));
  assert.equal(gd.transition(id("Kindling"), id("Ashes")), undefined);
  assert.match(p, /A Fire burns down to Hot Coals in ~8 turns and the coals to Ashes in ~15 turns\. Kindling on Fire or Hot Coals keeps it going; Ashes can't be relit\./);
  // skewered meat burns on Fire, cooks on Hot Coals
  assert.equal(gd.name(gd.transition(id("Skewered Rabbit"), id("Fire"))!.newActor), "Burnt Rabbit");
  assert.match(gd.name(gd.transition(id("Skewered Rabbit"), id("Hot Coals"))!.newActor), /^Cooked Rabbit/);
  assert.match(p, /Cook skewered meat on Hot Coals: on open Fire it burns\./);
  assert.match(p, /a picked domestic bush needs a Bowl of Soil, then water, to fruit again/);
  assert.match(p, /gooseberry \+4 from generation 3, \+3 from 7, \+2 from 9, \+1 from 14/);
});

test("new-player prompt (default): controls and our rules only; no game name, recipes, strategy or craft macro", () => {
  const p = systemPromptFor({ timeScale: 3, decisionCycleMs: 8000 } as object);
  assert.equal(p, systemPromptFor({ timeScale: 3, decisionCycleMs: 8000, promptBaseline: "new" } as object));
  assert.match(p, /^You are a person in a world\./);
  assert.match(p, /A year passes every 25 turns\./);
  assert.match(p, /people within 16 tiles of you hear it\. Numbers can't be spoken: they are removed\. Some phrases also have specific consequences/);
  assert.match(p, /"I FOLLOW YOU": the nearest person becomes your leader/);
  assert.match(p, /Name yourself as soon as you appear as an Eve, and name each baby you have while you hold it\./);
  assert.match(p, /What you can do depends on your age:/);
  assert.match(p, /"YOU ARE <FIRST>": names the nameless baby you hold, or, with your arms empty, the nearest nameless person aged 5 or older within 20 tiles/);
  assert.match(p, /From 10: you can carry a baby\./);
  assert.match(p, /While you carry a baby your arms are full/);
  assert.match(p, /These are only the basics\. Everything else about this world is yours to discover\./);
  assert.match(p, /Everyone wears a unique flower in their hair/);
  assert.match(p, /"actions": a list of up to 4 actions/);
  for (const banned of [/One Hour One Life/, /Fire Bow Drill/, /gooseberry/i, /PRIORITIES/, /Don't roam/, /objective/i, /language/i, /"type":"craft"/, /e\.g\./, /\(a turn is/])
    assert.doesNotMatch(p, banned, String(banned));
});

// --- held-item hints (RECIPE_HINTS): what the client's hint pane shows a human

test("hints: the client's hint list for an object, most basic other object first, one per object", () => {
  const names = (n: string) => gd.hints(id(n)).map((t) => `${gd.name(t.actor)} + ${gd.name(t.target)}`);
  assert.deepEqual(names("Ember Leaf"), ["Ember Leaf + Juniper Tinder"]);
  assert.deepEqual(names("Ember Shaft"), ["Leaf + Ember Shaft"]);
  assert.equal(names("Fire Bow Drill")[0], "Fire Bow Drill + Long Straight Shaft");
  assert.ok(names("Kindling").slice(0, 4).includes("Kindling + Burning Tinder"), "on the first 4 pages");
  assert.ok(!names("Kindling").some((n) => /\(\d+\/\d+ left\)/.test(n)), "use steps of other objects collapse into one");
  assert.equal(gd.depth(id("Stone")), 0);
  assert.equal(gd.depth(id("Sharp Stone")), 1);
});

test("hints: the ignition chain can be found one click at a time from the observation", async () => {
  const k3 = { cycleMs: 8000, timeScale: 3 };
  const obs = () => buildObservation(g.world, gd, { recipeHints: true, history: [], notebook: [], pastLifeNotes: [], goal: null, clock: k3 });
  const g = new FakeGame(gd);
  g.addPlayer({ id: 1, x: 0, y: 0, age: 20, held: id("Fire Bow Drill"), female: true });
  g.setTile(1, 0, id("Long Straight Shaft"));
  g.setTile(0, 1, id("Leaf"));
  g.start();
  const body = new Body(g.conn, g.world, gd);
  const set = (x: number, y: number, n: string) => {
    g.setTile(x, y, id(n));
    g.world.handle({ type: "MX", changes: [{ x, y, floor: 0, obj: { id: id(n), contained: [] }, responsibleId: -1 }] });
  };

  assert.match(obs(), /^- use on Long Straight Shaft \(1, 0\): it becomes Ember Shaft$/m);
  await body.use(1, 0);
  // the Ember Shaft lasts 10 game s: the client points its hint at it, so we say what goes on it
  let o = obs();
  assert.match(o, /^- Ember Shaft: \(1, 0\) \(becomes Long Straight Shaft in about 4 turns\)$/m);
  assert.match(o, /^- on the Ember Shaft you just made \(1, 0\): a Leaf -> get Ember Leaf, it becomes Long Straight Shaft$/m);

  await body.drop(0, -1);
  await body.use(0, 1); // pick up the Leaf
  assert.match(obs(), /^- use on Ember Shaft \(1, 0\): get Ember Leaf, it becomes Long Straight Shaft$/m);
  await body.use(1, 0);
  assert.equal(g.world.self!.held.id, id("Ember Leaf"));
  // no tinder in view: the held Ember Leaf's hint still names its one use
  o = obs();
  assert.match(o, /Holding: Ember Leaf \(becomes Leaf in about 4 turns\)/);
  assert.match(o, /^- use it on a Juniper Tinder \(none in view\): get Leaf, it becomes Smoldering Tinder$/m);
  assert.doesNotMatch(o, /you just made/, "this use changed what we hold: the hint follows the Ember Leaf, not the shaft");

  set(-1, 0, "Juniper Tinder");
  o = obs();
  assert.match(o, /^- use on Juniper Tinder \(-1, 0\): get Leaf, it becomes Smoldering Tinder$/m);
  assert.doesNotMatch(o, /none in view/, "shown once, with its place");
  await body.use(-1, 0);
  assert.equal(g.world.objAt(-1, 0).id, id("Smoldering Tinder"));

  // holding Kindling while the tinder smoulders: its hint names the Burning Tinder it will need
  await body.drop(1, 1);
  g.setTile(0, 1, id("Kindling"));
  set(0, 1, "Kindling");
  await body.use(0, 1);
  assert.match(obs(), /^- use it on a Burning Tinder \(none in view\): uses up Kindling, it becomes Fire$/m);
  set(-1, 0, "Burning Tinder");
  assert.match(obs(), /^- use on Burning Tinder \(-1, 0\): uses up Kindling, it becomes Fire$/m);
  await body.use(-1, 0);
  assert.equal(g.world.objAt(-1, 0).id, id("Fire"));
});

test("names: no placeholder in name position that could be copied as a name (\"I AM UNNAMED THORN\")", () => {
  const g = new FakeGame(gd);
  g.addPlayer({ id: 1, x: 0, y: 0, age: 14, held: 0, female: true });
  g.addPlayer({ id: 2, x: 1, y: 0, age: 0.5, held: 0, female: true });
  g.start();
  const obs = buildObservation(g.world, gd, { recipeHints: false, history: [], notebook: [], pastLifeNotes: [], goal: null, clock });
  assert.doesNotMatch(obs, /unnamed/i);
  assert.match(obs, /^#1 \(no name, woman, 14\)/m);
  assert.match(obs, /^- #2 \(no name, baby girl, 0\.5\) /m);
});

test("a named character is told its name in so many words", () => {
  const g = new FakeGame(gd);
  g.addPlayer({ id: 1, x: 0, y: 0, age: 20, held: 0, female: true });
  g.start();
  g.world.self!.name = "LILA PINE";
  const base = { recipeHints: false, history: [], notebook: [], pastLifeNotes: [], goal: null, clock };
  assert.match(buildObservation(g.world, gd, base), /^Your name is LILA PINE\.$/m);
});
