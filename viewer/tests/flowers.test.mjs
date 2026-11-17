// Per-person flowers: shared catalogue, viewer fallback assignment, palette vs hair colours, placement.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { FLOWER_COLORS, FLOWER_SHAPES, FLOWER_VARIANTS, LEGACY_FLOWER_SHAPES, pickFlower } from "../src/flowers.ts";
import { FLOWER_ART, flowerFor, flowersForLives, flowerSizeAtAge, recolorFlowerPixels } from "../src/ohol/flower.ts";
import { ELDER_HAIR, appearanceFor, hairGreyAmount, hexToRgb, mixHex, oklchToHex, SPAWNABLE_PEOPLE, FEMALE_POOL, MALE_HAIR_POOL } from "../src/ohol/appearance.ts";
import { composePerson } from "../src/ohol/compose.ts";
import zlib from "node:zlib";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIMS = ["openness", "conscientiousness", "extraversion", "agreeableness", "neuroticism"];
const key = (f) => `${f.shape}|${f.color}`;

test("the catalogue is shared verbatim with the agents service", { skip: !fs.existsSync(path.join(HERE, "../../agents/src/flowers.ts")) }, () => {
  assert.equal(fs.readFileSync(path.join(HERE, "../src/flowers.ts"), "utf8"), fs.readFileSync(path.join(HERE, "../../agents/src/flowers.ts"), "utf8"));
});

test("every shape has art; 11 shapes (5 real OHOL sprites + 6 generated) x 7 colours = 77", () => {
  for (const s of FLOWER_SHAPES) {
    const art = FLOWER_ART[s.id];
    assert.ok(art, s.id);
    assert.ok((art.sprite !== undefined) !== (art.image !== undefined), `${s.id}: exactly one of sprite / image`);
  }
  assert.equal(FLOWER_SHAPES.filter((s) => FLOWER_ART[s.id].sprite !== undefined).length, 5);
  assert.equal(FLOWER_SHAPES.filter((s) => FLOWER_ART[s.id].image !== undefined).length, 6);
  assert.equal(FLOWER_COLORS.length, 7);
  assert.equal(FLOWER_VARIANTS, 77);
  assert.equal(FLOWER_VARIANTS, FLOWER_SHAPES.length * FLOWER_COLORS.length);
  assert.equal(new Set(FLOWER_SHAPES.map((s) => s.id)).size, FLOWER_SHAPES.length, "unique shape ids");
  assert.equal(new Set(FLOWER_SHAPES.map((s) => s.name)).size, FLOWER_SHAPES.length, "unique shape names");
  assert.equal(new Set(FLOWER_COLORS.map((c) => c.id)).size, FLOWER_COLORS.length, "unique colour ids");
  // stale art entries for retired shapes are gone
  for (const id of Object.keys(FLOWER_ART)) assert.ok(FLOWER_SHAPES.some((s) => s.id === id), id);
});

test("old shape ids still render: daisy / tulip keep their ids, bellflower -> lily", () => {
  const rec = (shape, color, label) => ({ shape, color, label });
  assert.deepEqual(flowerFor({ lifeId: "r:1", flower: rec("daisy", "white", "white daisy") }), rec("daisy", "white", "white daisy"));
  assert.deepEqual(flowerFor({ lifeId: "r:1", flower: rec("tulip", "red", "red tulip") }), rec("tulip", "red", "red tulip"));
  assert.deepEqual(flowerFor({ lifeId: "r:1", flower: rec("bell", "blue", "blue bellflower") }), rec("lily", "blue", "blue lily"));
  const m = flowersForLives([{ lifeId: "r:1", lineageId: "r:1", bornAt: 0, diedAt: null, flower: rec("bell", "purple", "purple bellflower") }]);
  assert.deepEqual(m.get("r:1"), rec("lily", "purple", "purple lily"));
  for (const [from, to] of Object.entries(LEGACY_FLOWER_SHAPES)) {
    assert.ok(!FLOWER_ART[from], `${from} is retired`);
    assert.ok(FLOWER_ART[to], `${from} -> ${to} has art`);
  }
});

// ------------------------------------------------------------------ generated sprite files

/** Minimal PNG decoder (8-bit RGBA, non-interlaced: what the generated sprites are). */
function readPng(file) {
  const buf = fs.readFileSync(file);
  assert.equal(buf.toString("latin1", 1, 4), "PNG");
  let pos = 8;
  let w = 0;
  let h = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("latin1", pos + 4, pos + 8);
    const body = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      w = body.readUInt32BE(0);
      h = body.readUInt32BE(4);
      assert.equal(body[8], 8, "8-bit");
      assert.equal(body[9], 6, "RGBA");
      assert.equal(body[12], 0, "not interlaced");
    } else if (type === "IDAT") idat.push(body);
    pos += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const out = new Uint8Array(w * h * 4); // wraps mod 256, as PNG filters need
  const stride = w * 4;
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? out[y * stride + x - 4] : 0;
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = x >= 4 && y > 0 ? out[(y - 1) * stride + x - 4] : 0;
      const p = a + b - c;
      const pr = Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c;
      const v = line[x];
      out[y * stride + x] = f === 0 ? v : f === 1 ? v + a : f === 2 ? v + b : f === 3 ? v + ((a + b) >> 1) : v + pr;
    }
  }
  return { w, h, data: out };
}

const FLOWER_DIR = path.join(HERE, "..", "public", "flowers");

test("generated sprites: files exist, small trimmed RGBA, white petals that tint to the flower colour", () => {
  for (const s of FLOWER_SHAPES) {
    const art = FLOWER_ART[s.id];
    if (!art.image) continue;
    const { w, h, data } = readPng(path.join(FLOWER_DIR, art.image));
    assert.ok(Math.max(w, h) === 64 && Math.min(w, h) >= 40, `${s.id}: ${w}x${h}`);
    let clear = 0;
    let solid = 0;
    for (let i = 3; i < data.length; i += 4) data[i] === 0 ? clear++ : data[i] >= 200 && solid++;
    assert.ok(clear > 0.1 * w * h && solid > 0.3 * w * h, `${s.id}: transparent background, solid flower`);
    // touches the edges (trimmed)
    const alphaAt = (x, y) => data[(y * w + x) * 4 + 3];
    const rowHas = (y) => Array.from({ length: w }, (_, x) => alphaAt(x, y)).some((a) => a > 0);
    const colHas = (x) => Array.from({ length: h }, (_, y) => alphaAt(x, y)).some((a) => a > 0);
    assert.ok(rowHas(0) && rowHas(h - 1) && colHas(0) && colHas(w - 1), `${s.id}: trimmed`);
    // tinted blue: most non-ink petal pixels become blue
    const d = new Uint8ClampedArray(data);
    recolorFlowerPixels(d, w, h, hexToRgb(FLOWER_COLORS.find((c) => c.id === "blue").hex), { keepCentre: art.keepCentre });
    let blue = 0;
    let opaque = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 200) continue;
      opaque++;
      if (d[i + 2] > d[i] + 40 && d[i + 2] > d[i + 1] + 40) blue++;
    }
    assert.ok(blue > 0.4 * opaque, `${s.id}: ${blue}/${opaque} blue`);
    for (let i = 3; i < d.length; i += 4) assert.equal(d[i], data[i], "alpha unchanged");
  }
});

test("keepCentre: the generated daisy keeps its yellow centre on blue, browns it on yellow petals", () => {
  const { w, h, data } = readPng(path.join(FLOWER_DIR, FLOWER_ART.daisy.image));
  const centre = (d) => {
    const o = (Math.floor(h / 2) * w + Math.floor(w / 2)) * 4;
    return [d[o], d[o + 1], d[o + 2]];
  };
  const blue = new Uint8ClampedArray(data);
  recolorFlowerPixels(blue, w, h, [0.1, 0.27, 0.89], { keepCentre: true });
  const [r, g, b] = centre(blue);
  assert.ok(r > 150 && g > 120 && b < 120, `yellow centre kept: ${[r, g, b]}`);
  const yellow = new Uint8ClampedArray(data);
  recolorFlowerPixels(yellow, w, h, [1, 0.93, 0.21], { keepCentre: true, warmPetals: true });
  const [r2, g2, b2] = centre(yellow);
  assert.ok(r2 < 160 && g2 < 110 && b2 < 60, `brown centre on yellow: ${[r2, g2, b2]}`);
});

test("flowerFor: deterministic from lifeId; the record's flower wins", () => {
  const a = flowerFor({ lifeId: "r1:15", lineageId: "r1:3" });
  assert.deepEqual(flowerFor({ lifeId: "r1:15", lineageId: "r1:3" }), a);
  const ids = Array.from({ length: 40 }, (_, i) => `r1:${100 + i}`);
  assert.ok(new Set(ids.map((id) => key(flowerFor({ lifeId: id })))).size > 20, "different lives, different flowers");
  const rec = { shape: "tulip", color: "blue", label: "blue tulip" };
  assert.deepEqual(flowerFor({ lifeId: "r1:15", flower: rec }), rec);
  // unknown ids (a newer catalogue) fall back instead of drawing nothing
  assert.ok(FLOWER_ART[flowerFor({ lifeId: "r1:15", flower: { shape: "orchid", color: "teal", label: "x" } }).shape]);
});

test("flowerFor: living family members never share a variant (6, 30, 56 members)", () => {
  for (const n of [6, 30, 56]) {
    const fam = Array.from({ length: n }, (_, i) => `run7:${10 + i * 3}`);
    const fl = fam.map((id) => flowerFor({ lifeId: id, lineageId: "run7:10", livingFamilyLifeIds: fam }));
    assert.equal(new Set(fl.map(key)).size, n, `${n} members`);
    if (n <= Math.min(FLOWER_SHAPES.length, FLOWER_COLORS.length)) {
      assert.equal(new Set(fl.map((f) => f.shape)).size, n, "small families: all shapes differ");
      assert.equal(new Set(fl.map((f) => f.color)).size, n, "small families: all colours differ");
    }
  }
});

test("flowerFor: a newcomer never changes an older member's flower; oldest keep theirs", () => {
  const fam = ["run7:10", "run7:14", "run7:20", "run7:31"];
  const before = fam.map((id) => flowerFor({ lifeId: id, livingFamilyLifeIds: fam }));
  const joined = [...fam, "run7:40", "run7:41"];
  const after = fam.map((id) => flowerFor({ lifeId: id, livingFamilyLifeIds: joined }));
  assert.deepEqual(after, before);
  // order of the list doesn't matter (oldest = smallest player id)
  assert.deepEqual(fam.map((id) => flowerFor({ lifeId: id, livingFamilyLifeIds: [...joined].reverse() })), before);
  // the eldest is unaffected by anyone
  assert.deepEqual(before[0], flowerFor({ lifeId: "run7:10" }));
});

test("flowersForLives (records without flowers): unique among contemporaries, stable when others die or join", () => {
  const L = (pid, bornAt, diedAt = null) => ({ lifeId: `r:${pid}`, lineageId: "r:1", bornAt, diedAt });
  const lives = [L(1, 0, 500), L(2, 100), L(3, 150), L(4, 200), L(5, 260), L(6, 300), L(7, 320), L(8, 400)];
  const a = flowersForLives(lives);
  // everyone alive at the same time differs
  const alive = (t) => lives.filter((l) => l.bornAt <= t && (l.diedAt ?? Infinity) > t).map((l) => key(a.get(l.lifeId)));
  for (const t of [120, 330, 450, 600]) assert.equal(new Set(alive(t)).size, alive(t).length);
  // a death recorded later, and later births, change nobody's flower
  const b = flowersForLives([...lives.slice(0, 3), { ...lives[3], diedAt: 700 }, ...lives.slice(4), L(9, 800), L(10, 810)]);
  for (const l of lives) assert.deepEqual(b.get(l.lifeId), a.get(l.lifeId), l.lifeId);
  // record flowers are kept and avoided
  const rec = { shape: "daisy", color: "white", label: "white daisy" };
  const c = flowersForLives([{ ...L(1, 0), flower: rec }, L(2, 10)]);
  assert.deepEqual(c.get("r:1"), rec);
  assert.notEqual(key(c.get("r:2")), key(rec));
  // other lineages don't constrain
  assert.deepEqual(flowersForLives([L(2, 100), { ...L(99, 50), lineageId: "r:2" }]).get("r:2"), flowersForLives([L(2, 100)]).get("r:2"));
});

test("pickFlower with more living relatives than variants still returns a flower", () => {
  const taken = Array.from({ length: FLOWER_VARIANTS }, (_, v) => ({ shape: FLOWER_SHAPES[Math.floor(v / FLOWER_COLORS.length)].id, color: FLOWER_COLORS[v % FLOWER_COLORS.length].id }));
  assert.ok(pickFlower("x:1", taken).label);
});

// ------------------------------------------------------------------ palette vs hair colours

const lin = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
function oklab(hex) {
  const [r, g, b] = hexToRgb(hex).map(lin);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}

test("flower colours sit >= 0.07 OKLab away from every hair tint (any personality, any age)", () => {
  // the hair space: OKLCH L 0.66, chroma 0..0.17, every hue, greyed for elders (hairColorForTraits, hairTintAtAge)
  const hair = [];
  for (let h = 0; h < 360; h += 4)
    for (let c = 0; c <= 0.17; c += 0.01) {
      const x = oklchToHex(0.66, c, h);
      for (const age of [25, 40, 45, 50, 55, 60]) hair.push(oklab(mixHex(x, ELDER_HAIR, hairGreyAmount(age))));
    }
  for (const col of FLOWER_COLORS) {
    const p = oklab(col.hex);
    const d = Math.min(...hair.map((q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2])));
    assert.ok(d >= 0.07, `${col.name} ${col.hex}: ${d.toFixed(3)}`);
  }
  // and the colours are distinct from each other
  for (const a of FLOWER_COLORS)
    for (const b of FLOWER_COLORS) {
      if (a === b) continue;
      const p = oklab(a.hex);
      const q = oklab(b.hex);
      assert.ok(Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) > 0.1, `${a.name} vs ${b.name}`);
    }
});

test("recolorFlowerPixels: ink stays, petals take the tint, alpha unchanged", () => {
  // 3 px: black outline, pink petal, yellow centre
  const d = new Uint8ClampedArray([10, 10, 10, 255, 240, 120, 180, 255, 250, 220, 30, 200]);
  recolorFlowerPixels(d, 3, 1, [0, 0, 1], { keepCentre: true });
  assert.deepEqual([...d.slice(0, 4)], [10, 10, 10, 255]);
  assert.ok(d[6] > 100 && d[4] === 0 && d[5] === 0, "petal is blue");
  assert.deepEqual([...d.slice(8, 12)], [250, 220, 30, 200], "centre kept");
});

test("flower size: smaller for babies, full from 10", () => {
  assert.ok(flowerSizeAtAge(0.5) < flowerSizeAtAge(5));
  assert.ok(flowerSizeAtAge(5) < flowerSizeAtAge(10));
  assert.equal(flowerSizeAtAge(10), flowerSizeAtAge(60));
});

// ------------------------------------------------------------------ placement (needs generated assets)

const manifestPath = path.join(HERE, "..", "public", "ohol", "objects.json");
const haveAssets = fs.existsSync(manifestPath);
const M = haveAssets ? JSON.parse(fs.readFileSync(manifestPath, "utf8")) : null;

test("the flower is drawn last-but-held, on the head, at every age, facing and hairstyle", { skip: !haveAssets && "run npm run assets" }, () => {
  for (const s of FLOWER_SHAPES) if (FLOWER_ART[s.id].sprite !== undefined) assert.ok(M.sprites[FLOWER_ART[s.id].sprite], `sprite for ${s.id}`);
  const people = [...FEMALE_POOL.map((p) => [p.id, true]), ...MALE_HAIR_POOL.map((p) => [p.id, false]), [19, true], [347, false]];
  for (const [displayId, female] of people)
    for (const age of [0.5, 2, 5, 10, 15, 25, 45, 60])
      for (const facingLeft of [false, true]) {
        const ap = { ...appearanceFor({ displayId, female, lineageId: displayId, traits: {}, traitDims: DIMS, lifeId: `t:${displayId}` }), hairDonorId: displayId };
        const ops = composePerson(M, { displayId, age, facingLeft, appearance: ap });
        const fi = ops.findIndex((o) => o.flower);
        assert.ok(fi >= 0, "has a flower");
        assert.equal(fi, ops.length - 1, "drawn after hair, face and hat");
        const f = ops[fi];
        // the head sprite: the flower centre lies inside its visible box (sits on the head, never floats)
        const head = ops.find((o) => /^Head/.test(M.sprites[o.sprite]?.n ?? ""));
        const hs = M.sprites[head.sprite];
        const sx = head.flip ? -1 : 1;
        const cx = head.x + sx * (-hs.ax + hs.cx);
        const cy = head.y + hs.ay - hs.cy;
        assert.ok(Math.abs(f.x - cx) < hs.vw / 2 && Math.abs(f.y - cy) < hs.vh / 2, `${displayId} age ${age} ${facingLeft}`);
        // behind the face: toward the back of the head
        assert.ok(facingLeft ? f.x > cx : f.x < cx);
        assert.equal(f.flip, facingLeft);
      }
  // no lifeId and no flower -> none drawn (a family's generic look)
  const ap = appearanceFor({ displayId: 19, female: true, lineageId: 5, traits: {}, traitDims: DIMS });
  assert.ok(!composePerson(M, { displayId: 19, age: 25, appearance: ap }).some((o) => o.flower));
  assert.ok(SPAWNABLE_PEOPLE.length);
});

test("every shape sits on the head: centre inside the head's visible box, never bigger than the head", { skip: !haveAssets && "run npm run assets" }, () => {
  for (const s of FLOWER_SHAPES)
    for (const [displayId, female] of [[19, true], [347, false], [FEMALE_POOL[0].id, true], [MALE_HAIR_POOL[0].id, false]])
      for (const age of [0.5, 5, 25, 60])
        for (const facingLeft of [false, true]) {
          const ap = { ...appearanceFor({ displayId, female, lineageId: displayId, traits: {}, traitDims: DIMS, lifeId: `t:${displayId}` }), hairDonorId: displayId, flower: { shape: s.id, color: "red", label: "" } };
          const ops = composePerson(M, { displayId, age, facingLeft, appearance: ap });
          const f = ops[ops.length - 1];
          assert.equal(f.flower?.shape, s.id);
          const head = ops.find((o) => /^Head/.test(M.sprites[o.sprite]?.n ?? ""));
          const hs = M.sprites[head.sprite];
          const sx = head.flip ? -1 : 1;
          const cx = head.x + sx * (-hs.ax + hs.cx);
          const cy = head.y + hs.ay - hs.cy;
          const where = `${s.id} on ${displayId} age ${age} ${facingLeft ? "left" : "right"}`;
          assert.ok(Math.abs(f.x - cx) < hs.vw / 2 && Math.abs(f.y - cy) < hs.vh / 2, where);
          assert.ok(f.flower.size <= Math.max(hs.vw, hs.vh), `${where}: ${f.flower.size} vs head ${hs.vw}x${hs.vh}`);
          if (FLOWER_ART[s.id].sprite !== undefined) assert.equal(f.sprite, FLOWER_ART[s.id].sprite);
          else assert.equal(f.sprite, -1, "generated art: no OHOL sprite");
        }
});
