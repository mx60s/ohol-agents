import type { MapResponse, RunEvent, StateResponse } from "./api-types";
import { MockSource } from "./mock";
import { ReplaySource } from "./replay";

export interface DataSource {
  fetchState(): Promise<StateResponse>;
  fetchMap(): Promise<MapResponse>;
  fetchEvents(since: number): Promise<{ events: RunEvent[] }>;
  /** Live event stream. Returns an unsubscribe function. */
  subscribe(onEvent: (ev: RunEvent) => void): () => void;
}

class HttpSource implements DataSource {
  constructor(private base: string) {}

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.base}${path}`);
    if (!res.ok) throw new Error(`GET ${path} -> HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  fetchState(): Promise<StateResponse> {
    return this.get<StateResponse>("/api/state");
  }

  fetchMap(): Promise<MapResponse> {
    return this.get<MapResponse>("/api/map");
  }

  fetchEvents(since: number): Promise<{ events: RunEvent[] }> {
    return this.get<{ events: RunEvent[] }>(`/api/events?since=${since}`);
  }

  subscribe(onEvent: (ev: RunEvent) => void): () => void {
    // EventSource reconnects automatically when the connection drops.
    const es = new EventSource(`${this.base}/api/stream`);
    es.onmessage = (msg) => {
      try {
        onEvent(JSON.parse(msg.data as string) as RunEvent);
      } catch (err) {
        console.error("ignoring malformed stream event", err);
      }
    };
    return () => es.close();
  }
}

// ?api=<url> overrides the build-time VITE_API_URL (handy for pointing a
// deployed viewer at a different run)
const queryApi =
  typeof window !== "undefined"
    ? new URLSearchParams(window.location.search).get("api")
    : null;
const envUrl = (queryApi ?? (import.meta.env.VITE_API_URL as string | undefined))?.trim();
const queryMock =
  typeof window !== "undefined" &&
  new URLSearchParams(window.location.search).has("mock");

// ?replay=<url> (or build-time VITE_API_URL=replay -> <base>/replay.jsonl)
// plays back a recording made by agents/src/tools/record.ts
const queryReplay =
  typeof window !== "undefined"
    ? new URLSearchParams(window.location.search).get("replay")
    : null;
export const replayUrl: string | null =
  queryReplay ||
  (envUrl === "replay" || envUrl?.startsWith("replay:")
    ? envUrl.startsWith("replay:")
      ? envUrl.slice("replay:".length)
      : `${import.meta.env.BASE_URL}replay.jsonl`
    : null);
export const replay: ReplaySource | null = replayUrl ? new ReplaySource(replayUrl) : null;
export const replayMode = replay != null;

export const mockMode: boolean = !replayMode && (envUrl === "mock" || queryMock);
export const apiUrl: string = replayMode
  ? "replay"
  : mockMode
    ? "mock"
    : envUrl === "same-origin"
      ? "" // viewer served by the agents service itself
      : (envUrl?.replace(/\/+$/, "") || "http://localhost:8787");

export const source: DataSource = replay ?? (mockMode ? new MockSource() : new HttpSource(apiUrl));

/** "now" for comparing against event/run timestamps: playhead time in replay mode */
export function clockNow(): number {
  return replay ? replay.now() : Date.now();
}

/** stretch speech-bubble lifetimes at high replay speeds so they stay readable */
export function speechScale(): number {
  return replay ? Math.max(1, replay.getStatus().speed / 4) : 1;
}
