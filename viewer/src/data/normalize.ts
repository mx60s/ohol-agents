// Defensive normalisation of API responses. The backend may be older or newer
// than this viewer, a fixture may be hand-written, and optional fields come and
// go; everything the hooks hand to components goes through here so pages can
// rely on arrays being arrays and numbers being numbers.

import type {
  Cutaway,
  CutawayTarget,
  AgentSpecExample,
  AgentSpecIntervention,
  AgentSpecLimits,
  AgentSpecResponse,
  AgentSpecSettings,
  AgentView,
  DeathRecord,
  DeathsResponse,
  LifeActivity,
  LifeLogResponse,
  LifeRecord,
  LineageRecord,
  LineagesResponse,
  LivesResponse,
  LlmStatus,
  MapResponse,
  MinimapResponse,
  PlayerView,
  RunEvent,
  RunInfo,
  ServerSetting,
  StateResponse,
  Stats,
  StoryHistoryResponse,
  Invention,
  InventionsResponse,
  FieldNote,
  FieldNotesResponse,
  LeadershipEdge,
  LeadershipPerson,
  LeadershipResponse,
  StorySoFar,
  TraitSource,
  Traits,
} from "../api-types.ts";
import { canonicalFlower } from "../flowers.ts";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const arr = <T>(v: unknown, f: (x: unknown) => T | null): T[] =>
  Array.isArray(v) ? v.map(f).filter((x): x is T => x !== null) : [];
const num = (v: unknown, d = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : d);
const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown, d = ""): string => (typeof v === "string" ? v : d);
const strOrNull = (v: unknown): string | null => (typeof v === "string" ? v : null);
const boolOrNull = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
/** a positive time scale (game clock slowdown), else 1 */
const scaleOf = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 1);
const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

export function normTraitSource(v: unknown): TraitSource {
  return v === "steered" ? "steered" : "mock";
}

/** Keep finite numeric entries only. Returns null for a missing/empty vector. */
export function normTraits(v: unknown): Traits | null {
  if (!isObj(v)) return null;
  const out: Traits = {};
  for (const [k, x] of Object.entries(v)) if (typeof x === "number" && Number.isFinite(x)) out[k] = x;
  return Object.keys(out).length ? out : null;
}

export const EMPTY_STATS: Stats = { alive: 0, totalBirths: 0, totalDeaths: 0, maxGeneration: 0, families: 0, llmCalls: 0, llmCostUsd: 0 };

/** LLM provider health; null when the backend doesn't send it (older agents service, fixtures) */
export function normLlmStatus(v: unknown): LlmStatus | null {
  if (!isObj(v) || typeof v.ok !== "boolean") return null;
  return {
    ok: v.ok,
    lastError: strOrNull(v.lastError),
    since: numOrNull(v.since),
    consecutiveFailures: num(v.consecutiveFailures),
    retryAt: numOrNull(v.retryAt),
    outageSince: numOrNull(v.outageSince),
  };
}

function normRun(v: unknown): RunInfo {
  const r = isObj(v) ? v : {};
  const lim = isObj(r.limits) ? r.limits : {};
  const status = r.status === "idle" || r.status === "paused" || r.status === "halted" ? r.status : "running";
  const ds = isObj(r.dailySpend) ? r.dailySpend : null;
  return {
    id: str(r.id, "unknown"),
    startedAt: num(r.startedAt),
    model: str(r.model, "unknown model"),
    memoryMode: r.memoryMode === "persistent" ? "persistent" : "per-life",
    recipeHints: r.recipeHints === true,
    targetPopulation: num(r.targetPopulation),
    status,
    haltReason: strOrNull(r.haltReason),
    limits: { maxGeneration: num(lim.maxGeneration), maxLives: num(lim.maxLives), maxRuntimeMin: num(lim.maxRuntimeMin), maxCostUsd: num(lim.maxCostUsd) },
    continuous: r.continuous === true,
    pauseKind: r.pauseKind === "daily-cap" || r.pauseKind === "llm-outage" ? r.pauseKind : null,
    pauseReason: strOrNull(r.pauseReason),
    resumesAt: numOrNull(r.resumesAt),
    dailySpend: ds ? { last24hUsd: num(ds.last24hUsd), capUsd: num(ds.capUsd) } : undefined,
    llmStatus: normLlmStatus(r.llmStatus) ?? undefined,
    timeScale: scaleOf(r.timeScale),
  };
}

function normAgent(v: unknown): AgentView | null {
  if (!isObj(v) || typeof v.agentId !== "string") return null;
  const status = v.status === "alive" || v.status === "dead" || v.status === "waiting" ? v.status : "connecting";
  return {
    agentId: v.agentId,
    lifeIndex: num(v.lifeIndex, 1),
    status,
    playerId: numOrNull(v.playerId),
    name: strOrNull(v.name),
    x: numOrNull(v.x),
    y: numOrNull(v.y),
    age: numOrNull(v.age),
    female: boolOrNull(v.female),
    food: numOrNull(v.food),
    foodCapacity: numOrNull(v.foodCapacity),
    heat: numOrNull(v.heat),
    held: strOrNull(v.held),
    motherId: numOrNull(v.motherId),
    eveId: numOrNull(v.eveId),
    generation: numOrNull(v.generation),
    goal: strOrNull(v.goal),
    lastThought: strOrNull(v.lastThought),
    lastAction: strOrNull(v.lastAction),
    lastSaid: strOrNull(v.lastSaid),
    lifeId: strOrNull(v.lifeId),
    lineageId: strOrNull(v.lineageId),
    traits: normTraits(v.traits),
  };
}

function normCondition(v: unknown): PlayerView["condition"] {
  if (!isObj(v) || (v.kind !== "wound" && v.kind !== "sickness") || typeof v.name !== "string" || !v.name.trim()) return null;
  return { kind: v.kind, name: v.name.trim().slice(0, 60) };
}

function normPlayer(v: unknown): PlayerView | null {
  if (!isObj(v) || typeof v.id !== "number") return null;
  return {
    id: v.id,
    x: num(v.x),
    y: num(v.y),
    age: num(v.age),
    female: boolOrNull(v.female),
    name: strOrNull(v.name),
    held: strOrNull(v.held),
    agentId: strOrNull(v.agentId),
    dying: v.dying === true,
    condition: normCondition(v.condition),
    homesick: v.homesick === true,
    moving: v.moving === true,
    displayId: num(v.displayId, 19),
    lifeId: strOrNull(v.lifeId),
    lineageId: strOrNull(v.lineageId),
  };
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** A cutaway in Focus; null if absent or malformed (older servers never send one). */
export function normCutaway(v: unknown): Cutaway | null {
  if (!isObj(v) || !isObj(v.target) || !finite(v.until)) return null;
  const t = v.target;
  let target: CutawayTarget;
  if (t.type === "person" && typeof t.id === "string") target = { type: "person", id: t.id, lifeId: strOrNull(t.lifeId), playerId: numOrNull(t.playerId), name: strOrNull(t.name) };
  else if (t.type === "animal" && finite(t.objectId) && finite(t.x) && finite(t.y)) target = { type: "animal", objectId: t.objectId, x: t.x, y: t.y, name: typeof t.name === "string" ? t.name : "" };
  else if (t.type === "tile" && finite(t.x) && finite(t.y)) target = { type: "tile", x: t.x, y: t.y };
  else return null;
  return { kind: "cutaway", target, label: typeof v.label === "string" ? v.label : "", reason: typeof v.reason === "string" ? v.reason : "", since: num(v.since), until: v.until, returnTo: strOrNull(v.returnTo) };
}

function normStory(v: unknown): StorySoFar | null {
  if (!isObj(v) || typeof v.text !== "string") return null;
  return { text: v.text, updatedAt: num(v.updatedAt) };
}

export function normState(v: unknown): StateResponse {
  const s = isObj(v) ? v : {};
  const st = isObj(s.stats) ? s.stats : {};
  const f = isObj(s.focus) ? s.focus : null;
  const c = isObj(s.control) ? s.control : null;
  return {
    run: normRun(s.run),
    control: c ? { open: c.open === true, totalCostUsd: num(c.totalCostUsd), maxTotalCostUsd: num(c.maxTotalCostUsd) } : undefined,
    traitDims: strArr(s.traitDims),
    traitSource: normTraitSource(s.traitSource),
    now: num(s.now, Date.now()),
    agents: arr(s.agents, normAgent),
    players: arr(s.players, normPlayer),
    stats: {
      alive: num(st.alive),
      totalBirths: num(st.totalBirths),
      totalDeaths: num(st.totalDeaths),
      maxGeneration: num(st.maxGeneration),
      families: num(st.families),
      llmCalls: num(st.llmCalls),
      llmCostUsd: num(st.llmCostUsd),
    },
    focus: f
      ? { agentId: strOrNull(f.agentId), lifeId: strOrNull(f.lifeId), since: num(f.since), reason: strOrNull(f.reason), cutaway: normCutaway(f.cutaway) }
      : { agentId: null, lifeId: null, since: 0, reason: null },
    story: normStory(s.story),
  };
}

const ACTIVITY_KEYS: (keyof LifeActivity)[] = [
  "thoughts", "actions", "failedActions", "moves", "tilesWalked", "maxDistFromBirth", "forage", "reflexForage",
  "eat", "pickUp", "drop", "craft", "wear", "babyPickups", "feeds", "says", "saysHeard",
];

export function normActivity(v: unknown): LifeActivity {
  const a = isObj(v) ? v : {};
  const out = {} as LifeActivity;
  for (const k of ACTIVITY_KEYS) out[k] = num(a[k]);
  return out;
}

export function normLife(v: unknown): LifeRecord | null {
  if (!isObj(v) || typeof v.lifeId !== "string") return null;
  const status = v.status === "dead" || v.status === "lost" ? v.status : v.diedAt != null ? "dead" : "alive";
  return {
    lifeId: v.lifeId,
    runId: str(v.runId, v.lifeId.split(":")[0] ?? ""),
    agentId: str(v.agentId, "?"),
    lifeIndex: numOrNull(v.lifeIndex),
    playerId: num(v.playerId),
    name: strOrNull(v.name),
    female: boolOrNull(v.female),
    displayId: numOrNull(v.displayId),
    lineageId: str(v.lineageId, v.lifeId),
    motherLifeId: strOrNull(v.motherLifeId),
    motherPlayerId: numOrNull(v.motherPlayerId),
    generation: num(v.generation, 1),
    traits: normTraits(v.traits),
    inherited: v.inherited === true,
    traitSource: normTraitSource(v.traitSource),
    bornAt: num(v.bornAt),
    timeScale: scaleOf(v.timeScale),
    ageAtBirth: numOrNull(v.ageAtBirth),
    birthX: numOrNull(v.birthX),
    birthY: numOrNull(v.birthY),
    diedAt: numOrNull(v.diedAt),
    ageAtDeath: numOrNull(v.ageAtDeath),
    deathReason: strOrNull(v.deathReason),
    lostAt: numOrNull(v.lostAt),
    presumedEndAt: numOrNull(v.presumedEndAt),
    status,
    childLifeIds: strArr(v.childLifeIds),
    activity: normActivity(v.activity),
    outage: v.outage === true,
    validForStudy: v.validForStudy !== false && v.outage !== true,
    updatedAt: num(v.updatedAt, num(v.bornAt)),
    // forward-compatible: a backend-written personality summary (see shared/personality.ts)
    ...(typeof v.personalitySummary === "string" ? { personalitySummary: v.personalitySummary } : {}),
  } as LifeRecord;
}

export function normLives(v: unknown): LivesResponse {
  const r = isObj(v) ? v : {};
  return {
    now: num(r.now, Date.now()),
    traitDims: strArr(r.traitDims),
    traitSource: normTraitSource(r.traitSource),
    lives: arr(r.lives, normLife),
    more: r.more === true,
  };
}

export function normLineage(v: unknown): LineageRecord | null {
  if (!isObj(v) || typeof v.lineageId !== "string") return null;
  return {
    lineageId: v.lineageId,
    eveLifeId: str(v.eveLifeId, v.lineageId),
    eveName: strOrNull(v.eveName),
    founderIsEve: v.founderIsEve !== false,
    foundedAt: num(v.foundedAt),
    extinctAt: numOrNull(v.extinctAt),
    living: num(v.living),
    livingLifeIds: strArr(v.livingLifeIds),
    totalLives: num(v.totalLives),
    maxGeneration: num(v.maxGeneration, 1),
    meanTraits: normTraits(v.meanTraits) ?? {},
  };
}

export function normLineages(v: unknown): LineagesResponse {
  const r = isObj(v) ? v : {};
  return { now: num(r.now, Date.now()), traitDims: strArr(r.traitDims), traitSource: normTraitSource(r.traitSource), lineages: arr(r.lineages, normLineage) };
}

export function normDeath(v: unknown): DeathRecord | null {
  if (!isObj(v) || typeof v.lifeId !== "string") return null;
  return {
    lifeId: v.lifeId,
    lineageId: str(v.lineageId, v.lifeId),
    agentId: str(v.agentId, "?"),
    name: strOrNull(v.name),
    female: boolOrNull(v.female),
    generation: num(v.generation, 1),
    bornAt: num(v.bornAt),
    diedAt: num(v.diedAt),
    timeScale: scaleOf(v.timeScale),
    ageAtDeath: numOrNull(v.ageAtDeath),
    deathReason: strOrNull(v.deathReason),
    traits: normTraits(v.traits),
    inherited: v.inherited === true,
    validForStudy: v.validForStudy !== false,
  };
}

export function normDeaths(v: unknown): DeathsResponse {
  const r = isObj(v) ? v : {};
  return { now: num(r.now, Date.now()), traitSource: normTraitSource(r.traitSource), deaths: arr(r.deaths, normDeath) };
}

export function normEvent(v: unknown): RunEvent | null {
  if (!isObj(v) || typeof v.seq !== "number" || typeof v.kind !== "string") return null;
  return {
    seq: v.seq,
    t: num(v.t),
    kind: v.kind as RunEvent["kind"],
    agentId: strOrNull(v.agentId),
    playerId: numOrNull(v.playerId),
    name: strOrNull(v.name),
    text: str(v.text),
    data: isObj(v.data) ? v.data : undefined,
  };
}

export function normEvents(v: unknown): RunEvent[] {
  return arr(isObj(v) ? v.events : v, normEvent);
}

export function normLifeLog(v: unknown, lifeId: string): LifeLogResponse {
  const r = isObj(v) ? v : {};
  return { lifeId: str(r.lifeId, lifeId), events: arr(r.events, normEvent), nextBefore: numOrNull(r.nextBefore) };
}

export function normMap(v: unknown): MapResponse {
  const r = isObj(v) ? v : {};
  const cells = Array.isArray(r.cells)
    ? (r.cells.filter((c) => Array.isArray(c) && c.length >= 5 && c.every((x) => typeof x === "number")) as MapResponse["cells"])
    : [];
  return { cells, names: normNames(r.names) };
}

export function normMinimap(v: unknown): MinimapResponse {
  const r = isObj(v) ? v : {};
  const block = typeof r.block === "number" && r.block >= 1 && r.block <= 64 ? Math.floor(r.block) : 1;
  return { block, cells: normMap({ cells: r.cells }).cells };
}

export function normNames(v: unknown): Record<number, string> {
  const out: Record<number, string> = {};
  if (isObj(v)) for (const [k, x] of Object.entries(v)) if (typeof x === "string") out[Number(k)] = x;
  return out;
}

export function normStoryHistory(v: unknown): StoryHistoryResponse {
  const r = isObj(v) ? v : {};
  return {
    history: arr(r.history, (x) => {
      const s = normStory(x);
      return s && isObj(x) ? { ...s, runId: strOrNull(x.runId) } : null;
    }),
  };
}

/** GET /api/inventions: drop malformed rows; newest first (re-sorted, a fixture may be hand-written). */
export function normInventions(v: unknown): InventionsResponse {
  const r = isObj(v) ? v : {};
  const rows = arr(r.inventions, (x): Invention | null => {
    if (!isObj(x)) return null;
    const item = str(x.item).trim();
    const t = num(x.t, NaN);
    if (!item || !Number.isFinite(t)) return null;
    const objectId = numOrNull(x.objectId);
    return { item, ...(objectId != null && objectId > 0 ? { objectId } : {}), lifeId: strOrNull(x.lifeId), name: strOrNull(x.name), t, runId: str(x.runId) };
  });
  return { inventions: rows.sort((a, b) => b.t - a.t) };
}

/** GET /api/fieldnotes: drop malformed rows (no text, bad times, an end before the start); newest first. */
export function normFieldNotes(v: unknown): FieldNotesResponse {
  const r = isObj(v) ? v : {};
  const rows = arr(r.notes, (x): FieldNote | null => {
    if (!isObj(x)) return null;
    const text = str(x.text).replace(/\r\n?/g, "\n").trim();
    const windowStart = num(x.windowStart, NaN);
    const windowEnd = num(x.windowEnd, NaN);
    if (!text || !Number.isFinite(windowStart) || !Number.isFinite(windowEnd) || windowEnd < windowStart) return null;
    return { t: num(x.t, windowEnd), runId: str(x.runId), windowStart, windowEnd, text, model: str(x.model) };
  });
  return { notes: rows.sort((a, b) => b.windowEnd - a.windowEnd) };
}

/**
 * GET /api/leadership: living people with an integer id (first copy wins), edges between listed people
 * only (one leader per follower, the last listed wins; no self-follows). Cycles are left to the
 * tree builder (site/leadership.ts), which guards against them.
 */
export function normLeadership(v: unknown): LeadershipResponse {
  const r = isObj(v) ? v : {};
  const seen = new Set<number>();
  const people = arr(r.people, (x): LeadershipPerson | null => {
    if (!isObj(x)) return null;
    const id = num(x.id, NaN);
    // living people only (the API never sends anyone else; a hand-written fixture might)
    if (!Number.isInteger(id) || seen.has(id) || x.alive === false) return null;
    seen.add(id);
    const name = strOrNull(x.name)?.trim() || null;
    const family = strOrNull(x.family)?.trim() || null;
    return {
      id, name, age: num(x.age), female: boolOrNull(x.female), isEve: x.isEve === true, family, alive: true,
      lifeId: strOrNull(x.lifeId), flower: canonicalFlower(x.flower),
    };
  });
  const leaderOf = new Map<number, number>();
  for (const x of Array.isArray(r.edges) ? r.edges : []) {
    if (!isObj(x)) continue;
    const follower = num(x.follower, NaN);
    const leader = num(x.leader, NaN);
    if (follower === leader || !seen.has(follower) || !seen.has(leader)) continue;
    leaderOf.set(follower, leader);
  }
  const edges: LeadershipEdge[] = [...leaderOf].map(([follower, leader]) => ({ follower, leader }));
  return { runId: str(r.runId), at: num(r.at), edges, people };
}

// ------------------------------------------------------------------ /api/agent-spec

const CATEGORIES = ["human-ui", "wiki", "beyond-human", "game-setting"] as const;

function normServerSetting(v: unknown): ServerSetting {
  const r = isObj(v) ? v : {};
  const source = r.source === "env" || r.source === "settings file" ? r.source : "unknown";
  return { value: strOrNull(r.value), source };
}

/** The numeric fields of d, read from v (non-numbers fall back to d's value). */
function numRecord<T extends { [K in keyof T]: number }>(v: unknown, d: T): T {
  const r = isObj(v) ? v : {};
  const out = { ...d };
  for (const k of Object.keys(d) as (keyof T & string)[]) out[k] = num(r[k], d[k]) as T[keyof T & string];
  return out;
}

const LIMITS0: AgentSpecLimits = {
  viewRadius: 0, peopleRadius: 0, resourceRadius: 0, maxThingKinds: 0, maxHints: 0, maxPeople: 0, historyShown: 0, heardWindowS: 0, heardMax: 0,
  heardTurns: 0, seenTurns: 0, seenMax: 0, seenPerPersonPerTurn: 0, memoryLines: 0, memoryLineChars: 0, rememberExtraLines: 0, rememberChars: 0, searchSteps: 0,
  maxActDist: 0, wakeSpeechRadius: 0, hearingRadius: 0, reflexFood: 0,
};

function normAgentExample(v: unknown): AgentSpecExample | null {
  if (!isObj(v) || typeof v.observation !== "string") return null;
  const rep = isObj(v.reply) ? v.reply : {};
  const reply: AgentSpecExample["reply"] = {};
  for (const k of ["thought", "goal", "say", "remember"] as const) if (typeof rep[k] === "string") reply[k] = rep[k] as string;
  if (isObj(rep.action)) reply.action = rep.action;
  if (Array.isArray(rep.actions)) reply.actions = rep.actions.filter(isObj);
  return {
    t: num(v.t),
    agentId: str(v.agentId),
    playerId: numOrNull(v.playerId),
    lifeIndex: numOrNull(v.lifeIndex),
    model: strOrNull(v.model),
    age: num(v.age),
    observation: v.observation,
    reasoning: strOrNull(v.reasoning),
    replyText: str(v.replyText),
    reply,
    results: arr(v.results, (x) => (isObj(x) ? { action: str(x.action), result: str(x.result) } : null)),
    said: strOrNull(v.said),
  };
}

/** null when the body isn't an agent spec (an older service: 404, or the page fallback). */
export function normAgentSpec(v: unknown): AgentSpecResponse | null {
  if (!isObj(v) || typeof v.systemPrompt !== "string") return null;
  const s = isObj(v.settings) ? v.settings : {};
  const om = isObj(s.overheadModels) ? s.overheadModels : {};
  const settings: AgentSpecSettings = {
    model: str(s.model),
    selfHosted: s.selfHosted === true,
    overheadModels: { narrator: str(om.narrator), director: strOrNull(om.director), story: str(om.story), fieldNotes: strOrNull(om.fieldNotes) },
    ...numRecord(s, {
      decisionCycleMs: 0, babyDecisionIntervalMs: 0, babyIdleMaxMs: 0, timeScale: 1, gameSecondsPerTurn: 0, turnsPerYear: 0,
      reasoningMaxTokens: 0, decisionMaxTokens: 0, maxTokens: 0, actionListMax: 1, turnDecideTimeoutMs: 0, babyIdleTurns: 0, memorySummaryTurns: 0,
    }),
    directorMinDwellMs: numOrNull(s.directorMinDwellMs),
    directorCutawayMs: numOrNull(s.directorCutawayMs),
    fieldNotesIntervalMs: numOrNull(s.fieldNotesIntervalMs),
    turnClock: s.turnClock === true,
    memorySummary: s.memorySummary === true,
    promptBaseline: s.promptBaseline === "playbook" ? "playbook" : "new",
    reasoningCap: s.reasoningCap === true,
    reasoningEffort: strOrNull(s.reasoningEffort),
    craftMacro: s.craftMacro === true,
    recipeHints: s.recipeHints === true,
    memoryMode: s.memoryMode === "persistent" ? "persistent" : "per-life",
    traitSource: normTraitSource(s.traitSource),
    foodBonus: normServerSetting(s.foodBonus),
    foodBonusSecondsPerPip: normServerSetting(s.foodBonusSecondsPerPip),
    freeNames: normServerSetting(s.freeNames),
    playerSaves: normServerSetting(s.playerSaves),
    earlyMaxBabies: normServerSetting(s.earlyMaxBabies),
    earlyMaxGenerations: normServerSetting(s.earlyMaxGenerations),
    noCooldownBypass: normServerSetting(s.noCooldownBypass),
    languagesMinPlayers: normServerSetting(s.languagesMinPlayers),
    langLearnSeconds: normServerSetting(s.langLearnSeconds),
  };
  return {
    now: num(v.now),
    runId: strOrNull(v.runId),
    systemPrompt: v.systemPrompt,
    userSuffix: str(v.userSuffix),
    replyFields: arr(v.replyFields, (x) => (isObj(x) && typeof x.name === "string" ? { name: x.name, meaning: str(x.meaning) } : null)),
    noteHeadings: strArr(v.noteHeadings),
    actions: arr(v.actions, (x) =>
      isObj(x) && typeof x.type === "string"
        ? { type: x.type, template: str(x.template), fields: strArr(x.fields), meaning: str(x.meaning), ...(typeof x.note === "string" && x.note ? { note: x.note } : {}), ...(x.temporary === true ? { temporary: true } : {}) }
        : null,
    ),
    validActionTypes: strArr(v.validActionTypes),
    settings,
    limits: numRecord(v.limits, LIMITS0),
    sayLimits: arr(v.sayLimits, (x) => (isObj(x) && typeof x.age === "number" && typeof x.letters === "number" ? { age: x.age, letters: x.letters } : null)),
    interventions: arr(v.interventions, (x) =>
      isObj(x) && typeof x.name === "string" && (CATEGORIES as readonly unknown[]).includes(x.category)
        ? { id: str(x.id, x.name), name: x.name, category: x.category as AgentSpecIntervention["category"], on: boolOrNull(x.on), detail: str(x.detail) }
        : null,
    ),
    example: normAgentExample(v.example),
  };
}
