import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventLog } from "./events.ts";

test("raw log files rotate at the size cap, keeping older generations (.1 newest) until the total cap", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "evlog-"));
  try {
    const log = new EventLog(dir, "t", 10_000);
    const rec = (i: number) => ({ i, observation: "x".repeat(900) });
    for (let i = 0; i < 200; i++) log.write("llm.jsonl", rec(i)); // ~180 KB written
    const files = readdirSync(log.dir).sort();
    assert.ok(files.length >= 18, `every generation kept under the total cap (${files.length})`);
    for (const f of files) assert.ok(statSync(path.join(log.dir, f)).size <= 10_000, f);
    // .1 is the newest previous generation, higher numbers older: nothing lost
    const firstI = (f: string) => JSON.parse(readFileSync(path.join(log.dir, f), "utf8").split("\n")[0]).i as number;
    assert.ok(firstI("llm.jsonl.1") > firstI("llm.jsonl.2") && firstI("llm.jsonl.2") > firstI("llm.jsonl.3"));
    const n = files.filter((f) => /\.\d+$/.test(f)).length;
    assert.equal(firstI(`llm.jsonl.${n}`), 0, "the oldest generation still has the first record");
    // events.jsonl is a raw file too
    for (let i = 0; i < 100; i++) log.emitEvent("thought", { agentId: "a01", text: "y".repeat(500) });
    assert.ok(statSync(path.join(log.dir, "events.jsonl")).size <= 10_000);
    assert.equal(log.recent.length, 100, "in-memory buffer unaffected");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("past the total cap (all run dirs together) the oldest rotated files are deleted, live files never", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "evlog-"));
  try {
    const old = new EventLog(dir, "old", 10_000, 0, 60_000);
    for (let i = 0; i < 40; i++) old.write("llm.jsonl", { observation: "x".repeat(900) });
    const log = new EventLog(dir, "new", 10_000, 0, 60_000);
    for (let i = 0; i < 100; i++) log.write("llm.jsonl", { observation: "x".repeat(900) });
    const all = readdirSync(dir).flatMap((d) => readdirSync(path.join(dir, d)).map((f) => path.join(dir, d, f)));
    const total = all.reduce((s, f) => s + statSync(f).size, 0);
    assert.ok(total <= 60_000 + 10_000, `under the cap, give or take the live file (${total})`);
    assert.ok(existsSync(path.join(old.dir, "llm.jsonl")) && existsSync(path.join(log.dir, "llm.jsonl")), "live files kept");
    assert.ok(existsSync(path.join(log.dir, "llm.jsonl.1")), "the newest generation kept");
    assert.ok(!readdirSync(old.dir).some((f) => /\.\d+$/.test(f)), "the older run's rotated files went first");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a throwing listener neither skips the others nor escapes to the emitter (e.g. from a timer)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "evlog-"));
  try {
    const log = new EventLog(dir, "t");
    const seen: number[] = [];
    log.on("event", () => {
      throw new Error("boom");
    });
    log.on("event", (e) => seen.push(e.seq));
    assert.doesNotThrow(() => log.emitEvent("system", { text: "x" }));
    assert.deepEqual(seen, [1]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rotation off (0) keeps appending", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "evlog-"));
  try {
    const log = new EventLog(dir, "t", 0);
    for (let i = 0; i < 50; i++) log.write("a.jsonl", { x: "z".repeat(1000) });
    assert.deepEqual(readdirSync(log.dir), ["a.jsonl"]);
    assert.ok(statSync(path.join(log.dir, "a.jsonl")).size > 50_000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
