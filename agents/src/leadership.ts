// GET /api/leadership: who follows whom among the living, merged across every living agent's view.
//
// Each agent's World keeps the server's FW messages (follower id -> leader id, World.leaders) and
// when the latest report about each follower arrived (World.leaderSeen, also for "follows no one").
// The views disagree when one agent has heard a newer FW than another; the most recently received
// report about a follower wins. Edges to or from someone not alive are dropped, and a cycle (the
// server should never report one) is broken at its least recently reported edge.

import type { Flower, LeadershipEdge, LeadershipPerson, LeadershipResponse } from "./api-types.ts";

/** The part of a World this needs (game/world.ts). */
export interface LeaderView<P extends LeaderPlayer = LeaderPlayer> {
  selfId: number | null;
  dead: boolean;
  players: ReadonlyMap<number, P>;
  names: ReadonlyMap<number, string>;
  lineage: ReadonlyMap<number, { ancestors: number[] }>;
  leaders: ReadonlyMap<number, number>;
  leaderSeen: ReadonlyMap<number, number>;
  currentAge(p: P): number;
}

export interface LeaderPlayer {
  id: number;
  name: string | null;
  female: boolean | null;
  lastSeen: number;
  eveId: number | null;
}

/** Our records about a living player (LifeStore): generation, lifeId and flower, when it is one of ours. */
export interface LeaderLives {
  playerFields(playerId: number): { lifeId: string | null; flower: Flower | null };
  generationOf?(playerId: number): number | null;
}

/**
 * Merge the views' leadership: per follower, the most recently received FW wins (ties: the first
 * view). Keeps edges whose ends both pass `alive`, never a self-follow, and no cycles. Sorted by follower.
 */
export function mergeLeadership(views: Iterable<Pick<LeaderView, "leaders" | "leaderSeen">>, alive: (id: number) => boolean): LeadershipEdge[] {
  const newest = new Map<number, { t: number; leader: number | null }>();
  for (const v of views) {
    const ids = new Set<number>([...v.leaderSeen.keys(), ...v.leaders.keys()]);
    for (const f of ids) {
      const t = v.leaderSeen.get(f) ?? 0;
      const prev = newest.get(f);
      if (prev && prev.t >= t) continue;
      newest.set(f, { t, leader: v.leaders.get(f) ?? null });
    }
  }
  const lead = new Map<number, { t: number; leader: number }>();
  for (const [f, r] of newest) {
    if (r.leader == null || r.leader === f || !alive(f) || !alive(r.leader)) continue;
    lead.set(f, { t: r.t, leader: r.leader });
  }
  // one leader per follower: each walk ends at a root or loops back into itself
  const state = new Map<number, "path" | "done">();
  for (const start of [...lead.keys()]) {
    if (state.has(start)) continue;
    const path: number[] = [];
    let cur: number | undefined = start;
    while (cur !== undefined && !state.has(cur)) {
      state.set(cur, "path");
      path.push(cur);
      cur = lead.get(cur)?.leader;
    }
    if (cur !== undefined && state.get(cur) === "path") {
      const cycle = path.slice(path.indexOf(cur));
      let drop = cycle[0];
      for (const n of cycle) if (lead.get(n)!.t < lead.get(drop)!.t) drop = n;
      lead.delete(drop);
    }
    for (const n of path) state.set(n, "done");
  }
  return [...lead].map(([follower, r]) => ({ follower, leader: r.leader })).sort((a, b) => a.follower - b.follower);
}

/** The surname: the last word of a two-or-more-word name. */
export function familyOf(name: string | null): string | null {
  const w = (name ?? "").trim().split(/\s+/).filter(Boolean);
  return w.length >= 2 ? w[w.length - 1] : null;
}

/**
 * The whole GET /api/leadership body from the living agents' worlds. People: everyone alive any
 * of them can see (themselves included), newest sighting wins, sorted by id.
 */
export function buildLeadership<P extends LeaderPlayer>(runId: string, views: LeaderView<P>[], lives?: LeaderLives | null, now = Date.now()): LeadershipResponse {
  const seen = new Map<number, { p: P; v: LeaderView<P> }>();
  const lineage = new Map<number, { ancestors: number[] }>();
  for (const v of views) {
    for (const [id, l] of v.lineage) lineage.set(id, l);
    for (const p of v.players.values()) {
      if (p.id === v.selfId && v.dead) continue;
      const prev = seen.get(p.id);
      if (!prev || prev.p.lastSeen < p.lastSeen) seen.set(p.id, { p, v });
    }
  }
  const people: LeadershipPerson[] = [...seen.values()]
    .map(({ p, v }) => {
      const name = p.name ?? v.names.get(p.id) ?? null;
      const lin = lineage.get(p.id);
      const gen = lives?.generationOf?.(p.id) ?? null;
      const isEve = lin ? lin.ancestors.length === 0 : gen != null ? gen === 1 : p.eveId === p.id;
      const f = lives?.playerFields(p.id);
      return {
        id: p.id, name, age: Math.round(v.currentAge(p) * 10) / 10, female: p.female, isEve, family: familyOf(name), alive: true,
        lifeId: f?.lifeId ?? null, flower: f?.flower ?? null,
      };
    })
    .sort((a, b) => a.id - b.id);
  const edges = mergeLeadership(views, (id) => seen.has(id));
  return { runId, at: now, edges, people };
}
