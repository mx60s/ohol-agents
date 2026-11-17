// Deterministic SYNTHETIC lives for checking the study page and its statistics at realistic n.
// ?fixture=synthetic&n=400[&seed=1][&null=1]. Pure (no DOM); tests/study.test.mjs uses it to check
// that planted effects are detected and null traits are not.
//
// Model (OHOL timing: one game year per real minute):
// - Eves appear every EVE_EVERY_MIN minutes at age 14 with traits ~ N(0,1) clipped to +-2.5.
// - A child's traits = mother's + N(0, 0.15) per dim, clipped (as the agents service does).
// - Each lineage has a shared environment u ~ N(0, 0.6) ("camp quality"), so outcomes are
//   correlated within families, as in the real game.
// - Reaching 14: P = logistic(0.4 + u + SURVIVAL_BETA * z[survival]). Children who don't make it die
//   at 14 * u^1.5; adults die at 14 + 46 * u^0.7 (some reach 60).
// - Births: an adult woman has Poisson(2.6 * exp(u / 2 + FERTILITY_BETA * z[fertility])) children between
//   14 and 40 (only those before her death and before "now" happen).
// - Roles: each role event draws from softmax(base + per-life noise + SOCIAL_BETA * z[social] on
//   socialising + CARE_BETA * z[care] on caregiving); caregiving is rare unless she has children.
// - The last dim is a planted null: it affects nothing.
// "now" = just after the n-th birth; lives still going then are alive (10% of them "lost").

import type { LifeActivity, LifeRecord, LineageRecord, Traits } from "../api-types.ts";
import { gauss, rng, type Rng } from "./stats.ts";
import { ADULT_AGE, LIFESPAN_YEARS, YEAR_MS } from "./analysis.ts";

/** deliberately NOT the Big Five: the page must work with whatever dims the data has */
export const SYNTH_DIMS = ["curiosity", "diligence", "sociability", "warmth", "anxiety"];

export interface SynthEffects {
  survival: number;
  fertility: number;
  social: number;
  care: number;
}
export const PLANTED: SynthEffects = { survival: 1.0, fertility: 0.5, social: 0.45, care: 0.9 };
export const NO_EFFECTS: SynthEffects = { survival: 0, fertility: 0, social: 0, care: 0 };
/** which dim index carries which effect; the last dim is always null */
export const EFFECT_DIM = { survival: 0, fertility: 1, social: 2, care: 3 } as const;

export interface SynthOptions {
  n: number;
  seed?: number;
  dims?: string[];
  effects?: SynthEffects;
  mutationSd?: number;
}

export interface SynthData {
  lives: LifeRecord[];
  lineages: LineageRecord[];
  traitDims: string[];
  now: number;
  startedAt: number;
}

const EVE_EVERY_MIN = 9;
/** SD of a lineage-wide 'camp quality' effect on survival (logit) and, halved, fertility (log rate) */
const FAMILY_SD = 0.6;
const T0 = Date.UTC(2026, 10, 1, 12, 0, 0);
const RUN_MS = 3 * 60 * YEAR_MS;
const FIRST = ["ADA", "BEN", "CORA", "DAN", "EDIE", "FINN", "GWEN", "HAL", "IRIS", "JUDE", "KIT", "LENA", "MILO", "NELL", "OTIS", "PIA", "QUIN", "ROSA", "SAUL", "TESS", "URI", "VERA", "WREN", "YARA", "ZEKE"];
const SURNAMES = ["HOPE", "ASHGROVE", "MOSS", "KETTLE", "DAWN", "FERN", "STONE", "BRIAR", "LARK", "MARSH", "THORN", "WILLOW", "CROW", "HOLLOW", "REED", "FINCH"];

const clip = (v: number) => Math.max(-2.5, Math.min(2.5, v));
const logistic = (x: number) => 1 / (1 + Math.exp(-x));

function poisson(r: Rng, lambda: number): number {
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= r();
  } while (p > L && k < 50);
  return k - 1;
}

interface Pending {
  t: number;
  mother: Draft | null;
  seq: number;
}

interface Draft {
  idx: number;
  playerId: number;
  z: number[];
  female: boolean;
  generation: number;
  bornAt: number;
  startAge: number;
  deathAge: number;
  diesAt: number;
  mother: Draft | null;
  lineage: Draft;
  surname: string;
  first: string;
  children: Draft[];
  planned: number;
  /** family environment (camp quality), shared by a whole lineage */
  env: number;
}

export function generateSynthetic(opts: SynthOptions): SynthData {
  const n = Math.max(0, Math.floor(opts.n));
  const dims = opts.dims ?? SYNTH_DIMS;
  const eff = opts.effects ?? PLANTED;
  const mut = opts.mutationSd ?? 0.15;
  const R = rng((opts.seed ?? 1) * 7919 + 13);
  const zi = (k: number) => Math.min(k, dims.length - 1);
  const nullDim = dims.length - 1;
  const z = (d: Draft, k: number) => (k >= nullDim ? 0 : d.z[zi(k)]);

  const drafts: Draft[] = [];
  const queue: Pending[] = [];
  let seq = 0;
  let nextEve = T0;
  let eves = 0;
  const push = (p: Pending) => {
    queue.push(p);
    queue.sort((a, b) => a.t - b.t || a.seq - b.seq);
  };

  while (drafts.length < n) {
    if (!queue.length || nextEve <= queue[0].t) {
      push({ t: nextEve, mother: null, seq: seq++ });
      nextEve += EVE_EVERY_MIN * YEAR_MS;
      continue;
    }
    const p = queue.shift()!;
    const m = p.mother;
    const zz = m ? m.z.map((v) => clip(v + mut * gauss(R))) : dims.map(() => clip(gauss(R)));
    const startAge = m ? 0 : ADULT_AGE;
    const surname = m ? m.surname : SURNAMES[eves++ % SURNAMES.length];
    const d: Draft = {
      idx: drafts.length,
      playerId: drafts.length + 1,
      z: zz,
      female: m ? R() < 0.5 : true,
      generation: m ? m.generation + 1 : 1,
      bornAt: p.t,
      startAge,
      deathAge: 0,
      diesAt: 0,
      mother: m,
      lineage: null as unknown as Draft,
      surname,
      first: m ? FIRST[Math.floor(R() * FIRST.length)] : "EVE",
      children: [],
      planned: 0,
      env: 0,
    };
    d.lineage = m ? m.lineage : d;
    d.env = m ? m.env : FAMILY_SD * gauss(R);
    if (m) m.children.push(d);
    // survival
    const adult = startAge >= ADULT_AGE || R() < logistic(0.4 + d.env + eff.survival * z(d, EFFECT_DIM.survival));
    d.deathAge = adult ? Math.min(LIFESPAN_YEARS, ADULT_AGE + 46 * R() ** 0.7) : Math.max(0.2, ADULT_AGE * R() ** 1.5);
    d.diesAt = d.bornAt + (d.deathAge - startAge) * YEAR_MS;
    // births
    if (adult && d.female) {
      const k = poisson(R, 2.6 * Math.exp(0.5 * d.env + eff.fertility * z(d, EFFECT_DIM.fertility)));
      const ages = Array.from({ length: k }, () => ADULT_AGE + 26 * R())
        .filter((a) => a < d.deathAge)
        .sort((a, b) => a - b);
      d.planned = ages.length;
      for (const a of ages) push({ t: d.bornAt + (a - startAge) * YEAR_MS, mother: d, seq: seq++ });
    }
    drafts.push(d);
  }

  const now = (drafts.length ? drafts[drafts.length - 1].bornAt : T0) + 30_000;
  const id = (d: Draft) => `syn-r${Math.floor((d.lineage.bornAt - T0) / RUN_MS) + 1}:${d.playerId}`;
  const lives: LifeRecord[] = drafts.map((d) => {
    const dead = d.diesAt <= now;
    const lost = !dead && R() < 0.1;
    const lostAt = lost ? Math.max(d.bornAt + 1000, now - R() * 10 * YEAR_MS) : null;
    const endT = dead ? d.diesAt : (lostAt ?? now);
    const minutes = Math.max(0, (endT - d.bornAt) / YEAR_MS);
    const kids = d.children.filter((c) => c.bornAt <= now);
    const traits: Traits = {};
    dims.forEach((k, i) => (traits[k] = +d.z[i].toFixed(4)));
    return {
      lifeId: id(d),
      runId: id(d).split(":")[0],
      agentId: `a${String((d.idx % 12) + 1).padStart(2, "0")}`,
      lifeIndex: null,
      playerId: d.playerId,
      name: `${d.first} ${d.surname}`,
      female: d.female,
      displayId: null,
      lineageId: id(d.lineage),
      motherLifeId: d.mother ? id(d.mother) : null,
      motherPlayerId: d.mother ? d.mother.playerId : null,
      generation: d.generation,
      traits,
      inherited: !!d.mother,
      traitSource: "mock",
      bornAt: d.bornAt,
      ageAtBirth: d.startAge === 0 ? 0.01 : d.startAge + 0.01,
      birthX: null,
      birthY: null,
      diedAt: dead ? Math.round(d.diesAt) : null,
      ageAtDeath: dead ? +d.deathAge.toFixed(2) : null,
      deathReason: dead ? (d.deathAge >= LIFESPAN_YEARS - 0.01 ? "age" : R() < 0.7 ? "hunger" : "cold") : null,
      lostAt: lostAt != null ? Math.round(lostAt) : null,
      presumedEndAt: lost ? d.bornAt + (LIFESPAN_YEARS - d.startAge) * YEAR_MS : null,
      status: dead ? "dead" : lost ? "lost" : "alive",
      childLifeIds: kids.map(id),
      activity: activityFor(R, d, minutes, kids.length, eff, z),
      updatedAt: Math.round(Math.min(now, endT)),
    };
  });
  return { lives, lineages: lineagesOf(lives, dims, now), traitDims: dims, now, startedAt: T0 };
}

function activityFor(R: Rng, d: Draft, minutes: number, kids: number, eff: SynthEffects, z: (d: Draft, k: number) => number): LifeActivity {
  // babies (< 3) barely act; about 3 role events per game year after that
  const activeYears = Math.max(0, d.startAge + minutes - Math.max(d.startAge, 3));
  const E = Math.round(activeYears * (2.5 + R()));
  const caring = d.female && kids > 0;
  const logits = [0.2, 0.6, 0.1, caring ? -0.6 : -3, -0.1].map((b) => b + 0.25 * gauss(R));
  logits[4] += eff.social * z(d, EFFECT_DIM.social);
  logits[3] += eff.care * z(d, EFFECT_DIM.care);
  const mx = Math.max(...logits);
  const w = logits.map((l) => Math.exp(l - mx));
  const tot = w.reduce((s, v) => s + v, 0);
  const c = [0, 0, 0, 0, 0];
  for (let i = 0; i < E; i++) {
    let u = R() * tot;
    let k = 0;
    while (k < 4 && u >= w[k]) u -= w[k++];
    c[k]++;
  }
  const split = (v: number, f: number) => {
    let a = 0;
    for (let i = 0; i < v; i++) if (R() < f) a++;
    return [a, v - a];
  };
  const [forage, pickUp] = split(c[1], 0.65);
  const reflexForage = Math.round(R() * 3);
  const [craft, rest] = split(c[2], 0.6);
  const [drop, wear] = split(rest, 0.75);
  const [babyPickups, feeds] = split(c[3], 0.6);
  const says = c[4];
  const actions = c[0] + forage + reflexForage + pickUp + craft + drop + wear + babyPickups + feeds;
  return {
    thoughts: actions + says,
    actions,
    failedActions: Math.round(actions * 0.1),
    moves: c[0],
    tilesWalked: c[0] * 4,
    maxDistFromBirth: Math.round(Math.sqrt(c[0]) * 6),
    forage: forage + reflexForage,
    reflexForage,
    eat: Math.round((forage + reflexForage) * 0.6),
    pickUp,
    drop,
    craft,
    wear,
    babyPickups,
    feeds,
    says,
    saysHeard: Math.round(says * 0.7),
  };
}

function lineagesOf(lives: LifeRecord[], dims: string[], now: number): LineageRecord[] {
  const by = new Map<string, LifeRecord[]>();
  for (const l of lives) by.set(l.lineageId, [...(by.get(l.lineageId) ?? []), l]);
  return [...by.entries()]
    .map(([lineageId, ms]) => {
      const eve = ms.find((m) => m.lifeId === lineageId) ?? ms[0];
      const living = ms.filter((m) => m.status === "alive" || (m.status === "lost" && (m.presumedEndAt ?? 0) > now));
      const meanTraits: Traits = {};
      for (const d of dims) meanTraits[d] = ms.reduce((s, m) => s + (m.traits?.[d] ?? 0), 0) / ms.length;
      return {
        lineageId,
        eveLifeId: eve.lifeId,
        eveName: eve.name,
        founderIsEve: true,
        foundedAt: eve.bornAt,
        extinctAt: living.length ? null : Math.max(...ms.map((m) => m.diedAt ?? m.presumedEndAt ?? m.bornAt)),
        living: living.length,
        livingLifeIds: living.map((m) => m.lifeId),
        totalLives: ms.length,
        maxGeneration: Math.max(...ms.map((m) => m.generation)),
        meanTraits,
      };
    })
    .sort((a, b) => b.foundedAt - a.foundedAt);
}
