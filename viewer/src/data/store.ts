// Tiny shared polling store: one timer per key no matter how many components
// subscribe; polling stops when the last subscriber leaves (the cached value is
// kept, so remounts render instantly); hidden tabs skip ticks; errors keep the
// last good data. Static (fixture) clients fetch once.

import { getClient, type ApiClient } from "./client.ts";

export interface Resource<T> {
  data: T | null;
  /** last fetch error; cleared by the next success. data keeps the last good value. */
  error: Error | null;
  /** true until the first fetch settles */
  loading: boolean;
  /** ms epoch (browser clock) of the last successful fetch */
  updatedAt: number | null;
}

type Listener = () => void;

const hidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";

export class Poller<T> {
  snap: Resource<T> = { data: null, error: null, loading: true, updatedAt: null };
  private listeners = new Set<Listener>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight = false;
  private fetchedOnce = false;
  constructor(
    private fetcher: (c: ApiClient, prev: T | null) => Promise<T>,
    private intervalMs: number,
  ) {}

  subscribe = (cb: Listener): (() => void) => {
    this.listeners.add(cb);
    if (this.listeners.size === 1) this.start();
    return () => {
      this.listeners.delete(cb);
      if (this.listeners.size === 0) this.stop();
    };
  };
  getSnapshot = (): Resource<T> => this.snap;

  set(patch: Partial<Resource<T>>) {
    this.snap = { ...this.snap, ...patch };
    for (const l of this.listeners) l();
  }

  refresh = () => void this.tick(true);

  private onVisible = () => {
    if (!hidden()) void this.tick();
  };

  private start() {
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", this.onVisible);
    void this.tick(true);
  }
  private stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", this.onVisible);
  }

  private schedule() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const c = getClient();
    if (this.listeners.size === 0 || this.intervalMs <= 0 || (c.isStatic && this.fetchedOnce)) return;
    this.timer = setTimeout(() => void this.tick(), this.intervalMs);
  }

  private async tick(force = false) {
    if (this.inFlight) return;
    const c = getClient();
    if (!force && (hidden() || (c.isStatic && this.fetchedOnce))) return this.schedule();
    this.inFlight = true;
    try {
      const data = await this.fetcher(c, this.snap.data);
      this.fetchedOnce = true;
      this.set({ data, error: null, loading: false, updatedAt: Date.now() });
    } catch (e) {
      this.set({ error: e instanceof Error ? e : new Error(String(e)), loading: false });
    } finally {
      this.inFlight = false;
      this.schedule();
    }
  }
}

const pollers = new Map<string, Poller<unknown>>();

/** Shared poller for `key` (created on first use; the fetcher/interval of the first caller win). */
export function poller<T>(key: string, fetcher: (c: ApiClient, prev: T | null) => Promise<T>, intervalMs: number): Poller<T> {
  let p = pollers.get(key) as Poller<T> | undefined;
  if (!p) {
    p = new Poller<T>(fetcher, intervalMs);
    pollers.set(key, p as Poller<unknown>);
  }
  return p;
}
