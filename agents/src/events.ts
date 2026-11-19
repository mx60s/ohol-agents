// Run-wide event stream: in-memory ring buffer (for the API / SSE) plus
// append-only JSONL files on disk (for analysis).

import { mkdirSync, appendFileSync, existsSync, readdirSync, renameSync, statSync, statfsSync, unlinkSync } from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import type { RunEvent, RunEventKind } from "./api-types.ts";
import { cleanText, sanitizeData } from "./safety.ts";

/** caps for everything that reaches /api/events, SSE and the per-life logs */
export const EVENT_TEXT_MAX = 1000;
export const EVENT_NAME_MAX = 60;
/**
 * default size at which a raw log file is rotated: llm.jsonl is renamed to
 * llm.<UTC stamp>.jsonl (e.g. llm.20261118T194512Z.jsonl), a name that never
 * changes afterwards, so an off-site backup can copy each rotated file once.
 */
export const LOG_MAX_FILE_BYTES = 32 * 1024 * 1024;
/**
 * default cap on all run dirs' files under LOG_DIR together: a last-resort
 * safety only (everything is kept and backed up off-site, deploy/backup-logs.sh).
 * Past it the oldest rotated files that are older than PRUNE_MIN_AGE_MS are
 * deleted (live files never). /data auto-extends to 10 GB.
 */
export const LOG_MAX_TOTAL_BYTES = 8192 * 1024 * 1024;
/** the cap never deletes a rotated file younger than this: the backup (every 3 h) has had several chances to copy it */
export const PRUNE_MIN_AGE_MS = 24 * 3600_000;
/** warn (at most hourly) when the log volume is fuller than this */
export const DISK_WARN_FRACTION = 0.8;

/** "llm.jsonl" + Date -> "llm.20261118T194512Z.jsonl" */
export function rotatedName(file: string, at: Date): string {
  const stamp = at.toISOString().replace(/\.\d+Z$/, "Z").replace(/[-:]/g, "");
  const ext = path.extname(file);
  return `${file.slice(0, file.length - ext.length)}.${stamp}${ext}`;
}

/**
 * The rotated generations of `file` (e.g. "events.jsonl") in `dir`, oldest first: legacy
 * <file>.N (highest N oldest), then <stem>.<YYYYMMDDTHHMMSSZ>[-k]<ext> by stamp. File names only.
 */
export function rotatedFiles(dir: string, file: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const ext = path.extname(file);
  const stem = file.slice(0, file.length - ext.length);
  const legacy: { f: string; n: number }[] = [];
  const stamped: { f: string; stamp: string; k: number }[] = [];
  const stampRe = new RegExp(`^${escapeRe(stem)}\\.(\\d{8}T\\d{6}Z)(?:-(\\d+))?${escapeRe(ext)}$`);
  for (const f of names) {
    if (f.startsWith(file + ".") && /^\d+$/.test(f.slice(file.length + 1))) legacy.push({ f, n: Number(f.slice(file.length + 1)) });
    const m = stampRe.exec(f);
    if (m) stamped.push({ f, stamp: m[1], k: m[2] ? Number(m[2]) : 1 });
  }
  legacy.sort((a, b) => b.n - a.n);
  stamped.sort((a, b) => (a.stamp < b.stamp ? -1 : a.stamp > b.stamp ? 1 : a.k - b.k));
  return [...legacy.map((x) => x.f), ...stamped.map((x) => x.f)];
}

/** is `f` a rotated (closed, never written again) log file: <file>.N or <stem>.<stamp>[-k].<ext> */
export function isRotatedLogFile(f: string): boolean {
  return /\.jsonl\.\d+$/.test(f) || /\.\d{8}T\d{6}Z(?:-\d+)?\.jsonl$/.test(f);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export class EventLog extends EventEmitter {
  private seq = 0;
  readonly recent: RunEvent[] = [];
  readonly dir: string;
  private sizes = new Map<string, number>();
  private lastWriteError = 0;
  private lastDiskWarn = 0;
  private lastCapWarn = 0;

  /** maxFileBytes: rotate each raw file past this size (0 = never) */
  /** startSeq: continue a resumed run's event seq (see runstate.ts readLastSeq) */
  /** maxTotalBytes: last-resort cap on all run dirs under logDir together, enforced by deleting the oldest rotated files older than PRUNE_MIN_AGE_MS (0 = none) */
  constructor(private logDir: string, runId: string, private maxFileBytes = LOG_MAX_FILE_BYTES, startSeq = 0, private maxTotalBytes = LOG_MAX_TOTAL_BYTES) {
    super();
    this.seq = Math.max(0, Math.floor(startSeq));
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    this.dir = path.join(logDir, `${runId}-${stamp}`);
    mkdirSync(this.dir, { recursive: true });
  }

  emitEvent(kind: RunEventKind, e: Partial<Omit<RunEvent, "seq" | "t" | "kind">> & { text: string }): RunEvent {
    const ev: RunEvent = {
      seq: ++this.seq,
      t: Date.now(),
      kind,
      agentId: e.agentId ?? null,
      playerId: e.playerId ?? null,
      // last line of defence for model/game text: no control or invisible chars, bounded size
      name: e.name ? cleanText(e.name, EVENT_NAME_MAX) || null : null,
      text: cleanText(e.text, EVENT_TEXT_MAX),
      ...(e.data ? { data: sanitizeData(e.data) as Record<string, unknown> } : {}),
    };
    this.recent.push(ev);
    if (this.recent.length > 5000) this.recent.splice(0, 1000);
    this.write("events.jsonl", ev);
    // listeners (life store, director, story, SSE) run inside agents' timers and socket handlers:
    // one that throws must not skip the others or escape as an uncaught exception that kills the process
    for (const fn of this.listeners("event")) {
      try {
        (fn as (e: RunEvent) => void)(ev);
      } catch (err) {
        console.error("event listener failed", kind, err);
      }
    }
    return ev;
  }

  since(seq: number, max = 500): RunEvent[] {
    const out = this.recent.filter((e) => e.seq > seq);
    return out.slice(-max);
  }

  /**
   * Raw records: llm calls, observations, protocol traffic, etc. In an
   * always-on run llm.jsonl alone grows ~150 MB/day, so each file is rotated
   * at maxFileBytes to <stem>.<UTC stamp>.jsonl (see rotatedName), a stable
   * name the off-site backup copies once. Everything is kept; only past
   * maxTotalBytes (a last-resort safety) do the oldest rotated files go.
   */
  write(file: string, rec: unknown) {
    const p = path.join(this.dir, file);
    const line = JSON.stringify(rec) + "\n";
    const bytes = Buffer.byteLength(line);
    let size = this.sizes.get(file);
    if (size == null) {
      try {
        size = statSync(p).size;
      } catch {
        size = 0;
      }
    }
    try {
      if (this.maxFileBytes > 0 && size > 0 && size + bytes > this.maxFileBytes) {
        this.rotate(file);
        size = 0;
      }
      appendFileSync(p, line);
      this.sizes.set(file, size + bytes);
    } catch (e) {
      this.sizes.delete(file); // re-stat next time
      // disk full fails every write: say so once a minute, not hundreds of times
      if (Date.now() - this.lastWriteError > 60_000) {
        this.lastWriteError = Date.now();
        console.error("log write failed", e);
      }
    }
  }

  /** <file> -> <stem>.<stamp>.<ext> (-2, -3, ... if that name is taken); then check the disk and prune to the total cap */
  private rotate(file: string) {
    const p = path.join(this.dir, file);
    const name = rotatedName(file, new Date());
    const ext = path.extname(name);
    let target = path.join(this.dir, name);
    for (let k = 2; existsSync(target); k++) target = path.join(this.dir, `${name.slice(0, name.length - ext.length)}-${k}${ext}`);
    renameSync(p, target);
    try {
      this.checkDisk();
      this.prune();
    } catch (e) {
      console.error("log prune failed", e);
    }
  }

  /** a clear warning (at most hourly) when the log volume passes DISK_WARN_FRACTION */
  private checkDisk() {
    const fs = statfsSync(this.logDir);
    const total = fs.blocks * fs.bsize;
    if (!(total > 0)) return;
    const used = 1 - (fs.bavail * fs.bsize) / total;
    if (used > DISK_WARN_FRACTION && Date.now() - this.lastDiskWarn > 3600_000) {
      this.lastDiskWarn = Date.now();
      console.warn(
        `WARNING: log volume ${this.logDir} is ${(used * 100).toFixed(0)}% full (${(total / 1e9).toFixed(1)} GB). ` +
          `Logs are kept, not deleted, until LOG_MAX_TOTAL_MB; run deploy/backup-logs.sh and grow the volume.`,
      );
    }
  }

  /**
   * Last resort: while everything in the run dirs is over maxTotalBytes, delete the oldest
   * rotated files, but never one younger than PRUNE_MIN_AGE_MS (the backup has not necessarily
   * copied it yet). Live files are never deleted.
   */
  private prune() {
    if (!(this.maxTotalBytes > 0)) return;
    let total = 0;
    const rotated: { p: string; size: number; mtime: number }[] = [];
    for (const d of readdirSync(this.logDir, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const dir = path.join(this.logDir, d.name);
      for (const f of readdirSync(dir)) {
        try {
          const st = statSync(path.join(dir, f));
          if (!st.isFile()) continue;
          total += st.size;
          if (isRotatedLogFile(f)) rotated.push({ p: path.join(dir, f), size: st.size, mtime: st.mtimeMs });
        } catch {
          // gone meanwhile
        }
      }
    }
    if (total <= this.maxTotalBytes) return;
    rotated.sort((a, b) => a.mtime - b.mtime);
    const cutoff = Date.now() - PRUNE_MIN_AGE_MS;
    for (const r of rotated) {
      if (total <= this.maxTotalBytes) break;
      if (r.mtime > cutoff) break; // sorted: everything after is younger too
      console.warn(`WARNING: log cap LOG_MAX_TOTAL_MB reached: deleting ${r.p} (${(r.size / 1e6).toFixed(1)} MB)`);
      unlinkSync(r.p);
      total -= r.size;
    }
    if (total > this.maxTotalBytes && Date.now() - this.lastCapWarn > 3600_000) {
      this.lastCapWarn = Date.now();
      console.warn(`WARNING: logs exceed LOG_MAX_TOTAL_MB (${(total / 1e6).toFixed(0)} MB) but nothing older than 24 h is left to prune; keeping everything`);
    }
  }
}
