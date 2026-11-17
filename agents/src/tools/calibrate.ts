// Calibration harness: a short session per candidate model against a game
// server, scored into a JSON scorecard (see calibration.ts for the fields).
//
//   npx tsx src/tools/calibrate.ts run --model <id> [--minutes 15] [--agents 8]
//        [--host 127.0.0.1] [--port 8005] [--out calibration] [--max-cost 5]
//        [--initial-eves N] [--base-url URL]
//        [--reasoning off|minimal|low|medium|high] [--max-tokens N]
//        [--provider-sort throughput|latency|price] [--provider-order groq,cerebras] [--allow-fallbacks 0|1]
//        [--cycle-ms 4000] [--time-scale 1] [--stream 0|1]
//     Plays one session with fresh login emails, then writes
//     <out>/<runId>.scorecard.json and prints a one-row table.
//   npx tsx src/tools/calibrate.ts score <runDir> --model <id> [--agents N] [--out file]
//     Re-scores a finished run from its logs.
//   npx tsx src/tools/calibrate.ts summary <scorecard.json>... [--out table.md]
//     Markdown table across models.
//
// Per-run flags override the matching env settings (LLM_REASONING_EFFORT,
// LLM_MAX_TOKENS, LLM_PROVIDER_SORT / _ORDER / _ALLOW_FALLBACKS,
// DECISION_CYCLE_MS, TIME_SCALE, LLM_STREAM); every other setting comes from
// the environment / .env as usual (RECIPE_HINTS, ...). Streaming is on by
// default here so the scorecard gets time-to-first-token. --time-scale only
// records the scale and passes it to the agents (timeScale): the game server
// must be started with the same scale. The narrator, director
// and story are off. Reset the world between models (server/reset-local.sh)
// or give each model its own server, so leftover characters from an earlier
// session don't become mothers. This spends real money with a real key.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { config, type Config } from "../config.ts";
import { scoreRun, summaryTable, type Scorecard } from "../calibration.ts";

function args(argv: string[]) {
  const pos: string[] = [];
  const opt: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=", 2);
      opt[k] = v ?? argv[++i] ?? "";
    } else pos.push(a);
  }
  return { pos, opt };
}

/** TIME_SCALE (game clock k x slower), from config when present, else env; 1 = stock */
export function timeScale(): number {
  const v = Number((config as Config & { timeScale?: number }).timeScale ?? process.env.TIME_SCALE ?? 1);
  return Number.isFinite(v) && v > 0 ? v : 1;
}

export interface SessionOptions {
  model: string;
  minutes: number;
  agents: number;
  host: string;
  port: number;
  out: string;
  maxCostUsd: number;
  initialEves?: number;
  baseUrl?: string;
  reasoningEffort?: string;
  maxTokens?: number;
  providerSort?: string;
  providerOrder?: string[];
  allowFallbacks?: boolean;
  decisionCycleMs?: number;
  timeScale?: number;
  stream?: boolean;
}

/** Play one session and score it. Returns the scorecard (also written to <out>). */
export async function runSession(o: SessionOptions): Promise<{ card: Scorecard; file: string }> {
  const { GameData } = await import("../game/gameData.ts");
  const { EventLog } = await import("../events.ts");
  const { Population } = await import("../population.ts");
  const slug = o.model.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").slice(0, 40);
  const runId = `cal-${slug}-${Date.now().toString(36)}`;
  const logDir = path.resolve(o.out, "logs");
  mkdirSync(logDir, { recursive: true });
  const cfg: Config = {
    ...config,
    llmModel: o.model,
    ...(o.baseUrl ? { llmBaseUrl: o.baseUrl } : {}),
    agentCount: o.agents,
    oholHost: o.host,
    oholPort: o.port,
    runId,
    logDir,
    continuous: true,
    maxCostUsd: o.maxCostUsd,
    narratorIntervalMs: 0,
    directorIntervalMs: 0,
    storyIntervalMs: 0,
    ...(o.initialEves != null ? { initialEves: o.initialEves } : {}),
    ...(o.reasoningEffort != null ? { llmReasoningEffort: o.reasoningEffort } : {}),
    ...(o.maxTokens != null ? { llmMaxTokens: o.maxTokens } : {}),
    ...(o.providerSort != null ? { llmProviderSort: o.providerSort } : {}),
    ...(o.providerOrder != null ? { llmProviderOrder: o.providerOrder } : {}),
    ...(o.allowFallbacks != null ? { llmProviderAllowFallbacks: o.allowFallbacks } : {}),
    ...(o.decisionCycleMs != null ? { decisionCycleMs: o.decisionCycleMs, decisionIntervalMs: o.decisionCycleMs } : {}),
    llmStream: o.stream ?? true,
  };
  const scale = o.timeScale ?? timeScale();
  (cfg as Config & { timeScale?: number }).timeScale = scale;
  const log = new EventLog(logDir, runId);
  const pop = new Population(cfg, new GameData(), log);
  const startedAt = Date.now();
  console.log(`calibrate: ${o.model}, ${o.agents} agents, ${o.minutes} min, server ${o.host}:${o.port}, logs ${log.dir}`);
  void pop.start();
  const endAt = startedAt + o.minutes * 60_000;
  while (Date.now() < endAt && !pop.halted) await new Promise((r) => setTimeout(r, 1000));
  const endedAt = Date.now();
  if (!pop.halted) pop.halt("calibration session over");
  await new Promise((r) => setTimeout(r, 1500)); // let the last log lines land
  const card = scoreRun(log.dir, {
    model: o.model, runId, startedAt, endedAt, agentCount: o.agents, timeScale: scale, decisionCycleMs: cfg.decisionCycleMs,
    totalCostUsd: pop.llm.totalCost,
    settings: {
      reasoningEffort: cfg.llmReasoningEffort || null, maxTokens: cfg.llmMaxTokens, providerSort: cfg.llmProviderSort || null,
      providerOrder: cfg.llmProviderOrder, allowFallbacks: cfg.llmProviderOrder.length ? cfg.llmProviderAllowFallbacks : null, stream: cfg.llmStream,
    },
  });
  const file = path.resolve(o.out, `${runId}.scorecard.json`);
  writeFileSync(file, JSON.stringify(card, null, 2) + "\n");
  return { card, file };
}

async function main() {
  const { pos, opt } = args(process.argv.slice(2));
  const cmd = pos.shift();
  if (cmd === "run") {
    if (!opt.model) throw new Error("--model is required");
    if (!config.llmApiKey && !opt["base-url"]) throw new Error("no LLM key: set OPENROUTER_API_KEY (or LLM_API_KEY)");
    const { card, file } = await runSession({
      model: opt.model,
      minutes: Number(opt.minutes ?? 15),
      agents: Number(opt.agents ?? 8),
      host: opt.host ?? config.oholHost,
      port: Number(opt.port ?? config.oholPort),
      out: opt.out ?? "calibration",
      maxCostUsd: Number(opt["max-cost"] ?? 5),
      initialEves: opt["initial-eves"] != null ? Number(opt["initial-eves"]) : undefined,
      baseUrl: opt["base-url"],
      reasoningEffort: opt.reasoning,
      maxTokens: opt["max-tokens"] != null ? Number(opt["max-tokens"]) : undefined,
      providerSort: opt["provider-sort"],
      providerOrder: opt["provider-order"] != null ? opt["provider-order"].split(",").map((x) => x.trim()).filter(Boolean) : undefined,
      allowFallbacks: opt["allow-fallbacks"] != null ? opt["allow-fallbacks"] !== "0" : undefined,
      decisionCycleMs: opt["cycle-ms"] != null ? Number(opt["cycle-ms"]) : undefined,
      timeScale: opt["time-scale"] != null ? Number(opt["time-scale"]) : undefined,
      stream: opt.stream != null ? opt.stream !== "0" : undefined,
    });
    console.log(`scorecard: ${file}\n`);
    console.log(summaryTable([card]));
    process.exit(0);
  } else if (cmd === "score") {
    const dir = pos[0];
    if (!dir || !opt.model) throw new Error("usage: score <runDir> --model <id> [--agents N] [--started ms] [--ended ms]");
    const events = readFileSync(path.join(dir, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const card = scoreRun(dir, {
      model: opt.model, runId: path.basename(dir),
      startedAt: Number(opt.started ?? events[0]?.t ?? 0), endedAt: Number(opt.ended ?? events.at(-1)?.t ?? 0),
      agentCount: Number(opt.agents ?? config.agentCount), timeScale: Number(opt["time-scale"] ?? timeScale()),
      decisionCycleMs: Number(opt["cycle-ms"] ?? config.decisionCycleMs),
    });
    const out = JSON.stringify(card, null, 2) + "\n";
    if (opt.out) writeFileSync(opt.out, out);
    else process.stdout.write(out);
  } else if (cmd === "summary") {
    const cards = pos.map((f) => JSON.parse(readFileSync(f, "utf8")) as Scorecard);
    const table = summaryTable(cards);
    if (opt.out) writeFileSync(opt.out, table);
    process.stdout.write(table);
  } else {
    console.error("usage: calibrate.ts run --model <id> [...] | score <runDir> --model <id> | summary <scorecard.json>...");
    process.exit(2);
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("calibrate.ts")) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
