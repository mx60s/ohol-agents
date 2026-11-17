import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_TRAIT_DIMS, TRAIT_CLIP, inheritTraits, parseTraitDims, sampleEveTraits, seededRng } from "./traits.ts";

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const sd = (xs: number[]) => {
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
};

test("parseTraitDims: default, custom, dedupe, invalid", () => {
  assert.deepEqual(parseTraitDims(undefined), DEFAULT_TRAIT_DIMS);
  assert.deepEqual(parseTraitDims("  "), DEFAULT_TRAIT_DIMS);
  assert.deepEqual(parseTraitDims("curiosity, caution ,curiosity,risk_taking"), ["curiosity", "caution", "risk_taking"]);
  assert.throws(() => parseTraitDims("ok,bad name"));
  assert.throws(() => parseTraitDims("__proto__x,1abc"));
});

test("Eve traits: every dim, clipped, ~N(0,1)", () => {
  const rng = seededRng(1);
  const dims = ["a", "b", "c"];
  const vals: number[] = [];
  for (let i = 0; i < 20000; i++) {
    const t = sampleEveTraits(dims, rng);
    assert.deepEqual(Object.keys(t), dims);
    for (const v of Object.values(t)) {
      assert.ok(Math.abs(v) <= TRAIT_CLIP);
      vals.push(v);
    }
  }
  assert.ok(Math.abs(mean(vals)) < 0.02, `mean ${mean(vals)}`);
  // clipping at 2.5 shaves a little off the SD (~0.99)
  assert.ok(Math.abs(sd(vals) - 1) < 0.03, `sd ${sd(vals)}`);
  assert.ok(vals.some((v) => Math.abs(v) > 2), "tails present");
});

test("child traits: mother + N(0, 0.15) per dim (mutation statistics)", () => {
  const rng = seededRng(42);
  const dims = DEFAULT_TRAIT_DIMS;
  const mother = { openness: 0.3, conscientiousness: -1.1, extraversion: 0, agreeableness: 1.2, neuroticism: -0.4 };
  const diffs: number[] = [];
  for (let i = 0; i < 20000; i++) {
    const { traits, inherited } = inheritTraits(mother, dims, 0.15, rng);
    assert.equal(inherited, true);
    for (const d of dims) diffs.push(traits[d] - mother[d as keyof typeof mother]);
  }
  assert.ok(Math.abs(mean(diffs)) < 0.005, `mean diff ${mean(diffs)}`);
  assert.ok(Math.abs(sd(diffs) - 0.15) < 0.005, `sd diff ${sd(diffs)}`);
});

test("child traits are clipped at the bounds", () => {
  const rng = seededRng(7);
  for (let i = 0; i < 2000; i++) {
    const { traits } = inheritTraits({ x: 2.5, y: -2.5 }, ["x", "y"], 0.15, rng);
    assert.ok(traits.x <= TRAIT_CLIP && traits.y >= -TRAIT_CLIP);
  }
});

test("unknown mother falls back to Eve sampling, inherited=false", () => {
  const r = inheritTraits(null, ["a", "b"], 0.15, seededRng(3));
  assert.equal(r.inherited, false);
  assert.deepEqual(Object.keys(r.traits), ["a", "b"]);
});

test("dimension the mother lacks is sampled fresh", () => {
  const rng = seededRng(9);
  const vals: number[] = [];
  for (let i = 0; i < 5000; i++) vals.push(inheritTraits({ a: 2 }, ["a", "new"], 0.15, rng).traits.new);
  assert.ok(Math.abs(mean(vals)) < 0.05 && sd(vals) > 0.9);
});
