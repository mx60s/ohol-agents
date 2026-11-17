// LLM outage pause: a fake provider returning 402 pauses the run, disconnects
// the agents, flags the lives alive during the outage, and the run resumes by
// itself when the provider recovers. No game, no paid calls.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { config, type Config } from "./config.ts";
import { EventLog } from "./events.ts";
import { Population } from "./population.ts";
import { LifeStore } from "./lifestore.ts";
import { LlmHealth } from "./agent/llm.ts";
import type { GameData } from "./game/gameData.ts";

async function fakeProvider() {
  let status = 402;
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits++;
    req.resume();
    req.on("end", () => {
      res.statusCode = status;
      if (status !== 200) return res.end(JSON.stringify({ error: { message: "Insufficient credits", code: status } }));
      res.end(JSON.stringify({ choices: [{ message: { content: "OK" }, finish_reason: "stop" }], usage: { cost: 0, prompt_tokens: 5, completion_tokens: 1 } }));
    });
  });
  server.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    set: (s: number) => (status = s),
    hits: () => hits,
    close: () => (server.closeAllConnections(), server.close()),
  };
}

test("provider down (402) past LLM_OUTAGE_PAUSE_S: paused with a reason, agents disconnected, lives flagged; resumes on recovery", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "outage-"));
  const p = await fakeProvider();
  try {
    let now = 1_800_000_000_000;
    const health = new LlmHealth(() => now);
    const cfg: Config = { ...config, logDir: dir, runId: "o", llmBaseUrl: p.base, llmApiKey: "k", llmModel: "m", narratorIntervalMs: 0, llmOutagePauseMs: 60_000, continuous: true };
    const lives = new LifeStore({ logDir: dir, dims: ["x"], mutationSd: 0.1, traitSource: "mock", now: () => now });
    const log = new EventLog(dir, "o");
    lives.attach(log, "o");
    const pop = new Population(cfg, {} as GameData, log, { llmHealth: health, lives, onOutage: (from, to) => lives.markOutage("o", from, to) });
    pop.started = true; // as if start() ran; no agents log in here

    // three lives: one died long before the outage, one dies during it, one is alive throughout
    const ev = (kind: "birth" | "death", agentId: string, playerId: number, data: Record<string, unknown>) => {
      log.emitEvent(kind, { agentId, playerId, text: kind, data: { playerId, ...data } });
    };
    // EventLog stamps Date.now(); LifeStore reads ev.t, so give the records explicit times instead
    const at = (t: number, fn: () => void) => {
      const real = Date.now;
      Date.now = () => t;
      try {
        fn();
      } finally {
        Date.now = real;
      }
    };
    at(now - 600_000, () => ev("birth", "a01", 1, { eve: true, generation: 1, age: 14 }));
    at(now - 500_000, () => ev("death", "a01", 1, { age: 20, reason: "reason_hunger" }));
    at(now - 400_000, () => ev("birth", "a02", 2, { eve: true, generation: 1, age: 14 }));
    at(now - 300_000, () => ev("birth", "a03", 3, { eve: false, motherId: 2, generation: 2, age: 0 }));

    // fake agents with open connections
    const closed: string[] = [];
    for (const id of ["a02", "a03"]) pop.agents.push({ id, status: "alive", conn: { close: () => closed.push(id) }, stop: () => {}, view: () => ({ agentId: id, status: "alive" }) } as never);

    // the provider starts failing: 402 on every call
    await assert.rejects(pop.llm.chat([{ role: "user", content: "hi" }]));
    const outageStart = now;
    assert.equal(health.outageSince, outageStart);
    at(now + 30_000, () => ev("death", "a03", 3, { age: 0.5, reason: "reason_hunger" }));

    now += 30_000;
    pop.checkOutage(now);
    assert.equal(pop.state().run.status, "running", "not yet past LLM_OUTAGE_PAUSE_S");
    assert.deepEqual(closed, []);

    now += 31_000;
    pop.checkOutage(now);
    const run = pop.state().run;
    assert.equal(run.status, "paused");
    assert.equal(run.pauseKind, "llm-outage");
    assert.match(run.pauseReason!, /LLM provider outage since .*HTTP 402: Insufficient credits/);
    assert.equal(run.resumesAt, health.status().retryAt);
    assert.deepEqual(closed.sort(), ["a02", "a03"], "every agent disconnected");
    assert.ok(log.recent.some((e) => e.kind === "system" && /^paused: LLM provider outage/.test(e.text)));

    const rec = (id: string) => lives.get(id)!;
    assert.equal(rec("o:1").outage, false, "died before the outage");
    assert.equal(rec("o:1").validForStudy, true);
    assert.equal(rec("o:2").outage, true, "alive through the outage");
    assert.equal(rec("o:2").validForStudy, false);
    assert.equal(rec("o:3").validForStudy, false, "died during the outage");
    assert.equal(lives.deaths(10).find((d) => d.lifeId === "o:3")!.validForStudy, false);

    // logins are held while paused
    let loggedIn = false;
    void pop.logins.beforeLogin("a04", true).then(() => (loggedIn = true));
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(loggedIn, false, "no one logs in while paused");

    // still down: the probe at retryAt fails, backoff doubles, still paused
    const hits = p.hits();
    now = health.status().retryAt!;
    pop.checkOutage(now);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(p.hits(), hits + 1, "one probe call");
    assert.equal(pop.state().run.status, "paused");

    // provider recovers: the next probe succeeds and the run resumes
    p.set(200);
    now = health.status().retryAt!;
    pop.checkOutage(now);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(health.status().ok, true);
    pop.checkOutage(now);
    assert.equal(pop.state().run.status, "running");
    assert.equal(pop.state().run.pauseKind, null);
    assert.ok(log.recent.some((e) => e.kind === "system" && /^resumed: LLM provider recovered/.test(e.text)));
    await new Promise((r) => setTimeout(r, 1100));
    assert.equal(loggedIn, true, "logins resume");
    const outages = readFileSync(path.join(log.dir, "outages.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(outages.map((o) => o.event), ["paused", "resumed"]);

    // a life born after the outage is valid
    at(now + 1000, () => ev("birth", "a04", 4, { eve: false, motherId: 2, generation: 2, age: 0 }));
    assert.equal(rec("o:4").validForStudy, true);
    pop.halt("test over");
  } finally {
    p.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("429s and bad requests don't count as an outage; LLM_OUTAGE_PAUSE_S=0 never pauses", async () => {
  let now = 1_000_000;
  const h = new LlmHealth(() => now);
  const { LlmHttpError } = await import("./agent/llm.ts");
  h.failure(new LlmHttpError(429, "slow down"));
  h.failure(new LlmHttpError(400, "bad"));
  assert.equal(h.outageSince, null);
  now += 5000;
  h.failure(new LlmHttpError(503, "down"));
  assert.equal(h.outageSince, now);
  h.success();
  assert.equal(h.outageSince, null);
  h.failure(new Error("timeout"));
  assert.equal(h.outageSince, now, "network errors / timeouts count");

  const dir = mkdtempSync(path.join(tmpdir(), "outage-"));
  try {
    const pop = new Population({ ...config, logDir: dir, runId: "z", narratorIntervalMs: 0, llmOutagePauseMs: 0 }, {} as GameData, new EventLog(dir, "z"), { llmHealth: h });
    pop.started = true;
    pop.checkOutage(now + 3_600_000);
    assert.equal(pop.state().run.status, "running");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
