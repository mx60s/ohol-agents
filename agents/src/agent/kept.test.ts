// Agent-kept memory (kept.ts): the reply's "remember" kept verbatim, "forget", the cap, the
// THINGS YOU CHOSE TO REMEMBER section, saving per life across restarts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { GameData } from "../game/gameData.ts";
import { FakeGame } from "../game/fakeGame.ts";
import { Body } from "../game/body.ts";
import { Agent } from "./agent.ts";
import type { Config } from "../config.ts";
import type { EventLog } from "../events.ts";
import { buildObservation } from "./observe.ts";
import { parseForget, parseRemember, parseReply } from "./reply.ts";
import { KEPT_MAX, KeptMemory, keptLines, keptMemoryPath } from "./kept.ts";

const gd = new GameData();
const clock = { cycleMs: 8000, timeScale: 1 };

test("parse: remember kept as written (cleaned, up to 200 chars); forget as a number or text", () => {
  const r = parseReply('{"remember":"  the BIG pond\\nis at (5, 10)!  ","forget":"3","action":{"type":"eat"}}');
  assert.ok(r.ok);
  assert.equal(parseRemember(r.value), "the BIG pond is at (5, 10)!");
  assert.equal(parseRemember({ remember: "z".repeat(500) }).length, 200);
  assert.equal(parseForget(r.value), 3);
  assert.equal(parseForget({ forget: 2 }), 2);
  assert.equal(parseForget({ forget: "#4." }), 4);
  assert.equal(parseForget({ forget: " the pond is at (5, 10) " }), "the pond is at (5, 10)");
  assert.equal(parseForget({ forget: "" }), null);
  assert.equal(parseForget({}), null);
  assert.equal(parseForget({ forget: { n: 1 } }), null);
});

test("KeptMemory: verbatim, oldest first; duplicates not added; past the cap the oldest goes", () => {
  assert.equal(KEPT_MAX, 25);
  const m = new KeptMemory(null, 3);
  assert.deepEqual(m.remember("the pond is at (5, 10)", 1), { kind: "kept" });
  assert.deepEqual(m.remember("the pond is at (5, 10)", 2), { kind: "already" });
  assert.deepEqual(m.remember("The pond is at (5, 10)", 2), { kind: "kept" }, "only exact duplicates are refused");
  assert.deepEqual(m.remember("ash went east", 3), { kind: "kept" });
  assert.deepEqual(m.remember("berries north", 4), { kind: "kept", dropped: "the pond is at (5, 10)" });
  assert.deepEqual(m.texts, ["The pond is at (5, 10)", "ash went east", "berries north"]);
});

test("KeptMemory.forget: by number as listed or by exact text; misses say so", () => {
  const m = new KeptMemory(null);
  assert.deepEqual(m.forget(1), { ok: false, error: "nothing let go: you remember nothing" });
  for (const t of ["a one", "b two", "c three"]) m.remember(t, 0);
  assert.deepEqual(m.forget(2), { ok: true, text: "b two" });
  assert.deepEqual(m.forget(5), { ok: false, error: "nothing let go: there is no memory 5 (you have 2)" });
  assert.deepEqual(m.forget("C  THREE"), { ok: true, text: "c three" }, "case and spacing aside");
  assert.deepEqual(m.forget("nope"), { ok: false, error: 'nothing let go: no memory reads exactly "nope"' });
  assert.deepEqual(m.texts, ["a one"]);
});

test("observation: THINGS YOU CHOSE TO REMEMBER, numbered, oldest first, with turn ages; omitted when empty", () => {
  const now = 1_000_000;
  assert.deepEqual(keptLines([{ t: now - 3 * 8000, text: "the pond is at (5, 10)" }, { t: now, text: "ash went east" }], now, clock), [
    "1. (3 turns ago) the pond is at (5, 10)",
    "2. (just now) ash went east",
  ]);
  const g = new FakeGame(gd);
  g.addPlayer({ id: 1, x: 0, y: 0, age: 20, held: 0, female: true });
  g.start();
  const t = Date.now();
  const base = { recipeHints: false, history: [], pastLifeNotes: [], goal: null, clock, now: t };
  assert.doesNotMatch(buildObservation(g.world, gd, base), /CHOSE TO REMEMBER/);
  assert.doesNotMatch(buildObservation(g.world, gd, { ...base, kept: [] }), /CHOSE TO REMEMBER/);
  const obs = buildObservation(g.world, gd, { ...base, kept: [{ t: t - 8000, text: "the pond is at (5, 10)" }, { t: t - 16000 * 5, text: "Ash said: go east" }] });
  assert.match(obs, /\n\n== THINGS YOU CHOSE TO REMEMBER ==\n1\. \(1 turn ago\) the pond is at \(5, 10\)\n2\. \(10 turns ago\) Ash said: go east/);
  assert.doesNotMatch(obs, /YOUR NOTES/);
});

test("KeptMemory: saved per life; restored for the same player after a restart, not for a new life", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "kept-"));
  try {
    const file = keptMemoryPath(dir, "run/1", "a01");
    assert.equal(file, path.join(dir, "research", "kept-memory", "run_1", "a01.json"));
    const m = new KeptMemory(file);
    m.reset(7);
    m.remember("the pond is at (5, 10)", 100);
    m.remember("ash went east", 200);
    m.forget(2);
    const after = new KeptMemory(file);
    assert.equal(after.restore(7), true);
    assert.deepEqual(after.entries, [{ t: 100, text: "the pond is at (5, 10)" }]);
    const other = new KeptMemory(file);
    assert.equal(other.restore(8), false, "another body: nothing");
    assert.deepEqual(other.entries, []);
    after.reset(9);
    assert.deepEqual(after.entries, [], "a new life starts empty");
    assert.equal(new KeptMemory(file).restore(7), false, "the old life's file is replaced");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function agent(cfg: Record<string, unknown>, decide: () => string, newLife = true) {
  const g = new FakeGame(gd);
  g.addPlayer({ id: 1, x: 0, y: 0, age: 20, held: 0, female: true });
  g.food = 15;
  g.start();
  const events: { kind: string; text: string; data?: Record<string, unknown> }[] = [];
  const log = { emitEvent: (kind: string, e: { text: string; data?: Record<string, unknown> }) => events.push({ kind, ...e }), write: () => {} } as unknown as EventLog;
  const seen: string[] = [];
  const llm = {
    overBudget: false,
    chat: async (m: { content: unknown }[]) => {
      seen.push(String(m[m.length - 1].content));
      return { text: decide(), promptTokens: 0, completionTokens: 0, costUsd: 0, latencyMs: 1, model: "fake", finishReason: "stop" };
    },
  };
  const base = {
    runId: "t", recipeHints: false, craftMacro: false, llmModel: "fake", llmReasoningCap: false, decisionIntervalMs: 10, babyDecisionIntervalMs: 10,
    babyIdleMaxMs: 10, decisionCycleMs: 50, memoryMode: "per-life", actionListMax: 3, memorySummary: false,
  };
  const a = new Agent("a1", { ...base, ...cfg } as unknown as Config, gd, llm as never, log, undefined, {});
  const A = a as unknown as Record<string, any>;
  A.world = g.world;
  A.conn = { closed: false, close() {} };
  A.body = new Body(g.conn, g.world, gd);
  A.body.interrupt = () => A.urgentSinceActionStart();
  A.sleepInterruptible = async () => {};
  if (newLife) a.kept.reset(1);
  return { a, A, seen, events };
}

test("agent: remember, the cap with the oldest forgotten, forget by number and text, duplicates; history and action events", async () => {
  const replies = [
    '{"remember":"one","action":{"type":"wait","turns":1}}',
    '{"remember":"two","action":{"type":"wait","turns":1}}',
    '{"remember":"three","action":{"type":"wait","turns":1}}',
    '{"remember":"four","action":{"type":"wait","turns":1}}',
    '{"forget":1,"remember":"five","action":{"type":"wait","turns":1}}',
    '{"remember":"five","action":{"type":"wait","turns":1}}',
    '{"forget":"four","action":{"type":"wait","turns":1}}',
    '{"forget":"9","action":{"type":"wait","turns":1}}',
  ];
  const { a, A, seen, events } = agent({ memoryMaxEntries: 3 }, () => replies.shift() ?? '{"action":{"type":"wait","turns":1}}');
  for (let i = 0; i < 9; i++) await A.turn();
  const h = A.history.map((e: { action: string; result: string }) => `${e.action} -> ${e.result}`).filter((l: string) => /^(remember|forget)/.test(l));
  assert.deepEqual(h, [
    'remember "one" -> kept',
    'remember "two" -> kept',
    'remember "three" -> kept',
    'remember "four" -> kept; you forgot the oldest: "one"',
    'forget 1 -> you let go of "two"',
    'remember "five" -> kept',
    'remember "five" -> already remembered',
    'forget "four" -> you let go of "four"',
    "forget 9 -> nothing let go: there is no memory 9 (you have 2)",
  ]);
  assert.deepEqual(a.kept.texts, ["three", "five"]);
  assert.match(seen[8], /== THINGS YOU CHOSE TO REMEMBER ==\n1\. \(.+\) three\n2\. \(.+\) five$/m);
  const acts = events.filter((e) => e.kind === "action");
  assert.deepEqual(acts.filter((e) => typeof e.data?.remember === "string").length, 6);
  assert.deepEqual(acts.filter((e) => typeof e.data?.forget === "string").map((e) => [e.text, e.data!.forget, e.data!.forgotten ?? null]), [
    ['forget 1 -> you let go of "two"', "1", "two"],
    ['forget "four" -> you let go of "four"', "four", "four"],
    ["forget 9 -> nothing let go: there is no memory 9 (you have 2)", "9", null],
  ]);
  assert.equal(acts.find((e) => /forgot the oldest/.test(e.text))!.data!.dropped, "one");
});

test("agent: kept memory survives a restart of the agents service (same life), and the default cap is 25", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "kept-agent-"));
  try {
    const one = agent({ logDir: dir, runId: "r1" }, () => '{"remember":"the pond is at (5, 10)","action":{"type":"wait","turns":1}}');
    await one.A.turn();
    assert.equal(one.a.kept.max, 25);
    // a new process: a fresh Agent for the same slot reloads it on reconnecting to the same body (live() does kept.restore)
    const two = agent({ logDir: dir, runId: "r1" }, () => '{"action":{"type":"wait","turns":1}}', false);
    assert.equal(two.a.kept.restore(1), true);
    assert.deepEqual(two.a.kept.texts, ["the pond is at (5, 10)"]);
    await two.A.turn();
    assert.match(two.seen[0], /== THINGS YOU CHOSE TO REMEMBER ==\n1\. \(.+\) the pond is at \(5, 10\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
