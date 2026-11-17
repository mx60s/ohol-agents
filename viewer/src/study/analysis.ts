// Study definitions + per-question analyses over LifeRecords. Pure (no React); tested in tests/study.test.mjs.
// Trait names always come from the data (traitDims); nothing here knows them.

import type { LifeActivity, LifeRecord } from "../api-types.ts";
import {
  benjaminiHochberg,
  clusterPermCorr,
  clusterPermSpearman,
  finite,
  kaplanMeier,
  kmClusterBands,
  martingaleResiduals,
  mean,
  median,
  minDetectableR,
  ols,
  olsClustered,
  roleConcentration,
  sem,
  terciles,
  wilson,
  type ClusteredSlope,
  type ClusterPermResult,
  type KmStep,
  type OlsFit,
  type PermOptions,
  type ShuffleGini,
  type SurvSpell,
} from "./stats.ts";

// ------------------------------------------------------------------ constants

/** stock OHOL: one game year per real minute (TIME_SCALE 1) */
export const BASE_YEAR_MS = 60_000;
/** @deprecated stock year only; use yearMs(life), since runs can slow the game clock (TIME_SCALE) */
export const YEAR_MS = BASE_YEAR_MS;

/** game clock slowdown k of a life (LifeRecord.timeScale); missing / invalid = 1 (records before it existed) */
export function timeScaleOf(l: Pick<LifeRecord, "timeScale">): number {
  const k = l.timeScale;
  return typeof k === "number" && Number.isFinite(k) && k > 0 ? k : 1;
}

/** wall ms per game year of this life: 60 s x its timeScale */
export function yearMs(l: Pick<LifeRecord, "timeScale">): number {
  return BASE_YEAR_MS * timeScaleOf(l);
}

/** shortest game year among these lives (stock if none): how often ages can change by a year */
export function shortestYearMs(lives: readonly Pick<LifeRecord, "timeScale">[]): number {
  let m = Infinity;
  for (const l of lives) m = Math.min(m, yearMs(l));
  return Number.isFinite(m) ? m : BASE_YEAR_MS;
}
/** OHOL adulthood (fertile, can raise children) */
export const ADULT_AGE = 14;
/** OHOL old-age death */
export const LIFESPAN_YEARS = 60;
/** OHOL: women can have babies from ADULT_AGE until this age */
export const FERTILE_END = 40;
/** Q3: only lives with at least this many actions get role shares */
export const MIN_ACTIONS = 30;
/** default maximum permutations for a family-aware p (see permBudget for the page) */
export const PERMUTATIONS = 2000;
/** sequential stopping: a test stops permuting once this many permutations are as extreme as observed */
export const STOP_AFTER = 50;
/** trait-effect tests per trait on the page: reaching 14, survival, children, descendants + one per role */
export const TESTS_PER_TRAIT = 4 + 5;
/**
 * Max permutations per test so that BH over m tests can still reach q < .05: the smallest p is
 * 1 / (B + 1), and one lone effect passes BH only if p <= .05 / m, so B >= 20 m (here 40 m).
 */
export function permBudget(dims: number): number {
  return Math.max(PERMUTATIONS, 40 * TESTS_PER_TRAIT * Math.max(1, dims));
}
/** fitted lines need at least this many points (with 3, the 95% band uses t on 1 df and fills any plot) */
export const MIN_FIT_N = 5;
/** cluster-robust SEs need at least this many clusters (with 2 the sandwich collapses to 0) */
export const MIN_CLUSTERS = 5;

const olsMin = (xs: number[], ys: number[]) => (xs.length >= MIN_FIT_N ? ols(xs, ys) : null);

/** permutations per cell of the Q3 trait x role matrix */
export const MATRIX_PERMUTATIONS = 1000;
/** shuffles for the role-concentration null */
export const ROLE_SHUFFLES = 1000;
/** below this many lives with a known outcome the banner says nothing could be significant */
export const MIN_N_FOR_CLAIMS = 30;

// ------------------------------------------------------------------ ages & censoring

/** age at the start of the life: recorded, else 14 for a first-generation Eve, else 0 */
export function startAge(l: LifeRecord): number {
  return finite(l.ageAtBirth) ? l.ageAtBirth : l.generation === 1 && !l.inherited ? ADULT_AGE : 0;
}

/** game age at wall-clock time t, from birth time (capped to the 60-year lifespan) */
export function ageAt(l: LifeRecord, t: number): number {
  return Math.min(LIFESPAN_YEARS, Math.max(0, startAge(l) + (t - l.bornAt) / yearMs(l)));
}

/**
 * Last age we actually observed: age at death (dead), at lostAt (lost), or now (alive).
 * `event` false = right-censored (alive, or lost and never seen dying).
 */
export function observedAge(l: LifeRecord, now: number): { age: number; event: boolean } {
  if (l.status === "dead") return { age: finite(l.ageAtDeath) ? l.ageAtDeath : ageAt(l, l.diedAt ?? now), event: true };
  if (l.status === "lost") return { age: ageAt(l, l.lostAt ?? now), event: false };
  return { age: ageAt(l, now), event: false };
}

export type AdultOutcome = "yes" | "no" | "too-young" | "lost" | "born-adult";
/**
 * Did this life reach ADULT_AGE? Only lives born at least 14 game-years before `now` count (a complete
 * birth cohort): otherwise the early deaths of recent births would be counted while their surviving
 * siblings are not, biasing the share down. "born-adult" = started at >= 14 (Eves): no chance to fail.
 * "too-young" = born under 14 game-years ago (whether alive or already dead). "lost" = lost before 14,
 * never seen dying. Only "yes" and "no" are used.
 */
export function adultOutcome(l: LifeRecord, now: number): AdultOutcome {
  const a0 = startAge(l);
  if (a0 >= ADULT_AGE) return "born-adult";
  if (a0 + (now - l.bornAt) / yearMs(l) < ADULT_AGE) return "too-young";
  const o = observedAge(l, now);
  if (o.age >= ADULT_AGE) return "yes";
  return o.event ? "no" : "lost";
}

/** the survival spell of a life (age scale, delayed entry for lives that start as adults) */
export function spellOf(l: LifeRecord, now: number): SurvSpell {
  const o = observedAge(l, now);
  return { entry: startAge(l), exit: o.age, event: o.event };
}

// ------------------------------------------------------------------ roles

export const ROLES = ["exploring", "foraging", "crafting", "caregiving", "socialising"] as const;
export type Role = (typeof ROLES)[number];

/**
 * Role event counts from LifeActivity (groups as documented in api-types), counting events only
 * and avoiding double counts:
 *   exploring   = moves                       (tilesWalked / maxDistFromBirth are distances, not events)
 *   foraging    = forage - reflexForage + pickUp   (reflex forages are forced, not chosen; eat overlaps forage)
 *   crafting    = craft + drop + wear
 *   caregiving  = babyPickups + feeds
 *   socialising = says                        (saysHeard is a subset of says)
 */
export function roleCounts(a: LifeActivity): number[] {
  const nn = (v: number) => (finite(v) && v > 0 ? Math.round(v) : 0);
  return [
    nn(a.moves),
    Math.max(0, nn(a.forage) - nn(a.reflexForage)) + nn(a.pickUp),
    nn(a.craft) + nn(a.drop) + nn(a.wear),
    nn(a.babyPickups) + nn(a.feeds),
    nn(a.says),
  ];
}

/** share of each role in the life's role events; null if it has none */
export function roleShares(a: LifeActivity): number[] | null {
  const c = roleCounts(a);
  const t = c.reduce((s, v) => s + v, 0);
  return t > 0 ? c.map((v) => v / t) : null;
}

/**
 * Trait values are ~N(0,1) clipped to +-2.5; anything beyond MAX_ABS_TRAIT is a data error
 * (e.g. 1e300 in the edge fixture) and is treated as missing. Counted in dataWindow().outOfRange.
 */
export const MAX_ABS_TRAIT = 10;

export const traitOf = (l: LifeRecord, dim: string): number | null => {
  const v = l.traits?.[dim];
  return finite(v) && Math.abs(v) <= MAX_ABS_TRAIT ? v : null;
};

// ------------------------------------------------------------------ study inclusion

/**
 * false = keep out of every analysis: the backend flagged the life (validForStudy false), e.g. it was
 * alive while the LLM provider was down and the run paused (outage true), so it couldn't think for
 * part of its life. Records without the flags are valid.
 */
export function inStudy(l: Pick<LifeRecord, "validForStudy" | "outage">): boolean {
  return l.validForStudy !== false && l.outage !== true;
}

/** split lives into those the analyses use and those excluded (see inStudy) */
export function studyLives<L extends Pick<LifeRecord, "validForStudy" | "outage">>(lives: readonly L[]): { valid: L[]; excluded: L[]; outage: number } {
  const valid: L[] = [];
  const excluded: L[] = [];
  for (const l of lives) (inStudy(l) ? valid : excluded).push(l);
  return { valid, excluded, outage: excluded.filter((l) => l.outage === true).length };
}

// ------------------------------------------------------------------ data window

export interface Window {
  lives: number;
  runs: number;
  alive: number;
  lost: number;
  dead: number;
  withTraits: number;
  /** trait values ignored as out of range (|v| > MAX_ABS_TRAIT or not finite) */
  outOfRange: number;
}

export function dataWindow(lives: readonly LifeRecord[]): Window {
  return {
    lives: lives.length,
    runs: new Set(lives.map((l) => l.runId)).size,
    alive: lives.filter((l) => l.status === "alive").length,
    lost: lives.filter((l) => l.status === "lost").length,
    dead: lives.filter((l) => l.status === "dead").length,
    withTraits: lives.filter((l) => l.traits && Object.values(l.traits).some(finite)).length,
    outOfRange: lives.reduce((s, l) => s + Object.values(l.traits ?? {}).filter((v) => !(finite(v) && Math.abs(v) <= MAX_ABS_TRAIT)).length, 0),
  };
}

// ------------------------------------------------------------------ Q1 survival

const permOpts = (B: number | PermOptions, seed: number): PermOptions => (typeof B === "number" ? { B, seed } : { ...B, seed });

/** ages (game years) at which survival bands are evaluated */
export const SURV_GRID: readonly number[] = Array.from({ length: LIFESPAN_YEARS + 1 }, (_, i) => i);
/** ages for the numbers-at-risk row under the survival chart */
export const RISK_AGES: readonly number[] = [0, ADULT_AGE, 30, 45];
/** family-bootstrap resamples for the survival bands */
export const SURV_BOOT = 200;

export interface KmCurve {
  label: "low" | "middle" | "high";
  n: number;
  deaths: number;
  /** trait range in this third */
  min: number | null;
  max: number | null;
  steps: KmStep[];
  /** number under observation at each of RISK_AGES (entered by then, last seen at or after it) */
  atRisk: number[];
  /** last age anyone in this third was observed: the curve stops there */
  last: number;
  /** pointwise 95% family-bootstrap band on SURV_GRID */
  lo: (number | null)[];
  hi: (number | null)[];
}

export interface Q1Survival {
  /** lives with this trait and a usable survival spell */
  n: number;
  deaths: number;
  /** alive or lost: censored at the last age seen */
  censored: number;
  families: number;
  /** Kaplan-Meier by trait third (low, middle, high) */
  curves: KmCurve[];
  /**
   * Log-rank trend test over the whole trait range: correlation of rank(trait) with each life's
   * martingale residual (died more than expected > 0), family-aware permutation p.
   * stat > 0 = higher trait, higher death rate (shorter lives).
   */
  test: ClusterPermResult | null;
  boot: number;
}

export function q1Survival(lives: readonly LifeRecord[], dim: string, now: number, B: number | PermOptions = PERMUTATIONS, boot = SURV_BOOT): Q1Survival {
  const xs: number[] = [];
  const spells: SurvSpell[] = [];
  const cl: string[] = [];
  for (const l of lives) {
    const x = traitOf(l, dim);
    if (x == null) continue;
    const s = spellOf(l, now);
    if (!(s.exit > s.entry)) continue;
    xs.push(x);
    spells.push(s);
    cl.push(l.lineageId);
  }
  const labels = ["low", "middle", "high"] as const;
  const thirds = terciles(xs);
  const group = new Array<number>(xs.length);
  thirds.forEach((idx, g) => idx.forEach((i) => (group[i] = g)));
  const bands = boot > 0 ? kmClusterBands(spells, group, cl, 3, SURV_GRID, boot, 13) : null;
  const curves = thirds.map((idx, g): KmCurve => {
    const sp = idx.map((i) => spells[i]);
    const v = idx.map((i) => xs[i]);
    return {
      label: labels[g],
      n: idx.length,
      deaths: sp.filter((s) => s.event).length,
      min: v.length ? Math.min(...v) : null,
      max: v.length ? Math.max(...v) : null,
      steps: kaplanMeier(sp),
      last: sp.length ? Math.max(...sp.map((s) => s.exit)) : 0,
      atRisk: RISK_AGES.map((a) => sp.filter((s) => s.entry <= a + 1 && s.exit >= a).length),
      lo: bands?.[g].lo ?? SURV_GRID.map(() => null),
      hi: bands?.[g].hi ?? SURV_GRID.map(() => null),
    };
  });
  const deaths = spells.filter((s) => s.event).length;
  return {
    n: xs.length,
    deaths,
    censored: xs.length - deaths,
    families: new Set(cl).size,
    curves,
    test: deaths > 0 ? clusterPermCorr(xs, martingaleResiduals(spells), cl, permOpts(B, 12)) : null,
    boot: bands ? boot : 0,
  };
}

export interface TercileBar {
  label: "low" | "middle" | "high";
  k: number;
  n: number;
  lo: number | null;
  hi: number | null;
  p: number | null;
  /** trait range in this third */
  min: number | null;
  max: number | null;
}

export interface Q1Adult {
  bars: TercileBar[];
  /** eligible lives (born >= 14 game-years ago as children, outcome seen) */
  n: number;
  /** excluded: born under 14 game-years ago */
  tooYoung: number;
  /** excluded: lost before 14 */
  lost: number;
  /** excluded: started as adults (Eves) */
  bornAdult: number;
  /** Spearman(trait, reached 0/1) with family-aware permutation p: a trend test across the whole range */
  trend: ClusterPermResult | null;
}

export function q1Adulthood(lives: readonly LifeRecord[], dim: string, now: number, B: number | PermOptions = PERMUTATIONS): Q1Adult {
  const xs: number[] = [];
  const ys: number[] = [];
  const cl: string[] = [];
  let tooYoung = 0;
  let lost = 0;
  let bornAdult = 0;
  for (const l of lives) {
    const x = traitOf(l, dim);
    if (x == null) continue;
    const o = adultOutcome(l, now);
    if (o === "too-young") tooYoung++;
    else if (o === "lost") lost++;
    else if (o === "born-adult") bornAdult++;
    else {
      xs.push(x);
      ys.push(o === "yes" ? 1 : 0);
      cl.push(l.lineageId);
    }
  }
  const labels = ["low", "middle", "high"] as const;
  const bars = terciles(xs).map((idx, g) => {
    const k = idx.reduce((s, i) => s + ys[i], 0);
    const w = wilson(k, idx.length);
    const v = idx.map((i) => xs[i]);
    return { label: labels[g], k, n: idx.length, lo: w?.lo ?? null, hi: w?.hi ?? null, p: w?.p ?? null, min: v.length ? Math.min(...v) : null, max: v.length ? Math.max(...v) : null };
  });
  return { bars, n: xs.length, tooYoung, lost, bornAdult, trend: clusterPermSpearman(xs, ys, cl, permOpts(B, 11)) };
}

// ------------------------------------------------------------------ Q2 descendants

export interface Q2Row {
  lifeId: string;
  lineageId: string;
  name: string | null;
  x: number;
  children: number;
  grandchildren: number;
  /** her own count is final: dead, or past FERTILE_END by now */
  closed: boolean;
  /** grandchildren final too: closed, and so is every daughter */
  complete: boolean;
}

export interface Q2Result {
  rows: Q2Row[];
  /** Spearman(trait, children), women with a closed window only; family-aware permutation p */
  children: ClusterPermResult | null;
  /** Spearman(trait, children + grandchildren), women whose daughters' windows are closed too */
  descendants: ClusterPermResult | null;
  closed: number;
  complete: number;
}

/** her children can no longer change: she died, or she is (would be, if lost) past FERTILE_END now */
const fertilityClosed = (l: LifeRecord, now: number) => l.status === "dead" || startAge(l) + (now - l.bornAt) / yearMs(l) >= FERTILE_END;

/**
 * Women observed past ADULT_AGE (incl. Eves). Children = our recorded lives whose mother she is.
 * The tests only use women whose counts are final, so recent mothers (who have had less time) don't
 * pull the counts down.
 */
export function q2Descendants(
  lives: readonly LifeRecord[],
  dim: string,
  now: number,
  B: number | PermOptions = PERMUTATIONS,
  /**
   * every recorded life, excluded ones included (default: `lives`). Rows are only built for `lives`,
   * but a child born to (or a daughter of) a valid woman is still her child even if the child itself
   * is excluded from the study, and her count is only final once we know that daughter's window closed.
   */
  kin: readonly LifeRecord[] = lives,
): Q2Result {
  const byId = new Map(kin.map((l) => [l.lifeId, l]));
  const kidsOf = new Map<string, string[]>();
  const add = (m: string, c: string) => {
    const a = kidsOf.get(m) ?? [];
    if (!a.includes(c)) a.push(c);
    kidsOf.set(m, a);
  };
  for (const l of kin) {
    for (const c of l.childLifeIds) add(l.lifeId, c);
    if (l.motherLifeId) add(l.motherLifeId, l.lifeId);
  }
  const rows: Q2Row[] = [];
  for (const l of lives) {
    if (l.female !== true) continue;
    const x = traitOf(l, dim);
    if (x == null) continue;
    if (observedAge(l, now).age < ADULT_AGE) continue;
    const kids = kidsOf.get(l.lifeId) ?? [];
    const grand = kids.reduce((s, c) => s + (kidsOf.get(c)?.length ?? 0), 0);
    const closed = fertilityClosed(l, now);
    // a child we have no record of (or of unknown sex) can't be checked: count as not closed
    const complete = closed && kids.every((c) => {
      const k = byId.get(c);
      return k != null && k.female != null && (k.female === false || fertilityClosed(k, now));
    });
    rows.push({ lifeId: l.lifeId, lineageId: l.lineageId, name: l.name, x, children: kids.length, grandchildren: grand, closed, complete });
  }
  rows.sort((a, b) => a.x - b.x || a.lifeId.localeCompare(b.lifeId));
  const cRows = rows.filter((r) => r.closed);
  const dRows = rows.filter((r) => r.complete);
  return {
    rows,
    children: clusterPermSpearman(
      cRows.map((r) => r.x),
      cRows.map((r) => r.children),
      cRows.map((r) => r.lineageId),
      permOpts(B, 21),
    ),
    descendants: clusterPermSpearman(
      dRows.map((r) => r.x),
      dRows.map((r) => r.children + r.grandchildren),
      dRows.map((r) => r.lineageId),
      permOpts(B, 22),
    ),
    closed: cRows.length,
    complete: dRows.length,
  };
}

// ------------------------------------------------------------------ Q3 roles

export interface Q3Cell {
  dim: string;
  role: Role;
  rho: number | null;
  p: number | null;
  /** Benjamini-Hochberg q over the cells of this matrix (the banner pools them with every other test) */
  q: number | null;
}

export interface Q3Result {
  n: number;
  families: number;
  cells: Q3Cell[];
  tests: number;
  concentration: ShuffleGini[];
  shuffles: number;
  /** sex x life-stage groups the shuffle stays within */
  strata: number;
  /** mean share of each role */
  meanShare: number[];
}

export function q3Eligible(lives: readonly LifeRecord[]): LifeRecord[] {
  return lives.filter((l) => l.activity.actions >= MIN_ACTIONS && roleShares(l.activity) != null);
}

/** sex x life stage ("reached 14" or not, when last seen): what roles differ by regardless of traits */
export function roleStratum(l: LifeRecord, now: number): string {
  const sex = l.female === true ? "F" : l.female === false ? "M" : "?";
  return `${sex}${observedAge(l, now).age >= ADULT_AGE ? "adult" : "child"}`;
}

/**
 * Trait x role matrix and role concentration. Role shares are centred within sex x life stage before
 * correlating, so a trait that only changes who grows up (and adults do different things) does not
 * show up as a role preference; the concentration null shuffles within the same groups.
 */
export function q3Roles(lives: readonly LifeRecord[], dims: readonly string[], opts: { B?: number | PermOptions; shuffles?: number; now?: number } = {}): Q3Result {
  const B = opts.B ?? MATRIX_PERMUTATIONS;
  const now = opts.now ?? Math.max(0, ...lives.map((l) => l.updatedAt));
  const elig = q3Eligible(lives);
  const strata = elig.map((l) => roleStratum(l, now));
  const shares = elig.map((l) => roleShares(l.activity)!);
  const centred = (() => {
    const by = new Map<string, number[][]>();
    shares.forEach((s, i) => by.set(strata[i], [...(by.get(strata[i]) ?? []), s]));
    const mu = new Map([...by.entries()].map(([k, ss]) => [k, ROLES.map((_, r) => mean(ss.map((s) => s[r]))!)]));
    return shares.map((s, i) => s.map((v, r) => v - mu.get(strata[i])![r]));
  })();
  const cells: Q3Cell[] = [];
  dims.forEach((dim, di) => {
    const keep = elig.map((l, i) => [traitOf(l, dim), i] as const).filter((p): p is readonly [number, number] => p[0] != null);
    ROLES.forEach((role, ri) => {
      const r = clusterPermSpearman(
        keep.map((k) => k[0]),
        keep.map((k) => centred[k[1]][ri]),
        keep.map((k) => elig[k[1]].lineageId),
        permOpts(B, 100 + di * 10 + ri),
      );
      cells.push({ dim, role, rho: r?.stat ?? null, p: r?.p ?? null, q: null });
    });
  });
  const tested = cells.filter((c) => c.p != null);
  const q = benjaminiHochberg(tested.map((c) => c.p!));
  tested.forEach((c, i) => (c.q = q[i]));
  // keep the shuffle work bounded (pooled events x shuffles); report the B actually used
  const counts = elig.map((l) => roleCounts(l.activity));
  const T = counts.reduce((s, c) => s + c.reduce((a, b) => a + b, 0), 0);
  const want = opts.shuffles ?? ROLE_SHUFFLES;
  const shuffles = T > 0 ? Math.max(Math.min(want, 200), Math.min(want, Math.floor(3e7 / T))) : 0;
  const conc = roleConcentration(counts, ROLES.length, shuffles, 7, strata);
  return {
    n: elig.length,
    families: new Set(elig.map((l) => l.lineageId)).size,
    cells,
    tests: tested.length,
    concentration: conc.results,
    shuffles: conc.B,
    strata: conc.strata,
    meanShare: ROLES.map((_, r) => mean(shares.map((s) => s[r])) ?? 0),
  };
}

// ------------------------------------------------------------------ Q4 generations

export interface GenGroup {
  gen: number;
  values: { lifeId: string; lineageId: string; v: number }[];
  median: number | null;
}

export function q4Generations(lives: readonly LifeRecord[], dim: string): GenGroup[] {
  const by = new Map<number, GenGroup["values"]>();
  for (const l of lives) {
    const v = traitOf(l, dim);
    if (v == null) continue;
    const g = Math.max(1, Math.round(l.generation || 1));
    const a = by.get(g) ?? [];
    a.push({ lifeId: l.lifeId, lineageId: l.lineageId, v });
    by.set(g, a);
  }
  return [...by.entries()].sort((a, b) => a[0] - b[0]).map(([gen, values]) => ({ gen, values, median: median(values.map((x) => x.v)) }));
}

export interface LineageTrack {
  lineageId: string;
  size: number;
  points: { gen: number; mean: number; se: number | null; n: number }[];
}

/** per-lineage mean (+- 1 SE where n >= 3) of the trait at each generation; largest lineages first */
export function q4Trajectories(lives: readonly LifeRecord[], dim: string): LineageTrack[] {
  const by = new Map<string, Map<number, number[]>>();
  for (const l of lives) {
    const v = traitOf(l, dim);
    if (v == null) continue;
    const m = by.get(l.lineageId) ?? new Map<number, number[]>();
    const g = Math.max(1, Math.round(l.generation || 1));
    m.set(g, [...(m.get(g) ?? []), v]);
    by.set(l.lineageId, m);
  }
  return [...by.entries()]
    .map(([lineageId, m]) => ({
      lineageId,
      size: [...m.values()].reduce((s, a) => s + a.length, 0),
      points: [...m.entries()].sort((a, b) => a[0] - b[0]).map(([gen, vs]) => ({ gen, mean: mean(vs)!, se: vs.length >= 3 ? sem(vs) : null, n: vs.length })),
    }))
    .sort((a, b) => b.size - a.size || a.lineageId.localeCompare(b.lineageId));
}

export interface Q4Heredity {
  pairs: { mother: number; child: number; motherId: string; childId: string; lineageId: string }[];
  mothers: number;
  fit: OlsFit | null;
  /** slope with SE clustered by mother */
  clustered: ClusteredSlope | null;
}

/** mother vs child, for children whose mother is a recorded life (inherited traits) */
export function q4Heredity(lives: readonly LifeRecord[], dim: string): Q4Heredity {
  const byId = new Map(lives.map((l) => [l.lifeId, l]));
  const pairs: Q4Heredity["pairs"] = [];
  for (const l of lives) {
    if (!l.motherLifeId) continue;
    const m = byId.get(l.motherLifeId);
    if (!m) continue;
    const a = traitOf(m, dim);
    const b = traitOf(l, dim);
    if (a == null || b == null) continue;
    pairs.push({ mother: a, child: b, motherId: m.lifeId, childId: l.lifeId, lineageId: l.lineageId });
  }
  const xs = pairs.map((p) => p.mother);
  const ys = pairs.map((p) => p.child);
  return { pairs, mothers: new Set(pairs.map((p) => p.motherId)).size, fit: olsMin(xs, ys), clustered: new Set(pairs.map((p) => p.motherId)).size >= MIN_CLUSTERS ? olsClustered(xs, ys, pairs.map((p) => p.motherId)) : null };
}


// ------------------------------------------------------------------ everything for one trait

export interface DimResults {
  surv: Q1Survival;
  adult: Q1Adult;
  desc: Q2Result;
  gens: GenGroup[];
  tracks: LineageTrack[];
  hered: Q4Heredity;
}

export function perDim(lives: readonly LifeRecord[], dim: string, now: number, B: number | PermOptions = PERMUTATIONS, boot = SURV_BOOT, kin: readonly LifeRecord[] = lives): DimResults {
  return {
    surv: q1Survival(lives, dim, now, B, boot),
    adult: q1Adulthood(lives, dim, now, B),
    desc: q2Descendants(lives, dim, now, B, kin),
    gens: q4Generations(lives, dim),
    tracks: q4Trajectories(lives, dim),
    hered: q4Heredity(lives, dim),
  };
}

// ------------------------------------------------------------------ banner verdict

export interface TraitTest {
  label: string;
  dim: string;
  /** "reaching 14" | "survival" | "children" | "descendants" | a role */
  outcome: string;
  p: number;
  /** Benjamini-Hochberg q over every test on the page */
  q: number;
}

/**
 * Every trait-effect test on the page, pooled under one Benjamini-Hochberg correction:
 * per trait, Q1 reaching 14 and survival (log-rank), Q2 children and descendants; plus the Q3 matrix.
 * Heredity (Q4) is excluded: inheritance is by design, so its slope is not a finding. Role
 * concentration is excluded: it is about people, not traits.
 */
export function traitTests(per: Readonly<Record<string, DimResults>>, q3: Q3Result | null): TraitTest[] {
  const raw: { dim: string; outcome: string; p: number | null | undefined }[] = [];
  for (const [d, r] of Object.entries(per)) {
    raw.push({ dim: d, outcome: `reaching ${ADULT_AGE}`, p: r.adult.trend?.p });
    raw.push({ dim: d, outcome: "survival", p: r.surv.test?.p });
    raw.push({ dim: d, outcome: "children", p: r.desc.children?.p });
    raw.push({ dim: d, outcome: "descendants", p: r.desc.descendants?.p });
  }
  for (const c of q3?.cells ?? []) raw.push({ dim: c.dim, outcome: c.role, p: c.p });
  const valid = raw.filter((t): t is { dim: string; outcome: string; p: number } => finite(t.p));
  const q = benjaminiHochberg(valid.map((t) => t.p));
  return valid.map((t, i) => ({ label: `${t.dim} → ${t.outcome}`, dim: t.dim, outcome: t.outcome, p: t.p, q: q[i] }));
}

/** fewer families than this: no claims at all, whatever n is */
export const MIN_FAMILIES = 8;

export interface Verdict {
  /** "too-small": below MIN_N_FOR_CLAIMS lives or MIN_FAMILIES families; "none": nothing survives FDR 5%; "some": k tests do */
  state: "too-small" | "none" | "some";
  n: number;
  families: number;
  /**
   * smallest family-level |r| a single real effect needs to pass (80% power) at the per-test level
   * BH requires of a lone effect, .05 / tests; null if families < 4
   */
  minR: number | null;
  significant: TraitTest[];
  tests: number;
}

export function verdict(tests: readonly TraitTest[], n: number, families = Infinity): Verdict {
  const significant = tests.filter((t) => t.q < 0.05);
  const units = Number.isFinite(families) ? families : n;
  const minR = minDetectableR(units, 0.05 / Math.max(1, tests.length));
  const base = { n, families, minR, significant, tests: tests.length };
  if (n < MIN_N_FOR_CLAIMS || families < MIN_FAMILIES) return { state: "too-small", ...base };
  return { state: significant.length ? "some" : "none", ...base };
}

// ------------------------------------------------------------------ whole page (runs in worker.ts)

export interface StudyRequest {
  id: number;
  /** every recorded life; computeStudy leaves out those not inStudy() */
  lives: LifeRecord[];
  dims: string[];
  now: number;
}
export interface StudyResult {
  id: number;
  /** lives the analyses used / left out (validForStudy false or outage) */
  used: number;
  excluded: number;
  per: Record<string, DimResults>;
  q3: Q3Result;
}

export function computeStudy(req: StudyRequest): StudyResult {
  const perm: PermOptions = { B: permBudget(req.dims.length), stopAfter: STOP_AFTER };
  const { valid, excluded } = studyLives(req.lives);
  const per: Record<string, DimResults> = {};
  for (const d of req.dims) per[d] = perDim(valid, d, req.now, perm, SURV_BOOT, req.lives);
  return { id: req.id, used: valid.length, excluded: excluded.length, per, q3: q3Roles(valid, req.dims, { B: perm, now: req.now }) };
}
