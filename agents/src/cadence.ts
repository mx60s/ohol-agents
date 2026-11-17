// Fixed decision cadence, so every model acts at the same pace in game time.
//
// Without it the cadence is set by provider latency: a model that answers in
// 1 s decides 3x as often as one that answers in 6 s, which is a confound in
// any cross-model comparison (and a cost driver). The rule:
//
//   the start of one decision is at least DECISION_CYCLE_MS (default 8000)
//   after the start of the previous one, whatever the latency.
//
// Babies (age < 2) use BABY_DECISION_INTERVAL_MS instead. A turn that takes
// longer than the cycle (slow provider, long walk) starts the next one at once
// after its action: the loop is sequential (observe -> LLM -> act -> wait), so
// a cycle shorter than the latency never overlaps turns or queues requests;
// the agent just decides as fast as the provider allows.
//
// Contract for event-driven wake-ups (agent loop, agent/agent.ts): a wake-up
// may cut the wait short ONLY for a salient event (see SALIENT_WAKE_REASONS),
// and never earlier than MIN_WAKE_GAP_MS after the previous decision started.
// Any other wake-up (heard chatter, a stranger appearing) waits out the cycle.
// Use decisionWaitMs() for the normal wait and earlyWakeAllowed() to decide
// whether an event may end it. agent.ts currently computes the same wait from
// cfg.decisionIntervalMs (= decisionCycleMs), start to start.

import type { Config } from "./config.ts";

/** Events that may wake an agent before its cycle is up. */
export const SALIENT_WAKE_REASONS = [
  "own-baby-born", // a newborn whose mother is us appeared
  "baby-hungry", // a baby (ours or nearby) said "F" / is starving
  "spoken-to", // someone addressed us by name or as "you"
  "self-starving", // our food dropped to the starving threshold
  "attacked", // an animal or person hurt us / we are dying
  "death-nearby", // someone close to us died
  "connection", // connection closed or our character died (ends the loop anyway)
] as const;
export type WakeReason = (typeof SALIENT_WAKE_REASONS)[number] | (string & {});

/** even a salient event can't start a decision sooner than this after the previous start */
export const MIN_WAKE_GAP_MS = 1500;

export type CadenceConfig = Pick<Config, "decisionCycleMs" | "babyDecisionIntervalMs">;

/** The minimum start-to-start cycle for a character of this age (in game years). */
export function decisionCycleFor(cfg: CadenceConfig, ageYears: number | null): number {
  return ageYears != null && ageYears < 2 ? cfg.babyDecisionIntervalMs : cfg.decisionCycleMs;
}

/** How long to wait before the next decision, given when the previous one started. */
export function decisionWaitMs(cfg: CadenceConfig, turnStartedAt: number, ageYears: number | null, now = Date.now()): number {
  return Math.max(0, decisionCycleFor(cfg, ageYears) - (now - turnStartedAt));
}

/** May this wake-up end the wait early? Only salient events, and not within MIN_WAKE_GAP_MS of the last start. */
export function earlyWakeAllowed(reason: WakeReason, turnStartedAt: number, now = Date.now()): boolean {
  if (reason === "connection") return true;
  return (SALIENT_WAKE_REASONS as readonly string[]).includes(reason) && now - turnStartedAt >= MIN_WAKE_GAP_MS;
}
