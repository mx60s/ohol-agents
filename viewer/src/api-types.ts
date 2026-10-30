// HTTP API contract between the agents service and the viewer.
// The viewer keeps a copy of this file at viewer/src/api-types.ts.
//
// GET  /api/state            -> StateResponse         (poll every ~2s)
// GET  /api/map              -> MapResponse           (poll every ~5s; union of everything any agent has seen)
// GET  /api/events?since=N   -> { events: RunEvent[] } (events with seq > N, max 500)
// GET  /api/stream           -> SSE, each message `data: <RunEvent JSON>`
// GET  /api/objects          -> { names: Record<number, string> }  object id -> display name (all objects)
//
// Coordinates are absolute OHOL world coords. y grows northward (up).

export interface RunInfo {
  id: string;
  startedAt: number; // ms epoch
  model: string;
  memoryMode: "per-life" | "persistent";
  recipeHints: boolean;
  targetPopulation: number;
  status: "idle" | "running" | "halted"; // idle = waiting for POST /api/start
  haltReason: string | null;
  limits: { maxGeneration: number; maxLives: number; maxRuntimeMin: number; maxCostUsd: number };
}

export interface AgentView {
  agentId: string; // stable slot id, e.g. "a03"; survives across lives
  lifeIndex: number; // how many lives this slot has had (1-based)
  status: "connecting" | "alive" | "dead" | "waiting";
  playerId: number | null;
  name: string | null; // in-game name, null until named
  x: number | null;
  y: number | null;
  age: number | null; // in-game years
  female: boolean | null;
  food: number | null;
  foodCapacity: number | null;
  heat: number | null; // 0..1, 0.5 ideal
  held: string | null; // display name of held object, or "baby: <name>"
  motherId: number | null;
  eveId: number | null;
  generation: number | null; // 1 = Eve
  goal: string | null; // agent's own current goal text
  lastThought: string | null;
  lastAction: string | null;
  lastSaid: string | null;
}

export interface PlayerView {
  id: number;
  x: number;
  y: number;
  age: number;
  female: boolean | null;
  name: string | null;
  held: string | null;
  agentId: string | null; // null if not one of ours (e.g. a human)
  dying: boolean;
  moving: boolean; // walking right now
  displayId: number; // game "person" object id (encodes skin tone / gender in the real game)
}

export interface Stats {
  alive: number;
  totalBirths: number;
  totalDeaths: number;
  maxGeneration: number;
  families: number; // distinct living eve lineages
  llmCalls: number;
  llmCostUsd: number;
}

export interface StateResponse {
  run: RunInfo;
  /** dashboard controls: open = no password needed; spend across all runs in this process */
  control?: { open: boolean; totalCostUsd: number; maxTotalCostUsd: number };
  now: number;
  agents: AgentView[];
  players: PlayerView[];
  stats: Stats;
}

/** [x, y, biome, floorId, objectId] ; objectId/floorId 0 = empty */
export type MapCellTuple = [number, number, number, number, number];

export interface MapResponse {
  cells: MapCellTuple[];
  /** names for every object id that appears in cells */
  names: Record<number, string>;
}

export type RunEventKind =
  | "birth" // data: { playerId, motherId, eve: boolean }
  | "death" // data: { playerId, age, reason }
  | "say" // text = what was said; data: { playerId, x, y, heardBy: string[] (agentIds of other agents whose characters heard it) }
  | "action" // text = human readable action; data: { command }
  | "thought" // text = the agent's private reasoning summary / goal
  | "craft" // text = "made X from Y + Z"; data: { actor, target, newActor, newTarget }
  | "narration" // text = omniscient narrator's summary of recent plot (every ~30s); not seen by agents
  | "system"; // run start/stop, errors

export interface RunEvent {
  seq: number;
  t: number; // ms epoch
  kind: RunEventKind;
  agentId: string | null;
  playerId: number | null;
  name: string | null;
  text: string;
  data?: Record<string, unknown>;
}
