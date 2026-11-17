// Shape of public/ohol/objects.json, written by scripts/build-ohol-assets.mjs.

export interface SpriteMeta {
  /** sprite tag/name, e.g. "HeadWhite", "Hair001" */
  n: string;
  w: number;
  h: number;
  /** anchor offset: the image centre sits at (pos.x - ax, pos.y + ay) in y-up object space */
  ax: number;
  ay: number;
  /** visible-content centre offset from the image centre (image rows top-down) and size */
  cx: number;
  cy: number;
  vw: number;
  vh: number;
  /** 1 = multiplicative blending */
  m?: 1;
}

export interface Layer {
  /** sprite id */
  s: number;
  /** position in y-up object space */
  x: number;
  y: number;
  /** rotation in turns, positive = clockwise */
  r?: number;
  /** horizontal flip */
  f?: 1;
  /** colour multiply, "rrggbb" */
  c?: string;
  /** ageRange [start, end) for person layers */
  a?: [number, number];
  /** parent layer index */
  p?: number;
  /** invisible when holding (marks hands) */
  ih?: 1;
  /** invisWorn: 1 = hidden when worn, 2 = only visible when worn */
  iw?: 1 | 2;
  /** behind container slots */
  bs?: 1;
  /** additive blend */
  ad?: 1;
  /** drawn behind the player when held */
  db?: 1;
  /** body-part flags: 1 head, 2 body, 4 back foot, 8 front foot */
  bp?: number;
}

export type ClothingSlot = "h" | "t" | "b" | "s" | "p";

export interface ObjectRec {
  /** description, e.g. "Female001 D" */
  n: string;
  l: Layer[];
  /** person object (value is the person "race" weight in the game data) */
  person?: number;
  race?: string;
  male?: 1;
  noSpawn?: 1;
  /** clothing slot and offset */
  cl?: ClothingSlot;
  co?: [number, number];
  /** held offset */
  ho?: [number, number];
  /** 1 = held in hand, 2 = ridden, absent = held against the body */
  hh?: number;
  noFlip?: 1;
  floor?: 1;
  /** number of uses (objects with use dummies) */
  uses?: number;
  /** layers hidden on the full (unused) object */
  skip?: number[];
}

export interface OholManifest {
  dataRef: string;
  hiddenSprites: number[];
  sprites: Record<string, SpriteMeta>;
  objects: Record<string, ObjectRec>;
  /** use dummy id -> [parent object id, layer indices to skip] */
  dummies: Record<string, [number, number[]]>;
  ground: { name: string; w: number; h: number }[];
}

export interface Clothing {
  hat?: number | null;
  tunic?: number | null;
  bottom?: number | null;
  frontShoe?: number | null;
  backShoe?: number | null;
  backpack?: number | null;
}
