// Stable run identity for CONTINUOUS mode (the always-on world).
//
// Login emails derive from the run id (`<runId>-a01@mts.local`), and the OHOL
// server hands a still-living body back to the same email on login. So when
// the agents service restarts (crash, hot update, supervisor restart) it must
// keep the run id, or every character is abandoned and every slot is born
// again. LOG_DIR/research/current-run.json remembers the current run:
//
//   { runId, runCount, createdAt, startedAt, halted, gameServerEpoch, eventsDir }
//
// decideRun() (pure) picks resume vs. fresh run; RunController writes the
// file. Non-continuous mode never reads or writes it.

import { existsSync, mkdirSync, openSync, readFileSync, readSync, closeSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface RunRecord {
  runId: string;
  /** n in "<base>-r<n>-<ts>" */
  runCount: number;
  createdAt: number;
  /** first start of the run (kept across resumes); null while idle */
  startedAt: number | null;
  /** halted runs are over: a restart starts a fresh one */
  halted: boolean;
  /** GAME_SERVER_EPOCH when the run was last attached (start.sh sets it when it launches the game server) */
  gameServerEpoch: string | null;
  /** event log dir of the latest process on this run (to continue the event seq) */
  eventsDir: string | null;
  updatedAt: number;
}

export interface RunDecisionInput {
  continuous: boolean;
  /** RUN_ID: the stable prefix */
  base: string;
  prev: RunRecord | null;
  /** NEW_RUN=1 or the one-shot new-run flag file */
  newRun: boolean;
  /** GAME_SERVER_EPOCH of the running game server ("" / null = unknown) */
  gameServerEpoch: string | null;
  /** keep the run across a game-server restart (only useful if bodies survive one) */
  resumeAcrossServerRestart: boolean;
  now: number;
}

export interface RunDecision {
  runId: string;
  runCount: number;
  resumed: boolean;
  /** human-readable, for the log */
  reason: string;
}

export function newRunId(base: string, runCount: number, now: number) {
  return `${base}-r${runCount}-${now.toString(36)}`;
}

/** Resume the previous run, or start a fresh one? */
export function decideRun(i: RunDecisionInput): RunDecision {
  const fresh = (reason: string): RunDecision => {
    const runCount = (i.prev && i.prev.runId.startsWith(`${i.base}-`) ? i.prev.runCount : 0) + 1;
    return { runId: newRunId(i.base, runCount, i.now), runCount, resumed: false, reason };
  };
  if (!i.continuous) return fresh("not continuous");
  const p = i.prev;
  if (!p) return fresh("no previous run");
  if (i.newRun) return fresh("NEW_RUN requested");
  if (!p.runId.startsWith(`${i.base}-`)) return fresh(`RUN_ID changed (previous run ${p.runId})`);
  if (p.halted) return fresh(`previous run ${p.runId} was halted`);
  if (!i.resumeAcrossServerRestart && i.gameServerEpoch && p.gameServerEpoch && i.gameServerEpoch !== p.gameServerEpoch)
    return fresh(`the game server restarted since run ${p.runId} (its characters are gone)`);
  return { runId: p.runId, runCount: p.runCount, resumed: true, reason: `resuming run ${p.runId}` };
}

export class RunStateFile {
  readonly file: string;
  /** one-shot "start a fresh run on the next start" marker (hot-update.sh --new-run) */
  readonly flagFile: string;

  constructor(logDir: string) {
    const dir = path.join(logDir, "research");
    mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, "current-run.json");
    this.flagFile = path.join(dir, "new-run.flag");
  }

  load(): RunRecord | null {
    if (!existsSync(this.file)) return null;
    try {
      const r = JSON.parse(readFileSync(this.file, "utf8")) as RunRecord;
      if (!r || typeof r.runId !== "string" || !r.runId) return null;
      return {
        runId: r.runId,
        runCount: Number.isFinite(r.runCount) ? r.runCount : 1,
        createdAt: r.createdAt ?? 0,
        startedAt: r.startedAt ?? null,
        halted: r.halted === true,
        gameServerEpoch: r.gameServerEpoch ?? null,
        eventsDir: r.eventsDir ?? null,
        updatedAt: r.updatedAt ?? 0,
      };
    } catch (e) {
      console.error(`unreadable ${this.file}; starting a fresh run`, e);
      return null;
    }
  }

  save(r: RunRecord) {
    try {
      const tmp = this.file + ".tmp";
      writeFileSync(tmp, JSON.stringify(r, null, 2) + "\n");
      renameSync(tmp, this.file);
    } catch (e) {
      console.error("current-run.json write failed", e);
    }
  }

  /** true (and the flag is removed) if a fresh run was requested via the flag file */
  takeNewRunFlag(): boolean {
    return this.takeNewRunFlagContent() != null;
  }

  /**
   * The flag file's content ("" for a plain flag), and the flag is removed;
   * null = no flag. After a world regeneration start.sh writes a JSON record
   * into it (regen.ts, parseWorldRegenerated).
   */
  takeNewRunFlagContent(): string | null {
    if (!existsSync(this.flagFile)) return null;
    let content = "";
    try {
      content = readFileSync(this.flagFile, "utf8");
    } catch {
      // a flag we can't read is still a flag
    }
    try {
      unlinkSync(this.flagFile);
    } catch {
      // ignore
    }
    return content;
  }
}

/**
 * Highest event seq in `<dir>/events.jsonl` (or its rotated `.1`), from the
 * file's tail. 0 if none. A resumed run continues the seq from there, so
 * viewers polling /api/events?since=<seq> keep receiving events.
 */
export function readLastSeq(dir: string | null): number {
  if (!dir) return 0;
  for (const f of ["events.jsonl", "events.jsonl.1"]) {
    const p = path.join(dir, f);
    let size = 0;
    try {
      size = statSync(p).size;
    } catch {
      continue;
    }
    if (!size) continue;
    const n = Math.min(size, 256 * 1024);
    const buf = Buffer.alloc(n);
    const fd = openSync(p, "r");
    try {
      readSync(fd, buf, 0, n, size - n);
    } finally {
      closeSync(fd);
    }
    let max = 0;
    for (const line of buf.toString("utf8").split("\n")) {
      const m = /^\{"seq":(\d+),/.exec(line);
      if (m) max = Math.max(max, Number(m[1]));
    }
    if (max) return max;
  }
  return 0;
}
