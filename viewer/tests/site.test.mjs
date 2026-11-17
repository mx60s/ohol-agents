// Research-site pure logic (src/site/logic.ts): trees, roles, PCA, percentiles, sorting.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  activityShares,
  buildForest,
  clampTrait,
  compareNullable,
  deriveRole,
  familyOf,
  loadingHint,
  matchesQuery,
  median,
  ordinal,
  pageSlice,
  pca2,
  pcaProject,
  percentileLabel,
  percentileRank,
  prevNext,
  settleStaleLives,
  sortBy,
  traitRow,
  traitShort,
  treeDepth,
  treeSize,
} from "../src/site/logic.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name, file) => JSON.parse(fs.readFileSync(path.join(HERE, "..", "fixtures", name, file), "utf8"));
const DIMS = ["openness", "conscientiousness", "extraversion", "agreeableness", "neuroticism"];

const L = (id, mother, bornAt, extra = {}) => ({ lifeId: id, motherLifeId: mother, bornAt, lineageId: "eve", ...extra });

test("clampTrait: finite and within +-2.5", () => {
  assert.equal(clampTrait(1.2), 1.2);
  assert.equal(clampTrait(1e300), 2.5);
  assert.equal(clampTrait(-1e12), -2.5);
  assert.equal(clampTrait(NaN), null);
  assert.equal(clampTrait(null), null);
  assert.equal(clampTrait(undefined), null);
});

test("traitShort / traitRow", () => {
  assert.equal(traitShort("conscientiousness"), "Consc");
  assert.equal(traitShort("agreeableness"), "Agree");
  assert.equal(traitShort("risk_taking"), "Risk T");
  assert.deepEqual(traitRow({ a: 1, b: 9 }, ["a", "b"]), [1, 2.5]);
  assert.equal(traitRow({ a: 1 }, ["a", "b"]), null);
  assert.equal(traitRow(null, ["a"]), null);
});

test("median, percentileRank, labels", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.equal(median([]), null);
  const all = [1, 2, 3, 4, 5];
  assert.equal(percentileRank(1, all), 10);
  assert.equal(percentileRank(3, all), 50);
  assert.equal(percentileRank(5, all), 90);
  assert.equal(percentileRank(2, [2, 2, 2, 2]), 50);
  assert.equal(percentileRank(1, []), null);
  assert.equal(percentileLabel(10, 5), "lowest");
  assert.equal(percentileLabel(90, 5), "highest");
  assert.equal(percentileLabel(50, 5), "50th pct");
  assert.equal(percentileLabel(null, 5), "");
  assert.equal(ordinal(1), "1st");
  assert.equal(ordinal(22), "22nd");
  assert.equal(ordinal(13), "13th");
  assert.equal(ordinal(103), "103rd");
});

test("buildForest: tree from motherLifeId, birth order, unknown mothers become roots", () => {
  const lives = [L("c2", "eve", 30), L("eve", null, 0), L("c1", "eve", 10), L("g1", "c1", 50), L("x", "not-ours", 5)];
  const f = buildForest(lives);
  assert.deepEqual(
    f.map((n) => n.life.lifeId),
    ["eve", "x"],
  );
  assert.deepEqual(
    f[0].children.map((n) => n.life.lifeId),
    ["c1", "c2"],
  );
  assert.equal(f[0].children[0].children[0].life.lifeId, "g1");
  assert.equal(f[0].children[0].children[0].depth, 2);
  assert.equal(treeSize(f[0]), 4);
  assert.equal(treeDepth(f[0]), 3);
});

test("buildForest: cycles and self-mothers don't loop or drop lives", () => {
  const lives = [L("a", "b", 1), L("b", "a", 2), L("s", "s", 3)];
  const f = buildForest(lives);
  const ids = [];
  const walk = (n) => (ids.push(n.life.lifeId), n.children.forEach(walk));
  f.forEach(walk);
  assert.deepEqual(ids.sort(), ["a", "b", "s"]);
});

test("buildForest on the edge fixture places every life once", () => {
  const lives = fixture("edge", "lives.json").lives;
  const f = buildForest(lives);
  assert.equal(
    f.reduce((s, n) => s + treeSize(n), 0),
    lives.length,
  );
});

test("familyOf + prevNext", () => {
  const lives = [L("eve", null, 0), L("a", "eve", 10), L("b", "eve", 20), L("c", "eve", 30), L("k", "b", 40), L("eve2", null, 5)];
  const fam = familyOf(lives[2], lives);
  assert.equal(fam.mother.lifeId, "eve");
  assert.deepEqual(
    fam.siblings.map((l) => l.lifeId),
    ["a", "b", "c"],
  );
  assert.deepEqual(
    fam.children.map((l) => l.lifeId),
    ["k"],
  );
  const pn = prevNext(lives[2], lives);
  assert.equal(pn.prev.lifeId, "a");
  assert.equal(pn.next.lifeId, "c");
  assert.equal(prevNext(lives[1], lives).prev, null);
  // Eves step through the other motherless lives
  assert.equal(prevNext(lives[0], lives).next.lifeId, "eve2");
});

test("activity shares and role derivation", () => {
  assert.equal(deriveRole(null), null);
  assert.equal(deriveRole({ moves: 3 }), null); // too few to say
  assert.equal(deriveRole({ moves: 40, forage: 5, says: 3 }), "explorer");
  assert.equal(deriveRole({ babyPickups: 10, feeds: 12, moves: 4 }), "caregiver");
  assert.equal(deriveRole({ says: 30, moves: 2 }), "talker");
  assert.equal(deriveRole({ craft: 20, drop: 5, moves: 3 }), "maker");
  assert.equal(deriveRole({ moves: 10, forage: 10, says: 10, craft: 9 }), "generalist");
  const s = activityShares({ moves: 3, forage: 1, eat: 0, says: 4, tilesWalked: 999 });
  assert.equal(s[0].group, "socialising");
  assert.equal(
    Math.round(s.reduce((t, x) => t + x.share, 0) * 1e9),
    1e9,
  );
  assert.deepEqual(activityShares({}), []);
  // negative / NaN counters are ignored
  assert.equal(deriveRole({ moves: -50, says: NaN, forage: 9 }), "forager");
});

test("pca2: finds the dominant axis, deterministic sign, projections centred", () => {
  // points along (1, 1, 0) with a little noise on dim 3
  const rows = [];
  for (let i = -5; i <= 5; i++) rows.push([i * 0.3, i * 0.3, (i % 2) * 0.05]);
  const p = pca2(rows);
  assert.ok(p);
  const [c1] = p.components;
  assert.ok(Math.abs(Math.abs(c1[0]) - Math.SQRT1_2) < 0.01);
  assert.ok(Math.abs(Math.abs(c1[1]) - Math.SQRT1_2) < 0.01);
  assert.ok(c1[0] > 0 && c1[1] > 0, "largest loading made positive");
  assert.ok(p.explained[0] > 0.99);
  assert.ok(p.explained[0] + p.explained[1] <= 1 + 1e-9);
  const proj = rows.map((r) => pcaProject(p, r));
  const mx = proj.reduce((s, q) => s + q[0], 0) / proj.length;
  assert.ok(Math.abs(mx) < 1e-9);
  // components orthogonal
  const dot = p.components[0].reduce((s, x, i) => s + x * p.components[1][i], 0);
  assert.ok(Math.abs(dot) < 1e-6);
  assert.equal(loadingHint(c1, ["openness", "agreeableness", "z"]), "+Openn +Agree");
  assert.equal(pca2([[1, 2]]), null);
  assert.equal(pca2([[1], [2]]), null);
});

test("pca2 on the live fixture traits", () => {
  const lives = fixture("live1", "lives.json").lives;
  const rows = lives.map((l) => traitRow(l.traits, DIMS)).filter(Boolean);
  const p = pca2(rows);
  assert.ok(p && p.explained[0] >= p.explained[1]);
});

test("sorting: nulls last both ways, strings case-insensitive, stable", () => {
  assert.ok(compareNullable(1, 2) < 0);
  assert.ok(compareNullable(1, 2, "desc") > 0);
  assert.ok(compareNullable(null, 2) > 0);
  assert.ok(compareNullable(null, 2, "desc") > 0);
  assert.ok(compareNullable("abc", "ABD") < 0);
  const xs = [{ k: 2, i: 0 }, { k: null, i: 1 }, { k: 1, i: 2 }, { k: 2, i: 3 }];
  assert.deepEqual(
    sortBy(xs, (x) => x.k).map((x) => x.i),
    [2, 0, 3, 1],
  );
  assert.deepEqual(
    sortBy(xs, (x) => x.k, "desc").map((x) => x.i),
    [0, 3, 2, 1],
  );
});

test("matchesQuery + pageSlice", () => {
  assert.ok(matchesQuery("zoe", "🔥 Zoë 💀"));
  assert.ok(matchesQuery("", null));
  assert.ok(!matchesQuery("hope", "Eve Moss", null));
  const xs = Array.from({ length: 250 }, (_, i) => i);
  assert.deepEqual(pageSlice(xs, 0, 100).rows.length, 100);
  const last = pageSlice(xs, 9, 100);
  assert.equal(last.page, 2);
  assert.equal(last.rows.length, 50);
  assert.equal(pageSlice([], 3, 10).pages, 1);
});

test("settleStaleLives: 'alive' lives from an older run read as lost; same array when nothing to do", () => {
  const lives = [
    { lifeId: "a", runId: "r2", status: "alive", lostAt: null, updatedAt: 5 },
    { lifeId: "b", runId: "r1", status: "alive", lostAt: null, updatedAt: 3 },
    { lifeId: "c", runId: "r1", status: "dead", lostAt: null, updatedAt: 2 },
  ];
  const out = settleStaleLives(lives, "r2");
  assert.deepEqual(out.map((l) => l.status), ["alive", "lost", "dead"]);
  assert.equal(out[1].lostAt, 3);
  assert.equal(out[0], lives[0]);
  assert.equal(settleStaleLives(lives, null), lives);
  assert.equal(settleStaleLives(lives.slice(0, 1), "r2").length, 1);
  const cur = lives.slice(0, 1);
  assert.equal(settleStaleLives(cur, "r2"), cur);
});
