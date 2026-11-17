// Hand-built SVG chart pieces for the study page (no chart library). Styles: study.css + theme .chart.

import type { ReactNode } from "react";
import { lineageColor } from "../shared/lineage.ts";
import { niceTicks } from "./stats.ts";

export type Scale = ((v: number) => number) & { domain: [number, number]; range: [number, number] };

export function linear(d0: number, d1: number, r0: number, r1: number): Scale {
  const span = d1 - d0 || 1;
  const f = ((v: number) => r0 + ((v - d0) / span) * (r1 - r0)) as Scale;
  f.domain = [d0, d1];
  f.range = [r0, r1];
  return f;
}

/** [min, max] of finite values padded by `pad` (fraction), at least `minSpan` wide; fallback when empty */
export function extent(vals: readonly number[], pad = 0.06, minSpan = 1, fallback: [number, number] = [-1, 1]): [number, number] {
  const v = vals.filter(Number.isFinite);
  if (!v.length) return fallback;
  let lo = Math.min(...v);
  let hi = Math.max(...v);
  if (hi - lo < minSpan) {
    const c = (lo + hi) / 2;
    lo = c - minSpan / 2;
    hi = c + minSpan / 2;
  }
  const p = (hi - lo) * pad;
  return [lo - p, hi + p];
}

export const fmt = (v: number | null | undefined, d = 2) => (v == null || !Number.isFinite(v) ? "–" : v.toFixed(d));
export const fmtSigned = (v: number | null | undefined, d = 2) => (v == null || !Number.isFinite(v) ? "–" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(d)}`);
/** p-value text: "p = 0.042", "p < 0.001" */
export const fmtP = (p: number | null | undefined) => (p == null || !Number.isFinite(p) ? "p –" : p < 0.001 ? "p < 0.001" : `p = ${p < 0.01 ? p.toFixed(3) : p.toFixed(2)}`);

/** Chart frame: responsive SVG with a fixed viewBox */
export function Svg({ w, h, children, label }: { w: number; h: number; children: ReactNode; label: string }) {
  return (
    <svg className="chart study-chart" viewBox={`0 0 ${w} ${h}`} width="100%" role="img" aria-label={label} preserveAspectRatio="xMidYMid meet">
      {children}
    </svg>
  );
}

export interface Margin {
  l: number;
  r: number;
  t: number;
  b: number;
}

/** left + bottom axes with grid, tick labels and titles */
export function Axes({ x, y, m, w, h, xTicks, yTicks, xTitle, yTitle, xFmt = (v) => String(v), yFmt = (v) => String(v), xGrid = false }: {
  x: Scale;
  y: Scale;
  m: Margin;
  w: number;
  h: number;
  xTicks?: number[];
  yTicks?: number[];
  xTitle?: string;
  yTitle?: string;
  xFmt?: (v: number) => string;
  yFmt?: (v: number) => string;
  xGrid?: boolean;
}) {
  const xt = xTicks ?? niceTicks(x.domain[0], x.domain[1], 6).filter((v) => v >= x.domain[0] && v <= x.domain[1]);
  const yt = yTicks ?? niceTicks(y.domain[0], y.domain[1], 5).filter((v) => v >= Math.min(...y.domain) && v <= Math.max(...y.domain));
  return (
    <g>
      <g className="grid">
        {yt.map((v) => (
          <line key={`y${v}`} x1={m.l} x2={w - m.r} y1={y(v)} y2={y(v)} />
        ))}
        {xGrid && xt.map((v) => <line key={`x${v}`} x1={x(v)} x2={x(v)} y1={m.t} y2={h - m.b} />)}
      </g>
      <g className="axis">
        <line x1={m.l} x2={w - m.r} y1={h - m.b} y2={h - m.b} />
        <line x1={m.l} x2={m.l} y1={m.t} y2={h - m.b} />
      </g>
      {xt.map((v) => (
        <text key={`xl${v}`} x={x(v)} y={h - m.b + 15} textAnchor="middle">
          {xFmt(v)}
        </text>
      ))}
      {yt.map((v) => (
        <text key={`yl${v}`} x={m.l - 6} y={y(v) + 4} textAnchor="end">
          {yFmt(v)}
        </text>
      ))}
      {xTitle && (
        <text className="axis-title" x={(m.l + w - m.r) / 2} y={h - 6} textAnchor="middle">
          {xTitle}
        </text>
      )}
      {yTitle && (
        <text className="axis-title" transform={`translate(13 ${(m.t + h - m.b) / 2}) rotate(-90)`} textAnchor="middle">
          {yTitle}
        </text>
      )}
    </g>
  );
}

/** "not enough data yet" in place of a chart, same footprint */
export function NotEnough({ w, h, why }: { w: number; h: number; why?: string }) {
  return (
    <Svg w={w} h={h} label="not enough data yet">
      <rect x={1} y={1} width={w - 2} height={h - 2} rx={10} className="empty-well" />
      <text x={w / 2} y={h / 2 - 2} textAnchor="middle" className="empty-title">
        Not enough data yet
      </text>
      {why && (
        <text x={w / 2} y={h / 2 + 18} textAnchor="middle" className="empty-why">
          {why}
        </text>
      )}
    </Svg>
  );
}

/** deterministic jitter in [-1, 1] from a string */
export function jitter(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) / 4294967295) * 2 - 1;
}

/**
 * Point colour. Family colour only when a chart shows at most 6 families (then each is distinct);
 * otherwise neutral ink, since recycled colours would suggest families that aren't the same.
 */
export function pointColorer(lineageIds: readonly string[]): (lineageId: string) => string {
  const ids = [...new Set(lineageIds)].sort();
  if (ids.length > 6 || ids.length < 2) return () => "var(--ink-2)";
  return (id) => lineageColor(id, ids).color;
}

/** bar path from `base` up to `top` with rounded (<= 4px) data end; flat when too short */
export function barPath(x: number, w: number, top: number, base: number): string {
  const h = base - top;
  if (h <= 0.5) return `M${x} ${base - 0.75} H${x + w} V${base} H${x} Z`;
  const r = Math.min(4, h / 2, w / 2);
  return `M${x} ${base} V${top + r} Q${x} ${top} ${x + r} ${top} H${x + w - r} Q${x + w} ${top} ${x + w} ${top + r} V${base} Z`;
}

/** diverging fill for a correlation: berry (-) -> parchment (0) -> clay (+), saturating at |max| */
export function divergingFill(r: number | null, max = 0.6): string {
  if (r == null || !Number.isFinite(r)) return "var(--parchment-lo)";
  const a = Math.min(1, Math.abs(r) / max);
  const mid = [236, 228, 208];
  const end = r < 0 ? [59, 74, 144] : [178, 74, 44];
  return `rgb(${mid.map((v, i) => Math.round(v + (end[i] - v) * a)).join(",")})`;
}
