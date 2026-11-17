// Local end-to-end run of the turn clock without a game server or paid calls:
// a few real Agents on in-process fake worlds (FakeGame), the fake LLM provider
// over HTTP (fake-llm.ts), and a fake server clock (FakeClockPort), driven by
// the TurnCoordinator. Prints one line per turn.
//
//   npx tsx src/tools/turnclock-sim.ts [--agents 3] [--turns 8] [--latency-ms 400] [--speed 2]
//
// --speed: game seconds per wall second in the act window (1 = a real k=1 server).

import { config, type Config } from "../config.ts";
import { GameData } from "../game/gameData.ts";
import { FakeGame } from "../game/fakeGame.ts";
import { FakeClockPort } from "../game/fakeClock.ts";
import { Body } from "../game/body.ts";
import { Agent } from "../agent/agent.ts";
import { Llm } from "../agent/llm.ts";
import { TurnCoordinator } from "../turnclock.ts";
import type { EventLog } from "../events.ts";
import { startFakeLlm } from "./fake-llm.ts";

const argv = process.argv.slice(2);
const opt = (k: string, d: number) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? Number(argv[i + 1]) : d;
};
const nAgents = opt("agents", 3), nTurns = opt("turns", 8), latencyMs = opt("latency-ms", 400), speed = opt("speed", 2);

const fake = startFakeLlm({ latencyMs, ttftMs: 0, jsonErrorRate: 0 });
const port = await fake.ready;
const cfg: Config = {
  ...config, llmBaseUrl: `http://127.0.0.1:${port}`, llmApiKey: "x", llmModel: "fake", llmReasoningCap: false, llmStream: false,
  turnClock: true, turnGameS: 2.4, timeScale: 1, turnDecideTimeoutMs: 5000, maxCostUsd: 0, dailyCostUsd: 0,
};
const gd = new GameData();
const events: string[] = [];
const log = {
  emitEvent: (kind: string, e: { agentId?: string; text: string }) => events.push(`${e.agentId ?? "-"} ${kind}: ${e.text}`),
  write: () => {},
} as unknown as EventLog;
const llm = new Llm(cfg);
const clock = new FakeClockPort(1000, speed);
const agents: Agent[] = [];
const coord = new TurnCoordinator(clock, () => agents, {
  turnGameS: cfg.turnGameS, timeScale: 1, decideTimeoutMs: cfg.turnDecideTimeoutMs, babyIdleTurns: cfg.babyIdleTurns, pollMs: 20,
  warn: (t) => console.log("WARN", t),
});
for (let i = 0; i < nAgents; i++) {
  const g = new FakeGame(gd, 1, 5, () => coord.now());
  g.addPlayer({ id: 1, x: 0, y: 0, age: 20, held: 0, female: true });
  g.setTile(2, 1, gd.idByName("Stone")!);
  g.food = 15;
  g.start();
  const a = new Agent(`a${i + 1}`, cfg, gd, llm, log, undefined, { turns: coord.link() });
  const A = a as unknown as Record<string, any>;
  A.world = g.world;
  A.conn = { closed: false, close() {} };
  A.body = new Body(g.conn, g.world, gd);
  A.status = "alive";
  agents.push(a);
}

const t0 = Date.now();
let lastN = 0;
coord.start();
while (coord.n <= nTurns) {
  await new Promise((r) => setTimeout(r, 20));
  if (coord.n !== lastN) {
    lastN = coord.n;
    const i = coord.info();
    console.log(`turn ${i.n} at ${((Date.now() - t0) / 1000).toFixed(1)}s: game ${i.gameTime?.toFixed(1)} s, target ${i.target ?? "-"}, busy ${i.busy}`);
  }
}
await coord.stop();
fake.close();
const last = clock.writes.at(-1)!;
console.log(`\n${clock.writes.length} act windows, game clock ${clock.gameTime.toFixed(1)} s (last target ${last}), paused: ${clock.paused}; ${fake.calls()} model calls`);
console.log(events.filter((e) => !e.includes("thought")).slice(-8).join("\n"));
for (const a of agents) console.log(`${a.id}: ${a.history.slice(-3).map((h) => `${h.action} -> ${h.result}`).join(" | ")}`);
process.exit(0);
