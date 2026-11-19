// Calibration scorecards: one short session per candidate model, scored from
// the run's own logs (llm.jsonl, events.jsonl). Pure functions; the CLI that
// runs a session is tools/calibrate.ts.
//
// Comparability: every card records timeScale (TIME_SCALE, game clock k x
// slower) and decisionCycleMs, and gives rates per wall-minute and per game
// year. One game year = 60 s x timeScale of wall time (stock OHOL: 60 s).

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { RunEvent } from "./api-types.ts";
import { classifyAction } from "./lives.ts";
import { parseReply } from "./agent/reply.ts";
import { rotatedFiles } from "./events.ts";

export const SCORECARD_VERSION = 2;
/** stock OHOL: one game year per real minute (times TIME_SCALE when the clock is dilated) */
export const BASE_YEAR_MS = 60_000;

export interface Milestone {
  /** wall minutes from run start */
  wallMin: number;
  /** game years from run start */
  gameYears: number;
  /** the item or action that counted */
  what: string;
}

export interface Scorecard {
  version: number;
  model: string;
  runId: string;
  startedAt: number;
  endedAt: number;
  wallMinutes: number;
  /** game years elapsed (wallMinutes / timeScale) */
  gameYears: number;
  agentCount: number;
  timeScale: number;
  decisionCycleMs: number;
  /** per-run LLM settings (reasoning effort, max_tokens, provider routing, streaming) */
  settings: RunSettings;
  /** observation built -> action dispatched, per LLM-decided action (action events' turnMs) */
  turnMs: { n: number; p50: number | null; p90: number | null; p99: number | null };
  llm: {
    /** successful provider calls by agents (replies, parseable or not) */
    calls: number;
    /** agent turns where the provider call failed (HTTP error, timeout, backing off) */
    callErrors: number;
    promptTokens: number;
    completionTokens: number;
    cachedTokens: number;
    reasoningTokens: number;
    /** cached / prompt tokens */
    cacheHitRate: number;
    /** sum of costUsd in llm.jsonl (agents only; parse-failed calls aren't logged with cost) */
    costUsd: number;
    /** whole-run spend reported by the client (agents + overhead), when the tool knows it */
    totalCostUsd: number | null;
    costPerAgentHourUsd: number;
    latencyMsP50: number | null;
    latencyMsP90: number | null;
    latencyMsP99: number | null;
    /** time to first token (streamed calls only, LLM_STREAM=1 / --stream); null when not measured */
    ttftMsP50: number | null;
    ttftMsP90: number | null;
    reasoningTokensPerCall: number;
    completionTokensPerCall: number;
    /** upstream provider that served each call (OpenRouter's response field) -> calls */
    providers: Record<string, number>;
    /** replies that weren't valid JSON / calls */
    jsonErrors: number;
    jsonErrorRate: number;
    /**
     * Replies that gave the agent nothing to do (a wasted turn): empty,
     * cut off by max_tokens before any usable JSON, or unparseable.
     * failedReplies = emptyReplies + truncatedReplies + jsonErrors (each reply counts once).
     */
    failedReplies: number;
    failedReplyRate: number;
    /** empty visible reply (typically the whole budget went to reasoning: finish_reason "length") */
    emptyReplies: number;
    /** non-empty but cut off (finish_reason "length") and not parseable */
    truncatedReplies: number;
    /** cut off (finish_reason "length") but the JSON was still usable: not a failure, shown for the cap's cost */
    truncatedButUsable: number;
  };
  decisions: { total: number; perWallMinute: number; perAgentWallMinute: number; perGameYear: number; perAgentGameYear: number };
  actions: { total: number; failed: number; failureRate: number; reflex: number };
  lives: {
    /** distinct characters played (a reconnect to the same body isn't a new life) */
    lives: number;
    eves: number;
    babies: number;
    deaths: number;
    deathsByCause: Record<string, number>;
    maxGeneration: number;
    /** babies whose fate at age 3 is known: died, or born at least 3 game years before the end */
    babiesAtRisk: number;
    babiesSurvivedPast3: number;
    babySurvivalPast3Rate: number | null;
    perWallMinute: { births: number; deaths: number };
    perGameYear: { births: number; deaths: number };
  };
  firsts: { sharpStone: Milestone | null; fire: Milestone | null; clothing: Milestone | null };
}

export interface RunSettings {
  reasoningEffort: string | null;
  maxTokens: number | null;
  providerSort: string | null;
  providerOrder: string[];
  allowFallbacks: boolean | null;
  stream: boolean;
}

export interface ScoreMeta {
  model: string;
  runId: string;
  startedAt: number;
  endedAt: number;
  agentCount: number;
  timeScale?: number;
  decisionCycleMs: number;
  totalCostUsd?: number | null;
  settings?: Partial<RunSettings>;
}

function readJsonl(file: string): any[] {
  const out: any[] = [];
  const gens = rotatedFiles(path.dirname(file), path.basename(file)).map((f) => path.join(path.dirname(file), f));
  for (const f of [...gens.slice(-1), file]) {
    if (!existsSync(f)) continue;
    for (const line of readFileSync(f, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        // torn line
      }
    }
  }
  return out;
}

export function percentile(xs: number[], p: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[i];
}

const SHARP_STONE = /\bSharp Stone\b/;
// a lit fire, not its tools (Fire Bow Drill, Fire Bow, Firewood...)
const FIRE = /\b(Fire|Small Fire|Large Fire|Hot Coals|Burning Tinder)\b(?! Bow| Drill)/;
const CLOTHING = /\b(Skirt|Hat|Shoe|Shoes|Coat|Sweater|Loincloth|Diaper|Backpack|Clothing)\b/;

/** items an event says were produced: craft newActor/newTarget, and "A -> B" results in action text */
export function productsOf(e: RunEvent): string[] {
  const out: string[] = [];
  if (e.kind === "craft") {
    for (const k of ["newActor", "newTarget"]) if (typeof e.data?.[k] === "string") out.push(e.data[k] as string);
    out.push(e.text);
  } else if (e.kind === "action") {
    const i = e.text.indexOf(" -> ");
    const result = i >= 0 ? e.text.slice(i + 4) : "";
    for (const m of result.matchAll(/ -> ([^;]+)/g)) out.push(m[1].trim());
    if (typeof e.data?.heldAfter === "string") out.push(e.data.heldAfter as string);
  }
  return out;
}

/** Score one finished session from its run dir (llm.jsonl, events.jsonl). */
export function scoreRun(runDir: string, meta: ScoreMeta): Scorecard {
  return scoreRecords(readJsonl(path.join(runDir, "llm.jsonl")), readJsonl(path.join(runDir, "events.jsonl")) as RunEvent[], meta);
}

export function scoreRecords(llm: any[], events: RunEvent[], meta: ScoreMeta): Scorecard {
  const timeScale = meta.timeScale && meta.timeScale > 0 ? meta.timeScale : 1;
  const yearMs = BASE_YEAR_MS * timeScale;
  const wallMs = Math.max(1, meta.endedAt - meta.startedAt);
  const wallMinutes = wallMs / 60_000;
  const gameYears = wallMs / yearMs;
  const agentHours = (meta.agentCount * wallMs) / 3_600_000;

  // --- LLM
  const replies = llm.filter((r) => typeof r.reply === "string");
  const errorLines = llm.filter((r) => r.error != null);
  // older agents logged a reply that didn't parse as { error, raw }: the call itself succeeded
  const rawErrors = errorLines.filter((r) => typeof r.raw === "string").length;
  const callErrors = errorLines.length - rawErrors;
  const calls = replies.length + rawErrors;
  // agent.ts now logs every reply (with finishReason) and parses it afterwards: classify each one
  let emptyReplies = 0, truncatedReplies = 0, truncatedButUsable = 0, unparseable = 0;
  for (const r of replies) {
    const cut = r.finishReason === "length" || r.finishReason === "max_tokens";
    if (!String(r.reply).trim()) emptyReplies++;
    else if (parseReply(r.reply).ok) {
      if (cut) truncatedButUsable++;
    } else if (cut) truncatedReplies++;
    else unparseable++;
  }
  const jsonErrors = rawErrors + unparseable;
  const failedReplies = emptyReplies + truncatedReplies + jsonErrors;
  const sum = (k: string) => replies.reduce((a, r) => a + (Number(r[k]) || 0), 0);
  const promptTokens = sum("promptTokens");
  const cachedTokens = sum("cachedTokens");
  const costUsd = sum("costUsd");
  const lat = replies.map((r) => Number(r.latencyMs)).filter((x) => Number.isFinite(x));
  const ttft = replies.map((r) => r.ttftMs).filter((x): x is number => typeof x === "number" && Number.isFinite(x));
  const providers: Record<string, number> = {};
  for (const r of replies) if (typeof r.provider === "string" && r.provider) providers[r.provider] = (providers[r.provider] ?? 0) + 1;
  const turns: number[] = [];

  // --- events
  const evs = [...events].sort((a, b) => a.t - b.t || a.seq - b.seq);
  const lifeKey = (e: RunEvent) => `${e.agentId}|${Number(e.data?.playerId ?? e.playerId)}`;
  const born = new Map<string, { t: number; eve: boolean; gen: number; age0: number }>();
  const died = new Map<string, { t: number; age: number | null; reason: string }>();
  let actions = 0, failed = 0, reflex = 0;
  const firsts: Scorecard["firsts"] = { sharpStone: null, fire: null, clothing: null };
  const mark = (k: keyof Scorecard["firsts"], t: number, what: string) => {
    if (firsts[k]) return;
    const ms = Math.max(0, t - meta.startedAt);
    firsts[k] = { wallMin: round(ms / 60_000, 2), gameYears: round(ms / yearMs, 2), what };
  };
  for (const e of evs) {
    if (e.kind === "birth" && e.agentId) {
      const k = lifeKey(e);
      if (!born.has(k)) born.set(k, { t: e.t, eve: e.data?.eve === true, gen: Number(e.data?.generation) || 1, age0: Number(e.data?.age) || 0 });
    } else if (e.kind === "death" && e.agentId) {
      const k = lifeKey(e);
      if (!died.has(k)) {
        const age = Number(e.data?.age);
        died.set(k, { t: e.t, age: Number.isFinite(age) ? age : null, reason: String(e.data?.reason ?? "unknown").replace(/^reason_/, "") });
      }
    } else if (e.kind === "action" && typeof e.data?.remember !== "string" && typeof e.data?.forget !== "string") {
      const c = classifyAction(e);
      actions++;
      if (c.failedActions) failed++;
      if (e.data?.reflex === true) reflex++;
      const tm = Number(e.data?.turnMs);
      if (e.data?.turnMs != null && Number.isFinite(tm)) turns.push(tm);
      if (c.wear) mark("clothing", e.t, `wore ${String(e.data?.heldBefore ?? "clothing")}`);
    }
    if (e.kind === "craft" || e.kind === "action") {
      for (const p of productsOf(e)) {
        if (SHARP_STONE.test(p)) mark("sharpStone", e.t, p);
        if (FIRE.test(p)) mark("fire", e.t, p);
        if (CLOTHING.test(p)) mark("clothing", e.t, p);
      }
    }
  }
  const deathsByCause: Record<string, number> = {};
  for (const d of died.values()) deathsByCause[d.reason] = (deathsByCause[d.reason] ?? 0) + 1;
  let babies = 0, atRisk = 0, survived = 0, eves = 0, maxGen = 0;
  for (const [k, b] of born) {
    maxGen = Math.max(maxGen, b.gen);
    if (b.eve) {
      eves++;
      continue;
    }
    babies++;
    const d = died.get(k);
    if (d) {
      atRisk++;
      const age = d.age ?? b.age0 + (d.t - b.t) / yearMs;
      if (age >= 3) survived++;
    } else if (b.age0 + (meta.endedAt - b.t) / yearMs >= 3) {
      atRisk++;
      survived++;
    }
  }

  return {
    version: SCORECARD_VERSION,
    model: meta.model, runId: meta.runId, startedAt: meta.startedAt, endedAt: meta.endedAt,
    wallMinutes: round(wallMinutes, 2), gameYears: round(gameYears, 2),
    agentCount: meta.agentCount, timeScale, decisionCycleMs: meta.decisionCycleMs,
    settings: {
      reasoningEffort: meta.settings?.reasoningEffort || null, maxTokens: meta.settings?.maxTokens ?? null,
      providerSort: meta.settings?.providerSort || null, providerOrder: meta.settings?.providerOrder ?? [],
      allowFallbacks: meta.settings?.allowFallbacks ?? null, stream: meta.settings?.stream ?? false,
    },
    turnMs: { n: turns.length, p50: percentile(turns, 50), p90: percentile(turns, 90), p99: percentile(turns, 99) },
    llm: {
      calls, callErrors, promptTokens, completionTokens: sum("completionTokens"), cachedTokens, reasoningTokens: sum("reasoningTokens"),
      cacheHitRate: promptTokens ? round(cachedTokens / promptTokens, 4) : 0,
      costUsd: round(costUsd, 6), totalCostUsd: meta.totalCostUsd ?? null,
      costPerAgentHourUsd: round((meta.totalCostUsd ?? costUsd) / Math.max(agentHours, 1e-9), 4),
      latencyMsP50: percentile(lat, 50), latencyMsP90: percentile(lat, 90), latencyMsP99: percentile(lat, 99),
      ttftMsP50: percentile(ttft, 50), ttftMsP90: percentile(ttft, 90),
      reasoningTokensPerCall: replies.length ? round(sum("reasoningTokens") / replies.length, 1) : 0,
      completionTokensPerCall: replies.length ? round(sum("completionTokens") / replies.length, 1) : 0,
      providers,
      jsonErrors, jsonErrorRate: calls ? round(jsonErrors / calls, 4) : 0,
      failedReplies, failedReplyRate: calls ? round(failedReplies / calls, 4) : 0,
      emptyReplies, truncatedReplies, truncatedButUsable,
    },
    decisions: {
      total: calls,
      perWallMinute: round(calls / wallMinutes, 3),
      perAgentWallMinute: round(calls / wallMinutes / Math.max(1, meta.agentCount), 3),
      perGameYear: round(calls / gameYears, 3),
      perAgentGameYear: round(calls / gameYears / Math.max(1, meta.agentCount), 3),
    },
    actions: { total: actions, failed, failureRate: actions ? round(failed / actions, 4) : 0, reflex },
    lives: {
      lives: born.size, eves, babies, deaths: died.size, deathsByCause, maxGeneration: maxGen,
      babiesAtRisk: atRisk, babiesSurvivedPast3: survived, babySurvivalPast3Rate: atRisk ? round(survived / atRisk, 4) : null,
      perWallMinute: { births: round(born.size / wallMinutes, 3), deaths: round(died.size / wallMinutes, 3) },
      perGameYear: { births: round(born.size / gameYears, 3), deaths: round(died.size / gameYears, 3) },
    },
    firsts,
  };
}

function round(x: number, d: number) {
  const f = 10 ** d;
  return Math.round(x * f) / f;
}

const pct = (x: number | null) => (x == null ? "-" : `${(x * 100).toFixed(1)}%`);
const sec = (ms: number | null) => (ms == null ? "-" : (ms / 1000).toFixed(1));
const yrs = (m: Milestone | null) => (m ? m.gameYears.toFixed(1) : "-");

/** Markdown table comparing several scorecards (one row per card). */
export function summaryTable(cards: Scorecard[]): string {
  const head = [
    "model", "reasoning", "max tok", "provider pref", "served by", "time scale", "cycle s", "wall min", "game yrs", "agents", "calls", "cost $", "$/agent-h", "cache hit", "latency p50/p90 s", "TTFT p50 s", "turn p50/p90/p99 s", "reasoning tok/call",
    "decisions/agent-min", "decisions/agent-yr", "failed replies (empty/cut/JSON)", "JSON err", "action fail", "lives (Eves)", "deaths/game-yr", "top death causes", "max gen",
    "babies >3 (n/at risk)", "first Sharp Stone (yr)", "first fire (yr)", "first clothing (yr)",
  ];
  const rows = cards.map((c) => {
    const causes = Object.entries(c.lives.deathsByCause).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k} ${v}`).join(", ") || "-";
    const st = c.settings ?? ({} as Partial<RunSettings>);
    const pref = [st.providerSort, st.providerOrder?.length ? st.providerOrder.join(">") + (st.allowFallbacks === false ? " only" : "") : null].filter(Boolean).join(" ") || "-";
    const served = Object.entries(c.llm.providers ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k, v]) => `${k} ${v}`).join(", ") || "-";
    const t = c.turnMs ?? { p50: null, p90: null, p99: null };
    return [
      c.model, st.reasoningEffort ?? "default", st.maxTokens ?? "-", pref, served, c.timeScale, c.decisionCycleMs / 1000, c.wallMinutes, c.gameYears, c.agentCount, c.llm.calls,
      (c.llm.totalCostUsd ?? c.llm.costUsd).toFixed(3), c.llm.costPerAgentHourUsd.toFixed(3), pct(c.llm.cacheHitRate),
      `${sec(c.llm.latencyMsP50)}/${sec(c.llm.latencyMsP90)}`, sec(c.llm.ttftMsP50 ?? null), `${sec(t.p50)}/${sec(t.p90)}/${sec(t.p99)}`, c.llm.reasoningTokensPerCall ?? "-", c.decisions.perAgentWallMinute, c.decisions.perAgentGameYear,
      c.llm.failedReplyRate == null ? "-" : `${pct(c.llm.failedReplyRate)} (${c.llm.emptyReplies}/${c.llm.truncatedReplies}/${c.llm.jsonErrors})`,
      pct(c.llm.jsonErrorRate), pct(c.actions.failureRate), `${c.lives.lives} (${c.lives.eves})`, c.lives.perGameYear.deaths, causes,
      c.lives.maxGeneration, `${c.lives.babiesSurvivedPast3}/${c.lives.babiesAtRisk}`, yrs(c.firsts.sharpStone), yrs(c.firsts.fire), yrs(c.firsts.clothing),
    ].map(String);
  });
  const line = (cells: string[]) => `| ${cells.map((s) => s.replace(/\|/g, "\\|")).join(" | ")} |`;
  return [line(head), line(head.map(() => "---")), ...rows.map(line)].join("\n") + "\n";
}
