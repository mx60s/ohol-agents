// Event-driven turns: what wakes an agent, babies not polling, waits ending
// early, wasted turns explained, and the reasoning cap (all with fakes).
import { test } from "node:test";
import assert from "node:assert/strict";
import { GameData } from "../game/gameData.ts";
import { FakeGame } from "../game/fakeGame.ts";
import { Body } from "../game/body.ts";
import { bodyEvents, speechEvent, birthEvent, deathEvent } from "./salience.ts";
import { Agent } from "./agent.ts";
import type { Config } from "../config.ts";
import type { Llm, LlmResult, ChatMessage } from "./llm.ts";
import type { EventLog } from "../events.ts";

const gd = new GameData();

function family() {
  // mother #1 (20, fertile), her baby #2, an unrelated baby #3 nearby, a man #4
  const g = new FakeGame(gd);
  g.addPlayer({ id: 1, x: 0, y: 0, age: 20, held: 0, female: true });
  g.addPlayer({ id: 2, x: 1, y: 0, age: 0.4, held: 0, female: true, motherId: 1 });
  g.addPlayer({ id: 3, x: 3, y: 0, age: 0.4, held: 0, female: false, motherId: 9 });
  g.addPlayer({ id: 4, x: 2, y: 2, age: 30, held: 0, female: false });
  g.start();
  return g;
}

test("food thresholds: half, quarter (urgent), starving (urgent); only the deepest band reported", () => {
  const g = family();
  const w = g.world;
  const snap = (food: number) => ({ food, cap: 20, carrierId: null });
  assert.deepEqual(bodyEvents(snap(11), snap(10), w).map((e) => [e.reason, e.urgent]), [["your food fell to half (10/20)", false]]);
  assert.deepEqual(bodyEvents(snap(6), snap(5), w).map((e) => e.urgent), [true]);
  assert.match(bodyEvents(snap(11), snap(3), w)[0].reason, /STARVING/);
  assert.equal(bodyEvents(snap(9), snap(8), w).length, 0, "no band crossed");
  assert.equal(bodyEvents(snap(3), snap(9), w).length, 0, "eating is not an alarm");
});

test("being picked up or put down", () => {
  const g = family();
  const s = (carrierId: number | null) => ({ food: 4, cap: 4, carrierId });
  assert.match(bodyEvents(s(null), s(1), g.world)[0].reason, /#1 picked you up/);
  assert.match(bodyEvents(s(1), s(null), g.world)[0].reason, /#1 put you down/);
});

test("speech: own baby's F is urgent, a stranger's baby nearby is not, adult speech nearby wakes, babbling doesn't", () => {
  const g = family();
  const w = g.world;
  const own = speechEvent(w, { t: 0, speakerId: 2, x: 1, y: 0, text: "F" })!;
  assert.ok(own.urgent);
  assert.match(own.reason, /your baby #2 says "F"/);
  const other = speechEvent(w, { t: 0, speakerId: 3, x: 3, y: 0, text: "F" })!;
  assert.equal(other.urgent, false);
  assert.ok(speechEvent(w, { t: 0, speakerId: 4, x: 2, y: 2, text: "HELLO THERE" }));
  assert.equal(speechEvent(w, { t: 0, speakerId: 3, x: 3, y: 0, text: "MA" }), null, "baby babble isn't salient");
  assert.equal(speechEvent(w, { t: 0, speakerId: 1, x: 0, y: 0, text: "ME" }), null, "own speech isn't");
});

test("a baby only wakes for its mother, carrier or its name", () => {
  const g = new FakeGame(gd, 2);
  g.addPlayer({ id: 1, x: 0, y: 0, age: 20, held: 0, female: true });
  g.addPlayer({ id: 2, x: 1, y: 0, age: 0.4, held: 0, female: true, motherId: 1 });
  g.addPlayer({ id: 4, x: 2, y: 2, age: 30, held: 0, female: false });
  g.start();
  assert.ok(speechEvent(g.world, { t: 0, speakerId: 1, x: 0, y: 0, text: "YOU ARE LILY" }));
  assert.equal(speechEvent(g.world, { t: 0, speakerId: 4, x: 2, y: 2, text: "NICE WEATHER" }), null);
});

test("births and deaths", () => {
  const g = family();
  const baby = g.world.players.get(2)!;
  assert.ok(birthEvent(g.world, baby)!.urgent);
  assert.equal(birthEvent(g.world, g.world.players.get(3)!), null);
  assert.match(deathEvent(g.world, g.world.players.get(4)!)!.reason, /#4 died 2 tiles away/);
});

// --- the agent loop, with a fake world and a fake LLM

function fakeLog(): EventLog & { events: { kind: string; text: string }[] } {
  const events: { kind: string; text: string }[] = [];
  return { events, emitEvent: (kind: string, e: { text: string }) => events.push({ kind, text: e.text }), write: () => {} } as unknown as EventLog & { events: typeof events };
}

const baseCfg = {
  runId: "t", recipeHints: true, craftMacro: true, llmModel: "fake", llmReasoningCap: true, llmDecisionMaxTokens: 800, llmReasoningMaxTokens: 300,
  decisionIntervalMs: 50, babyDecisionIntervalMs: 50, babyIdleMaxMs: 400, decisionCycleMs: 300, memoryMode: "per-life",
};

function agentFor(g: FakeGame, llm: Partial<Llm> = {}, cfg: Record<string, unknown> = {}) {
  const log = fakeLog();
  const a = new Agent("a1", { ...baseCfg, ...cfg } as unknown as Config, gd, { overBudget: false, ...llm } as unknown as Llm, log);
  const A = a as unknown as Record<string, any>;
  A.world = g.world;
  A.conn = { closed: false, close() {} };
  A.body = new Body(g.conn, g.world, gd);
  A.body.interrupt = () => A.urgentSinceActionStart();
  return { a, A, log };
}

test("a baby with nothing happening idles instead of polling; a salient event wakes it early", async () => {
  const g = new FakeGame(gd, 2);
  g.addPlayer({ id: 1, x: 0, y: 0, age: 20, held: -2, female: true });
  g.addPlayer({ id: 2, x: 0, y: 0, age: 0.4, held: 0, female: true, motherId: 1 });
  g.start();
  const { A } = agentFor(g);
  let t0 = Date.now();
  await A.betweenTurns(t0);
  assert.ok(Date.now() - t0 >= 390, "idled for babyIdleMaxMs, not the 50 ms minimum interval");

  A.cfg.babyIdleMaxMs = 10_000;
  t0 = Date.now();
  setTimeout(() => A.noteSalient({ reason: "#1 put you down", urgent: true, t: Date.now() }), 100);
  await A.betweenTurns(t0);
  const dt = Date.now() - t0;
  assert.ok(dt >= 90 && dt < 1000, `woken by the event (${dt} ms)`);
});

test("the minimum interval holds even when an event arrives at once", async () => {
  const g = family();
  const { A } = agentFor(g, {}, { decisionIntervalMs: 300 });
  const t0 = Date.now();
  A.noteSalient({ reason: "x", urgent: true, t: t0 });
  await A.betweenTurns(t0);
  assert.ok(Date.now() - t0 >= 290);
});

test("wait: no model calls while waiting, ended early by a salient event and says why", async () => {
  const g = family();
  const { A } = agentFor(g);
  setTimeout(() => A.noteSalient({ reason: "your baby #2 says \"F\" (hungry)", urgent: true, t: Date.now() }), 100);
  const t0 = Date.now();
  const r = await A.execute({ type: "wait", turns: 4 });
  assert.ok(Date.now() - t0 < 600, "didn't sit out 4 turns (1.2 s)");
  assert.match(r, /waited 0 of 4 turns; woken: your baby #2 says "F"/);
});

test("a family's own newborn and food thresholds are detected from server messages", () => {
  const g = family();
  const { A } = agentFor(g);
  A.checkWorld(g.world); // first look: baby #2 is new to us
  assert.ok(A.pending.some((p: { reason: string }) => /gave birth to #2/.test(p.reason)));
  A.pending.length = 0;
  g.world.handle({ type: "FX", food: { food: 12, capacity: 20, lastAteId: 0, lastAteFillMax: 0, moveSpeed: 1, responsibleId: -1, yumBonus: 0, yumMultiplier: 1 } });
  A.checkWorld(g.world);
  g.world.handle({ type: "FX", food: { food: 9, capacity: 20, lastAteId: 0, lastAteFillMax: 0, moveSpeed: 1, responsibleId: -1, yumBonus: 0, yumMultiplier: 1 } });
  A.checkWorld(g.world);
  assert.ok(A.pending.some((p: { reason: string }) => /half/.test(p.reason)));
});

function reply(text: string, finishReason = "stop"): LlmResult {
  return { text, promptTokens: 0, completionTokens: 0, costUsd: 0, latencyMs: 1, model: "fake", finishReason };
}

test("wasted turns are explained in the next observation's history", async () => {
  const g = family();
  const replies = ['{"thought":"hmm"}', '{"action":{"type":"teleport"}}', '{"action":{"type":"use","x":1}}', "I think I will go north", '{"thought":"ok","action":{"type":"craft"}}'];
  const { A } = agentFor(g, { chat: async () => reply(replies.shift()!) });
  for (let i = 0; i < 5; i++) await A.turn();
  const results = A.history.map((h: { result: string }) => h.result);
  assert.match(results[0], /no "action", so you did nothing/);
  assert.match(results[1], /unknown action type "teleport"; valid types: .*craft/);
  assert.match(results[2], /"use" needs numeric "x" and "y"/);
  assert.match(results[3], /wasted turn: your reply had no JSON object/);
  assert.match(results[4], /"craft" needs "item"/);
});

test("reasoning cap: a mild reasoning budget (300) inside 800 tokens, effort low when the budget is 0; a model that ignores it gets one full retry", async () => {
  const g = family();
  const calls: { maxTokens?: number; extra?: Record<string, unknown> }[] = [];
  const queue = [reply('{"thought":"I am thinking a lot', "length"), reply('{"thought":"ok","action":{"type":"wait","turns":1}}')];
  const { A } = agentFor(g, {
    chat: async (_m: ChatMessage[], opts: { maxTokens?: number; extra?: Record<string, unknown> } = {}) => {
      calls.push(opts);
      return queue.shift()!;
    },
  }, { llmModel: "fake-ignores-effort" });
  const r = await A.decide([]);
  assert.deepEqual(calls[0], { maxTokens: 800, extra: { reasoning: { max_tokens: 300 } } });
  assert.deepEqual(calls[1], {}, "retried without the cap");
  assert.match(r.text, /wait/);

  const calls2: { extra?: Record<string, unknown> }[] = [];
  const { A: B } = agentFor(g, {
    chat: async (_m: ChatMessage[], opts: { extra?: Record<string, unknown> } = {}) => {
      calls2.push(opts);
      return reply('{"action":{"type":"eat"}}');
    },
  }, { llmModel: "fake-2", llmReasoningMaxTokens: 0 });
  await B.decide([]);
  assert.deepEqual(calls2[0].extra, { reasoning: { effort: "low" } });
});
