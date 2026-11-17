// Q2: who leaves descendants?
import { ADULT_AGE, FERTILE_END, type Q2Result } from "./analysis.ts";
import { barPath, fmt, fmtP, fmtSigned, linear, NotEnough, Svg } from "./charts.tsx";
import { Figure } from "./Figure.tsx";
import { niceTicks } from "./stats.ts";

export function Descendants({ res, dim }: { res: Q2Result; dim: string }) {
  const W = 1280;
  const H = 290;
  const m = { l: 50, r: 16, t: 14, b: 58 };
  const rows = res.rows;
  const c = res.children;
  const d = res.descendants;
  return (
    <Figure
      variant="green"
      className="span-12"
      head="Children and grandchildren per adult woman"
      title={`Sorted by ${dim}, low → high`}
      n={
        <>
          n = {rows.length} women who reached {ADULT_AGE} · {rows.length - res.closed} still open · <i className="sw sw-kids" /> children <i className="sw sw-grand" /> grandchildren
        </>
      }
      foot={
        <>
          <span>children (n = {res.closed} closed: dead or past {FERTILE_END}): ρ = {fmtSigned(c?.stat)} · {fmtP(c?.p)}{c ? ` · ${c.clusters} families` : ""}</span>
          <span>+ grandchildren (n = {res.complete} whose daughters are closed too): ρ = {fmtSigned(d?.stat)} · {fmtP(d?.p)}{d ? ` · ${d.clusters} families` : ""}</span>
        </>
      }
    >
      {!rows.length ? (
        <NotEnough w={W} h={H} why={`no woman observed past ${ADULT_AGE} yet`} />
      ) : (
        (() => {
          const max = Math.max(1, ...rows.map((r) => r.children + r.grandchildren));
          const y = linear(0, max, H - m.b, m.t);
          const slot = (W - m.l - m.r) / rows.length;
          const gap = slot > 6 ? 2 : slot > 3 ? 1 : 0;
          const bw = Math.max(1, Math.min(34, slot - gap));
          const x0 = (i: number) => m.l + i * slot + (slot - bw) / 2;
          const yt = niceTicks(0, max, 4).filter((v) => Number.isInteger(v));
          // trait value labels at ~8 evenly spaced women
          const k = Math.min(rows.length, 8);
          const labelIdx = [...new Set(Array.from({ length: k }, (_, j) => Math.round((j * (rows.length - 1)) / Math.max(1, k - 1))))];
          return (
            <Svg w={W} h={H} label={`descendants per woman sorted by ${dim}`}>
              <g className="grid">
                {yt.map((v) => (
                  <line key={v} x1={m.l} x2={W - m.r} y1={y(v)} y2={y(v)} />
                ))}
              </g>
              {yt.map((v) => (
                <text key={v} x={m.l - 6} y={y(v) + 4} textAnchor="end">
                  {v}
                </text>
              ))}
              {rows.map((r, i) => {
                const yc = y(r.children);
                const yg = y(r.children + r.grandchildren);
                return (
                  <g key={r.lifeId} className={!r.closed ? "open" : undefined}>
                    <title>{`${r.name ?? r.lifeId} · ${dim} ${fmtSigned(r.x)} · ${r.children} children, ${r.grandchildren} grandchildren${!r.closed ? " · still open (alive or under " + FERTILE_END + ")" : ""}`}</title>
                    <rect x={m.l + i * slot} y={m.t} width={slot} height={H - m.b - m.t} fill="transparent" />
                    {r.children > 0 && <path d={r.grandchildren ? `M${x0(i)} ${y(0)} V${yc} H${x0(i) + bw} V${y(0)} Z` : barPath(x0(i), bw, yc, y(0))} className="bar-kids" />}
                    {r.grandchildren > 0 && <path d={barPath(x0(i), bw, yg, yc - (r.children ? Math.min(2, (yc - yg) / 2) : 0))} className="bar-grand" />}
                    {r.children + r.grandchildren === 0 && <line x1={x0(i)} x2={x0(i) + bw} y1={y(0) - 1} y2={y(0) - 1} className="zero-tick" />}
                    {!r.closed && <line x1={x0(i)} x2={x0(i) + bw} y1={y(0) + 4} y2={y(0) + 4} className="open-tick" />}
                  </g>
                );
              })}
              <g className="axis">
                <line x1={m.l} x2={W - m.r} y1={H - m.b} y2={H - m.b} />
                <line x1={m.l} x2={m.l} y1={m.t} y2={H - m.b} />
              </g>
              {labelIdx.map((i) => (
                <text key={i} x={x0(i) + bw / 2} y={H - m.b + 20} textAnchor="middle" className="mono-label">
                  {fmt(rows[i].x, 2)}
                </text>
              ))}
              <text className="axis-title" x={(m.l + W - m.r) / 2} y={H - 8} textAnchor="middle">
                {`Women, by ${dim} (value shown under some bars) · underline = still open (not in the tests)`}
              </text>
              <text className="axis-title" transform={`translate(13 ${(m.t + H - m.b) / 2}) rotate(-90)`} textAnchor="middle">
                Descendants
              </text>
            </Svg>
          );
        })()
      )}
    </Figure>
  );
}
