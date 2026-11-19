// HTTP API contract between the agents service and the viewer.
// The viewer keeps a copy of this file at viewer/src/api-types.ts.
//
// GET  /api/state            -> StateResponse         (poll every ~2s)
// GET  /api/map              -> MapResponse           (poll every ~5s; union of everything any agent has seen)
// GET  /api/events?since=N   -> { events: RunEvent[] } (events with seq > N, max 500)
// GET  /api/stream           -> SSE, each message `data: <RunEvent JSON>`
// GET  /api/objects          -> { names: Record<number, string> }  object id -> display name (all objects)
// GET  /api/story/history?limit=N -> StoryHistoryResponse (past "story so far" versions, newest first; default 20, max 200)
// GET  /api/flowers          -> FlowersResponse       (the per-person flower catalogue: shapes and colours)
// GET  /api/inventions?limit=N&run=<runId|all> -> InventionsResponse (first time each technology item was made; newest first; default 20, max 200; default run = the current one)
// GET  /api/fieldnotes?limit=N -> FieldNotesResponse (the current run's field notes, newest first; default 50, max 500)
// GET  /api/leadership       -> LeadershipResponse    (who follows whom among the living, merged across agents' views)
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

import type { Flower, FlowerColor, FlowerShape } from "./flowers.ts";
export type { Flower, FlowerColor, FlowerShape };

export interface RunInfo {
  id: string;
  /** RUN_LABEL: a short label for this run, shown on the stream and site; "" = none. Missing from older services */
  label?: string;
  startedAt: number; // ms epoch
  model: string;
  memoryMode: "per-life" | "persistent";
  recipeHints: boolean;
  targetPopulation: number;
  /**
   * idle = waiting for POST /api/start; halted = run over (see haltReason);
   * paused = running, but LLM calls are suspended (see pauseKind, pauseReason,
   * resumesAt): by the rolling 24h spend cap, or because the LLM provider has
   * been down longer than LLM_OUTAGE_PAUSE_S. Characters stay in the world
   * (and may die) while paused.
   */
  status: "idle" | "running" | "paused" | "halted";
  /**
   * why the run is paused (status "paused"), else null:
   * - "daily-cap": rolling 24h spend cap; LLM calls resume when the window has room.
   * - "llm-outage": provider failing (401/402/403, 5xx, timeouts) for longer than
   *   LLM_OUTAGE_PAUSE_S. Every agent is disconnected and no one logs in; lives
   *   alive during the outage get outage: true / validForStudy: false. The run
   *   resumes by itself once a probe call succeeds (resumesAt = next probe);
   *   agents log back in with the same emails, so living characters are resumed.
   */
  pauseKind?: "daily-cap" | "llm-outage" | null;
  haltReason: string | null;
  /** maxCostUsd 0 = no per-run cap. In continuous mode the generation/lives/runtime limits are ignored. */
  limits: { maxGeneration: number; maxLives: number; maxRuntimeMin: number; maxCostUsd: number };
  /** CONTINUOUS=1: always-on, no generation/lives/runtime halts */
  continuous?: boolean;
  /** why the run is paused (status "paused"), else null */
  pauseReason?: string | null;
  /** ms epoch when the 24h window will have room again (daily cap) or of the next provider probe (outage), else null */
  resumesAt?: number | null;
  /** LLM spend over the last 24h, across all runs and restarts; capUsd 0 = no daily cap */
  dailySpend?: { last24hUsd: number; capUsd: number };
  /** LLM provider health (see LlmStatus). Always sent by the agents service. */
  llmStatus?: LlmStatus;
  /**
   * Game clock slowdown k (TIME_SCALE): one game year = 60 s x timeScale of
   * wall time (stock OHOL: 1). Always sent by the agents service; treat missing as 1.
   */
  timeScale?: number;
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
  /**
   * ms epoch of the first outage-class failure (401/402/403, 5xx, timeout,
   * network error) in the current failing streak; null while ok or when only
   * rate-limited (429) / bad requests. Past LLM_OUTAGE_PAUSE_S the run pauses.
   */
  outageSince?: number | null;
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
  /** the current life's flower (see LifeRecord.flower); null between lives */
  flower?: Flower | null;
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
  /** a wound or sickness this person carries (shown on their body in the game), e.g. { kind: "wound", name: "Bite Wound" }; null if none */
  condition?: { kind: "wound" | "sickness"; name: string } | null;
  /** outside their family's homeland (their own agent got the server's homesick cue) */
  homesick?: boolean;
  moving: boolean; // walking right now
  displayId: number; // game "person" object id (encodes skin tone / gender in the real game)
  /** set when this character is one of our agents' lives (this run or an earlier one), else null */
  lifeId?: string | null;
  lineageId?: string | null;
  /** that life's flower (see LifeRecord.flower); set when lifeId is known, else null */
  flower?: Flower | null;
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
 * character dies the focus stays on them for ~8s, then moves on. Otherwise it
 * holds for at least DIRECTOR_MIN_DWELL_MS.
 */
export interface Focus {
  agentId: string | null;
  /** which life of that slot: "<agentId>:<lifeIndex>", e.g. "a03:2" */
  lifeId?: string | null;
  since: number; // ms epoch when this focus started
  /** @deprecated always null: the director no longer gives a reason (kept so older clients still parse) */
  reason: string | null;
  /**
   * A short cutaway in progress (DIRECTOR_CUTAWAY_MS, ~10s): the camera shows
   * `target` instead, then returns to agentId (still the main subject, so
   * clients that ignore this field keep showing the subject). Absent/null otherwise.
   */
  cutaway?: Cutaway | null;
}

/** What a cutaway shows: a character, a dangerous animal (its latest known tile; animals move) or a tile. */
export type CutawayTarget =
  | { type: "person"; id: string; lifeId: string | null; playerId: number | null; name: string | null }
  | { type: "animal"; objectId: number; x: number; y: number; name: string }
  | { type: "tile"; x: number; y: number };

export interface Cutaway {
  kind: "cutaway";
  target: CutawayTarget;
  /** short caption, e.g. "Grizzly Bear near LIRA TIDEWICK" (may contain character names) */
  label: string;
  /** why: which rule picked it ("animal", "birth", "handover", "starving", "speech") */
  reason: string;
  since: number; // ms epoch
  /** ms epoch when the camera returns to the subject */
  until: number;
  /** the main subject's agentId (= Focus.agentId) */
  returnTo: string | null;
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

/**
 * The first time any character in a world (run) made a technology item: one per item per run,
 * persisted in LOG_DIR/inventions.jsonl across restarts. "Technology" is decided from game data:
 * made by a transition (crafted or transformed, incl. the craft macro), not food, not a natural
 * object or its states, not gathered by hand, not a pickup (rule: agents/src/inventions.ts).
 */
export interface Invention {
  /** display name of the item ("Sharp Stone") */
  item: string;
  /** OHOL object id (for its sprite); absent if unknown */
  objectId?: number;
  /** the maker's life (LifeRecord.lifeId), null if unknown */
  lifeId: string | null;
  /** the maker's name at the time, null if unnamed */
  name: string | null;
  t: number; // ms epoch
  runId: string;
}

export interface InventionsResponse {
  inventions: Invention[]; // newest first
}

/**
 * A researcher-style field note on the current run (fieldnotes.ts): every FIELD_NOTES_INTERVAL_MS
 * (20 min) one entry covering the time since the previous note; a run's first note covers the run
 * from its start. Plain text: paragraphs separated by a blank line, bullet lines start with "- ".
 */
export interface FieldNote {
  t: number; // ms epoch, when it was written
  runId: string;
  windowStart: number; // ms epoch
  windowEnd: number; // ms epoch
  text: string;
  model: string;
}

export interface FieldNotesResponse {
  notes: FieldNote[]; // the current run's, newest first
}

/** One "follows" link: `follower` follows `leader` (player ids; both alive). */
export interface LeadershipEdge {
  follower: number;
  leader: number;
}

/** A living person in GET /api/leadership. */
export interface LeadershipPerson {
  id: number; // player id
  name: string | null;
  age: number; // years, 1 decimal
  female: boolean | null;
  /** first of a family: generation 1, no ancestors */
  isEve: boolean;
  /** the surname (last word of the name); null while unnamed */
  family: string | null;
  alive: boolean; // always true: living people only
  lifeId?: string | null;
  flower?: Flower | null;
}

/**
 * GET /api/leadership: who follows whom right now (the server's FW messages, merged across every
 * living agent's view; the most recently received report wins). Living people only; edges between
 * living people only, never a cycle. `people` lists everyone alive, leaders and followers or not.
 */
export interface LeadershipResponse {
  runId: string;
  at: number; // ms epoch
  edges: LeadershipEdge[];
  people: LeadershipPerson[];
}

/** [x, y, biome, floorId, objectId] ; objectId/floorId 0 = empty */
export type MapCellTuple = [number, number, number, number, number];

/**
 * GET /api/minimap: every cell any agent has seen in this world, coarsened to
 * one sample per `block` x `block` tiles (biome only; floor and obj are 0), so
 * the stream's inset can show the whole explored world.
 */
export interface MinimapResponse {
  block: number;
  cells: MapCellTuple[];
}

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
  | "focus" // stream camera moved. agentId/playerId/name = new focus (all null if no one is alive); text = "camera follows <name>" (or "no one is alive"); data: { lifeId, previous: agentId | null, cause: "initial" | "switch" | "death" | "disconnect" | "empty" | "cutaway" | "cutaway-end", cutaway?: Cutaway (cause "cutaway"; agentId stays the main subject) }
  | "system" // run start/stop, errors
  | "issue"; // tester mode (TESTER_GOALS): text = a problem the model reported with the game or its controls (the reply's "issue"); data: { lifeId, lineageId, turn?, x, y, held, goal }. Also in issues.jsonl

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
  /**
   * game clock slowdown k in force when this life was born (RunInfo.timeScale):
   * one game year of this life = 60 s x timeScale of wall time. Lives from
   * different runs can differ. Always sent by the agents service; older records = 1.
   */
  timeScale?: number;
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
  /** latest time a lost character can still be alive (birth + rest of a 60-year lifespan, in this life's timeScale); null if not lost */
  presumedEndAt: number | null;
  /** alive = being played; dead = observed death; lost = see lostAt */
  status: "alive" | "dead" | "lost";
  childLifeIds: string[];
  activity: LifeActivity;
  /**
   * true = this character was alive while the LLM provider was down long enough
   * to pause the run (LLM_OUTAGE_PAUSE_S): for part of its life it couldn't
   * think, so it isn't comparable. Always sent by the agents service (false if not).
   */
  outage?: boolean;
  /**
   * false = exclude from study analyses (currently: outage). Always sent by the
   * agents service; older records without it are valid.
   */
  validForStudy?: boolean;
  /**
   * The flower this character wears in its hair (a declared intervention, to tell family members
   * apart). Always sent by the agents service: assigned at birth, unique among the living members
   * of the lineage, stable for life. null/absent only in old fixtures.
   */
  flower?: Flower | null;
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
  /** as LifeRecord.timeScale. Always sent by the agents service; missing = 1. */
  timeScale?: number;
  ageAtDeath: number | null;
  deathReason: string | null;
  traits: Traits | null;
  inherited: boolean;
  /** as LifeRecord.validForStudy (false = alive during an LLM outage). Always sent by the agents service. */
  validForStudy?: boolean;
}

/** GET /api/flowers: the catalogue LifeRecord.flower draws from (Flower.shape / Flower.color are ids here). */
export interface FlowersResponse {
  shapes: FlowerShape[];
  colors: FlowerColor[];
}

export interface DeathsResponse {
  now: number;
  traitSource: TraitSource;
  /** observed deaths only, newest first */
  deaths: DeathRecord[];
}

// ------------------------------------------------------------------ GET /api/agent-spec

/**
 * GET /api/agent-spec: what an agent is told and can do, rendered from the
 * agents service's own code and config (agents/src/agentspec.ts), plus one
 * real recent turn. Cached for about 60 s.
 */
export interface AgentSpecResponse {
  now: number;
  /** the current run (the example turn comes from its logs) */
  runId: string | null;
  /** the system prompt, exactly as sent on every decision (systemPromptFor(config)) */
  systemPrompt: string;
  /** appended after the observation in the one user message of every call */
  userSuffix: string;
  /** fields of the reply JSON object */
  replyFields: { name: string; meaning: string }[];
  /** the headings of the note-taker's yearly notes (YOUR NOTES), in order */
  noteHeadings: string[];
  /** every action, parsed from the prompt's own action list */
  actions: AgentSpecAction[];
  /** the action types the reply parser accepts (reply.ts) */
  validActionTypes: string[];
  settings: AgentSpecSettings;
  /** observation and hearing limits, in tiles / seconds / lines */
  limits: AgentSpecLimits;
  /** letters a person can say at an age (the client's getSayLimit) */
  sayLimits: { age: number; letters: number }[];
  /** declared interventions on top of the original game (README "Interventions") */
  interventions: AgentSpecIntervention[];
  /** the most recent completed decision by an adult in this run; null if none yet */
  example: AgentSpecExample | null;
}

export interface AgentSpecAction {
  /** "use", "go", ... */
  type: string;
  /** the template the model reads, e.g. {"type":"use","x":X,"y":Y} */
  template: string;
  /** argument names in the template ("x", "y", "person", ...) */
  fields: string[];
  /** the prompt's one-line meaning */
  meaning: string;
  /** how the harness carries it out, beyond the prompt's line (e.g. what search returns) */
  note?: string;
  /** a temporary intervention (the craft macro) */
  temporary?: boolean;
}

/** A game-server setting: OHOL_SETTING_<name> if set, else server/settings/<name>.ini as shipped. */
export interface ServerSetting {
  value: string | null;
  source: "env" | "settings file" | "unknown";
}

export interface AgentSpecSettings {
  /** the agents' model (every agent uses it) */
  model: string;
  /** the agents' model runs on our own server (not via OpenRouter) */
  selfHosted: boolean;
  /** models for the narrator / director / story / field notes (they never talk to agents); director null = heuristic, fieldNotes null = off */
  overheadModels: { narrator: string; director: string | null; story: string; fieldNotes: string | null };
  /** the stream director's shortest shot and its cutaway length (ms); null = off */
  directorMinDwellMs: number | null;
  directorCutawayMs: number | null;
  /** a field-notes write-up every this many ms; null = off */
  fieldNotesIntervalMs: number | null;
  /** the turn clock (TURN_CLOCK=1): the world is paused while agents think, then runs gameSecondsPerTurn per turn */
  turnClock: boolean;
  /** turn clock: replies later than this (ms) are dropped and the agent sits the turn out */
  turnDecideTimeoutMs: number;
  /** turn clock: a baby under 3 with nothing happening decides at most every this many turns */
  babyIdleTurns: number;
  /** one turn: ms from one decision's start to the next (turn clock: ms of the game-paced clock, not real time) */
  decisionCycleMs: number;
  /** without the turn clock: minimum ms between decisions under age 2 */
  babyDecisionIntervalMs: number;
  /** without the turn clock: a baby with nothing happening is asked at most this often (ms) */
  babyIdleMaxMs: number;
  /** game clock slowdown k (1 = stock) */
  timeScale: number;
  /** game seconds that pass in one turn */
  gameSecondsPerTurn: number;
  /** turns per year of life (a year is 60 game seconds) */
  turnsPerYear: number;
  reasoningCap: boolean;
  reasoningMaxTokens: number;
  decisionMaxTokens: number;
  /** the full token budget (uncapped calls and retries) */
  maxTokens: number;
  reasoningEffort: string | null;
  actionListMax: number;
  /** PROMPT_BASELINE: "new" = a first-time player's facts, no recipes or strategy; "playbook" = game facts and a ranked playbook */
  promptBaseline: "new" | "playbook";
  craftMacro: boolean;
  recipeHints: boolean;
  memoryMode: "per-life" | "persistent";
  /** the old note-taker's yearly notes (off by default; MEMORY_SUMMARY=1), every memorySummaryTurns turns */
  memorySummary: boolean;
  memorySummaryTurns: number;
  traitSource: TraitSource;
  foodBonus: ServerSetting;
  foodBonusSecondsPerPip: ServerSetting;
  freeNames: ServerSetting;
  playerSaves: ServerSetting;
  /** early birth cap: at most earlyMaxBabies per woman in generations 1..earlyMaxGenerations (0 = off) */
  earlyMaxBabies: ServerSetting;
  earlyMaxGenerations: ServerSetting;
  /** 1 = a mother on her birth cooldown never gets a baby (stock bypasses it when every mother is on one) */
  noCooldownBypass: ServerSetting;
  /** family languages apply from this many players */
  languagesMinPlayers: ServerSetting;
  /** game seconds of living together to learn most of another family's language (0 = off, stock) */
  langLearnSeconds: ServerSetting;
}

export interface AgentSpecLimits {
  viewRadius: number;
  peopleRadius: number;
  resourceRadius: number;
  maxThingKinds: number;
  maxHints: number;
  maxPeople: number;
  historyShown: number;
  /** heard lines stay this long (wall s; with the turn clock see heardTurns) */
  heardWindowS: number;
  /** turns a heard line stays in HEARD */
  heardTurns: number;
  heardMax: number;
  /** WHAT YOU SAW NEARBY: events from the last seenTurns turns, at most seenMax lines, seenPerPersonPerTurn about one person a turn */
  seenTurns: number;
  seenMax: number;
  seenPerPersonPerTurn: number;
  /** the old note-taker's yearly notes (off by default): at most this many lines of this many chars */
  memoryLines: number;
  memoryLineChars: number;
  /** entries the agent can keep in THINGS YOU CHOSE TO REMEMBER, and one entry's max length */
  keptMax: number;
  rememberChars: number;
  /** steps shown in the SEARCH section */
  searchSteps: number;
  /** use / drop / swap / take_out refuse a tile farther than this */
  maxActDist: number;
  /** speech this close (tiles) wakes an agent before its turn */
  wakeSpeechRadius: number;
  /** the server delivers speech this far (tiles) */
  hearingRadius: number;
  /** the starvation reflex fires at this food or less */
  reflexFood: number;
}

export type InterventionCategory = "human-ui" | "wiki" | "beyond-human" | "game-setting";

export interface AgentSpecIntervention {
  id: string;
  name: string;
  category: InterventionCategory;
  /** null = unknown (a game-server setting the agents service can't see) */
  on: boolean | null;
  detail: string;
}

/** One real decision, cleaned (no control characters) and size-capped. Render as text only. */
export interface AgentSpecExample {
  /** when the reply arrived */
  t: number;
  agentId: string;
  playerId: number | null;
  lifeIndex: number | null;
  model: string | null;
  age: number;
  /** the observation, as the model read it (multi-line) */
  observation: string;
  /** the model's reasoning text, when the provider returned it */
  reasoning: string | null;
  /** the reply as written */
  replyText: string;
  /** the reply as the harness read it: known fields only */
  reply: { thought?: string; goal?: string; say?: string; remember?: string; forget?: string; action?: Record<string, unknown>; actions?: Record<string, unknown>[] };
  /** each step's result, as the agent is told next turn */
  results: { action: string; result: string }[];
  /** what was actually said (cut to the age limit by the server) */
  said: string | null;
}
