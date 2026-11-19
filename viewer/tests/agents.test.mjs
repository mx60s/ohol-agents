// How agents work (agents.html): the /api/agent-spec normaliser against the live1 fixture and junk.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { normAgentSpec } from "../src/data/normalize.ts";
import { pageHref } from "../src/data/config.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(fs.readFileSync(path.join(HERE, "..", "fixtures", "live1", "agent-spec.json"), "utf8"));

test("normAgentSpec keeps the live1 fixture intact", () => {
  const s = normAgentSpec(fixture);
  assert.ok(s);
  assert.equal(s.systemPrompt, fixture.systemPrompt);
  assert.deepEqual(s.actions, fixture.actions);
  assert.deepEqual(s.interventions, fixture.interventions);
  assert.deepEqual(s.settings, fixture.settings);
  assert.deepEqual(s.limits, fixture.limits);
  assert.deepEqual(s.example, fixture.example);
  assert.deepEqual(s.replyFields, fixture.replyFields);
  assert.deepEqual(s.noteHeadings, fixture.noteHeadings);
  assert.ok(s.replyFields.some((f) => f.name === "remember"));
  assert.ok(s.actions.find((a) => a.type === "search")?.note);
  assert.equal(s.settings.turnClock, true);
});

test("normAgentSpec: not a spec -> null; bad fields dropped or defaulted", () => {
  assert.equal(normAgentSpec(null), null);
  assert.equal(normAgentSpec("<!doctype html>"), null);
  assert.equal(normAgentSpec({ error: "not found" }), null);
  const s = normAgentSpec({
    systemPrompt: "p",
    actions: [{ type: "go", fields: ["x", 3] }, { nope: 1 }],
    interventions: [{ name: "x", category: "made-up", on: true }, { id: "a", name: "A", category: "wiki", on: "yes" }],
    settings: { timeScale: "fast", decisionCycleMs: 4000, foodBonus: { value: "1", source: "elsewhere" } },
    example: { observation: "== YOU ==", reply: { thought: 3, action: { type: "eat" } }, results: [null, { action: "eat", result: "ate" }] },
  });
  assert.deepEqual(s.actions, [{ type: "go", template: "", fields: ["x"], meaning: "" }]);
  assert.deepEqual(s.interventions, [{ id: "a", name: "A", category: "wiki", on: null, detail: "" }]);
  assert.equal(s.settings.timeScale, 1);
  assert.equal(s.settings.decisionCycleMs, 4000);
  assert.deepEqual(s.settings.foodBonus, { value: "1", source: "unknown" });
  assert.deepEqual(s.example.reply, { action: { type: "eat" } });
  assert.deepEqual(s.example.results, [{ action: "eat", result: "ate" }]);
  assert.equal(normAgentSpec({ systemPrompt: "p", example: { reply: {} } }).example, null);
});

test("the page has a site link", () => {
  assert.match(pageHref("agents"), /^agents\.html/);
});
