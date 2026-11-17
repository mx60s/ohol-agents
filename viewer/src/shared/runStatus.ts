// Is anyone thinking? Model-provider and spend-cap state of the run, for the site's run bar and the
// stream's "lost in thought" banner. Pure; tested in tests/shared.test.mjs.

import type { RunInfo } from "../api-types.ts";

export type ThinkingState =
  /** agents think normally (or the run isn't going: idle / halted, nothing to say here) */
  | { kind: "ok" }
  /** the run paused because the model provider has been down past LLM_OUTAGE_PAUSE_S */
  | { kind: "llm-outage"; since: number | null; resumesAt: number | null }
  /** provider calls are failing but the run hasn't paused (yet): characters idle meanwhile */
  | { kind: "llm-failing"; since: number | null; resumesAt: number | null }
  /** the rolling 24h spend cap paused LLM calls */
  | { kind: "daily-cap"; since: number | null; resumesAt: number | null };

type RunLike = Pick<RunInfo, "status" | "pauseKind" | "pauseReason" | "resumesAt" | "llmStatus">;

export function thinkingState(run: RunLike | null | undefined): ThinkingState {
  if (!run || (run.status !== "running" && run.status !== "paused")) return { kind: "ok" };
  const llm = run.llmStatus;
  const failingSince = llm && !llm.ok ? (llm.outageSince ?? llm.since ?? null) : null;
  if (run.status === "paused") {
    if (run.pauseKind === "llm-outage") return { kind: "llm-outage", since: failingSince, resumesAt: run.resumesAt ?? llm?.retryAt ?? null };
    // older agents services sent no pauseKind: the only pause they had was the spend cap
    if (run.pauseKind === "daily-cap" || run.pauseKind == null) return { kind: "daily-cap", since: null, resumesAt: run.resumesAt ?? null };
  }
  if (llm && !llm.ok) return { kind: "llm-failing", since: llm.since ?? null, resumesAt: llm.retryAt ?? null };
  return { kind: "ok" };
}

/** a failing streak shorter than this (one 5xx, a timeout retried after 2 s) doesn't put up the stream banner */
export const STREAM_BANNER_GRACE_MS = 20_000;

/**
 * Stream: show "Our people are lost in thought" while the run is paused for a provider outage, or
 * provider calls have been failing for at least `graceMs`. Never for the spend cap. Clears by
 * itself as soon as the state recovers (it's derived from /api/state on every poll).
 */
export function lostInThought(run: RunLike | null | undefined, now: number, graceMs = STREAM_BANNER_GRACE_MS): boolean {
  const s = thinkingState(run);
  if (s.kind === "llm-outage") return true;
  if (s.kind !== "llm-failing") return false;
  return s.since == null || now - s.since >= graceMs;
}

export const LOST_IN_THOUGHT = "Our people are lost in thought. Back shortly.";

/**
 * Run bar: short status for a paused or not-thinking run, else null. `ago` is a formatted
 * duration ("4 min") supplied by the caller. Raw provider errors are not part of it (they may go
 * in a tooltip on the site, never on the stream).
 */
export function thinkingLabel(s: ThinkingState, ago: (ms: number) => string, now: number): string | null {
  const since = s.kind !== "ok" && s.since != null ? ` · ${ago(Math.max(0, now - s.since))}` : "";
  switch (s.kind) {
    case "llm-outage":
      return `paused: model provider unavailable${since}`;
    case "llm-failing":
      return `model provider unavailable${since}`;
    case "daily-cap":
      return `paused: daily spend cap${s.resumesAt != null && s.resumesAt > now ? ` · resumes in ${ago(s.resumesAt - now)}` : ""}`;
    default:
      return null;
  }
}
