#!/usr/bin/env node
// Build the OHOL art used by the browser renderer (viewer/src/ohol/).
//
//   node scripts/build-ohol-assets.mjs [--data <OneLifeData7 dir>] [--scope all|map] [--out <dir>]
//
// - Without --data, sparse-clones jasonrohrer/OneLifeData7 at DATA_REF (default OneLife_v437,
//   the same tag server/build.sh uses) into viewer/.ohol-cache/ and reuses it on later runs.
// - Converts sprites/*.tga and ground/*.tga to PNG (node:zlib, no npm deps).
// - Writes public/ohol/objects.json: per object, the sprite layers and the fields the renderer
//   needs, per sprite its size/anchor/blend, plus use-dummy -> parent mappings from
//   ../data/game-data.json.gz (the server's own object list, incl. generated dummies).
// - Genital and pubic-hair sprites (NUDITY_SPRITES) are never converted and are dropped from
//   every layer list, so they cannot be drawn.
//
// The art is public domain (OneLifeData7/no_copyright.txt).

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VIEWER = path.resolve(HERE, "..");
const REPO = path.resolve(VIEWER, "..");

export const DATA_REF = process.env.DATA_REF || "OneLife_v437";
const DATA_URL = "https://github.com/jasonrohrer/OneLifeData7.git";

// Sprites the game's own makeNudityMod.sh blanks are 592-600. We hide the genital subset:
// 595 Vagina2 (pubic-hair tuft, both sexes 11+/14+/16+), 596 Vagina1 (vulva line, all ages),
// 597 Penis1 + 599 Penis1Fill (age 0-14), 598 Penis2 + 600 Penis2Fill (14+).
// 592 Breasts / 593 BreastsFill and 594 Navel (also used as nipple dots) are kept.
export const NUDITY_SPRITES = new Set([595, 596, 597, 598, 599, 600]);

// ---------------------------------------------------------------- TGA -> RGBA

/** Decode a TGA (types 2 and 10, 24/32 bpp) to top-down RGBA. */
export function decodeTga(buf) {
  const idLen = buf[0];
  const cmapType = buf[1];
  const type = buf[2];
  const cmapLen = buf.readUInt16LE(5);
  const cmapDepth = buf[7];
  const w = buf.readUInt16LE(12);
  const h = buf.readUInt16LE(14);
  const bpp = buf[16];
  const desc = buf[17];
  if (type !== 2 && type !== 10) throw new Error(`unsupported TGA type ${type}`);
  if (bpp !== 24 && bpp !== 32) throw new Error(`unsupported TGA bpp ${bpp}`);
  const bytes = bpp / 8;
  let p = 18 + idLen + (cmapType ? cmapLen * Math.ceil(cmapDepth / 8) : 0);
  const n = w * h;
  const raw = Buffer.alloc(n * 4);
  const put = (i, o) => {
    raw[i * 4] = buf[o + 2];
    raw[i * 4 + 1] = buf[o + 1];
    raw[i * 4 + 2] = buf[o];
    raw[i * 4 + 3] = bytes === 4 ? buf[o + 3] : 255;
  };
  if (type === 2) {
    for (let i = 0; i < n; i++, p += bytes) put(i, p);
  } else {
    let i = 0;
    while (i < n) {
      const c = buf[p++];
      const count = (c & 0x7f) + 1;
      if (c & 0x80) {
        for (let k = 0; k < count; k++) put(i++, p);
        p += bytes;
      } else {
        for (let k = 0; k < count; k++, p += bytes) put(i++, p);
      }
    }
  }
  const topDown = (desc & 0x20) !== 0;
  const rightToLeft = (desc & 0x10) !== 0;
  const out = Buffer.alloc(n * 4);
  for (let y = 0; y < h; y++) {
    const sy = topDown ? y : h - 1 - y;
    for (let x = 0; x < w; x++) {
      const sx = rightToLeft ? w - 1 - x : x;
      raw.copy(out, (y * w + x) * 4, (sy * w + sx) * 4, (sy * w + sx) * 4 + 4);
    }
  }
  // Zero the colour of fully transparent pixels: invisible, and compresses better.
  for (let i = 0; i < n; i++) {
    if (out[i * 4 + 3] === 0) out.writeUInt32LE(0, i * 4);
  }
  return { w, h, data: out };
}

/**
 * Visible-content centre and size, as spriteBank.cpp computes them (alpha >= 64, C integer
 * division). Used for getObjectCenterOffset (held-object placement).
 */
export function visibleBounds({ w, h, data }) {
  let minX = w;
  let maxX = 0;
  let minY = h;
  let maxY = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] < 64) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  const idiv = (a, b) => Math.trunc(a / b);
  return {
    cx: idiv(maxX + minX, 2) - idiv(w, 2),
    cy: idiv(maxY + minY, 2) - idiv(h, 2),
    vw: maxX - minX,
    vh: maxY - minY,
  };
}

// ---------------------------------------------------------------- RGBA -> PNG

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** Encode top-down RGBA as PNG (colour type 6), adaptive per-row filters. */
export function encodePng(w, h, rgba) {
  const stride = w * 4;
  const out = Buffer.alloc((stride + 1) * h);
  const cand = Array.from({ length: 5 }, () => Buffer.alloc(stride));
  for (let y = 0; y < h; y++) {
    const row = rgba.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? rgba.subarray((y - 1) * stride, y * stride) : null;
    let best = 0;
    let bestSum = Infinity;
    for (let f = 0; f < 5; f++) {
      const c = cand[f];
      let sum = 0;
      for (let i = 0; i < stride; i++) {
        const a = i >= 4 ? row[i - 4] : 0;
        const b = prev ? prev[i] : 0;
        const cc = prev && i >= 4 ? prev[i - 4] : 0;
        let v;
        if (f === 0) v = row[i];
        else if (f === 1) v = row[i] - a;
        else if (f === 2) v = row[i] - b;
        else if (f === 3) v = row[i] - ((a + b) >> 1);
        else {
          const pp = a + b - cc;
          const pa = Math.abs(pp - a);
          const pb = Math.abs(pp - b);
          const pc = Math.abs(pp - cc);
          v = row[i] - (pa <= pb && pa <= pc ? a : pb <= pc ? b : cc);
        }
        v &= 0xff;
        c[i] = v;
        sum += v < 128 ? v : 256 - v;
      }
      if (sum < bestSum) {
        bestSum = sum;
        best = f;
      }
    }
    out[y * (stride + 1)] = best;
    cand[best].copy(out, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(out, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Minimal PNG decoder for our own output (tests only): colour type 6, 8-bit, no interlace. */
export function decodePng(buf) {
  let p = 8;
  let w = 0;
  let h = 0;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString("ascii", p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === "IHDR") {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
    } else if (type === "IDAT") idat.push(data);
    p += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * 4;
  const out = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    for (let i = 0; i < stride; i++) {
      const x = raw[y * (stride + 1) + 1 + i];
      const a = i >= 4 ? out[y * stride + i - 4] : 0;
      const b = y > 0 ? out[(y - 1) * stride + i] : 0;
      const c = y > 0 && i >= 4 ? out[(y - 1) * stride + i - 4] : 0;
      let pred = 0;
      if (f === 1) pred = a;
      else if (f === 2) pred = b;
      else if (f === 3) pred = (a + b) >> 1;
      else if (f === 4) {
        const pp = a + b - c;
        const pa = Math.abs(pp - a);
        const pb = Math.abs(pp - b);
        const pc = Math.abs(pp - c);
        pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[y * stride + i] = (x + pred) & 0xff;
    }
  }
  return { w, h, data: out };
}

// ---------------------------------------------------------------- object parsing

const num = (s) => Number.parseFloat(s);
const r3 = (v) => Math.round(v * 1000) / 1000;

/** Parse one objects/<id>.txt into a plain record (only what we need). */
export function parseObjectTxt(text) {
  const lines = text.split(/\r?\n/);
  const o = { id: 0, name: "", sprites: [] };
  const kv = {};
  let cur = null;
  let last = null; // [targetObject, key] for comma-list continuations
  const SPRITE_KEYS = ["pos", "rot", "hFlip", "color", "ageRange", "parent", "invisHolding", "invisWorn", "behindSlots", "invisCont"];
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    if (li === 1) {
      o.name = line;
      continue;
    }
    if (line.startsWith("spriteID=")) {
      cur = { id: Number.parseInt(line.slice(9), 10) };
      o.sprites.push(cur);
      last = null;
      continue;
    }
    // "a=1,b=2" style lines; list values continue after commas ("pos=1,2", "headIndex=3,4").
    for (const part of line.split(",")) {
      const eq = part.indexOf("=");
      if (eq < 0) {
        if (last) last[0][last[1]] += "," + part;
        continue;
      }
      const k = part.slice(0, eq);
      const v = part.slice(eq + 1);
      if (cur && SPRITE_KEYS.includes(k)) {
        cur[k] = v;
        last = [cur, k];
      } else {
        if (k === "headIndex") cur = null; // sprite block over
        kv[k] = v;
        last = [kv, k];
      }
    }
  }
  o.id = Number.parseInt(kv.id, 10);
  o.kv = kv;
  return o;
}

const indexList = (s) =>
  s === undefined || s === "" || s === "-1"
    ? []
    : s
        .split(",")
        .map((x) => Number.parseInt(x, 10))
        .filter((x) => x >= 0);

function hex(c) {
  return c
    .map((v) =>
      Math.max(0, Math.min(255, Math.round(v * 255)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("");
}

/** Use-dummy sprite visibility, ported from objectBank.cpp setupSpriteUseVis. Returns skip flags. */
export function useDummySkip(numSprites, vanish, appear, numUses, usesRemaining) {
  const skip = new Array(numSprites).fill(false);
  const vIdx = [];
  const aIdx = [];
  for (let s = 0; s < numSprites; s++) {
    if (vanish.has(s)) vIdx.push(s);
    if (appear.has(s)) aIdx.push(s);
  }
  if (usesRemaining === numUses) {
    for (const s of aIdx) skip[s] = true;
    return skip;
  }
  if (usesRemaining === 0) {
    for (const s of vIdx) skip[s] = true;
    return skip;
  }
  for (const s of aIdx) skip[s] = true;
  const d = usesRemaining;
  const nV = vIdx.length;
  if (nV > 0) {
    let left = Math.floor((d * nV) / numUses);
    const inLast = Math.floor(nV / numUses);
    let inFirst = Math.floor(((numUses - 1) * nV) / numUses);
    if (inLast === 0) {
      left += 1;
      inFirst += 1;
    }
    if (left > nV) left = nV;
    if (inFirst > nV) inFirst = nV;
    if (inFirst === nV && left > 1) left--;
    for (let v = left; v < nV; v++) skip[vIdx[v]] = true;
  }
  const nA = aIdx.length;
  if (nA > 0) {
    let invisLeft = Math.round((d * nA) / numUses);
    if (invisLeft > nA) invisLeft = nA;
    for (let v = 0; v < nA - invisLeft; v++) skip[aIdx[v]] = false;
  }
  return skip;
}

/** Compact JSON record for one object. Layer fields are omitted when default. */
function compactObject(o, spriteMeta) {
  const kv = o.kv;
  const head = new Set(indexList(kv.headIndex));
  const body = new Set(indexList(kv.bodyIndex));
  const bf = new Set(indexList(kv.backFootIndex));
  const ff = new Set(indexList(kv.frontFootIndex));
  const additive = new Set(indexList(kv.spritesAdditiveBlend));
  const behind = new Set(indexList(kv.spritesDrawnBehind));
  const keepIdx = [];
  o.sprites.forEach((s, i) => {
    if (!NUDITY_SPRITES.has(s.id) && spriteMeta.has(s.id)) keepIdx.push(i);
  });
  const remap = new Map(keepIdx.map((old, ni) => [old, ni]));
  const layers = keepIdx.map((i) => {
    const s = o.sprites[i];
    const [x, y] = (s.pos || "0,0").split(",").map(num);
    const L = { s: s.id, x: r3(x), y: r3(y) };
    const rot = num(s.rot || "0");
    if (rot) L.r = r3(rot);
    if (s.hFlip === "1") L.f = 1;
    const col = (s.color || "1,1,1").split(",").map(num);
    if (col.some((c) => Math.abs(c - 1) > 1e-6)) L.c = hex(col);
    const ar = (s.ageRange || "-1,-1").split(",").map(num);
    if (!(ar[0] === -1 && ar[1] === -1)) L.a = [r3(ar[0]), r3(ar[1])];
    // Walk up past dropped parents (none are dropped in practice: nudity sprites are leaves
    // or parent only other nudity sprites).
    let par = Number.parseInt(s.parent ?? "-1", 10);
    while (par >= 0 && !remap.has(par)) par = Number.parseInt(o.sprites[par]?.parent ?? "-1", 10);
    if (par >= 0) L.p = remap.get(par);
    if (s.invisHolding === "1") L.ih = 1;
    const iw = Number.parseInt(s.invisWorn || "0", 10);
    if (iw) L.iw = iw;
    if (s.behindSlots === "1") L.bs = 1;
    if (additive.has(i)) L.ad = 1;
    if (behind.has(i)) L.db = 1;
    let flags = 0;
    if (head.has(i)) flags |= 1;
    if (body.has(i)) flags |= 2;
    if (bf.has(i)) flags |= 4;
    if (ff.has(i)) flags |= 8;
    if (flags) L.bp = flags;
    return L;
  });
  const rec = { n: o.name, l: layers };
  const person = Number.parseInt((kv.person || "0").split("#")[0], 10);
  if (person) {
    rec.person = person;
    // Race letter is the last word of the description ("Female001 D").
    const m = /\s([A-Z])\s*$/.exec(o.name);
    if (m) rec.race = m[1];
    if (kv.male === "1") rec.male = 1;
    if (kv.noSpawn === "1") rec.noSpawn = 1;
  }
  if (kv.clothing && kv.clothing !== "n") {
    rec.cl = kv.clothing;
    const [cx, cy] = (kv.clothingOffset || "0,0").split(",").map(num);
    rec.co = [r3(cx), r3(cy)];
  }
  const [hx, hy] = (kv.heldOffset || "0,0").split(",").map(num);
  if (hx || hy) rec.ho = [r3(hx), r3(hy)];
  const hh = Number.parseInt(kv.heldInHand || "0", 10);
  if (hh) rec.hh = hh; // 1 = held in hand, 2 = ridden; 0 = held against the body
  if (kv.noFlip === "1") rec.noFlip = 1;
  if (kv.floor === "1") rec.floor = 1;
  const numUses = Number.parseInt((kv.numUses || "1").split(",")[0], 10);
  if (numUses > 1) {
    rec.uses = numUses;
    const vanish = new Set(indexList(kv.useVanishIndex));
    const appear = new Set(indexList(kv.useAppearIndex));
    // Skip lists in the *compacted* layer indices.
    const toCompact = (skip) =>
      skip.map((sk, i) => (sk && remap.has(i) ? remap.get(i) : -1)).filter((i) => i >= 0);
    const full = toCompact(useDummySkip(o.sprites.length, vanish, appear, numUses, numUses));
    if (full.length) rec.skip = full;
    rec._useSkip = (d) => toCompact(useDummySkip(o.sprites.length, vanish, appear, numUses, d));
  }
  return rec;
}

// ---------------------------------------------------------------- data fetch

function ensureData(dataArg) {
  if (dataArg) {
    const dir = path.resolve(dataArg);
    if (!fs.existsSync(path.join(dir, "objects"))) throw new Error(`${dir} has no objects/`);
    return dir;
  }
  const dir = path.join(VIEWER, ".ohol-cache", `OneLifeData7-${DATA_REF}`);
  if (fs.existsSync(path.join(dir, "objects")) && fs.existsSync(path.join(dir, "sprites"))) return dir;
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`== cloning OneLifeData7 @ ${DATA_REF} (sparse: objects, sprites, ground) into ${dir}`);
  const git = (...args) => execFileSync("git", args, { stdio: "inherit" });
  git("-c", "advice.detachedHead=false", "clone", "-q", "--depth", "1", "--branch", DATA_REF, "--filter=blob:none", "--sparse", DATA_URL, dir);
  git("-C", dir, "sparse-checkout", "set", "objects", "sprites", "ground");
  return dir;
}

// ---------------------------------------------------------------- main

function parseArgs(argv) {
  const a = { data: null, scope: "all", out: path.join(VIEWER, "public", "ohol") };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--data") a.data = argv[++i];
    else if (argv[i] === "--scope") a.scope = argv[++i];
    else if (argv[i] === "--out") a.out = path.resolve(argv[++i]);
    else if (!argv[i].startsWith("-") && !a.data) a.data = argv[i];
    else throw new Error(`unknown arg ${argv[i]}`);
  }
  if (!["all", "map"].includes(a.scope)) throw new Error("--scope must be all or map");
  return a;
}

function readGameData() {
  const p = path.join(REPO, "data", "game-data.json.gz");
  return JSON.parse(zlib.gunzipSync(fs.readFileSync(p)).toString("utf8"));
}

/**
 * --scope map: persons, clothing, anything with mapChance > 0, and everything a transition
 * can produce or consume (that is what can end up on a map tile or in a hand).
 */
function mapScope(gd) {
  const ids = new Set();
  for (const o of gd.objects) {
    if (o.person || o.clothing !== "n" || o.mapChance > 0) ids.add(o.parent || o.id);
  }
  const f = gd.transitionFields;
  const cols = ["actor", "target", "newActor", "newTarget"].map((k) => f.indexOf(k)).filter((i) => i >= 0);
  for (const t of gd.transitions) {
    for (const c of cols) {
      const v = Array.isArray(t) ? t[c] : t[f[c]];
      if (v > 0) ids.add(v);
    }
  }
  const byId = new Map(gd.objects.map((o) => [o.id, o]));
  for (const id of [...ids]) {
    const o = byId.get(id);
    if (o && o.parent) ids.add(o.parent);
  }
  return ids;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const data = ensureData(args.data);
  const gd = readGameData();
  const t0 = Date.now();

  const objDir = path.join(data, "objects");
  const sprDir = path.join(data, "sprites");
  const groundDir = path.join(data, "ground");

  // Sprite metadata: "<tag> <multiplicative> <anchorX> <anchorY>"
  const spriteMeta = new Map();
  for (const f of fs.readdirSync(sprDir)) {
    const m = /^(\d+)\.txt$/.exec(f);
    if (!m) continue;
    const id = Number(m[1]);
    if (NUDITY_SPRITES.has(id)) continue;
    if (!fs.existsSync(path.join(sprDir, `${id}.tga`))) continue;
    const t = fs.readFileSync(path.join(sprDir, f), "utf8").trim().split(/\s+/);
    spriteMeta.set(id, { n: t[0], m: t[1] === "1" ? 1 : 0, ax: Number(t[2]) || 0, ay: Number(t[3]) || 0 });
  }

  const wanted = args.scope === "map" ? mapScope(gd) : null;
  const objects = {};
  const useSkips = new Map();
  for (const f of fs.readdirSync(objDir)) {
    const m = /^(\d+)\.txt$/.exec(f);
    if (!m) continue;
    const o = parseObjectTxt(fs.readFileSync(path.join(objDir, f), "utf8"));
    if (wanted && !wanted.has(o.id)) continue;
    const rec = compactObject(o, spriteMeta);
    if (rec._useSkip) {
      useSkips.set(o.id, rec._useSkip);
      delete rec._useSkip;
    }
    objects[o.id] = rec;
  }

  // Use dummies (generated at load time by the game; ids come from the server dump).
  const dummies = {};
  for (const o of gd.objects) {
    if (!o.parent || o.parent === o.id || o.useIndex < 0) continue;
    const fn = useSkips.get(o.parent);
    if (!objects[o.parent] || !fn) continue;
    dummies[o.id] = [o.parent, fn(o.useIndex + 1)];
  }

  // Which sprites are referenced?
  const used = new Set();
  for (const rec of Object.values(objects)) for (const L of rec.l) used.add(L.s);

  fs.rmSync(args.out, { recursive: true, force: true });
  fs.mkdirSync(path.join(args.out, "sprites"), { recursive: true });
  fs.mkdirSync(path.join(args.out, "ground"), { recursive: true });

  let spriteBytes = 0;
  const sprites = {};
  for (const id of [...used].sort((a, b) => a - b)) {
    const meta = spriteMeta.get(id);
    const img = decodeTga(fs.readFileSync(path.join(sprDir, `${id}.tga`)));
    const png = encodePng(img.w, img.h, img.data);
    fs.writeFileSync(path.join(args.out, "sprites", `${id}.png`), png);
    spriteBytes += png.length;
    const vis = visibleBounds(img);
    sprites[id] = { n: meta.n, w: img.w, h: img.h, ax: meta.ax, ay: meta.ay, ...vis, ...(meta.m ? { m: 1 } : {}) };
  }

  const ground = [];
  let groundBytes = 0;
  if (fs.existsSync(groundDir)) {
    for (const f of fs.readdirSync(groundDir).sort()) {
      if (!f.endsWith(".tga")) continue;
      const img = decodeTga(fs.readFileSync(path.join(groundDir, f)));
      const png = encodePng(img.w, img.h, img.data);
      const name = f.replace(/\.tga$/, "");
      fs.writeFileSync(path.join(args.out, "ground", `${name}.png`), png);
      groundBytes += png.length;
      ground.push({ name, w: img.w, h: img.h });
    }
  }

  const manifest = {
    dataRef: DATA_REF,
    generatedBy: "viewer/scripts/build-ohol-assets.mjs",
    license: "OneLifeData7 art is public domain (no_copyright.txt)",
    hiddenSprites: [...NUDITY_SPRITES],
    sprites,
    objects,
    dummies,
    ground,
  };
  const json = JSON.stringify(manifest);
  fs.writeFileSync(path.join(args.out, "objects.json"), json);
  const mb = (b) => (b / 1024 / 1024).toFixed(1) + " MB";
  console.log(
    `== ohol assets (${args.scope}) -> ${path.relative(process.cwd(), args.out) || args.out}\n` +
      `   objects: ${Object.keys(objects).length} (+${Object.keys(dummies).length} use dummies)` +
      `, persons: ${Object.values(objects).filter((o) => o.person).length}` +
      `, clothing: ${Object.values(objects).filter((o) => o.cl).length}\n` +
      `   sprites: ${used.size} PNG, ${mb(spriteBytes)}\n` +
      `   ground: ${ground.length} PNG, ${mb(groundBytes)}\n` +
      `   objects.json: ${mb(json.length)} (${mb(zlib.gzipSync(json).length)} gzipped)\n` +
      `   total: ${mb(spriteBytes + groundBytes + json.length)} in ${((Date.now() - t0) / 1000).toFixed(1)} s`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
