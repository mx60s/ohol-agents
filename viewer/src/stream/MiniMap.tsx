// Minimap inset in the camera's bottom-right corner: the known world in biome
// colours, a dot per living character, a butter box on the followed one and a
// faint rectangle for the camera's view. The biome layer is rendered once per
// map change into an offscreen canvas; dots are composited on top only when
// positions, the focus or the camera tile change. No per-frame work.

import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { AgentView, MapCellTuple, PlayerView } from "../api-types.ts";
import { BIOME_FILL, UNKNOWN_FILL } from "../site/logic.ts";
import { biomeGrid, cameraRect, clampToBox, fitBounds, mapSignature, minimapDots, padBounds, project, worldBounds, type Bounds, type Fit } from "./minimap.ts";

/** inset size in stage px (the stage is 1920x1080, scaled to fit) */
export const MINIMAP_W = 220;
export const MINIMAP_H = 160;
/** canvas px per stage px: crisp at 1080p, still fine when OBS downscales to 720p */
const RES = 2;
const INK = "#1f1a14";
const BUTTER = "#f4d77e";
const PAPER = "#fffdf7";

export interface MiniMapProps {
  cells: MapCellTuple[];
  players: PlayerView[];
  agents: AgentView[];
  focusPlayerId: number | null;
  /** the whole explored world, coarse (/api/minimap); null: draw from `cells` */
  overview?: { block: number; cells: MapCellTuple[] } | null;
  /** player id -> the colour drawn on the camera for that person's hair; dots use it (else ink) */
  hairOf?: (playerId: number) => string | null;
  /** the current world (run id): the inset's bounds only grow within one world */
  worldKey?: string | null;
  /** camera target tile (null: no camera) */
  camera: { x: number; y: number } | null;
  /** the camera's px per tile and focus drop (tiles), to draw its visible area */
  cellPx: number;
  focusDrop: number;
}

function MiniMapImpl(p: MiniMapProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [view, setView] = useState<{ w: number; h: number } | null>(null);

  // The whole explored world (overview) when the service has it, else the nearby map. The bounds
  // only grow within one world: the inset never zooms in or jumps when someone travels or dies;
  // it zooms out a little when someone reaches new land, and starts over in a regenerated world.
  // everything this page has seen in this world stays drawn: overview polls are added up, never replaced
  const seenCells = useRef<{ key: string | null; m: Map<string, MapCellTuple> }>({ key: null, m: new Map() });
  if (seenCells.current.key !== (p.worldKey ?? null)) seenCells.current = { key: p.worldKey ?? null, m: new Map() };
  const fresh = p.overview && p.overview.cells.length ? p.overview.cells : p.cells;
  let added = false;
  for (const c of fresh) {
    if (!(c[2] >= 0)) continue;
    const k = `${c[0]},${c[1]}`;
    if (!seenCells.current.m.has(k)) {
      seenCells.current.m.set(k, c);
      added = true;
    }
  }
  const sourceRef = useRef<MapCellTuple[]>([]);
  if (added || sourceRef.current.length !== seenCells.current.m.size) sourceRef.current = [...seenCells.current.m.values()];
  const source = sourceRef.current;
  const minBlock = p.overview && p.overview.cells.length ? p.overview.block : 1;
  const sig = mapSignature(source);
  const grown = useRef<{ key: string | null; b: Bounds | null }>({ key: null, b: null });
  if (grown.current.key !== (p.worldKey ?? null)) grown.current = { key: p.worldKey ?? null, b: null };
  // everyone on the map stays inside, even past the explored cells
  let seen = worldBounds(source, p.players);
  for (const q of p.players) {
    if (!seen || !Number.isFinite(q.x) || !Number.isFinite(q.y)) continue;
    seen = { x0: Math.min(seen.x0, q.x - 0.5), y0: Math.min(seen.y0, q.y - 0.5), x1: Math.max(seen.x1, q.x + 0.5), y1: Math.max(seen.y1, q.y + 0.5) };
  }
  const prev = grown.current.b;
  const b = !seen ? prev : !prev ? seen : { x0: Math.min(prev.x0, seen.x0), y0: Math.min(prev.y0, seen.y0), x1: Math.max(prev.x1, seen.x1), y1: Math.max(prev.y1, seen.y1) };
  grown.current.b = b;
  const boundsKey = b ? `${b.x0},${b.y0},${b.x1},${b.y1}` : "";
  const base = useMemo(() => {
    if (!b) return null;
    const bounds = padBounds(b);
    const fit = fitBounds(bounds, MINIMAP_W, MINIMAP_H);
    const canvas = document.createElement("canvas");
    canvas.width = MINIMAP_W * RES;
    canvas.height = MINIMAP_H * RES;
    const g = canvas.getContext("2d");
    if (g) drawBiomes(g, source, bounds, fit, minBlock);
    return { canvas, fit };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, boundsKey, minBlock]);

  const hasBase = base != null;
  // the camera panel's size (our parent), for the visible-area rectangle
  useEffect(() => {
    const parent = ref.current?.parentElement?.parentElement;
    if (!parent) return;
    const on = () => setView((v) => (v && v.w === parent.clientWidth && v.h === parent.clientHeight ? v : { w: parent.clientWidth, h: parent.clientHeight }));
    on();
    const ro = new ResizeObserver(on);
    ro.observe(parent);
    return () => ro.disconnect();
  }, [hasBase]);

  const dots = useMemo(() => minimapDots(p.players, p.agents, p.focusPlayerId), [p.players, p.agents, p.focusPlayerId]);
  const camX = p.camera?.x ?? null;
  const camY = p.camera?.y ?? null;

  useEffect(() => {
    const c = ref.current;
    const g = c?.getContext("2d");
    if (!c || !g) return;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, c.width, c.height);
    if (!base) return;
    g.drawImage(base.canvas, 0, 0);
    g.setTransform(RES, 0, 0, RES, 0, 0);
    const f = base.fit;
    // the camera's visible area
    if (camX != null && camY != null && view) {
      const r = cameraRect(camX, camY, view.w, view.h, p.cellPx, p.focusDrop);
      const a = project(f, r.x0, r.y1);
      const b = project(f, r.x1, r.y0);
      const w = Math.max(4, b.px - a.px);
      const h = Math.max(3, b.py - a.py);
      const cx = (a.px + b.px) / 2;
      const cy = (a.py + b.py) / 2;
      g.fillStyle = "rgba(255,253,247,.16)";
      g.strokeStyle = "rgba(255,253,247,.75)";
      g.lineWidth = 1;
      g.fillRect(cx - w / 2, cy - h / 2, w, h);
      g.strokeRect(Math.round(cx - w / 2) + 0.5, Math.round(cy - h / 2) + 0.5, Math.round(w), Math.round(h));
    }
    // characters
    for (const d of dots) {
      const q = clampToBox(project(f, d.x, d.y), MINIMAP_W, MINIMAP_H, d.focus ? 8 : 4);
      if (d.focus) {
        // butter box, like the camera's focus ring
        g.lineWidth = 4;
        g.strokeStyle = INK;
        g.strokeRect(q.px - 7, q.py - 7, 14, 14);
        g.lineWidth = 2.2;
        g.strokeStyle = BUTTER;
        g.strokeRect(q.px - 7, q.py - 7, 14, 14);
      }
      g.beginPath();
      g.arc(q.px, q.py, 3.2, 0, Math.PI * 2);
      const pid = d.key.startsWith("p") ? Number(d.key.slice(1)) : null;
      g.fillStyle = (pid != null && p.hairOf?.(pid)) || (d.agent || d.focus ? INK : "rgba(31,26,20,.6)");
      g.fill();
      g.lineWidth = 1.2;
      g.strokeStyle = PAPER;
      g.stroke();
    }
  }, [base, dots, camX, camY, view, p.cellPx, p.focusDrop, p.hairOf]);

  if (!base) return null;
  return (
    <div className="minimap" aria-hidden="true">
      <canvas ref={ref} width={MINIMAP_W * RES} height={MINIMAP_H * RES} style={{ width: MINIMAP_W, height: MINIMAP_H }} />
    </div>
  );
}

function drawBiomes(g: CanvasRenderingContext2D, cells: readonly MapCellTuple[], bounds: Bounds, fit: Fit, minBlock = 1) {
  g.setTransform(RES, 0, 0, RES, 0, 0);
  const grid = biomeGrid(cells, bounds, fit, minBlock);
  const size = grid.block * fit.scale;
  for (let gy = 0; gy < grid.gh; gy++)
    for (let gx = 0; gx < grid.gw; gx++) {
      const b = grid.biomes[gy * grid.gw + gx];
      if (b < 0) continue;
      const a = project(fit, grid.x0 + gx * grid.block, grid.y1 - gy * grid.block);
      // snap to device px with a hair of overlap: no seams between buckets
      const x0 = Math.floor(a.px * RES) / RES;
      const y0 = Math.floor(a.py * RES) / RES;
      g.fillStyle = BIOME_FILL[b] ?? UNKNOWN_FILL;
      g.fillRect(x0, y0, Math.ceil((a.px + size - x0) * RES + 0.5) / RES, Math.ceil((a.py + size - y0) * RES + 0.5) / RES);
    }
}

export const MiniMap = memo(MiniMapImpl);
