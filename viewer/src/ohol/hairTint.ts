// Recolour a hair/beard sprite: desaturate, normalise its shading, then tint. Pure (works on a
// raw RGBA array), so it is unit-tested in node and run on an offscreen canvas in the browser.
//
// The OHOL hair sprites range from light brown/blonde fills to near-black fills with black
// outlines, and some (Hair018 locks) are multiplicative line art. A plain "grey * tint" leaves the
// dark ones black, so:
//   - normal sprites: luminance is stretched so the sprite's 95th percentile maps to 1, and pixels
//     away from the silhouette edge get a floor that grows with how dark the sprite is. Outlines
//     (at the edge, and interior strokes on light hair) stay dark; dark fills become visibly tinted.
//   - multiplicative sprites (stubble, Hair018 line-art locks): multiplying a tint over dark skin
//     shows nothing, so these become ordinary alpha sprites instead: colour = tint * 0.8,
//     alpha = original alpha * darkness (1 - L). The caller must draw them with normal blending
//     (compose.ts does). White areas become transparent, so nothing outside the strokes changes.

export interface HairTintOptions {
  /** sprite uses multiplicative blending */
  multiply: boolean;
}

const lum = (r: number, g: number, b: number) => (0.299 * r + 0.587 * g + 0.114 * b) / 255;

/** Chamfer distance (in px, approx) from each pixel to the nearest pixel with alpha < 64. */
function edgeDistance(data: Uint8ClampedArray | Uint8Array, w: number, h: number): Float32Array {
  const INF = 1e6;
  const d = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) d[i] = data[i * 4 + 3] < 64 ? 0 : INF;
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : d[y * w + x]);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (d[i] === 0) continue;
      d[i] = Math.min(d[i], at(x - 1, y) + 1, at(x, y - 1) + 1, at(x - 1, y - 1) + 1.414, at(x + 1, y - 1) + 1.414);
    }
  for (let y = h - 1; y >= 0; y--)
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (d[i] === 0) continue;
      d[i] = Math.min(d[i], at(x + 1, y) + 1, at(x, y + 1) + 1, at(x + 1, y + 1) + 1.414, at(x - 1, y + 1) + 1.414);
    }
  return d;
}

/**
 * Recolour in place. `tint` is [r, g, b] in 0..1. Alpha is never changed.
 */
export function recolorHairPixels(
  data: Uint8ClampedArray | Uint8Array,
  w: number,
  h: number,
  tint: [number, number, number],
  opts: HairTintOptions,
): void {
  const n = w * h;
  if (opts.multiply) {
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      if (data[o + 3] === 0) continue;
      const cover = Math.min(1, (1 - lum(data[o], data[o + 1], data[o + 2])) * 1.25);
      for (let c = 0; c < 3; c++) data[o + c] = Math.round(255 * tint[c] * 0.8);
      data[o + 3] = Math.round(data[o + 3] * cover);
    }
    return;
  }

  const lums: number[] = [];
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    if (data[o + 3] >= 64) lums.push(lum(data[o], data[o + 1], data[o + 2]));
  }
  if (lums.length === 0) return;
  lums.sort((a, b) => a - b);
  const hi = Math.max(lums[Math.floor(0.95 * (lums.length - 1))], 0.06);
  // How dark the sprite is overall: 0 for light hair, ->1 for near-black hair.
  const darkness = Math.min(1, Math.max(0, (0.6 - hi) / 0.55));
  // Interior floor for every hair sprite (black strokes would otherwise eat the tint on dark
  // skin), higher for dark sprites. Interior strokes stay visibly darker than the fill.
  const floor = 0.32 + 0.33 * darkness;
  const dist = edgeDistance(data, w, h);

  for (let i = 0; i < n; i++) {
    const o = i * 4;
    if (data[o + 3] === 0) continue;
    let v = Math.min(1, lum(data[o], data[o + 1], data[o + 2]) / hi);
    {
      // 0 at the silhouette edge, full floor from ~3 px in: keeps the outer outline dark.
      const k = Math.min(1, Math.max(0, (dist[i] - 1.2) / 2));
      v = Math.max(v, floor * k);
    }
    // Gamma lift so mid shading reads as colour rather than mud.
    v = v ** 0.7;
    for (let c = 0; c < 3; c++) data[o + c] = Math.round(255 * tint[c] * v);
  }
}
