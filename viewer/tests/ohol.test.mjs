// node --test tests/*.test.mjs   (Node >= 22.18 / 23.6: imports the .ts modules via type stripping)
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { decodePng, decodeTga, encodePng, parseObjectTxt, useDummySkip, visibleBounds } from "../scripts/build-ohol-assets.mjs";
import {
  FEMALE_POOL,
  LOOK_TABLE,
  MALE_HAIR_POOL,
  SPAWNABLE_PEOPLE,
  appearanceFor,
  hairColorForTraits,
  hairGreyAmount,
  hairTintAtAge,
  hexToRgb,
  lineageLook,
} from "../src/ohol/appearance.ts";
import { recolorHairPixels } from "../src/ohol/hairTint.ts";
import { NUDITY_SPRITES, composeObject, composePerson, opsBounds, personLayers } from "../src/ohol/compose.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIMS = ["openness", "conscientiousness", "extraversion", "agreeableness", "neuroticism"];

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function randTraits(r) {
  const o = {};
  for (const d of DIMS) {
    const g = Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
    o[d] = Math.max(-2.5, Math.min(2.5, g));
  }
  return o;
}
const dist = (a, b) => {
  const A = hexToRgb(a);
  const B = hexToRgb(b);
  return Math.hypot(A[0] - B[0], A[1] - B[1], A[2] - B[2]);
};
const relLum = (hex) => {
  const [r, g, b] = hexToRgb(hex).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

// ------------------------------------------------------------------ TGA -> PNG

function makeTga(w, h, pixels, { rle = false, topDown = false } = {}) {
  // pixels: top-down array of [r,g,b,a]
  const rows = [];
  for (let y = 0; y < h; y++) rows.push(pixels.slice(y * w, (y + 1) * w));
  if (!topDown) rows.reverse();
  const flat = rows.flat();
  const head = Buffer.alloc(18);
  head[2] = rle ? 10 : 2;
  head.writeUInt16LE(w, 12);
  head.writeUInt16LE(h, 14);
  head[16] = 32;
  head[17] = 8 | (topDown ? 0x20 : 0);
  const body = [];
  if (!rle) for (const [r, g, b, a] of flat) body.push(b, g, r, a);
  else
    for (const [r, g, b, a] of flat) body.push(0x00, b, g, r, a); // raw packets of 1
  return Buffer.concat([head, Buffer.from(body)]);
}

test("TGA (bottom-up, top-down, RLE) -> PNG round-trips pixel-exact", () => {
  const w = 5;
  const h = 3;
  const px = [];
  for (let i = 0; i < w * h; i++) px.push([i * 10, 255 - i * 7, (i * 37) % 256, i === 4 ? 0 : 128 + i]);
  for (const opts of [{}, { topDown: true }, { rle: true }]) {
    const img = decodeTga(makeTga(w, h, px, opts));
    assert.equal(img.w, w);
    assert.equal(img.h, h);
    const back = decodePng(encodePng(img.w, img.h, img.data));
    assert.deepEqual([...back.data], [...img.data]);
    // top-left pixel is px[0]; fully transparent pixel colour is zeroed
    assert.deepEqual([...img.data.subarray(0, 4)], px[0]);
    assert.deepEqual([...img.data.subarray(16, 20)], [0, 0, 0, 0]);
  }
  const png = encodePng(1, 1, Buffer.from([1, 2, 3, 4]));
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
});

test("visibleBounds matches spriteBank.cpp integer maths", () => {
  const w = 8;
  const h = 4;
  const data = Buffer.alloc(w * h * 4);
  for (const [x, y] of [
    [1, 1],
    [6, 2],
  ])
    data[(y * w + x) * 4 + 3] = 255;
  assert.deepEqual(visibleBounds({ w, h, data }), { cx: 3 - 4, cy: 1 - 2, vw: 5, vh: 1 });
});

test("object .txt parsing and use-dummy visibility", () => {
  const txt = [
    "id=7",
    "Thing# comment",
    "containSize=1.000000,vertSlotRot=0.000000",
    "numSprites=2",
    "spriteID=10",
    "pos=1.000000,-2.000000",
    "rot=0.250000",
    "hFlip=1",
    "color=1.000000,0.500000,0.000000",
    "ageRange=-1.000000,-1.000000",
    "parent=-1",
    "invisHolding=0,invisWorn=2,behindSlots=0",
    "spriteID=11",
    "pos=3.000000,4.000000",
    "rot=0.000000",
    "hFlip=0",
    "color=1.000000,1.000000,1.000000",
    "ageRange=3.000000,10.000000",
    "parent=0",
    "invisHolding=1,invisWorn=0,behindSlots=0",
    "spritesAdditiveBlend=0,1",
    "headIndex=1,0",
    "bodyIndex=-1",
    "numUses=3,1.000000",
    "useVanishIndex=0,1",
  ].join("\n");
  const o = parseObjectTxt(txt);
  assert.equal(o.id, 7);
  assert.equal(o.name, "Thing# comment");
  assert.equal(o.sprites.length, 2);
  assert.equal(o.sprites[0].pos, "1.000000,-2.000000");
  assert.equal(o.sprites[1].ageRange, "3.000000,10.000000");
  assert.equal(o.kv.spritesAdditiveBlend, "0,1");
  assert.equal(o.kv.headIndex, "1,0");
  assert.equal(o.kv.numUses, "3,1.000000");
  // 6 vanishing sprites over 6 uses: full shows all, d uses left shows d (minus the pull-down rule)
  const v = new Set([0, 1, 2, 3, 4, 5]);
  const shown = (d) => useDummySkip(6, v, new Set(), 6, d).filter((s) => !s).length;
  assert.equal(shown(6), 6);
  assert.equal(shown(0), 0);
  assert.ok(shown(1) >= 1 && shown(1) < shown(3) && shown(3) < shown(5) && shown(5) < 6);
});

// ------------------------------------------------------------------ appearance: colour

test("hairColorForTraits: valid, deterministic, continuous, readable band", () => {
  const r = rng(1);
  const lums = [];
  for (let i = 0; i < 300; i++) {
    const t = randTraits(r);
    const c = hairColorForTraits(t, DIMS);
    assert.match(c, /^#[0-9a-f]{6}$/);
    assert.equal(c, hairColorForTraits({ ...t }, DIMS));
    lums.push(relLum(c));
    // similar personality -> similar colour (Lipschitz-ish)
    const t2 = Object.fromEntries(Object.entries(t).map(([k, v]) => [k, v + (r() - 0.5) * 0.1]));
    assert.ok(dist(c, hairColorForTraits(t2, DIMS)) < 0.08, `jump at ${JSON.stringify(t)}`);
  }
  // readable lightness band: mid-tones only
  assert.ok(Math.min(...lums) > 0.18 && Math.max(...lums) < 0.55, `${Math.min(...lums)}..${Math.max(...lums)}`);
  // neutral personality is nearly unsaturated; strong ones differ by direction
  const neutral = hexToRgb(hairColorForTraits({}, DIMS));
  assert.ok(Math.max(...neutral) - Math.min(...neutral) < 0.1);
  const colours = DIMS.flatMap((d) => [hairColorForTraits({ [d]: 2.5 }, DIMS), hairColorForTraits({ [d]: -2.5 }, DIMS)]);
  for (let i = 0; i < colours.length; i++)
    for (let j = i + 1; j < colours.length; j++) assert.ok(dist(colours[i], colours[j]) > 0.05, `${colours[i]} ~ ${colours[j]}`);
  // trait set is swappable: any dims work
  assert.match(hairColorForTraits({ a: 1, b: -1 }, ["a", "b"]), /^#[0-9a-f]{6}$/);
});

test("hair greys with age", () => {
  assert.equal(hairGreyAmount(20), 0);
  assert.ok(hairGreyAmount(45) > 0 && hairGreyAmount(45) < hairGreyAmount(60));
  assert.equal(hairTintAtAge("#ff0000", 25), "#ff0000");
  // elders go silvery but keep a pastel of their personality colour
  const old = hexToRgb(hairTintAtAge("#ff0000", 70));
  const chroma = Math.max(...old) - Math.min(...old);
  assert.ok(chroma > 0.15 && chroma < 0.6, `chroma ${chroma}`);
  assert.ok(old[0] > old[1] && old[0] > old[2], "still reddish");
});

// ------------------------------------------------------------------ appearance: lineage

test("pools: 22 spawnable people, hair donors are same-sex", () => {
  assert.equal(SPAWNABLE_PEOPLE.length, 22);
  for (const l of LOOK_TABLE) {
    assert.ok(FEMALE_POOL.some((p) => p.id === l.femaleHairDonor));
    assert.ok(MALE_HAIR_POOL.some((p) => p.id === l.maleHairDonor));
  }
  const f = appearanceFor({ displayId: 19, female: true, lineageId: 5, traits: {}, traitDims: DIMS });
  const m = appearanceFor({ displayId: 347, female: false, lineageId: 5, traits: {}, traitDims: DIMS });
  assert.ok(FEMALE_POOL.some((p) => p.id === f.hairDonorId));
  assert.ok(MALE_HAIR_POOL.some((p) => p.id === m.hairDonorId));
  assert.equal(f.faceDonorId, m.faceDonorId, "one face per lineage");
});

test("appearance is deterministic from lineageId", () => {
  const input = { displayId: 19, female: true, lineageId: 1234, traits: { openness: 1 }, traitDims: DIMS };
  assert.deepEqual(appearanceFor(input), appearanceFor({ ...input }));
  assert.deepEqual(lineageLook("abc"), lineageLook("abc"));
  // different lineages usually differ even without coordination
  const slots = new Set(Array.from({ length: 50 }, (_, i) => lineageLook(i).slot));
  assert.ok(slots.size > 30);
});

test("lineage spread: 8 concurrent lineages all distinct; older looks are stable", () => {
  const r = rng(7);
  for (let trial = 0; trial < 200; trial++) {
    const ids = Array.from({ length: 8 }, () => Math.floor(r() * 1e6));
    if (new Set(ids).size < 8) continue;
    const looks = ids.map((id) => lineageLook(id, ids));
    for (const key of ["femaleHairDonor", "maleHairDonor", "faceDonor"])
      assert.equal(new Set(looks.map((l) => l[key])).size, 8, `${key} collides for ${ids}`);
    // a newer (higher id) lineage arriving never changes an existing one
    const newer = Math.max(...ids) + 1;
    for (const id of ids) assert.deepEqual(lineageLook(id, [...ids, newer]), lineageLook(id, ids));
  }
});

// ------------------------------------------------------------------ hair recolour pixels

test("recolorHairPixels: dark hair becomes visibly tinted, outline stays dark, alpha kept", () => {
  const w = 12;
  const h = 12;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 1; y < 11; y++)
    for (let x = 1; x < 11; x++) {
      const o = (y * w + x) * 4;
      const edge = x === 1 || y === 1 || x === 10 || y === 10;
      const v = edge ? 0 : 14; // near-black fill with a black outline
      data.set([v, v, v, 255], o);
    }
  const alpha = data.filter((_, i) => i % 4 === 3);
  recolorHairPixels(data, w, h, [0.2, 0.4, 0.9], { multiply: false });
  const at = (x, y) => [...data.subarray((y * w + x) * 4, (y * w + x) * 4 + 4)];
  assert.ok(at(5, 5)[2] > 120, `interior ${at(5, 5)}`);
  assert.ok(at(5, 5)[2] > at(5, 5)[0], "takes the tint's hue");
  assert.ok(at(1, 5)[2] < 40, `outline ${at(1, 5)}`);
  assert.deepEqual(
    [...data.filter((_, i) => i % 4 === 3)],
    [...alpha],
  );
  // multiply (line-art) sprites: white -> transparent, black strokes -> opaque tint
  const ml = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255]);
  recolorHairPixels(ml, 2, 1, [1, 0, 0], { multiply: true });
  assert.equal(ml[3], 0);
  assert.equal(ml[7], 255);
  assert.ok(ml[4] > 150 && ml[5] === 0);
});

// ------------------------------------------------------------------ composition (needs generated assets)

const manifestPath = path.join(HERE, "..", "public", "ohol", "objects.json");
const haveAssets = fs.existsSync(manifestPath);
const M = haveAssets ? JSON.parse(fs.readFileSync(manifestPath, "utf8")) : null;

test("no genital/pubic sprite is ever drawn, at any age, with any look", { skip: !haveAssets && "run npm run assets" }, () => {
  for (const id of NUDITY_SPRITES) assert.equal(M.sprites[id], undefined, `sprite ${id} exported`);
  const ids = Object.keys(M.objects).map(Number);
  for (const id of ids) for (const L of M.objects[id].l) assert.ok(!NUDITY_SPRITES.has(L.s), `object ${id}`);
  for (const p of SPAWNABLE_PEOPLE)
    for (const age of [0, 0.5, 2, 5, 11, 13, 14.5, 16, 25, 45, 60, 90]) {
      const ap = appearanceFor({ displayId: p.id, female: p.female, lineageId: p.id, traits: {}, traitDims: DIMS });
      for (const spec of [{ displayId: p.id, age }, { displayId: p.id, age, facingLeft: true, appearance: ap }])
        for (const op of composePerson(M, spec)) assert.ok(!NUDITY_SPRITES.has(op.sprite));
    }
});

test("graft: donor hair is re-anchored on the base head and flagged; base face kept when no face donor", { skip: !haveAssets }, () => {
  const L = personLayers(M, 19, 1007, undefined);
  const head = L.find((l) => (l.bp ?? 0) & 1);
  const hair = L.filter((l) => l.hair);
  assert.ok(hair.length > 0);
  assert.ok(hair.every((l) => /hair|beard/i.test(M.sprites[l.s].n)));
  assert.ok(hair.every((l) => /09/.test(M.sprites[l.s].n)), "only donor hair");
  assert.ok(L.some((l) => M.sprites[l.s].n === "Eyes001"), "own eyes kept");
  // donor back hair (drawn before the donor's body) stays behind the body
  const bodyIdx = L.findIndex((l) => (l.bp ?? 0) & 2);
  assert.ok(L.slice(0, bodyIdx).some((l) => l.hair));
  // every hair layer hangs (transitively) off the head
  const headIdx = L.indexOf(head);
  for (const h of hair) {
    let p = h.p;
    let guard = 0;
    while (p !== undefined && p >= 0 && p !== headIdx && guard++ < 50) p = L[p].p;
    assert.equal(p, headIdx);
  }
  // hair ops carry the tint, and the tint greys with age
  const ap = { hairDonorId: 1007, faceDonorId: 351, hairColor: "#3366cc", lookSlot: 0 };
  const young = composePerson(M, { displayId: 19, age: 25, appearance: ap }).filter((o) => o.hairTint);
  const old = composePerson(M, { displayId: 19, age: 60, appearance: ap }).filter((o) => o.hairTint);
  assert.ok(young.length && old.length);
  assert.equal(young[0].hairTint, "#3366cc");
  assert.notEqual(old[0].hairTint, "#3366cc");
});

test("flip mirrors x; clothing and held objects are placed", { skip: !haveAssets }, () => {
  const r = composePerson(M, { displayId: 19, age: 30 });
  const l = composePerson(M, { displayId: 19, age: 30, facingLeft: true });
  assert.equal(r.length, l.length);
  r.forEach((op, i) => assert.equal(l[i].x, -op.x));
  const dressed = composePerson(M, { displayId: 19, age: 30, clothing: { hat: 1117, tunic: 585, frontShoe: 203, backShoe: 203 }, heldObjectId: 33 });
  const extra = dressed.length - r.length;
  const expect =
    composeObject(M, 1117, { worn: true }).length +
    composeObject(M, 585, { worn: true }).length +
    2 * composeObject(M, 203, { worn: true }).length +
    composeObject(M, 33).length;
  assert.equal(extra, expect);
  // hat is drawn last before the held object and sits above the head
  const hatOp = dressed[dressed.length - 1 - composeObject(M, 33).length];
  assert.ok(hatOp.y > 150, `hat y ${hatOp.y}`);
  // babies are drawn lower (age offsets)
  const baby = composePerson(M, { displayId: 19, age: 0.5 });
  const headY = (ops) => ops.find((o) => o.sprite === 54).y;
  assert.ok(headY(baby) < headY(r) - 50);
});

test("lineage hairstyle survives ageing (no donor balding); tint greys instead", { skip: !haveAssets }, () => {
  for (const d of [...FEMALE_POOL, ...MALE_HAIR_POOL]) {
    const recipient = d.female ? 2404 : 3078;
    const ap = { hairDonorId: d.id, faceDonorId: recipient, hairColor: "#3366cc", lookSlot: 0 };
    const hairAt = (age) => composePerson(M, { displayId: recipient, age, appearance: ap }).filter((o) => o.hairTint);
    const sprites = (age) => hairAt(age).map((o) => o.sprite).sort().join(",");
    assert.equal(sprites(45), sprites(30), `${d.id} at 45`);
    assert.equal(sprites(60), sprites(30), `${d.id} at 60`);
    assert.notEqual(hairAt(60)[0].hairTint, hairAt(30)[0].hairTint);
  }
});

test("every hairstyle donor has normal-blend head hair at 25 (colour shows on dark skin)", { skip: !haveAssets }, () => {
  for (const d of [...FEMALE_POOL, ...MALE_HAIR_POOL]) {
    if (d.id === 2464) continue; // Hair018 line-art locks: recoloured as opaque strokes instead
    const L = personLayers(M, d.id);
    const head = L.findIndex((l) => (l.bp ?? 0) & 1);
    const adult = L.filter((l) => l.hair && /hair/i.test(M.sprites[l.s].n) && l.p === head && (!l.a || (25 >= l.a[0] && 25 < l.a[1])));
    assert.ok(adult.some((l) => !M.sprites[l.s].m), `${d.id} has no normal-blend adult hair`);
  }
});

test("opsBounds: visible box of draw ops, following drawOps' translate / rotate / flip / scale", () => {
  // 100x60 image, visible part 40x20 centred 10 px right / 5 px below the image centre; anchor at the image centre
  const m = { sprites: { 1: { n: "a", w: 100, h: 60, ax: 0, ay: 0, cx: 10, cy: 5, vw: 40, vh: 20 }, 2: { n: "shadow", w: 50, h: 50, ax: 0, ay: 0, cx: 0, cy: 0, vw: 50, vh: 50, m: 1 } } };
  const op = (o) => ({ sprite: 1, x: 0, y: 0, rot: 0, flip: false, color: null, blend: "normal", hairTint: null, ...o });
  const near = (b, e) => ["x0", "y0", "x1", "y1"].forEach((k) => assert.ok(Math.abs(b[k] - e[k]) < 1e-9, `${k}: ${b[k]} != ${e[k]}`));
  near(opsBounds(m, [op({})], 200, 300, 1), { x0: 190, y0: 295, x1: 230, y1: 315 });
  // op.y is y-up: 50 up moves the box 50 px up the screen; scale halves the size and offsets
  near(opsBounds(m, [op({ y: 50 })], 200, 300, 0.5), { x0: 195, y0: 272.5, x1: 215, y1: 282.5 });
  // flipped: mirrored around the anchor
  near(opsBounds(m, [op({ flip: true })], 200, 300, 1), { x0: 170, y0: 295, x1: 210, y1: 315 });
  // a quarter turn clockwise: (x, y) -> (-y, x) in y-down space
  near(opsBounds(m, [op({ rot: 0.25 })], 0, 0, 1), { x0: -15, y0: -10, x1: 5, y1: 30 });
  // union of ops; multiplicative sprites (shadows) and unknown sprites ignored
  near(opsBounds(m, [op({}), op({ x: 100 }), op({ sprite: 2, blend: "multiply" }), op({ sprite: 99 })], 0, 0, 1), { x0: -10, y0: -5, x1: 130, y1: 15 });
  assert.equal(opsBounds(m, [], 0, 0, 1), null);
  assert.equal(opsBounds(m, [op({ sprite: 2 })], 0, 0, 1), null);
});

test("opsBounds: a real tree is tall enough to cover an adult standing one tile behind it", { skip: !haveAssets && "run npm run assets" }, () => {
  const m = M;
  const S = 112 / 128;
  const tree = opsBounds(m, composeObject(m, 49), 0, 112, S); // Juniper one row in front (lower on screen)
  const person = opsBounds(m, composePerson(m, { displayId: 19, age: 30 }), 0, 0, S);
  assert.ok(tree && person);
  assert.ok(tree.y0 < person.y0, "canopy reaches above the head");
  assert.ok(tree.x0 < person.x0 && tree.x1 > person.x1);
});
