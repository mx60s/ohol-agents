// One hook that joins the shared data hooks into what every site page needs:
// lives + lineages + the live world state, with lookups (family names, live ages, agent views).

import { useMemo } from "react";
import type { AgentView, LifeRecord, LineageRecord, PlayerView } from "../api-types.ts";
import { getClient, useLineages, useLives, useWorldState } from "../data/index.ts";
import { displayName, lineageName, lineageOrder } from "../shared/index.ts";
import { lifeAge } from "./logic.ts";

export interface SiteData {
  /** every life, newest born first */
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
  const lv = useLives();
  const lin = useLineages();
  const w = useWorldState();
  const lineages = lin.data?.lineages;
  const agents = w.state?.agents;
  const players = w.state?.players;

  const derived = useMemo(() => {
    const ls = lineages ?? [];
    const lineageById = new Map(ls.map((l) => [l.lineageId, l]));
    const order = lineageOrder(ls);
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
      const parts = displayName(l.name, "").split(/\s+/).filter(Boolean);
      if (parts.length >= 2) m.set(l.lineageId, parts[parts.length - 1]);
    }
    return m;
  }, [lv.lives]);

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
      ageOf,
      loading: lv.loading && lv.lives.length === 0 && !lv.error,
      failed,
      error: lv.error ?? lin.error ?? null,
      online: w.online,
      isStatic: getClient().isStatic,
      serverNow: lv.now,
    };
  }, [derived, surnameByLineage, lv.lives, lv.byId, lv.traitDims, lv.loading, lv.error, lv.now, lin.error, w.online]);
}
