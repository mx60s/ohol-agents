// Q4: do traits persist, drift or converge across generations?
import { truncate } from "../shared/format.ts";
import { lineageColor } from "../shared/lineage.ts";
import type { GenGroup, LineageTrack, Q4Heredity } from "./analysis.ts";
import { Axes, extent, fmt, fmtSigned, jitter, linear, NotEnough, pointColorer, Svg } from "./charts.tsx";
import { Figure } from "./Figure.tsx";
import { olsBand } from "./stats.ts";

export function GenerationStrips({ byDim, dims }: { byDim: Record<string, GenGroup[]>; dims: string[] }) {
  const all = dims.flatMap((d) => byDim[d] ?? []);
  const gens = [...new Set(all.map((g) => g.gen))].sort((a, b) => a - b);
  const counts = new Map<number, number>();
  for (const g of byDim[dims[0]] ?? []) counts.set(g.gen, g.values.length);
  const yDom = extent(all.flatMap((g) => g.values.map((v) => v.v)), 0.05, 1, [-2.5, 2.5]);
  const cols = gens.length > 10 ? Math.min(dims.length, 2) : gens.length > 7 ? Math.min(dims.length, 3) : gens.length > 5 ? Math.min(dims.length, 3) : Math.min(dims.length, 5);
  const W = cols <= 2 ? 620 : cols === 3 ? 410 : 250;
  const H = 230;
  const nLine = gens.length && gens.length <= 6 ? gens.map((g) => `gen ${g}: n = ${counts.get(g) ?? 0}`).join(" · ") : `${all.length ? (byDim[dims[0]] ?? []).reduce((s, g) => s + g.values.length, 0) : 0} lives · ${gens.length} generations · n under each`;
  return (
    <Figure variant="orange" className="span-12" head="Trait distribution per generation" title="Each dot is a life · bar = median" n={nLine}>
      {!all.length ? (
        <NotEnough w={1280} h={200} why="no lives with traits yet" />
      ) : (
        <div className="small-mult" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
          {dims.map((d, k) => {
            const groups = byDim[d] ?? [];
            const m = { l: 40, r: 6, t: 8, b: 36 };
            const x = linear(gens[0] - 0.5, gens[gens.length - 1] + 0.5, m.l, W - m.r);
            const y = linear(yDom[0], yDom[1], H - m.b, m.t);
            const colW = (W - m.l - m.r) / gens.length;
            const r = colW < 18 ? 1.8 : 2.8;
            const showN = colW >= 20;
            return (
              <div key={d}>
                <div className="t">{d}</div>
                <Svg w={W} h={H} label={`${d} per generation`}>
                  <Axes x={x} y={y} m={m} w={W} h={H} xTicks={[]} yFmt={(v) => fmt(v, 0)} yTitle={k % cols === 0 ? "value" : undefined} />
                  {groups.map((g) => (
                    <g key={g.gen}>
                      {g.values.map((v) => (
                        <circle key={v.lifeId} cx={x(g.gen) + jitter(v.lifeId) * colW * 0.3} cy={y(v.v)} r={r} className="dot" />
                      ))}
                      {g.median != null && (
                        <line x1={x(g.gen) - colW * 0.36} x2={x(g.gen) + colW * 0.36} y1={y(g.median)} y2={y(g.median)} className="median">
                          <title>{`gen ${g.gen}: median ${fmtSigned(g.median)}, n = ${g.values.length}`}</title>
                        </line>
                      )}
                    </g>
                  ))}
                  {gens.map((g, i) =>
                    gens.length <= 12 || i % Math.ceil(gens.length / 12) === 0 ? (
                      <text key={g} x={x(g)} y={H - m.b + 14} textAnchor="middle" className="cat-label small">
                        {gens.length <= 6 ? `gen ${g}` : g}
                      </text>
                    ) : null,
                  )}
                  {showN &&
                    groups.map((g) => (
                      <text key={`n${g.gen}`} x={x(g.gen)} y={H - m.b + 27} textAnchor="middle" className="mono-label small">
                        n={g.values.length}
                      </text>
                    ))}
                </Svg>
              </div>
            );
          })}
        </div>
      )}
    </Figure>
  );
}

export function Trajectories({ tracks, dim, nameOf }: { tracks: LineageTrack[]; dim: string; nameOf: (lineageId: string) => string }) {
  const W = 640;
  const H = 330;
  const m = { l: 50, r: 110, t: 14, b: 44 };
  const multi = tracks.filter((t) => t.points.length >= 2);
  const shown = multi.slice(0, 6);
  const ids = shown.map((t) => t.lineageId).sort();
  return (
    <Figure
      variant="orange"
      className="span-6"
      head="Lineage mean trajectories"
      title={`${dim}: family mean by generation`}
      n={`${shown.length} largest of ${tracks.length} families · mean ± 1 SE where n ≥ 3 (relatives counted as independent, so too narrow)`}
    >
      {!shown.length ? (
        <NotEnough w={W} h={H} why="no family spans 2 generations yet" />
      ) : (
        (() => {
          const gens = shown.flatMap((t) => t.points.map((p) => p.gen));
          const x = linear(Math.min(...gens) - 0.3, Math.max(...gens) + 0.3, m.l, W - m.r);
          const y = linear(...extent(shown.flatMap((t) => t.points.flatMap((p) => [p.mean - (p.se ?? 0), p.mean + (p.se ?? 0)]))), H - m.b, m.t);
          const xt = [...new Set(gens)].sort((a, b) => a - b).filter((_g, i, a) => a.length <= 12 || i % Math.ceil(a.length / 12) === 0);
          // direct labels at each line's end, nudged apart
          const labels = shown
            .map((t, i) => {
              const last = t.points[t.points.length - 1];
              return { i, y: y(last.mean), x: x(last.gen), t };
            })
            .sort((a, b) => a.y - b.y);
          for (let k = 1; k < labels.length; k++) if (labels[k].y - labels[k - 1].y < 14) labels[k].y = labels[k - 1].y + 14;
          const floor = H - m.b - 2;
          for (let k = labels.length - 1; k >= 0; k--) {
            const lim = k === labels.length - 1 ? floor : labels[k + 1].y - 14;
            if (labels[k].y > lim) labels[k].y = lim;
          }
          return (
            <Svg w={W} h={H} label={`${dim} family means by generation`}>
              <Axes x={x} y={y} m={m} w={W} h={H} xTicks={xt} xTitle="Generation" yTitle={`${dim} (mean)`} yFmt={(v) => fmt(v, 1)} />
              {shown.map((t, i) => {
                const c = lineageColor(t.lineageId, ids).color;
                const off = (i - (shown.length - 1) / 2) * 3;
                return (
                  <g key={t.lineageId}>
                    <polyline points={t.points.map((p) => `${x(p.gen) + off},${y(p.mean)}`).join(" ")} fill="none" stroke={c} strokeWidth={2} />
                    {t.points.map((p) => (
                      <g key={p.gen}>
                        <title>{`${nameOf(t.lineageId)} · gen ${p.gen}: mean ${fmtSigned(p.mean)}${p.se != null ? ` ± ${fmt(p.se)}` : ""}, n = ${p.n}`}</title>
                        {p.se != null && <line x1={x(p.gen) + off} x2={x(p.gen) + off} y1={y(p.mean - p.se)} y2={y(p.mean + p.se)} stroke={c} strokeWidth={2} />}
                        <circle cx={x(p.gen) + off} cy={y(p.mean)} r={4} fill={c} className="pt" />
                      </g>
                    ))}
                  </g>
                );
              })}
              {labels.map((l) => (
                <text key={l.t.lineageId} x={l.x + 12} y={l.y + 4} className="val-label">
                  {truncate(nameOf(l.t.lineageId), 14)} <tspan className="mono-label">n={l.t.size}</tspan>
                </text>
              ))}
            </Svg>
          );
        })()
      )}
    </Figure>
  );
}

export function MotherChild({ res, dim }: { res: Q4Heredity; dim: string }) {
  const W = 640;
  const H = 330;
  const m = { l: 50, r: 16, t: 14, b: 44 };
  const f = res.fit;
  const c = res.clustered;
  const color = pointColorer(res.pairs.map((p) => p.lineageId));
  return (
    <Figure
      variant="orange"
      className="span-6"
      head="Mother vs child"
      title={`${dim}: mother vs child`}
      n={`n = ${res.pairs.length} pairs · ${res.mothers} mothers`}
      foot={
        <>
          <span>slope {fmt(f?.b)} · 95% CI [{fmt(f?.ciB[0])}, {fmt(f?.ciB[1])}]</span>
          <span>{c ? <>clustered by mother [{fmt(c.ciB[0])}, {fmt(c.ciB[1])}] · 1 = copied exactly</> : "clustered CI needs ≥ 5 mothers"}</span>
        </>
      }
    >
      {res.pairs.length < 1 ? (
        <NotEnough w={W} h={H} why="no child of a recorded mother yet" />
      ) : (
        (() => {
          const dom = extent(res.pairs.flatMap((p) => [p.mother, p.child]));
          const x = linear(dom[0], dom[1], m.l, W - m.r);
          const y = linear(dom[0], dom[1], H - m.b, m.t);
          const xs = res.pairs.map((p) => p.mother);
          const lo = Math.min(...xs);
          const hi = Math.max(...xs);
          const steps = 40;
          const grid = Array.from({ length: steps + 1 }, (_, i) => lo + ((hi - lo) * i) / steps);
          const clampY = (v: number) => y(Math.max(dom[0], Math.min(dom[1], v)));
          return (
            <Svg w={W} h={H} label={`${dim}, mother vs child`}>
              <Axes x={x} y={y} m={m} w={W} h={H} xTitle={`Mother's ${dim}`} yTitle={`Child's ${dim}`} xFmt={(v) => fmt(v, 1)} yFmt={(v) => fmt(v, 1)} />
              <line x1={x(dom[0])} y1={y(dom[0])} x2={x(dom[1])} y2={y(dom[1])} className="identity" />
              {f && hi > lo && (
                <>
                  <polygon points={[...grid.map((v) => `${x(v)},${clampY(olsBand(f, v)[1])}`), ...grid.map((v) => `${x(v)},${clampY(olsBand(f, v)[0])}`).reverse()].join(" ")} className="ci-band clay" />
                  <line x1={x(lo)} y1={clampY(f.a + f.b * lo)} x2={x(hi)} y2={clampY(f.a + f.b * hi)} className="fit-line clay" />
                </>
              )}
              {res.pairs.map((p) => (
                <circle key={p.childId} cx={x(p.mother)} cy={y(p.child)} r={4} fill={color(p.lineageId)} className="pt">
                  <title>{`mother ${fmtSigned(p.mother)} → child ${fmtSigned(p.child)}`}</title>
                </circle>
              ))}
            </Svg>
          );
        })()
      )}
      <div className="key">dashed = child equals mother</div>
    </Figure>
  );
}
