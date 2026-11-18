// Runtime config from env vars. See /.env.example.

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseTraitDims } from "./traits.ts";

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
/** CONTINUOUS=1: always-on; generation/lives/runtime limits are ignored */
const continuous = env.CONTINUOUS === "1";
const decisionCycleMs = num("DECISION_CYCLE_MS", num("DECISION_INTERVAL_MS", 8000));
const llmBaseUrl = env.LLM_BASE_URL ?? "https://openrouter.ai/api/v1";
const llmModel = env.LLM_MODEL ?? "google/gemini-3.8-flash";
/**
 * Default model for the narrator, director and story (overhead, not agents).
 * On OpenRouter a cheap fast model (verified in /api/v1/models on 2026-11-16);
 * on any other endpoint the agents' model, since ids differ per provider.
 */
const OPENROUTER = "https://openrouter.ai/api/v1";
const isOpenRouter = (u: string) => /openrouter\.ai/.test(u);
const llmApiKey = env.LLM_API_KEY ?? env.OPENROUTER_API_KEY ?? "";
/**
 * Endpoint for the overhead calls (narrator, story, director; Jev always uses
 * OpenRouter). Default: OpenRouter when the agents use another endpoint (e.g.
 * a self-hosted vLLM) and OPENROUTER_API_KEY is set, else the agents' endpoint.
 */
const overheadBaseUrl = env.OVERHEAD_BASE_URL || (!isOpenRouter(llmBaseUrl) && env.OPENROUTER_API_KEY ? OPENROUTER : llmBaseUrl);
const overheadApiKey = env.OVERHEAD_API_KEY || (isOpenRouter(overheadBaseUrl) ? env.OPENROUTER_API_KEY || llmApiKey : llmApiKey);
const overheadModel = env.OVERHEAD_MODEL || (isOpenRouter(overheadBaseUrl) ? "google/gemini-3.1-flash-lite" : llmModel);
if (env.TRAIT_SOURCE && env.TRAIT_SOURCE !== "mock") console.warn(`TRAIT_SOURCE=${env.TRAIT_SOURCE} is not supported yet (no steering); using "mock"`);

export const config = {
  oholHost: env.OHOL_HOST ?? "127.0.0.1",
  oholPort: num("OHOL_PORT", 8005),
  agentCount: num("AGENT_COUNT", 4),
  /** stable prefix for login emails; same prefix = same bodies after a restart */
  runId: env.RUN_ID ?? "pilot1",
  memoryMode: (env.MEMORY_MODE === "persistent" ? "persistent" : "per-life") as "per-life" | "persistent",
  /**
   * 1 (default) = a yearly summary of this life ("WHAT YOU REMEMBER") rewritten in the
   * background every MEMORY_SUMMARY_TURNS turns by the agents' model (agent/memory.ts); 0 = none
   */
  memorySummary: env.MEMORY_SUMMARY !== "0",
  /** turns between memory summaries (turn clock: 25 turns of TURN_GAME_S=2.4 = one game year; else decisions) */
  memorySummaryTurns: Math.max(1, Math.floor(num("MEMORY_SUMMARY_TURNS", 25))),
  recipeHints: env.RECIPE_HINTS !== "0",
  llmBaseUrl,
  llmApiKey,
  overheadBaseUrl,
  overheadApiKey,
  /**
   * How the agents' reasoning cap is sent: "openrouter" (reasoning.max_tokens)
   * or "vllm" (chat_template_kwargs.enable_thinking + thinking_token_budget).
   * Default: openrouter on OpenRouter, else vllm.
   */
  llmReasoningStyle: (env.LLM_REASONING_STYLE === "vllm" || env.LLM_REASONING_STYLE === "openrouter"
    ? env.LLM_REASONING_STYLE
    : isOpenRouter(llmBaseUrl) ? "openrouter" : "vllm") as "openrouter" | "vllm",
  llmModel,
  /** the agents' model as shown on the site and in records, when LLM_MODEL is a short served id (vLLM "m") */
  llmModelName: env.LLM_MODEL_NAME || llmModel,
  llmMaxTokens: num("LLM_MAX_TOKENS", 2000),
  /**
   * Game clock slowdown k (TIME_SCALE, default 1 = stock). The server runs its
   * whole game clock k x slower (server/patches/time-scale.patch; server/run.sh
   * reads the same TIME_SCALE). The server reports durations and speeds in wall
   * seconds already; this is for constants the client knows itself (60 s/year,
   * 3.75 tiles/s, ...) and for expressing waits in turns. Must match the server.
   */
  timeScale: num("TIME_SCALE", 1) > 0 ? num("TIME_SCALE", 1) : 1,
  /**
   * Game seconds the server adds to every food pip (FOOD_BONUS_S, default 18).
   * Must match the server: newPlayerFoodDecrementSecondsBonus with
   * mtsNewPlayerFoodBonus=1 (server/settings), or 0 when that's off. Used for
   * the food facts in the system prompt and the newborn window; the per-turn
   * food line uses the server's own drain time.
   */
  foodBonusS: Math.max(0, num("FOOD_BONUS_S", 18)),
  /**
   * Fixed decision cadence (comparability across models): at least this many ms
   * from the start of one decision to the start of the next, whatever the
   * provider latency. See cadence.ts. Default 8000.
   */
  decisionCycleMs,
  /** legacy name for the adult cycle; equals decisionCycleMs (DECISION_INTERVAL_MS is read only as a fallback for DECISION_CYCLE_MS) */
  decisionIntervalMs: decisionCycleMs,
  /** decisions while age < 2 (babies can do very little) */
  babyDecisionIntervalMs: num("BABY_DECISION_INTERVAL_MS", 15000),
  /**
   * hard spend cap for the run; the run halts past this. 0 = no cap.
   * Default 10, or 0 (no cap) with CONTINUOUS=1 unless set explicitly.
   */
  maxCostUsd: num("MAX_COST_USD", continuous ? 0 : 10),
  // --- run limits: the run halts (all agents disconnect, no more LLM calls)
  // when any of these is hit. Restart the process to start a new run.
  /** halt once a character of a later generation than this is born */
  maxGeneration: num("MAX_GENERATION", 3),
  /** halt after this many lives in total across all slots */
  maxLives: num("MAX_LIVES", 40),
  /** halt after this many minutes */
  maxRuntimeMin: num("MAX_RUNTIME_MIN", 90),
  /** omniscient broadcast narrator; 0 disables */
  narratorIntervalMs: num("NARRATOR_INTERVAL_MS", 90000),
  /** model for the narrator; default OVERHEAD_MODEL (see above) */
  narratorModel: env.NARRATOR_MODEL || overheadModel,
  // --- stream director (picks the one character the stream camera follows); see director.ts
  /** ms between director decisions; 0 disables the director (focus stays null) */
  directorIntervalMs: num("DIRECTOR_INTERVAL_MS", 10000),
  /**
   * how the director decides: "jev" (TypeSafe's Jev decision model on OpenRouter's
   * Decisions API), "llm" (DIRECTOR_MODEL chat model) or "heuristic" (no calls).
   * Default "jev" when the overhead endpoint is OpenRouter, else "llm".
   */
  directorEngine: (["jev", "llm", "heuristic"].includes(env.DIRECTOR_ENGINE ?? "")
    ? env.DIRECTOR_ENGINE
    : isOpenRouter(overheadBaseUrl) ? "jev" : "llm") as "jev" | "llm" | "heuristic",
  /** model for the "llm" engine; default OVERHEAD_MODEL */
  directorModel: env.DIRECTOR_MODEL || overheadModel,
  /** decision model for the "jev" engine */
  directorJevModel: env.DIRECTOR_JEV_MODEL || "typesafe/jev-1.13",
  /** jev: leave a valid focus only if P(switch) >= this ... */
  directorSwitchP: num("DIRECTOR_SWITCH_P", 0.7),
  /** ... and combined(new pick) - combined(current focus) >= this (a major development elsewhere skips this margin) */
  directorSwitchMargin: num("DIRECTOR_SWITCH_MARGIN", 0.15),
  /** jev: combined = w * P_jev + (1 - w) * normalised heuristic salience */
  directorJevWeight: num("DIRECTOR_JEV_WEIGHT", 0.5),
  /** min ms on one character before switching (not applied on death/disconnect) */
  directorMinDwellMs: num("DIRECTOR_MIN_DWELL_MS", 45000),
  /** ms to stay on a character after they die, so viewers see it */
  directorDeathHoldMs: num("DIRECTOR_DEATH_HOLD_MS", 8000),
  // --- "story so far" (rolling world summary, persisted in LOG_DIR/story.jsonl); see story.ts
  /** ms between story refreshes; 0 disables */
  storyIntervalMs: num("STORY_INTERVAL_MS", 900000),
  /** model for the story; default NARRATOR_MODEL, then OVERHEAD_MODEL */
  storyModel: env.STORY_MODEL || env.NARRATOR_MODEL || overheadModel,
  /** 0 = process starts idle; begin the run with POST /api/start?token=... */
  autostart: env.AUTOSTART !== "0",
  /** 1 = anyone can start/stop runs from the dashboard (no password) */
  openControl: env.OPEN_CONTROL === "1",
  /** spend cap across all runs since this process started; Start is refused past it. 0 = no cap */
  maxTotalCostUsd: num("MAX_TOTAL_COST_USD", 0),
  /** if set, POST /api/halt?token=<this> halts the run */
  controlToken: env.CONTROL_TOKEN ?? "",
  port: num("PORT", 8787),
  /** max concurrent SSE (/api/stream) clients; more get 503 */
  sseMaxClients: num("SSE_MAX_CLIENTS", 200),
  logDir: env.LOG_DIR ?? path.join(root, "agents/logs"),
  /** raw per-run log files (llm.jsonl, events.jsonl, ...) rotate to <file>.1 past this many MB; 0 = never */
  logMaxFileMb: num("LOG_MAX_FILE_MB", 32),
  // --- starting setup and rejoins (see logins.ts and README "Run setup")
  /** Eves to start the run with: logins go in one at a time until this many have appeared as Eves */
  initialEves: num("INITIAL_EVES", 2),
  /** after the Eves, the other first logins join one every JOIN_STAGGER_S (+- JOIN_JITTER of it), born as babies */
  joinStaggerMs: env.JOIN_STAGGER_S ? Number(env.JOIN_STAGGER_S) * 1000 : num("LOGIN_STAGGER_MS", 90_000),
  /** relative jitter on the join stagger, 0..1 (0.3 = +-30%) */
  joinJitter: num("JOIN_JITTER", 0.3),
  /** a slot whose character died logs in again after a uniform random delay in [min, max] s */
  respawnDelayMinMs: num("RESPAWN_DELAY_MIN_S", 30) * 1000,
  respawnDelayMaxMs: num("RESPAWN_DELAY_MAX_S", 90) * 1000,
  /**
   * a join or respawn waits for family room (a login would be born to a mother)
   * at most this long, then logs in anyway (and may become an Eve). 0 = no limit:
   * a new Eve appears only when no woman alive can have a baby. FAMILY_ROOM_MAX_HOLD_S, default 600.
   */
  familyRoomMaxHoldMs: num("FAMILY_ROOM_MAX_HOLD_S", 600) * 1000,
  /**
   * Early birth cap, mirrored from the server (mtsEarlyMaxBabies / mtsEarlyMaxGenerations): a woman of
   * generation <= EARLY_MAX_GENERATIONS with EARLY_MAX_BABIES children doesn't count as family room,
   * so free slots wait for a mother who can still have a baby. 0 = off.
   */
  earlyMaxBabies: num("EARLY_MAX_BABIES", 0),
  earlyMaxGenerations: num("EARLY_MAX_GENERATIONS", 5),
  /** after a login comes out as an Eve (outside the starting burst), hold joins this long: no Eve floods. 0 = off */
  eveMinGapMs: num("EVE_MIN_GAP_S", 300) * 1000,
  // --- LLM provider outage handling and request options
  /** provider failing (401/402/403, 5xx, timeouts) for longer than this many s -> run paused, lives flagged; 0 = never pause */
  llmOutagePauseMs: num("LLM_OUTAGE_PAUSE_S", 60) * 1000,
  /** 1 = mark the static system prompt cacheable (cache_control) for models that need explicit breakpoints (Anthropic, Gemini) */
  llmPromptCache: env.LLM_PROMPT_CACHE !== "0",
  /** 1 = record the model's reasoning text when the provider returns it (never changes the request) */
  llmCaptureReasoning: env.LLM_CAPTURE_REASONING !== "0",
  // --- OpenRouter routing and reasoning (sent only when set; see agent/llm.ts requestOptions)
  /** provider.sort: "throughput" | "latency" | "price"; "" = OpenRouter's default routing */
  llmProviderSort: env.LLM_PROVIDER_SORT ?? "",
  /** provider.order: comma-separated provider slugs to try first, e.g. "groq,cerebras" */
  llmProviderOrder: (env.LLM_PROVIDER_ORDER ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  /** provider.allow_fallbacks (with an order): 0 = only the listed providers */
  llmProviderAllowFallbacks: env.LLM_PROVIDER_ALLOW_FALLBACKS !== "0",
  /** reasoning.effort: "off" (sent as "none") | "minimal" | "low" | "medium" | "high"; "" = the model's default */
  llmReasoningEffort: env.LLM_REASONING_EFFORT ?? "",
  /** 1 = stream replies (measures time-to-first-token); the parsed result is the same */
  llmStream: env.LLM_STREAM === "1",
  // --- always-on mode and research data (see README "Research data")
  continuous,
  /**
   * CONTINUOUS only: 1 = start a fresh run (new run id, new login emails) instead
   * of resuming the one in LOG_DIR/research/current-run.json. See runstate.ts.
   */
  newRun: env.NEW_RUN === "1",
  /** set by deploy/start.sh when it launches the game server; a different value = the server restarted */
  gameServerEpoch: env.GAME_SERVER_EPOCH ?? "",
  /** 1 = resume the run even after a game-server restart (only if bodies survive one, e.g. a save patch) */
  resumeAcrossServerRestart: env.RESUME_ACROSS_SERVER_RESTART === "1",
  /** rolling-24h LLM spend cap across runs and restarts; past it LLM calls pause until the window has room. 0 = off */
  dailyCostUsd: num("DAILY_COST_USD", 0),
  /** trait dimension names (comma-separated) */
  traitDims: parseTraitDims(env.TRAIT_DIMS),
  /** only "mock" exists for now: traits are recorded and inherited but don't affect behaviour */
  traitSource: "mock" as "mock" | "steered",
  /** SD of the per-dimension mutation added to the mother's traits */
  traitMutationSd: num("TRAIT_MUTATION_SD", 0.15),
  // --- agent-side survival aids (see README "Interventions")
  /** 1 = the `craft <item>` macro (plans over the recipe graph and runs the steps). TEMPORARY intervention. */
  craftMacro: env.CRAFT_MACRO ? env.CRAFT_MACRO !== "0" : env.PROMPT_BASELINE === "playbook",
  /**
   * PROMPT_BASELINE: "new" (default) = a first-time player's knowledge (controls,
   * our naming/flower rules, no recipes or strategy); "playbook" = the earlier
   * game-facts + ranked playbook prompt. See agent/prompt.ts. The craft macro
   * defaults on only with "playbook".
   */
  promptBaseline: (env.PROMPT_BASELINE === "playbook" ? "playbook" : "new") as "new" | "playbook",
  /**
   * 1 = mild reasoning cap on agent decisions: keep some reasoning, but at most
   * LLM_REASONING_MAX_TOKENS of it (0 = ask for effort "low" instead), within
   * LLM_DECISION_MAX_TOKENS in total so the visible JSON isn't truncated
   */
  llmReasoningCap: env.LLM_REASONING_CAP !== "0",
  /** reasoning-token budget per decision (OpenRouter reasoning.max_tokens); 0 = use effort "low" */
  llmReasoningMaxTokens: num("LLM_REASONING_MAX_TOKENS", 300),
  /** total max_tokens for an agent decision when LLM_REASONING_CAP=1 (reasoning + visible reply) */
  llmDecisionMaxTokens: num("LLM_DECISION_MAX_TOKENS", 800),
  /** a baby with nothing new happening is re-asked at most this often (ms); salient events wake it sooner */
  babyIdleMaxMs: num("BABY_IDLE_MAX_MS", 60000),
  /**
   * max steps in one reply's "actions" list, run back to back like quick
   * clicks; the list stops at the first failed step or salient event. 1 = one
   * action per turn. Human-UI equivalent (see README "Interventions").
   */
  actionListMax: Math.max(1, Math.floor(num("ACTION_LIST_MAX", 4))),
  // --- turn-based clock (lockstep; docs/turn-clock.md). Needs the game server's mtsTurnClock=1.
  /** 1 = the game clock runs only in act windows the agents service opens (TurnCoordinator, turnclock.ts) */
  turnClock: env.TURN_CLOCK === "1",
  /** game seconds the clock runs per turn (60 game s = 1 year, so 2.4 = 25 turns a year) */
  turnGameS: num("TURN_GAME_S", 2.4) > 0 ? num("TURN_GAME_S", 2.4) : 2.4,
  /** decide phase timeout: replies later than this are dropped (TURN_DECIDE_TIMEOUT_S, default 20; healthy capped replies take 3-5 s) */
  turnDecideTimeoutMs: Math.max(1, num("TURN_DECIDE_TIMEOUT_S", 20)) * 1000,
  /** the game server's run dir, where mtsClockTarget.txt / mtsClockNow.txt live (deploy/start.sh exports it) */
  clockDir: env.MTS_CLOCK_DIR || env.WORLD_DIR || path.join(root, ".ohol-run"),
  /** turn clock: a baby with nothing salient happening decides at most every this many turns */
  babyIdleTurns: Math.max(1, Math.floor(num("BABY_IDLE_TURNS", 10))),
};

export type Config = typeof config;
