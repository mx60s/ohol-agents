// Study page statistics + analyses (node --test, .ts via type stripping).
// Reference values were computed separately with scipy 1.14 / numpy (see comments).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as S from "../src/study/stats.ts";
import * as A from "../src/study/analysis.ts";
import { EFFECT_DIM, generateSynthetic, NO_EFFECTS, PLANTED } from "../src/study/synthetic.ts";
import { livesCsv } from "../src/study/csv.ts";
import { normLives } from "../src/data/normalize.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixtureLives = (name) => normLives(JSON.parse(fs.readFileSync(path.join(HERE, "..", "fixtures", name, "lives.json"), "utf8")));
const close = (a, b, tol = 1e-6, msg = "") => assert.ok(Math.abs(a - b) <= tol, `${msg} ${a} != ${b} (tol ${tol})`);

// ------------------------------------------------------------------ stats vs scipy

test("distributions match scipy", () => {
  close(S.tQuantile(0.975, 10), 2.2281388519649385, 1e-7, "t.ppf(.975, 10)");
  close(S.tQuantile(0.975, 3), 3.182446305284263, 1e-7, "t.ppf(.975, 3)");
  close(S.tCdf(1.5, 7), 0.911350756505015, 1e-9, "t.cdf(1.5, 7)");
  close(S.normQuantile(0.975), 1.959963984540054, 1e-8);
  close(S.normQuantile(0.01), -2.3263478740408408, 1e-8);
  close(S.betaInc(0.3, 2.5, 1.5), 0.08894372317066562, 1e-10, "betainc");
});

test("Wilson interval (textbook + scipy-checked)", () => {
  const w = S.wilson(8, 10);
  close(w.lo, 0.4901624715366418, 1e-9);
  close(w.hi, 0.9433178485456247, 1e-9);
  const z = S.wilson(0, 5);
  close(z.lo, 0, 1e-12);
  close(z.hi, 0.43448246478317476, 1e-9);
  const big = S.wilson(81, 263);
  close(big.lo, 0.2552885198782742, 1e-9);
  close(big.hi, 0.36620957698280004, 1e-9);
  assert.equal(S.wilson(0, 0), null);
});

const X = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const Y = [2.1, 2.9, 3.2, 4.8, 5.1, 5.0, 7.3, 7.9, 8.1, 9.6, 10.2, 11.9];

test("OLS matches scipy.stats.linregress", () => {
  const f = S.ols(X, Y);
  close(f.b, 0.8583916083916083, 1e-10);
  close(f.a, 0.9287878787878796, 1e-10);
  close(f.seB, 0.04232406394982024, 1e-10);
  close(f.ciB[0], 0.7640877171319652, 1e-7);
  close(f.ciB[1], 0.9526954996512514, 1e-7);
  close(f.p, 1.8719748975554174e-9, 1e-11);
  const [lo, hi] = S.olsBand(f, f.mx);
  close((lo + hi) / 2, f.a + f.b * f.mx, 1e-9);
});

test("cluster-robust (CR1) slope matches a numpy sandwich", () => {
  const g = ["a", "a", "a", "b", "b", "c", "c", "c", "d", "d", "e", "e"];
  const c = S.olsClustered(X, Y, g);
  assert.equal(c.clusters, 5);
  close(c.seB, 0.031256236332353665, 1e-9);
  close(c.ciB[0], 0.7716103840197396, 1e-7);
  close(c.ciB[1], 0.9451728327634775, 1e-7);
  close(c.p, 1.0455072449443762e-5, 1e-9);
  assert.equal(S.olsClustered(X, Y, X.map(() => "one")), null);
});

test("Spearman with ties matches scipy.stats.spearmanr", () => {
  close(S.spearman([1, 2, 2, 3, 5, 5, 5, 8], [3, 1, 4, 4, 6, 5, 9, 7]), 0.8706358081229184, 1e-12);
  assert.deepEqual(S.ranks([10, 20, 20, 5]), [2, 3.5, 3.5, 1]);
});

test("Gini, quantiles, terciles, BH", () => {
  close(S.gini([1, 2, 3, 4]), 0.25, 1e-12);
  close(S.gini([0, 0, 0, 1]), 0.75, 1e-12);
  close(S.gini([5, 5, 5]), 0, 1e-12);
  assert.equal(S.gini([0, 0]), null);
  assert.equal(S.gini([3]), null);
  close(S.quantile([1, 2, 3, 4], 0.5), 2.5);
  close(S.quantile([1, 2, 3, 4], 0.25), 1.75); // numpy default
  const t = S.terciles([5, 1, 9, 3, 7, 2, 8]);
  assert.deepEqual(t.map((g) => g.length), [3, 2, 2]);
  assert.deepEqual(t[0].sort(), [1, 3, 5]);
  // BH: p.adjust(c(.01,.04,.03,.2), "BH") = .04 .0533 .0533 .2
  S.benjaminiHochberg([0.01, 0.04, 0.03, 0.2]).forEach((q, i) => close(q, [0.04, 0.16 / 3, 0.16 / 3, 0.2][i], 1e-12));
  close(S.minDetectableR(100), Math.tanh(2.8015852 / Math.sqrt(97)), 1e-6); // (z.975 + z.80) / sqrt(n - 3)
});

test("degenerate input never gives NaN", () => {
  for (const xs of [[], [1], [1, 1], [2, 2, 2, 2]]) {
    const ys = xs.map((_, i) => i);
    assert.equal(S.ols(xs, ys), null);
    assert.equal(S.spearman(xs, ys), null);
    assert.equal(S.spearmanPerm(xs, ys, 50), null);
    assert.equal(S.clusterPermSpearman(xs, ys, xs.map((_, i) => `c${i}`), 50), null);
    assert.ok(S.mean(xs) === null || Number.isFinite(S.mean(xs)));
  }
  assert.deepEqual(S.terciles([]), [[], [], []]);
  const rc = S.roleConcentration([[3, 0, 0]], 3, 50);
  assert.ok(rc.results.every((r) => r.observed === null && r.p === null));
  assert.deepEqual(S.niceTicks(1, 1), [1]);
});

test("permutation p is deterministic, bounded, and small for a strong effect", () => {
  const xs = Array.from({ length: 40 }, (_, i) => i);
  const ys = xs.map((x) => x + 3 * Math.sin(x));
  const a = S.spearmanPerm(xs, ys, 999, 5);
  const b = S.spearmanPerm(xs, ys, 999, 5);
  assert.equal(a.p, b.p);
  close(a.p, 1 / 1000, 1e-12);
  const r = S.rng(3);
  const noise = xs.map(() => r());
  const n = S.spearmanPerm(xs, noise, 999, 5);
  assert.ok(n.p > 0 && n.p <= 1);
});

test("role concentration: specialists sit above the shuffle band, generalists inside it", () => {
  const spec = Array.from({ length: 30 }, (_, i) => [0, 1, 2].map((r) => (r === i % 3 ? 40 : 2)));
  const s = S.roleConcentration(spec, 3, 300, 1);
  for (const r of s.results) {
    assert.ok(r.observed > r.hi, `specialists ${r.observed} > ${r.hi}`);
    assert.ok(r.p < 0.01);
  }
  const R = S.rng(9);
  const gen = Array.from({ length: 30 }, () => {
    const c = [0, 0, 0];
    for (let k = 0; k < 40; k++) c[Math.floor(R() * 3)]++;
    return c;
  });
  const g = S.roleConcentration(gen, 3, 300, 1);
  assert.ok(g.results.filter((r) => r.p < 0.05).length <= 1);
});

test("role concentration within strata: group differences alone are not 'specialisation'", () => {
  // children only forage/explore, adults also care; nobody specialises within their group
  const R = S.rng(4);
  const draw = (w) => {
    const c = [0, 0, 0];
    for (let k = 0; k < 40; k++) {
      let u = R() * w.reduce((a, b) => a + b, 0);
      let j = 0;
      while (u >= w[j]) u -= w[j++];
      c[j]++;
    }
    return c;
  };
  const counts = [...Array.from({ length: 30 }, () => draw([1, 1, 0])), ...Array.from({ length: 30 }, () => draw([1, 1, 2]))];
  const strata = counts.map((_, i) => (i < 30 ? "child" : "adult"));
  const pooled = S.roleConcentration(counts, 3, 300, 1);
  assert.ok(pooled.results[2].p < 0.01, "unstratified shuffle flags caregiving");
  const strat = S.roleConcentration(counts, 3, 300, 1, strata);
  assert.equal(strat.strata, 2);
  assert.ok(strat.results[2].p > 0.05, `stratified caregiving p = ${strat.results[2].p}`);
});

test("Kaplan-Meier with delayed entry and martingale residuals match lifelines / direct risk sets", () => {
  // reference: lifelines 0.30 KaplanMeierFitter(entry=...), residuals from explicit risk sets (tests/ comments in ref)
  const entry = [0, 0, 0, 0, 0, 0, 14, 14, 14, 0, 0, 14];
  const exit = [2, 5, 5, 16, 30, 40, 20, 30, 55, 9, 60, 25.5];
  const ev = [1, 1, 0, 1, 1, 0, 1, 1, 1, 0, 1, 0];
  const spells = entry.map((e, i) => ({ entry: e, exit: exit[i], event: ev[i] === 1 }));
  const km = S.kaplanMeier(spells);
  assert.deepEqual(km.slice(1).map((s) => s.t), [2, 5, 16, 20, 30, 55, 60]);
  [0.875, 0.75, 0.65625, 0.5625, 0.3375, 0.16875, 0].forEach((v, i) => close(km[i + 1].s, v, 1e-12, `S(${km[i + 1].t})`));
  close(S.kmAt(km, 25), 0.5625, 1e-12);
  const M = S.martingaleResiduals(spells);
  [0.875, 0.7321428571428572, -0.26785714285714285, 0.6071428571428572, 0.06428571428571433, -0.9357142857142857, 0.7321428571428572, 0.3321428571428572, -0.16785714285714282, -0.26785714285714285, -1.4357142857142857, -0.26785714285714285].forEach((v, i) => close(M[i], v, 1e-12, `M[${i}]`));
  close(M.reduce((a, b) => a + b, 0), 0, 1e-12, "residuals sum to 0");
  const x = [0.3, -1.2, 0.5, 1.1, -0.4, 0.9, -2.0, 0.1, 1.7, -0.6, 2.2, 0.0];
  close(S.clusterPermCorr(x, M, x.map((_, i) => `f${i % 6}`), { B: 100 }).stat, -0.5397786942759605, 1e-12, "log-rank trend r");
});

test("family permutation: exact enumeration for few families, sequential stopping, fast ranks agree", () => {
  const xs = [-1, -0.9, 0.1, 0.2, 1, 1.1, 2, 2.1];
  const ys = [1, 2, 3, 4, 5, 6, 7, 8];
  const fam = ["a", "a", "b", "b", "c", "c", "d", "d"];
  const r = S.clusterPermSpearman(xs, ys, fam, 2000, 1);
  assert.equal(r.exact, true);
  assert.equal(r.B, 24); // 4! arrangements
  close(r.minP, 1 / 24, 1e-12);
  close(r.p, 1 / 24, 1e-12); // only the observed order is as extreme (reversed, the within-family slopes break rho = -1)
  // 3 families can never give p < 1/6: the page must not claim anything
  const three = S.clusterPermSpearman(xs.slice(0, 6), ys.slice(0, 6), fam.slice(0, 6), 2000, 1);
  assert.ok(three.p >= 1 / 6 && three.exact);
  // sequential: a null test stops early with p = hits / used
  const R = S.rng(2);
  const nx = Array.from({ length: 200 }, () => R());
  const ny = Array.from({ length: 200 }, () => R());
  const nf = nx.map((_, i) => `f${i % 40}`);
  const seq = S.clusterPermSpearman(nx, ny, nf, { B: 5000, stopAfter: 50 }, 3);
  assert.ok(seq.B < 5000 && Math.abs(seq.p - 50 / seq.B) < 1e-12);
  // the fast rank path gives the same rho as the reference Spearman (with ties at the +-2.5 clip)
  const tx = nx.map((v, i) => (i % 7 === 0 ? 2.5 : v));
  close(S.clusterPermSpearman(tx, ny, nf, 10, 1).stat, S.spearman(tx, ny), 1e-12);
});

// ------------------------------------------------------------------ definitions

const life = (o) => ({
  lifeId: "r:1", runId: "r", agentId: "a01", lifeIndex: 1, playerId: 1, name: null, female: true, displayId: null, lineageId: "r:1",
  motherLifeId: null, motherPlayerId: null, generation: 2, traits: { t: 0 }, inherited: true, traitSource: "mock", bornAt: 0, ageAtBirth: 0,
  birthX: null, birthY: null, diedAt: null, ageAtDeath: null, deathReason: null, lostAt: null, presumedEndAt: null, status: "alive",
  childLifeIds: [], activity: {}, updatedAt: 0, ...o,
});

test("censoring and adulthood definitions", () => {
  const Y = A.YEAR_MS;
  assert.deepEqual(A.observedAge(life({ status: "dead", diedAt: 5 * Y, ageAtDeath: 5 }), 99 * Y), { age: 5, event: true });
  assert.deepEqual(A.observedAge(life({}), 10 * Y), { age: 10, event: false });
  assert.deepEqual(A.observedAge(life({ status: "lost", lostAt: 3 * Y }), 50 * Y), { age: 3, event: false });
  assert.equal(A.adultOutcome(life({}), 10 * Y), "too-young"); // alive child, born 10 years ago
  assert.equal(A.adultOutcome(life({}), 15 * Y), "yes");
  // complete cohorts only: a recent birth that already died is NOT counted (its surviving peers aren't either)
  assert.equal(A.adultOutcome(life({ status: "dead", diedAt: 2 * Y, ageAtDeath: 2 }), 3 * Y), "too-young");
  assert.equal(A.adultOutcome(life({ status: "dead", diedAt: 2 * Y, ageAtDeath: 2 }), 14 * Y), "no");
  assert.equal(A.adultOutcome(life({ status: "lost", lostAt: 4 * Y }), 40 * Y), "lost");
  assert.equal(A.adultOutcome(life({ status: "lost", lostAt: 20 * Y }), 40 * Y), "yes");
  assert.deepEqual(A.spellOf(life({ ageAtBirth: 14, generation: 1, inherited: false, status: "dead", diedAt: 10 * Y, ageAtDeath: 24 }), 99 * Y), { entry: 14, exit: 24, event: true });
  assert.equal(A.adultOutcome(life({ ageAtBirth: 14, generation: 1, inherited: false }), 1), "born-adult");
  assert.equal(A.observedAge(life({}), 500 * Y).age, A.LIFESPAN_YEARS);
});

test("out-of-range traits are ignored; small samples get no fit or clustered CI", () => {
  assert.equal(A.traitOf(life({ traits: { t: 1e300 } }), "t"), null);
  assert.equal(A.traitOf(life({ traits: { t: 2.4 } }), "t"), 2.4);
  assert.equal(A.dataWindow([life({ traits: { t: 1e9, u: 0 } })]).outOfRange, 1);
  const edge = fixtureLives("edge");
  const s = A.q1Survival(edge.lives, edge.traitDims[0], edge.now, 50);
  assert.ok(s.curves.every((c) => c.min == null || (Math.abs(c.min) <= A.MAX_ABS_TRAIT && Math.abs(c.max) <= A.MAX_ABS_TRAIT)));
  // two mothers: the sandwich SE would collapse to 0, so no clustered CI
  const fam = [
    life({ lifeId: "m1", lineageId: "m1", traits: { t: -1 } }), life({ lifeId: "m2", lineageId: "m2", traits: { t: 1 } }),
    ...[0, 1, 2].map((i) => life({ lifeId: `a${i}`, lineageId: "m1", motherLifeId: "m1", traits: { t: -1 + i * 0.1 } })),
    ...[0, 1, 2].map((i) => life({ lifeId: `b${i}`, lineageId: "m2", motherLifeId: "m2", traits: { t: 1 + i * 0.1 } })),
  ];
  const h = A.q4Heredity(fam, "t");
  assert.equal(h.mothers, 2);
  assert.ok(h.fit);
  assert.equal(h.clustered, null);
});

test("role counts avoid double counting", () => {
  const a = { moves: 4, tilesWalked: 99, maxDistFromBirth: 9, forage: 6, reflexForage: 2, eat: 5, pickUp: 1, drop: 2, craft: 3, wear: 1, babyPickups: 2, feeds: 1, says: 7, saysHeard: 6, actions: 0, thoughts: 0, failedActions: 0 };
  assert.deepEqual(A.roleCounts(a), [4, 5, 6, 3, 7]);
  assert.equal(A.roleShares({ ...a, moves: 0, forage: 0, reflexForage: 0, pickUp: 0, drop: 0, craft: 0, wear: 0, babyPickups: 0, feeds: 0, says: 0 }), null);
});

test("analyses cope with no data, one life and all-equal traits", () => {
  const dims = ["t"];
  const empty = [];
  const one = [life({ status: "dead", diedAt: 1, ageAtDeath: 20 })];
  const same = Array.from({ length: 10 }, (_, i) => life({ lifeId: `r:${i}`, lineageId: `r:${i % 3}`, status: "dead", ageAtDeath: i, diedAt: i * A.YEAR_MS }));
  for (const L of [empty, one, same]) {
    const s = A.q1Survival(L, "t", 1e9, 50);
    assert.equal(s.test, null);
    for (const c of s.curves) for (const v of [...c.steps.map((x) => x.s), ...c.atRisk]) assert.ok(Number.isFinite(v));
    const ad = A.q1Adulthood(L, "t", 1e9, 50);
    assert.equal(ad.trend, null);
    for (const b of ad.bars) assert.ok(b.n === 0 ? b.p === null : Number.isFinite(b.p));
    assert.equal(A.q2Descendants(L, "t", 1e9, 50).children, null);
    const q3 = A.q3Roles(L, dims, { B: 50, shuffles: 50 });
    assert.ok(q3.cells.every((c) => c.p === null));
    assert.equal(A.q4Heredity(L, "t").fit, null);
    A.q4Trajectories(L, "t").forEach((t) => t.points.forEach((p) => assert.ok(Number.isFinite(p.mean))));
    const v = A.verdict(A.traitTests({}, null), 0, 0);
    assert.equal(v.state, "too-small");
  }
});

test("analyses run on the fixtures and the CSV has one row per life", () => {
  for (const name of ["live1", "edge"]) {
    const r = fixtureLives(name);
    const dims = r.traitDims;
    const q3 = A.q3Roles(r.lives, dims, { B: 50, shuffles: 50 });
    assert.equal(q3.cells.length, dims.length * A.ROLES.length);
    for (const d of dims) {
      A.q1Survival(r.lives, d, r.now, 50);
      A.q1Adulthood(r.lives, d, r.now, 50);
      A.q2Descendants(r.lives, d, r.now, 50);
      A.q4Heredity(r.lives, d);
    }
    const csv = livesCsv(r.lives, dims, r.now);
    assert.equal(csv.trim().split("\n").length, r.lives.length + 1);
  }
});

// ------------------------------------------------------------------ synthetic: planted effects and nulls

test("synthetic generator is deterministic and plausible", () => {
  const a = generateSynthetic({ n: 400, seed: 1 });
  const b = generateSynthetic({ n: 400, seed: 1 });
  assert.deepEqual(a.lives, b.lives);
  assert.equal(a.lives.length, 400);
  const kids = a.lives.filter((l) => l.motherLifeId);
  assert.ok(kids.length > 200);
  // inheritance: child - mother ~ N(0, 0.15) (clipped)
  const byId = new Map(a.lives.map((l) => [l.lifeId, l]));
  const d0 = a.traitDims[0];
  const diffs = kids.map((k) => k.traits[d0] - byId.get(k.motherLifeId).traits[d0]);
  close(S.sd(diffs), 0.15, 0.03, "mutation sd");
  const h = A.q4Heredity(a.lives, d0);
  assert.ok(h.fit.ciB[0] < 1.02 && h.fit.ciB[1] > 0.95, "mother-child slope ~ 1");
  assert.ok(a.lives.some((l) => l.status === "alive") && a.lives.some((l) => l.status === "lost") && a.lives.some((l) => l.status === "dead"));
});

test("planted effects are detected at n = 400 (family-aware permutation)", () => {
  const s = generateSynthetic({ n: 400, seed: 1, effects: PLANTED });
  const dims = s.traitDims;
  const adult = A.q1Adulthood(s.lives, dims[EFFECT_DIM.survival], s.now, 1000);
  assert.ok(adult.trend.stat > 0 && adult.trend.p < 0.05, `survival p = ${adult.trend.p}`);
  const fert = A.q2Descendants(s.lives, dims[EFFECT_DIM.fertility], s.now, 1000);
  assert.ok(fert.children.stat > 0 && fert.children.p < 0.05, `fertility p = ${fert.children.p}`);
  const q3 = A.q3Roles(s.lives, dims, { B: 1000, shuffles: 200 });
  const soc = q3.cells.find((c) => c.dim === dims[EFFECT_DIM.social] && c.role === "socialising");
  assert.ok(soc.rho > 0 && soc.p < 0.05, `social p = ${soc.p}`);
  const care = q3.cells.find((c) => c.dim === dims[EFFECT_DIM.care] && c.role === "caregiving");
  assert.ok(care.rho > 0 && care.p < 0.05, `care p = ${care.p}`);
  // power over seeds: the survival effect is found in most worlds
  let hits = 0;
  const seeds = 12;
  for (let seed = 10; seed < 10 + seeds; seed++) {
    const w = generateSynthetic({ n: 400, seed, effects: PLANTED });
    if (A.q1Adulthood(w.lives, w.traitDims[EFFECT_DIM.survival], w.now, 400).trend.p < 0.05) hits++;
  }
  assert.ok(hits / seeds >= 0.5, `power ${hits}/${seeds}`);
});

test("a null world gives roughly uniform p (and naive shuffling would not)", () => {
  const fam = [];
  const naive = [];
  for (let seed = 1; seed <= 60; seed++) {
    const w = generateSynthetic({ n: 400, seed, effects: NO_EFFECTS });
    const d = w.traitDims[w.traitDims.length - 1];
    const a = A.q1Adulthood(w.lives, d, w.now, 300);
    fam.push(a.trend.p);
    const xs = [];
    const ys = [];
    for (const l of w.lives) {
      const o = A.adultOutcome(l, w.now);
      if (o === "yes" || o === "no") {
        xs.push(l.traits[d]);
        ys.push(o === "yes" ? 1 : 0);
      }
    }
    naive.push(S.spearmanPerm(xs, ys, 300, 3).p);
  }
  const frac = (ps, a) => ps.filter((p) => p < a).length / ps.length;
  assert.ok(frac(fam, 0.05) <= 0.12, `family-aware false positives ${frac(fam, 0.05)}`);
  assert.ok(frac(fam, 0.5) > 0.3 && frac(fam, 0.5) < 0.7, `family-aware median-ish ${frac(fam, 0.5)}`);
  close(S.mean(fam), 0.5, 0.1, "mean null p");
  // documents why the page does not shuffle individuals: families share outcomes
  assert.ok(frac(naive, 0.05) > frac(fam, 0.05), `naive ${frac(naive, 0.05)} vs family ${frac(fam, 0.05)}`);
});

test("banner verdict switches with n and significance", () => {
  const bh = (ps) => S.benjaminiHochberg(ps).map((q, i) => ({ label: `t${i}`, p: ps[i], q }));
  assert.equal(A.verdict(bh([0.001]), 10, 20).state, "too-small");
  assert.equal(A.verdict(bh([0.001]), 200, 3).state, "too-small"); // n is big but only 3 families
  assert.equal(A.verdict(bh([0.3, 0.6]), 200, 20).state, "none");
  const v = A.verdict(bh([0.0001, 0.5, 0.7]), 200, 20);
  assert.equal(v.state, "some");
  assert.equal(v.significant.length, 1);
  // traitTests pools per-trait results and the Q3 matrix under one BH
  const s = generateSynthetic({ n: 120, seed: 4 });
  const per = Object.fromEntries(s.traitDims.map((d) => [d, A.perDim(s.lives, d, s.now, 100)]));
  const tests = A.traitTests(per, A.q3Roles(s.lives, s.traitDims, { B: 100, shuffles: 50 }));
  assert.ok(tests.length > s.traitDims.length * 3);
  assert.ok(tests.every((x) => x.q >= x.p && x.q <= 1));
});

// ------------------------------------------------------------------ independent reference values (numpy / scipy / lifelines)

test("synthetic n = 400 seed 1 matches the Python reference", () => {
  // computed from the exported lives with scipy.stats.spearmanr, lifelines KaplanMeierFitter(entry=)
  // and explicit risk-set martingale residuals; every value agreed to < 1e-14
  const s = generateSynthetic({ n: 400, seed: 1, effects: PLANTED });
  const surv = A.q1Survival(s.lives, "curiosity", s.now, 50, 0);
  close(surv.test.stat, -0.27043133089874183, 1e-12, "log-rank trend r");
  assert.deepEqual(surv.curves.map((c) => [c.n, c.deaths]), [[134, 122], [133, 102], [133, 111]]);
  const ad = A.q1Adulthood(s.lives, "curiosity", s.now, 50);
  assert.equal(ad.n, 348);
  close(ad.trend.stat, 0.3752850758690617, 1e-12);
  const q2 = A.q2Descendants(s.lives, "diligence", s.now, 50);
  assert.equal(q2.closed, 118);
  close(q2.children.stat, 0.37252669700584423, 1e-12);
});

test("Q2 tests only use women whose counts are final", () => {
  const Y = A.YEAR_MS;
  const now = 100 * Y;
  const mk = (id, o) => life({ lifeId: id, lineageId: id, female: true, ...o });
  const L = [
    mk("dead", { status: "dead", bornAt: 0, ageAtDeath: 50, diedAt: 50 * Y }),
    mk("old", { bornAt: 50 * Y }), // alive, 50 now: past 40
    mk("young", { bornAt: 80 * Y }), // alive, 20 now: still open
  ];
  const r = A.q2Descendants(L, "t", now, 10);
  assert.deepEqual(r.rows.map((x) => [x.lifeId, x.closed]).sort(), [["dead", true], ["old", true], ["young", false]]);
  assert.equal(r.closed, 2);
});

test("whole page copes with n = 0, 1, 2, all-equal traits and 20 arbitrary trait names", () => {
  const Y = A.YEAR_MS;
  const names = Array.from({ length: 20 }, (_, i) => (i === 3 ? "a very long trait name that goes on and on" : i === 7 ? "Ünïcode → trait" : `dim_${i}`));
  const s = generateSynthetic({ n: 150, seed: 3, dims: names });
  const cases = [
    { lives: [], dims: names },
    { lives: s.lives.slice(0, 1), dims: names },
    { lives: s.lives.slice(0, 2), dims: names },
    { lives: Array.from({ length: 12 }, (_, i) => life({ lifeId: `r:${i}`, lineageId: `r:${i % 4}`, status: "dead", ageAtDeath: i + 1, diedAt: (i + 1) * Y, traits: { t: 0.5 } })), dims: ["t"] },
    { lives: s.lives, dims: names },
  ];
  for (const c of cases) {
    const res = A.computeStudy({ id: 1, lives: c.lives, dims: c.dims, now: c.lives.length ? Math.max(...c.lives.map((l) => l.updatedAt)) + Y : 0 });
    const walk = (v, path) => {
      if (typeof v === "number") assert.ok(!Number.isNaN(v), `NaN at ${path}`);
      else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
    };
    walk(res, `n=${c.lives.length}`);
    const tests = A.traitTests(res.per, res.q3);
    const v = A.verdict(tests, c.lives.length, new Set(c.lives.map((l) => l.lineageId)).size);
    assert.ok(["too-small", "none", "some"].includes(v.state));
  }
  // with 20 traits there are 180 tests; the permutation budget still lets a lone effect reach q < .05
  assert.ok(1 / (A.permBudget(20) + 1) <= 0.05 / (20 * A.TESTS_PER_TRAIT));
});
