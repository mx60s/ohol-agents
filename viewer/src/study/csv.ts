// "Download CSV": every life with traits, activity, roles and outcomes. Built client-side.

import type { LifeActivity, LifeRecord } from "../api-types.ts";
import { adultOutcome, observedAge, ROLES, roleShares } from "./analysis.ts";

const ACTIVITY: (keyof LifeActivity)[] = [
  "thoughts", "actions", "failedActions", "moves", "tilesWalked", "maxDistFromBirth", "forage", "reflexForage", "eat",
  "pickUp", "drop", "craft", "wear", "babyPickups", "feeds", "says", "saysHeard",
];

function cell(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  const s = String(v);
  // quote, and defuse spreadsheet formulas (=, +, -, @ at the start of a text cell)
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) || safe !== s ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function livesCsv(lives: readonly LifeRecord[], dims: readonly string[], now: number): string {
  const head = [
    "lifeId", "runId", "agentId", "lineageId", "motherLifeId", "generation", "female", "name", "status", "bornAt", "diedAt", "lostAt",
    "ageAtBirth", "ageAtDeath", "observedAge", "censored", "reachedAdult", "deathReason", "children", "traitSource", "inherited",
    ...dims.map((d) => `trait_${d}`), ...ACTIVITY.map((k) => `act_${k}`), ...ROLES.map((r) => `share_${r}`),
  ];
  const rows = lives.map((l) => {
    const o = observedAge(l, now);
    const sh = roleShares(l.activity);
    return [
      l.lifeId, l.runId, l.agentId, l.lineageId, l.motherLifeId, l.generation, l.female, l.name, l.status, l.bornAt, l.diedAt, l.lostAt,
      l.ageAtBirth, l.ageAtDeath, +o.age.toFixed(3), !o.event, adultOutcome(l, now), l.deathReason, l.childLifeIds.length, l.traitSource, l.inherited,
      ...dims.map((d) => l.traits?.[d]), ...ACTIVITY.map((k) => l.activity[k]), ...ROLES.map((_, i) => (sh ? +sh[i].toFixed(4) : null)),
    ].map(cell);
  });
  return [head.map(cell), ...rows].map((r) => r.join(",")).join("\n") + "\n";
}

export function downloadText(filename: string, text: string, type = "text/csv;charset=utf-8"): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
