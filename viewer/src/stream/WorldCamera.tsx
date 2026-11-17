// The stream camera: the world around the focused character, drawn with the
// real OHOL renderer (ground, floors, objects, people) on one canvas, plus DOM
// name labels and speech bubbles positioned every frame.
//
// One requestAnimationFrame loop; it only repaints when something moved (camera,
// a walking figure, a fade, freshly loaded sprites, new data), so an idle scene
// costs next to nothing in OBS. All per-player state is pruned to the players
// currently in view; the map index is bounded to a window around the camera.

import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { LifeRecord, MapCellTuple, PlayerView } from "../api-types.ts";
import { appearanceFor, drawGround, drawObject, drawPerson, getOholAssets, loadOholAssets, onOholSpriteLoaded } from "../ohol/index.ts";
import type { Appearance } from "../ohol/index.ts";
import { displayName } from "../shared/format.ts";
import { cameraStep, fanOut, focusTransition, parseHeld, retarget, sampleMotion, type Cam, type Motion } from "./logic.ts";

/** screen px per world tile (the game uses 128) */
export const CELL = 112;
const SCALE = CELL / 128;
/** focused character sits a little below centre: people extend upward */
const FOCUS_DROP = 0.55;
/** map window kept indexed around the camera, in tiles (radius) */
const WINDOW = 40;
const FADE_MS = 260;
const GHOST_MS = 2600;

export interface Bubble {
  key: string;
  playerId: number;
  text: string;
}

export interface CameraProps {
  players: PlayerView[];
  cells: MapCellTuple[];
  /** lower-cased object name -> id */
  idsByName: Map<string, number>;
  lives: Record<string, LifeRecord>;
  traitDims: string[];
  /** lineages kept visually apart (every lineage of this run, oldest first) */
  lineageIds: string[];
  /** focused character's player id (null: nobody) */
  focusPlayerId: number | null;
  /** the focused character just died: draw the last known figure fading out */
  focusDead: boolean;
  /** latest line per speaker, already filtered to the last few seconds */
  bubbles: Bubble[];
  /** shown centred when nobody is alive */
  emptyCard?: React.ReactNode;
  /** shown over the focused character when they die */
  deathCard?: React.ReactNode;
  /** small overlays (biome pill, reconnecting), positioned by the caller's CSS */
  children?: React.ReactNode;
  /** where to look when the focused character is not (or no longer) in view, e.g. their last known tile */
  fallback?: { x: number; y: number } | null;
  onCell?: (cell: { x: number; y: number; biome: number | null } | null) => void;
}

interface Figure {
  id: number;
  name: string;
  age: number;
  displayId: number;
  female: boolean;
  appearance: Appearance | null;
  heldObjectId: number | null;
  /** another player is carrying this one */
  carriedBy: number | null;
  /** babies this player carries (player ids) */
  carrying: number[];
}

type Drawable = { kind: "obj"; sy: number; sx: number; id: number } | { kind: "person"; sy: number; sx: number; fig: Figure; alpha: number; ghost: boolean };

const cellKey = (x: number, y: number) => `${x},${y}`;

/** approximate standing height in tiles (for bubble placement) */
function personHeight(age: number): number {
  if (age < 3) return 0.62;
  if (age < 14) return 0.62 + ((age - 3) / 11) * 0.72;
  return 1.45;
}

function WorldCameraImpl(props: CameraProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const fadeRef = useRef<HTMLDivElement>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const [ready, setReady] = useState(() => getOholAssets() != null);

  // ---- per-player motion (bounded to present players + the dying focus)
  const motions = useRef(new Map<number, Motion>());
  const dirty = useRef(true);
  const ghost = useRef<{ fig: Figure; x: number; y: number; t0: number } | null>(null);
  const lastFocusFig = useRef<{ fig: Figure; x: number; y: number } | null>(null);

  useEffect(() => {
    if (ready) return;
    let live = true;
    loadOholAssets()
      .then(() => live && setReady(true))
      .catch((e) => console.warn(String(e)));
    return () => {
      live = false;
    };
  }, [ready]);

  // ---- figures (appearance resolved once per data change, not per frame)
  const appearanceCache = useRef(new Map<string, Appearance>());
  const lineageKey = props.lineageIds.join("|");
  const figures = useMemo(() => {
    const cache = appearanceCache.current;
    if (cache.size > 300) cache.clear();
    const m = getOholAssets()?.manifest;
    const out = new Map<number, Figure>();
    const byId = new Map(props.players.map((p) => [p.id, p]));
    const byName = new Map(props.players.filter((p) => p.name).map((p) => [p.name!.toUpperCase(), p.id]));
    const carriedBy = new Map<number, number>();
    for (const p of props.players) {
      const h = parseHeld(p.held);
      if (h?.kind !== "baby") continue;
      const bid = h.playerId ?? (h.name ? byName.get(h.name.toUpperCase()) : undefined);
      if (bid != null && bid !== p.id && byId.has(bid)) carriedBy.set(bid, p.id);
    }
    for (const p of props.players) {
      const life = p.lifeId ? props.lives[p.lifeId] : undefined;
      const female = p.female ?? life?.female ?? true;
      const lineageId = p.lineageId ?? life?.lineageId ?? null;
      let appearance: Appearance | null = null;
      if (lineageId) {
        const key = `${p.lifeId ?? p.id}|${lineageId}|${lineageKey}|${life?.traits ? "t" : "-"}|${p.displayId}`;
        appearance = cache.get(key) ?? null;
        if (!appearance) {
          appearance = appearanceFor({
            displayId: p.displayId,
            female,
            lineageId,
            traits: life?.traits ?? {},
            traitDims: props.traitDims,
            livingLineageIds: props.lineageIds.length ? props.lineageIds : undefined,
          });
          cache.set(key, appearance);
        }
      }
      const h = parseHeld(p.held);
      let heldObjectId: number | null = null;
      const carrying: number[] = [];
      if (h?.kind === "object") {
        const id = props.idsByName.get(h.name.toLowerCase());
        if (id != null && (!m || m.objects[id] || m.dummies[id])) heldObjectId = id;
      }
      for (const [baby, holder] of carriedBy) if (holder === p.id) carrying.push(baby);
      if (carrying.length) heldObjectId = byId.get(carrying[0])?.displayId ?? null;
      out.set(p.id, {
        id: p.id,
        name: displayName(p.name, p.age < 3 ? "Baby" : "Unnamed"),
        age: p.age,
        displayId: p.displayId,
        female,
        appearance,
        heldObjectId,
        carriedBy: carriedBy.get(p.id) ?? null,
        carrying,
      });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.players, props.lives, props.traitDims, lineageKey, props.idsByName, ready]);
  const figuresRef = useRef(figures);
  figuresRef.current = figures;

  // ---- retarget walks on every poll; prune the gone
  useEffect(() => {
    const now = performance.now();
    const mm = motions.current;
    const present = new Set<number>();
    for (const p of props.players) {
      present.add(p.id);
      mm.set(p.id, retarget(mm.get(p.id), p.x, p.y, now));
    }
    for (const id of [...mm.keys()]) if (!present.has(id)) mm.delete(id);
    dirty.current = true;
  }, [props.players]);

  // ---- map window index (bounded), rebuilt when the map changes or the camera leaves the window
  const index = useRef<{ cx: number; cy: number; cells: MapCellTuple[] | null; map: Map<string, MapCellTuple> }>({ cx: 0, cy: 0, cells: null, map: new Map() });
  const cam = useRef<Cam | null>(null);
  const reindex = (c: Cam) => {
    const ix = index.current;
    const cells = propsRef.current.cells;
    const cx = Math.round(c.x);
    const cy = Math.round(c.y);
    if (ix.cells === cells && Math.abs(cx - ix.cx) < WINDOW / 2 && Math.abs(cy - ix.cy) < WINDOW / 2) return;
    const map = new Map<string, MapCellTuple>();
    for (const cell of cells) if (Math.abs(cell[0] - cx) <= WINDOW && Math.abs(cell[1] - cy) <= WINDOW) map.set(cellKey(cell[0], cell[1]), cell);
    index.current = { cx, cy, cells, map };
  };
  useEffect(() => {
    dirty.current = true;
  }, [props.cells, props.bubbles, props.focusPlayerId, props.focusDead, figures]);

  // ---- focus changes: pan if near, crossfade if far
  const pendingSnap = useRef(false);
  const fadeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevFocus = useRef<number | null>(null);
  useEffect(() => {
    const id = props.focusPlayerId;
    if (id === prevFocus.current) return;
    prevFocus.current = id;
    if (id == null) return;
    const m = motions.current.get(id);
    if (!m) return;
    const to = sampleMotion(m, performance.now());
    const how = focusTransition(cam.current, to);
    if (how === "snap") cam.current = { x: to.x, y: to.y };
    else if (how === "fade" && fadeRef.current) {
      fadeRef.current.classList.add("on");
      if (fadeTimer.current) clearTimeout(fadeTimer.current);
      fadeTimer.current = setTimeout(() => {
        pendingSnap.current = true;
        fadeRef.current?.classList.remove("on");
      }, FADE_MS);
    }
  }, [props.focusPlayerId]);

  // ---- death hold: remember the focused figure, fade it out when they die
  useEffect(() => {
    if (!props.focusDead) {
      ghost.current = null;
      return;
    }
    if (!ghost.current && lastFocusFig.current) ghost.current = { ...lastFocusFig.current, t0: performance.now() };
    dirty.current = true;
  }, [props.focusDead]);

  // ---- render loop
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    let W = 0;
    let H = 0;
    const resize = () => {
      const r = wrap.getBoundingClientRect();
      // the stage may be CSS-scaled (fit-to-viewport); use layout size, not the scaled rect
      W = wrap.clientWidth || r.width;
      H = wrap.clientHeight || r.height;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      dirty.current = true;
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);
    const offSprites = onOholSpriteLoaded(() => {
      dirty.current = true;
    });

    let raf = 0;
    let last = performance.now();
    let lastCamKey = "";
    const screen = new Map<number, { x: number; y: number; head: number }>();

    const frame = () => {
      raf = requestAnimationFrame(frame);
      const now = performance.now();
      const dt = Math.min(100, now - last);
      last = now;
      const P = propsRef.current;
      const figs = figuresRef.current;
      const mm = motions.current;

      // positions (with crowd fan-out), and the camera target
      const fan = fanOut(P.players);
      const pos = new Map<number, { x: number; y: number }>();
      let moving = false;
      for (const p of P.players) {
        const m = mm.get(p.id);
        if (!m) continue;
        if (now < m.t0 + m.dur) moving = true;
        const s = sampleMotion(m, now);
        pos.set(p.id, { x: s.x + (fan.get(p.id) ?? 0), y: s.y });
      }
      // carried babies ride with their holder
      for (const f of figs.values()) if (f.carriedBy != null && pos.has(f.carriedBy)) pos.set(f.id, pos.get(f.carriedBy)!);

      let target: Cam | null = null;
      const fid = P.focusPlayerId;
      const g = ghost.current;
      if (g && P.focusDead) target = { x: g.x, y: g.y };
      else if (fid != null && pos.has(fid)) target = pos.get(fid)!;
      else if (P.fallback && (fid != null || P.focusDead)) target = P.fallback;
      if (target && (!cam.current || pendingSnap.current)) {
        cam.current = { ...target };
        pendingSnap.current = false;
      } else if (target && cam.current) cam.current = cameraStep(cam.current, target, dt);
      const c = cam.current;
      const ghostAlive = !!g && P.focusDead && now - g.t0 < GHOST_MS + 400;
      const camKey = c ? `${c.x.toFixed(4)},${c.y.toFixed(4)},${W},${H}` : "none";
      if (!dirty.current && !moving && camKey === lastCamKey && !ghostAlive) return;
      dirty.current = false;
      lastCamKey = camKey;

      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const dpr = canvas.width / Math.max(1, W);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 1;
      ctx.filter = "none";
      ctx.fillStyle = "#8d985c";
      ctx.fillRect(0, 0, W, H);
      if (!c || !getOholAssets()) {
        P.onCell?.(null);
        layout(screen, null);
        return;
      }
      reindex(c);
      const map = index.current.map;
      const ox = W / 2 - c.x * CELL;
      const oy = H / 2 + FOCUS_DROP * CELL + c.y * CELL;
      const sx = (wx: number) => ox + wx * CELL;
      const sy = (wy: number) => oy - wy * CELL;

      const x0 = Math.floor(c.x - W / 2 / CELL) - 1;
      const x1 = Math.ceil(c.x + W / 2 / CELL) + 1;
      const yTop = Math.ceil(c.y + (H / 2 + FOCUS_DROP * CELL) / CELL) + 1;
      const yBot = Math.floor(c.y - (H / 2 - FOCUS_DROP * CELL) / CELL) - 1;

      // ground
      const unexplored: [number, number][] = [];
      for (let y = yTop; y >= yBot; y--) {
        for (let x = x0; x <= x1; x++) {
          const cell = map.get(cellKey(x, y));
          const px = Math.floor(sx(x) - CELL / 2);
          const py = Math.floor(sy(y) - CELL / 2);
          if (!cell || cell[2] < 0) {
            drawGround(ctx, 0, x, y, px, py, CELL + 1);
            unexplored.push([px, py]);
          } else drawGround(ctx, cell[2], x, y, px, py, CELL + 1);
        }
      }
      // fog over cells nobody has seen
      if (unexplored.length) {
        ctx.fillStyle = "rgba(235,225,200,.5)";
        for (const [px, py] of unexplored) ctx.fillRect(px, py, CELL + 1, CELL + 1);
      }
      // floors
      for (let y = yTop; y >= yBot; y--)
        for (let x = x0; x <= x1; x++) {
          const cell = map.get(cellKey(x, y));
          if (cell && cell[3] > 0) drawObject(ctx, cell[3], sx(x), sy(y), SCALE);
        }

      // objects (generous margin above/below: trees are tall) and people, back to front
      const list: Drawable[] = [];
      for (let y = yTop + 2; y >= yBot - 1; y--)
        for (let x = x0 - 1; x <= x1 + 1; x++) {
          const cell = map.get(cellKey(x, y));
          if (cell && cell[4] > 0) list.push({ kind: "obj", sx: sx(x), sy: sy(y), id: cell[4] });
        }
      for (const [id, f] of figs) {
        if (f.carriedBy != null) continue;
        const p = pos.get(id);
        if (!p) continue;
        if (g && P.focusDead && id === g.fig.id) continue;
        list.push({ kind: "person", sx: sx(p.x), sy: sy(p.y) + 0.01, fig: f, alpha: 1, ghost: false });
      }
      if (g && P.focusDead) {
        const k = Math.min(1, (now - g.t0) / GHOST_MS);
        list.push({ kind: "person", sx: sx(g.x), sy: sy(g.y) + 0.01, fig: g.fig, alpha: 1 - 0.8 * k, ghost: true });
      }
      list.sort((a, b) => a.sy - b.sy || (a.kind === b.kind ? a.sx - b.sx : a.kind === "obj" ? -1 : 1));

      const focusSx = fid != null && pos.has(fid) ? sx(pos.get(fid)!.x) : null;
      const focusSy = fid != null && pos.has(fid) ? sy(pos.get(fid)!.y) : null;
      const motionOf = (id: number) => mm.get(id);
      for (const d of list) {
        if (d.kind === "obj") {
          drawObject(ctx, d.id, d.sx, d.sy, SCALE);
          continue;
        }
        const f = d.fig;
        const isFocus = !P.focusDead && fid != null && (f.id === fid || f.carrying.includes(fid));
        if (isFocus && focusSx != null && focusSy != null) focusRing(ctx, d.sx, d.sy);
        const m = motionOf(f.id);
        ctx.save();
        if (d.ghost) {
          ctx.globalAlpha = d.alpha;
          ctx.filter = "grayscale(1) sepia(.25)";
        }
        drawPerson(ctx, { displayId: f.displayId, age: f.age, facingLeft: m?.facingLeft ?? false, heldObjectId: f.heldObjectId, appearance: f.appearance }, d.sx, d.sy, SCALE);
        ctx.restore();
      }
      ctx.globalAlpha = 1;
      ctx.filter = "none";

      // remember the focused figure (for the death fade)
      if (fid != null && !P.focusDead && figs.get(fid) && pos.get(fid)) {
        const f = figs.get(fid)!;
        const holder = f.carriedBy != null ? figs.get(f.carriedBy) : null;
        lastFocusFig.current = { fig: holder ?? f, ...(pos.get(holder?.id ?? fid) ?? pos.get(fid)!) };
      }

      // label/bubble anchors in screen px
      screen.clear();
      for (const [id, p] of pos) {
        const f = figs.get(id);
        if (!f) continue;
        const holder = f.carriedBy != null ? figs.get(f.carriedBy) : null;
        screen.set(id, { x: sx(p.x), y: sy(p.y), head: personHeight(holder ? holder.age : f.age) * CELL });
      }
      if (g && P.focusDead) screen.set(-1, { x: sx(g.x), y: sy(g.y), head: personHeight(g.fig.age) * CELL });
      else if (P.focusDead && target) screen.set(-1, { x: sx(target.x), y: sy(target.y), head: CELL });

      const fc = target ? map.get(cellKey(Math.round(target.x), Math.round(target.y))) : undefined;
      P.onCell?.(target ? { x: Math.round(target.x), y: Math.round(target.y), biome: fc ? fc[2] : null } : null);
      layout(screen, { W, H });
    };

    /** position the DOM labels and bubbles (children of overlayRef carry data-pid / data-kind) */
    const layout = (scr: Map<number, { x: number; y: number; head: number }>, size: { W: number; H: number } | null) => {
      const ov = overlayRef.current;
      if (!ov) return;
      // focus label first so it keeps its place; others step down around it
      const els = (Array.from(ov.children) as HTMLElement[]).sort((a, b) => rank(a) - rank(b));
      const placed: { x: number; y: number; w: number; h: number }[] = [];
      const hits = (r: { x: number; y: number; w: number; h: number }) => placed.some((q) => r.x < q.x + q.w + 4 && q.x < r.x + r.w + 4 && r.y < q.y + q.h + 2 && q.y < r.y + r.h + 2);
      for (const el of els) {
        const pid = Number(el.dataset.pid);
        const a = size ? scr.get(pid) : undefined;
        // people outside the view get no label (never pin a far-away name to the edge)
        const off = !a || !size || a.x < -40 || a.x > size.W + 40 || a.y < 0 || a.y - a.head > size.H;
        if (!a || !size || off) {
          el.style.visibility = "hidden";
          continue;
        }
        el.style.visibility = "visible";
        const kind = el.dataset.kind;
        const w = el.offsetWidth;
        const h = el.offsetHeight;
        let x: number;
        let y: number;
        if (kind === "bubble") {
          x = a.x - 26;
          y = a.y - a.head - h - 14;
        } else if (kind === "death") {
          x = a.x - w / 2;
          y = a.y - a.head - h - 22;
        } else {
          const stack = Number(el.dataset.stack ?? 0);
          x = a.x - w / 2;
          y = a.y + 10 + stack * (h + 4);
        }
        x = Math.max(8, Math.min(size.W - w - 8, x));
        y = Math.max(8, Math.min(size.H - h - 8, y));
        const r = { x, y, w, h };
        const step = kind === "bubble" ? -(h + 6) : h + 4;
        for (let i = 0; i < 4 && hits(r); i++) r.y += step;
        placed.push(r);
        y = r.y;
        el.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
      }
    };

    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      offSprites();
      if (fadeTimer.current) clearTimeout(fadeTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  // ---- DOM overlays (React re-renders them on data changes; the loop only moves them)
  const labels: React.ReactNode[] = [];
  for (const f of figures.values()) {
    const isFocus = !props.focusDead && f.id === props.focusPlayerId;
    const stack = f.carriedBy != null ? 1 : 0;
    labels.push(
      <div key={`l${f.id}`} data-pid={f.carriedBy ?? f.id} data-kind="label" data-stack={stack} className={`cam-label${isFocus ? " is-focus" : ""}`}>
        <span className="nm">{f.name}</span>
        <span className="ag">{isFocus ? ` ${Math.floor(f.age)}` : ` · ${Math.floor(f.age)}`}</span>
      </div>,
    );
  }
  for (const b of props.bubbles) {
    const f = figures.get(b.playerId);
    if (!f) continue;
    labels.push(
      <div key={`b${b.key}`} data-pid={f.carriedBy ?? f.id} data-kind="bubble" className="cam-bubble speech">
        <span className="tx">{b.text}</span>
      </div>,
    );
  }
  if (props.focusDead && props.deathCard)
    labels.push(
      <div key="death" data-pid={-1} data-kind="death" className="cam-death">
        {props.deathCard}
      </div>,
    );

  return (
    <div className="cam-stage" ref={wrapRef}>
      <canvas ref={canvasRef} className="cam-canvas" />
      <div className="cam-overlay" ref={overlayRef}>
        {labels}
      </div>
      <div className="cam-vignette" />
      <div className="cam-fade" ref={fadeRef} />
      {props.emptyCard && <div className="cam-empty">{props.emptyCard}</div>}
      {props.children}
    </div>
  );
}

/** layout order: death card, focus label, bubbles (newest first in DOM), other labels */
function rank(el: HTMLElement): number {
  if (el.dataset.kind === "death") return 0;
  if (el.classList.contains("is-focus")) return 1;
  if (el.dataset.kind === "bubble") return 2;
  return 3;
}

/** subtle dashed butter ellipse under the focused character's feet */
function focusRing(ctx: CanvasRenderingContext2D, x: number, y: number) {
  ctx.save();
  ctx.setLineDash([9, 6]);
  ctx.lineWidth = 6;
  ctx.strokeStyle = "rgba(31,26,20,.55)";
  ctx.beginPath();
  ctx.ellipse(x, y - 4, CELL * 0.52, CELL * 0.15, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.lineWidth = 3;
  ctx.strokeStyle = "#f4d77e";
  ctx.stroke();
  ctx.restore();
}

export const WorldCamera = memo(WorldCameraImpl);
