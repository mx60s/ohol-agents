// Body skills against the in-process fake server (real game data, no network).
import { test } from "node:test";
import assert from "node:assert/strict";
import { GameData, withArticle } from "./gameData.ts";
import { ANIMAL_JUMP_TILES, Body, sayLimit } from "./body.ts";
import { FakeGame } from "./fakeGame.ts";

const gd = new GameData();
const SHARP_STONE = gd.idByName("Sharp Stone")!;
const BUSH = gd.idByName("Wild Gooseberry Bush")!;

function setup(held: number, bushAt: [number, number]) {
  const g = new FakeGame(gd);
  g.addPlayer({ id: 1, x: 0, y: 0, age: 20, held, female: true });
  g.setTile(bushAt[0], bushAt[1], BUSH);
  return g;
}

test("forage with a tool in hand: eats, then picks the tool back up", async () => {
  const g = setup(SHARP_STONE, [5, 0]);
  g.food = 8;
  g.start();
  const body = new Body(g.conn, g.world, gd);
  const r = await body.forage();
  assert.equal(g.world.self!.held.id, SHARP_STONE, `tool back in hand (${r})`);
  assert.ok(g.food > 8, "ate");
  assert.match(r, /ate .*Gooseberry/);
  assert.match(r, /picked Sharp Stone back up/);
  assert.equal([...g.tiles.values()].filter((id) => id === SHARP_STONE).length, 0, "no stone left on the ground");
  // the tool was set down next to the food, not back where we started
  const drop = g.sent.find((c) => c.startsWith("DROP"))!;
  const [, dx, dy] = drop.split(" ").map(Number);
  assert.ok(Math.max(Math.abs(dx - 5), Math.abs(dy)) <= 2, `dropped next to the bush, not at the start (${drop})`);
});

test("forage carrying a baby: takes it along, sets it down by the food only briefly, and re-picks it", async () => {
  const g = setup(-2, [8, 0]);
  g.addPlayer({ id: 2, x: 0, y: 0, age: 0.5, held: 0, female: false, motherId: 1 });
  g.food = 6;
  g.start();
  const body = new Body(g.conn, g.world, gd);
  const r = await body.forage();
  assert.equal(g.world.self!.held.id, -2, `baby back in arms (${r})`);
  assert.match(r, /picked up baby .* again/);
  const down = g.babyLog.find((e) => e[2] === "down")!;
  const up = g.babyLog.find((e) => e[2] === "up" && e[0] >= down[0])!;
  assert.ok(down && up, "baby was put down and picked up");
  assert.ok(up[0] - down[0] < 2000, `baby down only briefly (${up[0] - down[0]} ms)`);
  const baby = g.players.get(2)!;
  assert.ok(Math.max(Math.abs(baby.x - 8), Math.abs(baby.y)) <= 2, "baby was carried to the food");
  // the walk to the food happened with the baby in arms: the first MOVE precedes the DROP
  assert.ok(g.sent.findIndex((c) => c.startsWith("MOVE")) < g.sent.findIndex((c) => c.startsWith("DROP")));
});

test("forage reports a baby it could not pick back up, with where it is", async () => {
  const g = setup(-2, [3, 0]);
  g.addPlayer({ id: 2, x: 0, y: 0, age: 0.5, held: 0, female: false, motherId: 1 });
  g.start();
  // sabotage: the server ignores the pickup
  const conn = g.conn;
  const body = new Body({ send: (c: string) => (c.startsWith("BABY") ? undefined : conn.send(c)) }, g.world, gd);
  const r = await body.forage();
  assert.match(r, /COULDN'T PICK THE BABY BACK UP/);
  assert.match(r, /baby #2 is at/);
});

test("a long walk stops on an urgent interrupt between legs", async () => {
  const g = setup(0, [100, 100]);
  g.start(40);
  const body = new Body(g.conn, g.world, gd);
  let legs = 0;
  body.interrupt = () => (legs++ >= 1 ? "your baby says F" : null);
  const r = await body.walkTo([[40, 0]]);
  assert.match(r, /stopped walking at .*your baby says F/);
});

test("onWalk reports each walk's start and target once (approach: the target tile, not the tile beside it)", async () => {
  const g = setup(0, [100, 100]);
  g.start(40);
  const body = new Body(g.conn, g.world, gd);
  const walks: [number[], number[]][] = [];
  body.onWalk = (from, to) => walks.push([from, to]);
  assert.equal(await body.walkTo([[5, 0]]), "arrived");
  assert.equal(await body.walkTo([[5, 0]]), "arrived", "already there: no walk");
  await body.approach(100, 100);
  assert.deepEqual(walks[0], [[0, 0], [5, 0]]);
  assert.deepEqual(walks[1], [[5, 0], [100, 100]]);
  assert.equal(walks.length, 2);
});

/** tiles the MOVE commands walked through */
function walked(g: FakeGame): [number, number][] {
  const out: [number, number][] = [];
  for (const c of g.sent.filter((s) => s.startsWith("MOVE"))) {
    const p = c.split(" ");
    const sx = Number(p[1]), sy = Number(p[2]);
    const d = p.slice(4).map(Number);
    for (let i = 0; i < d.length; i += 2) out.push([sx + d[i], sy + d[i + 1]]);
  }
  return out;
}

test("pathing goes around a dangerous animal when there is room", async () => {
  const g = setup(0, [99, 99]);
  const BOAR = gd.idByName("Wild Boar")!;
  assert.equal(gd.dangerRadius(BOAR), 1);
  assert.equal(gd.dangerRadius(gd.idByName("Knife")!), 0, "a weapon on the ground is not an animal");
  g.setTile(5, 0, BOAR);
  g.start();
  const body = new Body(g.conn, g.world, gd);
  const r = await body.walkTo([[10, 0]]);
  assert.equal(r, "arrived");
  const close = walked(g).filter(([x, y]) => Math.max(Math.abs(x - 5), Math.abs(y)) <= ANIMAL_JUMP_TILES);
  assert.equal(ANIMAL_JUMP_TILES, 4);
  assert.deepEqual(close, [], "never within a boar's jump (4 tiles)");
  assert.deepEqual(body.takeNotes(), []);
});

test("pathing that has to pass a dangerous animal says so", async () => {
  const g = setup(0, [99, 99]);
  const WALL = [...gd.objects.values()].find((o) => o.blocksWalking && o.permanent && /^Stone Wall/.test(o.name))!.id;
  for (let x = -2; x <= 12; x++) {
    g.setTile(x, 1, WALL);
    g.setTile(x, -1, WALL);
  }
  g.setTile(10, 2, gd.idByName("Wild Boar")!); // right next to where we are going
  g.start();
  const body = new Body(g.conn, g.world, gd);
  assert.equal(await body.walkTo([[10, 0]]), "arrived");
  const notes = body.takeNotes();
  assert.match(notes.join(), /your path passed within 2 tiles of a Wild Boar at \(10,2\); no safer way around/);
  assert.equal(notes.length, 1, "one note per animal, at its closest");
  assert.ok(walked(g).some(([x, y]) => x === 10 && y === 0));
});

test("starting within a swarm's jump margin still routes around its biting range", async () => {
  const g = setup(0, [99, 99]);
  const SWARM = gd.idByName("Mosquito Swarm")!;
  g.setTile(3, 0, SWARM); // straight ahead, 3 tiles away: we start inside its 4-tile margin
  g.start();
  const body = new Body(g.conn, g.world, gd);
  assert.equal(await body.walkTo([[6, 0]]), "arrived");
  const bitten = walked(g).filter(([x, y]) => Math.max(Math.abs(x - 3), Math.abs(y)) <= 1);
  assert.deepEqual(bitten, [], "never within the swarm's biting range");
});

test("pick_up_baby with full hands says why instead of a silent 'nothing happened'", async () => {
  const g = setup(SHARP_STONE, [9, 9]);
  g.addPlayer({ id: 2, x: 1, y: 0, age: 0.5, held: 0, female: false, motherId: 1 });
  g.start();
  const body = new Body(g.conn, g.world, gd);
  const r = await body.pickUpBaby(2);
  assert.equal(r, "tried to pick up #2: your hands are full (holding Sharp Stone); drop it first");
  assert.equal(g.sent.filter((c) => c.startsWith("BABY")).length, 0, "nothing sent");
});

test("a use the game has no transition for says so; a real one doesn't", async () => {
  const KINDLING = gd.idByName("Kindling")!, LFF = gd.idByName("Large Fast Fire")!, FIRE = gd.idByName("Fire")!;
  const g = setup(KINDLING, [9, 9]);
  g.setTile(1, 0, LFF);
  g.setTile(0, 1, FIRE);
  g.start();
  const body = new Body(g.conn, g.world, gd);
  assert.equal(await body.use(1, 0), "use at (1,0): nothing happened (a Kindling does nothing on a Large Fast Fire; what works on it: a Long Straight Shaft (not found in the wild: it is made; you get Firebrand); a Skewered Goose (not found in the wild: it is made; you get Burnt Goose); a Skewered Rabbit (not found in the wild: it is made; you get Burnt Rabbit))");
  assert.doesNotMatch(await body.use(0, 1), /does nothing/);
});

test("a click that does nothing names what works on the clicked thing, as the client's hint does", async () => {
  const id = (n: string) => gd.idByName(n)!;
  const g = setup(id("Leaf"), [9, 9]);
  g.setTile(1, 0, id("Burning Tinder"));
  g.setTile(0, 1, id("Smoldering Tinder"));
  g.setTile(-1, 0, id("Big Hard Rock"));
  g.start();
  const body = new Body(g.conn, g.world, gd);
  assert.equal(await body.use(1, 0), "use at (1,0): nothing happened (a Leaf does nothing on a Burning Tinder; what works on it: a Kindling (not found in the wild: it is made; uses up the Kindling, it becomes Fire))");
  assert.equal(await body.use(0, 1), "use at (0,1): nothing happened (a Leaf does nothing on a Smoldering Tinder)", "nothing works on it: it changes on its own");
  await body.drop(0, -1);
  assert.equal(await body.use(-1, 0), "use at (-1,0): nothing happened (bare hands do nothing on a Big Hard Rock; it's fixed in place and can't be carried; what works on it: a Stone (you get Sharp Stone); a Shovel (not found in the wild: it is made; you get Shovel (4/5 left), it becomes Dug Big Rock))");
});

test("what works on it: another of the same kind says 'another'", async () => {
  const id = (n: string) => gd.idByName(n)!;
  const g = setup(id("Stone"), [9, 9]);
  g.setTile(1, 0, id("Milkweed Stalk"));
  g.start();
  const body = new Body(g.conn, g.world, gd);
  assert.match(await body.use(1, 0), /what works on it: .*another Milkweed Stalk \(not found in the wild: it is made; uses up the Milkweed Stalk, it becomes Thread\)/);
});

test("drop with a baby in arms sets it down on your own tile even when every tile around is taken", async () => {
  const g = setup(SHARP_STONE, [9, 9]);
  g.addPlayer({ id: 2, x: 0, y: 0, age: 0.5, held: 0, female: false, motherId: 1 });
  g.start();
  const body = new Body(g.conn, g.world, gd);
  assert.match(await body.pickUpBaby(2), /drop it first/);
  g.world.self!.held = { id: -2, contained: [] } as never;
  const STONE = gd.idByName("Stone")!;
  for (const [x, y] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) g.setTile(x, y, STONE);
  const r = await body.drop();
  assert.doesNotMatch(r, /no empty spot/);
  assert.ok(g.sent.some((c) => c.startsWith("DROP 0 0")), g.sent.join("|"));
});

test("drop aimed at an occupied tile puts the item on the nearest empty tile and says so", async () => {
  const g = setup(SHARP_STONE, [1, 0]);
  g.start();
  const body = new Body(g.conn, g.world, gd);
  const r = await body.drop(1, 0);
  assert.match(r, /the tile at \(1,0\) has a Wild Gooseberry Bush.*, so you put it on the empty tile at/);
  assert.equal(g.world.self!.held.id, 0, r);
});

test("drop with every tile around taken steps to the nearest empty tile within 3", async () => {
  const g = setup(SHARP_STONE, [9, 9]);
  const STONE = gd.idByName("Stone")!;
  for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) g.setTile(x, y, STONE);
  g.start();
  const body = new Body(g.conn, g.world, gd);
  const r = await body.drop();
  assert.doesNotMatch(r, /no empty spot/);
  assert.equal(g.world.self!.held.id, 0, r);
  assert.ok([[2, 0], [-2, 0], [0, 2], [0, -2]].some(([x, y]) => g.world.objAt(x, y).id === SHARP_STONE), r);
});

test("forage with a tool and no free tile beside the food still frees the hands", async () => {
  const g = setup(SHARP_STONE, [4, 0]);
  const STONE = gd.idByName("Stone")!;
  for (let x = 2; x <= 6; x++) for (let y = -1; y <= 1; y++) if (!(x === 4 && y === 0)) g.setTile(x, y, STONE);
  g.food = 8;
  g.start();
  const body = new Body(g.conn, g.world, gd);
  const r = await body.forage();
  assert.match(r, /ate Gooseberry/);
  assert.match(r, /picked Sharp Stone back up/);
});

test("pick_up_baby under age 10 says why and sends nothing (server minPickupBabyAge)", async () => {
  const g = new FakeGame(gd);
  g.addPlayer({ id: 1, x: 0, y: 0, age: 7, held: 0, female: true });
  g.addPlayer({ id: 2, x: 1, y: 0, age: 0.5, held: 0, female: false, motherId: 3 });
  g.start();
  const body = new Body(g.conn, g.world, gd);
  assert.equal(await body.pickUpBaby(2), "tried to pick up #2: you're 7: you can carry a baby from 10");
  assert.equal(g.sent.filter((c) => c.startsWith("BABY")).length, 0, "nothing sent");
});

test("using a non-food, non-clothing item on a person says it is neither", async () => {
  const g = setup(SHARP_STONE, [9, 9]);
  g.addPlayer({ id: 2, x: 1, y: 0, age: 20, held: 0, female: true });
  g.start();
  const body = new Body(g.conn, g.world, gd);
  assert.match(await body.useOnPerson(2), /nothing happened \(a Sharp Stone is not food or clothing, so it can't be fed to or put on #2\)$/);
});

test("forage carrying a baby: a peel left in hand after eating is dropped so the baby can be picked back up", async () => {
  const g = setup(-2, [4, 0]);
  g.addPlayer({ id: 2, x: 0, y: 0, age: 0.5, held: 0, female: false, motherId: 1 });
  g.eatLeaves.set(gd.idByName("Gooseberry")!, gd.idByName("Banana Peel")!);
  g.food = 6;
  g.start();
  const body = new Body(g.conn, g.world, gd);
  const r = await body.forage();
  assert.match(r, /dropped the Banana Peel/);
  assert.equal(g.world.self!.held.id, -2, `baby back in arms (${r})`);
  assert.match(r, /picked up baby .* again/);
});

test("forage with a tool: a peel left in hand is dropped and the tool picked back up", async () => {
  const g = setup(SHARP_STONE, [4, 0]);
  g.eatLeaves.set(gd.idByName("Gooseberry")!, gd.idByName("Banana Peel")!);
  g.food = 6;
  g.start();
  const body = new Body(g.conn, g.world, gd);
  const r = await body.forage();
  assert.equal(g.world.self!.held.id, SHARP_STONE, r);
  assert.match(r, /dropped the Banana Peel.*picked Sharp Stone back up/);
});

test("say limit follows the server's getSayLimit: adults are not told they were cut off", () => {
  assert.deepEqual([0.5, 3, 7.9, 8, 9, 12, 14, 16, 20, 60].map(sayLimit), [1, 4, 8, 9, 11, 37, 59, 66, 68, 88]);
  const g = new FakeGame(gd);
  g.addPlayer({ id: 1, x: 0, y: 0, age: 14, held: 0, female: true });
  g.start();
  const body = new Body(g.conn, g.world, gd);
  assert.equal(body.say("I AM EVE AND THIS IS OUR CAMP"), 'said "I AM EVE AND THIS IS OUR CAMP"');
  assert.match(body.say("X".repeat(70)), /cut off: at your age you can only say 59 letters/);
});

test("forage while full: empty hands pick the food and keep it (nothing eaten); busy hands get told how", async () => {
  const g = setup(0, [3, 0]);
  g.food = 20;
  g.start();
  g.world.foodCapacity = 20;
  g.world.food = 20;
  const body = new Body(g.conn, g.world, gd);
  const r = await body.forage();
  assert.match(r, /you're full, so you didn't eat: you picked a .*Gooseberry/i);
  assert.ok(gd.isFood(g.world.self!.held.id), `holding food (${r})`);
  const r2 = await body.forage();
  assert.match(r2, /you're full .*empty your hands/);
});

test("say: numbers are left out as the game does, and the result says so; a sickness blocks use with the real reason", async () => {
  const g = setup(0, [99, 99]);
  g.start();
  const body = new Body(g.conn, g.world, gd);
  assert.equal(body.say("go to 44,2 now"), `said "GO TO , NOW" (numbers can't be spoken: they were left out)`);
  assert.ok(g.sent.includes("SAY 0 0 GO TO , NOW"));
  assert.equal(body.say("hello"), `said "HELLO"`);
});

test("say: \"ORDER,\" without followers says it was plain speech; with a follower (FW) no note", () => {
  const g = setup(0, [99, 99]);
  g.start();
  const body = new Body(g.conn, g.world, gd);
  const note = " (you have no followers: it was heard as plain speech, not as an order)";
  assert.equal(body.say("  order, dig here"), `said "ORDER, DIG HERE"${note}`);
  assert.equal(body.say("my order, dig"), `said "MY ORDER, DIG"`, "only at the start");
  const me = g.world.selfId!;
  g.world.handle({ type: "FW", follows: [{ followerId: 7, leaderId: me, colorIndex: 0 }] });
  assert.equal(body.say("ORDER, DIG HERE"), `said "ORDER, DIG HERE"`);
  g.world.handle({ type: "FW", follows: [{ followerId: 7, leaderId: -1, colorIndex: 0 }] });
  assert.equal(body.say("Order, dig"), `said "ORDER, DIG"${note}`, "the follower left");
});

test("drop aimed at a loose item puts it on the nearest empty tile instead of swapping", async () => {
  const PEEL = gd.idByName("Banana Peel")!, BANANA = gd.idByName("Banana")!;
  const g = setup(PEEL, [99, 99]);
  g.setTile(1, 0, BANANA);
  g.start();
  const body = new Body(g.conn, g.world, gd);
  const r = await body.drop(1, 0);
  assert.equal(g.world.self!.held.id, 0, `hands empty (${r})`);
  assert.equal(g.world.objAt(1, 0).id, BANANA, "the banana is still there");
  assert.match(r, /has a Banana, so you put it on the empty tile at/);
});

test("feeding someone while carrying a baby says the arms are full and sends nothing (server.cpp UBABY with a held baby)", async () => {
  const g = setup(-2, [9, 9]);
  g.addPlayer({ id: 2, x: 0, y: 0, age: 0.5, held: 0, female: false, motherId: 1 });
  g.addPlayer({ id: 3, x: 1, y: 0, age: 6, held: 0, female: true });
  g.start();
  const body = new Body(g.conn, g.world, gd);
  assert.match(await body.useOnPerson(3), /nothing happened \(your arms are full: you're carrying baby .*; put the baby down first\)$/);
  assert.equal(g.sent.filter((c) => c.startsWith("UBABY")).length, 0, "nothing sent");
});

test("swap or take_out aimed at a person says items can't be traded with a person", async () => {
  const g = setup(SHARP_STONE, [99, 99]);
  g.addPlayer({ id: 2, x: 1, y: 0, age: 12, held: gd.idByName("Flint Chip")!, female: true });
  g.start();
  const body = new Body(g.conn, g.world, gd);
  assert.match(await body.swap(1, 0), /no item at \(1,0\), only #2.*can't be swapped with or taken from a person; one puts it down, the other picks it up/);
  assert.match(await body.takeOut(1, 0), /no item at \(1,0\), only #2/);
  assert.equal(g.world.self!.held.id, SHARP_STONE, "nothing changed");
});

test("give puts the held item on an empty tile next to the person and says where", async () => {
  const g = setup(SHARP_STONE, [99, 99]);
  g.addPlayer({ id: 2, x: 4, y: 0, age: 12, held: 0, female: true });
  g.start();
  const body = new Body(g.conn, g.world, gd);
  const r = await body.give(2);
  assert.equal(g.world.self!.held.id, 0, r.text);
  assert.ok(r.at && Math.max(Math.abs(r.at[0] - 4), Math.abs(r.at[1])) <= 1, `next to #2 (${r.text})`);
  assert.equal(g.world.objAt(r.at![0], r.at![1]).id, SHARP_STONE);
  assert.match(r.text, /put the Sharp Stone down next to #2 at/);
  assert.equal((await body.give(2)).text, "not holding anything to give");
});

test("give: an item that lands on someone else's just-dropped item is reported as a swap, not a failure; a refused drop as a failure", async () => {
  const FLINT = gd.idByName("Flint Chip")!;
  const g = setup(SHARP_STONE, [99, 99]);
  g.addPlayer({ id: 2, x: 4, y: 0, age: 12, held: 0, female: true });
  g.addPlayer({ id: 3, x: 6, y: 0, age: 30, held: 0, female: false });
  g.dropSwaps = true;
  g.start();
  // #3 puts a Flint Chip on the chosen tile just before our drop lands
  let mode: "swap" | "refuse" = "swap";
  const conn = {
    send: (cmd: string) => {
      if (cmd.startsWith("DROP ")) {
        const [, x, y] = cmd.split(" ").map(Number);
        g.setTile(x, y, mode === "swap" ? FLINT : 0);
        g.world.handle({ type: "MX", changes: [{ x, y, floor: 0, obj: { id: mode === "swap" ? FLINT : 0, contained: [] }, responsibleId: 3 }] });
        // refuse: the fake server sees a fixed rock there and answers with an unchanged hand
        if (mode === "refuse") g.setTile(x, y, gd.idByName("Big Hard Rock")!);
      }
      g.conn.send(cmd);
    },
  };
  const body = new Body(conn, g.world, gd);
  const r = await body.give(2);
  assert.equal(g.world.self!.held.id, FLINT, r.text);
  assert.match(r.text, /^swapped next to #2 at \(\d+,\d+\): you put down the Sharp Stone and picked up the Flint Chip that was lying there \(dropping onto an item swaps them\); they can pick up the Sharp Stone$/);
  assert.doesNotMatch(r.text, /couldn't/);
  assert.equal(g.world.objAt(r.at![0], r.at![1]).id, SHARP_STONE);
  assert.equal(r.item, "Sharp Stone");
  // the server refuses the drop (the tile is unchanged as far as we see, the Flint Chip still in hand)
  mode = "refuse";
  const r2 = await body.give(2);
  assert.equal(g.world.self!.held.id, FLINT);
  assert.match(r2.text, /^couldn't put the Flint Chip down next to #2: drop at .*nothing happened/);
  assert.equal(r2.at, null);
});

test("forage aimed at something that isn't food names it and points to real food", async () => {
  const g = setup(0, [6, 0]);
  const CABBAGE = gd.idByName("Dug Wild Cabbage")!;
  g.setTile(2, 0, CABBAGE);
  g.food = 5;
  g.start();
  const body = new Body(g.conn, g.world, gd);
  const r = await body.forage(2, 0);
  assert.match(r, /^the Dug Wild Cabbage at \(2,0\) is not food: nothing there can be eaten by hand\. The nearest food by hand: Wild Gooseberry Bush.* at \(6,0\)\.$/);
});

test("an unexplained 'nothing happened' says what the tile has now, and who just changed it (two people, one tile, one turn)", async () => {
  const g = setup(0, [9, 9]);
  g.addPlayer({ id: 2, x: 2, y: 0, age: 30, held: 0, female: true, name: "LIRA THORNE" } as never);
  g.start();
  const body = new Body(g.conn, g.world, gd);
  // empty hands on an empty tile: nothing to use
  assert.equal(await body.use(1, 0), "use at (1,0): nothing happened (the tile at (1,0) is empty)");
  // someone else grabs the thing first: our click lands on an empty tile
  const SEED = gd.idByName("Carrot Seed Head")!;
  g.world.handle({ type: "MX", changes: [{ x: 1, y: 0, floor: 0, obj: { id: SEED, contained: [] }, responsibleId: -1 }] } as never);
  g.world.handle({ type: "MX", changes: [{ x: 1, y: 0, floor: 0, obj: { id: 0, contained: [] }, responsibleId: 2 }] } as never);
  const r = await body.use(1, 0);
  assert.match(r, /^use at \(1,0\): nothing happened \(the tile at \(1,0\) is empty; #2 (LIRA THORNE )?changed it just now, it had Carrot Seed Head\)$/);
});

test("drop, use, swap and take_out refuse a target more than 24 tiles away without moving; go has no limit", async () => {
  const g = new FakeGame(gd);
  g.addPlayer({ id: 1, x: -130, y: 57, age: 30, held: SHARP_STONE, female: true });
  g.start();
  const body = new Body(g.conn, g.world, gd);
  assert.equal(await body.drop(0, 0), "drop at (0,0): not done: (0,0) is 130 tiles from you at (-130,57); drop works on tiles up to 24 away; drop without x,y puts it down next to you; go there first to act on a far tile");
  assert.match(await body.use(0, 0), /^use at \(0,0\): not done: \(0,0\) is 130 tiles from you at \(-130,57\); use works on tiles up to 24 away; go there first/);
  assert.match(await body.swap(0, 0), /^swap at \(0,0\): not done: /);
  assert.match(await body.takeOut(0, 0), /^take out at \(0,0\): not done: /);
  assert.deepEqual(g.sent, [], "nothing sent, no step taken");
  assert.equal(g.world.self!.held.id, SHARP_STONE);
  // 24 tiles is still in reach
  assert.doesNotMatch(await body.drop(-106, 57), /not done/);
});

test("a walk too long for one action says where you are now and how far you got", async () => {
  const g = setup(0, [999, 999]);
  g.start();
  const body = new Body(g.conn, g.world, gd);
  const r = await body.go(300, 0);
  const me = g.world.self!;
  assert.equal(r, `still on the way (trip too long): you're now at (${me.x},${me.y}), ${Math.max(Math.abs(me.x), Math.abs(me.y))} tiles from where you started`);
  assert.ok(me.x > 24, "go itself is not limited");
});

test("swap and take_out that do nothing say why: empty hands, full hands, not a container, nothing in it, fixed in place", async () => {
  const id = (n: string) => gd.idByName(n)!;
  const g = setup(0, [9, 9]);
  g.setTile(1, 0, id("Big Hard Rock"));
  g.setTile(-1, 0, id("Basket"));
  g.setTile(0, 1, id("Stone"));
  g.start();
  const body = new Body(g.conn, g.world, gd);
  assert.equal(await body.swap(0, 1), "swap at (0,1): nothing happened (your hands are empty; a swap trades what you hold for the item on the tile)");
  assert.equal(await body.takeOut(1, 0), "take out at (1,0): nothing happened (the Big Hard Rock is not a container; it's fixed in place and can't be carried)");
  assert.equal(await body.takeOut(-1, 0), "take out at (-1,0): nothing happened (the Basket has nothing in it)");
  g.players.get(1)!.held = SHARP_STONE;
  g.world.self!.held = { id: SHARP_STONE, contained: [] };
  assert.equal(await body.swap(1, 0), "swap at (1,0): nothing happened (the Big Hard Rock is fixed in place and can't be carried)");
  assert.equal(await body.swap(0, -1), "swap at (0,-1): nothing happened (the tile at (0,-1) is empty; nothing there to swap with)");
  assert.equal(await body.takeOut(-1, 0), "take out at (-1,0): nothing happened (your hands are full: you're holding Sharp Stone; taking something out needs empty hands)");
});

test("drop onto a container that won't take the item (a Fresh Grave has slots) says so", async () => {
  const g = setup(SHARP_STONE, [9, 9]);
  g.setTile(1, 0, gd.idByName("Fresh Grave")!);
  g.start();
  const body = new Body(g.conn, g.world, gd);
  assert.equal(await body.drop(1, 0), "drop at (1,0): nothing happened (the Fresh Grave can't take the Sharp Stone; an item can only be put on an empty tile or into a container that takes it)");
});

test("pick_up_baby that does nothing says why: too old to be carried, held by someone else, too far", async () => {
  const g = new FakeGame(gd);
  g.addPlayer({ id: 1, x: 0, y: 0, age: 30, held: 0, female: true });
  g.addPlayer({ id: 2, x: 1, y: 0, age: 6.5, held: 0, female: false, motherId: 1 });
  g.addPlayer({ id: 3, x: 2, y: 0, age: 25, held: -4, female: true });
  g.addPlayer({ id: 4, x: 2, y: 0, age: 0.5, held: 0, female: true, motherId: 3 });
  g.start();
  const body = new Body(g.conn, g.world, gd);
  assert.equal(await body.pickUpBaby(2), "tried to pick up #2: nothing happened (#2 is 6: only someone under 5 can be carried)");
  assert.equal(await body.pickUpBaby(4), "tried to pick up #4: nothing happened (#4 is being carried by #3)");
});

test("names take a/an by their first letter", () => {
  assert.equal(withArticle("Ember Leaf"), "an Ember Leaf");
  assert.equal(withArticle("Stone"), "a Stone");
  assert.equal(withArticle("orange tulip"), "an orange tulip");
});
