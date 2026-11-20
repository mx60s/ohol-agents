// The stream camera: the world around the focused character, drawn with the
// real OHOL renderer (ground, floors, objects, people) on one canvas, plus DOM
// name labels and speech bubbles positioned every frame.
//
// One requestAnimationFrame loop; it only repaints when something moved (camera,
// a walking figure in view, a fade, freshly loaded sprites, new data), at most
// MAX_FPS times a second, so an idle scene costs next to nothing in OBS. All
// per-player state is pruned to the players currently in view; the map index is
// bounded to a window around the camera.

import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { LifeRecord, MapCellTuple, PlayerView } from "../api-types.ts";
import { appearanceFor, drawGround, drawObject, drawPerson, getOholAssets, loadOholAssets, objectBounds, onOholSpriteLoaded, personBounds } from "../ohol/index.ts";
import type { Appearance } from "../ohol/index.ts";
import { cueLabel, displayName } from "../shared/format.ts";
import { PersonalityTag } from "../shared/PersonalityTag.tsx";
import { cameraStep, fanOut, focusTransition, occluderAlpha, parseHeld, retarget, sampleMotion, type Cam, type Motion, type ScreenBox, type SpeechBubble } from "./logic.ts";
import { crowdMode, labelPriority, placeBoxes, planSpeech, shortName, type PlaceItem } from "./crowd.ts";

/** screen px per world tile (the game uses 128) */
export const CELL = 112;
const SCALE = CELL / 128;
/** focused character sits a little below centre: people extend upward */
export const FOCUS_DROP = 0.55;
/** map window kept indexed around the camera, in tiles (radius) */
const WINDOW = 40;
const FADE_MS = 260;
const GHOST_MS = 2600;
/** repaint cap: the overlay streams at 30 fps, and a full repaint is the costly part of a frame */
const MAX_FPS = 30;

/** a speech bubble, or (with `emote`) a small emote such as homesick */
export type Bubble = SpeechBubble;

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
  /** latest line per speaker, already filtered to the last few seconds (newest first) */
  bubbles: Bubble[];
  /** people who spoke recently (their labels win the collision pass) */
  speakers?: ReadonlySet<number>;
  /** a person's name colour (their hair colour), shared with the chat box */
  colorOf?: (playerId: number) => string | null;
  /** a person's family personality descriptor (PERSONALITIES), shown under each name label (smaller for others than the followed person); absent = feature off */
  personalityOf?: (playerId: number) => string | null;
  /** run.personalities (tag colours) */
  personalities?: string[] | null;
  /** the set of people on screen changed (player ids, sorted) */
  onInView?: (ids: number[]) => void;
  /** shown centred when nobody is alive */
  emptyCard?: React.ReactNode;
  /** shown over the focused character when they die */
  deathCard?: React.ReactNode;
  /** small overlays (biome pill, reconnecting), positioned by the caller's CSS */
  children?: React.ReactNode;
  /** where to look when the focused character is not (or no longer) in view, e.g. their last known tile */
  fallback?: { x: number; y: number } | null;
  /** a cutaway to something that is not a person (a dangerous animal, a tile): the camera centres here instead; key changes per cutaway */
  spot?: { key: string; x: number; y: number } | null;
  onCell?: (cell: { x: number; y: number; biome: number | null } | null) => void;
}

interface Figure {
  id: number;
  lifeId: string | null;
  motherLifeId: string | null;
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
  // many people on screen: compact speech (pips) and short labels; set from the render loop
  const [crowd, setCrowd] = useState(false);
  const crowdRef = useRef(false);
  const inViewKey = useRef("");
  const [inView, setInView] = useState<ReadonlySet<number>>(() => new Set());

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
        const key = `${p.lifeId ?? p.id}|${lineageId}|${lineageKey}|${life?.traits ? "t" : "-"}|${p.displayId}|${(p.flower ?? life?.flower)?.shape ?? ""}${(p.flower ?? life?.flower)?.color ?? ""}`;
        appearance = cache.get(key) ?? null;
        if (!appearance) {
          appearance = appearanceFor({
            displayId: p.displayId,
            female,
            lineageId,
            traits: life?.traits ?? {},
            traitDims: props.traitDims,
            livingLineageIds: props.lineageIds.length ? props.lineageIds : undefined,
            lifeId: p.lifeId ?? null,
            flower: p.flower ?? life?.flower ?? null,
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
        lifeId: p.lifeId ?? null,
        motherLifeId: life?.motherLifeId ?? null,
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
  }, [props.cells, props.bubbles, props.speakers, crowd, inView, props.focusPlayerId, props.focusDead, figures, props.spot?.key, props.spot?.x, props.spot?.y]);

  // ---- focus changes: pan if near, crossfade if far
  const pendingSnap = useRef(false);
  const fadeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevFocus = useRef<number | string | null>(null);
  const spot = props.spot ?? null;
  useEffect(() => {
    const id = props.focusPlayerId;
    const key = spot ? spot.key : id;
    if (key === prevFocus.current) return;
    prevFocus.current = key;
    let to: Cam;
    if (spot) to = { x: spot.x, y: spot.y };
    else {
      if (id == null) return;
      const m = motions.current.get(id);
      if (!m) return;
      to = sampleMotion(m, performance.now());
    }
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.focusPlayerId, spot?.key]);

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
    let lastDraw = -Infinity;
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
      const walking: number[] = [];
      for (const p of P.players) {
        const m = mm.get(p.id);
        if (!m) continue;
        if (now < m.t0 + m.dur) walking.push(p.id);
        const s = sampleMotion(m, now);
        pos.set(p.id, { x: s.x + (fan.get(p.id) ?? 0), y: s.y });
      }
      // carried babies ride with their holder
      for (const f of figs.values()) if (f.carriedBy != null && pos.has(f.carriedBy)) pos.set(f.id, pos.get(f.carriedBy)!);

      let target: Cam | null = null;
      const fid = P.focusPlayerId;
      const g = ghost.current;
      if (P.spot) target = { x: P.spot.x, y: P.spot.y };
      else if (g && P.focusDead) target = { x: g.x, y: g.y };
      else if (fid != null && pos.has(fid)) target = pos.get(fid)!;
      else if (P.fallback && (fid != null || P.focusDead)) target = P.fallback;
      if (target && (!cam.current || pendingSnap.current)) {
        cam.current = { ...target };
        pendingSnap.current = false;
      } else if (target && cam.current) cam.current = cameraStep(cam.current, target, dt);
      const c = cam.current;
      // only walks inside the view (plus a margin) need repaints; off-screen walkers cost nothing
      let moving = false;
      if (c) {
        const hx = W / 2 / CELL + 2;
        const hy = H / 2 / CELL + 3;
        for (const id of walking) {
          const q = pos.get(id)!;
          if (Math.abs(q.x - c.x) <= hx && Math.abs(q.y - c.y) <= hy) {
            moving = true;
            break;
          }
        }
      }
      const ghostAlive = !!g && P.focusDead && now - g.t0 < GHOST_MS + 400;
      const camKey = c ? `${c.x.toFixed(4)},${c.y.toFixed(4)},${W},${H}` : "none";
      if (!dirty.current && !moving && camKey === lastCamKey && !ghostAlive) return;
      // walking and panning repaint at most MAX_FPS (a full-scene repaint is the expensive part)
      if (now - lastDraw < 1000 / MAX_FPS - 2) return;
      lastDraw = now;
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
      const isFocusFig = (f: Figure) => !P.focusDead && fid != null && (f.id === fid || f.carrying.includes(fid));
      const specOf = (f: Figure) => ({ displayId: f.displayId, age: f.age, facingLeft: motionOf(f.id)?.facingLeft ?? false, heldObjectId: f.heldObjectId, appearance: f.appearance });
      // the focused figure (or whoever carries them, or their fading ghost): objects drawn after it
      // that cover it (tree canopies...) are drawn see-through so the character stays visible
      const fi = list.findIndex((d) => d.kind === "person" && (d.ghost || isFocusFig(d.fig)));
      const fd = fi >= 0 ? list[fi] : null;
      const focusBox: ScreenBox | null = fd?.kind === "person" ? personBounds(specOf(fd.fig), fd.sx, fd.sy, SCALE) : null;
      list.forEach((d, i) => {
        if (d.kind === "obj") {
          // cheap pre-check before composing bounds: in front of the focus and within reach of its box
          const near = focusBox != null && i > fi && d.sx > focusBox.x0 - 3 * CELL && d.sx < focusBox.x1 + 3 * CELL && d.sy - 6 * CELL < focusBox.y1;
          const a = near ? occluderAlpha(objectBounds(d.id, d.sx, d.sy, SCALE), focusBox, true) : 1;
          if (a < 1) {
            ctx.save();
            ctx.globalAlpha = a;
            drawObject(ctx, d.id, d.sx, d.sy, SCALE);
            ctx.restore();
          } else drawObject(ctx, d.id, d.sx, d.sy, SCALE);
          return;
        }
        const f = d.fig;
        if (isFocusFig(f) && focusSx != null && focusSy != null) focusRing(ctx, d.sx, d.sy);
        ctx.save();
        if (d.ghost) {
          ctx.globalAlpha = d.alpha;
          ctx.filter = "grayscale(1) sepia(.25)";
        }
        drawPerson(ctx, specOf(f), d.sx, d.sy, SCALE);
        ctx.restore();
      });
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

    /** who is on screen: drives crowd mode and the chat box */
    const reportInView = (scr: Map<number, { x: number; y: number; head: number }>, size: { W: number; H: number } | null) => {
      const ids: number[] = [];
      if (size) for (const [id, a] of scr) if (id >= 0 && onScreen(a, size)) ids.push(id);
      ids.sort((a, b) => a - b);
      const key = ids.join(",");
      if (key === inViewKey.current) return;
      inViewKey.current = key;
      setInView(new Set(ids));
      const c = crowdMode(crowdRef.current, ids.length);
      if (c !== crowdRef.current) {
        crowdRef.current = c;
        setCrowd(c);
      }
      propsRef.current.onInView?.(ids);
    };

    /** position the DOM labels, bubbles and pips (children of overlayRef carry data-pid / data-kind / data-prio) */
    const layout = (scr: Map<number, { x: number; y: number; head: number }>, size: { W: number; H: number } | null) => {
      reportInView(scr, size);
      const ov = overlayRef.current;
      if (!ov) return;
      const els = Array.from(ov.children) as HTMLElement[];
      const items: PlaceItem[] = [];
      const byKey = new Map<string, HTMLElement>();
      const fp = propsRef.current.focusPlayerId;
      const focusA = (fp != null ? scr.get(fp) : undefined) ?? scr.get(-1);
      els.forEach((el, i) => {
        const pid = Number(el.dataset.pid);
        const a = size ? scr.get(pid) : undefined;
        // people outside the view get no label (never pin a far-away name to the edge)
        if (!a || !size || !onScreen(a, size)) {
          el.style.visibility = "hidden";
          return;
        }
        const kind = el.dataset.kind;
        const w = el.offsetWidth;
        const h = el.offsetHeight;
        let x: number;
        let y: number;
        let dir: 1 | -1 = -1;
        if (kind === "bubble") {
          x = a.x - 26;
          y = a.y - a.head - h - 14;
        } else if (kind === "emote" || kind === "pip") {
          x = a.x - w / 2;
          y = a.y - a.head - h - 10;
        } else if (kind === "death") {
          x = a.x - w / 2;
          y = a.y - a.head - h - 22;
        } else {
          const stack = Number(el.dataset.stack ?? 0);
          x = a.x - w / 2;
          y = a.y + 10 + stack * (h + 4);
          dir = 1;
        }
        // same priority: nearer the followed person first
        const near = focusA ? Math.min(0.99, Math.hypot(a.x - focusA.x, a.y - focusA.y) / 1e4) : 0;
        const key = String(i);
        byKey.set(key, el);
        items.push({ key, x, y, w, h, dir, prio: Number(el.dataset.prio ?? 6) + near, steps: kind === "label" ? (el.dataset.opt === "1" ? 2 : 4) : kind === "pip" ? 1 : 4, optional: el.dataset.opt === "1" });
      });
      if (!size) return;
      // the chat box, minimap and HUD pills are in the way: labels go around them (or hide)
      const wrapEl = wrapRef.current;
      wrapEl?.querySelectorAll<HTMLElement>(".cam-chat, .minimap, .camhud").forEach((o, j) => {
        if (o.offsetParent === wrapEl && o.offsetWidth) items.push({ key: `avoid${j}`, x: o.offsetLeft, y: o.offsetTop, w: o.offsetWidth, h: o.offsetHeight, prio: -1, dir: 1, steps: 0 });
      });
      const spots = placeBoxes(items, size.W, size.H);
      for (const [key, r] of spots) {
        const el = byKey.get(key);
        if (!el) continue;
        if (!r) {
          el.style.visibility = "hidden";
          continue;
        }
        el.style.visibility = "visible";
        el.style.transform = `translate3d(${Math.round(r.x)}px, ${Math.round(r.y)}px, 0)`;
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
  const focusId = props.focusDead ? null : props.focusPlayerId;
  const focusLife = focusId != null ? (figures.get(focusId)?.lifeId ?? null) : null;
  const colorOf = props.colorOf;
  const labels: React.ReactNode[] = [];
  for (const f of figures.values()) {
    const isFocus = f.id === focusId;
    const stack = f.carriedBy != null ? 1 : 0;
    const speaking = !!props.speakers?.has(f.id);
    const focusBaby = !!focusLife && f.motherLifeId === focusLife && f.age < 8;
    const color = colorOf?.(f.id) ?? null;
    // personality tags live on the Now following card and the site, not under names on the camera
    const persona: string | null = null;
    // crowded: first names only (the followed person keeps their full name), and a label with no room hides
    const short = crowd && !isFocus;
    labels.push(
      <div
        key={`l${f.id}`}
        data-pid={f.carriedBy ?? f.id}
        data-kind="label"
        data-stack={stack}
        data-prio={labelPriority({ focus: isFocus, speaking, focusBaby })}
        data-opt={isFocus || !crowd ? "0" : "1"}
        className={`cam-label ugc${isFocus ? " is-focus" : " is-minor"}${speaking ? " is-speaking" : ""}${persona ? " has-persona" : ""}`}
        style={color ? ({ "--who": color } as React.CSSProperties) : undefined}
      >
        <span className="nm">{short ? shortName(f.name) : f.name}</span>
        <span className="ag">{isFocus || short ? ` ${Math.floor(f.age)}` : ` · ${Math.floor(f.age)}`}</span>
        {persona && <PersonalityTag personality={persona} palette={props.personalities} short className="cam-persona" />}
      </div>,
    );
  }
  // crowded: the followed person's line and the newest other line in full, a "…" pip for the rest
  const plan = planSpeech(props.bubbles, crowd, focusId, inView);
  for (const b of plan.full) {
    const f = figures.get(b.playerId);
    if (!f) continue;
    const mine = b.playerId === focusId;
    if (b.emote) {
      labels.push(
        <div key={`e${b.key}`} data-pid={f.carriedBy ?? f.id} data-kind="emote" className="cam-emote" data-prio={mine ? 2 : 2.6} title={cueLabel(b.emote)}>
          {(b.emote === "HOMESICK" || b.emote === "HOME") && <HomeIcon tear={b.emote === "HOMESICK"} />}
          <span className="tx">{cueLabel(b.emote)}</span>
        </div>,
      );
      continue;
    }
    const color = colorOf?.(f.id) ?? null;
    const tagged = crowd && !mine;
    labels.push(
      <div
        key={`b${b.key}`}
        data-pid={f.carriedBy ?? f.id}
        data-kind="bubble"
        data-prio={mine ? 2 : 2.5}
        data-opt={tagged ? "1" : "0"}
        className={`cam-bubble speech${tagged ? " is-other" : ""}`}
        style={color ? ({ "--who": color } as React.CSSProperties) : undefined}
      >
        {tagged && <span className="spk ugc">{shortName(f.name)}</span>}
        <span className="tx">{b.text}</span>
      </div>,
    );
  }
  for (const pid of plan.pips) {
    const f = figures.get(pid);
    if (!f) continue;
    const color = colorOf?.(f.id) ?? null;
    labels.push(
      <div key={`p${pid}`} data-pid={f.carriedBy ?? f.id} data-kind="pip" data-prio={3} data-opt="1" className="cam-pip" style={color ? ({ "--who": color } as React.CSSProperties) : undefined} aria-hidden="true">
        <i />
        <i />
        <i />
      </div>,
    );
  }
  if (props.focusDead && props.deathCard)
    labels.push(
      <div key="death" data-pid={-1} data-kind="death" data-prio={0} className="cam-death">
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

/** an anchor inside the view (with a little margin) */
function onScreen(a: { x: number; y: number; head: number }, size: { W: number; H: number }): boolean {
  return a.x >= -40 && a.x <= size.W + 40 && a.y >= 0 && a.y - a.head <= size.H;
}

/** the emote's icon: a little house (with a tear when homesick) */
function HomeIcon({ tear }: { tear: boolean }) {
  return (
    <svg className="ic" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <path d="M3 11.5 12 4l9 7.5M6 9.6V20h12V9.6" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      {tear ? <path d="M12 11.2c-1.7 2.3-2.5 3.6-2.5 4.6a2.5 2.5 0 0 0 5 0c0-1-.8-2.3-2.5-4.6z" fill="var(--berry)" /> : <path d="M10 20v-5h4v5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />}
    </svg>
  );
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
