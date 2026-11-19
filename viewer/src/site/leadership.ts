// Leadership (families page): pure helpers, no React, so node --test can import them.
// GET /api/leadership -> chains of command as an indented tree, flattened to rows with
// box-drawing prefixes ("├── ", "│   ", "└── ").
import type { LeadershipPerson, LeadershipResponse } from "../api-types.ts";

export const LEADERSHIP_EMPTY = 'Nobody leads anyone yet. People become followers by saying "I FOLLOW YOU".';

/** a leader with this many direct followers lists the ones who lead nobody as one comma list */
export const COMPACT_AT = 10;

export interface LeaderNode {
  person: LeadershipPerson;
  children: LeaderNode[];
  /** everyone under this person, at any depth */
  size: number;
}

export interface LeadershipTree {
  roots: LeaderNode[];
  /** living people who neither lead nor follow */
  unattached: number;
}

const byName = (a: LeadershipPerson, b: LeadershipPerson) => (a.name ?? "￿").localeCompare(b.name ?? "￿") || a.id - b.id;
const order = (a: LeaderNode, b: LeaderNode) => b.size - a.size || byName(a.person, b.person);

/**
 * Roots are people who lead someone and follow nobody. Biggest group first, then by name.
 * Cycle-safe: everyone appears once; a loop with no root gets one (its lowest id), which is
 * then treated as following nobody.
 */
export function buildLeadershipTree(r: LeadershipResponse | null): LeadershipTree {
  const people = new Map<number, LeadershipPerson>();
  for (const p of r?.people ?? []) if (p.alive !== false && !people.has(p.id)) people.set(p.id, p);
  const leaderOf = new Map<number, number>();
  for (const e of r?.edges ?? []) if (e.follower !== e.leader && people.has(e.follower) && people.has(e.leader)) leaderOf.set(e.follower, e.leader);
  const followers = new Map<number, number[]>();
  for (const [f, l] of leaderOf) followers.set(l, [...(followers.get(l) ?? []), f]);

  const placed = new Set<number>();
  const build = (id: number): LeaderNode | null => {
    if (placed.has(id)) return null;
    placed.add(id);
    const children = (followers.get(id) ?? []).map(build).filter((n): n is LeaderNode => n !== null).sort(order);
    return { person: people.get(id)!, children, size: children.reduce((s, c) => s + 1 + c.size, 0) };
  };
  const roots: LeaderNode[] = [];
  for (const id of followers.keys()) if (!leaderOf.has(id)) roots.push(build(id)!);
  // what's left sits on a loop (or under one): root each loop at its lowest id
  const left = [...leaderOf.keys()].filter((id) => !placed.has(id)).sort((a, b) => a - b);
  for (const start of left) {
    if (placed.has(start)) continue;
    const walk: number[] = [];
    let cur = start;
    while (!walk.includes(cur)) {
      walk.push(cur);
      cur = leaderOf.get(cur)!;
    }
    const loop = walk.slice(walk.indexOf(cur));
    const n = build(Math.min(...loop));
    if (n) roots.push(n);
  }
  roots.sort(order);
  let unattached = 0;
  for (const id of people.keys()) if (!leaderOf.has(id) && !followers.has(id)) unattached++;
  return { roots, unattached };
}

export type LeaderRow =
  | { kind: "person"; prefix: string; person: LeadershipPerson; followers: number }
  /** the followers of a big group who lead nobody, as one wrapping list */
  | { kind: "list"; prefix: string; people: LeadershipPerson[] };

/** The tree as display rows, depth first, with the box-drawing prefix for each line. */
export function leadershipRows(roots: LeaderNode[]): LeaderRow[] {
  const rows: LeaderRow[] = [];
  const walk = (n: LeaderNode, line: string, below: string) => {
    rows.push({ kind: "person", prefix: line, person: n.person, followers: n.children.length });
    const compact = n.children.length >= COMPACT_AT;
    const nested = compact ? n.children.filter((c) => c.children.length) : n.children;
    const listed = compact ? n.children.filter((c) => !c.children.length).map((c) => c.person) : [];
    const items = nested.length + (listed.length ? 1 : 0);
    nested.forEach((c, i) => {
      const last = i === items - 1;
      walk(c, below + (last ? "└── " : "├── "), below + (last ? "    " : "│   "));
    });
    if (listed.length) rows.push({ kind: "list", prefix: below + "└── ", people: listed });
  };
  for (const r of roots) walk(r, "", "");
  return rows;
}

/** "3 people follow no one" / "1 person follows no one"; "" for none. */
export function unattachedLine(n: number): string {
  return n <= 0 ? "" : n === 1 ? "1 person follows no one" : `${n} people follow no one`;
}
