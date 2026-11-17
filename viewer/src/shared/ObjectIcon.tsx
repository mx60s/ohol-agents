// Small canvas icons from the real OHOL art: an object (drawObject, fitted to its visible box) and
// a person's flower (drawFlower). Sprites load lazily; the canvas redraws as they arrive.
// Needs public/ohol/ (npm run assets); without it the canvas stays empty.

import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { Flower } from "../api-types.ts";
import { drawFlower, drawObject, getOholAssets, loadOholAssets, objectBounds, onOholSpriteLoaded } from "../ohol/index.ts";

function useAssetsReady(): boolean {
  const [ready, setReady] = useState(() => getOholAssets() != null);
  useEffect(() => {
    if (ready) return;
    let live = true;
    loadOholAssets()
      .then(() => live && setReady(true))
      .catch((e) => console.warn(String(e)));
    return () => {
      live = false;
    };
  }, [ready]);
  return ready;
}

function useIconCanvas(size: number, ready: boolean, draw: (g: CanvasRenderingContext2D, px: number) => void, deps: unknown[]) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv || !ready) return;
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const px = Math.round(size * dpr);
    if (cv.width !== px) cv.width = px;
    if (cv.height !== px) cv.height = px;
    const paint = () => {
      const g = cv.getContext("2d");
      if (!g) return;
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, px, px);
      g.imageSmoothingQuality = "high";
      draw(g, px);
    };
    paint();
    return onOholSpriteLoaded(paint);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, size, ...deps]);
  return ref;
}

/** An object's sprite, scaled to fit a size x size box (with a small margin), centred. */
export function ObjectIcon({ objectId, size, className, style, title }: { objectId: number; size: number; className?: string; style?: CSSProperties; title?: string }) {
  const ready = useAssetsReady();
  const ref = useIconCanvas(
    size,
    ready,
    (g, px) => {
      // measure at scale 1, then fit the visible box
      const b = objectBounds(objectId, 0, 0, 1);
      if (!b) return;
      const w = Math.max(1, b.x1 - b.x0);
      const h = Math.max(1, b.y1 - b.y0);
      const k = (px * 0.9) / Math.max(w, h);
      drawObject(g, objectId, px / 2 - ((b.x0 + b.x1) / 2) * k, px / 2 - ((b.y0 + b.y1) / 2) * k, k);
    },
    [objectId],
  );
  return <canvas ref={ref} className={`object-icon ${className ?? ""}`} style={{ width: size, height: size, ...style }} role="img" aria-label={title ?? "item"} title={title} />;
}

/** A person's flower on its own. */
export function FlowerIcon({ flower, size, className, style }: { flower: Flower; size: number; className?: string; style?: CSSProperties }) {
  const ready = useAssetsReady();
  const ref = useIconCanvas(size, ready, (g, px) => void drawFlower(g, flower.shape, flower.color, px / 2, px / 2, px * 0.92), [flower.shape, flower.color]);
  return <canvas ref={ref} className={`flower-icon ${className ?? ""}`} style={{ width: size, height: size, ...style }} role="img" aria-label={flower.label} title={flower.label} />;
}
