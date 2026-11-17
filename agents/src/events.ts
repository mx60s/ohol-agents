// Run-wide event stream: in-memory ring buffer (for the API / SSE) plus
// append-only JSONL files on disk (for analysis).

import { mkdirSync, appendFileSync, renameSync, statSync } from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import type { RunEvent, RunEventKind } from "./api-types.ts";
import { cleanText, sanitizeData } from "./safety.ts";

/** caps for everything that reaches /api/events, SSE and the per-life logs */
export const EVENT_TEXT_MAX = 1000;
export const EVENT_NAME_MAX = 60;
/** default size at which a raw log file is rotated to <file>.1 (the previous .1 is dropped) */
export const LOG_MAX_FILE_BYTES = 32 * 1024 * 1024;

export class EventLog extends EventEmitter {
  private seq = 0;
  readonly recent: RunEvent[] = [];
  readonly dir: string;
  private sizes = new Map<string, number>();
  private lastWriteError = 0;

  /** maxFileBytes: rotate each raw file past this size (0 = never); keeps disk use per file under ~2x this */
  /** startSeq: continue a resumed run's event seq (see runstate.ts readLastSeq) */
  constructor(logDir: string, runId: string, private maxFileBytes = LOG_MAX_FILE_BYTES, startSeq = 0) {
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
   * at maxFileBytes (one previous generation kept as <file>.1).
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
        renameSync(p, `${p}.1`);
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
}
