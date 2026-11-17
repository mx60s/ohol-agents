// HTTP API contract between the agents service and the viewer.
// The viewer keeps a copy of this file at viewer/src/api-types.ts.
//
// GET  /api/state            -> StateResponse         (poll every ~2s)
// GET  /api/map              -> MapResponse           (poll every ~5s; union of everything any agent has seen)
// GET  /api/events?since=N   -> { events: RunEvent[] } (events with seq > N, max 500)
// GET  /api/stream           -> SSE, each message `data: <RunEvent JSON>`
// GET  /api/objects          -> { names: Record<number, string> }  object id -> display name (all objects)
// GET  /api/story/history?limit=N -> StoryHistoryResponse (past "story so far" versions, newest first; default 20, max 200)
//
// Research endpoints (lives, lineages, traits; persisted across restarts and runs):
// GET  /api/lives?since=<ms>&limit=<n>        -> LivesResponse    lives with updatedAt > since, oldest update first
// GET  /api/lives/<lifeId>                    -> LifeRecord       (404 { error } if unknown)
// GET  /api/lives/<lifeId>/log?before=<seq>&limit=<n> -> LifeLogResponse  newest first
// GET  /api/lineages                          -> LineagesResponse
// GET  /api/deaths?limit=<n>                  -> DeathsResponse   newest first
// Errors are { error: string } with status 400 (bad query) or 404 (unknown id).
// lifeIds contain ":"; URL-encode them in paths (encodeURIComponent). Treat them as opaque: usually
// "<runId>:<playerId>", but "<runId>.<n>:<playerId>" when the game server restarted and reused the id.
//
// Coordinates are absolute OHOL world coords. y grows northward (up).

export interface RunInfo {
  id: string;
  startedAt: number; // ms epoch
  model: string;
  memoryMode: "per-life" | "persistent";
  recipeHints: boolean;
  targetPopulation: number;
  /**
   * idle = waiting for POST /api/start; halted = run over (see haltReason);
   * paused = running, but LLM calls are suspended by the rolling 24h spend cap
   * (see pauseReason / resumesAt). Characters stay in the world (and may die) while paused.
   */
  status: "idle" | "running" | "paused" | "halted";
  haltReason: string | null;
  /** maxCostUsd 0 = no per-run cap. In continuous mode the generation/lives/runtime limits are ignored. */
  limits: { maxGeneration: number; maxLives: number; maxRuntimeMin: number; maxCostUsd: number };
  /** CONTINUOUS=1: always-on, no generation/lives/runtime halts */
  continuous?: boolean;
  /** why the run is paused (status "paused"), else null */
  pauseReason?: string | null;
  /** ms epoch when the 24h window will have room again (status "paused"), else null */
  resumesAt?: number | null;
  /** LLM spend over the last 24h, across all runs and restarts; capUsd 0 = no daily cap */
  dailySpend?: { last24hUsd: number; capUsd: number };
  /** LLM provider health (see LlmStatus). Always sent by the agents service. */
  llmStatus?: LlmStatus;
}

/**
 * Health of the LLM provider, across runs. ok = the last call succeeded (or
 * none failed yet). While !ok, agents stop thinking (their characters idle),
 * the narrator and story pause and the director falls back to its heuristic;
 * one probe call goes out at retryAt, with exponential backoff (out of
 * credits / bad key: 1 min doubling to 30 min; rate limit: Retry-After;
 * 5xx / timeouts: 2 s doubling to 5 min).
 */
export interface LlmStatus {
  ok: boolean;
  /** short, viewer-safe description of the last failure, e.g. "HTTP 402: Insufficient credits"; kept after recovery */
  lastError: string | null;
  /** ms epoch when the current state (ok or failing) began; null = no failure yet */
  since: number | null;
  consecutiveFailures: number;
  /** ms epoch of the next probe call while failing, else null */
  retryAt: number | null;
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
  /** current life (see LifeRecord); null between lives. Always sent by the agents service. */
  lifeId?: string | null;
  lineageId?: string | null;
  /** MOCK traits of the current life (see StateResponse.traitSource); null between lives */
  traits?: Traits | null;
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
  /** set when this character is one of our agents' lives (this run or an earlier one), else null */
  lifeId?: string | null;
  lineageId?: string | null;
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
  /** trait dimension names, in order (config TRAIT_DIMS) */
  traitDims?: string[];
  /** "mock" = traits are assigned and inherited but do NOT affect behaviour or prompts */
  traitSource?: TraitSource;
  now: number;
  agents: AgentView[];
  players: PlayerView[];
  stats: Stats;
  /** stream camera: which living agent the single-character stream page should show (see Focus). Always set by /api/state. */
  focus?: Focus;
  /** rolling "story so far" of the whole world, across runs; null until the first summary. Always set by /api/state. */
  story?: StorySoFar | null;
}

/**
 * The director's pick for the stream camera. Changes are also sent as a
 * "focus" RunEvent. agentId is null when nobody is alive. When the focused
 * character dies the focus stays on them for ~8s (reason says they died), then
 * moves on. Otherwise it holds for at least DIRECTOR_MIN_DWELL_MS.
 */
export interface Focus {
  agentId: string | null;
  /** which life of that slot: "<agentId>:<lifeIndex>", e.g. "a03:2" */
  lifeId?: string | null;
  since: number; // ms epoch when this focus started
  reason: string | null; // short viewer-facing phrase, e.g. "Eve Hope is starving"
}

/** Rolling summary of the world's history (<=150 words), refreshed every few minutes. */
export interface StorySoFar {
  text: string;
  updatedAt: number; // ms epoch
}

export interface StoryVersion extends StorySoFar {
  runId: string | null; // run that was current when this version was written
}

export interface StoryHistoryResponse {
  history: StoryVersion[]; // newest first
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
  | "focus" // stream camera moved. agentId/playerId/name = new focus (all null if no one is alive); text = reason; data: { lifeId, previous: agentId | null, cause: "initial" | "switch" | "death" | "disconnect" | "empty" }
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

// ---------------------------------------------------------------------------
// Research data: lives, lineages, traits.
//
// TRAITS ARE MOCK DATA while traitSource is "mock": they are sampled and
// inherited exactly as the study design says, but nothing steers the agents
// with them. They have no effect on agent behaviour or prompts.
//
// Sampling: an Eve (or a child whose mother isn't one of our agents) gets each
// dimension ~ N(0, 1), clipped to +-2.5. A child of one of our agents gets its
// mother's vector + N(0, TRAIT_MUTATION_SD) per dimension, clipped to +-2.5.
// ---------------------------------------------------------------------------

export type TraitSource = "mock" | "steered";
/** dimension name -> value (roughly N(0,1), clipped to +-2.5). Names come from StateResponse.traitDims. */
export type Traits = Record<string, number>;

/**
 * Per-life behaviour tally, counted from the life's events, for "roles by
 * trait" analysis. Groups:
 * - exploring:   moves, tilesWalked, maxDistFromBirth
 * - foraging:    forage, reflexForage, eat, pickUp
 * - crafting:    craft, drop, wear
 * - caregiving:  babyPickups, feeds
 * - socialising: says, saysHeard
 * - overall:     thoughts (about one per LLM decision), actions, failedActions
 */
export interface LifeActivity {
  /** thought events, about one per LLM decision */
  thoughts: number;
  /** action events (waits excluded; reflex forages included) */
  actions: number;
  /** actions whose result was a failure or "nothing happened" */
  failedActions: number;
  /** "go" actions */
  moves: number;
  /** tiles moved, summed over actions (Chebyshev distance from position before to position after each action) */
  tilesWalked: number;
  /** furthest position reached from the birth tile (Chebyshev), sampled after each action */
  maxDistFromBirth: number;
  /** forage actions, chosen or reflex */
  forage: number;
  /** forage actions forced by the starvation reflex (not an LLM decision) */
  reflexForage: number;
  /** successful eats (via eat or forage) */
  eat: number;
  /** picked an object up into empty hands (use / pick_up) */
  pickUp: number;
  /** put a held object down */
  drop: number;
  /**
   * Used a held object on a tile or on itself and something changed (tool use,
   * combining items, fuelling a fire...), plus explicit "craft" events.
   * Heuristic; excludes picking up, eating, wearing and putting down.
   */
  craft: number;
  /** put on clothing */
  wear: number;
  /** picked up a baby (nursing = carrying) */
  babyPickups: number;
  /** fed / used a held item on another person, successfully */
  feeds: number;
  /** lines spoken */
  says: number;
  /** lines spoken that at least one other agent heard */
  saysHeard: number;
}

/**
 * One character's life, birth to death. Our agents' lives only (other players
 * aren't recorded). lifeId = `${runId}:${playerId}`. Every rebirth of an agent
 * slot is a new life with its own traits.
 */
export interface LifeRecord {
  lifeId: string;
  runId: string;
  /** agent slot that played this life, e.g. "a03" */
  agentId: string;
  /** that slot's life count within the run (1-based) */
  lifeIndex: number | null;
  /** in-game player id (unique per game server process, not globally) */
  playerId: number;
  /** in-game name, updated when named; null if never named */
  name: string | null;
  female: boolean | null;
  /** game "person" object id */
  displayId: number | null;
  /** = the founder's lifeId (see LineageRecord) */
  lineageId: string;
  /** mother's lifeId if she was one of our agents' lives, else null */
  motherLifeId: string | null;
  /** mother's in-game player id (null for an Eve) */
  motherPlayerId: number | null;
  /** in-game generation (1 = Eve), as counted by the game */
  generation: number;
  /** MOCK while traitSource is "mock" */
  traits: Traits | null;
  /** true = inherited from motherLifeId with mutation; false = sampled fresh (Eve or unknown mother) */
  inherited: boolean;
  traitSource: TraitSource;
  /** ms epoch */
  bornAt: number;
  /** in-game age at birth (0 for babies, ~14 for Eves); null if unknown */
  ageAtBirth: number | null;
  birthX: number | null;
  birthY: number | null;
  /** observed death; null while alive or lost */
  diedAt: number | null;
  ageAtDeath: number | null;
  /** server's death reason without "reason_", e.g. "hunger", "age", "killed_<objectId>" */
  deathReason: string | null;
  /**
   * We stopped controlling the character without seeing it die (run stopped,
   * service restarted, slot moved on). It may live on in the world, and can
   * still become a mother, until presumedEndAt.
   */
  lostAt: number | null;
  /** latest time a lost character can still be alive (birth + rest of a 60-year lifespan); null if not lost */
  presumedEndAt: number | null;
  /** alive = being played; dead = observed death; lost = see lostAt */
  status: "alive" | "dead" | "lost";
  childLifeIds: string[];
  activity: LifeActivity;
  /** ms epoch of the last change to this record (cursor for ?since=) */
  updatedAt: number;
}

/**
 * A family tree of our agents' lives, identified by its founder: an Eve, or
 * (founderIsEve false) the first of our lives born to a mother who wasn't one
 * of our agents.
 */
export interface LineageRecord {
  lineageId: string;
  eveLifeId: string;
  eveName: string | null;
  founderIsEve: boolean;
  foundedAt: number;
  /**
   * when the last member died (or, if lost, was presumed dead); null while any
   * member may still be alive anywhere, including lost characters before presumedEndAt
   */
  extinctAt: number | null;
  /** members that may still be alive (status alive, or lost and before presumedEndAt) */
  living: number;
  livingLifeIds: string[];
  totalLives: number;
  maxGeneration: number;
  /** mean of each trait over all lives in the lineage (MOCK while traitSource is "mock") */
  meanTraits: Traits;
}

export interface LivesResponse {
  now: number;
  traitDims: string[];
  traitSource: TraitSource;
  /** sorted by updatedAt ascending */
  lives: LifeRecord[];
  /**
   * true if more records match: request again with since = the last record's
   * updatedAt. For polling, pass since = the largest updatedAt seen and dedupe by lifeId.
   */
  more: boolean;
}

export interface LineagesResponse {
  now: number;
  traitDims: string[];
  traitSource: TraitSource;
  /** newest founded first */
  lineages: LineageRecord[];
}

export interface LifeLogResponse {
  lifeId: string;
  /** this life's birth/death/thought/say/action/craft events, newest first (seq is per run) */
  events: RunEvent[];
  /** pass as ?before= to get the next (older) page; null when there are no more */
  nextBefore: number | null;
}

export interface DeathRecord {
  lifeId: string;
  lineageId: string;
  agentId: string;
  name: string | null;
  female: boolean | null;
  generation: number;
  bornAt: number;
  diedAt: number;
  ageAtDeath: number | null;
  deathReason: string | null;
  traits: Traits | null;
  inherited: boolean;
}

export interface DeathsResponse {
  now: number;
  traitSource: TraitSource;
  /** observed deaths only, newest first */
  deaths: DeathRecord[];
}
