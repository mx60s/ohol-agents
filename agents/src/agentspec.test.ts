// GET /api/agent-spec: shape, the real prompt, size caps, sanitisation, and the
// mirrored constants still matching the files they come from.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { createServer } from "node:http";
import { config, type Config } from "./config.ts";
import {
  EXAMPLE_CAPS,
  OBSERVATION_LIMITS,
  REPLY_FIELDS,
  USER_SUFFIX,
  actionCatalogue,
  buildAgentSpec,
  clearAgentSpecCache,
  findExampleTurn,
  handleAgentSpecApi,
  readTailLines,
  serverSetting,
} from "./agentspec.ts";
import { systemPromptFor } from "./agent/prompt.ts";
import { validActionTypes } from "./agent/reply.ts";
import { sayLimit } from "./game/body.ts";
import type { AgentSpecResponse } from "./api-types.ts";

const SRC = path.dirname(new URL(import.meta.url).pathname);
const src = (f: string) => readFileSync(path.join(SRC, f), "utf8");
const cfg = (patch: Partial<Config> = {}): Config => ({ ...config, ...patch });

function obs(age: number, extra = "") {
  return `== YOU ==\n#2 MARA BELL (woman, ${Math.round(age)}), an Eve.\nAge ${age.toFixed(1)} of at most 60. At (1, 2), grassland.\n${extra}`;
}

/** a run dir with llm.jsonl + events.jsonl */
function runDir(lines: Record<string, unknown>[], events: Record<string, unknown>[] = []) {
  const dir = mkdtempSync(path.join(tmpdir(), "spec-"));
  writeFileSync(path.join(dir, "llm.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  writeFileSync(path.join(dir, "events.jsonl"), events.map((l) => JSON.stringify(l)).join("\n") + (events.length ? "\n" : ""));
  return dir;
}

const reply = (action: unknown, extra: Record<string, unknown> = {}) => JSON.stringify({ thought: "go to the berries", ...extra, action });

test("the prompt is exactly systemPromptFor(config), for each setting", () => {
  for (const patch of [{}, { craftMacro: false }, { actionListMax: 1 }, { timeScale: 3, decisionCycleMs: 6000 }]) {
    const c = cfg(patch);
    const s = buildAgentSpec(c, null);
    assert.equal(s.systemPrompt, systemPromptFor(c));
    assert.equal(s.example, null);
  }
});

test("the action catalogue is the prompt's own list and matches the parser", () => {
  for (const craftMacro of [true, false]) {
    const c = cfg({ craftMacro });
    const acts = actionCatalogue(c);
    assert.deepEqual(acts.map((a) => a.type).sort(), validActionTypes(craftMacro).sort());
    const prompt = systemPromptFor(c);
    for (const a of acts) {
      assert.ok(prompt.includes(`${a.template}  ${a.meaning}`), a.type);
      assert.ok(a.meaning.length > 5);
    }
    assert.equal(acts.find((a) => a.type === "craft")?.temporary, craftMacro ? true : undefined);
  }
  const use = actionCatalogue(cfg()).find((a) => a.type === "use")!;
  assert.deepEqual(use.fields, ["x", "y"]);
  assert.deepEqual(actionCatalogue(cfg()).find((a) => a.type === "pick_up_baby")!.fields, ["person"]);
});

test("response shape: settings, interventions, limits, say limits", () => {
  const c = cfg({ timeScale: 2, decisionCycleMs: 4700, craftMacro: true, recipeHints: false, actionListMax: 3 });
  const s = buildAgentSpec(c, null, { env: {}, runId: "r1" });
  assert.equal(s.runId, "r1");
  assert.equal(s.userSuffix, USER_SUFFIX);
  assert.equal(s.settings.model, c.llmModel);
  assert.equal(s.settings.timeScale, 2);
  assert.equal(s.settings.decisionCycleMs, 4700);
  assert.equal(s.settings.gameSecondsPerTurn, 2.35);
  assert.equal(s.settings.turnsPerYear, 25.5);
  assert.equal(s.settings.actionListMax, 3);
  const by = Object.fromEntries(s.interventions.map((i) => [i.id, i]));
  assert.equal(by["craft"].on, true);
  assert.equal(by["recipe-hints"].on, false);
  assert.equal(by["time-scale"].on, true);
  assert.equal(by["action-lists"].category, "human-ui");
  for (const i of s.interventions) assert.ok(["human-ui", "wiki", "beyond-human", "game-setting"].includes(i.category), i.id);
  assert.equal(new Set(s.interventions.map((i) => i.id)).size, s.interventions.length);
  for (const { age, letters } of s.sayLimits) assert.equal(letters, sayLimit(age));
  assert.ok(s.replyFields.length === REPLY_FIELDS.length);
  // every reply field is named in the prompt's format
  for (const f of s.replyFields) assert.ok(s.systemPrompt.includes(`"${f.name}"`), f.name);
  assert.deepEqual(s.replyFields.map((f) => f.name), ["thought", "goal", "say", "remember", "forget", "action", "actions"]);
  assert.match(s.actions.find((a) => a.type === "search")!.note!, /hint search.*first step first.*until the next search/);
  assert.match(s.actions.find((a) => a.type === "use")!.note!, new RegExp(`${s.limits.maxActDist} tiles`));
  assert.equal(s.actions.find((a) => a.type === "go")!.note, undefined);
  assert.equal(s.settings.turnClock, false);
  assert.equal(s.limits.heardTurns, Math.round(90_000 / 4700));
  // agent-kept memory replaces the note-taker (off by default); its capacity is MEMORY_MAX_ENTRIES
  assert.equal(by["kept-memory"].on, true);
  assert.match(by["kept-memory"].detail, /^up to 25 entries the agent chooses, verbatim/);
  assert.equal(s.limits.keptMax, 25);
  const small = buildAgentSpec(cfg({ memoryMaxEntries: 7 }), null, { env: {} });
  assert.equal(small.limits.keptMax, 7);
  assert.match(small.interventions.find((i) => i.id === "kept-memory")!.detail, /^up to 7 entries/);
  assert.match(small.replyFields.find((f) => f.name === "remember")!.meaning, /up to 7 entries/);
});

test("turn clock: settings, heard turns and the turn-clock intervention", () => {
  const c = cfg({ turnClock: true, turnGameS: 2.4, timeScale: 1, babyIdleTurns: 10, memorySummaryTurns: 25 });
  const s = buildAgentSpec(c, null, { env: { OHOL_SETTING_mtsEarlyMaxBabies: "3", OHOL_SETTING_mtsEarlyMaxGenerations: "5", OHOL_SETTING_mtsLangFullSeconds: "300" } });
  assert.equal(s.settings.turnClock, true);
  assert.equal(s.settings.gameSecondsPerTurn, 2.4);
  assert.equal(s.settings.turnsPerYear, 25);
  assert.equal(s.settings.babyIdleTurns, 10);
  assert.equal(s.settings.memorySummaryTurns, 25);
  assert.equal(s.limits.heardTurns, 11);
  const by = Object.fromEntries(s.interventions.map((i) => [i.id, i]));
  assert.equal(by["turn-clock"].on, true);
  assert.equal(by["early-birth-cap"].on, true);
  assert.match(by["early-birth-cap"].detail, /at most 3 babies per woman in generations 1-5/);
  assert.equal(by["language-learning"].on, true);
  const off = buildAgentSpec(cfg(), null, { env: { OHOL_SETTING_mtsEarlyMaxBabies: "0", OHOL_SETTING_mtsLangFullSeconds: "0" } });
  assert.equal(off.interventions.find((i) => i.id === "early-birth-cap")!.on, false);
  assert.equal(off.interventions.find((i) => i.id === "language-learning")!.on, false);
});

test("server settings: OHOL_SETTING_ wins, then the shipped .ini, else unknown", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ini-"));
  writeFileSync(path.join(dir, "mtsNewPlayerFoodBonus.ini"), "1\n");
  assert.deepEqual(serverSetting("mtsNewPlayerFoodBonus", {}, dir), { value: "1", source: "settings file" });
  assert.deepEqual(serverSetting("mtsNewPlayerFoodBonus", { OHOL_SETTING_mtsNewPlayerFoodBonus: "0" }, dir), { value: "0", source: "env" });
  assert.deepEqual(serverSetting("nope", {}, dir), { value: null, source: "unknown" });
  const s = buildAgentSpec(cfg(), null, { env: { OHOL_SETTING_mtsNewPlayerFoodBonus: "0" } });
  assert.equal(s.interventions.find((i) => i.id === "food-bonus")!.on, false);
  rmSync(dir, { recursive: true, force: true });
});

test("mirrored constants match observe.ts, salience.ts, agent.ts and prompt.ts", () => {
  const o = src("agent/observe.ts");
  const L = OBSERVATION_LIMITS;
  assert.match(src("game/world.ts"), new RegExp(`const VIEW_RADIUS = ${L.viewRadius};`));
  assert.match(o, new RegExp(`const RESOURCE_RADIUS = ${L.resourceRadius};`));
  assert.match(o, new RegExp(`const MAX_KINDS = ${L.maxThingKinds};`));
  assert.match(o, new RegExp(`const MAX_HINTS = ${L.maxHints};`));
  assert.match(o, new RegExp(`const HISTORY_SHOWN = ${L.historyShown};`));
  assert.equal(L.peopleRadius, L.viewRadius + 4);
  assert.match(o, /<= VIEW_RADIUS \+ 4\)/);
  assert.match(o, new RegExp(`people\\.slice\\(0, ${L.maxPeople}\\)`));
  // windows in wall s (turn clock: the same number of 8 s turns, see observe.ts shownMs)
  assert.match(o, new RegExp(`const HEARD_SHOWN_MS = ${L.heardWindowS}_000;`));
  assert.match(o, new RegExp(`now - h\\.t < shownMs\\(HEARD_SHOWN_MS, clock\\)\\)\\.slice\\(-${L.heardMax}\\)`));
  assert.match(o, new RegExp(`const SEEN_TURNS = ${L.seenTurns};`));
  assert.match(o, new RegExp(`const SEEN_SHOWN = ${L.seenMax};`));
  assert.match(src("game/world.ts"), new RegExp(`const SEEN_DID_PER_TURN = ${L.seenPerPersonPerTurn};`));
  assert.match(o, /now - e\.t < \(SEEN_TURNS \+ 0\.5\) \* clock\.cycleMs\)\.slice\(-SEEN_SHOWN\)/);
  const m = src("agent/memory.ts");
  assert.match(m, new RegExp(`MEMORY_MAX_LINES = ${L.memoryLines};`));
  assert.match(m, new RegExp(`MEMORY_LINE_CHARS = ${L.memoryLineChars};`));
  assert.match(src("agent/salience.ts"), new RegExp(`const HEAR_RADIUS = ${L.wakeSpeechRadius};`));
  const a = src("agent/agent.ts");
  assert.ok(a.includes(`obs + "\\n\\n${USER_SUFFIX}"`), "user suffix");
  assert.match(a, new RegExp(`world\\.food <= ${L.reflexFood} &&`));
});

test("example turn: the latest completed adult decision, with its results", () => {
  const t = 1_800_000_000_000;
  const dir = runDir(
    [
      { t, agentId: "a01", playerId: 2, lifeIndex: 1, observation: obs(24), reply: reply({ type: "go", x: 3, y: 4 }, { remember: "the spring is north", note: "old notebook field" }), reasoning: "berries are north", model: "m/x" },
      { t: t + 100, agentId: "a02", playerId: 5, observation: obs(1.2), reply: reply({ type: "jump" }) }, // a baby
      { t: t + 200, agentId: "a03", playerId: 7, observation: obs(30), reply: "no json here" }, // unparseable
      { t: t + 300, agentId: "a04", playerId: 9, observation: obs(30), reply: reply({ type: "fly" }) }, // invalid action
      { t: t + 400, agentId: "a03", playerId: 7, error: "HTTP 500" },
      { t: t + 5000, agentId: "a01", playerId: 2, observation: obs(24.1), reply: reply({ type: "eat" }) }, // latest, but no next turn yet
      { t: t + 6000, agentId: "a02", playerId: 5, observation: obs(1.3), reply: reply({ type: "jump" }) },
      { t: t + 6000, agentId: "a03", playerId: 7, observation: obs(30), reply: reply({ type: "eat" }) },
      { t: t + 6000, agentId: "a04", playerId: 9, observation: obs(30), reply: reply({ type: "eat" }) },
    ],
    [
      { t: t + 1000, kind: "action", agentId: "a01", playerId: 2, text: "go (3, 4) -> arrived", data: { action: { type: "go" } } },
      { t: t + 1200, kind: "say", agentId: "a01", playerId: 2, text: "HELLO" },
      { t: t + 1500, kind: "action", agentId: "a09", playerId: 1, text: "eat -> ate", data: {} },
    ],
  );
  const ex = findExampleTurn(dir, cfg())!;
  assert.equal(ex.agentId, "a01");
  assert.equal(ex.t, t);
  assert.equal(ex.age, 24);
  assert.equal(ex.model, "m/x");
  assert.equal(ex.reasoning, "berries are north");
  assert.deepEqual(ex.reply, { thought: "go to the berries", remember: "the spring is north", action: { type: "go", x: 3, y: 4 } });
  assert.deepEqual(ex.results, [{ action: "go (3, 4)", result: "arrived" }]);
  assert.equal(ex.said, "HELLO");
  assert.ok(ex.observation.startsWith("== YOU =="));
  rmSync(dir, { recursive: true, force: true });
});

test("example turn: a wait is used only when nothing else is found; actions lists kept as lists", () => {
  const t = 1_800_000_000_000;
  const list = { thought: "chain", actions: [{ type: "swap", x: 1, y: 1 }, { type: "use", x: 2, y: 1 }] };
  const dir = runDir(
    [
      { t, agentId: "a01", playerId: 2, observation: obs(20), reply: JSON.stringify(list) },
      { t: t + 10, agentId: "a02", playerId: 3, observation: obs(20), reply: reply({ type: "wait", turns: 2 }) },
      { t: t + 9000, agentId: "a01", playerId: 2, observation: obs(20), reply: reply({ type: "eat" }) },
      { t: t + 9000, agentId: "a02", playerId: 3, observation: obs(20), reply: reply({ type: "eat" }) },
    ],
    [
      { t: t + 100, kind: "action", agentId: "a01", playerId: 2, text: "swap (1, 1) -> swap: tile (1,1) A -> B", data: {} },
      { t: t + 200, kind: "action", agentId: "a01", playerId: 2, text: "use (2, 1) -> use at (2,1): nothing happened", data: {} },
    ],
  );
  const ex = findExampleTurn(dir, cfg())!;
  assert.equal(ex.agentId, "a01");
  assert.equal(ex.reply.actions?.length, 2);
  assert.equal(ex.results.length, 2);
  assert.equal(ex.results[0].result, "swap: tile (1,1) A -> B");
  rmSync(dir, { recursive: true, force: true });

  const only = runDir([
    { t, agentId: "a02", playerId: 3, observation: obs(20), reply: reply({ type: "wait", turns: 2 }) },
    { t: t + 9000, agentId: "a02", playerId: 3, observation: obs(20), reply: reply({ type: "eat" }) },
  ]);
  assert.deepEqual(findExampleTurn(only, cfg())!.reply.action, { type: "wait", turns: 2 });
  rmSync(only, { recursive: true, force: true });
});

test("example turn: sanitised and size-capped", () => {
  const t = 1_800_000_000_000;
  const evil = "‮evil​\u0007";
  const big = obs(30, `${evil}\n` + "x".repeat(50_000));
  const dir = runDir(
    [
      {
        t, agentId: "a01", playerId: 2, observation: big, reasoning: "r".repeat(20_000) + evil,
        reply: JSON.stringify({ thought: `t${evil}` + "y".repeat(2000), say: `HI${evil}`, junk: "<script>", action: { type: "go", x: 1, y: 2, evil: "z" } }),
      },
      { t: t + 9000, agentId: "a01", playerId: 2, observation: obs(30), reply: reply({ type: "eat" }) },
    ],
    [{ t: t + 10, kind: "action", agentId: "a01", playerId: 2, text: `go (1, 2) -> ${"q".repeat(5000)}${evil}`, data: {} }],
  );
  const ex = findExampleTurn(dir, cfg())!;
  const all = JSON.stringify(ex);
  assert.ok(!/[‮​\u0007]/.test(all), "no control or invisible characters");
  assert.ok(ex.observation.length <= EXAMPLE_CAPS.observation);
  assert.ok(ex.observation.includes("\n"), "lines kept");
  assert.ok(ex.reasoning!.length <= EXAMPLE_CAPS.reasoning);
  assert.ok(ex.replyText.length <= EXAMPLE_CAPS.replyText);
  assert.ok(ex.reply.thought!.length <= 400);
  assert.equal(ex.reply.say, "HIevil");
  assert.deepEqual(Object.keys(ex.reply).sort(), ["action", "say", "thought"]);
  assert.deepEqual(ex.reply.action, { type: "go", x: 1, y: 2 });
  assert.ok(ex.results[0].result.length <= EXAMPLE_CAPS.result);
  assert.ok(all.length < 20_000, `example is ${all.length} bytes`);
  rmSync(dir, { recursive: true, force: true });
});

test("readTailLines reads only the end and drops the torn first line", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "tail-"));
  const f = path.join(dir, "x.jsonl");
  writeFileSync(f, "");
  for (let i = 0; i < 1000; i++) appendFileSync(f, JSON.stringify({ i }) + "\n");
  const lines = readTailLines(f, 100);
  assert.ok(lines.length > 0 && lines.length < 15);
  assert.deepEqual(JSON.parse(lines.at(-1)!), { i: 999 });
  for (const l of lines) JSON.parse(l);
  assert.deepEqual(readTailLines(path.join(dir, "missing"), 100), []);
  rmSync(dir, { recursive: true, force: true });
});

test("GET /api/agent-spec over HTTP: JSON, cached ~60 s per run, 404s elsewhere untouched", async () => {
  clearAgentSpecCache();
  const t = 1_800_000_000_000;
  const dir = runDir([
    { t, agentId: "a01", playerId: 2, observation: obs(24), reply: reply({ type: "eat" }) },
    { t: t + 9000, agentId: "a01", playerId: 2, observation: obs(24), reply: reply({ type: "eat" }) },
  ], [{ t: t + 10, kind: "action", agentId: "a01", playerId: 2, text: "eat -> ate Gooseberry", data: {} }]);
  let calls = 0;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (!handleAgentSpecApi(url, res, () => (calls++, { dir, runId: "run1" }))) {
      res.statusCode = 404;
      res.end("{}");
    }
  });
  await new Promise<void>((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const r1 = await fetch(`${base}/api/agent-spec`);
  assert.equal(r1.status, 200);
  assert.match(r1.headers.get("content-type") ?? "", /json/);
  const body = (await r1.json()) as AgentSpecResponse;
  assert.equal(body.runId, "run1");
  assert.equal(body.systemPrompt, systemPromptFor(config));
  assert.equal(body.example?.results[0].result, "ate Gooseberry");
  // a newer turn within 60 s is not seen yet (cached)
  appendFileSync(path.join(dir, "llm.jsonl"), JSON.stringify({ t: t + 20000, agentId: "a01", playerId: 2, observation: obs(24), reply: reply({ type: "eat" }) }) + "\n");
  const again = (await (await fetch(`${base}/api/agent-spec`)).json()) as AgentSpecResponse;
  assert.equal(again.now, body.now);
  assert.equal((await fetch(`${base}/api/other`)).status, 404);
  assert.ok(calls >= 2);
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

test("the viewer fixture has the response shape", () => {
  // a snapshot (regenerate with src/tools/agent-spec-fixture.ts); live pages read the endpoint
  const f = path.join(SRC, "../../viewer/fixtures/live1/agent-spec.json");
  let spec: AgentSpecResponse;
  try {
    spec = JSON.parse(readFileSync(f, "utf8"));
  } catch {
    return; // no viewer checkout
  }
  for (const k of ["systemPrompt", "userSuffix", "replyFields", "actions", "validActionTypes", "settings", "limits", "sayLimits", "interventions", "example"]) assert.ok(k in spec, k);
  assert.ok(spec.systemPrompt.length > 1000);
  assert.ok(spec.example && spec.example.observation.length > 100 && spec.example.results.length > 0);
});
