// Leadership (families page): who follows whom among the living right now, as an indented tree.
// Names render as React text nodes (escaped); the tree logic lives in ./leadership.ts.

import { useMemo } from "react";
import type { LeadershipPerson } from "../api-types.ts";
import { pageHref, useLeadership, useWorldState } from "../data/index.ts";
import { displayName, FlowerIcon, formatAge, PersonalityTag } from "../shared/index.ts";
import { Pill } from "../theme/index.ts";
import { buildLeadershipTree, LEADERSHIP_EMPTY, leadershipRows, unattachedLine } from "./leadership.ts";
import { Note } from "./ui.tsx";

function Person({ p, compact, palette }: { p: LeadershipPerson; compact?: boolean; palette?: string[] | null }) {
  const name = displayName(p.name);
  return (
    <span className="ld-person">
      {p.flower && <FlowerIcon flower={p.flower} size={compact ? 14 : 16} />}
      {p.lifeId ? (
        <a className="ld-name ugc" href={pageHref("agent", { life: p.lifeId })}>
          {name}
        </a>
      ) : (
        <span className="ld-name ugc">{name}</span>
      )}
      {p.isEve && <Pill tone="warn" title="First of a family">Eve</Pill>}
      <span className="ld-age">{formatAge(p.age)}</span>
      {!compact && <PersonalityTag personality={p.personality} palette={palette} short className="ld-persona" />}
    </span>
  );
}

export function Leadership() {
  const { data, loading, error } = useLeadership();
  const palette = useWorldState().state?.run.personalities ?? null;
  const tree = useMemo(() => buildLeadershipTree(data), [data]);
  const rows = useMemo(() => leadershipRows(tree.roots), [tree]);
  if (!data) return <Note>{loading ? "Loading…" : error ? "Can't load leadership right now." : LEADERSHIP_EMPTY}</Note>;
  const loners = unattachedLine(tree.unattached);
  return (
    <div className="ld">
      {rows.length ? (
        <ul className="ld-tree" aria-label="Who follows whom">
          {rows.map((r, i) => (
            <li key={i} className={r.kind === "list" ? "ld-row is-list" : r.prefix ? "ld-row" : "ld-row is-root"}>
              <span className="ld-pre" aria-hidden>
                {r.prefix}
              </span>
              {r.kind === "person" ? (
                <Person p={r.person} palette={palette} />
              ) : (
                <span className="ld-list">
                  {r.people.map((p, j) => (
                    <span key={p.id} className="ld-li">
                      <Person p={p} compact />
                      {j < r.people.length - 1 ? "," : ""}
                    </span>
                  ))}
                </span>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <Note>{LEADERSHIP_EMPTY}</Note>
      )}
      {loners && <p className="ld-loners">{loners}</p>}
    </div>
  );
}
