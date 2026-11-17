// World regeneration on extinction (CONTINUOUS mode, the always-on world).
//
// When the run has had characters and now has none (no life of the run alive
// or possibly alive, no slot connecting or in the world) for EXTINCT_GRACE_S,
// the agents service asks the supervisor (deploy/start.sh) to wipe the world
// and start a fresh one: it writes REGEN_REQUEST_FILE (the reason) and sends
// SIGUSR2 to the supervisor's pid (SUPERVISOR_PIDFILE). The supervisor stops
// the agents and the game server, archives and deletes the world files, sets
// the new-run flag and starts both again (see deploy/README.md).
//
// Logins are held from the moment the run is extinct, so no fresh Eve is born
// into the old world while the grace period runs: the login scheduler's pause
// gate asks holdLogins(), which evaluates extinction right then, not from the
// last tick. A slot already past the gate counts as in the world (status
// "connecting"), and if it is born the run is not extinct any more and the
// timer resets. A halted or not-yet-started run is never extinct.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface RegenSettings {
  /** REGEN_ON_EXTINCTION (default on in CONTINUOUS mode, off otherwise; never outside CONTINUOUS) */
  enabled: boolean;
  /** EXTINCT_GRACE_S (default 180) in ms */
  graceMs: number;
  /** REGEN_REQUEST_FILE: set by a start.sh that handles SIGUSR2; null = no such supervisor */
  requestFile: string | null;
  /** SUPERVISOR_PIDFILE (default /tmp/as-supervisor.pid) */
  pidFile: string;
  /** REGEN_TIMEOUT_S (default 600): still running this long after a request = the supervisor didn't act; logins resume */
  timeoutMs: number;
}

export function regenSettingsFromEnv(env: NodeJS.ProcessEnv, continuous: boolean): RegenSettings {
  const num = (k: string, d: number) => {
    const v = Number(env[k]);
    return env[k] != null && env[k] !== "" && Number.isFinite(v) ? v : d;
  };
  const flag = env.REGEN_ON_EXTINCTION;
  return {
    enabled: continuous && (flag == null || flag === "" ? true : flag !== "0"),
    graceMs: Math.max(0, num("EXTINCT_GRACE_S", 180)) * 1000,
    requestFile: env.REGEN_REQUEST_FILE || null,
    pidFile: env.SUPERVISOR_PIDFILE || "/tmp/as-supervisor.pid",
    timeoutMs: Math.max(0, num("REGEN_TIMEOUT_S", 600)) * 1000,
  };
}

/** What the watch looks at, sampled when asked (never cached). */
export interface ExtinctionSample {
  /** the run is started and not halted (a halted run holds its population: not extinction) */
  running: boolean;
  /** the run has had at least one life (a fresh run's starting logins are not "extinct") */
  everLived: boolean;
  /** lives of the run that are alive or possibly alive (lives.ts possiblyAlive) */
  living: number;
  /** agent slots connecting or alive (a login past the gate) */
  inWorld: number;
}

/**
 * inactive: off, or the run isn't being played (idle, halted, paused);
 * alive: someone is (or may be) alive or on the way in; extinct: in the grace
 * period; due: extinct for graceMs, not requested yet; requested: done.
 */
export type ExtinctionState = "inactive" | "alive" | "extinct" | "due" | "requested";

/**
 * Pure detector. update(now) samples and reports the state; due(now) is true
 * exactly once, the first time the run has been extinct for graceMs (the
 * caller then asks the supervisor). holdLogins(now) is the login gate: true
 * while the run is extinct or a request is out.
 */
export class ExtinctionWatch {
  extinctSince: number | null = null;
  /** when the regeneration was requested (fire() returned true); null = not yet */
  requestedAt: number | null = null;
  /** no more requests from this process (a request failed or timed out); logins flow again */
  disabled = false;

  constructor(private graceMs: number, private sample: () => ExtinctionSample) {}

  /** Re-sample and report the state (no side effect but the grace timer). */
  update(now: number): ExtinctionState {
    if (this.disabled) return "inactive";
    if (this.requestedAt != null) return "requested";
    const s = this.sample();
    if (!(s.running && s.everLived && s.living === 0 && s.inWorld === 0)) {
      this.extinctSince = null;
      return s.running ? "alive" : "inactive";
    }
    this.extinctSince ??= now;
    return now - this.extinctSince < this.graceMs ? "extinct" : "due";
  }

  /** true exactly once: the grace period has run out (marks the request as out) */
  due(now: number): boolean {
    if (this.update(now) !== "due") return false;
    this.requestedAt = now;
    return true;
  }

  /** login gate: hold every login while extinct or while a request is out */
  holdLogins(now: number): boolean {
    const st = this.update(now);
    return st === "extinct" || st === "due" || st === "requested";
  }

  /** stop holding and stop requesting (the supervisor can't regenerate) */
  disable() {
    this.disabled = true;
    this.extinctSince = null;
  }
}

/** What the agents tell the supervisor (REGEN_REQUEST_FILE), and what comes back in the new-run flag. */
export interface RegenRequest {
  reason: string;
  runId: string | null;
  at: number;
}

/** in the new-run flag the supervisor writes after a regeneration (start.sh finish_regen) */
export interface WorldRegenerated {
  worldRegenerated: true;
  reason?: string;
  previousRunId?: string | null;
  requestedAt?: number;
  /** archive dir of the old world, or null if it couldn't be archived */
  archive?: string | null;
  /** UTC stamp of the regeneration (the archive's name) */
  at?: string;
}

/**
 * Parse the new-run flag's content: a WorldRegenerated record, or null (an
 * empty / plain flag). start.sh writes
 * {"worldRegenerated":true,"at":..,"archive":..,"request":<REGEN_REQUEST_FILE>}.
 */
export function parseWorldRegenerated(content: string | null): WorldRegenerated | null {
  if (!content || !content.trim()) return null;
  try {
    const j = JSON.parse(content) as Record<string, unknown> | null;
    if (!j || j.worldRegenerated !== true) return null;
    const req = (j.request && typeof j.request === "object" ? j.request : {}) as Partial<RegenRequest>;
    const str = (v: unknown) => (typeof v === "string" ? v : undefined);
    return {
      worldRegenerated: true,
      reason: str(j.reason) ?? str(req.reason),
      previousRunId: str(j.previousRunId) ?? str(req.runId) ?? null,
      requestedAt: typeof req.at === "number" ? req.at : undefined,
      archive: str(j.archive) ?? null,
      at: str(j.at),
    };
  } catch {
    // a hand-written request that wasn't JSON breaks the record, not the fact
    return /"worldRegenerated":\s*true/.test(content) ? { worldRegenerated: true } : null;
  }
}

/** The "world regenerated: ..." text for the new run's system event. */
export function worldRegeneratedText(w: WorldRegenerated): string {
  const parts = [`world regenerated: ${w.reason ?? "requested"}`];
  if (w.previousRunId) parts.push(`previous run ${w.previousRunId}`);
  parts.push(w.archive ? `old world archived to ${w.archive}` : "old world not archived");
  return parts.join("; ");
}

/**
 * Ask the supervisor to regenerate: write the request file, then SIGUSR2 its
 * pid. Returns null on success, else why it couldn't (the caller logs it and
 * lets the run go on in the old world).
 */
export function requestRegen(
  s: Pick<RegenSettings, "requestFile" | "pidFile">,
  req: RegenRequest,
  kill: (pid: number, sig: NodeJS.Signals) => void = process.kill,
): string | null {
  if (!s.requestFile) return "no REGEN_REQUEST_FILE (not run by a start.sh that regenerates worlds)";
  if (!existsSync(s.pidFile)) return `no supervisor pid file ${s.pidFile}`;
  const pid = Number(readFileSync(s.pidFile, "utf8").trim());
  if (!Number.isInteger(pid) || pid <= 1) return `bad pid in ${s.pidFile}`;
  try {
    mkdirSync(path.dirname(s.requestFile), { recursive: true });
    const tmp = `${s.requestFile}.tmp`;
    writeFileSync(tmp, JSON.stringify(req) + "\n");
    renameSync(tmp, s.requestFile);
  } catch (e) {
    return `can't write ${s.requestFile}: ${(e as Error).message}`;
  }
  try {
    kill(pid, "SIGUSR2");
  } catch (e) {
    return `can't signal the supervisor (pid ${pid}): ${(e as Error).message}`;
  }
  return null;
}
