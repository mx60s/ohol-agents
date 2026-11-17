// React canvas wrappers around the real OHOL renderer (../ohol): drawPerson + appearanceFor.
//
//   <PersonFigure displayId={350} age={24} female lineageId={l.lineageId} traits={l.traits} traitDims={dims} size={120} />
//   <PersonPortrait ... size={64} />            // head-and-shoulders crop
//
// Sprites load lazily; the canvas redraws as they arrive. Needs public/ohol/ (npm run assets).

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { Flower, Traits } from "../api-types.ts";
import { appearanceFor, composePerson, drawPerson, getOholAssets, loadOholAssets, onOholSpriteLoaded } from "../ohol/index.ts";
import type { DrawOp, OholManifest, PersonSpec } from "../ohol/index.ts";

export interface PersonArtProps {
  /** game "person" object id (LifeRecord.displayId / PlayerView.displayId); null -> a default */
  displayId: number | null | undefined;
  /** in-game years; drives body stage and hair greying */
  age: number | null | undefined;
  female?: boolean | null;
  lineageId?: string | null;
  /** lineages to keep visually apart (e.g. the living ones; see ohol/appearance lineageLook) */
  livingLineageIds?: readonly string[];
  traits?: Traits | null;
  traitDims?: readonly string[];
  /** this life: with it the person wears a flower (`flower`, else the fallback over livingFamilyLifeIds) */
  lifeId?: string | null;
  /** the record's flower (LifeRecord / AgentView / PlayerView .flower) */
  flower?: Flower | null;
  /** fallback for records without a flower: living members of the same lineage (ohol/flower.ts flowerFor) */
  livingFamilyLifeIds?: readonly string[];
  facingLeft?: boolean;
  heldObjectId?: number | null;
  /** CSS pixel size: the canvas is size x size (figure) or size x size (portrait) */
  size: number;
  /** grey/sepia it (dead) */
  dead?: boolean;
  className?: string;
  style?: CSSProperties;
  title?: string;
}

const DEFAULT_FEMALE = 19;
const DEFAULT_MALE = 347;
const HEAD_RE = /head|hair|eye|mouth|beard|babycry|babyhappy/i;
const SHADOW_RE = /shadow/i;

type Box = { x0: number; y0: number; x1: number; y1: number };

/** Union of the visible boxes of the ops (y-up object space). Rotation is approximated by the larger side. */
function opsBounds(m: OholManifest, ops: DrawOp[], pick: (name: string) => boolean): Box | null {
  let b: Box | null = null;
  for (const op of ops) {
    const meta = m.sprites[op.sprite];
    if (!meta || !pick(meta.n)) continue;
    const sx = op.flip ? -1 : 1;
    const cx = op.x + sx * (-meta.ax + meta.cx);
    const cy = op.y + meta.ay - meta.cy;
    const hw = (op.rot ? Math.max(meta.vw, meta.vh) : meta.vw) / 2;
    const hh = (op.rot ? Math.max(meta.vw, meta.vh) : meta.vh) / 2;
    const r = { x0: cx - hw, x1: cx + hw, y0: cy - hh, y1: cy + hh };
    b = b ? { x0: Math.min(b.x0, r.x0), y0: Math.min(b.y0, r.y0), x1: Math.max(b.x1, r.x1), y1: Math.max(b.y1, r.y1) } : r;
  }
  return b;
}

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

function useSpec(p: PersonArtProps): PersonSpec {
  const { displayId, age, female, lineageId, livingLineageIds, traits, traitDims, facingLeft, heldObjectId, lifeId, flower, livingFamilyLifeIds } = p;
  const flowerKey = flower ? `${flower.shape}|${flower.color}` : "";
  const familyKey = livingFamilyLifeIds?.join("|");
  const living = livingLineageIds?.join("|");
  const traitKey = traits ? JSON.stringify(traits) : "";
  const dimKey = traitDims?.join("|");
  return useMemo(() => {
    const fem = female ?? true;
    const id = displayId ?? (fem ? DEFAULT_FEMALE : DEFAULT_MALE);
    const appearance = lineageId
      ? appearanceFor({
          displayId: id,
          female: fem,
          lineageId,
          traits: traits ?? {},
          traitDims: traitDims ? [...traitDims] : [],
          livingLineageIds: livingLineageIds ? [...livingLineageIds] : undefined,
          lifeId: lifeId ?? null,
          flower: flower ?? null,
          livingFamilyLifeIds,
        })
      : null;
    return { displayId: id, age: Math.max(0, Math.min(60, age ?? 20)), facingLeft: !!facingLeft, heldObjectId: heldObjectId ?? null, appearance };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayId, age, female, lineageId, living, traitKey, dimKey, facingLeft, heldObjectId, lifeId, flowerKey, familyKey]);
}

type Fit = "figure" | "portrait";

function PersonCanvas(props: PersonArtProps & { fit: Fit }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const ready = useAssetsReady();
  const spec = useSpec(props);
  const { size, fit } = props;

  useEffect(() => {
    const cv = ref.current;
    const a = getOholAssets();
    if (!cv || !ready || !a) return;
    const dpr = Math.min(3, typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1);
    const px = Math.round(size * dpr);
    if (cv.width !== px) cv.width = px;
    if (cv.height !== px) cv.height = px;
    // a displayId that isn't a person object (bad data) falls back to a default body
    const drawSpec = a.manifest.objects[spec.displayId]?.person ? spec : { ...spec, displayId: props.female === false ? DEFAULT_MALE : DEFAULT_FEMALE };
    const ops = composePerson(a.manifest, drawSpec);
    let scale: number;
    let ox: number;
    let oy: number;
    if (fit === "portrait") {
      // head + hair (+ a little shoulder), centred, filling ~90% of the square
      const hb = opsBounds(a.manifest, ops, (n) => HEAD_RE.test(n)) ?? { x0: -40, x1: 40, y0: 60, y1: 140 };
      const side = Math.max(hb.x1 - hb.x0, hb.y1 - hb.y0) * 1.25;
      scale = px / side;
      const midX = (hb.x0 + hb.x1) / 2;
      const midY = (hb.y0 + hb.y1) / 2 - side * 0.08; // nudge down to show the neck
      ox = px / 2 - midX * scale;
      oy = px / 2 + midY * scale;
    } else {
      // natural scale: a fixed 200-unit-tall world box, feet near the bottom, so babies look small
      scale = px / 200;
      const bb = opsBounds(a.manifest, ops, (n) => !SHADOW_RE.test(n));
      const midX = bb ? (bb.x0 + bb.x1) / 2 : 0;
      ox = px / 2 - midX * scale;
      oy = px - 8 * scale;
    }
    const draw = () => {
      const g = cv.getContext("2d");
      if (!g) return;
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, cv.width, cv.height);
      g.imageSmoothingQuality = "high";
      drawPerson(g, drawSpec, ox, oy, scale);
    };
    draw();
    return onOholSpriteLoaded(draw);
  }, [ready, spec, size, fit]);

  return (
    <canvas
      ref={ref}
      className={`person-canvas ${props.className ?? ""}`}
      style={{ width: size, height: size, filter: props.dead ? "grayscale(.6) sepia(.2)" : undefined, ...props.style }}
      role="img"
      aria-label={props.title ?? "character"}
      title={props.title}
    />
  );
}

/** Whole body, natural scale (a baby is small, an adult fills the box). Feet at the bottom. */
export function PersonFigure(props: PersonArtProps) {
  return <PersonCanvas {...props} fit="figure" />;
}

/** Head-and-hair crop for avatars and cards. Wrap in .portrait-frame / .avatar for the design's framing. */
export function PersonPortrait(props: PersonArtProps) {
  return <PersonCanvas {...props} fit="portrait" />;
}
