// Replay a recorded run (JSONL written by agents/src/tools/record.ts) as a
// DataSource with a virtual playhead. Lines:
//   {k:"state",t,d:StateResponse} | {k:"map",t,cells,names} (deltas) | {k:"event",d:RunEvent}
import type { MapCellTuple, MapResponse, RunEvent, StateResponse } from "./api-types";
import type { DataSource } from "./api";

interface StateRec { t: number; d: StateResponse }
interface MapRec { t: number; cells: MapCellTuple[]; names: Record<number, string> }

export const SPEEDS = [1, 4, 16, 64] as const;

export interface ReplayStatus {
  loading: boolean;
  error: string | null;
  loadedBytes: number;
  playing: boolean;
  speed: number;
  start: number;
  end: number;
  playhead: number;
  /** bumps whenever the playhead jumps backward (event feed must be reset) */
  epoch: number;
}

/** first index i with arr[i].t > t (arr sorted by t) */
function upperBound<T extends { t: number }>(arr: T[], t: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].t <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export class ReplaySource implements DataSource {
  private states: StateRec[] = [];
  private maps: MapRec[] = [];
  private events: RunEvent[] = []; // sorted by t
  private ready: Promise<void>;

  private status: ReplayStatus = {
    loading: true,
    error: null,
    loadedBytes: 0,
    playing: true,
    speed: 16,
    start: 0,
    end: 0,
    playhead: 0,
    epoch: 0,
  };
  private lastWall = 0;
  private emitted = 0; // playhead up to which events have been emitted

  // accumulated map
  private mapCells = new Map<string, MapCellTuple>();
  private mapNames: Record<number, string> = {};
  private mapIdx = 0;
  private mapCache: MapResponse | null = null;

  private eventSubs = new Set<(ev: RunEvent) => void>();
  private statusSubs = new Set<() => void>();

  constructor(private url: string) {
    this.ready = this.load().catch((err) => {
      this.status = { ...this.status, loading: false, error: String(err) };
      this.notify();
      throw err;
    });
    setInterval(() => this.tick(), 100);
  }

  private async load() {
    const res = await fetch(this.url);
    if (!res.ok || !res.body) throw new Error(`GET ${this.url} -> HTTP ${res.status}`);
    let stream: ReadableStream<Uint8Array> = res.body;
    // progress counter on the raw bytes
    let bytes = 0;
    let lastNotify = 0;
    stream = stream.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform: (chunk, ctl) => {
          bytes += chunk.byteLength;
          if (performance.now() - lastNotify > 100) {
            lastNotify = performance.now();
            this.status = { ...this.status, loadedBytes: bytes };
            this.notify();
          }
          ctl.enqueue(chunk);
        },
      }),
    );
    if (/\.gz($|\?)/.test(this.url)) {
      stream = stream.pipeThrough(
        new DecompressionStream("gzip") as unknown as TransformStream<Uint8Array, Uint8Array>,
      );
    }
    const text = await new Response(stream).text();
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let o: { k: string; t?: number; d?: unknown; cells?: MapCellTuple[]; names?: Record<number, string> };
      try {
        o = JSON.parse(line);
      } catch {
        continue; // partially-written last line
      }
      if (o.k === "state") this.states.push({ t: o.t!, d: o.d as StateResponse });
      else if (o.k === "map") this.maps.push({ t: o.t!, cells: o.cells ?? [], names: o.names ?? {} });
      else if (o.k === "event") this.events.push(o.d as RunEvent);
    }
    if (!this.states.length) throw new Error("recording has no state lines");
    this.states.sort((a, b) => a.t - b.t);
    this.maps.sort((a, b) => a.t - b.t);
    this.events.sort((a, b) => a.t - b.t || a.seq - b.seq);
    const start = this.states[0].t;
    const end = this.states[this.states.length - 1].t;
    // map snapshots taken before the first state still belong at the start
    for (const m of this.maps) if (m.t < start) m.t = start;
    // the first snapshot is taken just after the first state; show it from t=start
    if (this.maps.length) this.maps[0].t = start;
    this.lastWall = performance.now();
    this.emitted = start;
    this.status = { ...this.status, loading: false, loadedBytes: bytes, start, end, playhead: start };
    this.notify();
  }

  private tick() {
    const s = this.status;
    const wall = performance.now();
    const dt = wall - this.lastWall;
    this.lastWall = wall;
    if (s.loading || s.error || !s.playing) return;
    let playhead = s.playhead + dt * s.speed;
    let playing = true;
    if (playhead >= s.end) {
      playhead = s.end;
      playing = false;
    }
    this.status = { ...s, playhead, playing };
    this.emitUpTo(playhead);
    this.notify();
  }

  private emitUpTo(playhead: number) {
    if (playhead <= this.emitted) return;
    const from = upperBound(this.events, this.emitted);
    const to = upperBound(this.events, playhead);
    this.emitted = playhead;
    for (let i = from; i < to; i++) for (const fn of this.eventSubs) fn(this.events[i]);
  }

  private notify() {
    for (const fn of this.statusSubs) fn();
  }

  // ---- controls ----

  getStatus = (): ReplayStatus => this.status;

  onStatus = (fn: () => void): (() => void) => {
    this.statusSubs.add(fn);
    return () => this.statusSubs.delete(fn);
  };

  /** playhead time (ms epoch), or wall time while loading */
  now(): number {
    return this.status.loading || this.status.error ? Date.now() : this.status.playhead;
  }

  setPlaying(playing: boolean) {
    const s = this.status;
    if (playing && s.playhead >= s.end) {
      this.seek(s.start); // restart from the beginning
    }
    this.lastWall = performance.now();
    this.status = { ...this.status, playing };
    this.notify();
  }

  setSpeed(speed: number) {
    this.status = { ...this.status, speed };
    this.notify();
  }

  seek(t: number) {
    const s = this.status;
    const playhead = Math.max(s.start, Math.min(s.end, t));
    // Any jump (back or forward) bumps epoch so the app resets and backfills its
    // event feed, rather than us emitting a burst of skipped events.
    this.emitted = playhead;
    this.status = { ...s, playhead, epoch: s.epoch + 1 };
    this.notify();
  }

  // ---- DataSource ----

  async fetchState(): Promise<StateResponse> {
    await this.ready;
    const i = Math.max(0, upperBound(this.states, this.status.playhead) - 1);
    return this.states[i].d;
  }

  async fetchMap(): Promise<MapResponse> {
    await this.ready;
    const to = upperBound(this.maps, this.status.playhead);
    if (to < this.mapIdx) {
      this.mapCells.clear();
      this.mapNames = {};
      this.mapIdx = 0;
    }
    if (to !== this.mapIdx || !this.mapCache) {
      for (let i = this.mapIdx; i < to; i++) {
        const m = this.maps[i];
        for (const c of m.cells) this.mapCells.set(`${c[0]},${c[1]}`, c);
        Object.assign(this.mapNames, m.names);
      }
      this.mapIdx = to;
      this.mapCache = { cells: [...this.mapCells.values()], names: { ...this.mapNames } };
    }
    return this.mapCache;
  }

  async fetchEvents(since: number): Promise<{ events: RunEvent[] }> {
    await this.ready;
    const to = upperBound(this.events, this.status.playhead);
    const out: RunEvent[] = [];
    for (let i = to - 1; i >= 0 && out.length < 500; i--) {
      if (this.events[i].seq > since) out.push(this.events[i]);
    }
    return { events: out.reverse() };
  }

  subscribe(onEvent: (ev: RunEvent) => void): () => void {
    this.eventSubs.add(onEvent);
    return () => this.eventSubs.delete(onEvent);
  }
}
