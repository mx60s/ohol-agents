// Browser-side flower art: recoloured copies of the flower sprites, cached per shape and colour.
// Two sources, one recolouring (flower.ts recolorFlowerPixels): real OHOL sprites (cropped to
// their visible box) and the generated OHOL-style sprites in public/flowers/ (already trimmed).
// See flower.ts for the catalogue and compose.ts (flowerOp) for placement.

import { FLOWER_ART, flowerHex, recolorFlowerPixels } from "./flower.ts";
import { hexToRgb } from "./appearance.ts";
import type { SpriteMeta } from "./types.ts";

export interface FlowerImage {
  img: HTMLCanvasElement;
  /** the flower fills this box of the image (px), centred in it */
  w: number;
  h: number;
}

const noop = () => {};
const cache = new Map<string, FlowerImage>();
/** generated sprite files: loading or loaded image per file name (a failed one is not retried) */
const files = new Map<string, HTMLImageElement>();
const fileReady = new Set<string>();
const fileFailed = new Set<string>();
/** callbacks waiting for a file to load */
const fileWaiting = new Map<string, Set<() => void>>();

function newCanvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return [c, c.getContext("2d", { willReadFrequently: true })!];
}

function flowersBase(): string {
  const env = (import.meta as unknown as { env?: { BASE_URL?: string } }).env;
  return `${env?.BASE_URL ?? "/"}flowers/`;
}

/** The generated sprite image, or null while it loads (onLoad fires once it has). */
function requestFile(name: string, onLoad: () => void): HTMLImageElement | null {
  if (fileReady.has(name)) return files.get(name)!;
  if (fileFailed.has(name)) return null;
  let waiting = fileWaiting.get(name);
  if (!waiting) fileWaiting.set(name, (waiting = new Set()));
  waiting.add(onLoad);
  if (!files.has(name)) {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => {
      fileReady.add(name);
      for (const cb of fileWaiting.get(name) ?? []) cb();
      fileWaiting.delete(name);
    };
    img.onerror = () => fileFailed.add(name);
    img.src = `${flowersBase()}${name}`;
    files.set(name, img);
  }
  return null;
}

/** Resolve once the generated sprite file for `shape` (if it uses one) has loaded or failed. */
export function preloadFlower(shape: string): Promise<void> {
  const name = FLOWER_ART[shape]?.image;
  if (!name || fileReady.has(name) || fileFailed.has(name)) return Promise.resolve();
  return new Promise((res) => {
    requestFile(name, noop);
    const img = files.get(name)!;
    img.addEventListener("load", () => res(), { once: true });
    img.addEventListener("error", () => res(), { once: true });
  });
}

/**
 * The flower image for a shape and colour, or null while its art is still loading.
 * `sprite` is the loaded OHOL sprite image + meta for sprite-based shapes; `onLoad` is called when
 * a generated sprite file finishes loading (so the caller can redraw).
 */
export function flowerImage(
  shape: string,
  color: string,
  sprite: { img: HTMLImageElement; meta: SpriteMeta } | null,
  onLoad: () => void = noop,
): FlowerImage | null {
  const key = `${shape}|${color}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const art = FLOWER_ART[shape] ?? FLOWER_ART.daisy;
  let cv: HTMLCanvasElement;
  let g: CanvasRenderingContext2D;
  if (art.sprite !== undefined) {
    if (!sprite) return null;
    const { img, meta } = sprite;
    // crop to the visible box (+1 px of the soft edge)
    const vw = Math.min(meta.w, meta.vw + 2);
    const vh = Math.min(meta.h, meta.vh + 2);
    const sx = Math.max(0, Math.round(meta.w / 2 + meta.cx - vw / 2));
    const sy = Math.max(0, Math.round(meta.h / 2 + meta.cy - vh / 2));
    [cv, g] = newCanvas(vw, vh);
    g.drawImage(img, sx, sy, vw, vh, 0, 0, vw, vh);
  } else {
    const img = requestFile(art.image ?? "daisy.png", onLoad);
    if (!img) return null;
    [cv, g] = newCanvas(img.naturalWidth, img.naturalHeight);
    g.drawImage(img, 0, 0);
  }
  const data = g.getImageData(0, 0, cv.width, cv.height);
  recolorFlowerPixels(data.data, cv.width, cv.height, hexToRgb(flowerHex(color)), {
    keepCentre: art.keepCentre,
    warmPetals: color === "yellow" || color === "orange",
  });
  g.putImageData(data, 0, 0);
  const out = { img: cv, w: cv.width, h: cv.height };
  cache.set(key, out);
  return out;
}
