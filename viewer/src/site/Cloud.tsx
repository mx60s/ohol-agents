// Personality cloud: every life as a point in trait space (or on the first 2 principal components).
// Colour = family (the ONLY place family colour is used on the site; no legend, no shape coding).
// Filled = alive, hollow = dead or lost. Hover for a card, click to open the life.

import { useMemo, useState } from "react";
import type { LifeRecord } from "../api-types.ts";
import { pageHref } from "../data/index.ts";
import { displayName, formatTrait, lineageColor } from "../shared/index.ts";
import { clampTrait, loadingHint, pca2, pcaProject, traitLabel, traitRow, traitShort, TRAIT_LIMIT } from "./logic.ts";
import { LifePortrait, Seg } from "./ui.tsx";
import type { SiteData } from "./useSite.ts";

const PCA = "__pca__";

interface Pt {
  life: LifeRecord;
  x: number;
  y: number;
  alive: boolean;
  color: string;
}

export function PersonalityCloud({ site, highlight }: { site: SiteData; highlight?: string | null }) {
  const dims = site.dims;
  const [xd, setXd] = useState<string | null>(null);
  const [yd, setYd] = useState<string | null>(null);
  const [hover, setHover] = useState<Pt | null>(null);
  const x = xd && (xd === PCA || dims.includes(xd)) ? xd : (dims[2] ?? dims[0] ?? PCA);
  const y = yd && dims.includes(yd) && yd !== x ? yd : (dims.find((d, i) => i >= 3 && d !== x) ?? dims.find((d) => d !== x) ?? dims[0]);
  const isPca = x === PCA;

  const model = useMemo(() => {
    if (!isPca) return null;
    const rows = site.lives.map((l) => traitRow(l.traits, dims)).filter((r): r is number[] => !!r);
    return pca2(rows);
  }, [isPca, site.lives, dims]);

  const pts = useMemo(() => {
    const out: Pt[] = [];
    for (const l of site.lives) {
      let px: number | null;
      let py: number | null;
      if (isPca) {
        const row = model && traitRow(l.traits, dims);
        if (!row || !model) continue;
        [px, py] = pcaProject(model, row);
      } else {
        px = clampTrait(l.traits?.[x]);
        py = clampTrait(y ? l.traits?.[y] : null);
      }
      if (px == null || py == null) continue;
      out.push({ life: l, x: px, y: py, alive: l.status === "alive", color: lineageColor(l.lineageId, site.order).color });
    }
    // dead behind, living on top, the highlighted life last
    return out.sort((a, b) => Number(a.alive) - Number(b.alive) || Number(a.life.lifeId === highlight) - Number(b.life.lifeId === highlight));
  }, [site.lives, site.order, isPca, model, dims, x, y, highlight]);

  const W = 560;
  const H = 360;
  const m = { l: 46, r: 14, t: 12, b: 42 };
  let lim = TRAIT_LIMIT;
  if (isPca) lim = Math.max(1, Math.ceil(Math.max(...pts.map((p) => Math.max(Math.abs(p.x), Math.abs(p.y))), 1) * 2) / 2);
  const sx = (v: number) => m.l + ((v + lim) / (2 * lim)) * (W - m.l - m.r);
  const sy = (v: number) => H - m.b - ((v + lim) / (2 * lim)) * (H - m.t - m.b);
  const ticks = lim <= 3 ? [-lim, -lim / 2, 0, lim / 2, lim] : [-lim, 0, lim];
  const xLab = isPca && model ? `PC1 · ${Math.round(model.explained[0] * 100)}% · ${loadingHint(model.components[0], dims)}` : traitLabel(x);
  const yLab = isPca && model ? `PC2 · ${Math.round(model.explained[1] * 100)}% · ${loadingHint(model.components[1], dims)}` : traitLabel(y ?? "");

  // the points are memoised: with thousands of lives, re-creating them on every hover or 2 s state
  // poll made React reconcile every <a><circle> each time
  const dots = useMemo(
    () =>
      pts.map((p) => {
        const me = p.life.lifeId === highlight;
        const r = me ? 8 : 6;
        return (
          <a key={p.life.lifeId} href={pageHref("agent", { life: p.life.lifeId })} aria-label={displayName(p.life.name)} onMouseEnter={() => setHover(p)} onFocus={() => setHover(p)}>
            <circle
              cx={sx(p.x)}
              cy={sy(p.y)}
              r={r}
              fill={p.alive ? p.color : "var(--parchment-hi)"}
              stroke={p.alive ? "var(--ink)" : p.color}
              strokeWidth={p.alive ? 1.5 : 2.2}
              className={me ? "pt me" : "pt"}
            />
            {me && <circle cx={sx(p.x)} cy={sy(p.y)} r={r + 5} fill="none" stroke="var(--ink)" strokeWidth={1.5} strokeDasharray="3 2" />}
          </a>
        );
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pts, highlight, lim],
  );

  if (!dims.length) return <p className="site-note">No trait data yet.</p>;

  const xOpts = [...dims.map((d) => ({ key: d, label: traitShort(d), title: traitLabel(d) })), { key: PCA, label: "PCA", title: "Project every trait onto the 2 main axes of variation" }];
  const yOpts = dims.filter((d) => d !== x).map((d) => ({ key: d, label: traitShort(d), title: traitLabel(d) }));

  return (
    <div className="cloud">
      <div className="cloud-ctl">
        <span className="axis-k">x</span>
        <Seg label="x axis" options={xOpts} value={x} onChange={(k) => setXd(k)} />
      </div>
      {!isPca && y && (
        <div className="cloud-ctl">
          <span className="axis-k">y</span>
          <Seg label="y axis" options={yOpts} value={y} onChange={(k) => setYd(k)} />
        </div>
      )}
      <div className="cloud-plot" onMouseLeave={() => setHover(null)}>
        <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Personality cloud: ${xLab} by ${yLab}`}>
          {ticks.map((t) => (
            <g key={`x${t}`}>
              <line className="grid" x1={sx(t)} x2={sx(t)} y1={m.t} y2={H - m.b} strokeDasharray={t === 0 ? undefined : "3 4"} />
              <text x={sx(t)} y={H - m.b + 15} textAnchor="middle" className="mono-t">
                {t > 0 ? `+${t}` : t}
              </text>
            </g>
          ))}
          {ticks.map((t) => (
            <g key={`y${t}`}>
              <line className="grid" x1={m.l} x2={W - m.r} y1={sy(t)} y2={sy(t)} strokeDasharray={t === 0 ? undefined : "3 4"} />
              <text x={m.l - 6} y={sy(t) + 4} textAnchor="end" className="mono-t">
                {t > 0 ? `+${t}` : t}
              </text>
            </g>
          ))}
          <g className="axis">
            <line x1={m.l} x2={W - m.r} y1={H - m.b} y2={H - m.b} />
            <line x1={m.l} x2={m.l} y1={m.t} y2={H - m.b} />
          </g>
          <text className="axis-title" x={(m.l + W - m.r) / 2} y={H - 6} textAnchor="middle">
            {xLab} →
          </text>
          <text className="axis-title" transform={`translate(13 ${(m.t + H - m.b) / 2}) rotate(-90)`} textAnchor="middle">
            {yLab} →
          </text>
          {dots}
        </svg>
        {hover && (
          <div className="cloud-card" style={{ left: `${(sx(hover.x) / W) * 100}%`, top: `${(sy(hover.y) / H) * 100}%` }} aria-hidden>
            <LifePortrait life={hover.life} site={site} size={44} eager />
            <div>
              <div className="nm ugc">{displayName(hover.life.name)}</div>
              <div className="meta">
                {site.famName(hover.life.lineageId)} · gen {hover.life.generation} · {hover.alive ? "alive" : hover.life.status === "lost" ? "lost" : "dead"}
              </div>
              <div className="mono vals">
                {isPca ? `PC1 ${formatTrait(hover.x)} · PC2 ${formatTrait(hover.y)}` : `${traitShort(x)} ${formatTrait(hover.x)} · ${traitShort(y ?? "")} ${formatTrait(hover.y)}`}
              </div>
            </div>
          </div>
        )}
      </div>
      <div className="cloud-foot">
        <span>filled = alive · hollow = dead</span>
        <span className="mono">n = {pts.length}</span>
      </div>
    </div>
  );
}
