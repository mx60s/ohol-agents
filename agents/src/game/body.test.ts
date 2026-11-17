// Body skills against the in-process fake server (real game data, no network).
import { test } from "node:test";
import assert from "node:assert/strict";
import { GameData } from "./gameData.ts";
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
  assert.match(body.takeNotes().join(), /your path went right past a Wild Boar at \(10,2\); no short safe way around/);
  assert.ok(walked(g).some(([x, y]) => x === 10 && y === 0));
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
