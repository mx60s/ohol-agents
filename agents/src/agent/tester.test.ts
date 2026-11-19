// Tester mode (TESTER_GOALS, tester.ts): family task assignment by founding order,
// the TEST TASK observation line, the reply format's "issue", issue logging.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { GameData } from "../game/gameData.ts";
import { FakeGame } from "../game/fakeGame.ts";
import { Body } from "../game/body.ts";
import { Agent, type AgentHooks } from "./agent.ts";
import type { Config } from "../config.ts";
import type { EventLog } from "../events.ts";
import { buildObservation } from "./observe.ts";
import { systemPromptFor } from "./prompt.ts";
import { parseReply } from "./reply.ts";
import { ISSUE_FIELD, parseIssue, parseTesterGoals, taskFor, testTaskLine } from "./tester.ts";
import { LifeBook } from "../lives.ts";
import { LifeStore } from "../lifestore.ts";
import { seededRng } from "../traits.ts";
import { FakeEvents } from "../test-helpers.ts";

const gd = new GameData();
const clock = { cycleMs: 8000, timeScale: 1 };
const GOALS = ["make fire", "make a kiln", "make a clay bowl", "fill a bowl with water"];

test("parseTesterGoals: a JSON array of strings; unset, empty or invalid = off", () => {
  const warned: string[] = [];
  const warn = (m: string) => warned.push(m);
  assert.deepEqual(parseTesterGoals(undefined, warn), []);
  assert.deepEqual(parseTesterGoals("  ", warn), []);
  assert.deepEqual(parseTesterGoals("[]", warn), []);
  assert.deepEqual(parseTesterGoals('[" make fire, then a kiln ", "", "a bowl"]', warn), ["make fire, then a kiln", "a bowl"]);
  assert.equal(warned.length, 0);
  assert.deepEqual(parseTesterGoals("make fire", warn), []);
  assert.deepEqual(parseTesterGoals('{"a":1}', warn), []);
  assert.deepEqual(parseTesterGoals('["a", 2]', warn), []);
  assert.equal(warned.length, 3);
});

test("taskFor: round-robin by founding position; none without goals or a position", () => {
  assert.equal(taskFor(GOALS, 0), "make fire");
  assert.equal(taskFor(GOALS, 3), "fill a bowl with water");
  assert.equal(taskFor(GOALS, 4), "make fire");
  assert.equal(taskFor(GOALS, 6), "make a clay bowl");
  assert.equal(taskFor(GOALS, null), null);
  assert.equal(taskFor([], 0), null);
});

test("founderIndex: the run's Eves in founding order, descendants inherit, other runs and orphans don't count", () => {
  const b = new LifeBook({ dims: ["a"], mutationSd: 0.15, traitSource: "mock", rng: seededRng(1) });
  const f = new FakeEvents();
  b.apply("old", f.eve("a09", 5)); // another run's Eve
  for (const [i, pid] of [10, 11, 12, 13].entries()) b.apply("r", f.eve(`a0${i}`, pid));
  b.apply("r", f.child("a04", 20, 12)); // Eve 12's daughter
  b.apply("r", f.child("a05", 21, 20, 3)); // and granddaughter
  b.apply("r", f.child("a06", 22, 999, 4)); // mother unknown: her own lineage, not a founder
  b.apply("r", f.eve("a07", 14)); // a later replacement Eve
  const idx = (pid: number) => b.founderIndex("r", b.byRunPlayer("r", pid)!.lineageId);
  assert.deepEqual([10, 11, 12, 13, 14].map(idx), [0, 1, 2, 3, 4]);
  assert.equal(idx(20), 2);
  assert.equal(idx(21), 2);
  assert.equal(idx(22), null);
  assert.equal(b.founderIndex("old", "old:5"), 0);
  assert.equal(taskFor(GOALS, idx(14)), "make fire", "the 5th family wraps round to list 0");
  assert.equal(taskFor(GOALS, idx(21)), "make a clay bowl");
});

test("founderIndex: the same after a restart (LifeStore reload)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "tester-"));
  const f = new FakeEvents();
  const mk = () => new LifeStore({ logDir: dir, dims: ["a"], mutationSd: 0.15, traitSource: "mock", rng: seededRng(1), now: () => f.t });
  try {
    const runDir = path.join(dir, "r-2026");
    const a = mk();
    a.load();
    a.handle("r", runDir, f.eve("a01", 30));
    a.handle("r", runDir, f.eve("a02", 31));
    a.handle("r", runDir, f.child("a03", 32, 31));
    a.handle("r", runDir, f.death("a01", 30));
    a.handle("r", runDir, f.eve("a01", 33));
    a.flush();
    const before = [30, 31, 32, 33].map((p) => a.founderIndexOf("r", p));
    assert.deepEqual(before, [0, 1, 1, 2]);
    const b = mk();
    b.load();
    assert.deepEqual([30, 31, 32, 33].map((p) => b.founderIndexOf("r", p)), before);
    assert.equal(b.founderIndexOf("r", 99), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("observation: the TEST TASK line comes first, only with a task", () => {
  const g = new FakeGame(gd);
  g.addPlayer({ id: 1, x: 0, y: 0, age: 20, held: 0, female: true });
  g.start();
  const base = { recipeHints: false, history: [], pastLifeNotes: [], goal: null, clock, now: Date.now() };
  const plain = buildObservation(g.world, gd, base);
  assert.doesNotMatch(plain, /TEST TASK/);
  assert.equal(buildObservation(g.world, gd, { ...base, testTask: null }), plain);
  const obs = buildObservation(g.world, gd, { ...base, testTask: "make fire, then a kiln." });
  const line = "TEST TASK (this is a test run of the game): your family's task list, in order: make fire, then a kiln. Work through it in order, moving on when one is done. Your family members share this list.";
  assert.equal(testTaskLine("make fire, then a kiln."), line);
  assert.equal(obs, `${line}\n\n${plain}`);
});

test("system prompt: the issue field only in tester mode; otherwise unchanged", () => {
  for (const promptBaseline of ["new", "playbook"] as const) {
    const off = systemPromptFor({ promptBaseline });
    assert.equal(systemPromptFor({ promptBaseline, testerGoals: [] }), off, "no goals = byte-identical");
    assert.ok(!off.includes('"issue"'));
    const on = systemPromptFor({ promptBaseline, testerGoals: GOALS });
    assert.ok(on.includes(`"forget":"optional: the number of a memory to let go (as listed)",${ISSUE_FIELD},"action":`));
    assert.equal(on.replace(`${ISSUE_FIELD},`, ""), off, "the only change");
    assert.equal(systemPromptFor({ promptBaseline, testerGoals: ["something else"] }), on, "static per run: no task list in it");
  }
});

test("parseIssue: cleaned, capped at 500; empty when absent", () => {
  const r = parseReply('{"issue":"  the kiln\\nwon\'t light  ","action":{"type":"eat"}}');
  assert.ok(r.ok);
  assert.equal(parseIssue(r.value), "the kiln won't light");
  assert.equal(parseIssue({ issue: "x".repeat(900) }).length, 500);
  assert.equal(parseIssue({}), "");
  assert.equal(parseIssue({ issue: 3 }), "");
});

function agent(cfg: Record<string, unknown>, decide: () => string, hooks: AgentHooks = {}) {
  const g = new FakeGame(gd);
  g.addPlayer({ id: 1, x: 4, y: -2, age: 20, held: 0, female: true });
  g.food = 15;
  g.start();
  const events: { kind: string; text: string; agentId?: string | null; playerId?: number | null; data?: Record<string, unknown> }[] = [];
  const written: { file: string; rec: Record<string, unknown> }[] = [];
  const log = {
    emitEvent: (kind: string, e: { text: string; data?: Record<string, unknown> }) => {
      const ev = { kind, ...e };
      events.push(ev);
      return ev;
    },
    write: (file: string, rec: Record<string, unknown>) => written.push({ file, rec }),
  } as unknown as EventLog;
  const seen: { system: string; user: string }[] = [];
  const llm = {
    overBudget: false,
    chat: async (m: { content: unknown }[]) => {
      seen.push({ system: String(m[0].content), user: String(m[m.length - 1].content) });
      return { text: decide(), promptTokens: 0, completionTokens: 0, costUsd: 0, latencyMs: 1, model: "fake", finishReason: "stop" };
    },
  };
  const base = {
    runId: "t", recipeHints: false, craftMacro: false, llmModel: "fake", llmReasoningCap: false, decisionIntervalMs: 10, babyDecisionIntervalMs: 10,
    babyIdleMaxMs: 10, decisionCycleMs: 50, memoryMode: "per-life", actionListMax: 3, memorySummary: false,
  };
  const a = new Agent("a1", { ...base, ...cfg } as unknown as Config, gd, llm as never, log, undefined, hooks);
  const A = a as unknown as Record<string, any>;
  A.world = g.world;
  A.conn = { closed: false, close() {} };
  A.body = new Body(g.conn, g.world, gd);
  A.body.interrupt = () => A.urgentSinceActionStart();
  A.sleepInterruptible = async () => {};
  a.kept.reset(1);
  return { a, A, seen, events, written };
}

const REPLY = '{"thought":"hm","goal":"make fire","issue":"I can\'t tell which tile is the tree","action":{"type":"wait","turns":1}}';

test("agent, tester mode: the task in the observation, issue logged as an event and to issues.jsonl", async () => {
  const hooks: AgentHooks = {
    testTask: (pid) => (pid === 1 ? "make fire, then a kiln" : null),
    lifeOf: (_a, pid) => ({ lifeId: `t:${pid}`, lineageId: "t:1" }),
  };
  const { A, seen, events, written } = agent({ testerGoals: ["make fire, then a kiln"] }, () => REPLY, hooks);
  await A.turn();
  assert.ok(seen[0].user.startsWith("TEST TASK (this is a test run of the game): your family's task list, in order: make fire, then a kiln. "));
  assert.ok(seen[0].system.includes(ISSUE_FIELD));
  const issues = events.filter((e) => e.kind === "issue");
  assert.equal(issues.length, 1);
  assert.equal(issues[0].text, "I can't tell which tile is the tree");
  assert.equal(issues[0].agentId, "a1");
  assert.equal(issues[0].playerId, 1);
  assert.deepEqual(issues[0].data, { lifeId: "t:1", lineageId: "t:1", x: 4, y: -2, held: "nothing", goal: "make fire" });
  const files = written.filter((w) => w.file === "issues.jsonl");
  assert.equal(files.length, 1);
  assert.equal(files[0].rec, issues[0]);
  // no issue, no event
  const quiet = agent({ testerGoals: ["x"] }, () => '{"issue":"  ","action":{"type":"wait","turns":1}}', hooks);
  await quiet.A.turn();
  assert.equal(quiet.events.filter((e) => e.kind === "issue").length, 0);
});

test("agent, tester mode off: no task, no issue field, an issue in the reply is ignored", async () => {
  const { A, seen, events, written } = agent({}, () => REPLY, { testTask: () => null });
  await A.turn();
  assert.doesNotMatch(seen[0].user, /TEST TASK/);
  assert.ok(!seen[0].system.includes('"issue"'));
  assert.equal(events.filter((e) => e.kind === "issue").length, 0);
  assert.equal(written.filter((w) => w.file === "issues.jsonl").length, 0);
});
