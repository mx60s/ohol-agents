import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Digest, FieldNotes, MAX_INPUT_CHARS, buildInput, cleanNote, failureOf, loadNotes, readRunEvents } from "./fieldnotes.ts";
import type { ChatLlm } from "./director.ts";
import type { AgentView, RunEvent } from "./api-types.ts";
import type { ChatMessage, LlmResult } from "./agent/llm.ts";

const MIN = 60_000;
const INTERVAL = 20 * MIN;
const T0 = 1_700_000_000_000; // before the test files' mtimes (readRunEvents skips files last written before a window)
const RUN = "pilot1-r9-abc";

class FakeLlm implements ChatLlm {
  overBudget = false;
  calls: ChatMessage[][] = [];
  fail = false;
  async chat(messages: ChatMessage[]): Promise<LlmResult> {
    this.calls.push(messages);
    if (this.fail) throw new Error("provider down");
    return { text: "The ROSE family gathered berries.\n\n- EVE ROSE spoke most.", promptTokens: 0, completionTokens: 0, costUsd: 0.001, latencyMs: 1, model: "fake/model", finishReason: "stop" };
  }
}

const alive = (name: string, agentId = "a01"): AgentView => ({ agentId, name, status: "alive", age: 20, generation: 1, female: true }) as AgentView;

let seq = 0;
const ev = (t: number, kind: RunEvent["kind"], text: string, extra: Partial<RunEvent> = {}): RunEvent => ({ seq: ++seq, t, kind, agentId: "a01", playerId: 1, name: "EVE ROSE", text, ...extra });

function writeEvents(dir: string, file: string, events: RunEvent[]) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, file), events.map((e) => JSON.stringify(e) + "\n").join(""));
}

function setup(logDir: string, o: { startedAt?: number | null; runDir?: string } = {}) {
  const clock = { t: T0 };
  const llm = new FakeLlm();
  const state = { canSpend: true, agents: [alive("EVE ROSE")], runId: RUN as string | null };
  const runDir = o.runDir ?? path.join(logDir, `${RUN}-2026-11-18T10-00-00-000Z`);
  const fn = new FieldNotes(
    {
      llm: () => llm,
      canSpend: () => state.canSpend,
      runId: () => state.runId,
      runStartedAt: () => (o.startedAt === undefined ? T0 : o.startedAt),
      runDir: () => runDir,
      agents: () => state.agents,
      now: () => clock.t,
    },
    { intervalMs: INTERVAL, quietHours: "", model: "fake/model", logDir },
  );
  return { fn, llm, clock, state, runDir };
}

const tmp = () => mkdtempSync(path.join(tmpdir(), "fieldnotes-test-"));

test("schedule: not due before 20 min; the first note covers the run from its start, across log dirs and rotated files", async () => {
  const logDir = tmp();
  // two earlier dirs of the same run (hot updates), one rotated file; another run's dir is ignored
  const d1 = path.join(logDir, `${RUN}-2026-11-18T08-00-00-000Z`);
  const d2 = path.join(logDir, `${RUN}-2026-11-18T09-00-00-000Z`);
  writeEvents(d1, "events.jsonl.1", [ev(T0 + 1 * MIN, "say", "OLDEST LINE")]);
  writeEvents(d1, "events.jsonl", [ev(T0 + 2 * MIN, "birth", "born", { data: { motherId: null, eve: true, generation: 1 } })]);
  writeEvents(d2, "events.jsonl", [ev(T0 + 70 * MIN, "thought", "I should build a fire.")]);
  writeEvents(path.join(logDir, "pilot1-r8-zzz-2026-11-17T00-00-00-000Z"), "events.jsonl", [ev(T0 + 3 * MIN, "say", "OTHER RUN")]);
  const s = setup(logDir);
  s.clock.t = T0 + 10 * MIN;
  assert.equal(await s.fn.tick(), "not-due");
  s.clock.t = T0 + 105 * MIN; // deployed 1h45m into the run, no notes yet
  assert.equal(await s.fn.tick(), "written");
  const input = s.llm.calls[0][1].content as string;
  assert.match(input, /FIRST field note/);
  assert.match(input, /OLDEST LINE/);
  assert.match(input, /I should build a fire/);
  assert.match(input, /appeared as an Eve/);
  assert.match(input, /PER HOUR/);
  assert.doesNotMatch(input, /OTHER RUN/);
  const [note] = s.fn.list();
  assert.equal(note.windowStart, T0);
  assert.equal(note.windowEnd, T0 + 105 * MIN);
  assert.equal(note.model, "fake/model");
  assert.match(note.text, /\n\n- EVE ROSE/);
  // persisted in the current run dir
  const line = JSON.parse(readFileSync(path.join(s.runDir, "fieldnotes.jsonl"), "utf8").trim());
  assert.equal(line.runId, RUN);
  assert.equal(line.windowEnd, T0 + 105 * MIN);
  // the next one is 20 min after the last note and covers only the time since it
  s.clock.t = T0 + 115 * MIN;
  assert.equal(await s.fn.tick(), "not-due");
  writeEvents(s.runDir, "events.jsonl", [ev(T0 + 110 * MIN, "say", "NEW LINE")]);
  s.clock.t = T0 + 125 * MIN;
  assert.equal(await s.fn.tick(), "written");
  const second = s.llm.calls[1][1].content as string;
  assert.doesNotMatch(second, /FIRST field note/);
  assert.match(second, /NEW LINE/);
  assert.doesNotMatch(second, /OLDEST LINE/);
  assert.match(second, /YOUR PREVIOUS NOTES/);
  assert.deepEqual(s.fn.list().map((n) => n.windowStart), [T0 + 105 * MIN, T0]);
  rmSync(logDir, { recursive: true });
});

test("skip: no note for an empty window, nobody alive, or no spending; the window moves on", async () => {
  const logDir = tmp();
  const s = setup(logDir);
  s.clock.t = T0 + 21 * MIN;
  assert.equal(await s.fn.tick(), "empty"); // no events at all
  assert.equal(s.llm.calls.length, 0);
  // events but nobody alive
  writeEvents(s.runDir, "events.jsonl", [ev(T0 + 30 * MIN, "say", "HELLO")]);
  s.state.agents = [];
  s.clock.t = T0 + 41 * MIN;
  assert.equal(await s.fn.tick(), "skipped");
  // paused / halted
  s.state.agents = [alive("EVE ROSE")];
  s.state.canSpend = false;
  s.clock.t = T0 + 61 * MIN;
  assert.equal(await s.fn.tick(), "skipped");
  // focus/system events alone are not activity
  writeEvents(s.runDir, "events.jsonl", [ev(T0 + 70 * MIN, "focus", "camera follows EVE ROSE"), ev(T0 + 71 * MIN, "system", "run started")]);
  s.state.canSpend = true;
  s.clock.t = T0 + 81 * MIN;
  assert.equal(await s.fn.tick(), "empty");
  assert.equal(s.llm.calls.length, 0);
  assert.deepEqual(s.fn.list(), []);
  // not started yet
  const n = setup(tmp(), { startedAt: null });
  n.clock.t = T0 + 100 * MIN;
  assert.equal(await n.fn.tick(), "not-due");
  rmSync(logDir, { recursive: true });
});

test("failure: logged, nothing written, retried at the next interval with the same window start", async () => {
  const logDir = tmp();
  const s = setup(logDir);
  writeEvents(s.runDir, "events.jsonl", [ev(T0 + 5 * MIN, "say", "HELLO")]);
  s.llm.fail = true;
  s.clock.t = T0 + 20 * MIN;
  assert.equal(await s.fn.tick(), "failed");
  assert.deepEqual(s.fn.list(), []);
  s.clock.t = T0 + 30 * MIN;
  assert.equal(await s.fn.tick(), "not-due");
  s.llm.fail = false;
  s.clock.t = T0 + 40 * MIN;
  assert.equal(await s.fn.tick(), "written");
  assert.equal(s.fn.list()[0].windowStart, T0);
  assert.match(s.llm.calls[1][1].content as string, /FIRST field note/);
  rmSync(logDir, { recursive: true });
});

test("restart: notes load from every run dir, and the schedule continues from the last note", async () => {
  const logDir = tmp();
  const old = path.join(logDir, `${RUN}-2026-11-18T08-00-00-000Z`);
  mkdirSync(old, { recursive: true });
  const n1 = { t: T0 + 20 * MIN, runId: RUN, windowStart: T0, windowEnd: T0 + 20 * MIN, text: "First.", model: "m" };
  const n2 = { t: T0 + 40 * MIN, runId: RUN, windowStart: T0 + 20 * MIN, windowEnd: T0 + 40 * MIN, text: "Second.", model: "m" };
  appendFileSync(path.join(old, "fieldnotes.jsonl"), [n1, n2, { ...n2, runId: "other" }].map((x) => JSON.stringify(x)).join("\n") + "\n{torn");
  writeEvents(old, "events.jsonl", [ev(T0 + 50 * MIN, "say", "AFTER RESTART")]);
  // restarted (new run dir) 45 min in: the next note is due at 60 min
  const s = setup(logDir, { runDir: path.join(logDir, `${RUN}-2026-11-18T09-00-00-000Z`) });
  assert.deepEqual(s.fn.list().map((n) => n.text), ["Second.", "First."]);
  s.clock.t = T0 + 45 * MIN;
  assert.equal(await s.fn.tick(), "not-due");
  s.clock.t = T0 + 60 * MIN;
  assert.equal(await s.fn.tick(), "written");
  const input = s.llm.calls[0][1].content as string;
  assert.match(input, /since your previous note/);
  assert.match(input, /AFTER RESTART/);
  assert.match(input, /First\.[\s\S]*Second\./);
  assert.equal(s.fn.list()[0].windowStart, T0 + 40 * MIN);
  // a fresh instance sees all three
  assert.equal(loadNotes(logDir, RUN).length, 3);
  // a new run in the same process starts with no notes
  s.state.runId = "pilot1-r10-new";
  assert.deepEqual(s.fn.list(), []);
  rmSync(logDir, { recursive: true });
});

test("readRunEvents: only the window, skips files last written before it", async () => {
  const logDir = tmp();
  const d = path.join(logDir, `${RUN}-x`);
  writeEvents(d, "events.jsonl.1", [ev(T0, "say", "A")]);
  writeEvents(d, "events.jsonl", [ev(T0 + 5 * MIN, "say", "B"), ev(T0 + 25 * MIN, "say", "C")]);
  utimesSync(path.join(d, "events.jsonl.1"), new Date(T0 / 1000), new Date(T0 / 1000));
  const got: string[] = [];
  await readRunEvents(logDir, RUN, T0 + MIN, T0 + 20 * MIN, (e) => got.push(e.text));
  assert.deepEqual(got, ["B"]);
  rmSync(logDir, { recursive: true });
});

test("digest: speech with cross-family marks, births to named mothers, deaths, action counts and repeated failures", () => {
  const d = new Digest(T0, T0 + INTERVAL);
  d.add(ev(T0 + 1, "say", "hi", { agentId: "a02", playerId: 2, name: "ADA LEE" }));
  d.add(ev(T0 + 2, "say", "COME HERE", { data: { heardBy: ["a02"] } }));
  d.add(ev(T0 + 3, "birth", "a03 born", { agentId: "a03", playerId: 3, name: null, data: { motherId: 1, eve: false, generation: 2 } }));
  d.add(ev(T0 + 4, "thought", "hungry", { agentId: "a03", playerId: 3, name: "MAY ROSE" }));
  d.add(ev(T0 + 5, "death", "died", { agentId: "a02", playerId: 2, name: null, data: { age: 31.4, reason: "reason_hunger" } }));
  for (let i = 0; i < 3; i++) d.add(ev(T0 + 10 + i, "action", "use (3, 4) -> use at (3,4): nothing happened", { data: { action: { type: "use" } } }));
  d.add(ev(T0 + 20, "action", "use (1, 2) -> use: tile (1,2) Big Hard Rock -> Big Hard Rock; holding Round Stone -> Sharp Stone", { data: { action: { type: "use" } } }));
  d.add(ev(T0 + 21, "action", "reflex forage -> ate Gooseberry; food 2 -> 7/20", { data: { reflex: true } }));
  d.add(ev(T0 + INTERVAL, "say", "OUT OF WINDOW"));
  const out = d.render(1, { hourly: false }).join("\n");
  assert.match(out, /EVE ROSE: "COME HERE" -> ADA LEE \[cross-family\]/);
  assert.match(out, /MAY ROSE born to EVE ROSE, generation 2/);
  assert.match(out, /ADA LEE died at age 31\.4 \(hunger\)/);
  assert.match(out, /use x4/);
  assert.match(out, /made: Sharp Stone/);
  assert.match(out, /ate: Gooseberry/);
  assert.match(out, /failed repeatedly: use: nothing happened x3/);
  assert.match(out, /thought .*"hungry"/);
  assert.doesNotMatch(out, /OUT OF WINDOW/);
  assert.equal(failureOf("go", "arrived"), null);
  assert.equal(failureOf("go", "no path found"), "go: no path found");
});

test("buildInput: stays under the cap with a long busy run", () => {
  const d = new Digest(T0, T0 + 6 * 3_600_000);
  for (let i = 0; i < 40_000; i++) {
    const a = `a${i % 20}`;
    const name = `P${i % 20} FAM${i % 4}`;
    d.add(ev(T0 + i * 500, i % 3 ? "thought" : "say", `line ${i} `.repeat(15), { agentId: a, playerId: i % 20, name, data: { heardBy: [`a${(i + 1) % 20}`] } }));
    d.add(ev(T0 + i * 500 + 1, "action", `go (${i}, 0) -> arrived`, { agentId: a, playerId: i % 20, name, data: { action: { type: "go" } } }));
  }
  const input = buildInput({ digest: d, first: true, runStartedAt: T0, alive: [alive("EVE ROSE")], inventions: [], previous: [] });
  assert.ok(input.length <= MAX_INPUT_CHARS, `input ${input.length} chars`);
  assert.match(input, /SPEECH: 13334 lines/);
  assert.match(input, /P19 FAM3/);
});

test("cleanNote: keeps paragraphs and bullets, drops markup", () => {
  assert.equal(cleanNote("## Notes\n**EVE** ate.\r\n\r\n\r\n* one\n• two\n<b>x</b>"), "Notes\nEVE ate.\n\n- one\n- two\n x".replace("\n x", "\nx"));
  assert.equal(cleanNote(42), "");
});

test("quiet hours: no note inside them; the window waits, so the next note covers the quiet stretch", async () => {
  const { inQuietHours } = await import("./quiet.ts");
  assert.equal(inQuietHours("23-10", "America/Los_Angeles", new Date("2026-11-19T08:00:00Z")), true, "midnight PT");
  assert.equal(inQuietHours("", "America/Los_Angeles", new Date("2026-11-19T08:00:00Z")), false);
});
