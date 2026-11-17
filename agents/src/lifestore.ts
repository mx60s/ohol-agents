// Persistence and queries for lives/lineages (logic is in lives.ts).
//
// On disk, under LOG_DIR:
//   research/lives.snapshot.json   all life records (rewritten atomically every few minutes)
//   research/lives.journal.jsonl   one full life record per line, appended on every
//                                  change since the snapshot; last line per lifeId wins
//   <run dir>/lives/<playerId>.jsonl  per-life event log (birth/death/thought/say/action/craft),
//                                  read from disk on request, never held in memory
// Startup: snapshot + journal replay, then lives that were still open are
// marked lost (we can't reconnect to them after a restart), then compaction.

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { LifeLogResponse, LifeRecord, LineageRecord, DeathRecord, RunEvent, TraitSource } from "./api-types.ts";
import { LifeBook, computeLineages, possiblyAlive, toDeath, toRecord, type LifeCore } from "./lives.ts";
import type { Rng } from "./traits.ts";

export interface LifeStoreOptions {
  logDir: string;
  dims: string[];
  mutationSd: number;
  traitSource: TraitSource;
  rng?: Rng;
  now?: () => number;
}

/** Anything that emits RunEvents and has a run dir (EventLog). */
export interface EventSource {
  readonly dir: string;
  on(event: "event", fn: (e: RunEvent) => void): unknown;
}

export class LifeStore {
  readonly book: LifeBook;
  readonly dims: string[];
  readonly traitSource: TraitSource;
  private readonly logDir: string;
  private readonly dir: string;
  private readonly now: () => number;
  private dirty = new Set<string>();
  private journalLines = 0;
  private changedSinceSnapshot = false;
  private timers: NodeJS.Timeout[] = [];
  /** a journal append failed (e.g. disk full) and may have left a partial line */
  private journalTorn = false;

  constructor(opts: LifeStoreOptions) {
    this.logDir = path.resolve(opts.logDir);
    this.dir = path.join(this.logDir, "research");
    mkdirSync(this.dir, { recursive: true });
    this.dims = opts.dims;
    this.traitSource = opts.traitSource;
    this.now = opts.now ?? Date.now;
    this.book = new LifeBook({ dims: opts.dims, mutationSd: opts.mutationSd, traitSource: opts.traitSource, rng: opts.rng ?? Math.random });
  }

  private get snapshotFile() {
    return path.join(this.dir, "lives.snapshot.json");
  }
  /** the snapshot before the current one (fallback if the current one is unreadable) */
  private get prevSnapshotFile() {
    return path.join(this.dir, "lives.snapshot.prev.json");
  }
  private get journalFile() {
    return path.join(this.dir, "lives.journal.jsonl");
  }

  /** Rebuild from disk. Returns the number of lives loaded. */
  load(): number {
    if (!this.loadSnapshot(this.snapshotFile, true)) this.loadSnapshot(this.prevSnapshotFile, false);
    if (existsSync(this.journalFile)) {
      for (const line of readFileSync(this.journalFile, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          this.book.load(JSON.parse(line) as LifeCore);
        } catch {
          // torn last line after a crash: skip
        }
      }
    }
    this.book.rebuildEpochs();
    // nothing from before this process is still being played
    this.book.markLost(() => true, null);
    this.snapshot(true);
    return this.book.lives.size;
  }

  /**
   * Load one snapshot file. An unreadable snapshot is moved aside, never
   * overwritten: load() ends with a snapshot, which used to replace a corrupt
   * file with just the journal's few records, losing the history for good.
   */
  private loadSnapshot(file: string, current: boolean): boolean {
    if (!existsSync(file)) return false;
    try {
      const arr = JSON.parse(readFileSync(file, "utf8"));
      if (!Array.isArray(arr)) throw new Error("not an array");
      for (const l of arr) if (l && typeof l.lifeId === "string") this.book.load(l as LifeCore);
      return true;
    } catch (e) {
      const aside = `${file}.corrupt-${this.now()}`;
      console.error(`lives snapshot ${path.basename(file)} unreadable; kept as ${path.basename(aside)}${current ? ", trying the previous snapshot" : ""}`, e);
      try {
        renameSync(file, aside);
      } catch {
        // leave it
      }
      return false;
    }
  }

  /** Periodic journal flush (activity counters) and snapshot/compaction. */
  startTimers(flushMs = 10_000, snapshotMs = 10 * 60_000) {
    this.timers.push(setInterval(() => this.flush(), flushMs).unref());
    this.timers.push(setInterval(() => this.snapshot(), snapshotMs).unref());
  }

  close() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.flush();
    this.snapshot();
  }

  /** Follow a run's event stream. */
  attach(log: EventSource, runId: string) {
    log.on("event", (e) => this.handle(runId, log.dir, e));
  }

  handle(runId: string, runDir: string, ev: RunEvent) {
    const r = this.book.apply(runId, ev);
    if (!r.life) return;
    if (r.created) {
      // "<runId>.<n>:<pid>" (a recycled player id) gets its own file: "<pid>-<n>.jsonl"
      const n = /^.*\.(\d+):\d+$/.exec(r.life.lifeId.slice(runId.length))?.[1];
      const rel = path.join(path.basename(runDir), "lives", `${r.life.playerId}${n ? `-${n}` : ""}.jsonl`);
      try {
        mkdirSync(path.join(this.logDir, path.dirname(rel)), { recursive: true });
        r.life.logPath = rel;
      } catch (e) {
        console.error("life log dir failed", e);
      }
    }
    if (r.loggable && r.life.logPath) {
      try {
        appendFileSync(path.join(this.logDir, r.life.logPath), JSON.stringify(ev) + "\n");
      } catch (e) {
        console.error("life log write failed", e);
      }
    }
    for (const l of r.changed) this.dirty.add(l.lifeId);
    if (r.important) this.flush();
  }

  /** Lives of a run that stopped (halt / shutdown) are no longer being played. */
  markRunLost(runId: string) {
    const lost = this.book.markLost((l) => l.runId === runId, this.now());
    for (const l of lost) this.dirty.add(l.lifeId);
    this.flush();
  }

  /** Append changed records to the journal. */
  flush() {
    if (!this.dirty.size) return;
    const lines: string[] = [];
    const ids = [...this.dirty];
    for (const id of ids) {
      const l = this.book.get(id);
      if (l) lines.push(JSON.stringify(l));
    }
    this.dirty.clear();
    try {
      // after a failed (possibly partial) append, start on a fresh line so the torn one doesn't swallow this one
      appendFileSync(this.journalFile, (this.journalTorn ? "\n" : "") + lines.join("\n") + "\n");
      this.journalTorn = false;
      this.journalLines += lines.length;
      this.changedSinceSnapshot = true;
    } catch (e) {
      this.journalTorn = true;
      // keep the records dirty so they're written again once the disk has room
      for (const id of ids) this.dirty.add(id);
      console.error("lives journal write failed", e);
      return;
    }
    if (this.journalLines > 50_000) this.snapshot();
  }

  /** Write a full snapshot atomically and truncate the journal. */
  snapshot(force = false) {
    this.flush();
    if (!force && !this.changedSinceSnapshot) return;
    try {
      const tmp = this.snapshotFile + ".tmp";
      writeFileSync(tmp, JSON.stringify([...this.book.lives.values()]));
      if (existsSync(this.snapshotFile)) renameSync(this.snapshotFile, this.prevSnapshotFile);
      renameSync(tmp, this.snapshotFile);
      writeFileSync(this.journalFile, "");
      this.journalLines = 0;
      this.changedSinceSnapshot = false;
    } catch (e) {
      console.error("lives snapshot failed", e);
    }
  }

  // ---- queries -------------------------------------------------------------

  get(lifeId: string): LifeRecord | null {
    const l = this.book.get(lifeId);
    return l ? toRecord(l) : null;
  }

  /** Records with updatedAt > since, oldest update first. Never splits a group of equal updatedAt. */
  livesSince(since: number, limit: number): { lives: LifeRecord[]; more: boolean } {
    const all = [...this.book.lives.values()].filter((l) => l.updatedAt > since).sort((a, b) => a.updatedAt - b.updatedAt);
    let n = Math.min(limit, all.length);
    while (n > 0 && n < all.length && all[n].updatedAt === all[n - 1].updatedAt) n++;
    return { lives: all.slice(0, n).map(toRecord), more: n < all.length };
  }

  lineages(): LineageRecord[] {
    return computeLineages(this.book.lives.values(), this.dims, this.now());
  }

  deaths(limit: number): DeathRecord[] {
    return [...this.book.lives.values()]
      .filter((l) => l.diedAt != null)
      .sort((a, b) => b.diedAt! - a.diedAt!)
      .slice(0, limit)
      .map(toDeath);
  }

  /** A life's logged events, newest first, with seq < before. Null if the life is unknown. */
  readLog(lifeId: string, before: number | null, limit: number): LifeLogResponse | null {
    const l = this.book.get(lifeId);
    if (!l) return null;
    const empty: LifeLogResponse = { lifeId, events: [], nextBefore: null };
    if (!l.logPath) return empty;
    const file = path.resolve(this.logDir, l.logPath);
    if (!file.startsWith(this.logDir + path.sep) || !existsSync(file)) return empty;
    const events: RunEvent[] = [];
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line) continue;
      try {
        const e = JSON.parse(line) as RunEvent;
        if (before == null || e.seq < before) events.push(e);
      } catch {
        // skip torn line
      }
    }
    events.sort((a, b) => b.seq - a.seq);
    const page = events.slice(0, limit);
    return { lifeId, events: page, nextBefore: events.length > limit ? page[page.length - 1].seq : null };
  }

  /** Fields for AgentView. */
  agentFields(runId: string, agentId: string, playerId: number | null) {
    const l = playerId != null ? this.book.byRunPlayer(runId, playerId) ?? this.book.current(runId, agentId) : null;
    return { lifeId: l?.lifeId ?? null, lineageId: l?.lineageId ?? null, traits: l?.traits ?? null };
  }

  /** Fields for PlayerView: our life (any run) with this player id that may be alive now. */
  playerFields(playerId: number) {
    const now = this.now();
    const l = this.book.findByPlayer(playerId, now);
    return l && possiblyAlive(l, now) ? { lifeId: l.lifeId, lineageId: l.lineageId } : { lifeId: null, lineageId: null };
  }
}
