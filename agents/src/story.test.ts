import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { StoryKeeper } from "./story.ts";
import type { ChatLlm } from "./director.ts";
import type { RunEvent } from "./api-types.ts";
import type { ChatMessage, LlmResult } from "./agent/llm.ts";

class FakeLlm implements ChatLlm {
  overBudget = false;
  calls: ChatMessage[][] = [];
  replies: string[] = [];
  async chat(messages: ChatMessage[]): Promise<LlmResult> {
    this.calls.push(messages);
    return { text: this.replies.shift() ?? "Nothing much.", promptTokens: 0, completionTokens: 0, costUsd: 0.001, latencyMs: 1, model: "fake", finishReason: "stop" };
  }
}

function setup(dir: string, llm = new FakeLlm(), canSpend = { v: true }) {
  const clock = { t: 5_000_000 };
  let seq = 0;
  const k = new StoryKeeper(
    { llm: () => llm, canSpend: () => canSpend.v, runId: () => "test-r1", now: () => clock.t },
    { intervalMs: 300_000, logDir: dir },
  );
  const ev = (kind: RunEvent["kind"], text: string, data?: Record<string, unknown>, name: string | null = null) =>
    k.observe({ seq: ++seq, t: clock.t, kind, agentId: "a01", playerId: 1, name, text, data });
  return { k, llm, clock, ev, canSpend };
}

const tmp = () => mkdtempSync(path.join(tmpdir(), "story-test-"));

test("idle: no call when nothing happened", async () => {
  const dir = tmp();
  const s = setup(dir);
  assert.equal(await s.k.tick(), "idle");
  // focus/thought/say alone don't count as history
  s.ev("focus", "Following Ada");
  s.ev("thought", "hmm");
  s.ev("say", "HELLO");
  s.ev("system", "run started: 4 agents");
  assert.equal(await s.k.tick(), "idle");
  assert.equal(s.llm.calls.length, 0);
  assert.equal(s.k.current(), null);
  rmSync(dir, { recursive: true });
});

test("refresh: uses previous summary + new events, then goes idle", async () => {
  const dir = tmp();
  const s = setup(dir);
  s.ev("birth", "a01 appeared as an Eve", { eve: true });
  s.ev("narration", "Eve Hope has discovered the berry.");
  s.ev("death", "EVE HOPE died at age 31.0 (hunger)", {}, "EVE HOPE");
  s.ev("action", "use (1, 2) -> use: tile (1,2) Round Stone -> nothing; holding Round Stone -> Sharp Stone", {}, "EVE HOPE");
  s.llm.replies.push("In the beginning there was Eve Hope, and a berry.");
  assert.equal(await s.k.tick(), "updated");
  const input = s.llm.calls[0][1].content;
  assert.match(input, /no previous summary/);
  assert.match(input, /NARRATION: Eve Hope has discovered the berry/);
  assert.match(input, /DEATH: EVE HOPE died/);
  assert.match(input, /FIRST: "EVE HOPE" got "Sharp Stone"/);
  assert.deepEqual(s.k.current(), { text: "In the beginning there was Eve Hope, and a berry.", updatedAt: 5_000_000 });

  assert.equal(await s.k.tick(), "idle");
  assert.equal(s.llm.calls.length, 1);

  s.clock.t += 300_000;
  s.ev("narration", "Things continue.");
  s.llm.replies.push("Then things continued.");
  assert.equal(await s.k.tick(), "updated");
  const input2 = s.llm.calls[1][1].content;
  assert.match(input2, /Your previous summary:\nIn the beginning there was Eve Hope, and a berry\./);
  assert.ok(!input2.includes("DEATH"), "old events not resent");
  assert.deepEqual(s.k.history(10).map((v) => v.text), ["Then things continued.", "In the beginning there was Eve Hope, and a berry."]);
  rmSync(dir, { recursive: true });
});

test("no spending allowed: skipped, events kept for later", async () => {
  const dir = tmp();
  const s = setup(dir, new FakeLlm(), { v: false });
  s.ev("narration", "Something.");
  assert.equal(await s.k.tick(), "skipped");
  assert.equal(s.llm.calls.length, 0);
  s.canSpend.v = true;
  assert.equal(await s.k.tick(), "updated");
  rmSync(dir, { recursive: true });
});

test("output is sanitized and capped at 80 words", async () => {
  const dir = tmp();
  const s = setup(dir);
  s.ev("narration", "x");
  s.llm.replies.push("## Title\u0007\n" + "word ".repeat(400) + " see https://evil.example/x");
  await s.k.tick();
  const t = s.k.current()!.text;
  assert.ok(t.split(/\s+/).length <= 80, String(t.split(/\s+/).length));
  assert.ok(!/[\u0000-\u001f#]|https?:/.test(t), t);
  rmSync(dir, { recursive: true });
});

test("persistence: a new keeper on the same LOG_DIR reloads the story and history", async () => {
  const dir = tmp();
  const s = setup(dir);
  s.ev("narration", "one");
  s.llm.replies.push("Version one.");
  await s.k.tick();
  s.clock.t += 1000;
  s.ev("narration", "two");
  s.llm.replies.push("Version two.");
  await s.k.tick();
  appendFileSync(path.join(dir, "story.jsonl"), '{"text":"torn'); // crash mid-write

  const lines = readFileSync(path.join(dir, "story.jsonl"), "utf8").trim().split("\n");
  assert.equal(lines.length, 3);

  const s2 = setup(dir);
  assert.deepEqual(s2.k.current(), { text: "Version two.", updatedAt: 5_001_000 });
  assert.deepEqual(s2.k.history(1), [{ text: "Version two.", updatedAt: 5_001_000, runId: "test-r1" }]);
  assert.equal(s2.k.history().length, 2);
  // the next refresh continues from the reloaded summary
  s2.ev("narration", "three");
  await s2.k.tick();
  assert.match(s2.llm.calls[0][1].content, /Your previous summary:\nVersion two\./);
  rmSync(dir, { recursive: true });
});

test("story.jsonl is compacted on load instead of growing forever", () => {
  const dir = tmp();
  const file = path.join(dir, "story.jsonl");
  for (let i = 0; i < 1000; i++) appendFileSync(file, JSON.stringify({ text: `Version ${i}.`, updatedAt: i, runId: "r", costUsd: 0.001 }) + "\n");
  const s = setup(dir);
  assert.equal(s.k.current()!.text, "Version 999.");
  const lines = readFileSync(file, "utf8").trim().split("\n");
  assert.equal(lines.length, 200);
  assert.equal(JSON.parse(lines[0]).text, "Version 800.");
  assert.equal(JSON.parse(lines[0]).costUsd, 0.001, "raw lines kept as written");
  assert.equal(setup(dir).k.history(200).length, 200);
  rmSync(dir, { recursive: true });
});
