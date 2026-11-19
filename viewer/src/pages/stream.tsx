import { hairColorForTraits } from "../ohol/appearance.ts";
// 1920x1080 stream overlay (stream.html; <body class="stream">). Follows the director's focus.
// Every piece of user/model text renders as React text (escaped), clamped by CSS.
import { TRAITS_SHOWN } from "../shared/personality.ts";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { AgentView, Invention, LifeRecord, MapCellTuple, PlayerView, RunEvent } from "../api-types.ts";
import { getClient, useInventions, useLives, useMap, useMinimap, useNow, useObjectNames, useWorldState } from "../data/index.ts";
import { ageStage, cueLabel, cueOfSay, deathReasonText, displayName, FlowerIcon, formatAge, formatRelative, LOST_IN_THOUGHT, lostInThought, ObjectIcon, PersonPortrait, withFamilyNames } from "../shared/index.ts";
import { flowersForLives } from "../ohol/flower.ts";
import { Sticker, Wordmark } from "../theme/index.ts";
import { backHome, biomeName, cutawayShot, headlineNumbers, latestNarrations, objectIdsByName, recentOf, runTimeParts, selectTicker, shortAgo, speechBubbles, describeAction, traitTags, warmthLabel, type TickerItem } from "../stream/logic.ts";
import { CELL, FOCUS_DROP, WorldCamera } from "../stream/WorldCamera.tsx";
import { MiniMap } from "../stream/MiniMap.tsx";
import { ChatBox } from "../stream/ChatBox.tsx";
import { chatLines } from "../stream/crowd.ts";
import "../stream/stream.css";
import { mount } from "./mount.tsx";

const EMPTY_PLAYERS: PlayerView[] = [];
const EMPTY_AGENTS: AgentView[] = [];
const EMPTY_CELLS: MapCellTuple[] = [];

/** Scale the fixed 1920x1080 stage to fit any viewport (OBS uses 1920x1080 exactly). */
function useFitScale(): number {
  const calc = () => Math.min(window.innerWidth / 1920, window.innerHeight / 1080) || 1;
  const [s, setS] = useState(calc);
  useEffect(() => {
    const on = () => setS(calc());
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return s;
}

/** Phone/small screens: the overlay becomes a scrolling column (same query as stream.css). OBS (1920x1080) never matches. */
const PHONE_QUERY = "(max-width: 820px), (orientation: landscape) and (max-height: 500px)";
function usePhone(): boolean {
  const q = typeof window !== "undefined" && window.matchMedia ? window.matchMedia(PHONE_QUERY) : null;
  const [on, setOn] = useState(() => !!q?.matches);
  useEffect(() => {
    if (!q) return;
    const f = () => setOn(q.matches);
    q.addEventListener("change", f);
    return () => q.removeEventListener("change", f);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return on;
}

/** prefers-reduced-motion: the ticker stops scrolling (it still updates). */
function useReducedMotion(): boolean {
  const q = typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
  const [on, setOn] = useState(() => !!q?.matches);
  useEffect(() => {
    if (!q) return;
    const f = () => setOn(q.matches);
    q.addEventListener("change", f);
    return () => q.removeEventListener("change", f);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return on;
}

function Stream() {
  const w = useWorldState();
  const lives0 = useLives();
  // unnamed people show their family name ("Unnamed Valley")
  const lives = useMemo(() => {
    const named = withFamilyNames(lives0.lives);
    return named === lives0.lives ? lives0 : { ...lives0, lives: named, byId: Object.fromEntries(named.map((l) => [l.lifeId, l])) };
  }, [lives0]);
  const map = useMap();
  const minimap = useMinimap();
  const names = useObjectNames();
  const now = useNow(1000);
  const scale = useFitScale();
  const phone = usePhone();
  const camRef = useRef<HTMLElement>(null);
  const camStage = useCallback(() => camRef.current?.querySelector<HTMLElement>(".cam-stage") ?? null, []);
  const isStatic = getClient().isStatic;
  const state = w.state;

  // server clock (bubbles, "ago"): browser now + skew measured at the last poll
  const skew = !isStatic && state && w.lastUpdate ? state.now - w.lastUpdate : 0;
  const serverNow = isStatic ? now : now + skew;

  const focus = state?.focus ?? null;
  const agent: AgentView | null = state?.agents.find((a) => a.agentId === focus?.agentId) ?? null;
  const lifeId = focus?.lifeId ?? agent?.lifeId ?? null;
  const life: LifeRecord | undefined = lifeId ? lives.byId[lifeId] : undefined;
  const players = state?.players ?? EMPTY_PLAYERS;
  // each person's hair colour, as the camera draws it, for their minimap dot
  const dimsForHair = lives.traitDims.length ? lives.traitDims : (state?.traitDims ?? []);
  const hairOf = useMemo(() => {
    const byPlayer = new Map<number, string>();
    for (const q of players) {
      const l = q.lifeId ? lives.byId[q.lifeId] : undefined;
      if (l?.traits) byPlayer.set(q.id, hairColorForTraits(l.traits, dimsForHair));
    }
    return (pid: number) => byPlayer.get(pid) ?? null;
  }, [players, lives.byId, dimsForHair]);
  // each person's flower (the chat box shows it by their name)
  const lifeFlowers = useMemo(() => flowersForLives(lives.lives), [lives.lives]);
  const flowerOf = useMemo(() => {
    const byPlayer = new Map<number, NonNullable<PlayerView["flower"]>>();
    for (const q of players) {
      const f = q.flower ?? (q.lifeId ? (lives.byId[q.lifeId]?.flower ?? lifeFlowers.get(q.lifeId)) : null);
      if (f) byPlayer.set(q.id, f);
    }
    return (pid: number) => byPlayer.get(pid) ?? null;
  }, [players, lives.byId, lifeFlowers]);
  const player = players.find((p) => lifeId && p.lifeId === lifeId) ?? (agent?.playerId != null ? players.find((p) => p.id === agent.playerId) : undefined);
  const focusPlayerId = player?.id ?? life?.playerId ?? agent?.playerId ?? null;

  // the focused character died (the director holds on them for a few seconds)
  const deathEv = useMemo(() => {
    if (!focus?.agentId || !life) return null;
    for (let i = w.events.length - 1; i >= 0; i--) {
      const e = w.events[i];
      if (e.t < life.bornAt) break;
      if (e.kind === "death" && (e.playerId === life.playerId || (e.agentId === focus.agentId && e.t >= (focus.since ?? 0) - 15_000))) return e;
    }
    return null;
  }, [w.events, life, focus?.agentId, focus?.since]);
  const focusDead = !!focus?.agentId && (!!deathEv || life?.status === "dead" || (!!state && !player && agent?.status === "dead"));
  const nobody = !focus?.agentId;

  const runLineages = useMemo(() => {
    const runId = state?.run.id;
    const seen = new Map<string, number>();
    for (const l of lives.lives) if (!runId || l.runId === runId) seen.set(l.lineageId, Math.min(seen.get(l.lineageId) ?? Infinity, l.bornAt));
    return [...seen.entries()].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0])).map((x) => x[0]);
  }, [lives.lives, state?.run.id]);
  const lineageKey = runLineages.join("|");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const lineageIds = useMemo(() => runLineages, [lineageKey]);

  const idsByName = useMemo(() => objectIdsByName(names), [names]);

  // speech bubbles: newest line per speaker in the last few seconds ("+HOMESICK+" is an emote)
  const bubbleSecond = Math.floor(serverNow / 1000);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const bubbles = useMemo(() => speechBubbles(w.events, serverNow), [w.events, bubbleSecond]);

  // who is on screen (reported by the camera), for the chat box
  const [inView, setInView] = useState<ReadonlySet<number>>(() => new Set());
  const onInView = useCallback((ids: number[]) => setInView(new Set(ids)), []);

  const [cell, setCell] = useState<{ x: number; y: number; biome: number | null } | null>(null);
  const cellRef = useRef(cell);
  const onCell = useCallback((c: { x: number; y: number; biome: number | null } | null) => {
    const p = cellRef.current;
    if (p === c || (p && c && p.x === c.x && p.y === c.y && p.biome === c.biome)) return;
    cellRef.current = c;
    setCell(c);
  }, []);

  const lastDeath = useMemo(() => {
    for (let i = w.events.length - 1; i >= 0; i--) if (w.events[i].kind === "death") return w.events[i];
    return null;
  }, [w.events]);

  const deathAge = (deathEv?.data as { age?: unknown } | undefined)?.age;
  const deathCard = focusDead ? (
    <>
      <b className="ugc">† {displayName(life?.name ?? agent?.name ?? player?.name)}</b>
      <span>, age {Math.floor(typeof deathAge === "number" ? deathAge : (life?.ageAtDeath ?? player?.age ?? agent?.age ?? 0))}</span>
    </>
  ) : null;

  // no /api/state yet (still connecting, or the service was down when OBS started): say so,
  // rather than claiming that nobody is alive
  const tuning = !state;
  const emptyCard = tuning ? (
    <div className="between">
      <div className="k">Tuning in</div>
      <h2>Finding the world…</h2>
      <p>The picture will appear as soon as the world answers.</p>
    </div>
  ) : nobody ? (
    <div className="between">
      <div className="k">Between generations</div>
      <h2>Everyone is resting for now</h2>
      <p>The world waits for its next Eve. The berries grow back anyway.</p>
      {lastDeath && (
        <p className="last ugc">
          Last to go: <b>{displayName(lastDeath.name)}</b>
          {typeof (lastDeath.data as { age?: unknown } | undefined)?.age === "number" ? `, ${Math.floor((lastDeath.data as { age: number }).age)}` : ""}
        </p>
      )}
    </div>
  ) : undefined;

  const fx = agent?.x ?? life?.birthX ?? null;
  const fy = agent?.y ?? life?.birthY ?? null;
  const fallback = useMemo(() => (fx != null && fy != null ? { x: fx, y: fy } : null), [fx, fy]);

  // a short cutaway (focus.cutaway): the camera shows its target; the side panel stays on the main subject
  const shot = nobody || focusDead ? null : cutawayShot(focus?.cutaway, serverNow, players, map.data?.cells ?? EMPTY_CELLS, names);
  const camPlayerId = nobody ? null : (shot?.playerId ?? focusPlayerId);
  const spot = shot?.spot ? { key: shot.key, x: shot.spot.x, y: shot.spot.y } : null;

  // the chat box: recent lines by the people on screen (and whoever the camera follows)
  const chatFocus = nobody || focusDead ? null : camPlayerId;
  const chat = useMemo(() => {
    const byId = new Map(players.map((q) => [q.id, q]));
    const focusLineageId = chatFocus != null ? (byId.get(chatFocus)?.lineageId ?? null) : null;
    return chatLines(w.events, { now: serverNow, inView, focusPlayerId: chatFocus, focusLineageId, who: (pid) => byId.get(pid) ?? null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [w.events, inView, chatFocus, players, bubbleSecond]);
  // people who spoke in the last half minute: their labels win the camera's collision pass
  const speakers = useMemo(() => new Set(chat.filter((l) => serverNow - l.t < 30_000).map((l) => l.playerId)), [chat, bubbleSecond]); // eslint-disable-line react-hooks/exhaustive-deps
  const chatBox = <ChatBox lines={chat} colorOf={hairOf} flowerOf={flowerOf} focusPlayerId={chatFocus} docked={phone} />;

  const offline = !isStatic && w.connection === "offline";
  // model provider down: a quiet banner (never the raw error); goes away by itself on recovery
  const thinking = !offline && lostInThought(state?.run, serverNow);
  // RUN_LABEL: always shown, top left of the camera
  const runLabel = state?.run.label?.trim() ?? "";

  // the camera's minimap inset; on phones it gets its own panel below the followed person
  const miniMap = (
    <MiniMap
      hairOf={hairOf}
      overview={minimap.data ?? null}
      worldKey={state?.run.id ?? null}
      cells={map.data?.cells ?? EMPTY_CELLS}
      players={players}
      agents={state?.agents ?? EMPTY_AGENTS}
      focusPlayerId={nobody || focusDead ? null : focusPlayerId}
      camera={nobody ? null : cell}
      cellPx={CELL}
      focusDrop={FOCUS_DROP}
      viewEl={phone ? camStage : undefined}
    />
  );

  return (
    <div className="stage-fit" style={phone ? undefined : { transform: `scale(${scale})` }}>
      <div className="frame">
        <Headline state={state} lives={lives.lives} now={serverNow} />
        <section className="cam" aria-label="camera" ref={camRef}>
          <WorldCamera
            key={w.runId ?? "none"}
            players={players}
            cells={map.data?.cells ?? []}
            idsByName={idsByName}
            lives={lives.byId}
            traitDims={lives.traitDims.length ? lives.traitDims : (state?.traitDims ?? [])}
            lineageIds={lineageIds}
            focusPlayerId={camPlayerId}
            focusDead={focusDead}
            spot={spot}
            bubbles={bubbles}
            speakers={speakers}
            colorOf={hairOf}
            onInView={onInView}
            emptyCard={emptyCard}
            deathCard={deathCard}
            fallback={fallback}
            onCell={onCell}
          >
            {runLabel && <span className="pill runlabel ugc">{runLabel}</span>}
            {(cell || shot) && !nobody && (
              <div className="camhud">
                {shot && shot.label && <span className="pill cutaway ugc">Cutaway: {shot.label}</span>}
                {cell && (
                  <span className="pill">
                    {biomeName(cell.biome)} · ({cell.x}, {cell.y})
                  </span>
                )}
              </div>
            )}
            {thinking && (
              <div className="lost-in-thought" role="status">
                {LOST_IN_THOUGHT}
              </div>
            )}
            {!phone && chatBox}
            {!phone && miniMap}
            {offline && <div className="reconnect">reconnecting…</div>}
          </WorldCamera>
        </section>
        {phone && chat.length > 0 && <section className="chatbox">{chatBox}</section>}
        <Following
          agent={agent}
          life={life}
          player={player}
          dead={focusDead}
          deathEv={deathEv}
          nobody={nobody}
          tuning={tuning}
          players={players}
          agents={state?.agents ?? []}
          byId={lives.byId}
          dims={lives.traitDims.length ? lives.traitDims : (state?.traitDims ?? [])}
          lineageIds={lineageIds}
          events={w.events}
          now={serverNow}
        />
        {phone && (
          <section className="mapbox">
            <div className="panel">
              <div className="panel-head is-leaf">
                <span className="ttl">🗺 The world</span>
              </div>
              {miniMap}
            </div>
          </section>
        )}
        <News events={w.events} agents={state?.agents ?? []} players={players} byId={lives.byId} runId={state?.run.id ?? null} now={serverNow} />
        <Inventions lives={lives.lives} byId={lives.byId} names={names} now={serverNow} />
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ headline

function Headline({ state, lives, now }: { state: ReturnType<typeof useWorldState>["state"]; lives: LifeRecord[]; now: number }) {
  const s = useMemo(() => (state ? headlineNumbers(state.stats, lives, state.run.id) : null), [state, lives]);
  const v = (n: number | undefined) => (n == null ? "–" : n);
  const [big, small] = runTimeParts(state ? now - state.run.startedAt : 0);
  return (
    <header className="top">
      <Wordmark />
      <Sticker variant="live" size={76} className="burst-live">
        LIVE!
      </Sticker>
      <div className="stats">
        <div className="chip alive">
          <div className="n">
            {v(s?.alive)} <small>alive</small>
          </div>
          <div className="k">♥ Players</div>
        </div>
        <div className="chip">
          <div className="n">{v(s?.births)}</div>
          <div className="k">Births</div>
        </div>
        <div className="chip dead">
          <div className="n">{v(s?.deaths)}</div>
          <div className="k">Deaths</div>
        </div>
        <div className="chip gen">
          <div className="n">
            {v(s?.generation)} <small>deepest</small>
          </div>
          <div className="k">Generations</div>
        </div>
        <div className="chip">
          <div className="n">
            {big}
            <small>{small}</small>
          </div>
          <div className="k">Run time</div>
        </div>
      </div>
    </header>
  );
}

// ------------------------------------------------------------------ now following

interface FollowingProps {
  agent: AgentView | null;
  life: LifeRecord | undefined;
  player: PlayerView | undefined;
  dead: boolean;
  deathEv: RunEvent | null;
  nobody: boolean;
  /** no world state yet */
  tuning?: boolean;
  players: PlayerView[];
  agents: AgentView[];
  byId: Record<string, LifeRecord>;
  dims: string[];
  lineageIds: string[];
  events: RunEvent[];
  now: number;
}

function Following(p: FollowingProps) {
  const { agent, life, player, dead, nobody, byId, players } = p;
  if (p.tuning) {
    return (
      <aside className="side">
        <div className="panel">
          <div className="panel-head is-clay">
            <span className="ttl">★ Now following</span>
          </div>
          <div className="side-empty">
            <h2>Tuning in…</h2>
          </div>
        </div>
      </aside>
    );
  }
  if (nobody || (!agent && !life)) {
    return (
      <aside className="side">
        <div className="panel">
          <div className="panel-head is-clay">
            <span className="ttl">★ Now following</span>
          </div>
          <div className="side-empty">
            <h2>Nobody, for now</h2>
            <p>No one is alive in the world. The camera will find the next arrival.</p>
          </div>
        </div>
      </aside>
    );
  }
  const age = player?.age ?? agent?.age ?? life?.ageAtDeath ?? life?.ageAtBirth ?? 0;
  const deathAge = (p.deathEv?.data as { age?: unknown } | undefined)?.age;
  const shownAge = dead && typeof deathAge === "number" ? deathAge : age;
  const gen = life?.generation ?? agent?.generation ?? null;
  const name = displayName(life?.name ?? agent?.name ?? player?.name, shownAge < 3 ? "Unnamed baby" : "Unnamed");
  const female = player?.female ?? agent?.female ?? life?.female ?? true;
  const ageOfLife = (l: LifeRecord) => players.find((x) => x.lifeId === l.lifeId)?.age ?? null;

  // mother
  let mother: string;
  const mom = life?.motherLifeId ? byId[life.motherLifeId] : undefined;
  if (mom) {
    const a = ageOfLife(mom);
    mother = mom.status === "dead" || a == null ? `${displayName(mom.name)} († ${formatAge(mom.ageAtDeath, { unit: false })})` : `${displayName(mom.name)} (alive, ${Math.floor(a)})`;
  } else if (life?.motherPlayerId != null || agent?.motherId != null) {
    const mp = players.find((x) => x.id === (life?.motherPlayerId ?? agent?.motherId));
    mother = mp ? `${displayName(mp.name)} (alive, ${Math.floor(mp.age)})` : "not one of ours";
  } else mother = gen === 1 || !life ? "none, an Eve" : "unknown";

  // kids
  const kids = (life?.childLifeIds ?? [])
    .map((id) => byId[id])
    .filter((k): k is LifeRecord => !!k)
    .sort((a, b) => a.bornAt - b.bornAt);
  const kidsText = kids.length
    ? kids
        .map((k) => {
          const a = ageOfLife(k);
          const n = displayName(k.name, "Baby");
          return k.status === "dead" || a == null ? `${n} †` : `${n} (${Math.floor(a)})`;
        })
        .join(" · ")
    : "none yet";

  const food = agent?.food ?? null;
  const cap = agent?.foodCapacity ?? null;
  const foodPct = food != null && cap ? Math.max(0, Math.min(1, food / cap)) : 0;
  const heat = agent?.heat ?? null;
  const tags = traitTags(life?.traits ?? agent?.traits ?? null, p.dims);
  const since = life?.bornAt ?? 0;
  const thoughtEv = recentOf(p.events, agent?.agentId, "thought", since, 1)[0];
  const said = recentOf(p.events, agent?.agentId, "say", since, 3);
  // their latest hands-on action (not walking, speaking or babies), in plain words
  const doing = (() => {
    for (const e of recentOf(p.events, agent?.agentId, "action", since, 12)) {
      const d = describeAction(e.text ?? "");
      if (d) return { t: e.t, text: d };
    }
    return null;
  })();
  const agentName = (id: string) => displayName(p.agents.find((a) => a.agentId === id)?.name, "someone");
  const thought = agent?.lifeId === life?.lifeId || !life ? (agent?.lastThought ?? thoughtEv?.text ?? null) : (thoughtEv?.text ?? null);

  return (
    <aside className="side">
      <div className="panel">
        <div className="panel-head is-clay">
          <span className="ttl">★ Now following</span>
          {gen != null && <span className="sub">gen {gen}</span>}
        </div>
        <div className="who">
          <div className={`photo tilt-l${dead ? " dead" : ""}`}>
            <div className="well">
              <PersonPortrait
                displayId={player?.displayId ?? life?.displayId}
                age={shownAge}
                female={female}
                lineageId={life?.lineageId ?? player?.lineageId ?? agent?.lineageId}
                livingLineageIds={p.lineageIds}
                traits={life?.traits ?? agent?.traits}
                traitDims={p.dims}
                lifeId={life?.lifeId}
                flower={life?.flower ?? player?.flower ?? agent?.flower}
                size={150}
                dead={dead}
              />
            </div>
          </div>
          <div className="who-r">
            <h2 className="nm ugc" title={name}>
              {dead ? "† " : ""}
              {name}
            </h2>
            <dl className="facts">
              <dt>Age</dt>
              <dd>
                {Math.floor(shownAge)} · {dead ? `died, ${deathReasonText(life?.deathReason ?? ((p.deathEv?.data as { reason?: string } | undefined)?.reason ?? null))}` : ageStage(shownAge)}
              </dd>
              <dt>Mother</dt>
              <dd className="ugc">{mother}</dd>
              <dt>Kids</dt>
              <dd className="ugc">{kidsText}</dd>
            </dl>
            <div className="meters">
              <div className="meter">
                <div className="k">
                  <span>Food</span>
                  <span>{food != null && cap ? `${food}/${cap}` : "?"}</span>
                </div>
                <div className="bar-track">
                  <div className="bar-fill" style={{ width: `${foodPct * 100}%`, background: `var(--gloss), ${foodPct < 0.3 ? "var(--grad-clay)" : "var(--grad-leaf)"}` }} />
                </div>
              </div>
              <div className="meter">
                <div className="k">
                  <span>Warmth</span>
                  <span>{warmthLabel(heat)}</span>
                </div>
                <div className="bar-track">
                  <div className="bar-fill" style={{ width: `${Math.max(0, Math.min(1, heat ?? 0)) * 100}%`, background: `var(--gloss), ${heat != null && (heat < 0.35 || heat > 0.65) ? "var(--grad-berry)" : "var(--grad-leaf)"}` }} />
                </div>
              </div>
            </div>
            {!dead && (player?.condition || player?.dying) && (
              <div className="condition ugc">
                ⚠ {player?.condition ? `${player.condition.kind === "sickness" ? "Sick" : "Wounded"}: ${player.condition.name}` : "Wounded"}
                {player?.dying ? " · bleeding" : ""}
              </div>
            )}
            {!dead && player?.homesick && <div className="condition homesick">🏠 Homesick: outside their family's homeland</div>}
            {!dead && !player?.homesick && backHome(p.events, { agentId: agent?.agentId, playerId: player?.id ?? life?.playerId }, since, p.now) && (
              <div className="condition back-home">🏠 Back home: returned to their family's homeland</div>
            )}
          </div>
        </div>
        {(tags.length > 0 || !TRAITS_SHOWN) && (
          <div className="sec">
            <div className="label">Personality</div>
            <div className="traitrow">
              {(TRAITS_SHOWN ? tags : ["none"]).map((t) => (
                <span key={t} className="pill">
                  {t}
                </span>
              ))}
            </div>
          </div>
        )}
        <div className="sec">
          <div className="label">Thinking</div>
          <div className="thought thinking">
            {thoughtEv && <span className="t">{formatRelative(thoughtEv.t, p.now)}</span>}
            <span className="tx ugc">{thought ?? "Nothing on their mind yet."}</span>
          </div>
        </div>
        {doing && (
          <div className="sec doing-sec">
            <div className="label">Doing</div>
            <div className="thought">
              <span className="t">{formatRelative(doing.t, p.now)}</span>{" "}
              <span className="tx ugc">{doing.text}</span>
            </div>
          </div>
        )}
        <div className="sec said-sec">
          <div className="label">Said recently</div>
          {said.length === 0 ? (
            <p className="muted quiet">Hasn't said anything yet.</p>
          ) : (
            <ul className="said">
              {said.map((e) => {
                const heard = Array.isArray((e.data as { heardBy?: unknown } | undefined)?.heardBy) ? ((e.data as { heardBy: unknown[] }).heardBy.filter((x) => typeof x === "string") as string[]) : [];
                return (
                  <li key={e.seq}>
                    <time>{shortAgo(e.t, p.now)}</time>
                    {cueOfSay(e.text) ? <span className="emote-label">({cueLabel(cueOfSay(e.text)!)})</span> : <span className="speech ugc">{e.text}</span>}
                    {heard.length > 0 && <span className="to">heard by {heard.slice(0, 3).map(agentName).join(", ")}</span>}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </aside>
  );
}

// ------------------------------------------------------------------ world news + ticker

function News({ events, agents, players, byId, runId, now }: { events: RunEvent[]; agents: AgentView[]; players: PlayerView[]; byId: Record<string, LifeRecord>; runId: string | null; now: number }) {
  // keep the newest narrations on screen until newer ones arrive: at one line every few minutes they would
  // otherwise scroll out of the page's recent-events window (busy worlds) and the box would go blank
  const narrKeep = useRef<{ runId: string | null; list: RunEvent[] }>({ runId: null, list: [] });
  const fresh = latestNarrations(events, 2);
  if (narrKeep.current.runId !== runId) narrKeep.current = { runId, list: [] };
  const merged = [...fresh, ...narrKeep.current.list].filter((e, i, arr) => arr.findIndex((x) => x.seq === e.seq) === i).sort((x, y) => y.t - x.t).slice(0, 2);
  narrKeep.current.list = merged;
  const narr = merged;
  const items = useMemo(() => {
    const agentNames: Record<string, string | null> = {};
    for (const a of agents) agentNames[a.agentId] = a.name;
    const pn = new Map<number, string | null>();
    for (const l of Object.values(byId)) if (!runId || l.runId === runId) pn.set(l.playerId, l.name);
    for (const p of players) if (p.name) pn.set(p.id, p.name);
    const known = new Set<string>();
    for (const n of pn.values()) if (n) known.add(n.trim().split(/\s+/)[0].toUpperCase());
    return selectTicker(events, { agentNames, playerName: (id) => pn.get(id) ?? null, knownFirstNames: known });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events, runId, byId]);
  return (
    <section className="newsbox">
      <div className="panel">
        <div className="panel-head is-navy">
          <span className="ttl">📻 World News</span>
        </div>
        <ul className="feed">
          {narr.length === 0 && <li className="now"><time /> <span>No news yet. The narrator is watching.</span></li>}
          {narr.map((e, i) => (
            <li key={e.seq} className={i === 0 ? "now" : "old"}>
              <time>{shortAgo(e.t, now) === "now" ? "now" : `${shortAgo(e.t, now)} ago`}</time>
              <span className="ugc">{e.text}</span>
            </li>
          ))}
        </ul>
        <Ticker items={items} />
      </div>
    </section>
  );
}

/** Marquee: new items are swapped in at the end of a loop, so the crawl never jumps. */
function Ticker({ items }: { items: TickerItem[] }) {
  const still = useReducedMotion();
  const [shown, setShown] = useState(items);
  const pending = useRef(items);
  pending.current = items;
  const boxRef = useRef<HTMLDivElement>(null);
  const runRef = useRef<HTMLDivElement>(null);
  const [dur, setDur] = useState(0);
  const sig = (xs: TickerItem[]) => xs.map((x) => x.text).join("\n");
  useEffect(() => {
    if (!dur && sig(items) !== sig(shown)) setShown(items);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, dur]);
  useLayoutEffect(() => {
    const box = boxRef.current;
    const run = runRef.current;
    if (!box || !run) return;
    const w = run.scrollWidth;
    // reduced motion: no crawl (dur 0), so new items swap in directly instead of at the loop's end
    setDur(!still && w > box.clientWidth ? Math.max(20, w / 70) : 0);
  }, [shown, still]);
  const onLoop = () => {
    if (sig(pending.current) !== sig(shown)) setShown(pending.current);
  };
  const content = (copy: number) =>
    shown.map((it) => (
      <span key={`${copy}-${it.key}`} className={`tk tk-${it.kind}`}>
        {it.text}
      </span>
    ));
  return (
    <div className="crawl">
      <div className="lab">ALSO</div>
      <div className="txt" ref={boxRef}>
        {shown.length === 0 ? (
          <span className="tk tk-quiet">Quiet out there, for now</span>
        ) : (
          <div className={`track${dur ? " run" : ""}`} style={dur ? { animationDuration: `${dur}s` } : undefined} onAnimationIteration={onLoop}>
            <div className="tk-seg" ref={runRef}>
              {content(0)}
            </div>
            {dur > 0 && (
              <div className="tk-seg" aria-hidden>
                {content(1)}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ recent inventions

/** Rows that fit the panel. */
const INVENTION_ROWS = 5;

/** The newest firsts: each item the first time anyone in this world made it (GET /api/inventions). */
function Inventions({ lives, byId, names, now }: { lives: LifeRecord[]; byId: Record<string, LifeRecord>; names: Record<number, string>; now: number }) {
  const { inventions } = useInventions(INVENTION_ROWS);
  const flowers = useMemo(() => flowersForLives(lives), [lives]);
  const byName = useMemo(() => objectIdsByName(names), [names]);
  return (
    <section className="inventions">
      <div className="panel">
        <div className="panel-head is-berry">
          <span className="ttl">💡 Recent inventions</span>
        </div>
        {inventions.length ? (
          <ol className="inv-list">
            {inventions.slice(0, INVENTION_ROWS).map((inv) => (
              <InventionRow key={`${inv.runId}|${inv.objectId ?? inv.item}`} inv={inv} life={inv.lifeId ? (byId[inv.lifeId] ?? null) : null} flowers={flowers} byName={byName} now={now} />
            ))}
          </ol>
        ) : (
          <p className="inv-empty">Nothing invented yet.</p>
        )}
      </div>
    </section>
  );
}

function InventionRow({ inv, life, flowers, byName, now }: { inv: Invention; life: LifeRecord | null; flowers: Map<string, NonNullable<LifeRecord["flower"]>>; byName: Map<string, number>; now: number }) {
  const objectId = inv.objectId ?? byName.get(inv.item.toLowerCase()) ?? null;
  const flower = life?.flower ?? (inv.lifeId ? flowers.get(inv.lifeId) : null) ?? null;
  const who = displayName(life?.name ?? inv.name, "someone");
  return (
    <li>
      <span className="inv-icon">{objectId != null && <ObjectIcon objectId={objectId} size={42} title={inv.item} />}</span>
      <span className="inv-main">
        <b className="inv-item">{inv.item}</b>
        <span className="inv-by ugc">
          by {who}
          {flower && <FlowerIcon flower={flower} size={20} />}
        </span>
      </span>
      <time>{formatRelative(inv.t, now)}</time>
    </li>
  );
}

mount(<Stream />);
