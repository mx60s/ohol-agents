// One hook that joins the shared data hooks into what every site page needs:
// lives + lineages + the live world state, with lookups (family names, live ages, agent views).

import { useMemo, useRef } from "react";
import type { AgentView, Flower, LifeRecord, LineageRecord, PlayerView } from "../api-types.ts";
import { flowersForLives } from "../ohol/flower.ts";
import { getClient, useLineages, useLives, useWorldState } from "../data/index.ts";
import { displayName, lineageName, lineageOrder, surnameOf } from "../shared/index.ts";
import { lifeAge, settleStaleLives } from "./logic.ts";

export interface SiteData {
  /** every life of the current run (world), newest born first; all runs when there is no current run */
  lives: LifeRecord[];
  byId: Record<string, LifeRecord>;
  dims: string[];
  lineages: LineageRecord[];
  lineageById: Map<string, LineageRecord>;
  /** lineage ids in founding order: pass as livingLineageIds so a family's look is stable on every page */
  order: string[];
  agentByLife: Map<string, AgentView>;
  playerByLife: Map<string, PlayerView>;
  /** family surname for a lineage id */
  famName: (lineageId: string | null | undefined) => string;
  /** the flower a life wears in its hair (the record's; fixtures/old data: ohol flowersForLives) */
  flowerOf: (lifeId: string) => Flower | null;
  /** best known in-game age (live from /api/state for the living) */
  ageOf: (l: LifeRecord) => number | null;
  /** first load still pending */
  loading: boolean;
  /** lives could not be loaded (and we have none) */
  failed: boolean;
  error: Error | null;
  online: boolean;
  isStatic: boolean;
  serverNow: number | null;
}

export function useSite(): SiteData {
  const lv0 = useLives();
  const lin = useLineages();
  const w = useWorldState();
  // after a world restart, "alive" records of the old run are not alive any more
  const runId = w.state?.run.id ?? null;
  const settled = useMemo(() => {
    const lives = settleStaleLives(lv0.lives, runId);
    return lives === lv0.lives ? { lives, byId: lv0.byId } : { lives, byId: Object.fromEntries(lives.map((l) => [l.lifeId, l])) };
  }, [lv0.lives, lv0.byId, runId]);
  // the site shows the current world only: a new run (world regenerated, fresh start) resets every
  // count, list and family. byId keeps every life, so an old life's own page still opens.
  // Fixtures and snapshots without a matching run keep everything.
  const current = useMemo(() => {
    if (!runId || !settled.lives.some((l) => l.runId === runId)) return settled.lives;
    return settled.lives.filter((l) => l.runId === runId);
  }, [settled.lives, runId]);
  const lv = { ...lv0, ...settled, lives: current };
  const currentLineageIds = useMemo(() => new Set(current.map((l) => l.lineageId)), [current]);
  const allLineages = lin.data?.lineages;
  const lineages = useMemo(() => allLineages?.filter((l) => currentLineageIds.has(l.lineageId)), [allLineages, currentLineageIds]);
  const agents = w.state?.agents;
  const players = w.state?.players;

  // the lineage order only changes when a family is founded; keep the same array otherwise so
  // memoised views keyed on it (the personality cloud's thousands of points) don't rebuild every poll
  const orderRef = useRef<string[]>([]);
  const derived = useMemo(() => {
    const ls = lineages ?? [];
    const lineageById = new Map(ls.map((l) => [l.lineageId, l]));
    const fresh = lineageOrder(ls);
    const order = fresh.join("|") === orderRef.current.join("|") ? orderRef.current : (orderRef.current = fresh);
    const agentByLife = new Map<string, AgentView>();
    for (const a of agents ?? []) if (a.lifeId && a.status === "alive") agentByLife.set(a.lifeId, a);
    const playerByLife = new Map<string, PlayerView>();
    for (const p of players ?? []) if (p.lifeId) playerByLife.set(p.lifeId, p);
    return { lineages: ls, lineageById, order, agentByLife, playerByLife };
  }, [lineages, agents, players]);

  // surname of the first named member, for families whose founder never got a name
  const surnameByLineage = useMemo(() => {
    const m = new Map<string, string>();
    for (const l of [...lv.lives].sort((a, b) => a.bornAt - b.bornAt)) {
      if (m.has(l.lineageId)) continue;
      // "Aurora II Dawn" -> "Dawn"; a lone "Aurora II" has no surname
      const surname = surnameOf(displayName(l.name, ""));
      if (surname) m.set(l.lineageId, surname);
    }
    return m;
  }, [lv.lives]);

  const flowers = useMemo(() => flowersForLives(lv.lives), [lv.lives]);

  return useMemo(() => {
    const { lineageById, agentByLife, playerByLife } = derived;
    const famName = (id: string | null | undefined) => {
      if (!id) return "Unknown";
      const l = lineageById.get(id);
      const founder = l?.eveName ?? lv.byId[id]?.name ?? null;
      // unnamed founder: borrow the surname of the first named member
      if (!displayName(founder, "")) return surnameByLineage.get(id) ?? lineageName({ lineageId: id, eveName: null });
      return lineageName({ lineageId: id, eveName: founder });
    };
    const ageOf = (l: LifeRecord) => {
      if (l.status !== "alive") return lifeAge(l);
      const live = agentByLife.get(l.lifeId)?.age ?? playerByLife.get(l.lifeId)?.age;
      return lifeAge(l, live ?? null);
    };
    const failed = !!lv.error && lv.lives.length === 0;
    return {
      lives: lv.lives,
      byId: lv.byId,
      dims: lv.traitDims,
      ...derived,
      famName,
      flowerOf: (lifeId: string) => flowers.get(lifeId) ?? null,
      ageOf,
      loading: lv.loading && lv.lives.length === 0 && !lv.error,
      failed,
      error: lv.error ?? lin.error ?? null,
      online: w.online,
      isStatic: getClient().isStatic,
      serverNow: lv.now,
    };
  }, [derived, surnameByLineage, flowers, lv.lives, lv.byId, lv.traitDims, lv.loading, lv.error, lv.now, lin.error, w.online]);
}
