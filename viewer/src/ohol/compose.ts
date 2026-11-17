// Pure scene composition: object/person records -> a flat list of sprite draw ops, following the
// game client (animationBank.cpp drawObjectAnim, objectBank.cpp, ageControl.cpp) for a still
// frame. No DOM here; render.ts executes the ops on a canvas.

import type { Appearance } from "./appearance.ts";
import { hairTintAtAge } from "./appearance.ts";
import type { Clothing, Layer, ObjectRec, OholManifest } from "./types.ts";

export type Blend = "normal" | "multiply" | "additive";

export interface DrawOp {
  sprite: number;
  /** anchor position in y-up object space, relative to the drawn object's origin (unscaled px) */
  x: number;
  y: number;
  /** turns, positive = clockwise */
  rot: number;
  flip: boolean;
  /** colour multiply "rrggbb" (no '#'), or null */
  color: string | null;
  blend: Blend;
  /** hair recolour tint "#rrggbb" (replaces the sprite's own colours), or null */
  hairTint: string | null;
  /** hair sprite that is multiplicative in the game; recoloured into an alpha sprite (see hairTint.ts) */
  hairLines?: boolean;
}

/** Genital/pubic sprites. Already removed by the asset build; filtered again here regardless. */
export const NUDITY_SPRITES: ReadonlySet<number> = new Set([595, 596, 597, 598, 599, 600]);

/** Lineage hairstyles keep the donor sprites of this age at older ages (see composePerson). Every male donor has a full head of hair at 15-35 (35-40 is already receding) and its 30-40 beard; female styles run 15-40. */
export const HAIR_STYLE_MAX_AGE = 34.9;

const HEAD = 1;
const BODY = 2;
const BACK_FOOT = 4;
const FRONT_FOOT = 8;

const isHairName = (n: string) => /hair|beard/i.test(n);
const isFaceName = (n: string) => /eyes|mouth/i.test(n) && !/anchor/i.test(n);

export function resolveObject(m: OholManifest, id: number): { rec: ObjectRec; skip: Set<number> } | null {
  const d = m.dummies[id];
  if (d) {
    const rec = m.objects[d[0]];
    return rec ? { rec, skip: new Set(d[1]) } : null;
  }
  const rec = m.objects[id];
  return rec ? { rec, skip: new Set(rec.skip ?? []) } : null;
}

function rotate(x: number, y: number, turnsCcw: number): [number, number] {
  const a = 2 * Math.PI * turnsCcw;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [x * c - y * s, x * s + y * c];
}

function layerOp(m: OholManifest, L: Layer, x: number, y: number, flipH: boolean, extraRot = 0): DrawOp {
  const sm = m.sprites[L.s];
  const noFlipSprite = flipH && !!sm && /NoFlip/.test(sm.n);
  let rot = L.r ?? 0;
  if (flipH) rot = -rot;
  return {
    sprite: L.s,
    x,
    y,
    rot: rot + extraRot,
    flip: (flipH && !noFlipSprite) !== !!L.f,
    color: L.c ?? null,
    blend: L.ad ? "additive" : sm?.m ? "multiply" : "normal",
    hairTint: null,
  };
}

export interface ObjectOpts {
  flipH?: boolean;
  /** drawn as worn clothing (hides invisWorn=1 layers, shows invisWorn=2 layers) */
  worn?: boolean;
  /** object rotation in turns (clockwise) */
  rot?: number;
}

/** Ops for a non-person object (or a person at its unaged default). */
export function composeObject(m: OholManifest, id: number, opts: ObjectOpts = {}): DrawOp[] {
  const r = resolveObject(m, id);
  if (!r) return [];
  const { rec, skip } = r;
  const flipH = !!opts.flipH && !rec.noFlip;
  const inRot = opts.rot ?? 0;
  const ops: DrawOp[] = [];
  rec.l.forEach((L, i) => {
    if (skip.has(i) || NUDITY_SPRITES.has(L.s) || !m.sprites[L.s]) return;
    if (rec.cl && L.iw) {
      if (opts.worn && L.iw === 1) return;
      if (!opts.worn && L.iw === 2) return;
    }
    let x = flipH ? -L.x : L.x;
    let y = L.y;
    if (inRot) [x, y] = rotate(x, y, -inRot);
    ops.push(layerOp(m, L, x, y, flipH, inRot));
  });
  return ops;
}

/** getObjectCenterOffset (objectBank.cpp): centre of the widest non-multiplicative sprite. */
export function objectCenterOffset(m: OholManifest, rec: ObjectRec): [number, number] {
  let best = -1;
  let bestW = 0;
  let bestY = 0;
  rec.l.forEach((L, i) => {
    const sm = m.sprites[L.s];
    if (!sm || sm.m || L.iw === 2) return;
    let w = sm.vw;
    const ra = Math.abs(L.r ?? 0) - Math.floor(Math.abs(L.r ?? 0));
    if (ra === 0.25 || ra === 0.75) w = sm.vh;
    if (best < 0 || w > bestW || (w === bestW && L.y < bestY)) {
      best = i;
      bestW = w;
      bestY = L.y;
    }
  });
  if (best < 0) return [0, 0];
  const L = rec.l[best];
  const sm = m.sprites[L.s];
  const [cx, cy] = rotate(sm.cx, sm.cy, L.r ?? 0);
  return [L.x + cx, L.y + cy];
}

// ------------------------------------------------------------------ appearance graft

interface PLayer extends Layer {
  hair?: boolean;
}

const graftCache = new Map<string, PLayer[]>();

function headDescendant(layers: Layer[], i: number, head: number): boolean {
  let p = layers[i].p;
  let guard = 0;
  while (p !== undefined && p >= 0 && guard++ < 200) {
    if (p === head) return true;
    p = layers[p].p;
  }
  return false;
}

/**
 * Base person layers with the hair/beard block from `hairDonor` and the eyes+mouth block from
 * `faceDonor` swapped in (all their age variants), re-anchored on the base head. Hair layers are
 * flagged for recolouring.
 */
export function personLayers(m: OholManifest, baseId: number, hairDonor?: number, faceDonor?: number): PLayer[] {
  const key = `${baseId}|${hairDonor ?? ""}|${faceDonor ?? ""}`;
  const hit = graftCache.get(key);
  if (hit) return hit;
  const base = m.objects[baseId];
  if (!base) return [];
  const name = (L: Layer) => m.sprites[L.s]?.n ?? "";
  const headOf = (rec: ObjectRec) => rec.l.findIndex((L) => (L.bp ?? 0) & HEAD);
  const bh = headOf(base);

  type Kind = "hair" | "face" | null;
  const kindOf = (rec: ObjectRec, i: number, h: number): Kind => {
    if (h < 0 || !headDescendant(rec.l, i, h)) return null;
    const n = name(rec.l[i]);
    if (isHairName(n)) return "hair";
    if (isFaceName(n)) return "face";
    return null;
  };

  // Donor layers of one kind, re-anchored on the base head. `back` = drawn before the donor's
  // body (long hair hanging behind the body); those go before the base body, the rest where the
  // base's first layer of that kind was (keeps e.g. eyes-under-hair ordering).
  interface Src {
    donor: number; // -1 = base
    idx: number; // index in its source object
    L: Layer;
    hair: boolean;
  }
  const donorLayers = (donorId: number | undefined, kind: Exclude<Kind, null>): { back: Src[]; front: Src[] } | null => {
    if (donorId === undefined || donorId === baseId) return null;
    const d = m.objects[donorId];
    if (!d) return null;
    const dh = headOf(d);
    if (dh < 0 || bh < 0) return null;
    const dbody = d.l.findIndex((L) => (L.bp ?? 0) & BODY);
    const dx = base.l[bh].x - d.l[dh].x;
    const dy = base.l[bh].y - d.l[dh].y;
    const back: Src[] = [];
    const front: Src[] = [];
    d.l.forEach((L, i) => {
      if (kindOf(d, i, dh) !== kind) return;
      const src = { donor: donorId, idx: i, L: { ...L, x: L.x + dx, y: L.y + dy, bp: undefined }, hair: kind === "hair" };
      (i < dbody ? back : front).push(src);
    });
    return { back, front };
  };

  const hair = donorLayers(hairDonor, "hair");
  const face = donorLayers(faceDonor, "face");
  const baseBody = base.l.findIndex((L) => (L.bp ?? 0) & BODY);

  const seq: Src[] = [];
  let hairDone = !hair;
  let faceDone = !face;
  base.l.forEach((L, i) => {
    if (i === baseBody) {
      if (hair) seq.push(...hair.back);
      if (face) seq.push(...face.back);
    }
    const kind = kindOf(base, i, bh);
    // (base layers of a replaced kind that sit behind the body are just dropped)
    if (kind === "hair" && hair) {
      if (!hairDone && i > baseBody) seq.push(...hair.front);
      hairDone = i > baseBody;
      return;
    }
    if (kind === "face" && face) {
      if (!faceDone && i > baseBody) seq.push(...face.front);
      faceDone = i > baseBody;
      return;
    }
    seq.push({ donor: -1, idx: i, L, hair: isHairName(name(L)) });
  });
  if (!faceDone && face) seq.push(...face.front);
  if (!hairDone && hair) seq.push(...hair.front);

  const where = new Map<string, number>();
  seq.forEach((s, k) => where.set(`${s.donor}:${s.idx}`, k));
  const newHead = where.get(`-1:${bh}`) ?? -1;
  const out: PLayer[] = seq.map((s) => {
    let p = s.L.p;
    if (p !== undefined && p >= 0) {
      // parent in the same source if it survived, else the base head (dropped/foreign parents)
      p = where.get(`${s.donor}:${p}`) ?? newHead;
    }
    return { ...s.L, p, hair: s.hair };
  });
  graftCache.set(key, out);
  return out;
}

// ------------------------------------------------------------------ person

export interface PersonSpec {
  displayId: number;
  age: number;
  facingLeft?: boolean;
  clothing?: Clothing;
  heldObjectId?: number | null;
  appearance?: Appearance | null;
}

const visibleAtAge = (L: Layer, age: number) => !L.a || (L.a[0] === -1 && L.a[1] === -1) || (age >= L.a[0] && age < L.a[1]);

/** ageControl.cpp getAgeHeadOffset */
export function ageHeadOffset(age: number, head: [number, number], body: [number, number], frontFoot: [number, number]): [number, number] {
  if (age === -1) return [0, 0];
  if (age < 20) return [0, Math.round(-((20 - age) / 20) * 0.6 * (head[1] - body[1]))];
  if (age >= 40) {
    const a = Math.min(age, 60);
    return [Math.round(((a - 40) / 20) * 2 * (frontFoot[0] - head[0])), Math.round(-((a - 40) / 20) * 0.35 * (head[1] - body[1]))];
  }
  return [0, 0];
}

/** ageControl.cpp getAgeBodyOffset */
export function ageBodyOffset(age: number, body: [number, number]): [number, number] {
  if (age === -1 || age >= 20) return [0, 0];
  return [0, Math.round(-((20 - age) / 20) * 0.75 * body[1])];
}

function topFlagged(layers: Layer[], flag: number, age: number): number {
  for (let i = layers.length - 1; i >= 0; i--) if ((layers[i].bp ?? 0) & flag && visibleAtAge(layers[i], age)) return i;
  return 0;
}

/** getBackHandIndex: of the two lowest visible invisHolding layers, the one with smaller x. */
function backHandIndex(layers: Layer[], age: number): number {
  let one = -1;
  let two = -1;
  let y1 = Infinity;
  let y2 = Infinity;
  layers.forEach((L, i) => {
    if (!L.ih || !visibleAtAge(L, age)) return;
    if (L.y < y1) {
      two = one;
      y2 = y1;
      one = i;
      y1 = L.y;
    } else if (L.y < y2) {
      two = i;
      y2 = L.y;
    }
  });
  if (one === -1) return -1;
  if (two === -1) return -1; // as in the C++ (returns handTwoIndex)
  return layers[one].x < layers[two].x ? one : two;
}

function limbChain(layers: Layer[], hand: number): number[] {
  const out: number[] = [];
  let k = hand;
  let guard = 0;
  while (k >= 0 && k < layers.length && !((layers[k].bp ?? 0) & BODY) && guard++ < 50) {
    out.push(k);
    k = layers[k].p ?? -1;
  }
  return out;
}

/** Ops for a person, with clothing, held object and appearance, following drawObjectAnim. */
export function composePerson(m: OholManifest, spec: PersonSpec): DrawOp[] {
  const base = m.objects[spec.displayId];
  if (!base) return [];
  const age = spec.age;
  const flipH = !!spec.facingLeft;
  const fx = (x: number) => (flipH ? -x : x);
  const ap = spec.appearance ?? null;
  const layers = personLayers(m, spec.displayId, ap?.hairDonorId, ap?.faceDonorId);
  const hairTint = ap ? hairTintAtAge(ap.hairColor, age) : null;

  const head = topFlagged(layers, HEAD, age);
  const body = topFlagged(layers, BODY, age);
  const backFoot = topFlagged(layers, BACK_FOOT, age);
  const frontFoot = topFlagged(layers, FRONT_FOOT, age);
  const pos = (i: number): [number, number] => [layers[i].x, layers[i].y];
  const headOff = ageHeadOffset(age, pos(head), pos(body), pos(frontFoot));
  const bodyOff = ageBodyOffset(age, pos(body));

  // per-layer own delta, then accumulate through the parent chain (no rotation in a still frame)
  const own = (i: number): [number, number] =>
    i === head ? headOff : i === body ? bodyOff : [0, 0];
  const finalPos = layers.map((L, i): [number, number] => {
    let [x, y] = [L.x, L.y];
    const d0 = own(i);
    x += d0[0];
    y += d0[1];
    let p = L.p;
    let guard = 0;
    while (p !== undefined && p >= 0 && guard++ < 200) {
      const d = own(p);
      x += d[0];
      y += d[1];
      p = layers[p].p;
    }
    return [fx(x), y];
  });

  const hand = backHandIndex(layers, age);
  const backArm = hand >= 0 ? limbChain(layers, hand) : [];
  const topBackArm = backArm.length ? backArm[backArm.length - 1] : -1;

  const cl = spec.clothing ?? {};
  const clothingOps = (id: number | null | undefined, at: [number, number]): DrawOp[] => {
    if (!id) return [];
    const r = resolveObject(m, id);
    if (!r) return [];
    const off = r.rec.co ?? [0, 0];
    const cx = at[0] + fx(off[0]);
    const cy = at[1] + off[1];
    return composeObject(m, id, { flipH, worn: true }).map((o) => ({ ...o, x: o.x + cx, y: o.y + cy }));
  };

  // With an agent appearance, hair/beard layers use the donor sprites for age 34.9 at every
  // later age: many male donors recede from 35 and go bald at 40-55, which would erase the lineage hairstyle.
  // Ageing is shown by the tint greying toward white instead (hairTintAtAge).
  const hairAge = Math.min(age, HAIR_STYLE_MAX_AGE);
  const ops: DrawOp[] = [];
  layers.forEach((L, i) => {
    const shownAt = ap && (L as PLayer).hair ? hairAge : age;
    if (!visibleAtAge(L, shownAt) || NUDITY_SPRITES.has(L.s) || !m.sprites[L.s]) return;
    if (i === topBackArm) {
      // bottom, tunic, backpack go under the top of the back arm, positioned off the body
      const b = finalPos[body];
      ops.push(...clothingOps(cl.bottom, b), ...clothingOps(cl.tunic, b), ...clothingOps(cl.backpack, b));
    }
    const op = layerOp(m, L, finalPos[i][0], finalPos[i][1], flipH);
    if ((L as PLayer).hair && hairTint) {
      op.hairTint = hairTint;
      if (op.blend === "multiply") {
        op.hairLines = true;
        op.blend = "normal";
      }
    }
    ops.push(op);
    if (i === backFoot) ops.push(...clothingOps(cl.backShoe, finalPos[i]));
    else if (i === frontFoot) ops.push(...clothingOps(cl.frontShoe, finalPos[i]));
  });
  // hat on top of everything, relative to the (aged) head
  ops.push(...clothingOps(cl.hat, finalPos[head]));

  if (spec.heldObjectId) {
    const r = resolveObject(m, spec.heldObjectId);
    if (r) {
      // heldInHand=1 -> the back hand; otherwise held against the body (computeHeldDrawPos)
      const holdAt = r.rec.hh === 1 && hand >= 0 ? finalPos[hand] : finalPos[body];
      let [hx, hy] = r.rec.ho ?? [0, 0];
      if (!r.rec.person) {
        const c = objectCenterOffset(m, r.rec);
        hx -= c[0];
        hy -= c[1];
      }
      const x = holdAt[0] + fx(hx);
      const y = holdAt[1] + hy;
      const held = r.rec.person
        ? composePerson(m, { displayId: spec.heldObjectId, age: 0.5, facingLeft: flipH })
        : composeObject(m, spec.heldObjectId, { flipH });
      ops.push(...held.map((o) => ({ ...o, x: o.x + x, y: o.y + y })));
    }
  }
  return ops;
}
