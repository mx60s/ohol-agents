import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalFlower, FLOWER_COLORS, FLOWER_SHAPES, FLOWER_VARIANTS, flowerLabel, isKnownFlower, LEGACY_FLOWER_SHAPES, pickFlower, type Flower } from "./flowers.ts";

const key = (f: Flower) => `${f.shape}|${f.color}`;

test("pickFlower is deterministic per lifeId and taken set", () => {
  assert.deepEqual(pickFlower("run1:10"), pickFlower("run1:10"));
  const taken = [pickFlower("run1:1"), pickFlower("run1:2")];
  assert.deepEqual(pickFlower("run1:10", taken), pickFlower("run1:10", taken));
  assert.ok(isKnownFlower(pickFlower("run1:10")));
  assert.equal(FLOWER_SHAPES.length, 11);
  assert.equal(FLOWER_VARIANTS, 77);
  const f = pickFlower("x");
  assert.equal(f.label, `${FLOWER_COLORS.find((c) => c.id === f.color)!.name} ${FLOWER_SHAPES.find((s) => s.id === f.shape)!.name}`);
});

test("pickFlower stays unique with many living relatives (30, then all 77)", () => {
  for (const n of [30, 77]) {
    const taken: Flower[] = [];
    for (let i = 0; i < n; i++) taken.push(pickFlower(`run1:${i}`, taken));
    assert.equal(new Set(taken.map(key)).size, n, `${n} distinct`);
  }
});

test("the first few relatives differ in both shape and colour", () => {
  const taken: Flower[] = [];
  for (let i = 0; i < 7; i++) taken.push(pickFlower(`run2:${i}`, taken));
  assert.equal(new Set(taken.map((f) => f.shape)).size, 7);
  assert.equal(new Set(taken.map((f) => f.color)).size, 7);
});

test("isKnownFlower rejects unknown ids and non-objects", () => {
  assert.equal(isKnownFlower(null), false);
  assert.equal(isKnownFlower({ shape: "orchid", color: "red", label: "red orchid" }), false);
  assert.equal(isKnownFlower({ shape: "rose", color: "teal", label: "teal rose" }), false);
});

test("catalogue: unique shape and colour ids and names", () => {
  for (const list of [FLOWER_SHAPES, FLOWER_COLORS]) {
    assert.equal(new Set(list.map((x) => x.id)).size, list.length);
    assert.equal(new Set(list.map((x) => x.name)).size, list.length);
  }
});

test("labels read naturally in observations", () => {
  assert.equal(flowerLabel("forgetmenot", "blue"), "blue forget-me-not");
  assert.equal(flowerLabel("iris", "purple"), "purple iris");
  assert.equal(flowerLabel("poppy", "orange"), "orange poppy");
  for (const s of FLOWER_SHAPES) assert.match(s.name, /^[a-z][a-z -]*[a-z]$/, s.id);
});

test("old shape ids: daisy and tulip keep their ids, bellflower -> lily (same colour, fresh label)", () => {
  assert.ok(isKnownFlower({ shape: "daisy", color: "white", label: "white daisy" }));
  assert.ok(isKnownFlower({ shape: "tulip", color: "red", label: "red tulip" }));
  assert.equal(isKnownFlower({ shape: "bell", color: "blue", label: "blue bellflower" }), false);
  assert.deepEqual(canonicalFlower({ shape: "bell", color: "blue", label: "blue bellflower" }), { shape: "lily", color: "blue", label: "blue lily" });
  const d = { shape: "daisy", color: "pink", label: "pink daisy" };
  assert.equal(canonicalFlower(d), d);
  for (const to of Object.values(LEGACY_FLOWER_SHAPES)) assert.ok(FLOWER_SHAPES.some((s) => s.id === to), to);
  assert.equal(canonicalFlower({ shape: "orchid", color: "red", label: "" }), null);
  assert.equal(canonicalFlower({ shape: "bell", color: "teal", label: "" }), null);
  assert.equal(canonicalFlower(null), null);
});
