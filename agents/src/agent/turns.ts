// Durations the model sees are in TURNS, not seconds: models reason badly
// about wall-clock time, but "your food lasts about 6 turns" is actionable.
//
// One turn = one decision cycle (config.decisionCycleMs, default 8 s: the
// interval plus typical LLM latency). The game server's clock can run
// config.timeScale x slower than real time, so a game duration of g seconds
// takes g * timeScale real seconds.
//
// Units: two kinds of durations reach these helpers.
// - Game constants the client knows itself (60 s per year, the food drain
//   formula, decay times from the game data) are GAME seconds: use turnsFor /
//   turnsText / realMs, which multiply by timeScale.
// - Durations the server reports (HX food_time, PU age rate, PM eta) are
//   already WALL seconds (server/patches/time-scale.patch converts them): use
//   turnsForWall / turnsTextWall, which must not scale again.

export interface TurnClock {
  /** real ms per decision cycle */
  cycleMs: number;
  /** real seconds per game second (server clock dilation; 1 = stock speed) */
  timeScale: number;
}

const DEFAULT_CYCLE_MS = 8000;

/** Read the clock from config, tolerating fields that may not exist yet. */
export function turnClock(cfg: object): TurnClock {
  const c = cfg as { decisionCycleMs?: unknown; timeScale?: unknown };
  const cycleMs = typeof c.decisionCycleMs === "number" && c.decisionCycleMs > 0 ? c.decisionCycleMs : DEFAULT_CYCLE_MS;
  const timeScale = typeof c.timeScale === "number" && c.timeScale > 0 ? c.timeScale : 1;
  return { cycleMs, timeScale };
}

/** Number of turns a game duration spans (fractional). */
export function turnsFor(gameSeconds: number, clock: TurnClock): number {
  return (gameSeconds * clock.timeScale * 1000) / clock.cycleMs;
}

/** Number of turns a wall-clock duration spans (fractional): for server-reported times. */
export function turnsForWall(wallSeconds: number, clock: TurnClock): number {
  return (wallSeconds * 1000) / clock.cycleMs;
}

/** Real milliseconds for a game duration. */
export function realMs(gameSeconds: number, clock: TurnClock): number {
  return gameSeconds * clock.timeScale * 1000;
}

/** Game seconds that one real-ms span covers. */
export function gameSecondsFor(realMsSpan: number, clock: TurnClock): number {
  return realMsSpan / 1000 / clock.timeScale;
}

/** "about 6 turns", "less than 1 turn", "1 turn" (a game duration) */
export function turnsText(gameSeconds: number, clock: TurnClock): string {
  return turnCountText(turnsFor(gameSeconds, clock));
}

/** As turnsText, for a wall-clock duration the server reported. */
export function turnsTextWall(wallSeconds: number, clock: TurnClock): string {
  return turnCountText(turnsForWall(wallSeconds, clock));
}

function turnCountText(t: number): string {
  if (!Number.isFinite(t)) return "many turns";
  if (t < 0.75) return "less than 1 turn";
  const n = t < 10 ? Math.round(t) : Math.round(t / 5) * 5;
  return `${n === 1 ? "1 turn" : `about ${n} turns`}`;
}

/** Turns elapsed since a real timestamp: "2 turns ago", "just now". */
export function turnsAgo(realT: number, now: number, clock: TurnClock): string {
  const t = (now - realT) / clock.cycleMs;
  if (t < 0.75) return "just now";
  const n = Math.round(t);
  return n === 1 ? "1 turn ago" : `${n} turns ago`;
}
