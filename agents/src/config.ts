// Runtime config from env vars. See /.env.example.

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// load repo-root .env for local dev (Railway injects env directly)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
for (const f of [path.join(root, ".env"), path.join(root, "agents/.env")]) {
  if (!existsSync(f)) continue;
  for (const line of readFileSync(f, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const env = process.env;
const num = (k: string, d: number) => (env[k] ? Number(env[k]) : d);

export const config = {
  oholHost: env.OHOL_HOST ?? "127.0.0.1",
  oholPort: num("OHOL_PORT", 8005),
  agentCount: num("AGENT_COUNT", 4),
  /** stable prefix for login emails; same prefix = same bodies after a restart */
  runId: env.RUN_ID ?? "pilot1",
  memoryMode: (env.MEMORY_MODE === "persistent" ? "persistent" : "per-life") as "per-life" | "persistent",
  recipeHints: env.RECIPE_HINTS !== "0",
  llmBaseUrl: env.LLM_BASE_URL ?? "https://openrouter.ai/api/v1",
  llmApiKey: env.LLM_API_KEY ?? env.OPENROUTER_API_KEY ?? "",
  llmModel: env.LLM_MODEL ?? "google/gemini-3.8-flash",
  llmMaxTokens: num("LLM_MAX_TOKENS", 2000),
  /** min ms between decisions for one agent */
  decisionIntervalMs: num("DECISION_INTERVAL_MS", 2500),
  /** decisions while age < 2 (babies can do very little) */
  babyDecisionIntervalMs: num("BABY_DECISION_INTERVAL_MS", 15000),
  /** hard spend cap for the run; agents stop calling the LLM past this */
  maxCostUsd: num("MAX_COST_USD", 10),
  // --- run limits: the run halts (all agents disconnect, no more LLM calls)
  // when any of these is hit. Restart the process to start a new run.
  /** halt once a character of a later generation than this is born */
  maxGeneration: num("MAX_GENERATION", 3),
  /** halt after this many lives in total across all slots */
  maxLives: num("MAX_LIVES", 40),
  /** halt after this many minutes */
  maxRuntimeMin: num("MAX_RUNTIME_MIN", 90),
  /** omniscient broadcast narrator; 0 disables */
  narratorIntervalMs: num("NARRATOR_INTERVAL_MS", 30000),
  narratorModel: env.NARRATOR_MODEL || undefined,
  /** 0 = process starts idle; begin the run with POST /api/start?token=... */
  autostart: env.AUTOSTART !== "0",
  /** 1 = anyone can start/stop runs from the dashboard (no password) */
  openControl: env.OPEN_CONTROL === "1",
  /** spend cap across all runs since this process started; Start is refused past it. 0 = no cap */
  maxTotalCostUsd: num("MAX_TOTAL_COST_USD", 0),
  /** if set, POST /api/halt?token=<this> halts the run */
  controlToken: env.CONTROL_TOKEN ?? "",
  port: num("PORT", 8787),
  logDir: env.LOG_DIR ?? path.join(root, "agents/logs"),
  /** ms between agent logins, so the first one becomes Eve and others are born to her */
  loginStaggerMs: num("LOGIN_STAGGER_MS", 20000),
};

export type Config = typeof config;
