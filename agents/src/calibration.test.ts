// Calibration scorecard aggregation from synthetic logs (no game, no LLM).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { percentile, scoreRecords, scoreRun, summaryTable } from "./calibration.ts";
import { FakeEvents } from "./test-helpers.ts";

const T0 = 1_700_000_000_000;

function session() {
  const f = new FakeEvents();
  f.t = T0;
  const evs = [
    f.ev("system", null, null, undefined, { text: "run started" }),
    f.eve("a01", 1),
    f.child("a02", 2, 1),
    f.eve("a03", 3),
  ];
  // a02 reconnects to the same body after a pause: not a new life
  evs.push(f.child("a02", 2, 1));
  f.wait(60_000);
  evs.push(f.action("a01", 1, "use (3, 4) -> use: holding Stone -> Sharp Stone", { action: { type: "use" }, heldBefore: "Stone", heldAfter: "Sharp Stone", turnMs: 1200 }));
  evs.push(f.action("a01", 1, "use (3, 5) -> nothing happened", { action: { type: "use" }, turnMs: 3400 }));
  evs.push(f.action("a03", 3, "forage (reflex: starving) -> ate Wild Carrot; food 2 -> 9/20", { reflex: true }));
  f.wait(60_000);
  evs.push(f.ev("craft", "a03", 3, { newActor: "Fire Bow Drill", newTarget: null }, { text: "made Fire Bow Drill" }));
  evs.push(f.child("a04", 4, 3)); // born at ~2 min
  f.wait(60_000);
  evs.push(f.ev("craft", "a03", 3, { newActor: "Burning Tinder", newTarget: "Fire" }, { text: "made Fire from Kindling + Burning Tinder" }));
  evs.push(f.death("a02", 2, 3.4, "reason_hunger")); // baby that made it past 3
  evs.push(f.action("a01", 1, "wear -> wearing Reed Skirt", { action: { type: "wear" }, heldBefore: "Reed Skirt", heldAfter: "nothing" }));
  evs.push(f.child("a05", 5, 1, 2));
  f.wait(30_000);
  evs.push(f.death("a05", 5, 0.5, "reason_hunger"));
  evs.push(f.death("a01", 1, 20, "reason_killed_418"));
  return { evs, f };
}

const llm = [
  { reply: "{}", latencyMs: 1000, promptTokens: 3000, completionTokens: 400, cachedTokens: 1500, reasoningTokens: 350, costUsd: 0.004, provider: "Groq", ttftMs: 300 },
  { reply: "{}", latencyMs: 2000, promptTokens: 3000, completionTokens: 400, cachedTokens: 1500, reasoningTokens: 350, costUsd: 0.004, provider: "Groq", ttftMs: 500 },
  { reply: "{}", latencyMs: 3000, promptTokens: 3000, completionTokens: 400, cachedTokens: 0, reasoningTokens: 350, costUsd: 0.004 },
  { reply: "{}", latencyMs: 10000, promptTokens: 3000, completionTokens: 400, cachedTokens: 0, reasoningTokens: 350, costUsd: 0.004 },
  { error: "Error: no JSON in reply", raw: "I think I will forage" },
  { error: "LlmHttpError: HTTP 402" },
];

test("scorecard: LLM usage, latency, JSON errors, actions, lives, deaths, babies past 3, firsts", () => {
  const { evs } = session();
  const end = T0 + 6 * 60_000;
  const c = scoreRecords(llm, evs, { model: "m", runId: "r", startedAt: T0, endedAt: end, agentCount: 4, timeScale: 1, decisionCycleMs: 8000 });
  assert.equal(c.wallMinutes, 6);
  assert.equal(c.gameYears, 6);
  assert.deepEqual(
    [c.llm.calls, c.llm.callErrors, c.llm.jsonErrors, c.llm.jsonErrorRate, c.llm.promptTokens, c.llm.cachedTokens, c.llm.reasoningTokens, c.llm.cacheHitRate],
    [5, 1, 1, 0.2, 12000, 3000, 1400, 0.25],
  );
  assert.equal(c.llm.costUsd, 0.016);
  assert.equal(c.llm.costPerAgentHourUsd, 0.04); // $0.016 over 4 agents x 0.1 h
  assert.deepEqual([c.llm.latencyMsP50, c.llm.latencyMsP90, c.llm.latencyMsP99], [2000, 10000, 10000]);
  assert.deepEqual([c.llm.ttftMsP50, c.llm.ttftMsP90], [300, 500]);
  assert.deepEqual(c.llm.providers, { Groq: 2 });
  assert.equal(c.llm.reasoningTokensPerCall, 350);
  assert.deepEqual(c.turnMs, { n: 2, p50: 1200, p90: 3400, p99: 3400 });
  assert.equal(c.decisions.perWallMinute, round(5 / 6));
  assert.deepEqual([c.actions.total, c.actions.failed, c.actions.reflex], [4, 1, 1]);
  assert.deepEqual([c.lives.lives, c.lives.eves, c.lives.babies, c.lives.deaths], [5, 2, 3, 3]);
  assert.deepEqual(c.lives.deathsByCause, { hunger: 2, killed_418: 1 });
  assert.equal(c.lives.maxGeneration, 2);
  // a02 died at 3.4 (survived); a05 died at 0.5; a04 born ~2 min before... end-born = ~3.9 min -> alive past 3
  assert.deepEqual([c.lives.babiesSurvivedPast3, c.lives.babiesAtRisk], [2, 3]);
  assert.equal(c.firsts.sharpStone!.what, "Sharp Stone");
  assert.ok(c.firsts.sharpStone!.wallMin > 0.9 && c.firsts.sharpStone!.wallMin < 1.2);
  assert.match(c.firsts.fire!.what, /Fire|Burning Tinder/);
  assert.ok(c.firsts.fire!.wallMin > 2.9, "the Fire Bow Drill doesn't count as fire");
  assert.match(c.firsts.clothing!.what, /Reed Skirt/);
});

test("scorecard at TIME_SCALE 2: per-game-year rates double, babies need twice the wall time to reach 3", () => {
  const { evs } = session();
  const end = T0 + 6 * 60_000;
  const meta = { model: "m", runId: "r", startedAt: T0, endedAt: end, agentCount: 4, decisionCycleMs: 8000 };
  const c1 = scoreRecords(llm, evs, { ...meta, timeScale: 1 });
  const c2 = scoreRecords(llm, evs, { ...meta, timeScale: 2 });
  assert.equal(c2.timeScale, 2);
  assert.equal(c2.gameYears, 3);
  assert.equal(c2.lives.perWallMinute.deaths, c1.lives.perWallMinute.deaths);
  assert.ok(Math.abs(c2.lives.perGameYear.deaths - c1.lives.perGameYear.deaths * 2) < 0.01);
  assert.ok(Math.abs(c2.decisions.perGameYear - c1.decisions.perGameYear * 2) < 0.01);
  // a04 is ~1.9 game years old at the end: unknown fate, not at risk yet
  assert.deepEqual([c2.lives.babiesSurvivedPast3, c2.lives.babiesAtRisk], [1, 2]);
  assert.ok(Math.abs(c2.firsts.fire!.gameYears - c1.firsts.fire!.gameYears / 2) < 0.01);
});

test("scoreRun reads the run dir (incl. a rotated .1 file); summary table has one row per card", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cal-"));
  try {
    const { evs } = session();
    writeFileSync(path.join(dir, "llm.jsonl.1"), llm.slice(0, 2).map((r) => JSON.stringify(r)).join("\n") + "\n");
    writeFileSync(path.join(dir, "llm.jsonl"), llm.slice(2).map((r) => JSON.stringify(r)).join("\n") + "\n{torn");
    writeFileSync(path.join(dir, "events.jsonl"), evs.map((e) => JSON.stringify(e)).join("\n") + "\n");
    const meta = { runId: "r", startedAt: T0, endedAt: T0 + 360_000, agentCount: 4, timeScale: 1, decisionCycleMs: 8000 };
    const a = scoreRun(dir, { ...meta, model: "google/gemini-3.8-flash", settings: { reasoningEffort: "low", maxTokens: 600, providerSort: "throughput", stream: true } });
    assert.deepEqual(a.settings, { reasoningEffort: "low", maxTokens: 600, providerSort: "throughput", providerOrder: [], allowFallbacks: null, stream: true });
    assert.equal(a.llm.calls, 5);
    const b = { ...a, model: "deepseek/deepseek-v4-flash", timeScale: 3 };
    const md = summaryTable([a, b]);
    const lines = md.trim().split("\n");
    assert.equal(lines.length, 4);
    assert.match(lines[0], /^\| model \| reasoning \| max tok \| provider pref \| served by \| time scale \| cycle s/);
    assert.match(lines[2], /^\| google\/gemini-3.8-flash \| low \| 600 \| throughput \| Groq 2 \| 1 \| 8 \|/);
    assert.match(lines[2], /\| 1.2\/3.4\/3.4 \|/, "turn time p50/p90/p99");
    assert.match(lines[3], /deepseek\/deepseek-v4-flash \| low \| 600 \| throughput \| Groq 2 \| 3 \|/);
    assert.match(lines[2], /\| 2\/3 \|/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scorecard: empty and cut-off replies are failed decisions, reported separately (Kimi: 0% JSON errors, 18% wasted)", () => {
  const ok = '{"thought":"eat","action":{"type":"eat"}}';
  const lines = [
    { reply: ok, finishReason: "stop", completionTokens: 300 },
    { reply: ok, finishReason: "stop", completionTokens: 300 },
    { reply: "", finishReason: "length", completionTokens: 2000, reasoningTokens: 2000 }, // reasoning ate the budget
    { reply: "  ", finishReason: "length", completionTokens: 800 },
    { reply: '{"thought":"I need the berries before the', finishReason: "length", completionTokens: 800 }, // cut, unusable
    { reply: '{"thought":"eat","action":{"type":"eat"},"note":"the berr', finishReason: "length", completionTokens: 800 }, // cut, still usable
    { reply: "I will forage now.", finishReason: "stop", completionTokens: 20 }, // plain JSON error
    { error: "Error: no JSON in reply", raw: "legacy line" }, // older log format
    { error: "LlmHttpError: HTTP 502" }, // call error, not a reply
  ];
  const c = scoreRecords(lines, [], { model: "m", runId: "r", startedAt: T0, endedAt: T0 + 60_000, agentCount: 1, timeScale: 1, decisionCycleMs: 8000 });
  assert.equal(c.llm.calls, 8);
  assert.equal(c.llm.callErrors, 1);
  assert.deepEqual(
    { empty: c.llm.emptyReplies, cut: c.llm.truncatedReplies, usable: c.llm.truncatedButUsable, json: c.llm.jsonErrors, failed: c.llm.failedReplies },
    { empty: 2, cut: 1, usable: 1, json: 2, failed: 5 },
  );
  assert.equal(c.llm.failedReplyRate, 0.625);
  assert.match(summaryTable([c]), /\| 62\.5% \(2\/1\/2\) \|/);
});

test("percentile", () => {
  assert.equal(percentile([], 50), null);
  assert.equal(percentile([5], 90), 5);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90), 9);
});

function round(x: number) {
  return Math.round(x * 1000) / 1000;
}
