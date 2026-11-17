// Q3: who takes which role, beyond chance?
import { MIN_ACTIONS, MIN_FIT_N, ROLES, type Q3Result } from "./analysis.ts";
import { divergingFill, fmt, fmtP, fmtSigned, linear, NotEnough, Svg } from "./charts.tsx";
import { Figure } from "./Figure.tsx";
import { niceTicks } from "./stats.ts";
import { truncate } from "../shared/format.ts";

export function RoleMatrix({ res, dims, pageQ }: { res: Q3Result; dims: string[]; pageQ?: (dim: string, role: string) => number | null }) {
  const cw = 92;
  const ch = dims.length > 10 ? 26 : 38;
  const m = { l: 150, t: 30, r: 8, b: 8 };
  const W = m.l + ROLES.length * cw + m.r;
  const H = m.t + Math.max(1, dims.length) * ch + m.b;
  // stars use the same page-wide BH as the banner (falls back to BH within the matrix)
  const qOf = (c: Q3Result["cells"][number] | undefined) => (c ? (pageQ ? pageQ(c.dim, c.role) : c.q) : null);
  const sig = res.cells.filter((c) => c.p != null && c.p < 0.05).length;
  const fdr = res.cells.filter((c) => (qOf(c) ?? 1) < 0.05).length;
  return (
    <Figure
      variant="berry"
      className="span-6"
      head="Trait × role correlation"
      title="Spearman ρ, trait vs role share (within sex × child/adult)"
      n={`n = ${res.n} lives with ≥ ${MIN_ACTIONS} actions · ${res.families} famil${res.families === 1 ? "y" : "ies"}`}
      foot={
        <>
          <span className="divkey">
            ρ −0.6 <i className="ramp" /> +0.6
          </span>
          <span>
            {res.tests > 0 ? (
              <>
                ● p &lt; .05 ({sig} of {res.tests}; ~{fmt(res.tests * 0.05, 1)} expected by chance) · ★ page FDR q &lt; .05 ({fdr})
              </>
            ) : (
              "● p < .05 · ★ FDR q < .05"
            )}
          </span>
        </>
      }
    >
      {res.n < MIN_FIT_N || !dims.length ? (
        <NotEnough w={W} h={Math.max(H, 200)} why={`${res.n} li${res.n === 1 ? "fe has" : "ves have"} ${MIN_ACTIONS}+ actions`} />
      ) : (
        <Svg w={W} h={H} label="trait by role correlation matrix">
          {ROLES.map((r, j) => (
            <text key={r} x={m.l + j * cw + cw / 2} y={m.t - 10} textAnchor="middle" className="cat-label">
              {r}
            </text>
          ))}
          {dims.map((d, i) => (
            <g key={d}>
              <text x={m.l - 10} y={m.t + i * ch + ch / 2 + 4} textAnchor="end" className="cat-label">
                {truncate(d, 18)}
                <title>{d}</title>
              </text>
              {ROLES.map((r, j) => {
                const c = res.cells.find((x) => x.dim === d && x.role === r);
                const v = c?.rho ?? null;
                const dark = v != null && Math.abs(v) > 0.38;
                const mark = (qOf(c) ?? 1) < 0.05 ? " ★" : c?.p != null && c.p < 0.05 ? " ●" : "";
                return (
                  <g key={r}>
                    <title>{`${d} × ${r}: ρ = ${fmtSigned(v)}, ${fmtP(c?.p)}, page FDR q = ${fmt(qOf(c), 3)}`}</title>
                    <rect x={m.l + j * cw + 1} y={m.t + i * ch + 1} width={cw - 2} height={ch - 2} rx={5} fill={divergingFill(v)} className="cell" />
                    <text x={m.l + j * cw + cw / 2} y={m.t + i * ch + ch / 2 + 4} textAnchor="middle" className="cell-label" style={{ fill: dark ? "#fff" : "var(--ink)" }}>
                      {fmtSigned(v)}
                      {mark}
                    </text>
                  </g>
                );
              })}
            </g>
          ))}
        </Svg>
      )}
    </Figure>
  );
}

export function RoleConcentration({ res }: { res: Q3Result }) {
  const W = 620;
  const rh = 42;
  const m = { l: 100, r: 120, t: 10, b: 44 };
  const H = m.t + ROLES.length * rh + m.b;
  const conc = res.concentration;
  const ok = conc.some((c) => c.observed != null);
  const maxV = Math.max(0.2, ...conc.flatMap((c) => [c.observed ?? 0, c.hi ?? 0]));
  const x = linear(0, Math.min(1, maxV * 1.1), m.l, W - m.r);
  const ticks = niceTicks(0, Math.min(1, maxV * 1.1), 6);
  return (
    <Figure
      variant="berry"
      className="span-6"
      head="Do people specialise?"
      title="How unevenly each role is spread across people"
      n={`n = ${res.n} · ${res.shuffles.toLocaleString("en-US")} shuffles within ${res.strata} sex × child/adult group${res.strata === 1 ? "" : "s"}`}
      foot={<span>grey = 95% of shuffles (role labels shuffled between people of the same sex and stage, each keeps their total) · ◆ observed · about people, not traits</span>}
    >
      {!ok ? (
        <NotEnough w={W} h={H} why={`needs 2+ lives with ${MIN_ACTIONS}+ actions`} />
      ) : (
        <Svg w={W} h={H} label="role concentration against shuffle null">
          <g className="grid">
            {ticks.map((v) => (
              <line key={v} x1={x(v)} x2={x(v)} y1={m.t} y2={H - m.b} />
            ))}
          </g>
          {ticks.map((v) => (
            <text key={v} x={x(v)} y={H - m.b + 15} textAnchor="middle">
              {fmt(v, 1)}
            </text>
          ))}
          {conc.map((c, i) => {
            const yy = m.t + i * rh + rh / 2;
            const beyond = c.p != null && c.p < 0.05;
            return (
              <g key={c.role}>
                <title>{`${ROLES[c.role]}: observed Gini ${fmt(c.observed, 3)}; shuffles 95% ${fmt(c.lo, 3)}–${fmt(c.hi, 3)}; ${fmtP(c.p)}`}</title>
                <text x={m.l - 10} y={yy + 4} textAnchor="end" className="cat-label">
                  {ROLES[c.role]}
                </text>
                {c.lo != null && c.hi != null && <rect x={x(c.lo)} y={yy - 8} width={Math.max(3, x(c.hi) - x(c.lo))} height={16} rx={8} className="null-band" />}
                {c.observed != null && <path d={`M${x(c.observed)} ${yy - 8} l8 8 l-8 8 l-8 -8 Z`} className={beyond ? "obs beyond" : "obs"} />}
                <text x={W - m.r + 8} y={yy + 4} className="val-label">
                  {fmt(c.observed, 2)} <tspan className="mono-label">{fmtP(c.p)}</tspan>
                </text>
              </g>
            );
          })}
          <g className="axis">
            <line x1={m.l} x2={W - m.r} y1={H - m.b} y2={H - m.b} />
          </g>
          <text className="axis-title" x={(m.l + W - m.r) / 2} y={H - 6} textAnchor="middle">
            Gini of role share across people (0 = everyone the same)
          </text>
        </Svg>
      )}
    </Figure>
  );
}
