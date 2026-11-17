// React hooks over the data client. All are shared: N components using the same
// hook cause one fetch loop. Data stays at its last good value through network
// errors; `error` / `online` tell you about trouble.

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type {
  DeathsResponse,
  LifeRecord,
  LineagesResponse,
  MapResponse,
  RunEvent,
  StateResponse,
  StorySoFar,
  StoryVersion,
  TraitSource,
} from "../api-types.ts";
import { getClient, type StreamStatus } from "./client.ts";
import { poller, type Poller, type Resource } from "./store.ts";

function useResource<T>(p: Poller<T>): Resource<T> & { refresh: () => void } {
  const snap = useSyncExternalStore(p.subscribe, p.getSnapshot, p.getSnapshot);
  return useMemo(() => ({ ...snap, refresh: p.refresh }), [snap, p]);
}

// ================================================================== world state + events

export type Connection = "connecting" | "live" | "offline";

export interface WorldSnapshot {
  state: StateResponse | null;
  /** recent run events, oldest first, deduped by seq, capped at MAX_EVENTS; reset when the run changes */
  events: RunEvent[];
  /** "offline" after 2 failed state polls in a row; "connecting" until the first success */
  connection: Connection;
  online: boolean;
  /** the SSE stream's own status (state polling still works if it is down) */
  stream: StreamStatus;
  runId: string | null;
  /** browser-clock ms of the last successful /api/state */
  lastUpdate: number | null;
  error: Error | null;
}

export const MAX_EVENTS = 1000;
const STATE_MS = 2000;

class WorldStore {
  snap: WorldSnapshot = { state: null, events: [], connection: "connecting", online: false, stream: "connecting", runId: null, lastUpdate: null, error: null };
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private unstream: (() => void) | null = null;
  private fails = 0;
  private lastSeq = 0;
  private backfilling = false;
  private seen = new Set<number>();

  subscribe = (cb: () => void) => {
    this.listeners.add(cb);
    if (this.listeners.size === 1) this.start();
    return () => {
      this.listeners.delete(cb);
      if (this.listeners.size === 0) this.stop();
    };
  };
  getSnapshot = () => this.snap;
  private set(p: Partial<WorldSnapshot>) {
    this.snap = { ...this.snap, ...p };
    for (const l of this.listeners) l();
  }

  private start() {
    const c = getClient();
    void this.pollState();
    this.unstream = c.stream({
      onEvent: (ev) => this.addEvents([ev]),
      onStatus: (s) => {
        this.set({ stream: s });
        if (s === "open" && this.snap.runId) void this.backfill(); // catch up whatever the gap missed
      },
    });
  }
  private stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.unstream?.();
    this.unstream = null;
  }

  private async pollState() {
    const c = getClient();
    try {
      const state = await c.state();
      this.fails = 0;
      const runChanged = this.snap.runId !== null && state.run.id !== this.snap.runId;
      if (runChanged) {
        this.lastSeq = 0;
        this.seen.clear();
        this.set({ events: [] });
      }
      const first = this.snap.runId === null;
      this.set({ state, runId: state.run.id, connection: "live", online: true, lastUpdate: Date.now(), error: null });
      if (first || runChanged) void this.backfill();
    } catch (e) {
      this.fails++;
      const err = e instanceof Error ? e : new Error(String(e));
      this.set({ error: err, ...(this.fails >= 2 || !this.snap.state ? { connection: "offline" as const, online: false } : {}) });
    }
    if (this.listeners.size && !(c.isStatic && this.snap.state)) {
      this.timer = setTimeout(() => void this.pollState(), this.fails ? Math.min(STATE_MS * 2 ** this.fails, 15_000) : STATE_MS);
    }
  }

  private async backfill() {
    if (this.backfilling) return;
    this.backfilling = true;
    try {
      const c = getClient();
      for (let page = 0; page < 20; page++) {
        const evs = await c.events(this.lastSeq);
        this.addEvents(evs);
        if (evs.length < 500) break;
      }
    } catch {
      /* the next (re)connect or run change retries */
    } finally {
      this.backfilling = false;
    }
  }

  private addEvents(evs: RunEvent[]) {
    const fresh = evs.filter((e) => !this.seen.has(e.seq));
    if (!fresh.length) return;
    for (const e of fresh) {
      this.seen.add(e.seq);
      if (e.seq > this.lastSeq) this.lastSeq = e.seq;
    }
    let events = [...this.snap.events, ...fresh];
    if (fresh.some((e, i) => i > 0 && e.seq < fresh[i - 1].seq) || (this.snap.events.length && fresh[0].seq < this.snap.events[this.snap.events.length - 1].seq)) {
      events.sort((a, b) => a.seq - b.seq);
    }
    if (events.length > MAX_EVENTS) {
      events = events.slice(-MAX_EVENTS);
      if (this.seen.size > MAX_EVENTS * 4) this.seen = new Set(events.map((e) => e.seq));
    }
    this.set({ events });
  }
}

const world = new WorldStore();

/** /api/state every 2 s + the SSE event stream (with backfill on reconnect and on run change). */
export function useWorldState(): WorldSnapshot {
  return useSyncExternalStore(world.subscribe, world.getSnapshot, world.getSnapshot);
}

// ================================================================== lives (incremental)

export interface LivesSnapshot {
  /** every life seen, newest born first */
  lives: LifeRecord[];
  byId: Record<string, LifeRecord>;
  traitDims: string[];
  traitSource: TraitSource;
  /** server clock of the last response */
  now: number | null;
}

const LIVES_MS = 5000;

const livesPoller = () =>
  poller<LivesSnapshot & { cursor: number }>(
    "lives",
    async (c, prev) => {
      const byId = { ...(prev?.byId ?? {}) };
      let cursor = prev?.cursor ?? 0;
      let meta = { traitDims: prev?.traitDims ?? [], traitSource: prev?.traitSource ?? ("mock" as TraitSource), now: prev?.now ?? null };
      let changed = !prev;
      for (let page = 0; page < 40; page++) {
        const r = await c.lives({ since: cursor, limit: 500 });
        meta = { traitDims: r.traitDims.length ? r.traitDims : meta.traitDims, traitSource: r.traitSource, now: r.now };
        // backend data wiped (new world): the server clock is behind our cursor and nothing matched
        if (page === 0 && !r.lives.length && prev && r.now < cursor) {
          return { lives: [], byId: {}, cursor: 0, ...meta };
        }
        for (const l of r.lives) {
          byId[l.lifeId] = l;
          if (l.updatedAt > cursor) cursor = l.updatedAt;
          changed = true;
        }
        if (!r.more || !r.lives.length) break;
      }
      if (!changed && prev) return { ...prev, ...meta };
      const lives = Object.values(byId).sort((a, b) => b.bornAt - a.bornAt || a.lifeId.localeCompare(b.lifeId));
      return { lives, byId, cursor, ...meta };
    },
    LIVES_MS,
  );

const EMPTY_LIVES: LivesSnapshot = { lives: [], byId: {}, traitDims: [], traitSource: "mock", now: null };

/** Every recorded life (all runs), fetched incrementally with ?since= every 5 s. */
export function useLives(): Omit<Resource<LivesSnapshot>, "data"> & LivesSnapshot & { refresh: () => void } {
  const r = useResource(livesPoller());
  const d = r.data ?? EMPTY_LIVES;
  return { lives: d.lives, byId: d.byId, traitDims: d.traitDims, traitSource: d.traitSource, now: d.now, error: r.error, loading: r.loading, updatedAt: r.updatedAt, refresh: r.refresh };
}

/** One life, polled every 4 s. notFound = the server answered 404. */
export function useLife(lifeId: string | null | undefined): { life: LifeRecord | null; notFound: boolean; loading: boolean; error: Error | null } {
  const p = poller<{ life: LifeRecord | null }>(`life:${lifeId ?? ""}`, async (c) => ({ life: lifeId ? await c.life(lifeId) : null }), 4000);
  const r = useResource(p);
  return { life: r.data?.life ?? null, notFound: !r.loading && !r.error && !!r.data && !r.data.life, loading: r.loading, error: r.error };
}

// ================================================================== simple polled resources

export function useLineages(): Resource<LineagesResponse> & { refresh: () => void } {
  return useResource(poller("lineages", (c) => c.lineages(), 5000));
}

export function useDeaths(limit = 50): Resource<DeathsResponse> & { refresh: () => void } {
  return useResource(poller(`deaths:${limit}`, (c) => c.deaths({ limit }), 5000));
}

export function useMap(): Resource<MapResponse> & { refresh: () => void } {
  return useResource(poller("map", (c) => c.map(), 5000));
}

/** object id -> name for every object (fetched once) */
export function useObjectNames(): Record<number, string> {
  return useResource(poller("objects", (c) => c.objects(), 0)).data ?? {};
}

/** "Story so far": current = newest version (null until the first summary), history newest first. Polled every 30 s. */
export function useStory(limit = 20): { current: StorySoFar | null; history: StoryVersion[]; loading: boolean; error: Error | null } {
  const r = useResource(poller(`story:${limit}`, (c) => c.storyHistory({ limit }), 30_000));
  const history = r.data?.history ?? [];
  return { current: history[0] ?? null, history, loading: r.loading, error: r.error };
}

// ================================================================== per-life log (paged)

export interface LifeLogState {
  /** newest first */
  events: RunEvent[];
  hasMore: boolean;
  loadMore: () => void;
  loading: boolean;
  loadingMore: boolean;
  error: Error | null;
}

/**
 * A life's own events, newest first, `pageSize` at a time. The newest page is
 * re-polled every `pollMs` (0 = never, e.g. for the dead) and new events are prepended.
 */
export function useLifeLog(lifeId: string | null | undefined, opts: { pageSize?: number; pollMs?: number } = {}): LifeLogState {
  const pageSize = opts.pageSize ?? 50;
  const pollMs = opts.pollMs ?? 4000;
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const gen = useRef(0);

  useEffect(() => {
    const my = ++gen.current;
    setEvents([]);
    setNextBefore(null);
    setLoading(true);
    setError(null);
    if (!lifeId) {
      setLoading(false);
      return;
    }
    const c = getClient();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let first = true;
    const head = async () => {
      try {
        const r = await c.lifeLog(lifeId, { limit: pageSize });
        if (gen.current !== my) return;
        setEvents((prev) => {
          if (first) return r.events;
          const top = prev[0]?.seq ?? -Infinity;
          const fresh = r.events.filter((e) => e.seq > top);
          return fresh.length ? [...fresh, ...prev] : prev;
        });
        if (first) setNextBefore(r.nextBefore);
        first = false;
        setError(null);
      } catch (e) {
        if (gen.current === my) setError(e instanceof Error ? e : new Error(String(e)));
      } finally {
        if (gen.current === my) {
          setLoading(false);
          if (pollMs > 0 && !c.isStatic) timer = setTimeout(head, pollMs);
        }
      }
    };
    void head();
    return () => {
      gen.current++;
      if (timer) clearTimeout(timer);
    };
  }, [lifeId, pageSize, pollMs]);

  const loadMore = useCallback(() => {
    if (!lifeId || nextBefore == null || loadingMore) return;
    const my = gen.current;
    setLoadingMore(true);
    getClient()
      .lifeLog(lifeId, { before: nextBefore, limit: pageSize })
      .then((r) => {
        if (gen.current !== my) return;
        setEvents((prev) => {
          const have = new Set(prev.map((e) => e.seq));
          return [...prev, ...r.events.filter((e) => !have.has(e.seq))];
        });
        setNextBefore(r.nextBefore);
      })
      .catch((e) => gen.current === my && setError(e instanceof Error ? e : new Error(String(e))))
      .finally(() => gen.current === my && setLoadingMore(false));
  }, [lifeId, nextBefore, loadingMore, pageSize]);

  return { events, hasMore: nextBefore != null, loadMore, loading, loadingMore, error };
}

// ================================================================== clock

/**
 * "Now" for relative times, re-rendering every `tickMs`. In fixture mode it is
 * frozen at the fixture's captured state.now, so screenshots are deterministic.
 */
export function useNow(tickMs = 1000): number {
  const c = getClient();
  const fixed = useResource(
    c.isStatic ? poller<number>("fixture-now", (cl) => cl.state().then((s) => s.now), 0) : poller<number>("no-fixture-now", async () => 0, 0),
  );
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (c.isStatic) return;
    const t = setInterval(() => setNow(Date.now()), tickMs);
    return () => clearInterval(t);
  }, [c, tickMs]);
  return c.isStatic ? (fixed.data ?? now) : now;
}
