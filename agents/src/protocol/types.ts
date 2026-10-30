// Typed shapes for parsed server messages. Parsers live in messages.ts.
// Coordinates are absolute world coords (our server patch zeroes the
// per-player birth offset). y grows northward (up) in OHOL.

/** Object stack in CONTAINER OBJECT FORMAT: "id,c1,c2:s1:s2,..." */
export interface ObjStack {
  id: number; // 0 = empty
  contained: { id: number; sub: number[] }[];
}

export interface PlayerUpdate {
  id: number;
  displayId: number; // po_id, the person object (encodes race/gender)
  facing: number;
  action: boolean;
  actionTarget: [number, number];
  /** held object; negative id means holding the baby with p_id = -id */
  held: ObjStack;
  heldOriginValid: boolean;
  heldOrigin: [number, number];
  heldTransitionSourceId: number;
  heat: number;
  doneMovingSeq: number;
  forced: boolean;
  /** null when the player was deleted (x y sent as "X X") */
  x: number | null;
  y: number | null;
  age: number;
  ageRate: number; // seconds per year
  moveSpeed: number;
  clothing: ObjStack[]; // hat;tunic;frontShoe;backShoe;bottom;backpack
  justAte: boolean;
  lastAteId: number;
  responsibleId: number;
  heldYum: boolean;
  heldLearned: boolean;
  /** set when x/y are "X": e.g. "reason_hunger", "reason_age", "reason_killed_123" */
  deathReason?: string;
}

export interface PlayerMove {
  id: number;
  start: [number, number];
  totalSec: number;
  etaSec: number;
  truncated: boolean;
  /** absolute waypoints */
  path: [number, number][];
}

export interface MapChange {
  x: number;
  y: number;
  floor: number;
  obj: ObjStack;
  responsibleId: number; // -1 none; < -1 means -(id) caused a transform
  from?: { x: number; y: number; speed: number };
}

export interface MapCell {
  biome: number;
  floor: number;
  obj: ObjStack;
}

export interface MapChunk {
  x: number; // lower-left / start x
  y: number;
  w: number;
  h: number;
  /** row-major, index = (cy * w + cx), world pos = (x + cx, y + cy) */
  cells: MapCell[];
}

export interface PlayerSays {
  id: number;
  isCurse: boolean;
  text: string;
}

export interface LocationSays {
  x: number;
  y: number;
  text: string;
}

export interface FoodChange {
  food: number;
  capacity: number;
  lastAteId: number;
  lastAteFillMax: number;
  moveSpeed: number;
  responsibleId: number;
  yumBonus: number;
  yumMultiplier: number;
}

export interface HeatChange {
  heat: number;
  foodTime: number;
  indoorBonus: number;
}

export interface Lineage {
  id: number;
  /** mother first, then grandmother, ... */
  ancestors: number[];
  eveId: number;
}

export interface PlayerName {
  id: number;
  first: string;
  last?: string;
}

export interface Emote {
  id: number;
  emot: number;
  ttl?: number;
}

export interface Craving {
  foodId: number;
  bonus: number;
}

export interface Follow {
  followerId: number;
  leaderId: number;
  colorIndex: number;
}

export interface Grave {
  x: number;
  y: number;
  id: number;
}

export type ServerMessage =
  | { type: "PU"; updates: PlayerUpdate[] }
  | { type: "PM"; moves: PlayerMove[] }
  | { type: "PO"; ids: number[] }
  | { type: "MX"; changes: MapChange[] }
  | { type: "MC"; chunk: MapChunk }
  | { type: "PS"; says: PlayerSays[] }
  | { type: "LS"; says: LocationSays[] }
  | { type: "FX"; food: FoodChange }
  | { type: "HX"; heat: HeatChange }
  | { type: "LN"; lineages: Lineage[] }
  | { type: "NM"; names: PlayerName[] }
  | { type: "DY"; ids: number[] }
  | { type: "HE"; ids: number[] }
  | { type: "BW"; ids: number[] }
  | { type: "PE"; emotes: Emote[] }
  | { type: "CR"; craving: Craving }
  | { type: "FW"; follows: Follow[] }
  | { type: "GV"; graves: Grave[] }
  | { type: "LR"; toolIds: number[] }
  | { type: "TS"; used: number; total: number }
  | { type: "FM" }
  | { type: "PONG"; id: string }
  | { type: "OTHER"; tag: string; lines: string[] };
