// The agent's turn loop against the fake server and a scripted (fake) LLM:
// what reaches the model's next observation, action lists, stale targets.
import { test } from "node:test";
import assert from "node:assert/strict";
import { GameData } from "../game/gameData.ts";
import { FakeGame } from "../game/fakeGame.ts";
import { Body } from "../game/body.ts";
import { Agent, type AgentHooks } from "./agent.ts";
import type { Config } from "../config.ts";
import type { Llm, LlmResult, ChatMessage } from "./llm.ts";
import type { EventLog } from "../events.ts";

const gd = new GameData();
const id = (n: string) => gd.idByName(n)!;

const baseCfg = {
  runId: "t", recipeHints: true, craftMacro: true, llmModel: "fake", llmReasoningCap: false, llmDecisionMaxTokens: 800, llmReasoningMaxTokens: 300,
  decisionIntervalMs: 50, babyDecisionIntervalMs: 50, babyIdleMaxMs: 400, decisionCycleMs: 300, memoryMode: "per-life", actionListMax: 3,
};

function reply(text: string): LlmResult {
  return { text, promptTokens: 0, completionTokens: 0, costUsd: 0, latencyMs: 1, model: "fake", finishReason: "stop" };
}

/** an agent on a fake world; the LLM answers from `replies` (strings or functions of the observation) */
export function agentFor(g: FakeGame, replies: (string | ((obs: string) => string) | Error)[], cfg: Record<string, unknown> = {}, hooks: AgentHooks = {}) {
  const logged: Record<string, unknown>[] = [];
  const log = { emitEvent: () => {}, write: (_f: string, rec: Record<string, unknown>) => logged.push(rec) } as unknown as EventLog;
  const seen: string[] = [];
  const llm = {
    overBudget: false,
    chat: async (m: ChatMessage[]) => {
      const obs = String(m[m.length - 1].content);
      seen.push(obs);
      const r = replies.shift();
      if (r instanceof Error) throw r;
      return reply(typeof r === "function" ? r(obs) : r ?? '{"action":{"type":"wait"}}');
    },
  } as unknown as Llm;
  const a = new Agent("a1", { ...baseCfg, ...cfg } as unknown as Config, gd, llm, log, undefined, hooks);
  const A = a as unknown as Record<string, any>;
  A.world = g.world;
  A.conn = { closed: false, close() {} };
  A.body = new Body(g.conn, g.world, gd);
  A.body.interrupt = () => A.urgentSinceActionStart();
  return { a, A, seen, logged };
}

function camp() {
  const g = new FakeGame(gd);
  g.addPlayer({ id: 1, x: 0, y: 0, age: 20, held: 0, female: true });
  g.setTile(2, 0, id("Stone"));
  g.setTile(4, 0, id("Big Hard Rock"));
  g.food = 15;
  g.start();
  return g;
}

test("provider errors never reach the model: logged only, nothing in the next observation", async () => {
  const g = camp();
  const { A, seen, logged } = agentFor(g, [new Error('LLM HTTP 402: {"error":{"message":"Insufficient credits"}}'), '{"action":{"type":"wait"}}']);
  A.sleepInterruptible = async () => {};
  await A.turn();
  assert.equal(A.history.length, 0, "no history entry for an infrastructure failure");
  assert.ok(logged.some((r) => /402/.test(String(r.error))), "the error is logged");
  await A.turn();
  assert.doesNotMatch(seen[1], /402|credits|HTTP|didn't arrive/i);
});

const results = (A: Record<string, any>) => A.history.map((h: { action: string; result: string }) => `${h.action} -> ${h.result}`);

test("actions list: steps run back to back in order, each result reported", async () => {
  const g = camp();
  const { A } = agentFor(g, ['{"thought":"make a sharp stone","actions":[{"type":"use","x":2,"y":0},{"type":"use","x":4,"y":0},{"type":"drop"}]}']);
  const t0 = Date.now();
  await A.turn();
  const r = results(A);
  assert.equal(r.length, 3, r.join("\n"));
  assert.match(r[0], /^use \(2, 0\) \[step 1\/3\] -> use: .*holding nothing -> Stone/);
  assert.match(r[1], /^use \(4, 0\) \[step 2\/3\] -> use: .*holding Stone -> Sharp Stone/);
  assert.match(r[2], /^drop \[step 3\/3\] -> drop: /);
  assert.ok(Date.now() - t0 < 3000, "no waiting between steps");
});

test("actions list: a failed step stops the rest, and the skip says why", async () => {
  const g = camp();
  const { A } = agentFor(g, ['{"actions":[{"type":"use","x":9,"y":9},{"type":"use","x":4,"y":0},{"type":"drop"}]}']);
  await A.turn();
  const r = results(A);
  assert.equal(r.length, 2, r.join("\n"));
  assert.match(r[0], /nothing happened/);
  assert.match(r[1], /^\(not done: use \(4, 0\), drop\) -> skipped because step 1 didn't work/);
});

test("actions list: a salient event stops the rest", async () => {
  const g = camp();
  const { A } = agentFor(g, ['{"actions":[{"type":"use","x":2,"y":0},{"type":"use","x":4,"y":0}]}']);
  const exec = A.execute.bind(A);
  A.execute = async (a: unknown) => {
    const r = await exec(a);
    A.noteSalient({ reason: 'your baby #2 says "F" (hungry)', urgent: true, t: Date.now() });
    return r;
  };
  await A.turn();
  const r = results(A);
  assert.equal(r.length, 2, r.join("\n"));
  assert.match(r[1], /skipped because something happened: your baby #2 says "F"/);
});

test("actions list: capped at ACTION_LIST_MAX; invalid later steps are not run and the model is told", async () => {
  const g = camp();
  const { A } = agentFor(g, ['{"actions":[{"type":"use","x":2,"y":0},{"type":"drop"},{"type":"use","x":2,"y":0},{"type":"drop"}]}'], { actionListMax: 2 });
  await A.turn();
  let r = results(A);
  assert.equal(r.filter((l: string) => /\[step/.test(l)).length, 2);
  assert.match(r.at(-1), /only 2 steps run per turn; the last 2 were not done/);

  const g2 = camp();
  const { A: B } = agentFor(g2, ['{"actions":[{"type":"use","x":2,"y":0},{"type":"fly"}]}']);
  await B.turn();
  r = results(B);
  assert.match(r[0], /use \(2, 0\) -> use:/, "the valid first step ran (as a single action)");
  assert.match(r.at(-1), /step 2 and later not done: unknown action type "fly"/);
});

/** a map change the server would send when someone else (or time) changes a tile */
function changeTile(g: FakeGame, x: number, y: number, objId: number, by = -1) {
  g.setTile(x, y, objId);
  g.world.handle({ type: "MX", changes: [{ x, y, floor: 0, obj: { id: objId, contained: [] }, responsibleId: by }] });
}

test("staleness: a target that changed while the model was thinking is not acted on, and the model is told", async () => {
  const g = camp();
  const { A, seen } = agentFor(g, [
    () => {
      changeTile(g, 2, 0, 0, 7); // someone else took the stone meanwhile
      return '{"action":{"type":"use","x":2,"y":0}}';
    },
    () => {
      changeTile(g, 4, 0, id("Stone")); // turned into something else (by time, say)
      return '{"action":{"type":"use","x":4,"y":0}}';
    },
  ]);
  await A.turn();
  assert.match(seen[0], /Stone/, "the model saw the stone");
  assert.match(A.history[0].result, /^the Stone at \(2,0\) is gone since you looked; you did nothing$/);
  assert.equal(g.sent.filter((c) => c.startsWith("USE")).length, 0, "nothing was sent to the server");
  await A.turn();
  assert.match(A.history[1].result, /the Big Hard Rock at \(4,0\) changed since you looked: it is now Stone; you did nothing/);
});

test("staleness: a thing that turned into its own next stage (tinder catching fire) is acted on, with a note", async () => {
  const g = new FakeGame(gd);
  g.addPlayer({ id: 1, x: 0, y: 0, age: 20, held: id("Kindling"), female: true });
  g.setTile(1, 0, id("Smoldering Tinder"));
  g.start();
  const { A } = agentFor(g, [
    () => {
      changeTile(g, 1, 0, id("Burning Tinder"));
      return '{"action":{"type":"use","x":1,"y":0}}';
    },
  ]);
  await A.turn();
  assert.match(A.history[0].result, /^\(the Smoldering Tinder at \(1,0\) had become Burning Tinder\) use: tile \(1,0\) Burning Tinder -> Fire/);
});

test("staleness: something in hand that decayed while the model thought is noted (Ember Leaf -> Leaf)", async () => {
  const g = new FakeGame(gd);
  g.addPlayer({ id: 1, x: 0, y: 0, age: 20, held: id("Ember Leaf"), female: true });
  g.setTile(1, 0, id("Juniper Tinder"));
  g.start();
  const { A } = agentFor(g, [
    () => {
      g.players.get(1)!.held = id("Leaf");
      g.world.handle({ type: "PU", updates: [puOf(g, 1)] });
      return '{"action":{"type":"use","x":1,"y":0}}';
    },
  ]);
  await A.turn();
  assert.match(A.history[0].result, /^\(your Ember Leaf had become Leaf\) use at \(1,0\): nothing happened/);
});

test("staleness: changes made by our own earlier steps don't count; a person who moved is noted", async () => {
  const g = camp();
  const { A } = agentFor(g, ['{"actions":[{"type":"use","x":2,"y":0},{"type":"drop","x":2,"y":0},{"type":"use","x":2,"y":0}]}']);
  await A.turn();
  const r = results(A);
  assert.equal(r.length, 3, r.join("\n"));
  assert.doesNotMatch(r.join("\n"), /since you looked/);

  const g2 = new FakeGame(gd);
  g2.addPlayer({ id: 1, x: 0, y: 0, age: 20, held: 0, female: true });
  g2.addPlayer({ id: 2, x: 1, y: 0, age: 0.5, held: 0, female: false, motherId: 1 });
  g2.start();
  const { A: B } = agentFor(g2, [
    () => {
      // the baby crawled 3 tiles while the model was thinking
      g2.players.get(2)!.x = 4;
      g2.world.handle({ type: "PU", updates: [{ ...puOf(g2, 2), x: 4, y: 0 }] });
      return '{"action":{"type":"pick_up_baby","person":2}}';
    },
  ]);
  await B.turn();
  assert.match(B.history[0].result, /^\(#2 had moved from \(1,0\) to \(4,0\) since you looked\) picked up/);
});

function puOf(g: FakeGame, pid: number) {
  const p = g.players.get(pid)!;
  return {
    id: p.id, displayId: p.female ? 19 : 347, facing: 0, action: false, actionTarget: [0, 0] as [number, number],
    held: { id: p.held, contained: [] }, heldOriginValid: false, heldOrigin: [0, 0] as [number, number], heldTransitionSourceId: 0,
    heat: 0.5, doneMovingSeq: 0, forced: false, x: p.x, y: p.y, age: p.age, ageRate: 60, moveSpeed: 3.75,
    clothing: Array.from({ length: 6 }, () => ({ id: 0, contained: [] })), justAte: false, lastAteId: 0, responsibleId: -1,
    heldYum: false, heldLearned: false,
  };
}

test("plan continuity: the next observation shows the previous thought and the last actions' outcomes", async () => {
  const g = camp();
  const { A, seen } = agentFor(g, ['{"thought":"Grab the stone, then sharpen it on the rock.","action":{"type":"use","x":2,"y":0}}', '{"action":{"type":"wait"}}']);
  await A.turn();
  await A.turn();
  assert.match(seen[1], /== YOUR LAST ACTIONS ==\nYour previous thought: "Grab the stone, then sharpen it on the rock\."\n- .*: use \(2, 0\) -> use: .*Stone/);
  assert.doesNotMatch(seen[0], /previous thought/, "nothing on the first turn");
});

test("birth wake-up: the server sends the newborn's PU before its LN; the mother is woken once the LN lands", () => {
  const g = new FakeGame(gd);
  g.addPlayer({ id: 1, x: 0, y: 0, age: 20, held: 0, female: true });
  g.start();
  const { A } = agentFor(g, []);
  A.checkWorld(g.world);
  let woken = 0;
  A.wake = () => woken++;
  // the newborn appears: PU first, no lineage yet (the order captured live)
  g.addPlayer({ id: 2, x: 0, y: 0, age: 0, held: 0, female: false });
  g.world.handle({ type: "PU", updates: [puOf(g, 2)] });
  A.checkWorld(g.world);
  assert.equal(A.pending.length, 0, "not known as ours yet");
  g.world.handle({ type: "LN", lineages: [{ id: 2, ancestors: [1], eveId: 1 }] });
  A.checkWorld(g.world);
  const birth = A.pending.find((p: { reason: string }) => /gave birth to #2/.test(p.reason));
  assert.ok(birth && birth.urgent, "urgent birth event");
  assert.ok(woken >= 1, "the mother was woken");
  A.checkWorld(g.world);
  assert.equal(A.pending.filter((p: { reason: string }) => /gave birth/.test(p.reason)).length, 1, "only once");
});

test("eat while holding clothing puts it on even when full (as the real client does); food when full is still refused", async () => {
  const g = new FakeGame(gd);
  g.addPlayer({ id: 1, x: 0, y: 0, age: 20, held: id("Reed Skirt"), female: true });
  g.food = 20;
  g.start();
  const { A } = agentFor(g, ['{"action":{"type":"eat"}}']);
  await A.turn();
  assert.match(results(A)[0], /^eat -> you put on the Reed Skirt \(bottom\)/);
  assert.ok(g.sent.some((c) => c.startsWith("SELF ")));

  const g2 = new FakeGame(gd);
  g2.addPlayer({ id: 1, x: 0, y: 0, age: 20, held: id("Gooseberry"), female: true });
  g2.food = 20;
  g2.start();
  const b = agentFor(g2, ['{"action":{"type":"eat"}}']);
  await b.A.turn();
  assert.equal(results(b.A)[0], "eat -> you're full, can't eat now");
  assert.ok(!g2.sent.some((c) => c.startsWith("SELF ")));
});

/** an Eve (#1) holding her unnamed newborn (#2); #3 is her grown daughter; #9 is another family's Eve */
function family(motherName: string | null, daughterName: string | null) {
  const g = new FakeGame(gd);
  g.addPlayer({ id: 1, x: 0, y: 0, age: 30, held: -2, female: true });
  g.addPlayer({ id: 2, x: 0, y: 0, age: 0.1, held: 0, female: true, motherId: 1 });
  g.addPlayer({ id: 3, x: 1, y: 0, age: 16, held: 0, female: true, motherId: 1 });
  g.addPlayer({ id: 9, x: 3, y: 0, age: 25, held: 0, female: true });
  g.start();
  g.world.handle({ type: "LN", lineages: [{ id: 1, ancestors: [], eveId: 1 }, { id: 2, ancestors: [1], eveId: 1 }, { id: 3, ancestors: [1], eveId: 1 }, { id: 9, ancestors: [], eveId: 9 }] });
  const nm = (pid: number, name: string | null) => {
    if (!name) return;
    const [first, ...last] = name.split(" ");
    g.world.handle({ type: "NM", names: [{ id: pid, first, ...(last.length ? { last: last.join(" ") } : {}) }] });
  };
  nm(1, motherName);
  nm(3, daughterName);
  nm(9, "AURORA HOPE"); // another family's Aurora doesn't count
  return g;
}

const says = (g: FakeGame) => g.sent.filter((c) => c.startsWith("SAY ")).map((c) => c.slice("SAY 0 0 ".length));

test("naming: an unnamed Eve can't found a family with a surname any family has used; she is told which are taken", async () => {
  const g = family(null, null);
  const taken = ["DAWN", "SOL"];
  const { A, seen } = agentFor(g, ['{"say":"I am Aurora Dawn","action":{"type":"wait"}}', '{"say":"I AM AURORA REED","action":{"type":"wait"}}'], {}, { takenSurnames: () => taken });
  A.sleepInterruptible = async () => {};
  await A.turn();
  assert.deepEqual(says(g), [], "the naming is not sent");
  // HOPE: seen on #9 (AURORA HOPE), not in the records yet
  assert.equal(results(A)[0], 'say "I am Aurora Dawn" -> family name DAWN is already taken by an earlier family; choose a new one (taken: DAWN, SOL, HOPE)');
  assert.match(seen[0], /No name yet: found your family by saying "I AM <FIRST NAME> <FAMILY NAME>" \(once only\)\. Family names already taken \(pick a new one\): DAWN, SOL, HOPE\./);
  await A.turn();
  assert.match(seen[1], /DAWN is already taken/, "the refusal reaches the next observation");
  assert.deepEqual(says(g), ["I AM AURORA REED"]);
});

test("naming: 'I AM HOPE' founds EVE HOPE, so it is checked too; at most 15 taken names are listed", async () => {
  const g = family(null, null);
  const many = Array.from({ length: 20 }, (_, i) => `FAM${String.fromCharCode(65 + i)}`);
  const { A } = agentFor(g, ['{"say":"I AM HOPE","action":{"type":"wait"}}'], {}, { takenSurnames: () => many });
  A.sleepInterruptible = async () => {};
  await A.turn();
  assert.deepEqual(says(g), []);
  const r = results(A)[0];
  assert.match(r, /family name HOPE is already taken by an earlier family; choose a new one \(taken: FAMA, FAMB, .*FAMO, \.\.\.\)$/);
  assert.equal((r.match(/FAM[A-Z]/g) ?? []).length, 15);
});

test("naming: a repeated first name in the family gets the next numeral, and the mother is told", async () => {
  const g = family("MIRA DAWN", "AURORA DAWN");
  const { A } = agentFor(g, ['{"say":"YOU ARE AURORA","action":{"type":"wait"}}'], {}, { familyFirstNames: () => [] });
  A.sleepInterruptible = async () => {};
  await A.turn();
  assert.deepEqual(says(g), ["YOU ARE AURORA II"]);
  assert.equal(results(A)[0], 'say "YOU ARE AURORA" -> said "YOU ARE AURORA II": named her AURORA II; AURORA was taken in your family');
});

test("naming: dead and out-of-sight relatives from the lineage records count; III after II; a new name passes unchanged", async () => {
  const g = family("MIRA DAWN", null);
  const { A } = agentFor(g, ['{"say":"you are aurora","action":{"type":"wait"}}'], {}, { familyFirstNames: () => ["AURORA", "AURORA II", "MIRA"] });
  A.sleepInterruptible = async () => {};
  await A.turn();
  assert.deepEqual(says(g), ["YOU ARE AURORA III"]);

  const g2 = family("MIRA DAWN", "AURORA DAWN");
  const b = agentFor(g2, ['{"say":"YOU ARE LUNA","action":{"type":"wait"}}'], {}, { familyFirstNames: () => ["AURORA"] });
  b.A.sleepInterruptible = async () => {};
  await b.A.turn();
  assert.deepEqual(says(g2), ["YOU ARE LUNA"]);
  assert.equal(results(b.A)[0], 'say "YOU ARE LUNA" -> said "YOU ARE LUNA"');
});

test("naming: a named Eve's 'I AM ...' and naming an already named baby are left alone; 'AURORA II DAWN' parses whole", async () => {
  const g = family("MIRA DAWN", "AURORA DAWN");
  g.world.handle({ type: "NM", names: [{ id: 2, first: "AURORA", last: "II DAWN" }] });
  const { A } = agentFor(g, ['{"say":"I AM MIRA DAWN. YOU ARE AURORA","action":{"type":"wait"}}'], {}, { takenSurnames: () => ["DAWN"], familyFirstNames: () => ["AURORA"] });
  A.sleepInterruptible = async () => {};
  await A.turn();
  assert.deepEqual(says(g), ["I AM MIRA DAWN. YOU ARE AURORA"]);
  assert.equal(g.world.players.get(2)!.name, "AURORA II DAWN", "client parsing keeps the numeral in the name");
});
