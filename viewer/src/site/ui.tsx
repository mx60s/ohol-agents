// Small site UI pieces: segmented controls, empty/offline notes, lazy real-art portraits, pager.
// All agent text renders as React text (escaped). Never inject raw HTML.

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { LifeRecord } from "../api-types.ts";
import { displayName, PersonalityTag, PersonFigure, PersonPortrait } from "../shared/index.ts";
import type { SiteData } from "./useSite.ts";

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

// ------------------------------------------------------------------ segmented control

export interface SegOption<K extends string> {
  key: K;
  label: ReactNode;
  title?: string;
}

export function Seg<K extends string>({ options, value, onChange, label, className }: { options: SegOption<K>[]; value: K; onChange: (k: K) => void; label: string; className?: string }) {
  return (
    <div className={cx("seg2", className)} role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.key} type="button" className={o.key === value ? "on" : undefined} aria-pressed={o.key === value} title={o.title} onClick={() => onChange(o.key)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ notes

/** Empty / loading / offline message inside a panel. */
export function Note({ children, tone }: { children: ReactNode; tone?: "empty" | "error" }) {
  return <p className={cx("site-note", tone === "error" && "is-error")}>{children}</p>;
}

/** Standard empty state for a panel fed by lives. */
export function LivesState({ site, empty }: { site: SiteData; empty: ReactNode }) {
  if (site.loading) return <Note>Loading…</Note>;
  if (site.failed) return <Note tone="error">Can't reach the world right now. This page will fill in when it's back.</Note>;
  return <Note>{empty}</Note>;
}

// ------------------------------------------------------------------ portraits

/** Mount children only once the box scrolls near the viewport (keeps 500-row tables fast). */
export function Lazy({ width, height, children, className, style }: { width: number; height: number; children: ReactNode; className?: string; style?: CSSProperties }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return;
    if (typeof IntersectionObserver === "undefined") {
      setSeen(true);
      return;
    }
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && setSeen(true), { rootMargin: "2000px" });
    io.observe(el);
    return () => io.disconnect();
  }, [seen]);
  return (
    <span ref={ref} className={className} style={{ width, height, display: "inline-block", flex: "none", ...style }}>
      {seen ? children : null}
    </span>
  );
}

export interface LifeArtProps {
  life: LifeRecord;
  site: SiteData;
  size: number;
  /** override the age (e.g. at death) */
  age?: number | null;
  /** round avatar frame instead of the square card frame */
  round?: boolean;
  /** skip the lazy wrapper (above-the-fold art) */
  eager?: boolean;
  className?: string;
}

function artProps(p: LifeArtProps) {
  const { life, site } = p;
  return {
    displayId: life.displayId,
    age: p.age !== undefined ? p.age : site.ageOf(life),
    female: life.female,
    lineageId: life.lineageId,
    livingLineageIds: site.order,
    traits: life.traits,
    traitDims: site.dims,
    lifeId: life.lifeId,
    flower: site.flowerOf(life.lifeId),
    dead: life.status === "dead",
    title: displayName(life.name),
  };
}

/** Head-and-shoulders real-art portrait in a frame. */
export function LifePortrait(p: LifeArtProps) {
  const dead = p.life.status === "dead";
  const art = <PersonPortrait {...artProps(p)} size={p.size} />;
  return (
    <span className={cx("portrait-frame portrait-well", p.round && "round", dead && "is-dead", p.className)} style={{ width: p.size + 3, height: p.size + 3 }}>
      {p.eager ? art : <Lazy width={p.size} height={p.size}>{art}</Lazy>}
    </span>
  );
}

/** Whole-body real-art figure at natural scale (babies small). */
export function LifeFigure(p: LifeArtProps) {
  return <PersonFigure {...artProps(p)} size={p.size} />;
}

// ------------------------------------------------------------------ pager

export function Pager({ page, pages, onPage, total, size }: { page: number; pages: number; onPage: (p: number) => void; total?: number; size?: number }) {
  if (pages <= 1) return null;
  const from = size != null ? page * size + 1 : null;
  const to = size != null && total != null ? Math.min(total, (page + 1) * size) : null;
  return (
    <div className="pager">
      <button type="button" className="btn is-ghost sm" disabled={page <= 0} onClick={() => onPage(page - 1)}>
        ← Prev
      </button>
      <span className="mono">{from != null && to != null && total != null ? `${from}–${to} of ${total}` : `${page + 1} / ${pages}`}</span>
      <button type="button" className="btn is-ghost sm" disabled={page >= pages - 1} onClick={() => onPage(page + 1)}>
        Next →
      </button>
    </div>
  );
}

// ------------------------------------------------------------------ misc

export function Sex({ female }: { female: boolean | null | undefined }) {
  if (female == null) return null;
  return (
    <span className="sex" aria-label={female ? "female" : "male"} title={female ? "female" : "male"}>
      {female ? "♀" : "♂"}
    </span>
  );
}

/** Sortable table header cell. */
export function SortTh<K extends string>({ k, sort, dir, onSort, children, className, title }: { k: K; sort: K; dir: "asc" | "desc"; onSort: (k: K) => void; children: ReactNode; className?: string; title?: string }) {
  const on = k === sort;
  return (
    <th className={cx("sortable", on && "on", className)} aria-sort={on ? (dir === "asc" ? "ascending" : "descending") : "none"} title={title}>
      <button type="button" onClick={() => onSort(k)}>
        {children}
        <span className="arr" aria-hidden>
          {on ? (dir === "asc" ? "▲" : "▼") : "↕"}
        </span>
      </button>
    </th>
  );
}

// ------------------------------------------------------------------ personalities

/**
 * Legend for the run's prompted family personalities (PERSONALITIES): each descriptor with the
 * families that carry it. Nothing when the run has none.
 */
export function PersonalityLegend({ site }: { site: SiteData }) {
  const list = site.personalities;
  if (!list?.length) return null;
  return (
    <div className="persona-legend" aria-label="Family personalities">
      <span className="lg-k" title="Each Eve's family gets one descriptor, in founding order; her descendants inherit it in their system prompt">
        Family personalities
      </span>
      {list.map((d) => {
        const fams = site.lineages.filter((l) => site.personalityOf(l.lineageId) === d).map((l) => site.famName(l.lineageId));
        return (
          <span key={d} className="lg-item">
            <PersonalityTag personality={d} palette={list} />
            <span className="lg-fams ugc">{fams.length ? fams.join(", ") : "no family yet"}</span>
          </span>
        );
      })}
    </div>
  );
}
