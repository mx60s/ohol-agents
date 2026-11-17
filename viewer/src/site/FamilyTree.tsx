// Family tree (top-down, CSS connectors) built from motherLifeId. Real-art portraits; the dead are
// dimmed with a † mark. Nodes with children can be folded; click a person to open their page.

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { LifeRecord } from "../api-types.ts";
import { pageHref } from "../data/index.ts";
import { displayName, firstNameOf, formatAge } from "../shared/index.ts";
import { treeSize, type TreeNode } from "./logic.ts";
import { LifePortrait } from "./ui.tsx";
import type { SiteData } from "./useSite.ts";

type Node = TreeNode<LifeRecord>;

export interface FamilyTreeProps {
  roots: Node[];
  site: SiteData;
  /** the life of the current page: ringed, not a link */
  me?: string | null;
  /** ids folded/unfolded by the user (controlled from outside, e.g. "expand all") */
  folded?: Set<string>;
  onToggle?: (id: string) => void;
  portrait?: number;
  /** full name (else first name only) */
  fullNames?: boolean;
}

/** first name: "Joy Hope" -> "Joy", "Aurora II Hope" -> "Aurora II" */
function firstName(n: string | null): string {
  const d = displayName(n);
  return firstNameOf(d) || d;
}

export function FamilyTree({ roots, site, me, folded, onToggle, portrait = 46, fullNames }: FamilyTreeProps) {
  const render = (n: Node) => {
    const l = n.life;
    const dead = l.status === "dead";
    const isFolded = folded?.has(l.lifeId) ?? false;
    const age = site.ageOf(l);
    const name = fullNames ? displayName(l.name) : firstName(l.name);
    const inner = (
      <>
        <LifePortrait life={l} site={site} size={portrait} round />
        <span className="fn ugc">
          {dead && <span aria-label="died">† </span>}
          {name}
        </span>
        <em>
          {formatAge(age)}
          {l.lifeId === me ? " · this page" : l.status === "alive" ? " · alive" : l.status === "lost" ? " · lost" : ""}
        </em>
      </>
    );
    return (
      <li key={l.lifeId}>
        <div className={`fnode${dead ? " dead" : ""}${l.lifeId === me ? " me" : ""}`}>
          {l.lifeId === me ? (
            <span className="fbody" title={displayName(l.name)}>
              {inner}
            </span>
          ) : (
            <a className="fbody" href={pageHref("agent", { life: l.lifeId })} title={displayName(l.name)}>
              {inner}
            </a>
          )}
          {n.children.length > 0 && onToggle && (
            <button type="button" className="fold" onClick={() => onToggle(l.lifeId)} aria-expanded={!isFolded} title={isFolded ? "Show children" : "Hide children"}>
              {isFolded ? `+${treeSize(n) - 1}` : "−"}
            </button>
          )}
        </div>
        {n.children.length > 0 && !isFolded && <ul>{n.children.map(render)}</ul>}
      </li>
    );
  };
  return (
    <div className="ftree">
      <ul className="root">{roots.map(render)}</ul>
    </div>
  );
}

/** Fold state: everything deeper than `openDepth` starts folded so big families stay readable. */
export function useFolds(roots: Node[], resetKey: string, budget = 40): { folded: Set<string>; toggle: (id: string) => void; expandAll: () => void; collapseAll: () => void } {
  const initial = useMemo(() => {
    // open generations breadth-first while the visible count stays within budget
    const folded = new Set<string>();
    let frontier = roots;
    let shown = roots.length;
    while (frontier.length) {
      const next = frontier.flatMap((n) => n.children);
      if (shown + next.length > budget) {
        for (const n of frontier) if (n.children.length) folded.add(n.life.lifeId);
        break;
      }
      shown += next.length;
      frontier = next;
    }
    return folded;
  }, [roots, budget]);
  // user folds survive data refreshes; they reset when resetKey changes (e.g. another family)
  const [override, setOverride] = useState<{ base: string; folded: Set<string> } | null>(null);
  const folded = override && override.base === resetKey ? override.folded : initial;
  return {
    folded,
    toggle: (id) => {
      const s = new Set(folded);
      if (s.has(id)) s.delete(id);
      else s.add(id);
      setOverride({ base: resetKey, folded: s });
    },
    expandAll: () => setOverride({ base: resetKey, folded: new Set() }),
    collapseAll: () => setOverride({ base: resetKey, folded: new Set(roots.flatMap((r) => (r.children.length ? [r.life.lifeId] : []))) }),
  };
}

/** Scroll box for a tree that starts centred on the root (wide trees overflow both ways). */
export function TreeScroll({ children, className, resetKey }: { children: ReactNode; className?: string; resetKey: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // wait a frame so the layout (and the lazy portrait boxes) exist
    const id = requestAnimationFrame(() => {
      el.scrollLeft = Math.max(0, (el.scrollWidth - el.clientWidth) / 2);
    });
    return () => cancelAnimationFrame(id);
  }, [resetKey]);
  return (
    <div ref={ref} className={`tree-scroll ${className ?? ""}`}>
      {children}
    </div>
  );
}
