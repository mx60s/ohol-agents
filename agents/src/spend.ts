// Rolling-window LLM spend ledger (default 24h), persisted so a restart
// doesn't reset the window. Clock is injectable for tests.
//
// File: one {"t": ms, "usd": n} per line, appended per LLM call; compacted
// to the current window on load and every hour.

import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

export const DAY_MS = 24 * 60 * 60 * 1000;

export class SpendLedger {
  private entries: { t: number; usd: number }[] = [];
  private lastCompact = 0;

  constructor(private opts: { file?: string | null; windowMs?: number; now?: () => number } = {}) {}

  get windowMs() {
    return this.opts.windowMs ?? DAY_MS;
  }

  private now() {
    return (this.opts.now ?? Date.now)();
  }

  load() {
    const f = this.opts.file;
    if (!f || !existsSync(f)) return;
    for (const line of readFileSync(f, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        if (Number.isFinite(r.t) && Number.isFinite(r.usd) && r.usd > 0) this.entries.push({ t: r.t, usd: r.usd });
      } catch {
        // torn line
      }
    }
    this.entries.sort((a, b) => a.t - b.t);
    this.compact();
  }

  add(usd: number) {
    if (!(usd > 0)) return;
    const t = this.now();
    this.entries.push({ t, usd });
    if (this.opts.file) {
      try {
        appendFileSync(this.opts.file, JSON.stringify({ t, usd }) + "\n");
      } catch (e) {
        console.error("spend ledger write failed", e);
      }
    }
    if (t - this.lastCompact > 60 * 60 * 1000) this.compact();
  }

  private prune(now: number) {
    const cutoff = now - this.windowMs;
    let i = 0;
    while (i < this.entries.length && this.entries[i].t <= cutoff) i++;
    if (i) this.entries.splice(0, i);
  }

  /** Drop entries outside the window, in memory and on disk. */
  compact() {
    const now = this.now();
    this.prune(now);
    this.lastCompact = now;
    if (this.opts.file) {
      try {
        // atomic: a crash mid-rewrite used to leave an empty ledger, silently resetting the daily cap
        const tmp = `${this.opts.file}.tmp`;
        writeFileSync(tmp, this.entries.map((e) => JSON.stringify(e) + "\n").join(""));
        renameSync(tmp, this.opts.file);
      } catch (e) {
        console.error("spend ledger compact failed", e);
      }
    }
  }

  /** USD spent in the window ending now. */
  spent(): number {
    this.prune(this.now());
    return this.entries.reduce((a, e) => a + e.usd, 0);
  }

  /** true if a cap is set (> 0) and the window's spend has reached it */
  blocked(capUsd: number): boolean {
    return capUsd > 0 && this.spent() >= capUsd;
  }

  /** When the window will drop below the cap again (null if not blocked). */
  resumesAt(capUsd: number): number | null {
    if (!this.blocked(capUsd)) return null;
    let total = this.spent();
    for (const e of this.entries) {
      total -= e.usd;
      if (total < capUsd) return e.t + this.windowMs;
    }
    return null;
  }
}
