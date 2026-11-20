// Yearly notes by a separate note-taker (memory.ts) replacing the notebook; long-term goal age; history window.
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
import { parseReply, checkActions, parseRemember } from "./reply.ts";
import { YearMemory, trimSummary, summaryInput, summaryMaxTokens, looksLikeReasoning, SUMMARY_SYSTEM, SUMMARY_REPLY_TOKENS, NOTE_HEADINGS, REMEMBER_MAX, YEAR_LINE_SYSTEM, YEAR_LINE_REPLY_TOKENS, YEAR_LINE_TRIES, trimYearLine, yearLineInput, yearLabel, yearLinesPath } from "./memory.ts";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

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
    assert.match(p, /"goal":"optional: what you are working on now; change it when you reach it or it no longer applies","say"/, baseline);
  }
});

test("parser: a reply with \"note\" parses and runs; the note is ignored", () => {
  const r = parseReply('{"thought":"x","note":"strike flint near tinder","action":{"type":"eat"}}');
  assert.ok(r.ok);
  const c = checkActions(r.value as Record<string, unknown>, false, 4);
  assert.ok("steps" in c && c.steps.length === 1 && c.notes.length === 0, JSON.stringify(c));
});

test("observation: YOUR NOTES where the notebook was, headings kept, omitted while empty; current goal age; 30 history lines", () => {
  const g = world();
  const now = g.world.now();
  const history = Array.from({ length: 40 }, (_, i) => ({ t: now - 1000, action: `act${i}`, result: "ok" }));
  const base = { recipeHints: false, history, pastLifeNotes: [], clock, now };
  const obs = buildObservation(g.world, gd, { ...base, memory: ["What you learned:", "Pond at (5, 10)", "flint works on tinder only when dry"], goal: "make fire", goalSetAt: now - 3 * 8000 });
  assert.match(obs, /== YOUR NOTES \(this life\) ==\nWhat you learned:\n- Pond at \(5, 10\)\n- flint works on tinder only when dry$/);
  assert.doesNotMatch(obs, /NOTEBOOK|WHAT YOU REMEMBER/);
  assert.match(obs, /Your current goal \(set 3 turns ago\): make fire/);
  assert.equal((obs.match(/^- just now: act\d+/gm) ?? []).length, 30, "the last 30 actions are shown");
  assert.match(obs, /act19 -> ok/);
  assert.doesNotMatch(obs, /act4 -> ok/);

  const fresh = buildObservation(g.world, gd, { ...base, memory: [], goal: "make fire", goalSetAt: now });
  assert.doesNotMatch(fresh, /YOUR NOTES/);
  assert.match(fresh, /Your current goal \(just set\): make fire/);
  assert.match(buildObservation(g.world, gd, { ...base, goal: "x", goalSetAt: now - 8000 }), /Your current goal \(set 1 turn ago\): x/);
});

test("trimSummary: bullets and numbering stripped, at most 10 facts of 160 chars, blanks and fences dropped", () => {
  const text = "```\n- Pond at (5, 10)\n* berries east\n\n1. flint failed: tinder was wet\n2) mother is #3\n• fire at camp\n## big rock N\n- " + "x".repeat(300) + "\n- line 8\n- line 9\n- line 10\n- line 11\n```";
  const lines = trimSummary(text);
  assert.equal(lines.length, 10);
  assert.deepEqual(lines.slice(0, 6), ["Pond at (5, 10)", "berries east", "flint failed: tinder was wet", "mother is #3", "fire at camp", "big rock N"]);
  assert.ok(lines[6].length <= 160 && lines[6].startsWith("xxx"));
  assert.equal(lines[9], "line 10");
  assert.deepEqual(trimSummary("  \n\n"), []);
});

test("trimSummary: headings kept as \"Heading:\", empty headings dropped, headings don't count toward the 10 lines", () => {
  const text = [
    "## What worked:", "- a Stone on a Big Hard Rock made a Sharp Stone",
    "**What didn't work**", "",
    "What you learned:", "- the pond is at (5, 10)", "- #3 LUNA said berries grow north",
    "- Major life events: your baby #7 was born",
    "Novel situations:",
  ].join("\n");
  assert.deepEqual(trimSummary(text), [
    "What worked:", "a Stone on a Big Hard Rock made a Sharp Stone",
    "What you learned:", "the pond is at (5, 10)", "#3 LUNA said berries grow north",
    "Major life events:", "your baby #7 was born",
  ]);
  const many = trimSummary(["What worked:", ...Array.from({ length: 12 }, (_, i) => `- fact ${i}`), "Novel situations:", "- late"].join("\n"));
  assert.equal(many.length, 11, "one heading plus 10 facts");
  assert.ok(!many.includes("Novel situations:"), "a heading past the cap has no facts and is dropped");
});

test("summaryInput: previous notes first, the year's transcript trimmed oldest first to the budget", () => {
  const entries = Array.from({ length: 500 }, (_, i) => `entry ${i} ${"y".repeat(40)}`);
  const s = summaryInput(["What worked:", "old fact"], entries, 2000);
  assert.ok(s.length <= 2000, String(s.length));
  assert.ok(s.startsWith("Previous notes:\nWhat worked:\n- old fact"));
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
  assert.match(calls[0][1].content, /- you: go \(1, 1\) -> walked/);
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
  assert.match(calls[1][1].content, /^Previous notes:\n- Pond at \(5, 10\)/);
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
      if (m[0].content === SUMMARY_SYSTEM || m[0].content === YEAR_LINE_SYSTEM) {
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

test("YearMemory: a reply cut by the token limit or one that is reasoning keeps the old memory; the entries are retried", async () => {
  let reply: LlmResult = res("old fact");
  const inputs: string[] = [];
  const { m, done } = memWith(async (msgs) => {
    inputs.push(msgs[1].content);
    return reply;
  }, { everyTurns: 1 });
  m.add("a");
  await m.tick(0);
  assert.deepEqual(m.memory, ["old fact"]);
  const bad: [string, LlmResult][] = [
    ["cut", { ...res("- Pond at (5, 10)\n- berries ea"), finishReason: "length" }],
    ["fragment", res(")")],
    ["reasoning", res("Need interpret: the results say the flint failed, so")],
    ["unclosed think", res("<think>The pond is west, so")],
  ];
  for (const [k, r] of bad) {
    reply = r;
    m.add(`during ${k}`);
    await m.tick(0);
    assert.deepEqual(m.memory, ["old fact"], k);
  }
  assert.match(inputs.at(-1)!, /during cut[\s\S]*during fragment[\s\S]*during reasoning[\s\S]*during unclosed think/, "the year's entries are kept for the next try");
  assert.deepEqual(done.map((d) => d.ok), [true, false, false, false, false]);
  assert.match((done[1] as unknown as { error: string }).error, /cut off \(finish_reason length\)/);
  assert.equal(looksLikeReasoning("Pond at (5, 10)\nflint failed: tinder was wet"), false, "facts are not reasoning");
  assert.equal(looksLikeReasoning("<think>x</think>\nPond at (5, 10)"), false, "a closed think block is stripped");
});

test("summaryMaxTokens: the reasoning budget plus room for 10 lines and headings, never below a decision's", () => {
  assert.equal(summaryMaxTokens(1600, 1200), 1200 + SUMMARY_REPLY_TOKENS, "fly.toml: 1600 total left only 400 after 1200 of reasoning");
  assert.equal(summaryMaxTokens(2000, 300), 2000);
  assert.ok(SUMMARY_REPLY_TOKENS * 3 >= 10 * 160 + NOTE_HEADINGS.join(":\n").length, "10 lines of 160 chars and the headings at ~3 chars per token");
});

test("agent: the summary is fired every N decisions in the background; a slow one never delays a decision", async () => {
  const d = deferred<LlmResult>();
  const { a, A, seen, logged, summaryCalls } = agent({}, () => d.promise, () => SAY);
  for (let i = 0; i < 7; i++) {
    const t0 = Date.now();
    await A.turn();
    assert.ok(Date.now() - t0 < 1500, `decision ${i + 1} was not held up`);
  }
  assert.equal(summaryCalls.length, 1, "one summary in flight, however many years pass");
  assert.deepEqual(summaryCalls[0], { maxTokens: 300 + SUMMARY_REPLY_TOKENS, extra: { reasoning: { max_tokens: 300 } }, json: false }, "same model and reasoning cap, plain text, room for the lines after it");
  assert.equal((a as unknown as Record<string, unknown>).notebook, undefined, "no notebook");
  assert.doesNotMatch(seen.join("\n"), /NOTEBOOK|strike flint/);
  assert.doesNotMatch(seen.at(-1)!, /YOUR NOTES/);
  assert.match(seen.at(-1)!, /Your current goal \(set \d+ turns? ago\): find berries/);

  d.resolve(res("What didn't work:\n- you called HELP and nobody came\nWhat worked:\nWhat you learned:\n- no berries in view", 0.002));
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(a.memory, ["What didn't work:", "you called HELP and nobody came", "What you learned:", "no berries in view"]);
  await A.turn();
  assert.match(seen.at(-1)!, /== YOUR NOTES \(this life\) ==\nWhat didn't work:\n- you called HELP and nobody came\nWhat you learned:\n- no berries in view/);
  const s = logged.find((r) => r.kind === "summary");
  assert.ok(s && s.costUsd === 0.002 && /say "HELP"/.test(s.input), "summary logged with its cost and input");
  assert.doesNotMatch(s.input, /call for help/, "the agent's own thoughts are not summary input");
});

test("agent: MEMORY_SUMMARY=0 makes no summary calls and shows no memory section", async () => {
  const { A, seen, summaryCalls } = agent({ memorySummary: false, memorySummaryTurns: 1 }, async () => res("fact"), () => SAY);
  for (let i = 0; i < 4; i++) await A.turn();
  assert.equal(summaryCalls.length, 0);
  assert.doesNotMatch(seen.join("\n"), /YOUR NOTES|NOTEBOOK/);
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
  assert.match(seen[2], /Your current goal \(set 2 turns ago\): make fire/);
  assert.match(seen[3], /Your current goal \(set 1 turn ago\): eat/);
});

test("note-taker: third-person prompt with the five headings, facts only; transcript lines labelled in order", () => {
  assert.match(SUMMARY_SYSTEM, /^You keep the memory notes for a player in a survival game\./);
  assert.match(SUMMARY_SYSTEM, /second person \("you"\), at most 10 short lines/);
  assert.match(SUMMARY_SYSTEM, /What worked \/ What didn't work \/ What you learned \/ Major life events \/ Novel situations/);
  assert.match(SUMMARY_SYSTEM, /Facts only, no advice or plans\. Say what people said as said, not as fact\./);
  assert.doesNotMatch(SUMMARY_SYSTEM, /\byour memory\b/i, "not framed as the agent rewriting its own memory");
  const m = new YearMemory({ everyTurns: 1, lockstep: false, cycleMs: 1000, call: async () => res("") });
  m.add("go (1, 1) -> arrived");
  m.saw("#4 LIRA TIDEWICK (woman, 30) picked up a Sharp Stone from (2, 2)");
  m.heard('#3 LUNA said: "BERRIES NORTH"');
  m.notice('"YOU INHERITED A HOME"');
  const input = (m as unknown as { entries: string[] }).entries;
  const s = summaryInput([], input);
  assert.match(s, /^No previous notes for this life\.\n\nTranscript of the last year, oldest first/);
  assert.match(s, /- you: go \(1, 1\) -> arrived\n- saw: #4 LIRA TIDEWICK \(woman, 30\) picked up a Sharp Stone from \(2, 2\)\n- claim: #3 LUNA said: "BERRIES NORTH"\n- game: "YOU INHERITED A HOME"$/);
  assert.match(s, /"claim:" is what someone said, not checked/);
});

test("summaryInput: the transcript is capped at about 3,000 tokens, the oldest lines dropped", () => {
  const entries = Array.from({ length: 600 }, (_, i) => `you: step ${i} ${"z".repeat(60)}`);
  const s = summaryInput([], entries);
  assert.ok(s.length <= 12_000, String(s.length));
  assert.match(s, /step 599 /);
  assert.doesNotMatch(s, /step 0 /);
});

test("agent: heard speech goes to the summary as a claim, the agent's thoughts not at all", async () => {
  const calls: ChatMessage[][] = [];
  const { A } = agent({ memorySummaryTurns: 2 }, async (m) => (calls.push(m), res("- fact")), () => '{"thought":"the berries are poisoned","action":{"type":"wait","turns":1}}');
  A.mem.heard('#2 MIRA said: "THE POND IS NORTH"');
  for (let i = 0; i < 3; i++) await A.turn();
  await new Promise((r) => setTimeout(r, 10));
  const input = String(calls[0]?.[1]?.content);
  assert.match(input, /- claim: #2 MIRA said: "THE POND IS NORTH"/);
  assert.doesNotMatch(input, /poisoned/);
});

test("agent: a reply that only speaks records 'spoke; no other action this turn', not a failed reply; an empty say records nothing said", async () => {
  const replies = ['{"thought":"x","say":"HELLO"}', '{"say":"123","action":{"type":"say"}}'];
  const { A } = agent({ memorySummary: false }, async () => res(""), () => replies.shift() ?? '{"action":{"type":"wait"}}');
  await A.turn();
  const h = A.history.map((e: { action: string; result: string }) => `${e.action} -> ${e.result}`);
  assert.deepEqual(h, ['say "HELLO" -> said "HELLO"', "(no other action) -> spoke; no other action this turn"]);
  await A.turn();
  const h2 = A.history.slice(2).map((e: { action: string; result: string }) => `${e.action} -> ${e.result}`);
  assert.deepEqual(h2, ['say "123" -> said nothing (numbers can\'t be spoken)', "(no other action) -> nothing said; no other action this turn"]);
});

test("agent: \"I FOLLOW YOU\" says whom the server made your leader (FW), and that it is your own child", async () => {
  const { A } = agent({ memorySummary: false }, async () => res(""), () => '{"say":"I FOLLOW YOU"}');
  const w = A.world;
  w.handle({ type: "PU", updates: [{ id: 5, displayId: 19, facing: 0, action: false, actionTarget: [0, 0], held: { id: 0, contained: [] }, heldOriginValid: false, heldOrigin: [0, 0], heldTransitionSourceId: 0, heat: 0.5, doneMovingSeq: 0, forced: false, x: 1, y: 0, age: 1, ageRate: 60, moveSpeed: 3.75, clothing: [], justAte: false, lastAteId: 0, responsibleId: -1, heldYum: false, heldLearned: false }] });
  w.handle({ type: "LN", lineages: [{ id: 5, ancestors: [1], eveId: 1 }] });
  setTimeout(() => w.handle({ type: "FW", follows: [{ followerId: 1, leaderId: 5, colorIndex: 0 }] }), 100);
  await A.turn();
  assert.equal(A.history[0].result, 'said "I FOLLOW YOU"; you now follow #5 (age 1, your baby)');
});

// --- "remember": the reply asks for something to go into the next yearly notes

test("remember: parsed and cleaned like say/goal (about 200 chars); \"note\" is not read as remember", () => {
  const r = parseReply('{"thought":"x","remember":"  the pond\\nis at (5, 10)  ","action":{"type":"eat"}}');
  assert.ok(r.ok);
  assert.equal(parseRemember(r.value), "the pond is at (5, 10)");
  const long = parseRemember({ remember: "y".repeat(400) });
  assert.ok(long.length <= 200 && long.length > 160 && long.startsWith("yyy"), String(long.length));
  assert.equal(parseRemember({ remember: 42 }), "");
  assert.equal(parseRemember({}), "");
  assert.equal(parseRemember({ note: "strike flint near tinder" }), "", "the old note field stays ignored");
});

test("remember: in the reply format line of both baselines", () => {
  for (const baseline of ["new", "playbook"] as const) {
    const p = buildSystemPrompt(clock, { craft: true, actionListMax: 3, baseline });
    assert.ok(p.includes(`"say":"optional: words to say now","remember":"optional: anything you want to remember, for any reason; it can stay with you for the rest of your life (up to 25 things)","forget":"optional: the number of a memory to let go (as listed)","action"`), baseline);
  }
});

test("YearMemory.remember: at most 8, oldest dropped; near-identical items (case, punctuation) kept once; blank refused", () => {
  const { m } = memWith(async () => res(""));
  for (let i = 0; i < 10; i++) assert.equal(m.remember(`fact ${i}`), true);
  assert.equal(REMEMBER_MAX, 8);
  assert.deepEqual(m.pendingRemember, Array.from({ length: 8 }, (_, i) => `fact ${i + 2}`));
  const { m: d } = memWith(async () => res(""));
  d.remember("The pond is at (5, 10).");
  d.remember("the pond is at 5, 10");
  d.remember("THE POND IS AT (5,10)!");
  d.remember("the pond is at (5, 11)");
  assert.deepEqual(d.pendingRemember, ["The pond is at (5, 10).", "the pond is at (5, 11)"]);
  assert.equal(d.remember(" ... "), false);
  assert.equal(d.pendingRemember.length, 2);
});

test("note-taker: remember items in their own section with turns ago, a prompt sentence, and up to 3 more lines", async () => {
  assert.match(SUMMARY_SYSTEM, /If the player asked you to remember things, include them unless the transcript shows they are wrong; for them you may use up to 3 more lines\./);
  const calls: ChatMessage[][] = [];
  const { m } = memWith(async (msgs) => (calls.push(msgs), res(["What you learned:", ...Array.from({ length: 16 }, (_, i) => `- fact ${i}`)].join("\n"))));
  m.add("go (1, 1) -> walked");
  m.tick(0);
  m.remember("the pond is at (5, 10)");
  m.tick(0);
  m.remember("berries grow north");
  await m.tick(0);
  const input = String(calls[0][1].content);
  assert.match(input, /No previous notes for this life\.\n\nThings the player asked to remember \(include them in the notes unless the transcript shows they are wrong; you may shorten them\):\n- \(2 turns ago\) the pond is at \(5, 10\)\n- \(1 turn ago\) berries grow north\n\nTranscript of the last year/);
  assert.equal(m.memory.length, 1 + 12, "two items: 10 + 2 fact lines");

  // no items: back to 10 lines and no section; many items: at most 13
  m.add("eat -> ate");
  await m.tick(0); await m.tick(0); await m.tick(0);
  assert.doesNotMatch(String(calls[1][1].content), /Things the player asked to remember/);
  assert.equal(m.memory.length, 1 + 10);
  for (let i = 0; i < 6; i++) m.remember(`item ${i}`);
  m.add("x");
  m.tick(0); m.tick(0); await m.tick(0);
  assert.equal(m.memory.length, 1 + 13);
});

test("YearMemory: remember items are cleared once a notes update succeeds, kept when it fails; items added meanwhile stay", async () => {
  let fail = true;
  const d = deferred<LlmResult>();
  const { m } = memWith(async () => {
    if (fail) throw new Error("LLM HTTP 500");
    return d.promise;
  }, { everyTurns: 1 });
  m.add("a");
  m.remember("first");
  await m.tick(0);
  assert.deepEqual(m.pendingRemember, ["first"], "kept after a failed update");
  fail = false;
  m.add("b");
  const p = m.tick(0)!;
  m.remember("during the call");
  d.resolve(res("- first"));
  await p;
  assert.deepEqual(m.memory, ["first"]);
  assert.deepEqual(m.pendingRemember, ["during the call"], "only what the note-taker saw is cleared");
});

test("YearMemory: a new life drops the remember items and restarts the turn count", async () => {
  const calls: ChatMessage[][] = [];
  const { m } = memWith(async (msgs) => (calls.push(msgs), res("- x")), { everyTurns: 1 });
  m.tick(0); m.tick(0);
  m.remember("from the last life");
  m.reset();
  assert.deepEqual(m.pendingRemember, []);
  m.remember("new life");
  m.add("a");
  await m.tick(0);
  assert.match(String(calls[0][1].content), /- \(1 turn ago\) new life\n/);
  assert.doesNotMatch(String(calls[0][1].content), /last life/);
});

test("agent with MEMORY_SUMMARY=1: remember gets one history line and an action event, is kept, and the note-taker gets it too; \"note\" is ignored", async () => {
  const replies = [
    '{"thought":"x","remember":"The pond is at (5, 10)","action":{"type":"wait","turns":1}}',
    '{"thought":"x","note":"strike flint near tinder","action":{"type":"wait","turns":1}}',
  ];
  const calls: ChatMessage[][] = [];
  const { A, seen } = agent({ memorySummaryTurns: 3 }, async (m) => (calls.push(m), res("- the pond is at (5, 10)")), () => replies.shift() ?? '{"action":{"type":"wait","turns":1}}');
  const events: { kind: string; text: string; data?: Record<string, unknown> }[] = [];
  A.log.emitEvent = (kind: string, e: { text: string; data?: Record<string, unknown> }) => events.push({ kind, ...e });
  await A.turn();
  await A.turn();
  const h = A.history.map((e: { action: string; result: string }) => `${e.action} -> ${e.result}`);
  assert.deepEqual(h.filter((l: string) => /remember|note|flint/i.test(l)), ['remember "The pond is at (5, 10)" -> kept'], "\"note\" leaves no trace");
  assert.deepEqual(A.mem.pendingRemember, ["The pond is at (5, 10)"]);
  const ev = events.filter((e) => e.kind === "action" && e.data?.remember);
  assert.deepEqual(ev.map((e) => [e.text, e.data!.remember]), [['remember "The pond is at (5, 10)" -> kept', "The pond is at (5, 10)"]]);
  const obs = seen[1];
  assert.equal((obs.match(/pond is at/g) ?? []).length, 2, "the history line and THINGS YOU CHOSE TO REMEMBER");
  assert.match(obs, /== THINGS YOU CHOSE TO REMEMBER ==\n1\. \(1 turn ago\) The pond is at \(5, 10\)/);
  assert.doesNotMatch(obs, /flint/);
  await A.turn();
  await new Promise((r) => setTimeout(r, 10));
  const input = String(calls[0][1].content);
  assert.match(input, /Things the player asked to remember[^\n]*\n- \(\d+ turns? ago\) The pond is at \(5, 10\)\n/);
  assert.doesNotMatch(input, /- you: remember/, "the item is not repeated in the transcript");
  assert.deepEqual(A.mem.pendingRemember, [], "cleared after the notes update");
});

test("agent by default: no note-taker call and no YOUR NOTES section; a remember is kept and shown", async () => {
  const { config } = await import("../config.ts");
  assert.equal(config.memorySummary, process.env.MEMORY_SUMMARY === "1", "MEMORY_SUMMARY is off unless set to 1");
  const { A, seen, summaryCalls } = agent({ memorySummary: false, memorySummaryTurns: 1 }, async () => res("- a note"), () => '{"remember":"x marks the spot","action":{"type":"wait","turns":1}}');
  for (let i = 0; i < 4; i++) await A.turn();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(summaryCalls.length, 0, "the note-taker is never called");
  assert.equal(A.history[0].result, "kept");
  assert.equal(A.history.filter((h: { result: string }) => h.result === "already remembered").length, 3, "exact duplicates are not added");
  assert.ok(seen.every((o) => !/YOUR NOTES/.test(o)));
  assert.match(seen[3], /== THINGS YOU CHOSE TO REMEMBER ==\n1\. \(\d+ turns? ago\) x marks the spot$/m);
  assert.deepEqual(A.kept.texts, ["x marks the spot"]);
});

// --- year lines (MEMORY_SUMMARY=years): one line per completed year, from that year's transcript alone

function yearsWith(call: (m: ChatMessage[]) => Promise<LlmResult>, o: Partial<ConstructorParameters<typeof YearMemory>[0]> = {}) {
  const done: { ok: boolean }[] = [];
  const m = new YearMemory({ mode: "years", everyTurns: 2, lockstep: false, cycleMs: 1000, call, onDone: (r) => done.push(r), ...o });
  return { m, done };
}

test("year-line writer: one line, second person, facts of that year (goals at a high level, with outcome); no advice or how-to", () => {
  assert.equal(
    YEAR_LINE_SYSTEM,
    `You write one line of a player's life record in a survival game. From the transcript of one year of their life, write ONE line in second person ("you"), at most 240 characters: what they did and made, where, who they were with, and notable events (births, deaths, injuries). You may say at a high level what they were trying to do ("goal:" lines: "you tried to...", "you wanted to...") and whether it worked, failed or was left unfinished. Otherwise only what the transcript shows happened: no advice, guesses, how-to or plans for later. Say what people said as said, not as fact. Reply with the line only.`,
  );
  {
    const { m } = yearsWith(async () => ({ text: "x" }) as LlmResult);
    m.goal("make fire");
    assert.deepEqual((m as unknown as { entries: string[] }).entries, ["goal: make fire"], "a new goal goes into the year's transcript");
  }
  const input = yearLineInput(30, 31, ["you: eat -> ate", 'claim: #3 LUNA said: "BERRIES NORTH"']);
  assert.equal(input, `The player's age during this year: 30 to 31.\n\nTranscript of this year, oldest first ("you:" is the player's action and its result; "saw:" happened nearby; "game:" is a game notice; "claim:" is what someone said, not checked; "goal:" is what the player set out to do):\n- you: eat -> ate\n- claim: #3 LUNA said: "BERRIES NORTH"`);
  assert.match(yearLineInput(4, 4, []), /^The player's age during this year: 4\.\n/);
  assert.equal(yearLabel({ from: 30, to: 31 }), "Age 30-31");
  assert.equal(yearLabel({ from: 30, to: 30 }), "Age 30");
});

test("trimYearLine: the first line with words, bullets, quotes and an echoed age label stripped, at most 240 chars", () => {
  assert.equal(trimYearLine("- You made a fire at (3, 4).\n- second line"), "You made a fire at (3, 4).");
  assert.equal(trimYearLine("```\nAge 30-31: you ate berries\n```"), "you ate berries");
  assert.equal(trimYearLine('**Age 30**: "you buried your mother"'), "you buried your mother");
  assert.equal(trimYearLine("<think>hm</think>\n\nyou slept"), "you slept");
  assert.equal(trimYearLine("x".repeat(300)).length, 240);
  assert.equal(trimYearLine(" \n)\n"), "");
});

test("YearMemory years mode: exactly one line per completed year, labelled with the ages, from that year's transcript alone", async () => {
  const calls: ChatMessage[][] = [];
  let n = 0;
  const { m, done } = yearsWith(async (msgs) => (calls.push(msgs), res(`- you did thing ${++n}`)));
  m.add("eat -> ate");
  assert.equal(m.tick(0, 30.1), null);
  const p1 = m.tick(0, 31.0);
  assert.ok(p1, "a year (2 decisions) in");
  await p1;
  m.add("go (5, 5) -> arrived");
  assert.equal(m.tick(0, 31.5), null);
  await m.tick(0, 32.1);
  assert.equal(calls.length, 2);
  assert.equal(calls[0][0].content, YEAR_LINE_SYSTEM);
  assert.match(calls[0][1].content, /^The player's age during this year: 30 to 31\./);
  assert.match(calls[0][1].content, /eat -> ate/);
  assert.match(calls[1][1].content, /^The player's age during this year: 31 to 32\./);
  assert.doesNotMatch(calls[1][1].content, /eat -> ate|thing 1/, "not cumulative: neither last year's transcript nor its line");
  assert.deepEqual(m.years, [{ from: 30, to: 31, text: "you did thing 1" }, { from: 31, to: 32, text: "you did thing 2" }]);
  assert.deepEqual(m.memory, [], "the notes are untouched");
  assert.deepEqual(done.map((d) => d.ok), [true, true]);
  // a year with nothing in its transcript gets no line and no call
  m.tick(0, 32.5);
  assert.equal(m.tick(0, 33.0), null);
  assert.equal(calls.length, 2);
});

test("YearMemory years mode: a failed year is retried on its own (never merged into the next) and dropped after the tries", async () => {
  let fail = true;
  const inputs: string[] = [];
  const { m, done } = yearsWith(async (msgs) => {
    inputs.push(msgs[1].content);
    if (fail) throw new Error("LLM HTTP 500");
    return res("you fished");
  }, { everyTurns: 2 });
  m.add("year one");
  m.tick(0, 10);
  await m.tick(0, 11); // try 1 fails
  m.add("year two");
  await m.tick(0, 11.5); // try 2 of year one (year two not due yet)
  assert.match(inputs[1], /year one/);
  assert.doesNotMatch(inputs[1], /year two/);
  fail = false;
  await m.tick(0, 12); // year two is cut off and queued; year one's 3rd try succeeds
  assert.deepEqual(m.years, [{ from: 10, to: 11, text: "you fished" }]);
  assert.doesNotMatch(inputs[2], /year two/);
  await m.tick(0, 12.2);
  assert.deepEqual(m.years.map((y) => [y.from, y.to]), [[10, 11], [11, 12]]);
  assert.match(inputs[3], /year two/);
  assert.doesNotMatch(inputs[3], /year one/);
  // all tries fail: that year gets no line
  fail = true;
  m.add("year three");
  m.tick(0, 12.5);
  for (let i = 0; i < YEAR_LINE_TRIES + 2; i++) await m.tick(0, 13);
  assert.equal(inputs.filter((s) => /year three/.test(s)).length, YEAR_LINE_TRIES);
  assert.equal(m.years.length, 2);
  assert.equal(m.busy, false);
  assert.equal(done.filter((d) => !d.ok).length, 2 + YEAR_LINE_TRIES);
});

test("YearMemory years mode: a new life clears the lines and drops a line still in flight; lines are saved per life and restored after a restart", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "yearlines-"));
  try {
    const file = yearLinesPath(dir, "run/1", "a1");
    assert.equal(file, path.join(dir, "research", "year-lines", "run_1", "a1.json"));
    const { m } = yearsWith(async () => res("you built a fire"), { everyTurns: 2, yearsFile: file });
    m.reset(7);
    m.add("x");
    m.tick(0, 20);
    m.add("y");
    await m.tick(0, 21);
    assert.deepEqual(m.years, [{ from: 20, to: 21, text: "you built a fire" }]);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { playerId: 7, years: m.years });

    // a restart: a fresh YearMemory gets them back for the same life, not for another one
    const { m: m2 } = yearsWith(async () => res(""), { yearsFile: file });
    assert.equal(m2.restoreYears(8), false);
    assert.deepEqual(m2.years, []);
    assert.equal(m2.restoreYears(7), true);
    assert.deepEqual(m2.years, [{ from: 20, to: 21, text: "you built a fire" }]);

    // a new life: nothing, saved; a line in flight from the last life is dropped
    const d = deferred<LlmResult>();
    const { m: m3 } = yearsWith(() => d.promise, { everyTurns: 2, yearsFile: file });
    m3.restoreYears(7);
    m3.add("z");
    m3.tick(0, 21);
    const p = m3.tick(0, 22)!;
    assert.ok(p);
    m3.reset(9);
    d.resolve(res("stale line"));
    await p;
    assert.deepEqual(m3.years, []);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { playerId: 9, years: [] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("agent with MEMORY_SUMMARY=years: a line per year in the background, YOUR PAST YEARS shows the last N, the count note names them; no notes, remember list unchanged", async () => {
  const { config } = await import("../config.ts");
  assert.equal(config.memoryYears, process.env.MEMORY_SUMMARY === "years");
  assert.equal(config.memoryYearLines, process.env.MEMORY_YEAR_LINES ? Math.max(1, Math.floor(Number(process.env.MEMORY_YEAR_LINES))) : 2);
  let n = 0;
  const { a, A, seen, logged, summaryCalls } = agent(
    { memorySummary: false, memoryYears: true, memoryYearLines: 2, memorySummaryTurns: 1 },
    async () => res(`you waited, year ${++n}`, 0.001),
    () => '{"thought":"wait it out","remember":"pond west","action":{"type":"wait","turns":1}}',
  );
  for (let i = 0; i < 5; i++) {
    await A.turn();
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.ok(summaryCalls.length >= 3, String(summaryCalls.length));
  assert.deepEqual(summaryCalls[0], { maxTokens: 800, extra: { reasoning: { max_tokens: 300 } }, json: false }, "same model and cap; max(decision, reasoning + one line)");
  assert.equal(summaryMaxTokens(800, 1200, YEAR_LINE_REPLY_TOKENS), 1400);
  assert.ok(a.yearLines.length >= 3);
  assert.deepEqual(a.memory, [], "no headed notes");
  const last = seen.at(-1)!;
  assert.match(last, /\(You see your last 30 actions and last 10 thoughts; older ones fade unless you chose to remember them\. A one-line summary of each past year of this life is kept; the last 2 are shown under YOUR PAST YEARS\.\)/);
  const section = last.split("== YOUR PAST YEARS ==\n")[1]?.split("\n\n")[0];
  assert.ok(section, last);
  const lines = section.split("\n");
  assert.equal(lines.length, 2, "only the last 2 years");
  const k = Number(/year (\d+)$/.exec(lines[1])?.[1]);
  assert.ok(k >= 3, lines[1]);
  assert.deepEqual(lines, [`- Age 20: you waited, year ${k - 1}`, `- Age 20: you waited, year ${k}`], "the last two, newest last");
  assert.match(last, /== THINGS YOU CHOSE TO REMEMBER ==\n1\. \(\d+ turns? ago\) pond west\n\n== YOUR PAST YEARS ==/);
  assert.doesNotMatch(last, /YOUR NOTES/);
  const yl = logged.find((r) => r.kind === "yearline");
  assert.ok(yl && yl.costUsd === 0.001 && /The player's age during this year: 20\./.test(yl.input), "logged with its cost");
  assert.doesNotMatch(yl.input, /wait it out/, "the agent's own thoughts are not input");
  assert.ok(!logged.some((r) => r.kind === "summary"));
});

test("agent by default (MEMORY_SUMMARY unset): no year-line calls, no YOUR PAST YEARS, the count note without years", async () => {
  const { A, seen, summaryCalls } = agent({ memorySummary: false, memorySummaryTurns: 1 }, async () => res("you waited"), () => '{"action":{"type":"wait","turns":1}}');
  for (let i = 0; i < 3; i++) await A.turn();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(summaryCalls.length, 0);
  assert.ok(seen.every((o) => !/PAST YEARS|past year/.test(o)));
  assert.match(seen.at(-1)!, /== YOUR LAST ACTIONS ==\n\(You see your last 30 actions and last 10 thoughts; older ones fade unless you chose to remember them\.\)\n/);
});
