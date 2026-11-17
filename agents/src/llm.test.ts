// LLM client failure handling against a local fake provider (no paid calls).
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Llm, LlmHealth, LlmHttpError } from "./agent/llm.ts";
import type { Config } from "./config.ts";

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

async function fakeProvider(handler: Handler) {
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits++;
    req.resume();
    req.on("end", () => handler(req, res));
  });
  server.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, hits: () => hits, close: () => (server.closeAllConnections(), server.close()) };
}

const cfg = (base: string) => ({ llmBaseUrl: base, llmApiKey: "k", llmModel: "m", llmMaxTokens: 10, maxCostUsd: 0 }) as unknown as Config;
const ok = (res: http.ServerResponse) => res.end(JSON.stringify({ choices: [{ message: { content: "{}" }, finish_reason: "stop" }], usage: { cost: 0 } }));
const msgs = [{ role: "user" as const, content: "hi" }];

test("402 (out of credits): no retries, visible status, backoff, then a single probe", async () => {
  let fail = true;
  const p = await fakeProvider((_req, res) => {
    if (!fail) return ok(res);
    res.statusCode = 402;
    res.end(JSON.stringify({ error: { message: "Insufficient credits. Add more using https://openrouter.ai/settings/credits", code: 402 } }));
  });
  let now = 1_000_000;
  const health = new LlmHealth(() => now);
  const llm = new Llm(cfg(p.base), undefined, health);
  try {
    await assert.rejects(llm.chat(msgs), (e) => e instanceof LlmHttpError && e.status === 402);
    assert.equal(p.hits(), 1, "a 402 is not retried");
    const s = health.status();
    assert.equal(s.ok, false);
    assert.equal(s.consecutiveFailures, 1);
    assert.equal(s.since, 1_000_000);
    assert.match(s.lastError!, /^HTTP 402: Insufficient credits/);
    assert.ok(!s.lastError!.includes("http"), "no links in the viewer-facing error");
    assert.equal(s.retryAt, now + 60_000);
    assert.equal(llm.overBudget, true, "callers see they must not call");

    // while backing off: no request reaches the provider
    await assert.rejects(llm.chat(msgs), /backing off/);
    assert.equal(p.hits(), 1);

    // backoff doubles on the next failed probe
    now += 60_000;
    assert.equal(llm.overBudget, false);
    await assert.rejects(llm.chat(msgs));
    assert.equal(health.status().retryAt, now + 120_000);
    assert.equal(health.status().since, 1_000_000, "since = when the outage began");

    // recovery
    now += 120_000;
    fail = false;
    await llm.chat(msgs);
    const r = health.status();
    assert.equal(r.ok, true);
    assert.equal(r.consecutiveFailures, 0);
    assert.equal(r.retryAt, null);
    assert.equal(r.since, now);
  } finally {
    p.close();
  }
});

test("while a probe is in flight, other callers wait instead of piling on", async () => {
  let release: () => void = () => {};
  const p = await fakeProvider((_req, res) => {
    release = () => ok(res);
  });
  let now = 0;
  const health = new LlmHealth(() => now);
  health.failure(new LlmHttpError(503, "down"));
  now = 10_000;
  const llm = new Llm(cfg(p.base), undefined, health);
  try {
    const probe = llm.chat(msgs);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(llm.overBudget, true);
    await assert.rejects(llm.chat(msgs), /backing off/);
    release();
    await probe;
    assert.equal(health.status().ok, true);
    assert.equal(p.hits(), 1);
  } finally {
    p.close();
  }
});

test("5xx is retried within the call; 429 honours Retry-After", async () => {
  let mode = "500";
  const p = await fakeProvider((_req, res) => {
    res.statusCode = mode === "500" ? 500 : 429;
    if (mode === "429") res.setHeader("retry-after", "42");
    res.end("{}");
  });
  let now = 0;
  const health = new LlmHealth(() => now);
  const llm = new Llm(cfg(p.base), undefined, health);
  try {
    await assert.rejects(llm.chat(msgs));
    assert.equal(p.hits(), 3, "transient errors get 3 attempts");
    assert.equal(health.status().retryAt, 2000);
    now = 2000;
    mode = "429";
    await assert.rejects(llm.chat(msgs));
    assert.equal(p.hits(), 4, "429 isn't retried in-call");
    assert.equal(health.status().retryAt, 2000 + 42_000);
  } finally {
    p.close();
  }
});

test("a response body that stalls times out instead of hanging the caller forever", async () => {
  const p = await fakeProvider((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.write('{"choices": [');
    // never finishes
  });
  const health = new LlmHealth();
  const llm = new Llm(cfg(p.base), undefined, health, 200);
  try {
    const t0 = Date.now();
    await assert.rejects(llm.chat(msgs));
    assert.ok(Date.now() - t0 < 5000);
    assert.equal(health.status().lastError, "timed out");
  } finally {
    p.close();
  }
});
