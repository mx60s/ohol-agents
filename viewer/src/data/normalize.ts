// Defensive normalisation of API responses. The backend may be older or newer
// than this viewer, a fixture may be hand-written, and optional fields come and
// go; everything the hooks hand to components goes through here so pages can
// rely on arrays being arrays and numbers being numbers.

import type {
  AgentView,
  DeathRecord,
  DeathsResponse,
  LifeActivity,
  LifeLogResponse,
  LifeRecord,
  LineageRecord,
  LineagesResponse,
  LivesResponse,
  MapResponse,
  PlayerView,
  RunEvent,
  RunInfo,
  StateResponse,
  Stats,
  StoryHistoryResponse,
  StorySoFar,
  TraitSource,
  Traits,
} from "../api-types.ts";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const arr = <T>(v: unknown, f: (x: unknown) => T | null): T[] =>
  Array.isArray(v) ? v.map(f).filter((x): x is T => x !== null) : [];
const num = (v: unknown, d = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : d);
const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown, d = ""): string => (typeof v === "string" ? v : d);
const strOrNull = (v: unknown): string | null => (typeof v === "string" ? v : null);
const boolOrNull = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
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
    pauseReason: strOrNull(r.pauseReason),
    resumesAt: numOrNull(r.resumesAt),
    dailySpend: ds ? { last24hUsd: num(ds.last24hUsd), capUsd: num(ds.capUsd) } : undefined,
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
    moving: v.moving === true,
    displayId: num(v.displayId, 19),
    lifeId: strOrNull(v.lifeId),
    lineageId: strOrNull(v.lineageId),
  };
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
      ? { agentId: strOrNull(f.agentId), lifeId: strOrNull(f.lifeId), since: num(f.since), reason: strOrNull(f.reason) }
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
    ageAtDeath: numOrNull(v.ageAtDeath),
    deathReason: strOrNull(v.deathReason),
    traits: normTraits(v.traits),
    inherited: v.inherited === true,
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
