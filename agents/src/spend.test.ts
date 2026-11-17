import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DAY_MS, SpendLedger } from "./spend.ts";
import { Llm } from "./agent/llm.ts";
import { config } from "./config.ts";

const H = 60 * 60 * 1000;

test("rolling 24h cap: blocks at the cap, resumes when the window has room", () => {
  let now = 1_000_000_000;
  const l = new SpendLedger({ now: () => now });
  const t0 = now;
  l.add(0.4);
  now += H;
  l.add(0.4);
  now += H;
  assert.equal(l.blocked(1), false);
  l.add(0.3);
  assert.equal(l.blocked(1), true);
  assert.equal(l.blocked(0), false, "0 = no cap");
  // dropping the first 0.4 brings the window to 0.7 < 1
  assert.equal(l.resumesAt(1), t0 + DAY_MS);
  now = t0 + DAY_MS - 1;
  assert.equal(l.blocked(1), true);
  now = t0 + DAY_MS;
  assert.equal(l.blocked(1), false);
  assert.ok(Math.abs(l.spent() - 0.7) < 1e-9);
  assert.equal(l.resumesAt(1), null);
});

test("spend survives a restart; old entries are compacted away", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "spend-"));
  try {
    const file = path.join(dir, "spend.jsonl");
    let now = 5_000_000_000;
    const a = new SpendLedger({ file, now: () => now });
    a.load();
    a.add(2);
    now += 20 * H;
    a.add(3);
    now += 1000;
    const b = new SpendLedger({ file, now: () => now });
    b.load();
    assert.equal(b.spent(), 5);
    assert.equal(b.blocked(5), true);
    now += 5 * H; // first entry is now older than 24h
    const c = new SpendLedger({ file, now: () => now });
    c.load();
    assert.equal(c.spent(), 3);
    assert.equal(readFileSync(file, "utf8").trim().split("\n").length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("compaction rewrites atomically: a failed rewrite leaves the ledger intact", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "spend-"));
  try {
    const file = path.join(dir, "spend.jsonl");
    const now = 5_000_000_000;
    const a = new SpendLedger({ file, now: () => now });
    a.add(4);
    a.add(1);
    mkdirSync(`${file}.tmp`); // the temp file can't be written (stands in for a crash / full disk mid-rewrite)
    a.compact();
    const b = new SpendLedger({ file, now: () => now });
    b.load();
    assert.equal(b.spent(), 5, "cap state not reset");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Llm: gate pauses calls without a request; MAX_COST_USD 0 = no per-run cap", async () => {
  let paused: string | null = "daily spend cap";
  const llm = new Llm({ ...config, maxCostUsd: 0, llmBaseUrl: "http://127.0.0.1:1" }, { onCost: () => {}, pausedReason: () => paused });
  llm.totalCost = 1e6;
  assert.equal(llm.overRunBudget, false);
  assert.equal(llm.overBudget, true);
  await assert.rejects(llm.chat([{ role: "user", content: "x" }]), /LLM calls stopped: daily spend cap/);
  paused = null;
  assert.equal(llm.overBudget, false);
  const capped = new Llm({ ...config, maxCostUsd: 10 });
  capped.totalCost = 10;
  assert.equal(capped.overRunBudget, true);
});

test("Llm.addCost (director Jev spend) counts toward the run cap and the shared gate", () => {
  const gated: number[] = [];
  const llm = new Llm({ ...config, maxCostUsd: 0.001 }, { onCost: (u) => gated.push(u), pausedReason: () => null });
  llm.addCost(0.0004);
  llm.addCost(-1);
  llm.addCost(Number.NaN);
  assert.equal(llm.totalCost, 0.0004);
  assert.deepEqual(gated, [0.0004]);
  assert.equal(llm.overBudget, false);
  llm.addCost(0.0007);
  assert.equal(llm.overBudget, true);
});
