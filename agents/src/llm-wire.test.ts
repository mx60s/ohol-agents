// Request/response format against a local fake provider (no paid calls):
// prompt-cache breakpoints, cached/reasoning token counts, reasoning capture.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Llm, llmLogFields, needsExplicitCache, reasoningOf, wireMessages, REASONING_LOG_MAX_CHARS } from "./agent/llm.ts";
import type { Config } from "./config.ts";

async function fakeProvider(reply: (body: any) => unknown) {
  const bodies: any[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw);
      bodies.push(body);
      res.end(JSON.stringify(reply(body)));
    });
  });
  server.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, bodies, close: () => (server.closeAllConnections(), server.close()) };
}

const cfg = (base: string, over: Partial<Config> = {}) =>
  ({ llmBaseUrl: base, llmApiKey: "k", llmModel: "google/gemini-3.8-flash", llmMaxTokens: 10, maxCostUsd: 0, ...over }) as unknown as Config;
const SYSTEM = "You are a character in One Hour One Life. ".repeat(50);
const msgs = [
  { role: "system" as const, content: SYSTEM },
  { role: "user" as const, content: "observation 17" },
];

const fullReply = {
  model: "google/gemini-3.8-flash",
  choices: [{ message: { content: '{"action":{"type":"wait"}}', reasoning: "I am hungry. The berry bush is 3 tiles east." }, finish_reason: "stop" }],
  usage: {
    prompt_tokens: 3000, completion_tokens: 500, cost: 0.004,
    prompt_tokens_details: { cached_tokens: 1200, cache_write_tokens: 0 },
    completion_tokens_details: { reasoning_tokens: 450 },
  },
};

test("Gemini/Claude: the static system prompt gets a cache_control breakpoint; the dynamic observation doesn't", async () => {
  const p = await fakeProvider(() => fullReply);
  try {
    for (const model of ["google/gemini-3.8-flash", "anthropic/claude-haiku-5.5"]) {
      await new Llm(cfg(p.base, { llmModel: model })).chat(msgs);
      const sent = p.bodies.at(-1).messages;
      assert.deepEqual(sent[0], { role: "system", content: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }] });
      assert.deepEqual(sent[1], { role: "user", content: "observation 17" }, "observation stays a plain string");
    }
  } finally {
    p.close();
  }
});

test("implicitly-caching models and LLM_PROMPT_CACHE=0 get plain string messages (unchanged request)", async () => {
  const p = await fakeProvider(() => fullReply);
  try {
    await new Llm(cfg(p.base, { llmModel: "deepseek/deepseek-v4-flash" })).chat(msgs);
    assert.deepEqual(p.bodies.at(-1).messages, msgs);
    await new Llm(cfg(p.base, { llmPromptCache: false })).chat(msgs);
    assert.deepEqual(p.bodies.at(-1).messages, msgs);
  } finally {
    p.close();
  }
  assert.equal(needsExplicitCache("openai/gpt-oss-120b"), false);
  assert.equal(needsExplicitCache("~anthropic/claude-sonnet-latest"), true);
  // explicit cache flag: the last cacheable message wins (Gemini uses only the last breakpoint)
  const w = wireMessages([{ role: "system", content: "a" }, { role: "user", content: "static", cache: true }, { role: "user", content: "dyn" }], "google/gemini-3.8-flash", true) as any[];
  assert.equal(typeof w[0].content, "string");
  assert.ok(Array.isArray(w[1].content));
  assert.equal(typeof w[2].content, "string");
});

test("cached, cache-write and reasoning tokens and the reasoning text are captured; the reply text is parsed as before", async () => {
  const p = await fakeProvider(() => fullReply);
  try {
    const r = await new Llm(cfg(p.base)).chat(msgs);
    assert.equal(r.text, '{"action":{"type":"wait"}}');
    assert.equal(r.cachedTokens, 1200);
    assert.equal(r.cacheWriteTokens, 0);
    assert.equal(r.reasoningTokens, 450);
    assert.equal(r.reasoningText, "I am hungry. The berry bush is 3 tiles east.");
    const body = p.bodies.at(-1);
    assert.equal(body.reasoning, undefined, "capture never adds reasoning params to the request");
    assert.equal(body.include_reasoning, undefined);
    const line = llmLogFields(r);
    assert.equal(line.reasoning, r.reasoningText);
    assert.deepEqual([line.cachedTokens, line.reasoningTokens, line.promptTokens, line.completionTokens], [1200, 450, 3000, 500]);

    // capture off: same request, no reasoning text
    const before = JSON.stringify(p.bodies.at(-1));
    const off = await new Llm(cfg(p.base, { llmCaptureReasoning: false })).chat(msgs);
    assert.equal(JSON.stringify(p.bodies.at(-1)), before);
    assert.equal(off.reasoningText, null);
    assert.equal(off.text, r.text);
    assert.equal("reasoning" in llmLogFields(off), false);
  } finally {
    p.close();
  }
});

test("reasoning from reasoning_details, missing usage details, and the llm.jsonl cap", async () => {
  assert.equal(
    reasoningOf({ content: "x", reasoning_details: [{ type: "reasoning.encrypted", data: "zz" }, { type: "reasoning.summary", summary: "plan" }, { type: "reasoning.text", text: "step" }] }),
    "plan\nstep",
  );
  assert.equal(reasoningOf({ content: "x" }), null);
  assert.equal(reasoningOf({ content: "x", reasoning: "   " }), null);
  assert.equal(reasoningOf({ content: "x", reasoning_content: "vllm thought" }), "vllm thought", "vLLM's reasoning parser field");
  const p = await fakeProvider(() => ({ choices: [{ message: { content: "{}", reasoning: "r".repeat(20_000) } }], usage: { cost: 0 } }));
  try {
    const r = await new Llm(cfg(p.base)).chat(msgs);
    assert.equal(r.cachedTokens, 0);
    assert.equal(r.reasoningTokens, 0);
    assert.equal(llmLogFields(r).reasoning!.length, REASONING_LOG_MAX_CHARS);
  } finally {
    p.close();
  }
});
