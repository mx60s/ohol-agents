// People (people.html): every life ever, searchable and sortable, with portraits and each trait column.
import { useMemo, useState } from "react";
import type { LifeRecord } from "../api-types.ts";
import { pageHref, useNow } from "../data/index.ts";
import { deathReasonText, displayName, formatAge, formatRelative, formatTrait } from "../shared/index.ts";
import { clampTrait, matchesQuery, pageSlice, sortBy, traitLabel, traitShort, type SortDir } from "../site/logic.ts";
import { LifePortrait, LivesState, Pager, Seg, SortTh } from "../site/ui.tsx";
import { useSite } from "../site/useSite.ts";
import "../site/site.css";
import { MockBadge, Panel, SiteLayout } from "../theme/index.ts";
import { mount } from "./mount.tsx";

type Status = "all" | "alive" | "dead";
const PAGE = 100;

function PeoplePage() {
  const site = useSite();
  const now = useNow(30_000);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<Status>("all");
  const [fam, setFam] = useState("");
  const [sort, setSort] = useState<string>("born");
  const [dir, setDir] = useState<SortDir>("desc");
  const [page, setPage] = useState(0);

  const counts = useMemo(() => ({ all: site.lives.length, alive: site.lives.filter((l) => l.status === "alive").length, dead: site.lives.filter((l) => l.status === "dead").length }), [site.lives]);
  const fams = useMemo(() => sortBy([...new Set(site.lives.map((l) => l.lineageId))], (id) => site.famName(id)), [site]);

  const rows = useMemo(() => {
    const f = site.lives.filter(
      (l) => (status === "all" || l.status === status) && (!fam || l.lineageId === fam) && matchesQuery(q, displayName(l.name), site.famName(l.lineageId)),
    );
    let key: (l: LifeRecord) => number | string | null;
    if (sort.startsWith("t:")) {
      const d = sort.slice(2);
      key = (l) => clampTrait(l.traits?.[d]);
    } else {
      const keys: Record<string, (l: LifeRecord) => number | string | null> = {
        name: (l) => (l.name ? displayName(l.name) : null),
        age: (l) => site.ageOf(l),
        gen: (l) => l.generation,
        family: (l) => site.famName(l.lineageId),
        status: (l) => l.status,
        cause: (l) => (l.status === "dead" ? deathReasonText(l.deathReason) : null),
        born: (l) => l.bornAt,
      };
      key = keys[sort] ?? keys.born;
    }
    return sortBy(f, key, dir, (a, b) => b.bornAt - a.bornAt);
  }, [site, status, fam, q, sort, dir]);

  const onSort = (k: string) => {
    if (k === sort) setDir(dir === "asc" ? "desc" : "asc");
    else {
      setSort(k);
      setDir(k === "name" || k === "family" || k === "status" || k === "cause" ? "asc" : "desc");
    }
    setPage(0);
  };
  const pg = pageSlice(rows, page, PAGE);
  const th = (k: string, label: string, cls?: string, title?: string) => (
    <SortTh k={k} sort={sort} dir={dir} onSort={onSort} className={cls} title={title}>
      {label}
    </SortTh>
  );

  return (
    <SiteLayout active="people">
      <div className="as">
        <div className="page-title">
          <h1>People</h1>
        </div>
        <Panel title="Every life" variant="green" badge={<MockBadge title="Mock: traits are assigned and inherited as designed, but nothing steers the agents yet" />}>
          <div className="tools">
            <input className="search" type="search" placeholder="Search names or families" value={q} onChange={(e) => (setQ(e.target.value), setPage(0))} aria-label="Search people" />
            <Seg<Status>
              label="Status"
              value={status}
              onChange={(s) => (setStatus(s), setPage(0))}
              options={[
                { key: "all", label: `Everyone ${counts.all}` },
                { key: "alive", label: `Living ${counts.alive}` },
                { key: "dead", label: `Dead ${counts.dead}` },
              ]}
            />
            <select value={fam} onChange={(e) => (setFam(e.target.value), setPage(0))} aria-label="Family">
              <option value="">Every family</option>
              {fams.map((id) => (
                <option key={id} value={id}>
                  {site.famName(id)}
                </option>
              ))}
            </select>
            <span className="mono count">{rows.length} shown</span>
          </div>
          {rows.length === 0 ? (
            <LivesState site={site} empty={site.lives.length ? "Nobody matches." : "No lives yet."} />
          ) : (
            <>
              <div className="table-wrap">
                <table className="data sortable-table people-table">
                  <thead>
                    <tr>
                      {th("name", "Name")}
                      {th("age", "Age", "num")}
                      {th("gen", "Gen", "num")}
                      {th("family", "Family")}
                      {th("status", "Status")}
                      {th("cause", "Cause")}
                      {th("born", "Born")}
                      {site.dims.map((d) => th(`t:${d}`, traitShort(d), "num trait", traitLabel(d)))}
                    </tr>
                  </thead>
                  <tbody>
                    {pg.rows.map((l) => (
                      <tr key={l.lifeId} className={l.status === "dead" ? "is-dead" : undefined}>
                        <td className="name-cell">
                          <a href={pageHref("agent", { life: l.lifeId })}>
                            <LifePortrait life={l} site={site} size={32} round />
                            <span className="ugc clip">{displayName(l.name)}</span>
                          </a>
                        </td>
                        <td className="num mono">{formatAge(site.ageOf(l), { unit: false })}</td>
                        <td className="num mono">{l.generation}</td>
                        <td className="ugc clip">{site.famName(l.lineageId)}</td>
                        <td>{l.status === "alive" ? <span className="st alive">● alive</span> : l.status === "lost" ? <span className="st lost">lost</span> : <span className="st dead">† dead</span>}</td>
                        <td>{l.status === "dead" ? deathReasonText(l.deathReason) : ""}</td>
                        <td className="when" title={new Date(l.bornAt).toLocaleString()}>
                          {formatRelative(l.bornAt, now)}
                        </td>
                        {site.dims.map((d) => {
                          const v = clampTrait(l.traits?.[d]);
                          return (
                            <td key={d} className="num mono trait" style={v == null ? undefined : { background: traitBg(v) }} title={formatTrait(l.traits?.[d])}>
                              {v == null ? "" : formatTrait(v, 1)}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Pager page={pg.page} pages={pg.pages} onPage={(p) => (setPage(p), window.scrollTo({ top: 0 }))} total={rows.length} size={PAGE} />
            </>
          )}
        </Panel>
      </div>
    </SiteLayout>
  );
}

/** quiet diverging tint for trait cells: berry for high, clay for low */
function traitBg(v: number): string {
  const a = Math.min(1, Math.abs(v) / 2.5) * 0.38;
  return v >= 0 ? `rgba(74,90,168,${a.toFixed(3)})` : `rgba(192,100,58,${a.toFixed(3)})`;
}

mount(<PeoplePage />);
