// The mild reasoning cap's retry (no LLM): models that burn the budget on reasoning
// (empty reply, finish_reason "length") get one full-budget retry, and are uncapped after two.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cappedDecision, ranOutOfTokens, type CapState } from "./agent.ts";
import type { ChatMessage, ChatOptions, LlmResult } from "./llm.ts";

const cfg = { llmModel: "moonshotai/kimi-k3.1-pro", llmReasoningCap: true, llmReasoningMaxTokens: 300, llmDecisionMaxTokens: 800 };
const OK = '{"thought":"eat","action":{"type":"eat"}}';
const msgs: ChatMessage[] = [{ role: "user", content: "obs" }];

function res(text: string, finishReason: string | null, completionTokens: number, costUsd = 0.01): LlmResult {
  return { text, finishReason, completionTokens, promptTokens: 1000, costUsd, latencyMs: 100, model: cfg.llmModel };
}

/** a fake LLM answering from a script; records each call's options */
function fake(script: LlmResult[]) {
  const calls: (ChatOptions | undefined)[] = [];
  return {
    calls,
    llm: {
      chat: async (_m: ChatMessage[], o?: ChatOptions) => {
        calls.push(o);
        return script.shift() ?? res(OK, "stop", 200);
      },
    },
  };
}

const fresh = (): CapState => ({ uncapped: new Set(), strikes: new Map() });

test("ranOutOfTokens: finish_reason length/max_tokens, or nothing visible after the whole budget", () => {
  assert.ok(ranOutOfTokens(res("", "length", 800), 800));
  assert.ok(ranOutOfTokens(res('{"thought":"cut', "max_tokens", 800), 800));
  assert.ok(ranOutOfTokens(res("", null, 800), 800), "reason not reported");
  assert.ok(ranOutOfTokens(res(" ", "stop", 812), 800));
  assert.ok(!ranOutOfTokens(res("", "stop", 0), 800), "an empty reply that didn't use the budget isn't truncation");
  assert.ok(!ranOutOfTokens(res(OK, "stop", 300), 800));
});

test("an empty reply with finish_reason length is retried once with the full budget and counts a strike", async () => {
  const st = fresh();
  const f = fake([res("", "length", 800, 0.02), res(OK, "stop", 1500, 0.03)]);
  const r = await cappedDecision(f.llm, msgs, cfg, st);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls[0], { maxTokens: 800, extra: { reasoning: { max_tokens: 300 } } }, "first call capped");
  assert.equal(f.calls[1], undefined, "retry: full budget (LLM_MAX_TOKENS), no cap");
  assert.equal(r.text, OK);
  assert.equal(r.costUsd, 0.05, "both calls are paid for");
  assert.equal(r.latencyMs, 200);
  assert.equal(st.strikes.get(cfg.llmModel), 1);
  assert.equal(st.uncapped.size, 0);
});

test("two strikes: the model stays uncapped (announced once); later calls go straight to the full budget", async () => {
  const st = fresh();
  const announced: string[] = [];
  const f = fake([res("", "length", 800), res(OK, "stop", 900), res('{"thought":"I will go to the', "length", 800), res(OK, "stop", 900), res(OK, "stop", 900)]);
  await cappedDecision(f.llm, msgs, cfg, st, (m) => announced.push(m));
  await cappedDecision(f.llm, msgs, cfg, st, (m) => announced.push(m));
  assert.deepEqual(announced, [cfg.llmModel]);
  assert.ok(st.uncapped.has(cfg.llmModel));
  await cappedDecision(f.llm, msgs, cfg, st, (m) => announced.push(m));
  assert.equal(f.calls.length, 5);
  assert.equal(f.calls[4], undefined, "uncapped: one full-budget call");
});

test("no retry for a normal reply, or a cut-off reply whose JSON is still usable", async () => {
  const st = fresh();
  const f = fake([res(OK, "stop", 300), res('{"thought":"eat","action":{"type":"eat"},"note":"the berr', "length", 800)]);
  await cappedDecision(f.llm, msgs, cfg, st);
  const r = await cappedDecision(f.llm, msgs, cfg, st);
  assert.equal(f.calls.length, 2);
  assert.equal(r.finishReason, "length");
  assert.equal(st.strikes.size, 0);
});

test("cap off: a single plain call", async () => {
  const f = fake([res("", "length", 2000)]);
  await cappedDecision(f.llm, msgs, { ...cfg, llmReasoningCap: false }, fresh());
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0], undefined);
});

test("vllm style (self-hosted Qwen): thinking on with thinking_token_budget, no OpenRouter reasoning object", async () => {
  const f = fake([res(OK, "stop", 200)]);
  await cappedDecision(f.llm, msgs, { ...cfg, llmReasoningStyle: "vllm" }, fresh());
  assert.deepEqual(f.calls[0], { maxTokens: 800, extra: { chat_template_kwargs: { enable_thinking: true }, thinking_token_budget: 300 } });
});
