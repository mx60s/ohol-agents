// Failed actions nearby: a try that did nothing (Body.lastNoop) relayed by Population
// to other agents within view (World.seeTried), shown under WHAT YOU SAW NEARBY.
import { test } from "node:test";
import assert from "node:assert/strict";
import { GameData } from "../game/gameData.ts";
import { FakeGame } from "../game/fakeGame.ts";
import { Body } from "../game/body.ts";
import type { SeenEvent, TriedNothing, World } from "../game/world.ts";
import { buildObservation, seenText } from "./observe.ts";
import { seenForNotes } from "./agent.ts";
import { relayTried } from "../population.ts";

const gd = new GameData();
const id = (n: string) => gd.idByName(n)!;
const clock = { cycleMs: 8000, timeScale: 1 };

/**
 * #1 (0,0) and #6 (17,0) watch, #4 LIRA (3,0) is the actor, #9 (2,1) is a baby of 1.
 * Every character has its own World (one agent each), all seeing the same people.
 */
function scene() {
  let t = 1_000_000;
  const people = [
    { id: 1, x: 0, y: 0, age: 30, held: 0, female: true },
    { id: 4, x: 3, y: 0, age: 30, held: 0, female: true },
    { id: 6, x: 17, y: 0, age: 30, held: 0, female: false },
    { id: 9, x: 2, y: 1, age: 1, held: 0, female: true },
  ];
  const games = new Map<number, FakeGame>();
  for (const self of [1, 4, 6, 9]) {
    const g = new FakeGame(gd, self, 5, () => t);
    for (const p of people) g.addPlayer({ ...p });
    g.start();
    g.world.seenMergeMs = 8000;
    g.world.handle({ type: "NM", names: [{ id: 4, first: "LIRA", last: "TIDEWICK" }] });
    games.set(self, g);
  }
  const agents = [...games.values()].map((g) => ({ status: "alive", world: g.world as World | null }));
  const agentOf = (self: number) => agents[[...games.keys()].indexOf(self)];
  const w = (self: number) => games.get(self)!.world;
  const lines = (self: number) => w(self).seen.filter((e) => e.kind === "tried").map((e) => seenText(w(self), gd, e));
  const obs = (self: number) => buildObservation(w(self), gd, { recipeHints: false, history: [], pastLifeNotes: [], goal: null, clock, now: t });
  return { agents, agentOf, w, lines, obs, tick: (turns: number) => (t += turns * 8000) };
}

const useFlint: TriedNothing = { kind: "use", x: 3, y: 4, held: id("Flint Chip"), target: id("Sharp Stone") };

test("a try that did nothing reaches others within view, not the actor, not someone farther than the view radius", () => {
  const s = scene();
  relayTried(s.agents, s.agentOf(4), useFlint);
  assert.deepEqual(s.lines(1), ["#4 LIRA TIDEWICK (woman, 30) tried a Flint Chip on a Sharp Stone at (3, 4): nothing happened"]);
  assert.match(s.obs(1), /== WHAT YOU SAW NEARBY ==\n- just now: #4 LIRA TIDEWICK \(woman, 30\) tried a Flint Chip on a Sharp Stone at \(3, 4\): nothing happened/);
  assert.deepEqual(s.lines(4), [], "the actor is not told about itself");
  assert.equal(s.w(6).players.has(4), true, "#6 sees #4 as a person (16 tiles)...");
  assert.deepEqual(s.lines(6), [], "...but 14 tiles is beyond the view radius (12)");
  assert.deepEqual(s.lines(9).length, 1, "a baby nearby sees it too");
});

test("a baby's try is not relayed; a dead or not-alive agent gets nothing", () => {
  const s = scene();
  relayTried(s.agents, s.agentOf(9), { kind: "use", x: 2, y: 2, held: 0, target: id("Big Hard Rock") });
  assert.deepEqual(s.lines(1), [], "a baby of 1: not relayed");
  s.agentOf(1).status = "waiting";
  relayTried(s.agents, s.agentOf(4), useFlint);
  assert.deepEqual(s.lines(1), [], "not alive: nothing");
});

test("wording: bare hands, a drop, feeding refused, a non-food on a person, swap and take out; facts only", () => {
  const s = scene();
  const tries: TriedNothing[] = [
    { kind: "use", x: -1, y: 0, held: 0, target: id("Big Hard Rock") },
    { kind: "drop", x: 5, y: 1, held: id("Leaf"), target: 0 },
    { kind: "feed", x: 2, y: 1, held: id("Gooseberry"), target: 0, person: 9 },
  ];
  for (const t of tries) relayTried(s.agents, s.agentOf(4), t);
  s.tick(1);
  relayTried(s.agents, s.agentOf(4), { kind: "feed", x: 0, y: 0, held: id("Sharp Stone"), target: 0, person: 1 });
  relayTried(s.agents, s.agentOf(4), { kind: "drop", x: 5, y: 1, held: id("Leaf"), target: id("Big Hard Rock") });
  relayTried(s.agents, s.agentOf(4), { kind: "swap", x: 5, y: 2, held: id("Leaf"), target: id("Big Hard Rock") });
  relayTried(s.agents, s.agentOf(4), { kind: "take_out", x: 5, y: 3, held: 0, target: id("Big Hard Rock") });
  const who = "#4 LIRA TIDEWICK (woman, 30)";
  assert.deepEqual(s.lines(1), [
    `${who} tried bare hands on a Big Hard Rock at (-1, 0): nothing happened`,
    `${who} tried to put down a Leaf at (5, 1): nothing happened`,
    `${who} tried to feed a Gooseberry to #9 (no name, baby girl, 1.0): refused`,
    `${who} tried a Sharp Stone on you: nothing happened`,
    `${who} tried to put down a Leaf on a Big Hard Rock at (5, 1): nothing happened`,
    `${who} tried to swap a Leaf for a Big Hard Rock at (5, 2): nothing happened`,
    `${who} tried to take something out of a Big Hard Rock at (5, 3): nothing happened`,
  ]);
  assert.doesNotMatch(s.lines(1).join("\n"), /works|because|instead|need/, "no reasons, no hint of what would work");
});

test("the same try again folds into one line with a count; a busy person is capped at 4 lines a turn", () => {
  const s = scene();
  for (let i = 0; i < 3; i++) relayTried(s.agents, s.agentOf(4), useFlint);
  assert.deepEqual(s.lines(1), ["#4 LIRA TIDEWICK (woman, 30) tried a Flint Chip on a Sharp Stone at (3, 4): nothing happened (3 times)"]);
  // a next turn: a new line, counted afresh
  s.tick(2);
  relayTried(s.agents, s.agentOf(4), useFlint);
  assert.match(s.lines(1)[1], /nothing happened$/);
  // many different tries in one turn: 4 lines, the rest counted on the last
  s.tick(2);
  for (let i = 0; i < 7; i++) relayTried(s.agents, s.agentOf(4), { kind: "use", x: 10, y: i, held: 0, target: id("Big Hard Rock") });
  const now = s.w(1).seen.filter((e) => e.kind === "tried" && e.text.includes("(10, "));
  assert.equal(now.length, 4);
  assert.match(seenText(s.w(1), gd, now[3]), /at \(10, 3\): nothing happened \(and 3 more tries by them that did nothing\)$/);
  // tries and doings share the per-person cap
  s.w(1).handle({ type: "MX", changes: [{ x: 9, y: 0, floor: 0, obj: { id: id("Stone"), contained: [] }, responsibleId: 4 }] });
  assert.equal(s.w(1).seen.filter((e) => e.kind === "did").length, 0, "a doing past the cap is counted, not a fifth line");
  assert.match(seenText(s.w(1), gd, now[3]), /\(and 1 more change by them\) \(and 3 more tries by them that did nothing\)$/);
  const sect = s.obs(1).split("== WHAT YOU SAW NEARBY ==\n")[1].split("\n\n")[0].split("\n");
  assert.ok(sect.length <= 20, "at most 20 lines shown");
});

test("a new tried line goes to the note-taker's transcript, like other seen lines", () => {
  const s = scene();
  const got: string[] = [];
  const w = s.w(1);
  (w as unknown as { ev: { onSeen(e: SeenEvent): void } }).ev = { onSeen: (e) => { const l = seenForNotes(w, gd, e); if (l) got.push(l); } };
  relayTried(s.agents, s.agentOf(4), useFlint);
  relayTried(s.agents, s.agentOf(4), useFlint);
  assert.deepEqual(got, ["#4 LIRA TIDEWICK (woman, 30) tried a Flint Chip on a Sharp Stone at (3, 4): nothing happened"], "one transcript line; a repeat folds");
});

test("Body.lastNoop: set by a use the server answered with no change, not by one that worked or was refused before sending", async () => {
  const g = new FakeGame(gd);
  g.addPlayer({ id: 1, x: 0, y: 0, age: 20, held: id("Leaf"), female: true });
  g.setTile(1, 0, id("Burning Tinder"));
  g.setTile(-1, 0, id("Big Hard Rock"));
  g.start();
  const body = new Body(g.conn, g.world, gd);
  await body.use(1, 0);
  assert.deepEqual(body.lastNoop, { kind: "use", x: 1, y: 0, held: id("Leaf"), target: id("Burning Tinder") });
  body.lastNoop = null;
  await body.use(90, 0);
  assert.equal(body.lastNoop, null, "too far: nothing was tried");
  await body.drop(0, -1);
  assert.equal(body.lastNoop, null, "the drop worked");
  await body.use(-1, 0);
  assert.deepEqual(body.lastNoop, { kind: "use", x: -1, y: 0, held: 0, target: id("Big Hard Rock") });
});
