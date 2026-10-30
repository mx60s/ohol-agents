// Run-wide event stream: in-memory ring buffer (for the API / SSE) plus
// append-only JSONL files on disk (for analysis).

import { mkdirSync, appendFileSync } from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import type { RunEvent, RunEventKind } from "./api-types.ts";

export class EventLog extends EventEmitter {
  private seq = 0;
  readonly recent: RunEvent[] = [];
  readonly dir: string;

  constructor(logDir: string, runId: string) {
    super();
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
      name: e.name ?? null,
      text: e.text,
      ...(e.data ? { data: e.data } : {}),
    };
    this.recent.push(ev);
    if (this.recent.length > 5000) this.recent.splice(0, 1000);
    this.write("events.jsonl", ev);
    this.emit("event", ev);
    return ev;
  }

  since(seq: number, max = 500): RunEvent[] {
    const out = this.recent.filter((e) => e.seq > seq);
    return out.slice(-max);
  }

  /** Raw records: llm calls, observations, protocol traffic, etc. */
  write(file: string, rec: unknown) {
    try {
      appendFileSync(path.join(this.dir, file), JSON.stringify(rec) + "\n");
    } catch (e) {
      console.error("log write failed", e);
    }
  }
}
