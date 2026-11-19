// What the agent chose to remember (the reply's "remember"), kept verbatim.
// Replaces the note-taker's yearly notes (memory.ts, now off by default): the
// agent decides what to keep, for any reason. Each entry is the cleaned text
// as written (up to REMEMBER_CHARS) with when it was made; nothing is
// rewritten, filtered or summarised. Up to MEMORY_MAX_ENTRIES (default 25) entries: a new one past
// that drops the oldest unless the agent lets one go ("forget": a number as
// listed in THINGS YOU CHOSE TO REMEMBER, or the exact text). Saved per agent
// for the current life (like known names) so a restart keeps it.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { turnsAgo, type TurnClock } from "./turns.ts";

/** entries kept at once by default (MEMORY_MAX_ENTRIES) */
export const KEPT_MAX = 25;

export interface KeptEntry {
  /** when it was made (World.now ms, the clock turn ages are counted on) */
  t: number;
  text: string;
}

/** what is saved per agent (one file, the current life) */
export interface KeptFile {
  playerId: number;
  entries: KeptEntry[];
}

export type RememberResult = { kind: "kept"; dropped?: string } | { kind: "already" } | { kind: "empty" };
export type ForgetResult = { ok: true; text: string } | { ok: false; error: string };

export class KeptMemory {
  /** the life (player id) these entries belong to */
  playerId: number | null = null;
  entries: KeptEntry[] = [];

  constructor(readonly file: string | null = null, readonly max = KEPT_MAX) {}

  get texts(): string[] {
    return this.entries.map((e) => e.text);
  }

  /** a new life: nothing remembered */
  reset(playerId: number | null) {
    this.playerId = playerId;
    this.entries = [];
    this.save();
  }

  /** the same life after a restart: the entries saved for it (false if none were saved for this player) */
  restore(playerId: number): boolean {
    this.playerId = playerId;
    this.entries = [];
    if (!this.file) return false;
    try {
      const d = JSON.parse(readFileSync(this.file, "utf8")) as KeptFile;
      if (d?.playerId !== playerId || !Array.isArray(d.entries)) return false;
      for (const e of d.entries) if (typeof e?.text === "string" && e.text && Number.isFinite(e.t)) this.entries.push({ t: e.t, text: e.text });
      this.entries = this.entries.slice(-this.max);
      return true;
    } catch {
      return false;
    }
  }

  toJSON(): KeptFile {
    return { playerId: this.playerId ?? 0, entries: this.entries };
  }

  private save() {
    if (!this.file || this.playerId == null) return;
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.toJSON()) + "\n");
      renameSync(tmp, this.file);
    } catch (e) {
      console.error("kept memory save failed", e);
    }
  }

  /** Keep this text (already cleaned) as made at t. An exact duplicate is not added; past max the oldest is dropped. */
  remember(text: string, t: number): RememberResult {
    if (!text.trim()) return { kind: "empty" };
    if (this.entries.some((e) => e.text === text)) return { kind: "already" };
    this.entries.push({ t, text });
    const dropped = this.entries.length > this.max ? this.entries.shift()!.text : undefined;
    this.save();
    return dropped != null ? { kind: "kept", dropped } : { kind: "kept" };
  }

  /** Let one go: its number as listed (1 = oldest) or its exact text (case and spacing aside). */
  forget(ref: number | string): ForgetResult {
    if (!this.entries.length) return { ok: false, error: "nothing let go: you remember nothing" };
    let i: number;
    if (typeof ref === "number") {
      i = ref - 1;
      if (!Number.isInteger(ref) || i < 0 || i >= this.entries.length) return { ok: false, error: `nothing let go: there is no memory ${ref} (you have ${this.entries.length})` };
    } else {
      const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
      i = this.entries.findIndex((e) => e.text === ref);
      if (i < 0) i = this.entries.findIndex((e) => norm(e.text) === norm(ref));
      if (i < 0) return { ok: false, error: `nothing let go: no memory reads exactly "${ref}"` };
    }
    const [e] = this.entries.splice(i, 1);
    this.save();
    return { ok: true, text: e.text };
  }
}

/** The THINGS YOU CHOSE TO REMEMBER lines, oldest first: "1. (3 turns ago) text". */
export function keptLines(entries: KeptEntry[], now: number, clock: TurnClock): string[] {
  return entries.map((e, i) => `${i + 1}. (${turnsAgo(e.t, now, clock)}) ${e.text}`);
}

/** where an agent's kept memory is saved: LOG_DIR/research/kept-memory/<run>/<agent>.json */
export function keptMemoryPath(logDir: string, runId: string, agentId: string): string {
  const safe = (s: string) => s.replace(/[^A-Za-z0-9_.-]/g, "_");
  return path.join(logDir, "research", "kept-memory", safe(runId), `${safe(agentId)}.json`);
}
