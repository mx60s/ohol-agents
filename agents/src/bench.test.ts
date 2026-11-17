// bench-endpoint against the fake provider; LLM client streaming, routing and reasoning options.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promptsFromLogs, runBench, formatReport } from "./tools/bench-endpoint.ts";
import { startFakeLlm, FAKE_PROVIDER } from "./tools/fake-llm.ts";
import { Llm, requestOptions } from "./agent/llm.ts";
import type { Config } from "./config.ts";

test("bench-endpoint: prompts from llm.jsonl, concurrency cap, latency/TTFT percentiles, throughput, providers", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "bench-"));
  const fake = startFakeLlm({ latencyMs: 120, ttftMs: 40, random: () => 0.3 });
  try {
    const port = await fake.ready;
    const log = path.join(dir, "llm.jsonl");
    writeFileSync(log, [
      JSON.stringify({ observation: "You are EVE HOPE, age 14. Food 9/20.", reply: "{}" }),
      JSON.stringify({ error: "LlmHttpError: HTTP 402" }),
      JSON.stringify({ observation: "You are FAITH, age 2. Food 2/10. STARVING.", reply: "{}" }),
      "{torn",
    ].join("\n"));
    const prompts = promptsFromLogs([log], "SYSTEM");
    assert.equal(prompts.length, 2);
    assert.deepEqual(prompts[0][0], { role: "system", content: "SYSTEM" });
    assert.match(prompts[1][1].content, /^You are FAITH.*\n\nWhat do you do next\? Reply with JSON only\.$/s);

    const { report, calls } = await runBench({ url: `http://127.0.0.1:${port}`, model: "fake/m", prompts, n: 12, concurrency: 3, maxTokens: 300, reasoningEffort: "low", providerSort: "throughput" });
    assert.equal(calls.length, 12);
    assert.equal(report.ok, 12);
    assert.deepEqual(report.errors, {});
    assert.ok(fake.maxInFlight() <= 3, `max in flight ${fake.maxInFlight()}`);
    assert.ok(report.latencyMs.p50! >= 120 && report.latencyMs.p99! < 2000, JSON.stringify(report.latencyMs));
    assert.ok(report.ttftMs.p50! >= 40 && report.ttftMs.p50! < report.latencyMs.p50!, "TTFT measured from the stream, before the full reply");
    assert.ok(report.requestsPerSec > 5, `rps ${report.requestsPerSec}`);
    assert.equal(report.completionTokensMean, 60);
    assert.equal(report.reasoningTokensMean, 40);
    assert.deepEqual(report.providers, { [FAKE_PROVIDER]: 12 });
    // the request carried the per-run settings, streamed
    const b = fake.bodies.at(-1);
    assert.deepEqual([b.stream, b.max_tokens, b.reasoning, b.provider], [true, 300, { effort: "low" }, { sort: "throughput" }]);
    assert.match(formatReport(report), /latency\s+p50/);

    fake.setFail(503);
    const bad = await runBench({ url: `http://127.0.0.1:${port}`, model: "fake/m", prompts, n: 4, concurrency: 2, stream: false });
    assert.deepEqual([bad.report.ok, bad.report.errors], [0, { "503": 4 }]);
  } finally {
    fake.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("LLM client: LLM_STREAM=1 gives the same parsed result plus TTFT and the serving provider", async () => {
  const fake = startFakeLlm({ latencyMs: 100, ttftMs: 30, random: () => 0.3 });
  try {
    const port = await fake.ready;
    const base = { llmBaseUrl: `http://127.0.0.1:${port}`, llmApiKey: "k", llmModel: "m", llmMaxTokens: 50, maxCostUsd: 0 };
    const msgs = [{ role: "user" as const, content: "hi" }];
    const plain = await new Llm(base as unknown as Config).chat(msgs);
    const streamed = await new Llm({ ...base, llmStream: true } as unknown as Config).chat(msgs);
    assert.equal(streamed.text, plain.text);
    assert.equal(streamed.reasoningText, plain.reasoningText);
    assert.deepEqual([streamed.promptTokens, streamed.completionTokens, streamed.reasoningTokens, streamed.cachedTokens], [plain.promptTokens, plain.completionTokens, plain.reasoningTokens, plain.cachedTokens]);
    assert.equal(plain.ttftMs, null);
    assert.ok(streamed.ttftMs! >= 30 && streamed.ttftMs! <= streamed.latencyMs);
    assert.equal(streamed.provider, FAKE_PROVIDER);
    assert.equal(plain.provider, FAKE_PROVIDER);
    assert.equal(fake.bodies.at(-1).stream, true);
    assert.equal(fake.bodies.at(-2).stream, undefined, "not streamed unless LLM_STREAM=1");
  } finally {
    fake.close();
  }
});

test("routing and reasoning options: only when set, overridable per call, not applied to overhead models", async () => {
  assert.deepEqual(requestOptions({}), {});
  assert.deepEqual(requestOptions({ llmReasoningEffort: "off" }), { reasoning: { effort: "none" } });
  assert.deepEqual(requestOptions({ llmProviderSort: "throughput", llmProviderOrder: [] }), { provider: { sort: "throughput" } });
  assert.deepEqual(requestOptions({ llmProviderOrder: ["groq", "cerebras"], llmProviderAllowFallbacks: false }), { provider: { order: ["groq", "cerebras"], allow_fallbacks: false } });
  assert.deepEqual(requestOptions({ llmReasoningEffort: "low" }, { reasoning: { max_tokens: 100 } }), { reasoning: { max_tokens: 100 } });
  assert.deepEqual(requestOptions({ llmReasoningEffort: "low", llmProviderSort: "latency" }, { reasoning: null, provider: null }), {});

  const fake = startFakeLlm({ random: () => 0.3 });
  try {
    const port = await fake.ready;
    const cfg = { llmBaseUrl: `http://127.0.0.1:${port}`, llmApiKey: "k", llmModel: "agents/model", llmMaxTokens: 50, maxCostUsd: 0, llmReasoningEffort: "low", llmProviderSort: "throughput", llmProviderOrder: [] } as unknown as Config;
    const llm = new Llm(cfg);
    await llm.chat([{ role: "user", content: "x" }]);
    assert.deepEqual([fake.bodies.at(-1).reasoning, fake.bodies.at(-1).provider], [{ effort: "low" }, { sort: "throughput" }]);
    await llm.chat([{ role: "user", content: "x" }], { model: "cheap/narrator", json: false });
    assert.deepEqual([fake.bodies.at(-1).reasoning, fake.bodies.at(-1).provider], [undefined, undefined], "narrator/director/story keep defaults");
  } finally {
    fake.close();
  }
});
