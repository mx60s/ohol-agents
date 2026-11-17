// Pure statistics for the study page. No DOM, no React; tested in tests/study.test.mjs.
// Every function copes with n = 0 / 1 / all-equal input by returning null (never NaN).

// ------------------------------------------------------------------ basics

export const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export function mean(a: readonly number[]): number | null {
  if (!a.length) return null;
  let s = 0;
  for (const v of a) s += v;
  return s / a.length;
}

/** sample variance (n - 1); null for n < 2 */
export function variance(a: readonly number[]): number | null {
  if (a.length < 2) return null;
  const m = mean(a)!;
  let s = 0;
  for (const v of a) s += (v - m) ** 2;
  return s / (a.length - 1);
}

export function sd(a: readonly number[]): number | null {
  const v = variance(a);
  return v == null ? null : Math.sqrt(v);
}

/** standard error of the mean; null for n < 2 */
export function sem(a: readonly number[]): number | null {
  const s = sd(a);
  return s == null ? null : s / Math.sqrt(a.length);
}

/** linear-interpolation quantile (numpy default, "type 7"); null for empty input */
export function quantile(a: readonly number[], q: number): number | null {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const h = (s.length - 1) * Math.min(1, Math.max(0, q));
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  return s[lo] + (s[hi] - s[lo]) * (h - lo);
}

export const median = (a: readonly number[]) => quantile(a, 0.5);

// ------------------------------------------------------------------ seeded RNG

export type Rng = () => number;

/** mulberry32: small, fast, deterministic uniform [0, 1) */
export function rng(seed: number): Rng {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/** standard normal draw (Box-Muller) */
export function gauss(r: Rng): number {
  const u = 1 - r();
  const v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** in-place Fisher-Yates shuffle */
export function shuffleInPlace<T>(a: T[] | Float64Array | Int32Array | Uint8Array, r: Rng): void {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    const t = a[i];
    a[i] = a[j];
    a[j] = t;
  }
}

// ------------------------------------------------------------------ distributions

/** log Gamma (Lanczos, g = 7) */
export function lgamma(x: number): number {
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
  x -= 1;
  let a = c[0];
  const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/** continued fraction for the incomplete beta (Numerical Recipes betacf) */
function betacf(a: number, b: number, x: number): number {
  const EPS = 3e-14;
  const FPMIN = 1e-300;
  let c = 1;
  let d = 1 - ((a + b) * x) / (a + 1);
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((a - 1 + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + 1 + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

/** regularised incomplete beta I_x(a, b) */
export function betaInc(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (bt * betacf(a, b, x)) / a : 1 - (bt * betacf(b, a, 1 - x)) / b;
}

/** Student t CDF */
export function tCdf(t: number, df: number): number {
  if (!Number.isFinite(t)) return t > 0 ? 1 : 0;
  const x = df / (df + t * t);
  const tail = 0.5 * betaInc(x, df / 2, 0.5);
  return t > 0 ? 1 - tail : tail;
}

/** Student t quantile (bisection on tCdf; plenty fast for a few calls per render) */
export function tQuantile(p: number, df: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  let lo = -1e4;
  let hi = 1e4;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (tCdf(mid, df) < p) lo = mid;
    else hi = mid;
    if (hi - lo < 1e-10) break;
  }
  return (lo + hi) / 2;
}

/** standard normal quantile (Acklam's rational approximation, |error| < 1.2e-9) */
export function normQuantile(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  if (p < pl) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - pl) return -normQuantile(1 - p);
  const q = p - 0.5;
  const r = q * q;
  return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

// ------------------------------------------------------------------ proportions

/** Wilson score interval for k successes in n trials. null for n = 0. */
export function wilson(k: number, n: number, z = 1.959963984540054): { p: number; lo: number; hi: number } | null {
  if (!(n > 0) || k < 0 || k > n) return null;
  const p = k / n;
  const z2 = z * z;
  const d = 1 + z2 / n;
  const c = p + z2 / (2 * n);
  const w = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return { p, lo: Math.max(0, (c - w) / d), hi: Math.min(1, (c + w) / d) };
}

// ------------------------------------------------------------------ regression

export interface OlsFit {
  n: number;
  /** intercept, slope */
  a: number;
  b: number;
  /** residual SD (n - 2 df) */
  s: number;
  seB: number;
  /** 95% CI for the slope, t with n - 2 df */
  ciB: [number, number];
  /** two-sided p for slope = 0 */
  p: number;
  r2: number;
  mx: number;
  sxx: number;
  tcrit: number;
}

/** Ordinary least squares y = a + b x. null if n < 3 or x has no spread. */
export function ols(xs: readonly number[], ys: readonly number[]): OlsFit | null {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return null;
  const mx = mean(xs.slice(0, n))!;
  const my = mean(ys.slice(0, n))!;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i] - mx) ** 2;
    sxy += (xs[i] - mx) * (ys[i] - my);
    syy += (ys[i] - my) ** 2;
  }
  if (!(sxx > 1e-12 * n)) return null;
  const b = sxy / sxx;
  const a = my - b * mx;
  let ssr = 0;
  for (let i = 0; i < n; i++) ssr += (ys[i] - a - b * xs[i]) ** 2;
  const s = Math.sqrt(ssr / (n - 2));
  const seB = s / Math.sqrt(sxx);
  const tcrit = tQuantile(0.975, n - 2);
  const t = seB > 0 ? b / seB : b === 0 ? 0 : Infinity;
  const p = Number.isFinite(t) ? 2 * (1 - tCdf(Math.abs(t), n - 2)) : 0;
  return { n, a, b, s, seB, ciB: [b - tcrit * seB, b + tcrit * seB], p, r2: syy > 0 ? 1 - ssr / syy : 0, mx, sxx, tcrit };
}

/** 95% confidence band for the mean response at x */
export function olsBand(f: OlsFit, x: number): [number, number] {
  const y = f.a + f.b * x;
  const se = f.s * Math.sqrt(1 / f.n + (x - f.mx) ** 2 / f.sxx);
  return [y - f.tcrit * se, y + f.tcrit * se];
}

export interface ClusteredSlope {
  b: number;
  seB: number;
  ciB: [number, number];
  p: number;
  /** number of clusters; t uses G - 1 df */
  clusters: number;
}

/**
 * OLS slope with a cluster-robust (CR1, "sandwich") standard error, e.g. clustered by mother:
 * V = c (X'X)^-1 [sum_g X_g' u_g u_g' X_g] (X'X)^-1, c = G/(G-1) * (N-1)/(N-2). t with G - 1 df.
 * Same small-sample correction as Stata's `regress, vce(cluster)`. null if G < 2.
 */
export function olsClustered(xs: readonly number[], ys: readonly number[], cluster: readonly string[]): ClusteredSlope | null {
  const f = ols(xs, ys);
  if (!f) return null;
  const n = f.n;
  // (X'X)^-1 for X = [1, x]
  let sx = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i];
    sxx += xs[i] * xs[i];
  }
  const det = n * sxx - sx * sx;
  const inv = [
    [sxx / det, -sx / det],
    [-sx / det, n / det],
  ];
  const sums = new Map<string, [number, number]>();
  for (let i = 0; i < n; i++) {
    const u = ys[i] - f.a - f.b * xs[i];
    const g = sums.get(cluster[i]) ?? [0, 0];
    g[0] += u;
    g[1] += u * xs[i];
    sums.set(cluster[i], g);
  }
  const G = sums.size;
  if (G < 2) return null;
  const meat = [
    [0, 0],
    [0, 0],
  ];
  for (const [s0, s1] of sums.values()) {
    meat[0][0] += s0 * s0;
    meat[0][1] += s0 * s1;
    meat[1][0] += s1 * s0;
    meat[1][1] += s1 * s1;
  }
  // V[1][1] = row 1 of inv * meat * col 1 of inv
  const r = inv[1];
  const v11 = r[0] * (meat[0][0] * r[0] + meat[0][1] * r[1]) + r[1] * (meat[1][0] * r[0] + meat[1][1] * r[1]);
  const c = (G / (G - 1)) * ((n - 1) / (n - 2));
  const seB = Math.sqrt(Math.max(0, c * v11));
  const tcrit = tQuantile(0.975, G - 1);
  const t = seB > 0 ? f.b / seB : f.b === 0 ? 0 : Infinity;
  const p = Number.isFinite(t) ? 2 * (1 - tCdf(Math.abs(t), G - 1)) : 0;
  return { b: f.b, seB, ciB: [f.b - tcrit * seB, f.b + tcrit * seB], p, clusters: G };
}

// ------------------------------------------------------------------ ranks and correlation

/** ranks 1..n, ties get their average rank */
export function ranks(a: readonly number[]): number[] {
  const idx = a.map((v, i) => [v, i] as const).sort((x, y) => x[0] - y[0]);
  const out = new Array<number>(a.length);
  for (let i = 0; i < idx.length; ) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const r = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) out[idx[k][1]] = r;
    i = j + 1;
  }
  return out;
}

/** Pearson r; null if n < 3 or either side has no spread */
export function pearson(xs: readonly number[], ys: readonly number[]): number | null {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return null;
  const mx = mean(xs.slice(0, n))!;
  const my = mean(ys.slice(0, n))!;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  if (!(sxx > 0) || !(syy > 0)) return null;
  return Math.max(-1, Math.min(1, sxy / Math.sqrt(sxx * syy)));
}

/** Spearman rho = Pearson on average ranks (matches scipy.stats.spearmanr with ties) */
export function spearman(xs: readonly number[], ys: readonly number[]): number | null {
  if (Math.min(xs.length, ys.length) < 3) return null;
  return pearson(ranks(xs), ranks(ys));
}

export interface PermResult {
  stat: number;
  /** two-sided permutation p = (1 + #{|T*| >= |T|}) / (B + 1) */
  p: number;
  B: number;
  n: number;
}

/**
 * Spearman rho with a two-sided permutation p (y shuffled, x fixed, seeded).
 * The denominator is permutation-invariant, so each shuffle costs one dot product.
 */
export function spearmanPerm(xs: readonly number[], ys: readonly number[], B = 2000, seed = 1): PermResult | null {
  const n = Math.min(xs.length, ys.length);
  const rho = spearman(xs, ys);
  if (rho == null) return null;
  const rx = ranks(xs.slice(0, n));
  const ry = ranks(ys.slice(0, n));
  const mx = mean(rx)!;
  const my = mean(ry)!;
  const cx = Float64Array.from(rx, (v) => v - mx);
  const cy = Float64Array.from(ry, (v) => v - my);
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxx += cx[i] * cx[i];
    syy += cy[i] * cy[i];
  }
  const den = Math.sqrt(sxx * syy);
  const obs = Math.abs(rho) - 1e-12;
  const r = rng(seed);
  let hits = 0;
  for (let b = 0; b < B; b++) {
    shuffleInPlace(cy, r);
    let s = 0;
    for (let i = 0; i < n; i++) s += cx[i] * cy[i];
    if (Math.abs(s / den) >= obs) hits++;
  }
  return { stat: rho, p: (1 + hits) / (B + 1), B, n };
}

export interface ClusterPermResult extends PermResult {
  /** number of clusters (families) */
  clusters: number;
  /** true if every arrangement of the G family centres was enumerated (G! <= B): p is exact */
  exact: boolean;
  /** smallest p this test could produce: 1 / G! when exact, else 1 / (B + 1) */
  minP: number;
}

/** average ranks 1..n of x into out (ties get their average rank): one native sort + two binary searches each */
function ranksInto(x: Float64Array, sorted: Float64Array, out: Float64Array): void {
  sorted.set(x);
  sorted.sort();
  const n = x.length;
  for (let i = 0; i < n; i++) {
    const v = x[i];
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const m = (lo + hi) >>> 1;
      if (sorted[m] < v) lo = m + 1;
      else hi = m;
    }
    let up = lo;
    hi = n;
    while (up < hi) {
      const m = (up + hi) >>> 1;
      if (sorted[m] <= v) up = m + 1;
      else hi = m;
    }
    out[i] = (lo + up + 1) / 2;
  }
}

export interface PermOptions {
  /** maximum number of random permutations */
  B?: number;
  seed?: number;
  /**
   * Besag-Clifford sequential stopping: stop as soon as this many permutations are at least as extreme
   * (then p = hits / permutations used; still a valid p). Clearly-null tests finish in a few dozen
   * permutations; small p still get all B. 0 = off.
   */
  stopAfter?: number;
}

/**
 * Correlation between rank(x) and a fixed score vector, with a family-aware permutation p.
 *
 * Traits are inherited (child = mother + small noise), so almost all trait variation is BETWEEN families,
 * and families also share outcomes (place, food, luck). Shuffling individuals then gives far too many
 * false positives. Instead each x is split into its family mean + the life's deviation from it; each
 * permutation moves the family means between families and keeps every deviation (and every score) in
 * place. The effective sample size is the number of families, not the number of lives.
 * Two-sided. If G! <= B, every arrangement is enumerated (exact p = #{|r*| >= |r|} / G!); otherwise
 * B random ones, p = (1 + #{|r*| >= |r|}) / (B + 1), or the sequential p if stopAfter is set.
 * score = ranks(y) gives Spearman; score = martingale residuals gives a log-rank trend test.
 * null if the correlation is undefined or there are fewer than 2 families.
 */
export function clusterPermCorr(xs: readonly number[], score: readonly number[], cluster: readonly string[], opts: PermOptions = {}): ClusterPermResult | null {
  const B = Math.max(1, Math.floor(opts.B ?? 2000));
  const stopAfter = opts.stopAfter ?? 0;
  const n = Math.min(xs.length, score.length, cluster.length);
  if (n < 3) return null;
  const x = Float64Array.from(xs.slice(0, n));
  const sc = score.slice(0, n);
  const stat = pearson(ranks([...x]), sc);
  if (stat == null) return null;
  const keys = [...new Set(cluster.slice(0, n))];
  const G = keys.length;
  if (G < 2) return null;
  const ki = new Map(keys.map((k, i) => [k, i]));
  const ci = Int32Array.from(cluster.slice(0, n), (c) => ki.get(c)!);
  const sum = new Float64Array(G);
  const cnt = new Float64Array(G);
  for (let i = 0; i < n; i++) {
    sum[ci[i]] += x[i];
    cnt[ci[i]]++;
  }
  const means = Float64Array.from(sum, (s, g) => s / cnt[g]);
  const dev = Float64Array.from(x, (v, i) => v - means[ci[i]]);
  const ms = mean(sc)!;
  const cs = Float64Array.from(sc, (v) => v - ms);
  let ss = 0;
  for (let i = 0; i < n; i++) ss += cs[i] * cs[i];
  const obs = Math.abs(stat) - 1e-12;
  const xx = new Float64Array(n);
  const sorted = new Float64Array(n);
  const rx = new Float64Array(n);
  const mx = (n + 1) / 2;
  const extreme = (pm: Float64Array) => {
    for (let i = 0; i < n; i++) xx[i] = dev[i] + pm[ci[i]];
    ranksInto(xx, sorted, rx);
    let sxy = 0;
    let sxx = 0;
    for (let i = 0; i < n; i++) {
      const d = rx[i] - mx;
      sxy += d * cs[i];
      sxx += d * d;
    }
    return Math.abs(sxx > 0 && ss > 0 ? sxy / Math.sqrt(sxx * ss) : 0) >= obs;
  };
  let total = 1;
  for (let g = 2; g <= G && total <= B; g++) total *= g;
  if (total <= B) {
    // exact: Heap's algorithm visits all G! arrangements of the family means (the first is the observed one)
    const pm = Float64Array.from(means);
    const c = new Int32Array(G);
    let hits = extreme(pm) ? 1 : 0;
    let i = 1;
    while (i < G) {
      if (c[i] < i) {
        const j = i % 2 === 0 ? 0 : c[i];
        const t = pm[j];
        pm[j] = pm[i];
        pm[i] = t;
        if (extreme(pm)) hits++;
        c[i]++;
        i = 1;
      } else {
        c[i] = 0;
        i++;
      }
    }
    return { stat, p: hits / total, B: total, n, clusters: G, exact: true, minP: 1 / total };
  }
  const R = rng(opts.seed ?? 1);
  const pm = Float64Array.from(means);
  let hits = 0;
  for (let b = 1; b <= B; b++) {
    shuffleInPlace(pm, R);
    if (extreme(pm)) hits++;
    if (stopAfter > 0 && hits >= stopAfter && b < B) return { stat, p: hits / b, B: b, n, clusters: G, exact: false, minP: 1 / (B + 1) };
  }
  return { stat, p: (1 + hits) / (B + 1), B, n, clusters: G, exact: false, minP: 1 / (B + 1) };
}

/** Spearman rho with a family-aware permutation p: clusterPermCorr with score = ranks(y). */
export function clusterPermSpearman(xs: readonly number[], ys: readonly number[], cluster: readonly string[], B: number | PermOptions = 2000, seed = 1): ClusterPermResult | null {
  const n = Math.min(xs.length, ys.length, cluster.length);
  if (n < 3) return null;
  const o: PermOptions = typeof B === "number" ? { B, seed } : { seed, ...B };
  return clusterPermCorr(xs.slice(0, n), ranks(ys.slice(0, n)), cluster.slice(0, n), o);
}

// ------------------------------------------------------------------ survival

export interface SurvSpell {
  /** age at which the life enters observation (0 for babies, ~14 for Eves: delayed entry) */
  entry: number;
  /** last observed age */
  exit: number;
  /** true = died at exit; false = right-censored (alive, or lost) */
  event: boolean;
}

export interface KmStep {
  /** age */
  t: number;
  /** S(t) just after t */
  s: number;
  /** at risk just before t */
  atRisk: number;
  deaths: number;
}

/** number of sorted values < v */
function countBelow(sorted: Float64Array, v: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const m = (lo + hi) >>> 1;
    if (sorted[m] < v) lo = m + 1;
    else hi = m;
  }
  return lo;
}

/** distinct death ages with deaths d and risk set size r (at risk at t: entry < t <= exit) */
function riskTable(spells: readonly SurvSpell[]): { t: number[]; d: number[]; r: number[] } {
  const ok = spells.filter((s) => s.exit > s.entry);
  const entries = Float64Array.from(ok, (s) => s.entry).sort();
  const exits = Float64Array.from(ok, (s) => s.exit).sort();
  const deaths = ok.filter((s) => s.event).map((s) => s.exit).sort((a, b) => a - b);
  const t: number[] = [];
  const d: number[] = [];
  const r: number[] = [];
  for (let i = 0; i < deaths.length; ) {
    let j = i;
    while (j < deaths.length && deaths[j] === deaths[i]) j++;
    t.push(deaths[i]);
    d.push(j - i);
    // entry < t and exit >= t; since entry < exit, {exit < t} is a subset of {entry < t}
    r.push(countBelow(entries, deaths[i]) - countBelow(exits, deaths[i]));
    i = j;
  }
  return { t, d, r };
}

/**
 * Kaplan-Meier survival with delayed entry (left truncation): at risk at age t if entry < t <= exit.
 * One step per distinct death age, after a leading { t: 0, s: 1 }. Lives with exit <= entry are ignored.
 */
export function kaplanMeier(spells: readonly SurvSpell[]): KmStep[] {
  const { t, d, r } = riskTable(spells);
  const out: KmStep[] = [{ t: 0, s: 1, atRisk: spells.filter((s) => s.exit > s.entry && s.entry <= 0).length, deaths: 0 }];
  let S = 1;
  for (let k = 0; k < t.length; k++) {
    if (r[k] > 0) S *= 1 - d[k] / r[k];
    out.push({ t: t[k], s: S, atRisk: r[k], deaths: d[k] });
  }
  return out;
}

/** S(t) from KM steps (right-continuous step function) */
export function kmAt(steps: readonly KmStep[], t: number): number {
  let s = 1;
  for (const st of steps) {
    if (st.t > t) break;
    s = st.s;
  }
  return s;
}

/**
 * Martingale residuals under "no covariate effect": M_i = event_i - (Lambda(exit_i) - Lambda(entry_i)),
 * Lambda = Nelson-Aalen cumulative hazard of everyone (Breslow ties), with delayed entry.
 * sum_i x_i M_i is the log-rank (Cox score) statistic for covariate x, so correlating rank(trait) with M
 * under the family-aware permutation is a log-rank trend test that keeps alive and lost lives as censored.
 */
export function martingaleResiduals(spells: readonly SurvSpell[]): number[] {
  const { t, d, r } = riskTable(spells);
  const cum = new Float64Array(t.length);
  let L = 0;
  for (let k = 0; k < t.length; k++) cum[k] = L += r[k] > 0 ? d[k] / r[k] : 0;
  const times = Float64Array.from(t);
  // Lambda(a) = cum hazard over death ages <= a
  const lam = (a: number) => {
    let lo = 0;
    let hi = times.length;
    while (lo < hi) {
      const m = (lo + hi) >>> 1;
      if (times[m] <= a) lo = m + 1;
      else hi = m;
    }
    return lo ? cum[lo - 1] : 0;
  };
  return spells.map((s) => (s.exit > s.entry ? (s.event ? 1 : 0) - (lam(s.exit) - lam(s.entry)) : 0));
}

/**
 * Pointwise 95% bands for Kaplan-Meier curves by resampling whole families (cluster bootstrap),
 * so lives in the same family are not treated as independent. group[i] in 0..nGroups-1 is fixed
 * (from the original data). Returns, per group, lo/hi on `grid` (null where under half of the
 * resamples still have that group under observation at that age).
 */
export function kmClusterBands(spells: readonly SurvSpell[], group: readonly number[], cluster: readonly string[], nGroups: number, grid: readonly number[], reps = 200, seed = 5): { lo: (number | null)[]; hi: (number | null)[] }[] {
  const keys = [...new Set(cluster)];
  const members = new Map<string, number[]>(keys.map((k) => [k, []]));
  cluster.forEach((c, i) => members.get(c)!.push(i));
  const vals: number[][][] = Array.from({ length: nGroups }, () => grid.map(() => []));
  const R = rng(seed);
  for (let b = 0; b < reps && keys.length >= 2; b++) {
    const by: SurvSpell[][] = Array.from({ length: nGroups }, () => []);
    for (let k = 0; k < keys.length; k++) for (const i of members.get(keys[Math.floor(R() * keys.length)])!) by[group[i]].push(spells[i]);
    by.forEach((sp, g) => {
      const ok = sp.filter((s) => s.exit > s.entry);
      if (!ok.length) return;
      const last = Math.max(...ok.map((s) => s.exit));
      const steps = kaplanMeier(ok);
      grid.forEach((t, j) => {
        if (t <= last) vals[g][j].push(kmAt(steps, t));
      });
    });
  }
  return vals.map((vg) => ({
    lo: vg.map((v) => (v.length >= reps / 2 ? quantile(v, 0.025) : null)),
    hi: vg.map((v) => (v.length >= reps / 2 ? quantile(v, 0.975) : null)),
  }));
}

// ------------------------------------------------------------------ multiple testing and power

/**
 * Benjamini-Hochberg adjusted p-values (q), same order as input. Controls the FDR for independent or
 * positively dependent tests (PRDS); the page's tests share families, so treat q as approximate.
 */
export function benjaminiHochberg(ps: readonly number[]): number[] {
  const m = ps.length;
  const order = ps.map((p, i) => [p, i] as const).sort((a, b) => a[0] - b[0]);
  const q = new Array<number>(m);
  let prev = 1;
  for (let k = m - 1; k >= 0; k--) {
    const [p, i] = order[k];
    prev = Math.min(prev, (p * m) / (k + 1));
    q[i] = Math.min(1, prev);
  }
  return q;
}

/**
 * Smallest |r| detectable with the given power at two-sided alpha (Fisher z approximation); null for n < 4.
 * For the family-aware tests pass n = number of families: r is then the family-level correlation.
 */
export function minDetectableR(n: number, alpha = 0.05, power = 0.8): number | null {
  if (n < 4) return null;
  const z = (normQuantile(1 - alpha / 2) + normQuantile(power)) / Math.sqrt(n - 3);
  return Math.tanh(z);
}

// ------------------------------------------------------------------ inequality

/**
 * Gini coefficient of non-negative values: sum_i sum_j |x_i - x_j| / (2 n^2 mean).
 * 0 = everyone equal; (n-1)/n = one person has it all. null if n < 2 or all zero.
 */
export function gini(values: readonly number[]): number | null {
  const n = values.length;
  if (n < 2) return null;
  const s = Float64Array.from(values).sort();
  let tot = 0;
  let w = 0;
  for (let i = 0; i < n; i++) {
    tot += s[i];
    w += (2 * (i + 1) - n - 1) * s[i];
  }
  if (!(tot > 0)) return null;
  return w / (n * tot);
}

export interface ShuffleGini {
  role: number;
  observed: number | null;
  /** 2.5% and 97.5% of the null distribution */
  lo: number | null;
  hi: number | null;
  nullMedian: number | null;
  /** one-sided p: share of shuffles at least as concentrated as observed, (1 + hits) / (B + 1) */
  p: number | null;
}

/**
 * Role concentration vs a shuffle null.
 * counts[i][r] = person i's events in role r. Observed: Gini over people of each role's share
 * (count / person total). Null: pool the role labels of all events WITHIN each stratum (e.g. sex x
 * child/adult), shuffle them between the people of that stratum (each keeps their own total),
 * recompute the Gini over everyone. So differences between strata (babies don't care for babies,
 * mothers do) are kept in the null and only specialisation beyond them counts. Without strata, the
 * whole population is one stratum. People with 0 events are dropped.
 */
export function roleConcentration(counts: readonly (readonly number[])[], roles: number, B = 1000, seed = 7, strata?: readonly string[]): { results: ShuffleGini[]; B: number; n: number; strata: number } {
  const keep = counts.map((_c, i) => i).filter((i) => counts[i].reduce((s, v) => s + v, 0) > 0);
  const st = keep.map((i) => strata?.[i] ?? "");
  // rows ordered by stratum so each stratum's events form one contiguous block of the pool
  const order = keep.map((_, k) => k).sort((a, b) => (st[a] < st[b] ? -1 : st[a] > st[b] ? 1 : a - b));
  const rows = order.map((k) => counts[keep[k]]);
  const rowSt = order.map((k) => st[k]);
  const n = rows.length;
  const nStrata = new Set(rowSt).size;
  const totals = rows.map((c) => c.reduce((s, v) => s + v, 0));
  const shareGini = (cs: readonly (readonly number[])[], r: number) => gini(cs.map((c, i) => c[r] / totals[i]));
  const observed = Array.from({ length: roles }, (_, r) => (n >= 2 ? shareGini(rows, r) : null));
  if (n < 2 || B <= 0) return { results: observed.map((o, r) => ({ role: r, observed: o, lo: null, hi: null, nullMedian: null, p: null })), B: 0, n, strata: nStrata };
  const T = totals.reduce((s, v) => s + v, 0);
  const pool = new Uint8Array(T);
  const blocks: [number, number][] = [];
  let k = 0;
  rows.forEach((c, i) => {
    if (i === 0 || rowSt[i] !== rowSt[i - 1]) blocks.push([k, k]);
    for (let r = 0; r < roles; r++) for (let j = 0; j < c[r]; j++) pool[k++] = r;
    blocks[blocks.length - 1][1] = k;
  });
  const R = rng(seed);
  const nulls: number[][] = Array.from({ length: roles }, () => []);
  const tally = rows.map(() => new Array<number>(roles).fill(0));
  for (let b = 0; b < B; b++) {
    for (const [a, z] of blocks) shuffleInPlace(pool.subarray(a, z), R);
    let off = 0;
    for (let i = 0; i < n; i++) {
      const t = tally[i];
      t.fill(0);
      for (let j = 0; j < totals[i]; j++) t[pool[off + j]]++;
      off += totals[i];
    }
    for (let r = 0; r < roles; r++) {
      const g = shareGini(tally, r);
      if (g != null) nulls[r].push(g);
    }
  }
  const results = observed.map((o, r) => {
    const nl = nulls[r];
    if (!nl.length || o == null) return { role: r, observed: o, lo: null, hi: null, nullMedian: null, p: null };
    const hits = nl.filter((g) => g >= o - 1e-12).length;
    return { role: r, observed: o, lo: quantile(nl, 0.025), hi: quantile(nl, 0.975), nullMedian: median(nl), p: (1 + hits) / (nl.length + 1) };
  });
  return { results, B, n, strata: nStrata };
}

// ------------------------------------------------------------------ grouping

/**
 * Split into thirds by value: sort (stable by index on ties), group = floor(rank * 3 / n).
 * Sizes differ by at most 1; tied values at a boundary can land in different thirds.
 * Returns index lists (into `values`), low / middle / high.
 */
export function terciles(values: readonly number[]): [number[], number[], number[]] {
  const n = values.length;
  const idx = values.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: [number[], number[], number[]] = [[], [], []];
  idx.forEach(([, i], rank) => out[Math.min(2, Math.floor((rank * 3) / n))].push(i));
  return out;
}

/** nice axis ticks covering [lo, hi] */
export function niceTicks(lo: number, hi: number, count = 5): number[] {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [];
  if (hi < lo) [lo, hi] = [hi, lo];
  if (hi === lo) return [lo];
  const raw = (hi - lo) / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step - 1e-9) * step; v <= hi + step * 1e-9; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : +v.toFixed(10));
  return out;
}
