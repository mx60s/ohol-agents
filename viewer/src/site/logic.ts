// Pure logic for the research site (no React, no DOM). Tested in tests/site.test.mjs.
//
// Traits are MOCK while traitSource is "mock": roughly N(0,1), clipped to +-2.5 by the server.
// Bad data (1e300, null, NaN) must never break a chart, so everything numeric goes through clampTrait.

import type { LifeActivity, LifeRecord, Traits } from "../api-types.ts";

export const TRAIT_LIMIT = 2.5;

/** A trait value safe to plot: finite and within +-2.5, else null. */
export function clampTrait(v: number | null | undefined): number | null {
  if (v == null || !Number.isFinite(v)) return null;
  return Math.max(-TRAIT_LIMIT, Math.min(TRAIT_LIMIT, v));
}

/** Short column label for a trait dim: "conscientiousness" -> "Consc", "risk_taking" -> "Risk T". */
export function traitShort(dim: string): string {
  const words = dim.replace(/[_-]+/g, " ").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return dim;
  const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);
  if (words.length === 1) return cap(words[0].length > 6 ? words[0].slice(0, 5) : words[0]);
  return words.map((w, i) => (i === 0 ? cap(w.slice(0, 4)) : w.charAt(0).toUpperCase())).join(" ");
}

/** Full label: "risk_taking" -> "Risk taking". */
export function traitLabel(dim: string): string {
  const s = dim.replace(/[_-]+/g, " ").trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ------------------------------------------------------------------ stats

export function median(xs: readonly number[]): number | null {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

export function mean(xs: readonly number[]): number | null {
  const v = xs.filter((x) => Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

/**
 * Percentile rank of `v` among `all` (0..100): share below plus half the ties.
 * `all` should include v itself. Returns null with no data.
 */
export function percentileRank(v: number, all: readonly number[]): number | null {
  const xs = all.filter((x) => Number.isFinite(x));
  if (!xs.length || !Number.isFinite(v)) return null;
  let below = 0;
  let eq = 0;
  for (const x of xs) {
    if (x < v) below++;
    else if (x === v) eq++;
  }
  return (100 * (below + eq / 2)) / xs.length;
}

/** 78 -> "78th", 1 -> "1st", 12 -> "12th", 22 -> "22nd" */
export function ordinal(n: number): string {
  const i = Math.round(n);
  const t = i % 100;
  if (t >= 11 && t <= 13) return `${i}th`;
  return `${i}${["th", "st", "nd", "rd"][i % 10] ?? "th"}`;
}

/** Percentile label: "78th pct", "lowest", "highest". */
export function percentileLabel(p: number | null, n: number): string {
  if (p == null) return "";
  if (n > 1 && p <= 100 / n / 2 + 1e-9) return "lowest";
  if (n > 1 && p >= 100 - 100 / n / 2 - 1e-9) return "highest";
  return `${ordinal(Math.min(99, Math.max(1, p)))} pct`;
}

/** Values of one dim over lives with usable traits (clamped). */
export function traitValues(lives: readonly Pick<LifeRecord, "traits">[], dim: string): number[] {
  const out: number[] = [];
  for (const l of lives) {
    const v = clampTrait(l.traits?.[dim]);
    if (v != null) out.push(v);
  }
  return out;
}

/** Per-dim mean over lives (clamped values), skipping missing. */
export function meanTraits(lives: readonly Pick<LifeRecord, "traits">[], dims: readonly string[]): Traits {
  const out: Traits = {};
  for (const d of dims) {
    const m = mean(traitValues(lives, d));
    if (m != null) out[d] = m;
  }
  return out;
}

// ------------------------------------------------------------------ PCA

export interface Pca {
  /** unit loading vectors (length = dims), PC1 and PC2 */
  components: [number[], number[]];
  /** share of total variance explained by each (0..1) */
  explained: [number, number];
  means: number[];
}

function matVec(m: number[][], v: number[]): number[] {
  return m.map((row) => row.reduce((s, x, j) => s + x * v[j], 0));
}
function norm(v: number[]): number {
  return Math.sqrt(v.reduce((s, x) => s + x * x, 0));
}

/** Top eigenvector of a symmetric PSD matrix by power iteration (deterministic start). */
function topEigen(m: number[][]): { vec: number[]; val: number } {
  const n = m.length;
  let v = Array.from({ length: n }, (_, i) => 1 + i * 0.1);
  let val = 0;
  for (let it = 0; it < 300; it++) {
    const w = matVec(m, v);
    const nw = norm(w);
    if (nw < 1e-12) return { vec: v.map(() => 0), val: 0 };
    const next = w.map((x) => x / nw);
    const diff = norm(next.map((x, i) => x - v[i]));
    v = next;
    val = nw;
    if (diff < 1e-10) break;
  }
  // sign: largest-magnitude loading positive (stable across runs)
  let big = 0;
  for (let i = 1; i < n; i++) if (Math.abs(v[i]) > Math.abs(v[big])) big = i;
  if (v[big] < 0) v = v.map((x) => -x);
  return { vec: v, val };
}

/**
 * 2-component PCA over rows (each row = one life's trait vector, already clamped).
 * Rows with any missing value should be dropped by the caller. Returns null for < 2 rows or < 2 dims.
 */
export function pca2(rows: readonly number[][]): Pca | null {
  if (rows.length < 2) return null;
  const d = rows[0].length;
  if (d < 2) return null;
  const means = Array.from({ length: d }, (_, j) => rows.reduce((s, r) => s + r[j], 0) / rows.length);
  const cov = Array.from({ length: d }, () => new Array<number>(d).fill(0));
  for (const r of rows) {
    for (let i = 0; i < d; i++) {
      const a = r[i] - means[i];
      for (let j = i; j < d; j++) cov[i][j] += a * (r[j] - means[j]);
    }
  }
  for (let i = 0; i < d; i++) for (let j = i; j < d; j++) cov[j][i] = cov[i][j] /= rows.length - 1;
  const total = cov.reduce((s, row, i) => s + row[i], 0);
  const e1 = topEigen(cov);
  const deflated = cov.map((row, i) => row.map((x, j) => x - e1.val * e1.vec[i] * e1.vec[j]));
  const e2 = topEigen(deflated);
  return {
    components: [e1.vec, e2.vec],
    explained: total > 0 ? [e1.val / total, e2.val / total] : [0, 0],
    means,
  };
}

/** Project one (clamped, complete) row onto the 2 components. */
export function pcaProject(p: Pca, row: readonly number[]): [number, number] {
  const c = row.map((x, i) => x - p.means[i]);
  return [c.reduce((s, x, i) => s + x * p.components[0][i], 0), c.reduce((s, x, i) => s + x * p.components[1][i], 0)];
}

/** The two biggest loadings of a component, e.g. "+openness −agreeableness". */
export function loadingHint(vec: readonly number[], dims: readonly string[], k = 2): string {
  return vec
    .map((v, i) => ({ v, d: dims[i] }))
    .sort((a, b) => Math.abs(b.v) - Math.abs(a.v))
    .slice(0, k)
    .filter((x) => Math.abs(x.v) > 0.2)
    .map((x) => `${x.v >= 0 ? "+" : "−"}${traitShort(x.d)}`)
    .join(" ");
}

/** Complete clamped trait vector for a life, or null if any dim is missing/invalid. */
export function traitRow(traits: Traits | null | undefined, dims: readonly string[]): number[] | null {
  if (!traits) return null;
  const out: number[] = [];
  for (const d of dims) {
    const v = clampTrait(traits[d]);
    if (v == null) return null;
    out.push(v);
  }
  return out;
}

// ------------------------------------------------------------------ activity & roles

export type ActivityGroup = "exploring" | "foraging" | "crafting" | "caregiving" | "socialising";
export const ACTIVITY_GROUPS: readonly ActivityGroup[] = ["exploring", "foraging", "crafting", "caregiving", "socialising"];

export const ROLE_OF_GROUP: Record<ActivityGroup, string> = {
  exploring: "explorer",
  foraging: "forager",
  crafting: "maker",
  caregiving: "caregiver",
  socialising: "talker",
};

const n0 = (x: number | null | undefined) => (typeof x === "number" && Number.isFinite(x) && x > 0 ? x : 0);

/** Counts per activity group (see LifeActivity docs; distances are not counts so they're left out). */
export function activityGroups(a: Partial<LifeActivity> | null | undefined): Record<ActivityGroup, number> {
  const x = a ?? {};
  return {
    exploring: n0(x.moves),
    foraging: n0(x.forage) + n0(x.eat) + n0(x.pickUp),
    crafting: n0(x.craft) + n0(x.drop) + n0(x.wear),
    caregiving: n0(x.babyPickups) + n0(x.feeds),
    socialising: n0(x.says),
  };
}

export interface ActivityShare {
  group: ActivityGroup;
  count: number;
  share: number;
}

/** Shares of each group (sum 1), biggest first; empty when nothing was counted. */
export function activityShares(a: Partial<LifeActivity> | null | undefined): ActivityShare[] {
  const g = activityGroups(a);
  const total = ACTIVITY_GROUPS.reduce((s, k) => s + g[k], 0);
  if (!total) return [];
  return ACTIVITY_GROUPS.map((group) => ({ group, count: g[group], share: g[group] / total })).sort((p, q) => q.count - p.count);
}

export const MIN_ROLE_ACTIONS = 8;

/**
 * Role from the activity mix: the dominant group if it holds >= 35% and leads the runner-up
 * by 1.25x; "generalist" otherwise; null if fewer than MIN_ROLE_ACTIONS counted (too early).
 * Heuristic, for the agent page; not a study result.
 */
export function deriveRole(a: Partial<LifeActivity> | null | undefined): string | null {
  const s = activityShares(a);
  const total = s.reduce((t, x) => t + x.count, 0);
  if (total < MIN_ROLE_ACTIONS) return null;
  const [top, second] = s;
  if (top.share >= 0.35 && (!second || top.count >= second.count * 1.25)) return ROLE_OF_GROUP[top.group];
  return "generalist";
}

// ------------------------------------------------------------------ family trees

export interface TreeNode<L extends Pick<LifeRecord, "lifeId" | "motherLifeId" | "bornAt"> = LifeRecord> {
  life: L;
  children: TreeNode<L>[];
  depth: number;
}

/**
 * Forest from motherLifeId. Roots = lives whose mother is null or not in `lives`.
 * Children in birth order. Cycles (bad data) are broken: a life is placed once.
 */
export function buildForest<L extends Pick<LifeRecord, "lifeId" | "motherLifeId" | "bornAt">>(lives: readonly L[]): TreeNode<L>[] {
  const byId = new Map(lives.map((l) => [l.lifeId, l]));
  const kids = new Map<string, L[]>();
  const roots: L[] = [];
  for (const l of lives) {
    const m = l.motherLifeId;
    if (m && m !== l.lifeId && byId.has(m)) {
      const arr = kids.get(m) ?? [];
      arr.push(l);
      kids.set(m, arr);
    } else roots.push(l);
  }
  const byBirth = (a: L, b: L) => a.bornAt - b.bornAt || a.lifeId.localeCompare(b.lifeId);
  const placed = new Set<string>();
  const make = (l: L, depth: number): TreeNode<L> => {
    placed.add(l.lifeId);
    const ch = (kids.get(l.lifeId) ?? []).filter((c) => !placed.has(c.lifeId)).sort(byBirth);
    return { life: l, depth, children: ch.map((c) => make(c, depth + 1)) };
  };
  const forest = roots.sort(byBirth).map((r) => make(r, 0));
  // lives only reachable through a cycle: add them as extra roots
  for (const l of [...lives].sort(byBirth)) if (!placed.has(l.lifeId)) forest.push(make(l, 0));
  return forest;
}

export function treeSize(n: TreeNode<Pick<LifeRecord, "lifeId" | "motherLifeId" | "bornAt">>): number {
  return 1 + n.children.reduce((s, c) => s + treeSize(c), 0);
}

export function treeDepth(n: TreeNode<Pick<LifeRecord, "lifeId" | "motherLifeId" | "bornAt">>): number {
  return 1 + n.children.reduce((m, c) => Math.max(m, treeDepth(c)), 0);
}

/** Mother, siblings (same mother, birth order, including the life itself) and children of a life. */
export function familyOf<L extends Pick<LifeRecord, "lifeId" | "motherLifeId" | "bornAt" | "lineageId">>(
  life: L,
  all: readonly L[],
): { mother: L | null; siblings: L[]; children: L[] } {
  const byBirth = (a: L, b: L) => a.bornAt - b.bornAt || a.lifeId.localeCompare(b.lifeId);
  const mother = life.motherLifeId ? (all.find((l) => l.lifeId === life.motherLifeId) ?? null) : null;
  const siblings = life.motherLifeId ? all.filter((l) => l.motherLifeId === life.motherLifeId).sort(byBirth) : [life];
  const children = all.filter((l) => l.motherLifeId === life.lifeId && l.lifeId !== life.lifeId).sort(byBirth);
  return { mother, siblings, children };
}

/**
 * Previous / next for the agent page: siblings in birth order; for a life without a known
 * mother (Eves), the other motherless lives in birth order.
 */
export function prevNext<L extends Pick<LifeRecord, "lifeId" | "motherLifeId" | "bornAt">>(life: L, all: readonly L[]): { prev: L | null; next: L | null } {
  const byBirth = (a: L, b: L) => a.bornAt - b.bornAt || a.lifeId.localeCompare(b.lifeId);
  const ids = new Set(all.map((l) => l.lifeId));
  const motherKnown = (l: L) => !!l.motherLifeId && ids.has(l.motherLifeId);
  const group = motherKnown(life) ? all.filter((l) => l.motherLifeId === life.motherLifeId) : all.filter((l) => !motherKnown(l));
  const sorted = [...group].sort(byBirth);
  const i = sorted.findIndex((l) => l.lifeId === life.lifeId);
  if (i < 0) return { prev: null, next: null };
  return { prev: sorted[i - 1] ?? null, next: sorted[i + 1] ?? null };
}

// ------------------------------------------------------------------ sorting & filtering

export type SortDir = "asc" | "desc";

/**
 * Compare with nulls always last (whatever the direction). Strings compare case-insensitively.
 */
export function compareNullable(a: number | string | null | undefined, b: number | string | null | undefined, dir: SortDir = "asc"): number {
  const an = a == null || (typeof a === "number" && !Number.isFinite(a));
  const bn = b == null || (typeof b === "number" && !Number.isFinite(b));
  if (an && bn) return 0;
  if (an) return 1;
  if (bn) return -1;
  const c = typeof a === "string" || typeof b === "string" ? String(a).localeCompare(String(b), undefined, { sensitivity: "base" }) : (a as number) - (b as number);
  return dir === "asc" ? c : -c;
}

/** Stable sort by a key function (nulls last), with a tiebreak. */
export function sortBy<T>(xs: readonly T[], key: (x: T) => number | string | null | undefined, dir: SortDir = "asc", tiebreak?: (a: T, b: T) => number): T[] {
  return xs
    .map((x, i) => ({ x, i, k: key(x) }))
    .sort((p, q) => compareNullable(p.k, q.k, dir) || (tiebreak ? tiebreak(p.x, q.x) : 0) || p.i - q.i)
    .map((p) => p.x);
}

/** Case- and accent-insensitive "contains" over several fields. Empty query matches everything. */
export function matchesQuery(q: string, ...fields: (string | null | undefined)[]): boolean {
  const norm = (s: string) => s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
  const needle = norm(q.trim());
  if (!needle) return true;
  return fields.some((f) => f != null && norm(f).includes(needle));
}

/** Clip a page index into range and return the slice. */
export function pageSlice<T>(xs: readonly T[], page: number, size: number): { rows: T[]; page: number; pages: number } {
  const pages = Math.max(1, Math.ceil(xs.length / size));
  const p = Math.max(0, Math.min(pages - 1, page));
  return { rows: xs.slice(p * size, p * size + size), page: p, pages };
}

// ------------------------------------------------------------------ ages & lives

/** Best known in-game age: live value if given, else age at death, else age at birth. */
export function lifeAge(l: Pick<LifeRecord, "ageAtDeath" | "ageAtBirth" | "status">, liveAge?: number | null): number | null {
  if (liveAge != null && Number.isFinite(liveAge)) return liveAge;
  if (l.ageAtDeath != null && Number.isFinite(l.ageAtDeath)) return l.ageAtDeath;
  return l.ageAtBirth ?? null;
}

/** Wall-clock lifetime in ms (alive: until now; lost: until lostAt). */
export function lifetimeMs(l: Pick<LifeRecord, "bornAt" | "diedAt" | "lostAt">, now: number): number | null {
  const end = l.diedAt ?? l.lostAt ?? now;
  if (!Number.isFinite(l.bornAt) || l.bornAt <= 0) return null;
  return Math.max(0, end - l.bornAt);
}
