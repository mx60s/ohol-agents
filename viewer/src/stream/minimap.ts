// Pure layout and projection for the stream camera's minimap inset (no React,
// no DOM). Tested in tests/stream.test.mjs.
//
// World coordinates: one tile per unit, y up; a tile (x, y) covers
// [x-0.5, x+0.5] x [y-0.5, y+0.5]. Minimap coordinates: px from the inset's
// top-left, y down.

import type { MapCellTuple } from "../api-types.ts";

export interface Bounds {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface Fit {
  /** px per tile */
  scale: number;
  /** world point drawn at the inset's top-left */
  wx0: number;
  wy1: number;
}

export interface BiomeGrid {
  /** grid size in buckets */
  gw: number;
  gh: number;
  /** bucket size in tiles (>= 1) */
  block: number;
  /** world coords of the grid's top-left corner (x min, y max) */
  x0: number;
  y1: number;
  /** most common biome per bucket, row-major from the top; -1 = nothing seen */
  biomes: Int8Array;
}

/** at most this many map cells are read (larger maps are sampled with a stride) */
export const MAX_CELLS_READ = 200_000;
/** the frame never zooms in closer than this many tiles across */
export const MIN_SPAN = 24;
const BIOMES = 8; // 0..6 known, 7 = anything else

/** World bounds of the known map, as tile edges; falls back to `points` when there are no cells. null = nothing to show. */
export function worldBounds(cells: readonly MapCellTuple[], points: readonly { x: number; y: number }[] = []): Bounds | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const step = strideFor(cells.length);
  for (let i = 0; i < cells.length; i += step) {
    const c = cells[i];
    const x = c[0];
    const y = c[1];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  if (x0 === Infinity)
    for (const p of points) {
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
      x0 = Math.min(x0, p.x);
      x1 = Math.max(x1, p.x);
      y0 = Math.min(y0, p.y);
      y1 = Math.max(y1, p.y);
    }
  if (x0 === Infinity) return null;
  return { x0: x0 - 0.5, y0: y0 - 0.5, x1: x1 + 0.5, y1: y1 + 0.5 };
}

/** Expand bounds by a margin (tiles: max(minTiles, frac * span)) and to at least MIN_SPAN across. */
export function padBounds(b: Bounds, frac = 0.06, minTiles = 2, minSpan = MIN_SPAN): Bounds {
  const grow = (lo: number, hi: number): [number, number] => {
    const m = Math.max(minTiles, (hi - lo) * frac);
    lo -= m;
    hi += m;
    if (hi - lo < minSpan) {
      const c = (lo + hi) / 2;
      lo = c - minSpan / 2;
      hi = c + minSpan / 2;
    }
    return [lo, hi];
  };
  const [x0, x1] = grow(b.x0, b.x1);
  const [y0, y1] = grow(b.y0, b.y1);
  return { x0, y0, x1, y1 };
}

/** Fit bounds into a W x H px box, uniform scale, centred. */
export function fitBounds(b: Bounds, W: number, H: number): Fit {
  const sw = Math.max(1e-6, b.x1 - b.x0);
  const sh = Math.max(1e-6, b.y1 - b.y0);
  const scale = Math.max(1e-6, Math.min(W / sw, H / sh));
  const cx = (b.x0 + b.x1) / 2;
  const cy = (b.y0 + b.y1) / 2;
  return { scale, wx0: cx - W / 2 / scale, wy1: cy + H / 2 / scale };
}

/** World point -> inset px. */
export function project(f: Fit, x: number, y: number): { px: number; py: number } {
  return { px: (x - f.wx0) * f.scale, py: (f.wy1 - y) * f.scale };
}

/** Clamp an inset point into the box, `inset` px from the edges (dots outside the known map stay visible at the edge). */
export function clampToBox(p: { px: number; py: number }, W: number, H: number, inset = 3): { px: number; py: number; clamped: boolean } {
  const px = Math.min(W - inset, Math.max(inset, p.px));
  const py = Math.min(H - inset, Math.max(inset, p.py));
  return { px, py, clamped: px !== p.px || py !== p.py };
}

/**
 * Biomes bucketed onto a coarse grid: a bucket is `block` tiles square, with
 * block chosen so a bucket is at least one px at the fit's scale. The grid is
 * therefore never bigger than the box (bounded work for any map), and each
 * bucket shows its most common biome.
 */
export function biomeGrid(cells: readonly MapCellTuple[], b: Bounds, fit: Fit): BiomeGrid {
  const block = Math.max(1, Math.ceil(1 / fit.scale));
  const x0 = Math.floor(b.x0);
  const y1 = Math.ceil(b.y1);
  const gw = Math.max(1, Math.ceil((Math.ceil(b.x1) - x0) / block));
  const gh = Math.max(1, Math.ceil((y1 - Math.floor(b.y0)) / block));
  const counts = new Uint16Array(gw * gh * BIOMES);
  const step = strideFor(cells.length);
  for (let i = 0; i < cells.length; i += step) {
    const c = cells[i];
    const biome = c[2];
    if (!(biome >= 0)) continue; // unknown / unseen
    const gx = Math.floor((c[0] + 0.5 - x0) / block);
    const gy = Math.floor((y1 - (c[1] + 0.5)) / block);
    if (gx < 0 || gy < 0 || gx >= gw || gy >= gh) continue;
    const k = (gy * gw + gx) * BIOMES + (biome < BIOMES - 1 ? biome : BIOMES - 1);
    if (counts[k] < 65535) counts[k]++;
  }
  const biomes = new Int8Array(gw * gh).fill(-1);
  for (let g = 0; g < gw * gh; g++) {
    let best = -1;
    let bn = 0;
    for (let k = 0; k < BIOMES; k++) {
      const n = counts[g * BIOMES + k];
      if (n > bn) {
        bn = n;
        best = k;
      }
    }
    biomes[g] = best;
  }
  return { gw, gh, block, x0, y1, biomes };
}

/** A cheap content signature, so a re-polled but unchanged map doesn't re-render the base layer. */
export function mapSignature(cells: readonly MapCellTuple[]): string {
  const n = cells.length;
  if (!n) return "0";
  let h = 2166136261;
  const step = Math.max(1, Math.floor(n / 512));
  for (let i = 0; i < n; i += step) {
    const c = cells[i];
    h = Math.imul(h ^ (c[0] & 0xffff), 16777619);
    h = Math.imul(h ^ (c[1] & 0xffff), 16777619);
    h = Math.imul(h ^ (c[2] & 0xff), 16777619);
  }
  const last = cells[n - 1];
  return `${n}:${h >>> 0}:${last[0]},${last[1]},${last[2]}`;
}

/** The camera's visible area in world tiles, centred on the camera target (the focus sits `drop` tiles below centre). */
export function cameraRect(cx: number, cy: number, viewW: number, viewH: number, cellPx: number, drop = 0): Bounds {
  const hw = viewW / 2 / cellPx;
  const hh = viewH / 2 / cellPx;
  const my = cy + drop;
  return { x0: cx - hw, x1: cx + hw, y0: my - hh, y1: my + hh };
}

export interface Dot {
  key: string;
  x: number;
  y: number;
  /** the camera's focused character */
  focus: boolean;
  /** one of our agents (vs a stranger) */
  agent: boolean;
}

/**
 * Dots for living characters: every player in view of the agents, plus agents
 * whose character isn't among the players (by player id), deduplicated.
 */
export function minimapDots(
  players: readonly { id: number; x: number; y: number; agentId: string | null }[],
  agents: readonly { agentId: string; playerId: number | null; status: string; x: number | null; y: number | null }[],
  focusPlayerId: number | null,
): Dot[] {
  const out: Dot[] = [];
  const seen = new Set<number>();
  for (const p of players) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || seen.has(p.id)) continue;
    seen.add(p.id);
    out.push({ key: `p${p.id}`, x: p.x, y: p.y, focus: p.id === focusPlayerId, agent: p.agentId != null });
  }
  for (const a of agents) {
    if (a.status !== "alive" || a.x == null || a.y == null || !Number.isFinite(a.x) || !Number.isFinite(a.y)) continue;
    if (a.playerId != null && seen.has(a.playerId)) continue;
    if (a.playerId != null) seen.add(a.playerId);
    out.push({ key: `a${a.agentId}`, x: a.x, y: a.y, focus: a.playerId != null && a.playerId === focusPlayerId, agent: true });
  }
  // the focus last, so it draws on top
  return out.sort((p, q) => Number(p.focus) - Number(q.focus));
}

function strideFor(n: number): number {
  return n > MAX_CELLS_READ ? Math.ceil(n / MAX_CELLS_READ) : 1;
}
