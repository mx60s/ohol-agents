import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventLog, isRotatedLogFile, rotatedFiles, rotatedName } from "./events.ts";

/** "llm.jsonl" rotated generations in a dir, oldest first */
const gens = (dir: string, file = "llm.jsonl") => rotatedFiles(dir, file);

test("raw log files rotate at the size cap to stable stamped names (llm.<stamp>.jsonl), all kept", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "evlog-"));
  try {
    const log = new EventLog(dir, "t", 10_000);
    const rec = (i: number) => ({ i, observation: "x".repeat(900) });
    for (let i = 0; i < 200; i++) log.write("llm.jsonl", rec(i)); // ~180 KB written
    const files = readdirSync(log.dir).sort();
    assert.ok(files.length >= 18, `every generation kept under the total cap (${files.length})`);
    for (const f of files) assert.ok(statSync(path.join(log.dir, f)).size <= 10_000, f);
    for (const f of files) assert.match(f, /^llm(\.\d{8}T\d{6}Z(-\d+)?)?\.jsonl$/, f);
    // oldest first, by stamp (and -k within one second): the records are in order, nothing lost
    const firstI = (f: string) => JSON.parse(readFileSync(path.join(log.dir, f), "utf8").split("\n")[0]).i as number;
    const g = gens(log.dir);
    assert.equal(g.length, files.length - 1);
    assert.equal(firstI(g[0]), 0, "the oldest generation still has the first record");
    for (let k = 1; k < g.length; k++) assert.ok(firstI(g[k]) > firstI(g[k - 1]), `${g[k - 1]} < ${g[k]}`);
    assert.ok(firstI("llm.jsonl") > firstI(g[g.length - 1]), "the live file is the newest");
    // names never change: another rotation leaves the existing ones alone
    const before = new Set(g);
    for (let i = 200; i < 220; i++) log.write("llm.jsonl", rec(i));
    for (const f of before) assert.ok(existsSync(path.join(log.dir, f)), `${f} kept its name`);
    // events.jsonl is a raw file too
    for (let i = 0; i < 100; i++) log.emitEvent("thought", { agentId: "a01", text: "y".repeat(500) });
    assert.ok(statSync(path.join(log.dir, "events.jsonl")).size <= 10_000);
    assert.ok(gens(log.dir, "events.jsonl").length > 0);
    assert.equal(log.recent.length, 100, "in-memory buffer unaffected");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rotatedName / rotatedFiles / isRotatedLogFile: stamped names, legacy .N first (highest oldest)", () => {
  assert.equal(rotatedName("llm.jsonl", new Date("2026-11-18T19:45:12.345Z")), "llm.20261118T194512Z.jsonl");
  const dir = mkdtempSync(path.join(tmpdir(), "evlog-"));
  try {
    for (const f of ["events.jsonl", "events.jsonl.1", "events.jsonl.2", "events.20261118T194512Z-2.jsonl", "events.20261118T194512Z.jsonl", "events.20261117T000000Z.jsonl", "llm.20261118T194512Z.jsonl", "events.jsonl.tmp"])
      writeFileSync(path.join(dir, f), "");
    assert.deepEqual(rotatedFiles(dir, "events.jsonl"), [
      "events.jsonl.2", "events.jsonl.1", "events.20261117T000000Z.jsonl", "events.20261118T194512Z.jsonl", "events.20261118T194512Z-2.jsonl",
    ]);
    assert.deepEqual(rotatedFiles(path.join(dir, "missing"), "events.jsonl"), []);
    assert.ok(isRotatedLogFile("llm.20261118T194512Z.jsonl") && isRotatedLogFile("llm.20261118T194512Z-3.jsonl") && isRotatedLogFile("llm.jsonl.4"));
    assert.ok(!isRotatedLogFile("llm.jsonl") && !isRotatedLogFile("lives.journal.jsonl") && !isRotatedLogFile("positions.jsonl"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("past the total cap (last resort) the oldest rotated files go, but only ones older than 24 h; live files never", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "evlog-"));
  try {
    const old = new EventLog(dir, "old", 10_000, 0, 60_000);
    for (let i = 0; i < 40; i++) old.write("llm.jsonl", { observation: "x".repeat(900) });
    // the older run's rotated files are two days old (copied off-site long ago)
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 3600_000);
    for (const f of gens(old.dir)) utimesSync(path.join(old.dir, f), twoDaysAgo, twoDaysAgo);
    const log = new EventLog(dir, "new", 10_000, 0, 60_000);
    for (let i = 0; i < 100; i++) log.write("llm.jsonl", { observation: "x".repeat(900) });
    assert.ok(existsSync(path.join(old.dir, "llm.jsonl")) && existsSync(path.join(log.dir, "llm.jsonl")), "live files kept");
    assert.equal(gens(old.dir).length, 0, "the older run's old rotated files went");
    // the new run's rotated files are fresh: over the cap, but none is deleted
    assert.ok(gens(log.dir).length >= 9, `fresh rotated files all kept (${gens(log.dir).length})`);
    const all = readdirSync(dir).flatMap((d) => readdirSync(path.join(dir, d)).map((f) => path.join(dir, d, f)));
    const total = all.reduce((s, f) => s + statSync(f).size, 0);
    assert.ok(total > 60_000, "over the cap rather than deleting a file the backup may not have yet");
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
