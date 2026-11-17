import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventLog } from "./events.ts";

test("raw log files rotate at the size cap, so an always-on run can't fill the disk", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "evlog-"));
  try {
    const log = new EventLog(dir, "t", 10_000);
    const rec = { observation: "x".repeat(900) };
    for (let i = 0; i < 200; i++) log.write("llm.jsonl", rec); // ~180 KB written
    const files = readdirSync(log.dir).sort();
    assert.deepEqual(files, ["llm.jsonl", "llm.jsonl.1"]);
    for (const f of files) assert.ok(statSync(path.join(log.dir, f)).size <= 10_000, f);
    // events.jsonl is a raw file too
    for (let i = 0; i < 100; i++) log.emitEvent("thought", { agentId: "a01", text: "y".repeat(500) });
    assert.ok(statSync(path.join(log.dir, "events.jsonl")).size <= 10_000);
    assert.equal(log.recent.length, 100, "in-memory buffer unaffected");
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
