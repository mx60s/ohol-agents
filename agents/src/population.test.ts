// Run status and limits in continuous vs normal mode (no game, no LLM calls).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { config, type Config } from "./config.ts";
import { EventLog } from "./events.ts";
import { MAP_MAX_CELLS, Population } from "./population.ts";
import type { GameData } from "./game/gameData.ts";
import { LlmHealth, LlmHttpError } from "./agent/llm.ts";

const gd = {} as GameData;

function withPop(over: Partial<Config>, gate: { paused: string | null }, fn: (p: Population, log: EventLog) => void) {
  const dir = mkdtempSync(path.join(tmpdir(), "pop-"));
  try {
    const cfg: Config = { ...config, logDir: dir, runId: "t", narratorIntervalMs: 0, ...over };
    const log = new EventLog(dir, "t");
    const pop = new Population(cfg, gd, log, {
      spend: { onCost: () => {}, pausedReason: () => gate.paused, last24hUsd: () => 12.5, resumesAt: () => (gate.paused ? 123 : null) },
    });
    fn(pop, log);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const birth = (log: EventLog, generation: number) =>
  log.emitEvent("birth", { agentId: "a01", playerId: generation, text: "born", data: { playerId: generation, generation } });

test("normal mode: generation limit halts the run", () => {
  withPop({ continuous: false, maxGeneration: 3 }, { paused: null }, (pop, log) => {
    birth(log, 4);
    assert.equal(pop.halted, true);
    assert.equal(pop.state().run.status, "halted");
  });
});

test("continuous mode: no generation/lives halts", () => {
  withPop({ continuous: true, maxGeneration: 3, maxLives: 2 }, { paused: null }, (pop, log) => {
    for (let g = 1; g <= 10; g++) birth(log, g);
    assert.equal(pop.halted, false);
    assert.equal(pop.state().run.continuous, true);
  });
});

test("RunInfo.timeScale reports TIME_SCALE (game year = 60 s x k)", () => {
  withPop({ timeScale: 3 }, { paused: null }, (pop) => assert.equal(pop.state().run.timeScale, 3));
});

test("daily cap shows status paused with reason and resume time, then running again", () => {
  const gate = { paused: "daily spend cap reached" as string | null };
  withPop({ continuous: true, dailyCostUsd: 10 }, gate, (pop) => {
    assert.equal(pop.state().run.status, "idle");
    pop.started = true;
    let run = pop.state().run;
    assert.equal(run.status, "paused");
    assert.equal(run.pauseReason, "daily spend cap reached");
    assert.equal(run.resumesAt, 123);
    assert.deepEqual(run.dailySpend, { last24hUsd: 12.5, capUsd: 10 });
    assert.equal(pop.llm.overBudget, true);
    assert.equal(pop.halted, false);
    gate.paused = null;
    run = pop.state().run;
    assert.equal(run.status, "running");
    assert.equal(run.pauseReason, null);
    assert.equal(pop.state().traitSource, "mock");
  });
});

test("LLM provider failures: llmStatus in /api/state, one announcement each way, health shared across runs", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pop-"));
  try {
    const cfg: Config = { ...config, logDir: dir, runId: "t", narratorIntervalMs: 0 };
    const health = new LlmHealth();
    const log = new EventLog(dir, "t");
    const pop = new Population(cfg, gd, log, { llmHealth: health });
    assert.deepEqual(pop.state().run.llmStatus, { ok: true, lastError: null, since: null, consecutiveFailures: 0, retryAt: null, outageSince: null });
    const sys = () => log.recent.filter((e) => e.kind === "system").map((e) => e.text);
    health.failure(new LlmHttpError(402, "Insufficient credits"));
    health.failure(new LlmHttpError(402, "Insufficient credits"));
    const check = () => (pop as unknown as { checkLimits(): void }).checkLimits();
    check();
    check();
    const st = pop.state().run.llmStatus!;
    assert.equal(st.ok, false);
    assert.equal(st.consecutiveFailures, 2);
    assert.equal(st.lastError, "HTTP 402: Insufficient credits");
    assert.equal(pop.llm.overBudget, true, "agents/narrator/director/story stop calling");
    assert.deepEqual(sys(), ["LLM provider failing (HTTP 402: Insufficient credits); agents are idle until it recovers"]);
    // a new run (new Population) keeps the backoff
    const pop2 = new Population(cfg, gd, new EventLog(dir, "t2"), { llmHealth: health });
    assert.equal(pop2.llm.overBudget, true);
    health.success();
    check();
    assert.equal(sys().at(-1), "LLM provider recovered");
    assert.equal(pop.state().run.llmStatus!.ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("/api/map stays bounded: capped cell store, last-known centre while nobody is alive, short cache", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pop-"));
  try {
    const cfg: Config = { ...config, logDir: dir, runId: "t", narratorIntervalMs: 0 };
    const pop = new Population(cfg, { name: () => "Stone" } as unknown as GameData, new EventLog(dir, "t"));
    const cells = new Map<string, { biome: number; floor: number; obj: { id: number; contained: [] }; t: number }>();
    // a long run's worth of exploration: a 500x500 area
    for (let x = 0; x < 500; x++) for (let y = 0; y < 500; y++) cells.set(`${x},${y}`, { biome: 1, floor: 0, obj: { id: 0, contained: [] }, t: x * 500 + y });
    const agent = { status: "alive", world: { self: { x: 490, y: 490 }, cells } };
    pop.agents.push(agent as never);
    const m1 = pop.map(60, 1_000);
    assert.ok(m1.cells.length <= 121 * 121);
    assert.ok((pop as unknown as { merged: Map<string, unknown> }).merged.size <= MAP_MAX_CELLS, "merged map capped");
    assert.equal(pop.map(60, 1_500), m1, "cached for a moment");
    agent.status = "dead";
    const m2 = pop.map(60, 5_000);
    assert.ok(m2.cells.length > 0 && m2.cells.length <= 121 * 121, "nobody alive: still only around the last centre, not the whole world");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("config: CONTINUOUS=1 turns spend caps off by default; explicit values still apply", () => {
  const agentsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const read = (env: Record<string, string>) => {
    const out = execFileSync(
      process.execPath,
      ["--import", "tsx", "-e", "import('./src/config.ts').then(m => console.log(JSON.stringify({ c: m.config.continuous, max: m.config.maxCostUsd, daily: m.config.dailyCostUsd, dims: m.config.traitDims })))"],
      { cwd: agentsDir, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env }, encoding: "utf8" },
    );
    return JSON.parse(out.trim().split("\n").at(-1)!);
  };
  // .env files could override unset vars; pass explicit empties where it matters
  assert.deepEqual(read({ CONTINUOUS: "1", MAX_COST_USD: "", DAILY_COST_USD: "" }), {
    c: true, max: 0, daily: 0, dims: ["openness", "conscientiousness", "extraversion", "agreeableness", "neuroticism"],
  });
  assert.equal(read({ CONTINUOUS: "0", MAX_COST_USD: "" }).max, 10);
  const explicit = read({ CONTINUOUS: "1", MAX_COST_USD: "25", DAILY_COST_USD: "40", TRAIT_DIMS: "x,y" });
  assert.deepEqual([explicit.max, explicit.daily, explicit.dims], [25, 40, ["x", "y"]]);
});

test("speechScrambled: never below 15 alive (server minActivePlayersForLanguages); at 15+ the hearer's words differ from the speaker's echo", () => {
  withPop({}, { paused: null }, (pop) => {
    const agent = (playerId: number) => ({ id: `a${playerId}`, status: "alive", world: { selfId: playerId }, emit: () => {} }) as never;
    const P = pop as unknown as { agents: unknown[] };
    for (let i = 1; i <= 8; i++) P.agents.push(agent(i));
    pop.spoke(agent(1), "HELLO SISTER", 0, 0);
    assert.equal(pop.speechScrambled(1, "HOBA KESTEL"), false, "8 players: nothing is scrambled");
    for (let i = 9; i <= 15; i++) P.agents.push(agent(i));
    assert.equal(pop.speechScrambled(1, "HELLO SISTER"), false, "same words as said");
    assert.equal(pop.speechScrambled(1, "HOBA KESTEL"), true);
    assert.equal(pop.speechScrambled(2, "HOBA"), null, "never heard #2 speak");
  });
});
