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
import { YearMemory, trimSummary, summaryInput, summaryMaxTokens, looksLikeReasoning, SUMMARY_SYSTEM, SUMMARY_REPLY_TOKENS, NOTE_HEADINGS, REMEMBER_MAX } from "./memory.ts";

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
    assert.match(p, /"goal":"optional: your long-term goal for this life \(not this turn's step\); only when it changes","say"/, baseline);
  }
});

test("parser: a reply with \"note\" parses and runs; the note is ignored", () => {
  const r = parseReply('{"thought":"x","note":"strike flint near tinder","action":{"type":"eat"}}');
  assert.ok(r.ok);
  const c = checkActions(r.value as Record<string, unknown>, false, 4);
  assert.ok("steps" in c && c.steps.length === 1 && c.notes.length === 0, JSON.stringify(c));
});

test("observation: YOUR NOTES where the notebook was, headings kept, omitted while empty; long-term goal age; 15 history lines", () => {
  const g = world();
  const now = g.world.now();
  const history = Array.from({ length: 20 }, (_, i) => ({ t: now - 1000, action: `act${i}`, result: "ok" }));
  const base = { recipeHints: false, history, pastLifeNotes: [], clock, now };
  const obs = buildObservation(g.world, gd, { ...base, memory: ["What you learned:", "Pond at (5, 10)", "flint works on tinder only when dry"], goal: "make fire", goalSetAt: now - 3 * 8000 });
  assert.match(obs, /== YOUR NOTES \(this life\) ==\nWhat you learned:\n- Pond at \(5, 10\)\n- flint works on tinder only when dry$/);
  assert.doesNotMatch(obs, /NOTEBOOK|WHAT YOU REMEMBER/);
  assert.match(obs, /Your long-term goal \(set 3 turns ago\): make fire/);
  assert.equal((obs.match(/^- just now: act\d+/gm) ?? []).length, 15, "the last 15 actions are shown");
  assert.match(obs, /act19 -> ok/);
  assert.doesNotMatch(obs, /act4 -> ok/);

  const fresh = buildObservation(g.world, gd, { ...base, memory: [], goal: "make fire", goalSetAt: now });
  assert.doesNotMatch(fresh, /YOUR NOTES/);
  assert.match(fresh, /Your long-term goal \(just set\): make fire/);
  assert.match(buildObservation(g.world, gd, { ...base, goal: "x", goalSetAt: now - 8000 }), /Your long-term goal \(set 1 turn ago\): x/);
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
  assert.match(seen.at(-1)!, /Your long-term goal \(set \d+ turns? ago\): find berries/);

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
  assert.match(seen[2], /Your long-term goal \(set 2 turns ago\): make fire/);
  assert.match(seen[3], /Your long-term goal \(set 1 turn ago\): eat/);
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

test("remember: parsed and cleaned like say/goal (about 160 chars); \"note\" is not read as remember", () => {
  const r = parseReply('{"thought":"x","remember":"  the pond\\nis at (5, 10)  ","action":{"type":"eat"}}');
  assert.ok(r.ok);
  assert.equal(parseRemember(r.value), "the pond is at (5, 10)");
  const long = parseRemember({ remember: "y".repeat(400) });
  assert.ok(long.length <= 160 && long.startsWith("yyy"), String(long.length));
  assert.equal(parseRemember({ remember: 42 }), "");
  assert.equal(parseRemember({}), "");
  assert.equal(parseRemember({ note: "strike flint near tinder" }), "", "the old note field stays ignored");
});

test("remember: in the reply format line of both baselines", () => {
  for (const baseline of ["new", "playbook"] as const) {
    const p = buildSystemPrompt(clock, { craft: true, actionListMax: 3, baseline });
    assert.match(p, /"say":"optional: words to say now","remember":"optional: something you want to keep in your notes","action"/, baseline);
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

test("agent: remember gets one history line and an action event, no pending list in the observation; \"note\" is ignored", async () => {
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
  assert.deepEqual(h.filter((l: string) => /remember|note|flint/i.test(l)), ['remember "The pond is at (5, 10)" -> kept for your next notes'], "\"note\" leaves no trace");
  assert.deepEqual(A.mem.pendingRemember, ["The pond is at (5, 10)"]);
  const ev = events.filter((e) => e.kind === "action" && e.data?.remember);
  assert.deepEqual(ev.map((e) => [e.text, e.data!.remember]), [['remember "The pond is at (5, 10)" -> kept for your next notes', "The pond is at (5, 10)"]]);
  const obs = seen[1];
  assert.equal((obs.match(/pond is at/g) ?? []).length, 1, "only the history line shows it");
  assert.doesNotMatch(obs, /flint/);
  await A.turn();
  await new Promise((r) => setTimeout(r, 10));
  const input = String(calls[0][1].content);
  assert.match(input, /Things the player asked to remember[^\n]*\n- \(\d+ turns? ago\) The pond is at \(5, 10\)\n/);
  assert.doesNotMatch(input, /- you: remember/, "the item is not repeated in the transcript");
  assert.deepEqual(A.mem.pendingRemember, [], "cleared after the notes update");
});

test("agent: with MEMORY_SUMMARY=0 a remember says it was not kept", async () => {
  const { A } = agent({ memorySummary: false }, async () => res(""), () => '{"remember":"x marks the spot","action":{"type":"wait","turns":1}}');
  await A.turn();
  assert.equal(A.history[0].result, "not kept: notes are off");
  assert.deepEqual(A.mem.pendingRemember, []);
});
