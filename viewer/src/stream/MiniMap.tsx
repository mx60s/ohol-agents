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
  /** camera target tile (null: no camera) */
  camera: { x: number; y: number } | null;
  /** the camera's px per tile and focus drop (tiles), to draw its visible area */
  cellPx: number;
  focusDrop: number;
}

function MiniMapImpl(p: MiniMapProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [view, setView] = useState<{ w: number; h: number } | null>(null);

  // base layer: once per map change (the map is re-polled every few seconds; the signature skips unchanged polls)
  const sig = mapSignature(p.cells);
  const noCells = p.cells.length === 0;
  const pointsKey = noCells ? p.players.map((q) => `${q.x},${q.y}`).join(";") : "";
  const base = useMemo(() => {
    const bounds0 = worldBounds(p.cells, noCells ? p.players : []);
    if (!bounds0) return null;
    const bounds = padBounds(bounds0);
    const fit = fitBounds(bounds, MINIMAP_W, MINIMAP_H);
    const canvas = document.createElement("canvas");
    canvas.width = MINIMAP_W * RES;
    canvas.height = MINIMAP_H * RES;
    const g = canvas.getContext("2d");
    if (g) drawBiomes(g, p.cells, bounds, fit);
    return { canvas, fit };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, pointsKey]);

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
      g.fillStyle = d.agent || d.focus ? INK : "rgba(31,26,20,.6)";
      g.fill();
      g.lineWidth = 1.2;
      g.strokeStyle = PAPER;
      g.stroke();
    }
  }, [base, dots, camX, camY, view, p.cellPx, p.focusDrop]);

  if (!base) return null;
  return (
    <div className="minimap" aria-hidden="true">
      <canvas ref={ref} width={MINIMAP_W * RES} height={MINIMAP_H * RES} style={{ width: MINIMAP_W, height: MINIMAP_H }} />
    </div>
  );
}

function drawBiomes(g: CanvasRenderingContext2D, cells: MapCellTuple[], bounds: Bounds, fit: Fit) {
  g.setTransform(RES, 0, 0, RES, 0, 0);
  const grid = biomeGrid(cells, bounds, fit);
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
