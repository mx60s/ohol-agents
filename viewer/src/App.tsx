import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type {
  AgentView,
  MapCellTuple,
  MapResponse,
  RunEvent,
  StateResponse,
} from "./api-types";
import { apiUrl, clockNow, mockMode, replay, replayMode, source, speechScale } from "./api";
import { SPEEDS, type ReplayStatus } from "./replay";
import MapCanvas, { agentColor, type FocusPoint } from "./MapCanvas";
import CameraGrid from "./CameraGrid";

const EMPTY_CELLS: MapCellTuple[] = [];
const EMPTY_NAMES: Record<number, string> = {};
const MAX_EVENTS = 500;

function fmtTime(t: number): string {
  return new Date(t).toLocaleTimeString("en-GB", { hour12: false });
}

function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${sec}s`;
  return `${m}m ${sec}s`;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** Auto-scroll a list to the bottom on new content unless scrolled up. */
function useAutoScroll(dep: number) {
  const ref = useRef<HTMLDivElement | null>(null);
  const stick = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [dep]);
  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };
  return { ref, onScroll };
}

const STATUS_ORDER: Record<AgentView["status"], number> = {
  alive: 0,
  connecting: 1,
  waiting: 2,
  dead: 3,
};

function AgentCard({
  agent,
  onClick,
}: {
  agent: AgentView;
  onClick: (a: AgentView) => void;
}) {
  const dimmed = agent.status === "dead" || agent.status === "waiting";
  const foodPct =
    agent.food != null && agent.foodCapacity
      ? Math.max(0, Math.min(100, (agent.food / agent.foodCapacity) * 100))
      : 0;
  const foodClass = foodPct < 25 ? "food-fill low" : "food-fill";
  return (
    <button
      type="button"
      className={`agent-card${dimmed ? " dimmed" : ""}`}
      onClick={() => onClick(agent)}
    >
      <div className="agent-head">
        <span
          className="agent-dot"
          style={{ background: agentColor(agent.agentId) }}
        />
        <span className="agent-name">{agent.name ?? agent.agentId}</span>
        <span className={`status s-${agent.status}`}>{agent.status}</span>
        {agent.age != null && (
          <span className="agent-age">{Math.floor(agent.age)}y</span>
        )}
      </div>
      <div className="food-row">
        <div className="food-bar" title="food">
          <div className={foodClass} style={{ width: `${foodPct}%` }} />
        </div>
        <span className="food-num">
          {agent.food != null ? Math.floor(agent.food) : "–"}/
          {agent.foodCapacity ?? "–"}
        </span>
      </div>
      <div className="agent-meta">
        heat {agent.heat != null ? `${Math.round(agent.heat * 100)}%` : "–"}
        {" · "}
        {agent.held ?? "empty hands"}
        {agent.generation != null && ` · gen ${agent.generation}`}
      </div>
      {agent.goal && <div className="agent-goal">→ {agent.goal}</div>}
      {agent.lastThought && (
        <div className="agent-thought">“{truncate(agent.lastThought, 90)}”</div>
      )}
      {agent.lastSaid && (
        <div className="agent-said">said: {truncate(agent.lastSaid, 70)}</div>
      )}
    </button>
  );
}

export default function App() {
  const [state, setState] = useState<StateResponse | null>(null);
  const [map, setMap] = useState<MapResponse | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [view, setView] = useState<"cameras" | "map">("cameras");
  const [follow, setFollow] = useState(true);
  const [focus, setFocus] = useState<FocusPoint | null>(null);
  const [showActions, setShowActions] = useState(false);
  const [nowTs, setNowTs] = useState(() => clockNow());
  const [offline, setOffline] = useState(false);
  const lastSeqRef = useRef(0);

  // 1s ticker for uptime / speech-bubble expiry (playhead clock in replay mode)
  useEffect(() => {
    const id = setInterval(() => setNowTs(clockNow()), replayMode ? 250 : 1000);
    return () => clearInterval(id);
  }, []);

  // poll /api/state every 2s
  useEffect(() => {
    let cancelled = false;
    let failures = 0;
    let inFlight = false;
    const tick = async () => {
      if (inFlight) return; // slow network: don't stack requests
      inFlight = true;
      try {
        const s = await source.fetchState();
        failures = 0;
        if (!cancelled) {
          setState(s);
          setOffline(false);
        }
      } catch (err) {
        console.error("state poll failed", err);
        // only flag offline after several misses in a row
        if (++failures >= 3 && !cancelled) setOffline(true);
      } finally {
        inFlight = false;
      }
    };
    void tick();
    const id = setInterval(tick, replayMode ? 500 : 2000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  // poll /api/map every 5s
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const m = await source.fetchMap();
        if (!cancelled) setMap(m);
      } catch (err) {
        console.error("map poll failed", err);
      }
    };
    void tick();
    const id = setInterval(tick, replayMode ? 1500 : 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  // events: initial backfill, then live stream
  useEffect(() => {
    let cancelled = false;
    source
      .fetchEvents(0)
      .then((res) => {
        if (cancelled) return;
        setEvents((prev) => {
          const seen = new Set(prev.map((e) => e.seq));
          const merged = [...prev];
          for (const ev of res.events) {
            if (!seen.has(ev.seq)) merged.push(ev);
          }
          merged.sort((a, b) => a.seq - b.seq);
          return merged.slice(-MAX_EVENTS);
        });
        for (const ev of res.events) {
          if (ev.seq > lastSeqRef.current) lastSeqRef.current = ev.seq;
        }
      })
      .catch((err) => console.error("event backfill failed", err));

    const unsubscribe = source.subscribe((ev) => {
      if (ev.seq <= lastSeqRef.current) return;
      lastSeqRef.current = ev.seq;
      setEvents((prev) => [...prev, ev].slice(-MAX_EVENTS));
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  // New run (after a restart from the dashboard): event seq numbers restart
  // at 1, so drop the old run's events and backfill the new one.
  const runIdRef = useRef<string | null>(null);
  const runId = state?.run.id ?? null;
  useEffect(() => {
    if (!runId) return;
    const prevId = runIdRef.current;
    runIdRef.current = runId;
    if (!prevId || prevId === runId) return;
    lastSeqRef.current = 0;
    setEvents([]);
    source
      .fetchEvents(0)
      .then((res) => {
        setEvents((prev) => {
          const seen = new Set(prev.map((e) => e.seq));
          const merged = [...prev, ...res.events.filter((e) => !seen.has(e.seq))];
          merged.sort((a, b) => a.seq - b.seq);
          return merged.slice(-MAX_EVENTS);
        });
        for (const ev of res.events) if (ev.seq > lastSeqRef.current) lastSeqRef.current = ev.seq;
      })
      .catch((err) => console.error("event backfill failed", err));
  }, [runId]);

  // Replay seek: the playhead jumped, so rebuild the event feed from scratch.
  const replayEpoch = useSyncExternalStore(
    replay ? replay.onStatus : noopSubscribe,
    () => replay?.getStatus().epoch ?? 0,
  );
  useEffect(() => {
    if (!replayEpoch) return;
    let cancelled = false;
    lastSeqRef.current = Number.MAX_SAFE_INTEGER; // drop stream events until backfilled
    setEvents([]);
    setNowTs(clockNow());
    void source.fetchState().then((s) => !cancelled && setState(s));
    void source.fetchMap().then((m) => !cancelled && setMap(m));
    source
      .fetchEvents(0)
      .then((res) => {
        if (cancelled) return;
        setEvents(res.events.slice(-MAX_EVENTS));
        lastSeqRef.current = res.events.length ? res.events[res.events.length - 1].seq : 0;
      })
      .catch((err) => console.error("event backfill failed", err));
    return () => {
      cancelled = true;
    };
  }, [replayEpoch]);

  // ---- derived data ----

  const sortedAgents = useMemo(
    () =>
      [...(state?.agents ?? [])].sort(
        (a, b) =>
          STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
          a.agentId.localeCompare(b.agentId),
      ),
    [state],
  );

  const followTarget = useMemo(() => {
    if (!state) return null;
    let sx = 0;
    let sy = 0;
    let n = 0;
    for (const a of state.agents) {
      if (a.status === "alive" && a.x != null && a.y != null) {
        sx += a.x;
        sy += a.y;
        n++;
      }
    }
    return n > 0 ? { x: sx / n, y: sy / n } : null;
  }, [state]);

  const recentSays = useMemo(
    () =>
      events.filter(
        (e) => e.kind === "say" && nowTs - e.t < 8000 * speechScale() && e.t <= nowTs,
      ),
    [events, nowTs],
  );

  const chatEvents = useMemo(
    () => events.filter((e) => e.kind === "say"),
    [events],
  );

  const timelineEvents = useMemo(
    () =>
      events.filter(
        (e) =>
          e.kind !== "say" &&
          e.kind !== "narration" &&
          (showActions || e.kind !== "action"),
      ),
    [events, showActions],
  );

  const narrationEvents = useMemo(
    () => events.filter((e) => e.kind === "narration"),
    [events],
  );
  const latestNarration = narrationEvents[narrationEvents.length - 1];

  const agentNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of state?.agents ?? []) m.set(a.agentId, a.name ?? a.agentId);
    return m;
  }, [state]);

  const chatScroll = useAutoScroll(chatEvents.length);
  const timelineScroll = useAutoScroll(timelineEvents.length);
  const storyScroll = useAutoScroll(narrationEvents.length);

  const onAgentClick = (a: AgentView) => {
    if (a.x == null || a.y == null) return;
    setFollow(false);
    setFocus((f) => ({ x: a.x as number, y: a.y as number, seq: (f?.seq ?? 0) + 1 }));
  };

  const onCameraSelect = (a: AgentView) => {
    if (a.x == null || a.y == null) return;
    onAgentClick(a);
    setView("map");
  };

  const heardByLine = (ev: RunEvent): string | null => {
    const hb = ev.data?.heardBy;
    if (!Array.isArray(hb)) return null;
    if (hb.length === 0) return "(no one nearby heard)";
    const names = hb.map((id) =>
      (agentNameById.get(String(id)) ?? String(id)).toUpperCase(),
    );
    return `heard by ${names.join(", ")}`;
  };

  const stats = state?.stats;

  return (
    <div className={`app${latestNarration ? " has-narration" : ""}${replayMode ? " is-replay" : ""}`}>
      <header className="topbar">
        <div className="title">
          OHOL Agent Civilization
          {mockMode && <span className="badge-mock">MOCK</span>}
          {replayMode && <span className="badge-mock badge-replay">REPLAY</span>}
        </div>
        <div className="run-info">
          {state ? (
            <>
              <span className="run-chip">{state.run.model}</span>
              <span className="run-chip">{state.run.memoryMode}</span>
              <span className="run-chip">
                up {fmtDuration(nowTs - state.run.startedAt)}
              </span>
              {state.run.status === "idle" ? (
                <span className="run-chip" style={{ color: "#f0c060", borderColor: "#f0c060" }}>
                  IDLE: waiting for start
                </span>
              ) : state.run.status === "halted" ? (
                <span className="run-chip" style={{ color: "#ff6b6b", borderColor: "#ff6b6b" }} title={state.run.haltReason ?? ""}>
                  HALTED: {state.run.haltReason}
                </span>
              ) : state.run.limits ? (
                <span className="run-chip" title="run halts automatically at any of these">
                  limits: gen ≤{state.run.limits.maxGeneration} · {state.run.limits.maxLives} lives · {state.run.limits.maxRuntimeMin}m · ${state.run.limits.maxCostUsd}
                </span>
              ) : null}
            </>
          ) : (
            <span className="dim">connecting…</span>
          )}
        </div>
        {!replayMode && state?.control && (
          <span className="run-chip" title="LLM spend across all runs since the service started; Start is refused past the cap">
            all runs ${state.control.totalCostUsd.toFixed(2)}{state.control.maxTotalCostUsd > 0 ? ` / $${state.control.maxTotalCostUsd}` : ""}
          </span>
        )}
        {!mockMode && !replayMode && state && <RunControl status={state.run.status} open={!!state.control?.open} />}
        <div className="stats">
          {stats && (
            <>
              <span>alive {stats.alive}</span>
              <span>births {stats.totalBirths}</span>
              <span>deaths {stats.totalDeaths}</span>
              <span>gen {stats.maxGeneration}</span>
              <span>families {stats.families}</span>
              <span>llm {stats.llmCalls}</span>
              <span>${stats.llmCostUsd.toFixed(2)}</span>
            </>
          )}
        </div>
        {offline && (
          <div className="badge-offline" title={apiUrl}>
            offline
          </div>
        )}
      </header>

      {replay && <PlaybackBar />}

      {latestNarration && (
        <div className="narration-banner" title="the narrator's latest plot summary">
          <span className="narr-text">“{latestNarration.text}”</span>
          <span className="narr-time">{fmtTime(latestNarration.t)}</span>
        </div>
      )}

      <main className="middle">
        <div className="map-area">
          <div className="view-toggle">
            <button
              type="button"
              className={view === "cameras" ? "active" : ""}
              onClick={() => setView("cameras")}
            >
              Cameras
            </button>
            <button
              type="button"
              className={view === "map" ? "active" : ""}
              onClick={() => setView("map")}
            >
              Map
            </button>
          </div>
          {view === "map" ? (
            <MapCanvas
              cells={map?.cells ?? EMPTY_CELLS}
              names={map?.names ?? EMPTY_NAMES}
              players={state?.players ?? []}
              recentSays={recentSays}
              follow={follow}
              followTarget={followTarget}
              focus={focus}
              onUserPan={() => setFollow(false)}
              onToggleFollow={() => setFollow((f) => !f)}
            />
          ) : (
            <CameraGrid
              agents={sortedAgents}
              players={state?.players ?? []}
              cells={map?.cells ?? EMPTY_CELLS}
              names={map?.names ?? EMPTY_NAMES}
              says={chatEvents}
              onSelect={onCameraSelect}
            />
          )}
        </div>
        <aside className="sidebar">
          {sortedAgents.map((a) => (
            <AgentCard key={a.agentId} agent={a} onClick={onAgentClick} />
          ))}
          {sortedAgents.length === 0 && (
            <div className="dim sidebar-empty">no agents yet</div>
          )}
        </aside>
      </main>

      <footer className="bottom">
        <section className="panel">
          <div className="panel-head">
            Chat <span className="dim">({chatEvents.length})</span>
            <span className="chat-note">
              all speech shown; characters only hear people nearby
            </span>
          </div>
          <div
            className="scroll"
            ref={chatScroll.ref}
            onScroll={chatScroll.onScroll}
          >
            {chatEvents.map((ev) => {
              const heard = heardByLine(ev);
              return (
                <div key={ev.seq}>
                  <div className="line">
                    <span className="time">{fmtTime(ev.t)}</span>{" "}
                    <span
                      className="name"
                      style={{
                        color: ev.agentId ? agentColor(ev.agentId) : "#8b949e",
                      }}
                    >
                      {ev.name ?? "?"}
                    </span>
                    <span className="dim">: </span>
                    <span>{ev.text}</span>
                  </div>
                  {heard && <div className="heard-by">{heard}</div>}
                </div>
              );
            })}
            {chatEvents.length === 0 && (
              <div className="line dim">no chat yet</div>
            )}
          </div>
        </section>
        <section className="panel">
          <div className="panel-head">
            Timeline <span className="dim">({timelineEvents.length})</span>
            <label className="actions-toggle">
              <input
                type="checkbox"
                checked={showActions}
                onChange={(e) => setShowActions(e.target.checked)}
              />
              actions
            </label>
          </div>
          <div
            className="scroll"
            ref={timelineScroll.ref}
            onScroll={timelineScroll.onScroll}
          >
            {timelineEvents.map((ev) => (
              <div className={`line ev-${ev.kind}`} key={ev.seq}>
                <span className="time">{fmtTime(ev.t)}</span>{" "}
                <span className={`kind k-${ev.kind}`}>{ev.kind}</span>{" "}
                {ev.name && <span className="name">{ev.name}: </span>}
                <span>{ev.text}</span>
              </div>
            ))}
            {timelineEvents.length === 0 && (
              <div className="line dim">no events yet</div>
            )}
          </div>
        </section>
        <section className="panel">
          <div className="panel-head">
            Story <span className="dim">({narrationEvents.length})</span>
          </div>
          <div
            className="scroll"
            ref={storyScroll.ref}
            onScroll={storyScroll.onScroll}
          >
            {narrationEvents.map((ev) => (
              <div className="story-line" key={ev.seq}>
                <span className="time">{fmtTime(ev.t)}</span>{" "}
                <span className="story-text">“{ev.text}”</span>
              </div>
            ))}
            {narrationEvents.length === 0 && (
              <div className="line dim">the narrator has not spoken yet</div>
            )}
          </div>
        </section>
      </footer>
    </div>
  );
}


// Start/stop button. The password is the server's CONTROL_TOKEN; it's kept in
// this browser's localStorage after the first successful use.
const TOKEN_KEY = "ohol-control-token";

function RunControl({ status, open }: { status: "idle" | "running" | "halted"; open: boolean }) {
  const [busy, setBusy] = useState(false);
  const running = status === "running";
  const act = async () => {
    const verb = running ? "halt" : "start";
    if (running && !window.confirm("Stop the run? All agents disconnect.")) return;
    let token = open ? "" : localStorage.getItem(TOKEN_KEY);
    if (!token && !open) {
      token = window.prompt("Password to start/stop runs:")?.trim() ?? "";
      if (!token) return;
    }
    setBusy(true);
    try {
      const res = await fetch(`${apiUrl}/api/${verb}`, {
        method: "POST",
        headers: token ? { authorization: `Bearer ${token}` } : {},
      });
      if (res.status === 403) {
        localStorage.removeItem(TOKEN_KEY);
        window.alert("Wrong password.");
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { ok: boolean; result?: string };
      if (!body.ok) window.alert(body.result ?? "Refused.");
      if (!open && token) localStorage.setItem(TOKEN_KEY, token);
    } catch (err) {
      window.alert(`Couldn't ${verb} the run: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <button className={`run-control ${running ? "stop" : "start"}`} onClick={act} disabled={busy}>
      {busy ? "…" : running ? "■ Stop run" : status === "halted" ? "▶ Start new run" : "▶ Start run"}
    </button>
  );
}

const noopSubscribe = () => () => {};

function useReplayStatus(): ReplayStatus | null {
  return useSyncExternalStore(
    replay ? replay.onStatus : noopSubscribe,
    () => replay?.getStatus() ?? null,
  );
}

function fmtMB(n: number): string {
  return `${(n / 1e6).toFixed(1)} MB`;
}

function PlaybackBar() {
  const st = useReplayStatus();
  const r = replay;
  if (!r || !st) return null;
  if (st.loading || st.error) {
    return (
      <div className="replay-loading">
        {st.error ? (
          <span style={{ color: "#ff6b6b" }}>Couldn't load recording: {st.error}</span>
        ) : (
          <span>Loading recording… {st.loadedBytes > 0 && fmtMB(st.loadedBytes)}</span>
        )}
      </div>
    );
  }
  const total = st.end - st.start;
  const elapsed = st.playhead - st.start;
  return (
    <div className="playback-bar">
      <button
        type="button"
        className="pb-play"
        onClick={() => r.setPlaying(!st.playing)}
        title={st.playing ? "pause" : "play"}
      >
        {st.playing ? "❚❚" : "▶"}
      </button>
      <span className="pb-time">{fmtDuration(elapsed)}</span>
      <input
        className="pb-scrub"
        type="range"
        min={0}
        max={total}
        step={1000}
        value={elapsed}
        onChange={(e) => r.seek(st.start + Number(e.target.value))}
      />
      <span className="pb-time">{fmtDuration(total)}</span>
      <div className="pb-speeds">
        {SPEEDS.map((sp) => (
          <button
            key={sp}
            type="button"
            className={sp === st.speed ? "active" : ""}
            onClick={() => r.setSpeed(sp)}
          >
            {sp}x
          </button>
        ))}
      </div>
    </div>
  );
}
