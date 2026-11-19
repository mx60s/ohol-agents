// Homesick: the server's private "+HOMESICK+" over our own head (server.cpp, a walk out of the
// family's homeland) is a feeling the agent is told about, never something it said.
import { test } from "node:test";
import assert from "node:assert/strict";
import { GameData } from "../game/gameData.ts";
import { FakeGame } from "../game/fakeGame.ts";
import { Body } from "../game/body.ts";
import { compassWord, homesickNotice, HOMESICK_LINE } from "../game/world.ts";
import { buildObservation } from "./observe.ts";
import { Agent } from "./agent.ts";
import type { Config } from "../config.ts";
import type { Llm } from "./llm.ts";
import type { EventLog } from "../events.ts";
import { cueOfSay } from "../cues.ts";

const gd = new GameData();
const clock = { cycleMs: 8000, timeScale: 1 };

function adult() {
  const g = new FakeGame(gd);
  g.addPlayer({ id: 1, x: 0, y: 0, age: 20, held: 0, female: true });
  g.start();
  return g;
}

function agentFor(g: FakeGame) {
  const log = { emitEvent: () => {}, write: () => {} } as unknown as EventLog;
  const cfg = { runId: "t", recipeHints: true, craftMacro: true, llmModel: "fake", decisionIntervalMs: 50, babyDecisionIntervalMs: 50, babyIdleMaxMs: 400, decisionCycleMs: 300, memoryMode: "per-life" };
  const spoken: string[] = [];
  const speech = { spoke: (_a: unknown, text: string) => spoken.push(text), heard: () => {} };
  const a = new Agent("a1", cfg as unknown as Config, gd, { overBudget: false } as unknown as Llm, log, speech as never);
  const A = a as unknown as Record<string, any>;
  A.world = g.world;
  A.body = new Body(g.conn, g.world, gd);
  // Agent.live wires the World's events like this
  const ev = (g.world as unknown as { ev: Record<string, unknown> }).ev;
  ev.onCue = (word: string, was: boolean) => A.felt(g.world, word, was);
  return { a, A, spoken };
}

const say = (text: string) => ({ type: "PS" as const, says: [{ id: 1, isCurse: false, text }] });
const observe = (g: FakeGame) => buildObservation(g.world, gd, { recipeHints: true, history: [], pastLifeNotes: [], goal: null, foodSources: [], clock });

test("compass words: y grows north; a mostly-straight line is one direction", () => {
  assert.equal(compassWord([0, 10], [0, 0]), "south");
  assert.equal(compassWord([0, 0], [10, 2]), "east");
  assert.equal(compassWord([5, 5], [0, 0]), "southwest");
  assert.equal(compassWord([1, 1], [1, 1]), null);
});

test("+HOMESICK+ over our head: told once, with the way back from the walk that left; not in HEARD, not something we said", async () => {
  const g = adult();
  const { A, spoken } = agentFor(g);
  const body: Body = A.body;
  await body.go(0, 6); // a walk north that left the homeland
  g.world.handle(say("+HOMESICK+"));
  assert.deepEqual(g.world.homesick && g.world.homesick.toward, "south");
  assert.equal(g.world.heard.length, 0, "the cue is not heard speech");
  assert.equal(A.lastSaid, null);
  const notice = "You feel homesick: you have left your family's homeland. It lies back the way you came, to the south.";
  assert.deepEqual(A.history.map((h: { action: string; result: string }) => `${h.action} -> ${h.result}`), [`(feeling) -> ${notice}`]);
  assert.ok(A.pending.some((p: { reason: string }) => p.reason === notice), "a salient event");
  assert.deepEqual(spoken, ["+HOMESICK+"], "the stream gets the cue as an emote say");
  const obs = observe(g);
  assert.ok(obs.includes(HOMESICK_LINE));
  assert.doesNotMatch(obs, /HOMESICK\+|birth/i, "no cue text in HEARD, nothing about births");
  assert.doesNotMatch(A.history[0].result, /birth|baby|child/i);
});

test("without a recent walk the direction is left out", () => {
  const g = adult();
  g.world.handle(say("+HOMESICK+"));
  assert.equal(homesickNotice(g.world.homesick), "You feel homesick: you have left your family's homeland.");
});

test("+HOME+ (walked back in) clears it; +FREE REIN+ too", () => {
  const g = adult();
  const { A } = agentFor(g);
  g.world.handle(say("+HOMESICK+"));
  assert.ok(observe(g).includes(HOMESICK_LINE));
  g.world.handle(say("+HOME+"));
  assert.equal(g.world.homesick, null);
  assert.ok(!observe(g).includes(HOMESICK_LINE));
  assert.match(A.history[A.history.length - 1].result, /no longer feel homesick/);
  g.world.handle(say("+HOMESICK+"));
  g.world.handle(say("+FREE REIN+"));
  assert.equal(g.world.homesick, null);
  assert.equal(g.world.heard.length, 0);
});

test("+HOME+ without having been homesick adds nothing to the history", () => {
  const g = adult();
  const { A } = agentFor(g);
  g.world.handle(say("+HOME+"));
  assert.equal(A.history.length, 0);
});

test("a baby put down after a carry: the cues can't tell where it is any more, so the feeling is dropped", () => {
  const g = new FakeGame(gd, 2);
  g.addPlayer({ id: 1, x: 0, y: 0, age: 20, held: -2, female: true });
  g.addPlayer({ id: 2, x: 0, y: 0, age: 2, held: 0, female: true, motherId: 1 });
  g.start();
  g.world.handle({ type: "PS", says: [{ id: 2, isCurse: false, text: "+HOMESICK+" }] });
  assert.ok(g.world.homesick);
  const mom = g.world.players.get(1)!;
  mom.held = { id: 0, contained: [] } as never;
  g.world.handle({ type: "HX", heat: { heat: 0.5, foodTime: 6, indoorBonus: 0 } }); // any message re-checks the carry
  assert.equal(g.world.homesick, null);
});

test("others' cues are stripped from their speech; our own words beside a cue are kept", () => {
  const g = new FakeGame(gd);
  g.addPlayer({ id: 1, x: 0, y: 0, age: 20, held: 0, female: true });
  g.addPlayer({ id: 3, x: 1, y: 0, age: 20, held: 0, female: false });
  g.start();
  g.world.handle({ type: "PS", says: [{ id: 3, isCurse: false, text: "+FAMILY+ HELLO" }] });
  g.world.handle({ type: "PS", says: [{ id: 1, isCurse: false, text: "HELLO +HOMESICK+" }] });
  assert.deepEqual(g.world.heard.map((h) => h.text), ["HELLO", "HELLO"]);
  assert.ok(g.world.homesick);
});

test("a +WORD+ say is an emote for the event consumers", () => {
  assert.equal(cueOfSay("+HOMESICK+"), "HOMESICK");
  assert.equal(cueOfSay(" +FREE REIN+ "), "FREE REIN");
  assert.equal(cueOfSay("I AM HOMESICK"), null);
  assert.equal(cueOfSay("+A+ B"), null);
});

test("an agent can't say a cue itself: '+' never reaches the server", () => {
  const g = adult();
  const body = new Body(g.conn, g.world, gd);
  assert.equal(body.say("+HOMESICK+"), 'said "HOMESICK"');
});
