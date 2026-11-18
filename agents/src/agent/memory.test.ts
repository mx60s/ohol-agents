// Yearly memory summary (memory.ts) replacing the notebook; goal age; history window.
import { test } from "node:test";
import assert from "node:assert/strict";
import { GameData } from "../game/gameData.ts";
import { FakeGame } from "../game/fakeGame.ts";
import { Body } from "../game/body.ts";
import { Agent } from "./agent.ts";
import type { Config } from "../config.ts";
import type { Llm, LlmResult, ChatMessage, ChatOptions } from "./llm.ts";
import type { EventLog } from "../events.ts";
import { buildObservation } from "./observe.ts";
import { buildSystemPrompt } from "./prompt.ts";
import { parseReply, checkActions } from "./reply.ts";
import { YearMemory, trimSummary, summaryInput, SUMMARY_SYSTEM } from "./memory.ts";

const gd = new GameData();
const clock = { cycleMs: 8000, timeScale: 1 };

function res(text: string, costUsd = 0): LlmResult {
  return { text, promptTokens: 10, completionTokens: 10, costUsd, latencyMs: 1, model: "fake", finishReason: "stop" };
}

/** a promise plus its resolve/reject */
function deferred<T>() {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => ((resolve = a), (reject = b)));
  return { promise, resolve, reject };
}

function world() {
  const g = new FakeGame(gd);
  g.addPlayer({ id: 1, x: 0, y: 0, age: 20, held: 0, female: true });
  g.food = 15;
  g.start();
  return g;
}

test("prompt: no \"note\" field and no notebook in either baseline", () => {
  for (const baseline of ["new", "playbook"] as const) {
    const p = buildSystemPrompt(clock, { craft: true, actionListMax: 3, baseline });
    assert.doesNotMatch(p, /"note"|notebook/i, baseline);
    assert.match(p, /"goal":"optional, only when it changes","say"/, baseline);
  }
});

test("parser: a reply with \"note\" parses and runs; the note is ignored", () => {
  const r = parseReply('{"thought":"x","note":"strike flint near tinder","action":{"type":"eat"}}');
  assert.ok(r.ok);
  const c = checkActions(r.value as Record<string, unknown>, false, 4);
  assert.ok("steps" in c && c.steps.length === 1 && c.notes.length === 0, JSON.stringify(c));
});

test("observation: WHAT YOU REMEMBER where the notebook was, omitted while empty; goal age; 15 history lines", () => {
  const g = world();
  const now = g.world.now();
  const history = Array.from({ length: 20 }, (_, i) => ({ t: now - 1000, action: `act${i}`, result: "ok" }));
  const base = { recipeHints: false, history, pastLifeNotes: [], clock, now };
  const obs = buildObservation(g.world, gd, { ...base, memory: ["Pond at (5, 10)", "flint works on tinder only when dry"], goal: "make fire", goalSetAt: now - 3 * 8000 });
  assert.match(obs, /== WHAT YOU REMEMBER \(this life\) ==\n- Pond at \(5, 10\)\n- flint works on tinder only when dry$/);
  assert.doesNotMatch(obs, /NOTEBOOK/);
  assert.match(obs, /Your goal \(set 3 turns ago\): make fire/);
  assert.equal((obs.match(/^- just now: act\d+/gm) ?? []).length, 15, "the last 15 actions are shown");
  assert.match(obs, /act19 -> ok/);
  assert.doesNotMatch(obs, /act4 -> ok/);

  const fresh = buildObservation(g.world, gd, { ...base, memory: [], goal: "make fire", goalSetAt: now });
  assert.doesNotMatch(fresh, /WHAT YOU REMEMBER/);
  assert.match(fresh, /Your goal \(just set\): make fire/);
  assert.match(buildObservation(g.world, gd, { ...base, goal: "x", goalSetAt: now - 8000 }), /Your goal \(set 1 turn ago\): x/);
});

test("trimSummary: bullets and numbering stripped, at most 8 lines of 160 chars, blanks and fences dropped", () => {
  const text = "```\n- Pond at (5, 10)\n* berries east\n\n1. flint failed: tinder was wet\n2) mother is #3\n• fire at camp\n## big rock N\n- " + "x".repeat(300) + "\n- line 8\n- line 9\n```";
  const lines = trimSummary(text);
  assert.equal(lines.length, 8);
  assert.deepEqual(lines.slice(0, 6), ["Pond at (5, 10)", "berries east", "flint failed: tinder was wet", "mother is #3", "fire at camp", "big rock N"]);
  assert.ok(lines[6].length <= 160 && lines[6].startsWith("xxx"));
  assert.equal(lines[7], "line 8");
  assert.deepEqual(trimSummary("  \n\n"), []);
});

test("summaryInput: previous memory first, the year's entries trimmed oldest first to the budget", () => {
  const entries = Array.from({ length: 500 }, (_, i) => `entry ${i} ${"y".repeat(40)}`);
  const s = summaryInput(["old fact"], entries, 2000);
  assert.ok(s.length <= 2000, String(s.length));
  assert.ok(s.startsWith("Your memory so far:\n- old fact"));
  assert.match(s, /entry 499/);
  assert.doesNotMatch(s, /entry 0 /);
});

function memWith(call: (m: ChatMessage[]) => Promise<LlmResult>, o: Partial<ConstructorParameters<typeof YearMemory>[0]> = {}) {
  const done: { ok: boolean }[] = [];
  const m = new YearMemory({ everyTurns: 3, lockstep: false, cycleMs: 1000, call, onDone: (r) => done.push(r), ...o });
  return { m, done };
}

test("YearMemory: every N decisions, never more than one in flight; the result becomes the memory", async () => {
  const calls: ChatMessage[][] = [];
  const pending: ReturnType<typeof deferred<LlmResult>>[] = [];
  const { m, done } = memWith((msgs) => {
    calls.push(msgs);
    const d = deferred<LlmResult>();
    pending.push(d);
    return d.promise;
  });
  m.add("go (1, 1) -> walked");
  assert.equal(m.tick(0), null);
  assert.equal(m.tick(0), null);
  const p = m.tick(0);
  assert.ok(p, "third decision starts a summary");
  await Promise.resolve();
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0].content, SUMMARY_SYSTEM);
  assert.match(calls[0][1].content, /go \(1, 1\) -> walked/);
  m.add("eat -> ate");
  for (let i = 0; i < 6; i++) assert.equal(m.tick(0), null, "busy: no second call");
  assert.equal(calls.length, 1);
  pending[0].resolve(res("- Pond at (5, 10)\n- berries east"));
  await p;
  assert.deepEqual(m.memory, ["Pond at (5, 10)", "berries east"]);
  assert.equal(done.length, 1);
  // overdue while busy: starts on the next decision, with the previous memory in the input
  const p2 = m.tick(0);
  assert.ok(p2);
  await Promise.resolve();
  assert.match(calls[1][1].content, /^Your memory so far:\n- Pond at \(5, 10\)/);
  assert.match(calls[1][1].content, /eat -> ate/);
  pending[1].resolve(res("fire at camp"));
  await p2;
  assert.deepEqual(m.memory, ["fire at camp"]);
});

test("YearMemory: turn clock counts turns as game-paced time (N * cycleMs), not decisions", () => {
  const { m } = memWith(() => new Promise(() => {}), { lockstep: true, everyTurns: 25, cycleMs: 2400 });
  m.add("x");
  assert.equal(m.tick(1000), null);
  assert.equal(m.tick(1000 + 24 * 2400), null, "24 turns in");
  assert.ok(m.tick(1000 + 25 * 2400), "a year (25 turns) in");
});

test("YearMemory: an error, an empty reply or a timeout keeps the old memory; the entries are retried", async () => {
  let mode: "ok" | "fail" | "empty" | "hang" = "ok";
  const inputs: string[] = [];
  const { m, done } = memWith(async (msgs) => {
    inputs.push(msgs[1].content);
    if (mode === "fail") throw new Error("LLM HTTP 500");
    if (mode === "hang") return new Promise<LlmResult>(() => {});
    return res(mode === "empty" ? "\n- \n" : "old fact");
  }, { everyTurns: 1, timeoutMs: 50 });
  m.add("a");
  await m.tick(0);
  assert.deepEqual(m.memory, ["old fact"]);
  for (const k of ["fail", "empty", "hang"] as const) {
    mode = k;
    m.add(`during ${k}`);
    await m.tick(0);
    assert.deepEqual(m.memory, ["old fact"], k);
    assert.equal(m.busy, false, `${k}: not stuck in flight`);
  }
  assert.match(inputs.at(-1)!, /during fail[\s\S]*during empty[\s\S]*during hang/, "failed years' entries are kept for the next try");
  assert.deepEqual(done.map((d) => d.ok), [true, false, false, false]);
});

test("YearMemory: reset at a new life clears the memory and drops a summary still in flight", async () => {
  const d = deferred<LlmResult>();
  const { m, done } = memWith(() => d.promise, { everyTurns: 1 });
  m.memory = ["from the last life"];
  m.add("x");
  const p = m.tick(0)!;
  m.reset();
  assert.deepEqual(m.memory, []);
  d.resolve(res("stale summary"));
  await p;
  assert.deepEqual(m.memory, [], "a summary from the previous life is dropped");
  assert.equal(done.length, 0);
  assert.equal(m.busy, false);
});

// --- the agent: the summary runs beside decisions and never holds them up

function agent(cfg: Record<string, unknown>, summary: (m: ChatMessage[], o?: ChatOptions) => Promise<LlmResult>, decide: (obs: string) => string) {
  const g = world();
  const logged: Record<string, any>[] = [];
  const log = { emitEvent: () => {}, write: (_f: string, rec: Record<string, unknown>) => logged.push(rec) } as unknown as EventLog;
  const seen: string[] = [];
  const summaryCalls: (ChatOptions | undefined)[] = [];
  const llm = {
    overBudget: false,
    chat: async (m: ChatMessage[], o?: ChatOptions) => {
      if (m[0].content === SUMMARY_SYSTEM) {
        summaryCalls.push(o);
        return summary(m, o);
      }
      const obs = String(m[m.length - 1].content);
      seen.push(obs);
      return res(decide(obs));
    },
  } as unknown as Llm;
  const base = {
    runId: "t", recipeHints: false, craftMacro: false, llmModel: "fake", llmReasoningCap: true, llmDecisionMaxTokens: 800, llmReasoningMaxTokens: 300,
    decisionIntervalMs: 10, babyDecisionIntervalMs: 10, babyIdleMaxMs: 10, decisionCycleMs: 50, memoryMode: "per-life", actionListMax: 3,
    memorySummary: true, memorySummaryTurns: 3,
  };
  const a = new Agent("a1", { ...base, ...cfg } as unknown as Config, gd, llm, log, undefined, {});
  const A = a as unknown as Record<string, any>;
  A.world = g.world;
  A.conn = { closed: false, close() {} };
  A.body = new Body(g.conn, g.world, gd);
  A.body.interrupt = () => A.urgentSinceActionStart();
  return { a, A, seen, logged, summaryCalls };
}

const SAY = '{"thought":"call for help","goal":"find berries","note":"strike flint near tinder","say":"HELP","action":{"type":"wait","turns":1}}';

test("agent: the summary is fired every N decisions in the background; a slow one never delays a decision", async () => {
  const d = deferred<LlmResult>();
  const { a, A, seen, logged, summaryCalls } = agent({}, () => d.promise, () => SAY);
  for (let i = 0; i < 7; i++) {
    const t0 = Date.now();
    await A.turn();
    assert.ok(Date.now() - t0 < 1500, `decision ${i + 1} was not held up`);
  }
  assert.equal(summaryCalls.length, 1, "one summary in flight, however many years pass");
  assert.deepEqual(summaryCalls[0], { maxTokens: 800, extra: { reasoning: { max_tokens: 300 } }, json: false }, "same model and reasoning cap, plain text");
  assert.equal((a as unknown as Record<string, unknown>).notebook, undefined, "no notebook");
  assert.doesNotMatch(seen.join("\n"), /NOTEBOOK|strike flint/);
  assert.doesNotMatch(seen.at(-1)!, /WHAT YOU REMEMBER/);
  assert.match(seen.at(-1)!, /Your goal \(set \d+ turns? ago\): find berries/);

  d.resolve(res("- you called HELP and nobody came\n- no berries in view", 0.002));
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(a.memory, ["you called HELP and nobody came", "no berries in view"]);
  await A.turn();
  assert.match(seen.at(-1)!, /== WHAT YOU REMEMBER \(this life\) ==\n- you called HELP and nobody came\n- no berries in view/);
  const s = logged.find((r) => r.kind === "summary");
  assert.ok(s && s.costUsd === 0.002 && /say "HELP"/.test(s.input) && /you thought: call for help/.test(s.input), "summary logged with its cost and input");
});

test("agent: MEMORY_SUMMARY=0 makes no summary calls and shows no memory section", async () => {
  const { A, seen, summaryCalls } = agent({ memorySummary: false, memorySummaryTurns: 1 }, async () => res("fact"), () => SAY);
  for (let i = 0; i < 4; i++) await A.turn();
  assert.equal(summaryCalls.length, 0);
  assert.doesNotMatch(seen.join("\n"), /WHAT YOU REMEMBER|NOTEBOOK/);
});

test("agent: the goal age counts from when it was set or changed, not when it was repeated", async () => {
  const replies = [
    '{"goal":"make fire","action":{"type":"wait","turns":1}}',
    '{"goal":"make fire","action":{"type":"wait","turns":1}}',
    '{"goal":"eat","action":{"type":"wait","turns":1}}',
    '{"action":{"type":"wait","turns":1}}',
  ];
  const { A, seen } = agent({ memorySummary: false }, async () => res(""), () => replies.shift() ?? '{"action":{"type":"wait"}}');
  for (let i = 0; i < 5; i++) await A.turn();
  assert.match(seen[2], /Your goal \(set 2 turns ago\): make fire/);
  assert.match(seen[3], /Your goal \(set 1 turn ago\): eat/);
});
