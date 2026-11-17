// Fixed decision cadence: models with different latencies act at the same pace.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decisionCycleFor, decisionWaitMs, earlyWakeAllowed, MIN_WAKE_GAP_MS } from "./cadence.ts";

const cfg = { decisionCycleMs: 8000, babyDecisionIntervalMs: 15000 };

/** the agent loop's timing: turn = latency + action time, then wait decisionWaitMs */
function decisionsIn(windowMs: number, latencyMs: number, actionMs = 1500) {
  let t = 0;
  let n = 0;
  while (t < windowMs) {
    const start = t;
    n++;
    t += latencyMs + actionMs;
    t += decisionWaitMs(cfg, start, 20, t);
  }
  return n;
}

test("cycle is start-to-start: a 1 s model and a 6 s model make the same number of decisions", () => {
  const fast = decisionsIn(10 * 60_000, 1000);
  const slow = decisionsIn(10 * 60_000, 6000);
  assert.equal(fast, 75);
  assert.equal(slow, 75);
  // slower than the cycle: no extra wait, the next decision starts at once
  assert.equal(decisionWaitMs(cfg, 0, 20, 12_000), 0);
  assert.equal(decisionWaitMs(cfg, 0, 20, 3000), 5000);
});

test("cycle shorter than the latency degrades gracefully: next turn right after the action, no overlap, no backlog", () => {
  const short = { decisionCycleMs: 3000, babyDecisionIntervalMs: 15000 };
  const starts: number[] = [];
  let t = 0;
  while (t < 60_000) {
    const start = t;
    starts.push(start);
    t += 5000 + 1500; // latency 5 s + action 1.5 s, longer than the 3 s cycle
    const wait = decisionWaitMs(short, start, 20, t);
    assert.equal(wait, 0);
    t += wait;
  }
  // one turn at a time, each starting exactly when the previous finished: 60 s / 6.5 s
  assert.equal(starts.length, Math.ceil(60_000 / 6500));
  for (let i = 1; i < starts.length; i++) assert.equal(starts[i] - starts[i - 1], 6500);
});

test("babies keep their own interval", () => {
  assert.equal(decisionCycleFor(cfg, 1.5), 15000);
  assert.equal(decisionCycleFor(cfg, 2), 8000);
  assert.equal(decisionCycleFor(cfg, null), 8000);
  assert.equal(decisionWaitMs(cfg, 0, 0.5, 4000), 11000);
});

test("early wake-ups: only salient events, never within MIN_WAKE_GAP_MS; a closed connection always", () => {
  assert.equal(earlyWakeAllowed("own-baby-born", 0, MIN_WAKE_GAP_MS), true);
  assert.equal(earlyWakeAllowed("own-baby-born", 0, MIN_WAKE_GAP_MS - 1), false);
  assert.equal(earlyWakeAllowed("heard-chatter", 0, 7000), false);
  assert.equal(earlyWakeAllowed("connection", 0, 10), true);
});

test("config: DECISION_CYCLE_MS default 8000, DECISION_INTERVAL_MS is a fallback, decisionIntervalMs follows it", () => {
  const agentsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const read = (env: Record<string, string>) =>
    JSON.parse(
      execFileSync(process.execPath, ["--import", "tsx", "-e", "import('./src/config.ts').then(m => console.log(JSON.stringify([m.config.decisionCycleMs, m.config.decisionIntervalMs])))"], {
        cwd: agentsDir, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env }, encoding: "utf8",
      }).trim().split("\n").at(-1)!,
    );
  assert.deepEqual(read({ DECISION_CYCLE_MS: "", DECISION_INTERVAL_MS: "" }), [8000, 8000]);
  assert.deepEqual(read({ DECISION_CYCLE_MS: "10000", DECISION_INTERVAL_MS: "" }), [10000, 10000]);
  assert.deepEqual(read({ DECISION_CYCLE_MS: "", DECISION_INTERVAL_MS: "9000" }), [9000, 9000]);
});
