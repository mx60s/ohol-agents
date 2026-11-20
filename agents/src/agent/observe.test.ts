// Observation formatting: food drain in turns, home, water/heat/food summary.
import { test } from "node:test";
import assert from "node:assert/strict";
import { GameData } from "../game/gameData.ts";
import { FakeGame } from "../game/fakeGame.ts";
import { Body } from "../game/body.ts";
import { ageText, buildObservation, direction, foodLine, shortTermNote, HISTORY_SHOWN, THOUGHTS_SHOWN } from "./observe.ts";
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
  assert.match(line, /^Food: 9\/20\. Drains 1 pip per turn \(faster because you are cold\); it runs out in about 8 turns\.$/);
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
    assert.equal(line, `Food: 9/20. Drains 1 pip every ${c.rate} (faster because you are cold); it runs out in ${c.left}.`, `k=${c.k}`);
    // the turn count is wall time / cycle, nothing else
    assert.ok(Math.abs(turnsForWall(foodTime, clock) - (foodTime * 1000) / c.cycleMs) < 1e-9);
  }
  // the regression: k=2 used to show 2x the turns (k x the server's already-scaled time)
  const { w } = hxWorld(2, 0.07);
  assert.doesNotMatch(foodLine(w, { cycleMs: 4700, timeScale: 2 }), /every ~20 turns because|about 190 turns/);
});

test("food line: names cold or heat as the cause without a comparison number", () => {
  for (const k of [1, 2, 3]) {
    const clock = { cycleMs: 5000, timeScale: k };
    const line = foodLine(hxWorld(k, 0.07).w, clock);
    assert.match(line, /\(faster because you are cold\)/);
    assert.doesNotMatch(line, /warm it would be/);
    assert.match(foodLine(hxWorld(k, 0.9).w, clock), /\(faster because you are too hot\)/);
    assert.doesNotMatch(foodLine(hxWorld(k, 0.5).w, clock), /faster because/);
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
  const obs = buildObservation(g.world, gd, { recipeHints: true, history: [], pastLifeNotes: [], goal: null, foodSources: body.foodSources(), clock });
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
  const o = () => buildObservation(g.world, gd, { recipeHints: false, history: [], pastLifeNotes: [], goal: null, clock });
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
  const obs = buildObservation(g.world, gd, { recipeHints: true, history: [], pastLifeNotes: [], goal: null, clock });
  // no boar was seen next to us: every animal that gives a Hog Cut, not one guess
  assert.match(obs, /You are WOUNDED: Hog Cut from a Wild Boar or a Wild Boar with Piglet or a Domestic Boar or a Domestic Boar with Piglet\. A wound fills your hands; it can't be dropped or eaten\. You are bleeding: you die within ~3 turns unless someone heals you \(only a Sterile Wool Pad used on you treats a Hog Cut\)\./);
  assert.match(obs, /Holding: nothing \(hands taken by a wound: Hog Cut\)/);
  assert.doesNotMatch(obs, /eat the Hog Cut/);
  assert.match(obs, /#2 .*, SICK \(Yellow Fever; hands taken\)/);
  const body = new Body(g.conn, g.world, gd);
  assert.match(await body.drop(), /can't drop: your hands are taken by your wound \(Hog Cut\); it can't be put down/);
  assert.match(await body.self(), /can't: your hands are taken by your wound/);
  assert.equal(body.heldName(), "Hog Cut (wound)");
});

test("a wound names the attacker next to you when it appeared, not the first animal that gives it", () => {
  const g = new FakeGame(gd);
  g.addPlayer({ id: 1, x: 0, y: 0, age: 20, held: 0, female: true });
  g.setTile(1, 1, id("Hungry Grizzly Bear"));
  g.setTile(-3, 0, id("Wolf"));
  g.start();
  const obs = () => buildObservation(g.world, gd, { recipeHints: true, history: [], pastLifeNotes: [], goal: null, clock });
  const self = { id: 1, displayId: 19, facing: 0, action: false, actionTarget: [0, 0] as [number, number], heldOriginValid: false, heldOrigin: [0, 0] as [number, number],
    heldTransitionSourceId: 0, heat: 0.07, doneMovingSeq: 0, forced: false, x: 0, y: 0, age: 20, ageRate: 60, moveSpeed: 3.75, clothing: [],
    justAte: false, lastAteId: 0, responsibleId: -1, heldYum: false, heldLearned: false };
  g.world.handle({ type: "PU", updates: [{ ...self, held: { id: id("Bite Wound"), contained: [] } }] });
  assert.match(obs(), /You are WOUNDED: Bite Wound from a Hungry Grizzly Bear\./);
  // the bear walks off: the wound still names it
  g.world.handle({ type: "MX", changes: [{ x: 1, y: 1, floor: 0, obj: { id: 0, contained: [] }, responsibleId: -1 }] });
  assert.match(obs(), /Bite Wound from a Hungry Grizzly Bear\./);
});

test("a wound with no attacker seen lists every animal that gives it", () => {
  const g = new FakeGame(gd);
  g.addPlayer({ id: 1, x: 0, y: 0, age: 20, held: id("Bite Wound"), female: true });
  g.start();
  const obs = buildObservation(g.world, gd, { recipeHints: true, history: [], pastLifeNotes: [], goal: null, clock });
  assert.match(obs, /Bite Wound from a Wolf or a Shot Wolf or a Grizzly Bear or a Hungry Grizzly Bear or .*a Sleepy Grizzly Bear\./);
});

test("hints: the same kind as the held thing is 'another'; a made-only thing is 'not found in the wild', a natural one 'none in view'", () => {
  const g = new FakeGame(gd);
  g.addPlayer({ id: 1, x: 0, y: 0, age: 20, held: id("Milkweed Stalk"), female: true });
  g.start();
  const obs = () => buildObservation(g.world, gd, { recipeHints: true, history: [], pastLifeNotes: [], goal: null, clock });
  assert.match(obs(), /^- use it on another Milkweed Stalk \(not found in the wild: it is made\): .*Thread/m);
  assert.doesNotMatch(obs(), /a Milkweed Stalk/);
  g.world.handle({ type: "MX", changes: [{ x: 1, y: 0, floor: 0, obj: { id: id("Milkweed Stalk"), contained: [] }, responsibleId: -1 }] });
  assert.match(obs(), /^- use on another Milkweed Stalk \(1, 0\): /m);
  // a natural thing keeps "none in view"
  assert.equal(gd.madeOnly(id("Stone")), false);
  assert.equal(gd.madeOnly(id("Sharp Stone")), true);
  const g2 = new FakeGame(gd);
  g2.addPlayer({ id: 1, x: 0, y: 0, age: 20, held: id("Sharp Stone"), female: true });
  g2.start();
  const o2 = buildObservation(g2.world, gd, { recipeHints: true, history: [], pastLifeNotes: [], goal: null, clock });
  assert.match(o2, /\(none in view\)/, o2.split("YOU COULD")[1]);
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
  const obs = buildObservation(g.world, gd, { recipeHints: true, history: [], pastLifeNotes: [], goal: null, clock });
  assert.match(obs, /#2 .*, WOUNDED \(Bite Wound; hands taken; treated only by a Sterile Wool Pad\)/);
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
  const obs = buildObservation(g.world, gd, { recipeHints: false, history: [], pastLifeNotes: [], goal: null, clock });
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
  const at = (ms: number) => buildObservation(g.world, gd, { recipeHints: false, history: [], pastLifeNotes: [], goal: null, clock, now: Date.now() + ms });
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
  const obs = buildObservation(g.world, gd, { recipeHints: true, history: [], pastLifeNotes: [], goal: null, clock });
  assert.match(obs, /notice from the game: "YOU INHERITED A HOME"/);
  // languages are on from the first player (minActivePlayersForLanguages = 1)
  assert.match(obs, /#7 .*\[other family: their language differs from yours\]: "TOBA KEMI"/, "nothing better known: another family's speech is scrambled");
  const withHook = (r: boolean | null) => buildObservation(g.world, gd, { recipeHints: false, history: [], pastLifeNotes: [], goal: null, clock, speechScrambled: () => r });
  assert.match(withHook(true), /#7 .*\[other family: their language differs from yours\]: "TOBA KEMI"/, "the words differed from what #7 said");
  assert.doesNotMatch(withHook(false), /language differs/, "same words as said (e.g. learned by living together)");
  assert.match(withHook(null), /language differs/, "unknown: fall back to the population rule");
  assert.match(obs, /Food: 2\/4, STARVING - say F so a woman picks you up/);
  assert.doesNotMatch(obs, /EAT NOW/, "babies can't eat");
  assert.match(systemPromptFor({ promptBaseline: "playbook" }), /speech between families arrives as scrambled words/);
  // a full banana plant gives a banana and keeps 6 of 7 (not the last-use "Empty Banana Plant")
  assert.equal(gd.name(gd.transition(0, 2142)!.newTarget), "Banana Plant (6/7 left)");
  assert.equal(gd.name(gd.transition(0, 6953)!.newTarget), "Empty Banana Plant", "the last banana empties it");
  // a baby that died at 0.88 is not "age 1"
  g.world.handle({ type: "PU", updates: [{ id: 3, displayId: 347, facing: 0, action: false, actionTarget: [0, 0], held: { id: 0, contained: [] }, heldOriginValid: false, heldOrigin: [0, 0], heldTransitionSourceId: 0, heat: 0.5, doneMovingSeq: 0, forced: false, x: null as unknown as number, y: null as unknown as number, age: 0.88, ageRate: 60, moveSpeed: 3.75, clothing: [], justAte: false, lastAteId: 0, responsibleId: -1, heldYum: false, heldLearned: false, deathReason: "reason_hunger" }] });
  const obs2 = buildObservation(g.world, gd, { recipeHints: false, history: [], pastLifeNotes: [], goal: null, clock });
  assert.match(obs2, /== WHAT YOU SAW NEARBY ==\n- just now: #3 \(no name, baby girl, 0\.8\) \[your sibling\] died at \(2, 0\): starved/);
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
  const base = { recipeHints: false, history: [], pastLifeNotes: [], goal: null, clock };
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

const obsAt = (g: FakeGame, now: number, clk = clock) => buildObservation(g.world, gd, { recipeHints: false, history: [], pastLifeNotes: [], goal: null, clock: clk, now });

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
  assert.match(p, /people within 16 tiles of you hear it\. Numbers can't be spoken: they are removed\. When giving directions to an area, name areas or describe landmarks instead\. Some phrases also have specific consequences/);
  assert.match(p, /"I FOLLOW YOU": the nearest person becomes your leader/);
  assert.match(p, /Name yourself as soon as you appear as an Eve, and name each baby you have while you hold it or stand next to it\./);
  assert.match(p, /What you can do depends on your age:/);
  assert.match(p, /"type":"give","person":ID\}  put what you hold down next to another person for them to pick up/);
  assert.match(p, /"YOU ARE <FIRST>": names the nameless baby you hold, or a nameless baby within 3 tiles of you, or else the nearest nameless person aged 5 or older within 20 tiles/);
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
  const obs = () => buildObservation(g.world, gd, { recipeHints: true, history: [], pastLifeNotes: [], goal: null, clock: k3 });
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
  assert.match(o, /^- use it on a Juniper Tinder \(not found in the wild: it is made\): get Leaf, it becomes Smoldering Tinder$/m);
  assert.doesNotMatch(o, /you just made/, "this use changed what we hold: the hint follows the Ember Leaf, not the shaft");

  set(-1, 0, "Juniper Tinder");
  o = obs();
  assert.match(o, /^- use on Juniper Tinder \(-1, 0\): get Leaf, it becomes Smoldering Tinder$/m);
  assert.doesNotMatch(o, /use it on a Juniper Tinder/, "shown once, with its place");
  await body.use(-1, 0);
  assert.equal(g.world.objAt(-1, 0).id, id("Smoldering Tinder"));

  // holding Kindling while the tinder smoulders: its hint names the Burning Tinder it will need
  await body.drop(1, 1);
  g.setTile(0, 1, id("Kindling"));
  set(0, 1, "Kindling");
  await body.use(0, 1);
  assert.match(obs(), /^- use it on a Burning Tinder \(not found in the wild: it is made\): uses up Kindling, it becomes Fire$/m);
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
  const obs = buildObservation(g.world, gd, { recipeHints: false, history: [], pastLifeNotes: [], goal: null, clock });
  assert.doesNotMatch(obs, /unnamed/i);
  assert.match(obs, /^#1 \(no name, woman, 14\)/m);
  assert.match(obs, /^- #2 \(no name, baby girl, 0\.5\) /m);
});

test("a named character is told its name in so many words", () => {
  const g = new FakeGame(gd);
  g.addPlayer({ id: 1, x: 0, y: 0, age: 20, held: 0, female: true });
  g.start();
  g.world.self!.name = "LILA PINE";
  const base = { recipeHints: false, history: [], pastLifeNotes: [], goal: null, clock };
  assert.match(buildObservation(g.world, gd, base), /^Your name is LILA PINE\.$/m);
});

test("a mother holding her own unnamed baby is asked to name it; not once it has a name, not for someone else's baby", () => {
  const base = { recipeHints: false, history: [], pastLifeNotes: [], goal: null, clock };
  const mk = (motherId: number) => {
    const g = new FakeGame(gd);
    g.addPlayer({ id: 1, x: 0, y: 0, age: 20, held: -2, female: true });
    g.addPlayer({ id: 2, x: 0, y: 0, age: 0.1, held: 0, female: true, motherId });
    g.start();
    return g;
  };
  const own = mk(1);
  assert.match(buildObservation(own.world, gd, base), /Your baby #2 has no name yet: name her or him now by saying "YOU ARE <FIRST NAME>"/);
  own.world.handle({ type: "NM", names: [{ id: 2, first: "AURORA", last: "SAGE" }] });
  assert.doesNotMatch(buildObservation(own.world, gd, base), /has no name yet/);
  const other = mk(9);
  assert.doesNotMatch(buildObservation(other.world, gd, base), /has no name yet/);
});

test("leadership from the server's FW messages: who you follow and who follows you", () => {
  const base = { recipeHints: false, history: [], pastLifeNotes: [], goal: null, clock };
  const g = new FakeGame(gd);
  g.addPlayer({ id: 1, x: 0, y: 0, age: 30, held: 0, female: true });
  g.addPlayer({ id: 2, x: 2, y: 0, age: 20, held: 0, female: true });
  g.addPlayer({ id: 3, x: 3, y: 0, age: 40, held: 0, female: true });
  g.start();
  g.world.handle({ type: "NM", names: [{ id: 3, first: "LUNA", last: "THISTLE" }] });
  g.world.handle({ type: "FW", follows: [{ followerId: 1, leaderId: 3, colorIndex: 0 }, { followerId: 2, leaderId: 1, colorIndex: 0 }] });
  const o = buildObservation(g.world, gd, base);
  assert.match(o, /^You follow #3 LUNA THISTLE\.$/m);
  assert.match(o, /^Your followers: #2\.$/m);
  g.world.handle({ type: "FW", follows: [{ followerId: 1, leaderId: -1, colorIndex: 0 }] });
  assert.doesNotMatch(buildObservation(g.world, gd, base), /You follow/);
});

test("children 3-13 are girls and boys, not women and men (a mother asked her 4-year-old 'woman' to carry the baby)", () => {
  const g = new FakeGame(gd);
  g.addPlayer({ id: 1, x: 0, y: 0, age: 21, held: 0, female: true });
  g.addPlayer({ id: 2, x: 1, y: 0, age: 4, held: 0, female: true });
  g.addPlayer({ id: 3, x: 2, y: 0, age: 13, held: 0, female: false });
  g.addPlayer({ id: 4, x: 3, y: 0, age: 14, held: 0, female: false });
  g.start();
  const obs = buildObservation(g.world, gd, { recipeHints: false, history: [], pastLifeNotes: [], goal: null, clock });
  assert.match(obs, /^#1 \(no name, woman, 21\)/m);
  assert.match(obs, /^- #2 \(no name, girl, 4\) /m);
  assert.match(obs, /^- #3 \(no name, boy, 13\) /m);
  assert.match(obs, /^- #4 \(no name, man, 14\) /m);
});

test("a mother keeps her children out of sight: last seen where and when; dropped on death or once grown", () => {
  let t = 1_000_000;
  const g = new FakeGame(gd, 1, 5, () => t);
  g.addPlayer({ id: 1, x: -10, y: 57, age: 25, held: 0, female: true });
  g.addPlayer({ id: 29, x: -130, y: 57, age: 1.2, held: 0, female: true, motherId: 1 });
  g.addPlayer({ id: 30, x: -12, y: 57, age: 13.5, held: 0, female: false, motherId: 1 });
  g.start();
  g.world.handle({ type: "NM", names: [{ id: 29, first: "STAR", last: "PINE" }] });
  const base = { recipeHints: false, history: [], pastLifeNotes: [], goal: null, clock };
  assert.doesNotMatch(buildObservation(g.world, gd, { ...base, now: t }), /out of sight/, "all in range");
  g.world.handle({ type: "PO", ids: [29, 30] });
  t += 3 * 8000;
  const obs = buildObservation(g.world, gd, { ...base, now: t });
  assert.match(obs, /^Your children out of sight: #29 STAR PINE \(baby girl, 1\.6\) last seen at \(-130,57\), 120 tiles away, 3 turns ago; #30 \(boy, 13\) last seen at \(-12,57\), 2 tiles away, 3 turns ago\.$/m);
  // #30 turns 14: no longer tracked
  t += 30_000;
  g.world.handle({ type: "HX", heat: { heat: 0.5, foodTime: 10, indoorBonus: 0 } });
  assert.doesNotMatch(buildObservation(g.world, gd, { ...base, now: t }), /#30/);
  // a death message for #29 ends the record
  g.world.handle({ type: "PU", updates: [{ id: 29, displayId: 19, facing: 0, action: false, actionTarget: [0, 0], held: { id: 0, contained: [] }, heldOriginValid: false, heldOrigin: [0, 0], heldTransitionSourceId: 0, heat: 0.5, doneMovingSeq: 0, forced: false, x: null as unknown as number, y: null as unknown as number, age: 1.8, ageRate: 60, moveSpeed: 3.75, clothing: [], justAte: false, lastAteId: 0, responsibleId: -1, heldYum: false, heldLearned: false, deathReason: "reason_hunger" }] });
  assert.doesNotMatch(buildObservation(g.world, gd, { ...base, now: t }), /out of sight/);
});

test("food at 0: you starve to death at the next drain (server.cpp: foodStore below 0 kills), counted from the last drop", () => {
  let t = 1_000_000;
  const g = new FakeGame(gd, 1, 5, () => t);
  g.addPlayer({ id: 1, x: 0, y: 0, age: 20, held: 0, female: true });
  g.food = 1;
  g.cap = 12;
  g.start();
  g.world.handle({ type: "HX", heat: { heat: 0.5, foodTime: 32, indoorBonus: 0 } });
  const fx = (food: number, yumBonus = 0) => g.world.handle({ type: "FX", food: { food, capacity: 12, lastAteId: 0, lastAteFillMax: 0, moveSpeed: 3.75, responsibleId: -1, yumBonus, yumMultiplier: 1 } });
  fx(0);
  assert.match(foodLine(g.world, clock), /^Food: 0\/12, STARVING - EAT NOW: empty; you starve to death in about 4 turns unless you eat \(at the next drain; it drains 1 pip every ~4 turns\)\.$/);
  t += 16_000;
  assert.match(foodLine(g.world, clock), /you starve to death in about 2 turns unless you eat/);
  assert.doesNotMatch(foodLine(g.world, clock), /less than 1 turn/);
  // a yum bonus is used up first: one more drain per bonus pip
  fx(0, 1);
  fx(0, 0);
  fx(0, 1);
  assert.match(foodLine(g.world, clock), /you starve to death in about 8 turns/);
});

test("age labels round down: 2.97 is a baby of 2.9, not 3.0; 13.6 is 13", () => {
  assert.equal(ageText(2.97), "2.9");
  assert.equal(ageText(13.6), "13");
  assert.equal(ageText(0.3), "0.3");
  assert.equal(ageText(2.97, 1), "2.9");
  const g = new FakeGame(gd);
  g.addPlayer({ id: 1, x: 0, y: 0, age: 20, held: 0, female: true });
  g.addPlayer({ id: 2, x: 1, y: 0, age: 2.97, held: 0, female: true });
  g.start();
  assert.match(buildObservation(g.world, gd, { recipeHints: false, history: [], pastLifeNotes: [], goal: null, clock }), /#2 \(no name, baby girl, 2\.9\)/);
});

test("+FAMILY+ and other +WORD+ server markers are not speech; a naming line is checked for scrambling on its spoken words", () => {
  const g = new FakeGame(gd);
  g.addPlayer({ id: 1, x: 0, y: 0, age: 20, held: 0, female: true });
  g.addPlayer({ id: 7, x: 3, y: 0, age: 30, held: 0, female: true, motherId: 50 });
  g.addPlayer({ id: 21, x: 4, y: 0, age: 0.1, held: 0, female: true, motherId: 7 });
  g.start();
  g.world.handle({ type: "LN", lineages: [{ id: 1, ancestors: [], eveId: 1 }, { id: 7, ancestors: [50], eveId: 50 }, { id: 21, ancestors: [7], eveId: 50 }] });
  g.world.handle({ type: "PS", says: [{ id: 7, isCurse: false, text: "+FAMILY+" }] });
  g.world.handle({ type: "PS", says: [{ id: 7, isCurse: false, text: "+FAMILY+ HELLO" }] });
  assert.deepEqual(g.world.heard.map((h) => h.text), ["HELLO"]);
  g.world.handle({ type: "PS", says: [{ id: 7, isCurse: false, text: "YOU ARE LUNA" }] });
  g.world.handle({ type: "NM", names: [{ id: 21, first: "LUNA", last: "THORN" }] });
  const seen: string[] = [];
  const obs = buildObservation(g.world, gd, { recipeHints: false, history: [], pastLifeNotes: [], goal: null, clock, speechScrambled: (_id, text) => (seen.push(text), text !== "YOU ARE LUNA") });
  assert.ok(seen.includes("YOU ARE LUNA"), seen.join(" | "));
  assert.match(obs, /#7 \(no name, woman, 30\): "YOU ARE LUNA \[this named #21\]"/, "same words as said: not tagged as another language");
});

test("new-player prompt: fixed things can't be carried, said generally", () => {
  const p = systemPromptFor({} as object);
  assert.match(p, /Some things \(trees, bushes, big rocks, deposits, piles\) are fixed in place and can't be carried\./);
  assert.doesNotMatch(p, /Trees and bushes can't be carried/);
});

// --- WHAT YOU SAW NEARBY (World.seen)

function pu(id: number, x: number, y: number, o: Record<string, unknown> = {}) {
  return { id, displayId: 19, facing: 0, action: false, actionTarget: [0, 0] as [number, number], held: { id: 0, contained: [] }, heldOriginValid: false, heldOrigin: [0, 0] as [number, number], heldTransitionSourceId: 0, heat: 0.5, doneMovingSeq: 0, forced: false, x, y, age: 30, ageRate: 60, moveSpeed: 3.75, clothing: [], justAte: false, lastAteId: 0, responsibleId: -1, heldYum: false, heldLearned: false, ...o };
}
const mxc = (x: number, y: number, obj: number, responsibleId: number, from?: [number, number]) =>
  ({ type: "MX" as const, changes: [{ x, y, floor: 0, obj: { id: obj, contained: [] }, responsibleId, ...(from ? { from: { x: from[0], y: from[1], speed: 1 } } : {}) }] });

function seenScene() {
  let t = 1_000_000;
  const g = new FakeGame(gd, 1, 5, () => t);
  g.addPlayer({ id: 1, x: 0, y: 0, age: 30, held: 0, female: true });
  g.addPlayer({ id: 4, x: 3, y: 0, age: 30, held: 0, female: true });
  g.setTile(2, 2, id("Sharp Stone"));
  g.setTile(1, 1, id("Milkweed Stalk"));
  g.start();
  g.world.seenMergeMs = 8000;
  g.world.handle({ type: "NM", names: [{ id: 4, first: "LIRA", last: "TIDEWICK" }] });
  const obs = () => buildObservation(g.world, gd, { recipeHints: false, history: [], pastLifeNotes: [], goal: null, clock, now: t });
  return { g, obs, tick: (turns: number) => (t += turns * 8000) };
}

test("WHAT YOU SAW NEARBY: people, others' doings, a dangerous animal and a death, newest last; not our own doings", () => {
  const { g, obs, tick } = seenScene();
  const w = g.world;
  assert.equal(w.seen.length, 0, "who was already there when we appeared is not an event");
  w.handle({ type: "PU", updates: [pu(5, 6, 6, { displayId: 347 })] });
  w.handle(mxc(2, 2, 0, 4));
  tick(1);
  // #4 takes up a Milkweed Stalk, then uses it on the one on the ground
  w.handle({ type: "PU", updates: [pu(4, 3, 0, { held: { id: id("Milkweed Stalk"), contained: [] } })] });
  w.handle({ type: "PU", updates: [pu(4, 3, 0)] });
  w.handle(mxc(1, 1, id("Thread"), 4));
  w.handle(mxc(0, 1, id("Leaf"), 1)); // our own drop: already in YOUR LAST ACTIONS
  // a wolf comes into view and closes in within one turn: one line, latest position
  w.handle(mxc(10, 0, id("Wolf"), -1, [20, 0]));
  w.handle(mxc(8, 0, id("Wolf"), -1, [10, 0]));
  tick(1);
  w.handle(mxc(6, 0, id("Wolf"), -1, [8, 0]));
  w.handle(mxc(5, 0, id("Wolf"), -1, [6, 0]));
  w.handle({ type: "PU", updates: [pu(5, null as unknown as number, null as unknown as number, { displayId: 347, deathReason: "reason_hunger" })] });
  const o = obs();
  const section = o.slice(o.indexOf("== WHAT YOU SAW NEARBY =="), o.indexOf("\n\n== HEARD =="));
  assert.equal(section, [
    "== WHAT YOU SAW NEARBY ==",
    "- 2 turns ago: #5 (no name, man, 30) came into view at (6, 6)",
    "- 2 turns ago: #4 LIRA TIDEWICK (woman, 30) picked up a Sharp Stone from (2, 2)",
    "- 1 turn ago: #4 LIRA TIDEWICK (woman, 30) used a Milkweed Stalk on a Milkweed Stalk at (1, 1): it became Thread",
    "- 1 turn ago: a Wolf came into view at (8, 0), 8 tiles from you",
    "- just now: a Wolf moved to (5, 0), 5 tiles from you",
    "- just now: #5 (no name, man, 30) died at (6, 6): starved",
  ].join("\n"));
  assert.doesNotMatch(o, /DEATHS YOU SAW|Leaf at \(0, 1\)/);
  // about 5 turns later the old lines are gone
  tick(5);
  assert.doesNotMatch(obs(), /picked up a Sharp Stone/);
  assert.match(obs(), /5 turns ago: #5 .* died/);
});

test("WHAT YOU SAW NEARBY: babies picked up and put down, births, naming, out of view; at most 20 lines, a busy person folded", () => {
  const { g, obs, tick } = seenScene();
  const w = g.world;
  w.handle({ type: "PU", updates: [pu(9, 3, 1, { age: 0 })] });
  w.handle({ type: "LN", lineages: [{ id: 9, ancestors: [4], eveId: 4 }] });
  w.handle({ type: "PU", updates: [pu(4, 3, 0, { held: { id: -9, contained: [] } })] });
  w.handle({ type: "PS", says: [{ id: 4, isCurse: false, text: "YOU ARE AURORA" }] });
  w.handle({ type: "NM", names: [{ id: 9, first: "AURORA", last: "TIDEWICK" }] });
  w.handle({ type: "PU", updates: [pu(4, 3, 0)] });
  tick(1);
  w.handle({ type: "PU", updates: [pu(4, 40, 0, { forced: true })] });
  const o = obs();
  assert.match(o, /- 1 turn ago: #9 AURORA TIDEWICK \(baby girl, 0\.0\) was born at \(3, 1\)/);
  assert.match(o, /- 1 turn ago: #4 LIRA TIDEWICK \(woman, 30\) picked up #9 AURORA TIDEWICK/);
  assert.match(o, /- 1 turn ago: #4 LIRA TIDEWICK \(woman, 30\) named #9 AURORA TIDEWICK/);
  assert.match(o, /- 1 turn ago: #4 LIRA TIDEWICK \(woman, 30\) put down #9 AURORA TIDEWICK/);
  assert.match(o, /- just now: #4 LIRA TIDEWICK \(woman, 30\) went out of view/);
  // one person doing many things in a turn: 2 lines, the rest counted
  w.handle({ type: "PU", updates: [pu(4, 3, 0, { forced: true })] });
  for (let i = 0; i < 7; i++) w.handle(mxc(-2, i, id("Stone"), 4));
  const busy = obs();
  assert.equal((busy.match(/put down a Stone/g) ?? []).length, 4);
  assert.match(busy, /put down a Stone at \(-2, 3\) \(and 3 more changes by them\)/);
  for (let i = 0; i < 24; i++) w.handle({ type: "PU", updates: [pu(20 + i, 5, i - 12)] });
  const lines = obs().split("== WHAT YOU SAW NEARBY ==\n")[1].split("\n\n")[0].split("\n");
  assert.equal(lines.length, 20, "at most 20 lines");
  assert.match(lines.at(-1)!, /#43 .* came into view/, "newest last; the oldest dropped");
});

test("recent thoughts: shown dated and in full (no 200-char cut)", () => {
  const g = new FakeGame(gd);
  g.addPlayer({ id: 1, x: 0, y: 0, age: 20, held: 0, female: true });
  g.start();
  const long = "I will " + "carefully ".repeat(30) + "make thread.";
  const now = g.world.now();
  const obs = buildObservation(g.world, gd, { recipeHints: false, history: [], pastLifeNotes: [], goal: null, clock, recentThoughts: [{ t: now - 2, text: "First." }, { t: now - 1, text: "Second." }, { t: now, text: long }] });
  assert.match(obs, /Your recent thoughts:\n- [^\n]*: "First\."\n- [^\n]*: "Second\."\n- [^\n]*: "I will carefully/);
  assert.ok(obs.includes(long), "the long thought is shown whole");
});

test("short-term memory note: under YOUR LAST ACTIONS with the real counts; years mentioned only when year lines are on", () => {
  const g = new FakeGame(gd);
  g.addPlayer({ id: 1, x: 0, y: 0, age: 31, held: 0, female: true });
  g.start();
  const now = g.world.now();
  const base = { recipeHints: false, history: [{ t: now, action: "eat", result: "ate" }], pastLifeNotes: [], goal: null, clock, now, recentThoughts: [{ t: now, text: "Eat." }], kept: [{ t: now, text: "pond west" }] };
  const off = buildObservation(g.world, gd, base);
  const note = `(You see your last ${HISTORY_SHOWN} actions and last ${THOUGHTS_SHOWN} thoughts; older ones fade unless you chose to remember them.)`;
  assert.equal(note, "(You see your last 30 actions and last 10 thoughts; older ones fade unless you chose to remember them.)");
  assert.ok(off.includes(`== YOUR LAST ACTIONS ==\n${note}\nYour recent thoughts:\n`), off);
  assert.doesNotMatch(off, /PAST YEARS|each past year/);
  // year lines off: lines given but not shown, byte-identical to no year options at all
  const years = [{ from: 29, to: 30, text: "you gathered berries" }, { from: 30, to: 31, text: "you made a fire at (3, 4) with your mother" }, { from: 31, to: 31, text: "you held your baby" }];
  assert.equal(buildObservation(g.world, gd, { ...base, years, yearLinesShown: 0 }), off);
  assert.equal(buildObservation(g.world, gd, { ...base, years: [], yearLinesShown: 2 }).replace(shortTermNote(2), note), off, "on with no lines yet: only the note differs");

  const on = buildObservation(g.world, gd, { ...base, years, yearLinesShown: 2 });
  assert.equal(shortTermNote(2), "(You see your last 30 actions and last 10 thoughts; older ones fade unless you chose to remember them. A one-line summary of each past year of this life is kept; the last 2 are shown under YOUR PAST YEARS.)");
  assert.match(shortTermNote(1), /the last one is shown under YOUR PAST YEARS\.\)$/);
  assert.ok(on.includes(`== YOUR LAST ACTIONS ==\n${shortTermNote(2)}\n`));
  // the rest is unchanged: the section is appended at the end, after THINGS YOU CHOSE TO REMEMBER, newest last, only the last N
  assert.equal(on.replace(shortTermNote(2), note), off + "\n\n== YOUR PAST YEARS ==\n- Age 30-31: you made a fire at (3, 4) with your mother\n- Age 31: you held your baby");
  assert.ok(on.indexOf("== THINGS YOU CHOSE TO REMEMBER ==") < on.indexOf("== YOUR PAST YEARS =="));
  const three = buildObservation(g.world, gd, { ...base, years, yearLinesShown: 3 });
  assert.match(three, /== YOUR PAST YEARS ==\n- Age 29-30: you gathered berries\n- Age 30-31: [^\n]*\n- Age 31: you held your baby$/);
});

test("prompted personality: 'You are <descriptor>.' is the system prompt's second sentence; none = unchanged", () => {
  const plain = systemPromptFor({});
  const p = systemPromptFor({}, "conscientious and restless");
  assert.ok(p.startsWith("You are a person in a world. You are conscientious and restless. Everyone else is an independent mind like you."));
  assert.equal(p.replace(" You are conscientious and restless.", ""), plain);
  assert.equal(systemPromptFor({}, null), plain);
  assert.notEqual(systemPromptFor({}, "sociable and sentimental"), p, "cached per descriptor");
});
