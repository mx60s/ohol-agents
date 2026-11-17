// Browser renderer for the real OHOL art (canvas 2D).
//
//   await loadOholAssets();                       // fetches ohol/objects.json once
//   drawObject(ctx, objectId, x, y, scale, opts)  // (x, y) = object origin on the canvas (tile centre-bottom)
//   drawPerson(ctx, spec, x, y, scale)            // (x, y) = feet
//
// Sprites load lazily on first use and are cached. The draw functions return true when every
// sprite was available; otherwise they draw what they have, start loading the rest, and call the
// onOholSpriteLoaded() listeners when more arrive so the caller can redraw.

import { appearanceFor } from "./appearance.ts";
import type { Appearance, AppearanceInput } from "./appearance.ts";
import { composeObject, composePerson, opsBounds } from "./compose.ts";
import type { Box, DrawOp, ObjectOpts, PersonSpec } from "./compose.ts";
import { recolorHairPixels } from "./hairTint.ts";
import { flowerImage, preloadFlower } from "./flowerArt.ts";
import { FLOWER_ART } from "./flower.ts";
import type { OholManifest, SpriteMeta } from "./types.ts";

export interface OholAssets {
  manifest: OholManifest;
  baseUrl: string;
}

let assets: OholAssets | null = null;
let loading: Promise<OholAssets> | null = null;
const images = new Map<number, HTMLImageElement>();
const ready = new Set<number>();
const failed = new Set<number>();
const variants = new Map<string, HTMLCanvasElement>();
/** Tinted / hair-recoloured sprite copies are an LRU: every new life (hair colour) and every elder age step adds some, so an always-on page must not keep them all. */
const MAX_VARIANTS = 800;
function variantGet(key: string): HTMLCanvasElement | undefined {
  const c = variants.get(key);
  if (c) {
    variants.delete(key);
    variants.set(key, c);
  }
  return c;
}
function variantSet(key: string, c: HTMLCanvasElement): void {
  variants.set(key, c);
  while (variants.size > MAX_VARIANTS) {
    const oldest = variants.keys().next().value;
    if (oldest === undefined) break;
    variants.delete(oldest);
  }
}
const listeners = new Set<() => void>();
const groundImages = new Map<string, HTMLImageElement>();

function defaultBase(): string {
  const env = (import.meta as unknown as { env?: { BASE_URL?: string } }).env;
  return `${env?.BASE_URL ?? "/"}ohol/`;
}

/** Fetch the manifest (once). Sprites are loaded lazily by the draw calls. */
export function loadOholAssets(baseUrl: string = defaultBase()): Promise<OholAssets> {
  if (assets) return Promise.resolve(assets);
  if (!loading) {
    const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
    loading = fetch(`${base}objects.json`)
      .then((r) => {
        if (!r.ok) throw new Error(`ohol assets: ${r.status} for ${base}objects.json (run \`npm run assets\`)`);
        return r.json() as Promise<OholManifest>;
      })
      .then((manifest) => {
        assets = { manifest, baseUrl: base };
        return assets;
      })
      .catch((e) => {
        loading = null;
        throw e;
      });
  }
  return loading;
}

export function getOholAssets(): OholAssets | null {
  return assets;
}

/** Called (batched per animation frame) whenever lazily requested sprites finish loading. */
export function onOholSpriteLoaded(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

let notifyQueued = false;
function notify() {
  if (notifyQueued) return;
  notifyQueued = true;
  requestAnimationFrame(() => {
    notifyQueued = false;
    for (const cb of listeners) cb();
  });
}

function requestSprite(id: number): HTMLImageElement | null {
  if (ready.has(id)) return images.get(id)!;
  if (!assets || failed.has(id) || images.has(id)) return null;
  const img = new Image();
  img.decoding = "async";
  img.onload = () => {
    ready.add(id);
    notify();
  };
  img.onerror = () => failed.add(id);
  img.src = `${assets.baseUrl}sprites/${id}.png`;
  images.set(id, img);
  return null;
}

/** Resolve once every sprite in `ops` has loaded (or failed). */
function whenLoaded(ops: DrawOp[]): Promise<void> {
  const ids = [...new Set(ops.map((o) => o.sprite))].filter((id) => id >= 0);
  for (const id of ids) requestSprite(id);
  const flowers = ops.flatMap((o) => (o.flower ? [preloadFlower(o.flower.shape)] : []));
  return Promise.all([
    ...flowers,
    ...ids.map(
      (id) =>
        new Promise<void>((res) => {
          const img = images.get(id);
          if (!img || ready.has(id) || failed.has(id)) return res();
          img.addEventListener("load", () => res(), { once: true });
          img.addEventListener("error", () => res(), { once: true });
        }),
    ),
  ]).then(() => undefined);
}

function canvasFor(img: HTMLImageElement): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement("canvas");
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const g = c.getContext("2d", { willReadFrequently: true })!;
  return [c, g];
}

/** Colour-multiplied copy of a sprite (the game's per-layer `color=`), cached. */
function tinted(id: number, img: HTMLImageElement, hex: string): HTMLCanvasElement {
  const key = `${id}|c|${hex}`;
  let c = variantGet(key);
  if (c) return c;
  const [cv, g] = canvasFor(img);
  g.drawImage(img, 0, 0);
  g.globalCompositeOperation = "multiply";
  g.fillStyle = `#${hex}`;
  g.fillRect(0, 0, cv.width, cv.height);
  g.globalCompositeOperation = "destination-in";
  g.drawImage(img, 0, 0);
  variantSet(key, cv);
  c = cv;
  return c;
}

/** Hair-recoloured copy of a sprite, cached per tint. */
function hairRecolored(id: number, img: HTMLImageElement, tint: string, multiply: boolean): HTMLCanvasElement {
  const key = `${id}|h|${tint}|${multiply ? 1 : 0}`;
  const hit = variantGet(key);
  if (hit) return hit;
  const [cv, g] = canvasFor(img);
  g.drawImage(img, 0, 0);
  const data = g.getImageData(0, 0, cv.width, cv.height);
  const t = tint.replace("#", "");
  const rgb: [number, number, number] = [0, 2, 4].map((i) => Number.parseInt(t.slice(i, i + 2), 16) / 255) as [number, number, number];
  recolorHairPixels(data.data, cv.width, cv.height, rgb, { multiply });
  g.putImageData(data, 0, 0);
  variantSet(key, cv);
  return cv;
}

/** A person's flower (DrawOp.flower), centred on its position. */
function drawFlowerOp(ctx: CanvasRenderingContext2D, op: DrawOp, x: number, y: number, scale: number): boolean {
  const f = op.flower!;
  let sprite: { img: HTMLImageElement; meta: SpriteMeta } | null = null;
  if (op.sprite >= 0) {
    const img = requestSprite(op.sprite);
    const meta = assets?.manifest.sprites[op.sprite];
    if (!img || !meta) return false;
    sprite = { img, meta };
  }
  const fi = flowerImage(f.shape, f.color, sprite, notify);
  if (!fi) return false;
  const k = (f.size * scale) / Math.max(fi.w, fi.h);
  ctx.save();
  ctx.translate(x + op.x * scale, y - op.y * scale);
  ctx.scale(op.flip ? -k : k, k);
  ctx.drawImage(fi.img, -fi.w / 2, -fi.h / 2);
  ctx.restore();
  return true;
}

const COMPOSITE: Record<DrawOp["blend"], GlobalCompositeOperation> = {
  normal: "source-over",
  multiply: "multiply",
  additive: "lighter",
};

/**
 * Execute draw ops with the object origin at canvas (x, y). Returns true if all sprites were drawn.
 * Multiplicative sprites multiply into whatever is already on the canvas, as in the game, so draw
 * the ground/background first.
 */
export function drawOps(ctx: CanvasRenderingContext2D, ops: DrawOp[], x: number, y: number, scale: number): boolean {
  if (!assets) return false;
  const m = assets.manifest;
  let complete = true;
  for (const op of ops) {
    if (op.flower) {
      if (!drawFlowerOp(ctx, op, x, y, scale)) complete = false;
      continue;
    }
    const meta = m.sprites[op.sprite];
    const img = requestSprite(op.sprite);
    if (!meta || !img) {
      complete = false;
      continue;
    }
    let src: CanvasImageSource = img;
    if (op.hairTint) src = hairRecolored(op.sprite, img, op.hairTint, !!op.hairLines);
    else if (op.color) src = tinted(op.sprite, img, op.color);
    ctx.save();
    ctx.globalCompositeOperation = COMPOSITE[op.blend];
    ctx.translate(x + op.x * scale, y - op.y * scale);
    if (op.rot) ctx.rotate(op.rot * 2 * Math.PI);
    ctx.scale(op.flip ? -scale : scale, scale);
    ctx.drawImage(src, -meta.ax - meta.w / 2, -meta.ay - meta.h / 2);
    ctx.restore();
  }
  return complete;
}

export interface DrawObjectOpts extends ObjectOpts {
  /** ignored for non-person objects; for persons draws them at this age */
  age?: number;
}

/** Draw any object (map item, clothing, use dummy, ...). `opts.flipH` mirrors it. */
export function drawObject(
  ctx: CanvasRenderingContext2D,
  objectId: number,
  x: number,
  y: number,
  scale = 1,
  opts: DrawObjectOpts = {},
): boolean {
  if (!assets) return false;
  const rec = assets.manifest.objects[objectId];
  const ops =
    rec?.person && opts.age !== undefined
      ? composePerson(assets.manifest, { displayId: objectId, age: opts.age, facingLeft: opts.flipH })
      : composeObject(assets.manifest, objectId, opts);
  return drawOps(ctx, ops, x, y, scale);
}

export interface DrawPersonSpec extends PersonSpec {}

/**
 * A person's flower on its own (an icon), centred on (x, y), its larger side `size` px. Returns
 * false while its art is loading (onOholSpriteLoaded fires when it arrives).
 */
export function drawFlower(ctx: CanvasRenderingContext2D, shape: string, color: string, x: number, y: number, size: number): boolean {
  if (!assets) return false;
  const op: DrawOp = { sprite: FLOWER_ART[shape]?.sprite ?? -1, x: 0, y: 0, rot: 0, flip: false, color: null, blend: "normal", hairTint: null, flower: { shape, color, size } };
  return drawFlowerOp(ctx, op, x, y, 1);
}

/** Draw a person with age, facing, clothing, held object and (optional) agent appearance. */
export function drawPerson(ctx: CanvasRenderingContext2D, spec: DrawPersonSpec, x: number, y: number, scale = 1): boolean {
  if (!assets) return false;
  return drawOps(ctx, composePerson(assets.manifest, spec), x, y, scale);
}

/** Screen bounds of an object drawn by drawObject at (x, y) (visible pixels; null if unknown / not loaded). */
export function objectBounds(objectId: number, x: number, y: number, scale = 1, opts: DrawObjectOpts = {}): Box | null {
  if (!assets) return null;
  const rec = assets.manifest.objects[objectId];
  const ops =
    rec?.person && opts.age !== undefined
      ? composePerson(assets.manifest, { displayId: objectId, age: opts.age, facingLeft: opts.flipH })
      : composeObject(assets.manifest, objectId, opts);
  return opsBounds(assets.manifest, ops, x, y, scale);
}

/** Screen bounds of a person drawn by drawPerson at (x, y). */
export function personBounds(spec: DrawPersonSpec, x: number, y: number, scale = 1): Box | null {
  return assets ? opsBounds(assets.manifest, composePerson(assets.manifest, spec), x, y, scale) : null;
}

/** Resolve when all sprites a person/object needs are loaded (for one-shot renders). */
export function preloadPerson(spec: PersonSpec): Promise<void> {
  return assets ? whenLoaded(composePerson(assets.manifest, spec)) : Promise.resolve();
}
export function preloadObject(objectId: number, opts: ObjectOpts = {}): Promise<void> {
  return assets ? whenLoaded(composeObject(assets.manifest, objectId, opts)) : Promise.resolve();
}

/** Convenience: appearance + draw in one call. */
export function drawAgent(
  ctx: CanvasRenderingContext2D,
  spec: Omit<PersonSpec, "appearance"> & { look: Omit<AppearanceInput, "displayId"> },
  x: number,
  y: number,
  scale = 1,
): Appearance {
  const appearance = appearanceFor({ ...spec.look, displayId: spec.displayId });
  drawPerson(ctx, { ...spec, appearance }, x, y, scale);
  return appearance;
}

/**
 * Ground texture for a biome (0-6, anything else -> "U"). The game's 512 px textures span 4x4
 * cells of 128 px; this draws the cell (cellX, cellY)'s quarter-of-a-quarter into a `size` px
 * square with its top-left at (x, y). Returns false until the texture has loaded.
 */
export function drawGround(
  ctx: CanvasRenderingContext2D,
  biome: number,
  cellX: number,
  cellY: number,
  x: number,
  y: number,
  size: number,
): boolean {
  if (!assets) return false;
  const name = assets.manifest.ground.some((g) => g.name === `ground_${biome}`) ? `ground_${biome}` : "ground_U";
  let img = groundImages.get(name);
  if (!img) {
    img = new Image();
    img.onload = notify;
    img.src = `${assets.baseUrl}ground/${name}.png`;
    groundImages.set(name, img);
  }
  if (!img.complete || img.naturalWidth === 0) return false;
  const tiles = Math.max(1, Math.round(img.naturalWidth / 128));
  const tx = ((cellX % tiles) + tiles) % tiles;
  const ty = tiles - 1 - (((cellY % tiles) + tiles) % tiles); // world y is up
  const s = img.naturalWidth / tiles;
  ctx.drawImage(img, tx * s, ty * s, s, s, x, y, size, size);
  return true;
}
