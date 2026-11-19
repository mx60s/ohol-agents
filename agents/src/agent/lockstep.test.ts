// The real Agent under the turn clock (TURN_CLOCK=1): TurnCoordinator + fake
// server clock + FakeGame + a scripted model. Decisions come one per turn,
// `wait N` skips N decide phases, a late reply is dropped and noted.
import { test } from "node:test";
import assert from "node:assert/strict";
import { GameData } from "../game/gameData.ts";
import { FakeGame } from "../game/fakeGame.ts";
import { FakeClockPort } from "../game/fakeClock.ts";
import { Body } from "../game/body.ts";
import { Agent } from "./agent.ts";
import { TurnCoordinator } from "../turnclock.ts";
import type { Config } from "../config.ts";
import type { Llm, ChatMessage } from "./llm.ts";
import type { EventLog } from "../events.ts";

const gd = new GameData();
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const cfg = {
  runId: "t", recipeHints: true, craftMacro: false, llmModel: "fake", llmReasoningCap: false, llmDecisionMaxTokens: 800, llmReasoningMaxTokens: 300,
  decisionIntervalMs: 8000, babyDecisionIntervalMs: 8000, babyIdleMaxMs: 60000, decisionCycleMs: 8000, memoryMode: "per-life", actionListMax: 3,
  turnClock: true, turnGameS: 2.4, timeScale: 1, babyIdleTurns: 10,
};

test("turn clock end to end: one decision per turn, wait 2 skips two, a late reply is dropped and noted", async () => {
  // 8 game s per wall s: a 300 ms act window, long enough for each plain action here
  const port = new FakeClockPort(500, 8);
  const agents: Agent[] = [];
  const coord = new TurnCoordinator(port, () => agents, { turnGameS: 2.4, timeScale: 1, decideTimeoutMs: 80, babyIdleTurns: 10, pollMs: 2, idleMs: 5 });
  // the World on the coordinator's game-paced clock, as Agent.live sets it up
  const g = new FakeGame(gd, 1, 5, () => coord.now());
  g.addPlayer({ id: 1, x: 0, y: 0, age: 20, held: 0, female: true });
  g.food = 15;
  g.start();
  const calls: { turn: number; obs: string }[] = [];
  const script: (string | { delayMs: number; text: string })[] = [
    '{"thought":"look around","action":{"type":"go","x":1,"y":0}}',
    '{"action":{"type":"wait","turns":2}}',
    { delayMs: 200, text: '{"action":{"type":"go","x":3,"y":0}}' },
    '{"action":{"type":"jump"}}',
  ];
  const llm = {
    overBudget: false,
    chat: async (m: ChatMessage[]) => {
      calls.push({ turn: coord.n, obs: String(m[m.length - 1].content) });
      const s = script.shift() ?? '{"action":{"type":"jump"}}';
      const r = typeof s === "string" ? { delayMs: 0, text: s } : s;
      await sleep(r.delayMs);
      return { text: r.text, promptTokens: 0, completionTokens: 0, costUsd: 0, latencyMs: 1, model: "fake", finishReason: "stop" };
    },
  } as unknown as Llm;
  const log = { emitEvent: () => {}, write: () => {} } as unknown as EventLog;
  const a = new Agent("a1", cfg as unknown as Config, gd, llm, log, undefined, { turns: coord.link() });
  const A = a as unknown as Record<string, any>;
  A.world = g.world;
  A.conn = { closed: false, close() {} };
  A.body = new Body(g.conn, g.world, gd);
  A.status = "alive";
  agents.push(a);
  coord.start();
  const end = Date.now() + 5000;
  while (calls.length < 4 && Date.now() < end) await sleep(5);
  await coord.stop();
  const turns = calls.map((c) => c.turn);
  // 1: go; 2: wait 2 (skips 3 and 4); 5: too slow (dropped at 80 ms, done thinking by turn 6); 6: jump
  assert.deepEqual(turns.slice(0, 4), [1, 2, 5, 6]);
  assert.equal(g.world.self!.x, 1, "the late go (3,0) never ran");
  assert.match(calls[1].obs, /go \(1, 0\) -> arrived/);
  assert.match(calls[2].obs, /waited 2 turns/);
  assert.match(calls[3].obs, /you were too slow to act this turn/);
  // history ages are in turns of the game-paced clock
  assert.match(calls[3].obs, /\d turns ago: wait 2 turns -> waited 2 turns/);
  // every target 2.4 game s above the last
  for (let i = 1; i < port.writes.length; i++) assert.ok(Math.abs(port.writes[i] - port.writes[i - 1] - 2.4) < 1e-6);
});

test("turn clock: a search-only reply is a turn like a say-only one; the next decision comes the next turn", async () => {
  const port = new FakeClockPort(500, 8);
  const agents: Agent[] = [];
  const coord = new TurnCoordinator(port, () => agents, { turnGameS: 2.4, timeScale: 1, decideTimeoutMs: 200, babyIdleTurns: 10, pollMs: 2, idleMs: 5 });
  const g = new FakeGame(gd, 1, 5, () => coord.now());
  g.addPlayer({ id: 1, x: 0, y: 0, age: 20, held: 0, female: true });
  g.food = 15;
  g.start();
  const calls: { turn: number; obs: string }[] = [];
  const script = ['{"action":{"type":"search","what":"fire"}}', '{"action":{"type":"go","x":1,"y":0}}', '{"action":{"type":"jump"}}'];
  const llm = {
    overBudget: false,
    chat: async (m: ChatMessage[]) => {
      calls.push({ turn: coord.n, obs: String(m[m.length - 1].content) });
      return { text: script.shift() ?? '{"action":{"type":"jump"}}', promptTokens: 0, completionTokens: 0, costUsd: 0, latencyMs: 1, model: "fake", finishReason: "stop" };
    },
  } as unknown as Llm;
  const log = { emitEvent: () => {}, write: () => {} } as unknown as EventLog;
  const a = new Agent("a1", cfg as unknown as Config, gd, llm, log, undefined, { turns: coord.link() });
  const A = a as unknown as Record<string, any>;
  A.world = g.world;
  A.conn = { closed: false, close() {} };
  A.body = new Body(g.conn, g.world, gd);
  A.status = "alive";
  agents.push(a);
  coord.start();
  const end = Date.now() + 5000;
  while (calls.length < 3 && Date.now() < end) await sleep(5);
  await coord.stop();
  assert.deepEqual(calls.slice(0, 3).map((c) => c.turn), [1, 2, 3]);
  assert.match(calls[1].obs, /search "fire" -> MAKING FIRE: \d+ steps \(see SEARCH\)/);
  assert.match(calls[1].obs, /== SEARCH: MAKING FIRE ==/);
  assert.match(calls[2].obs, /go \(1, 0\) -> arrived/);
});
