// Deaths: a short recent list (home) and a sortable, filterable table over every observed death (families page).

import { useMemo, useState } from "react";
import type { LifeRecord } from "../api-types.ts";
import { pageHref, useNow } from "../data/index.ts";
import { deathReasonText, displayName, formatAge, formatClock, formatRelative } from "../shared/index.ts";
import { matchesQuery, pageSlice, sortBy, type SortDir } from "./logic.ts";
import { LifePortrait, LivesState, Pager, SortTh } from "./ui.tsx";
import type { SiteData } from "./useSite.ts";

export const DEATH_ICON: Record<string, string> = {
  starved: "🍂",
  froze: "❄",
  "old age": "⌛",
  killed: "⚔",
  overheated: "☀",
};

export function deadLives(site: SiteData): LifeRecord[] {
  return site.lives.filter((l) => l.status === "dead");
}

export function RecentDeaths({ site, limit = 5 }: { site: SiteData; limit?: number }) {
  const now = useNow(15_000);
  const rows = useMemo(() => sortBy(deadLives(site), (l) => l.diedAt ?? l.updatedAt, "desc").slice(0, limit), [site, limit]);
  if (!rows.length) return <LivesState site={site} empty="Nobody has died yet." />;
  return (
    <ul className="deaths">
      {rows.map((l) => {
        const why = deathReasonText(l.deathReason);
        return (
          <li key={l.lifeId}>
            <a href={pageHref("agent", { life: l.lifeId })} className="row-link">
              <LifePortrait life={l} site={site} size={38} round />
              <div className="who">
                <div className="nm ugc">
                  {displayName(l.name)} <span className="age">{formatAge(l.ageAtDeath)}</span>
                </div>
                <div className="why">
                  {DEATH_ICON[why] ? `${DEATH_ICON[why]} ` : ""}
                  {why}
                </div>
              </div>
              <time title={l.diedAt ? new Date(l.diedAt).toLocaleString() : undefined}>{formatRelative(l.diedAt == null ? null : Math.min(l.diedAt, now), now)}</time>
            </a>
          </li>
        );
      })}
    </ul>
  );
}

type DKey = "name" | "family" | "age" | "gen" | "cause" | "when";

export function DeathsTable({ site, pageSize = 25 }: { site: SiteData; pageSize?: number }) {
  const now = useNow(30_000);
  const [sort, setSort] = useState<DKey>("when");
  const [dir, setDir] = useState<SortDir>("desc");
  const [cause, setCause] = useState("");
  const [fam, setFam] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(0);
  const dead = useMemo(() => deadLives(site), [site]);
  const causes = useMemo(() => {
    const c = new Map<string, number>();
    for (const l of dead) c.set(deathReasonText(l.deathReason), (c.get(deathReasonText(l.deathReason)) ?? 0) + 1);
    return [...c.entries()].sort((a, b) => b[1] - a[1]);
  }, [dead]);
  const fams = useMemo(() => {
    const c = new Map<string, number>();
    for (const l of dead) c.set(l.lineageId, (c.get(l.lineageId) ?? 0) + 1);
    return [...c.entries()].map(([id, n]) => ({ id, n, name: site.famName(id) })).sort((a, b) => a.name.localeCompare(b.name));
  }, [dead, site]);

  const rows = useMemo(() => {
    const f = dead.filter((l) => (!cause || deathReasonText(l.deathReason) === cause) && (!fam || l.lineageId === fam) && matchesQuery(q, displayName(l.name), site.famName(l.lineageId)));
    const keyOf: Record<DKey, (l: LifeRecord) => number | string | null> = {
      name: (l) => (l.name ? displayName(l.name) : null),
      family: (l) => site.famName(l.lineageId),
      age: (l) => l.ageAtDeath,
      gen: (l) => l.generation,
      cause: (l) => deathReasonText(l.deathReason),
      when: (l) => l.diedAt,
    };
    return sortBy(f, keyOf[sort], dir, (a, b) => (b.diedAt ?? 0) - (a.diedAt ?? 0));
  }, [dead, cause, fam, q, sort, dir, site]);

  const onSort = (k: DKey) => {
    if (k === sort) setDir(dir === "asc" ? "desc" : "asc");
    else {
      setSort(k);
      setDir(k === "when" || k === "age" ? "desc" : "asc");
    }
    setPage(0);
  };
  const pg = pageSlice(rows, page, pageSize);
  if (!dead.length) return <LivesState site={site} empty="Nobody has died yet." />;

  return (
    <div>
      <div className="tools">
        <input className="search" type="search" placeholder="Search names" value={q} onChange={(e) => (setQ(e.target.value), setPage(0))} aria-label="Search deaths by name" />
        <select value={cause} onChange={(e) => (setCause(e.target.value), setPage(0))} aria-label="Cause of death">
          <option value="">Every cause</option>
          {causes.map(([c, n]) => (
            <option key={c} value={c}>
              {c} ({n})
            </option>
          ))}
        </select>
        <select value={fam} onChange={(e) => (setFam(e.target.value), setPage(0))} aria-label="Family">
          <option value="">Every family</option>
          {fams.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name} ({f.n})
            </option>
          ))}
        </select>
        <span className="mono count">{rows.length} shown</span>
      </div>
      <div className="table-wrap">
        <table className="data sortable-table">
          <thead>
            <tr>
              <SortTh k="name" sort={sort} dir={dir} onSort={onSort}>
                Name
              </SortTh>
              <SortTh k="family" sort={sort} dir={dir} onSort={onSort}>
                Family
              </SortTh>
              <SortTh k="age" sort={sort} dir={dir} onSort={onSort} className="num">
                Age
              </SortTh>
              <SortTh k="gen" sort={sort} dir={dir} onSort={onSort} className="num">
                Gen
              </SortTh>
              <SortTh k="cause" sort={sort} dir={dir} onSort={onSort}>
                Cause
              </SortTh>
              <SortTh k="when" sort={sort} dir={dir} onSort={onSort}>
                When
              </SortTh>
            </tr>
          </thead>
          <tbody>
            {pg.rows.map((l) => {
              const why = deathReasonText(l.deathReason);
              return (
                <tr key={l.lifeId}>
                  <td className="name-cell">
                    <a href={pageHref("agent", { life: l.lifeId })}>
                      <LifePortrait life={l} site={site} size={28} round />
                      <span className="ugc clip">{displayName(l.name)}</span>
                    </a>
                  </td>
                  <td className="ugc clip">{site.famName(l.lineageId)}</td>
                  <td className="num mono">{formatAge(l.ageAtDeath, { unit: false })}</td>
                  <td className="num mono">{l.generation}</td>
                  <td>
                    {DEATH_ICON[why] ? `${DEATH_ICON[why]} ` : ""}
                    {why}
                  </td>
                  <td className="when" title={l.diedAt ? new Date(l.diedAt).toLocaleString() : undefined}>
                    {formatClock(l.diedAt)} <span className="muted">· {formatRelative(l.diedAt == null ? null : Math.min(l.diedAt, now), now)}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <Pager page={pg.page} pages={pg.pages} onPage={setPage} total={rows.length} size={pageSize} />
    </div>
  );
}
