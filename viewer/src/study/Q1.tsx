// Q1: do traits affect survival and reaching adulthood?
import { ADULT_AGE, LIFESPAN_YEARS, RISK_AGES, SURV_GRID, type Q1Adult, type Q1Survival } from "./analysis.ts";
import { Axes, barPath, fmt, fmtP, fmtSigned, linear, NotEnough, Svg } from "./charts.tsx";
import { Figure } from "./Figure.tsx";

/** low / middle / high third: diverging, so the middle reads as neutral */
export const THIRD_COLORS = ["var(--clay)", "var(--ink-3)", "var(--berry)"];

export function Survival({ res, dim }: { res: Q1Survival; dim: string }) {
  const W = 640;
  const H = 330;
  const m = { l: 50, r: 16, t: 14, b: 74 };
  const t = res.test;
  const dir = t && t.p < 0.05 ? (t.stat < 0 ? ` · higher ${dim}, longer lives` : ` · higher ${dim}, shorter lives`) : "";

  return (
    <Figure
      variant="navy"
      className="span-7"
      head="Survival by trait third"
      title={`Kaplan–Meier, by ${dim}`}
      n={`n = ${res.n} · ${res.deaths} died · ${res.censored} alive or lost (censored) · ${res.families} famil${res.families === 1 ? "y" : "ies"}`}
      foot={
        <>
          <span>bands: 95% family bootstrap{res.boot ? ` (${res.boot})` : ""}</span>
          <span>
            log-rank trend {fmtP(t?.p)}
            {dir}
          </span>
        </>
      }
    >
      {res.deaths < 1 || res.n < 3 ? (
        <NotEnough w={W} h={H} why={res.n ? "no deaths yet" : "no lives with this trait yet"} />
      ) : (
        (() => {
          const x = linear(0, LIFESPAN_YEARS, m.l, W - m.r);
          const y = linear(0, 1, H - m.b, m.t);
          const rowY = (i: number) => H - m.b + 34 + i * 12;
          return (
            <Svg w={W} h={H} label={`survival by ${dim} third`}>
              <Axes x={x} y={y} m={m} w={W} h={H} xTicks={[0, 14, 30, 45, 60]} yTicks={[0, 0.25, 0.5, 0.75, 1]} yFmt={(v) => `${Math.round(v * 100)}%`} xTitle="" yTitle="Still alive" />
              <line x1={x(ADULT_AGE)} x2={x(ADULT_AGE)} y1={m.t} y2={H - m.b} className="ref-line" />
              {res.curves.map((c, g) => {
                const pts: string[] = [];
                const band: [number, number, number][] = [];
                SURV_GRID.forEach((a, j) => {
                  const lo = c.lo[j];
                  const hi = c.hi[j];
                  if (a <= c.last && lo != null && hi != null) band.push([a, lo, hi]);
                });
                let prev = 1;
                pts.push(`${x(0)},${y(1)}`);
                for (const s of c.steps) {
                  if (s.t > c.last) break;
                  pts.push(`${x(s.t)},${y(prev)}`, `${x(s.t)},${y(s.s)}`);
                  prev = s.s;
                }
                pts.push(`${x(c.last)},${y(prev)}`);
                const poly = band.length > 1 ? [...band.map(([a, , hi]) => `${x(a)},${y(hi)}`), ...band.map(([a, lo]) => `${x(a)},${y(lo)}`).reverse()].join(" ") : "";
                return (
                  <g key={c.label}>
                    {poly && <polygon points={poly} fill={THIRD_COLORS[g]} fillOpacity={0.12} stroke="none" />}
                    <polyline points={pts.join(" ")} fill="none" stroke={THIRD_COLORS[g]} strokeWidth={2.4}>
                      <title>{`${c.label} third (${fmt(c.min, 1)} to ${fmt(c.max, 1)}): n = ${c.n}, ${c.deaths} died`}</title>
                    </polyline>
                  </g>
                );
              })}
              {res.curves.map((c, g) => (
                <g key={c.label} style={{ fill: THIRD_COLORS[g] }}>
                  {RISK_AGES.map((a, j) => (
                    <text key={a} x={x(a) + (j === 0 ? 6 : 0)} y={rowY(g)} textAnchor="middle" className="mono-label small" style={{ fill: "inherit" }}>
                      {c.atRisk[j]}
                    </text>
                  ))}
                </g>
              ))}
            </Svg>
          );
        })()
      )}
      <div className="key">
        {res.curves.map((c, g) => c.n > 0 && (
          <span key={c.label} style={{ color: THIRD_COLORS[g], fontWeight: 800, marginRight: 12 }}>
            ━ {c.label} {fmt(c.min, 1)} to {fmt(c.max, 1)} (n {c.n}, {c.deaths} died)
          </span>
        ))}
      </div>
      <div className="key">x = age (game years) · numbers under it: lives still observed at that age · curves stop at the oldest age seen in each third · lives starting as adults enter at {ADULT_AGE}</div>
    </Figure>
  );
}

export function Adulthood({ res, dim }: { res: Q1Adult; dim: string }) {
  const W = 460;
  const H = 330;
  const m = { l: 50, r: 12, t: 16, b: 58 };
  const t = res.trend;
  return (
    <Figure
      variant="navy"
      className="span-5"
      head="Reached adulthood, by trait third"
      title={`Share reaching ${ADULT_AGE}`}
      n={`n = ${res.n} born ≥ ${ADULT_AGE} y ago · excl. ${res.bornAdult} born adult, ${res.tooYoung} younger${res.lost ? `, ${res.lost} lost as children` : ""}`}
      foot={
        <>
          <span>95% Wilson (lives as independent)</span>
          <span>trend ρ = {fmtSigned(t?.stat)} · {fmtP(t?.p)}{t ? ` · ${t.clusters} families` : ""}</span>
        </>
      }
    >
      {res.n < 3 ? (
        <NotEnough w={W} h={H} why={`${res.n} li${res.n === 1 ? "fe" : "ves"} old enough to have had the chance`} />
      ) : (
        (() => {
          const y = linear(0, 1, H - m.b, m.t);
          const bw = (W - m.l - m.r) / 3;
          const x = linear(0, 3, m.l, W - m.r);
          return (
            <Svg w={W} h={H} label={`share reaching ${ADULT_AGE} by ${dim} third`}>
              <Axes x={x} y={y} m={m} w={W} h={H} xTicks={[]} yTicks={[0, 0.25, 0.5, 0.75, 1]} yFmt={(v) => `${Math.round(v * 100)}%`} yTitle={`Reached ${ADULT_AGE}`} xTitle={dim} />
              {res.bars.map((b, i) => {
                const cx = m.l + bw * (i + 0.5);
                const w = Math.min(64, bw * 0.5);
                if (!b.n || b.p == null)
                  return (
                    <text key={b.label} x={cx} y={y(0.1)} textAnchor="middle" className="muted-label">
                      n = 0
                    </text>
                  );
                const top = y(b.p);
                return (
                  <g key={b.label}>
                    <title>{`${b.label} third: ${b.k}/${b.n} reached ${ADULT_AGE} (${Math.round(b.p * 100)}%, 95% CI ${Math.round((b.lo ?? 0) * 100)}–${Math.round((b.hi ?? 0) * 100)}%)`}</title>
                    <path d={barPath(cx - w / 2, w, top, y(0))} className="bar" />
                    <line x1={cx} x2={cx} y1={y(b.lo!)} y2={y(b.hi!)} className="whisker" />
                    <line x1={cx - 8} x2={cx + 8} y1={y(b.lo!)} y2={y(b.lo!)} className="whisker" />
                    <line x1={cx - 8} x2={cx + 8} y1={y(b.hi!)} y2={y(b.hi!)} className="whisker" />
                    <text x={cx + w / 2 + 5} y={Math.min(top, y(0) - 6) - 2} className="val-label">
                      {b.k}/{b.n}
                    </text>
                    <text x={cx} y={H - m.b + 16} textAnchor="middle" className="cat-label">
                      {b.label}
                    </text>
                    <text x={cx} y={H - m.b + 30} textAnchor="middle" className="mono-label">
                      {fmt(b.min, 1)} to {fmt(b.max, 1)}
                    </text>
                  </g>
                );
              })}
            </Svg>
          );
        })()
      )}
    </Figure>
  );
}
