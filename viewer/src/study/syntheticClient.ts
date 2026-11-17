// ?fixture=synthetic&n=400[&seed=1][&null=1]: serves generateSynthetic() through the normal data hooks.
// Installed with setClient() before the page mounts, so nothing else in the data layer changes.

import type { LivesResponse, StateResponse } from "../api-types.ts";
import type { ApiClient, StreamHandlers } from "../data/client.ts";
import { generateSynthetic, NO_EFFECTS, PLANTED, type SynthData } from "./synthetic.ts";

export class SyntheticClient implements ApiClient {
  readonly isStatic = true;
  readonly mode = { kind: "fixture" as const, name: "synthetic" };
  readonly data: SynthData;
  constructor(opts: { n: number; seed: number; nullWorld: boolean }) {
    this.data = generateSynthetic({ n: opts.n, seed: opts.seed, effects: opts.nullWorld ? NO_EFFECTS : PLANTED });
  }
  async state(): Promise<StateResponse> {
    const d = this.data;
    const alive = d.lives.filter((l) => l.status === "alive").length;
    return {
      run: { id: "synthetic", startedAt: d.startedAt, model: "synthetic/generator", memoryMode: "per-life", recipeHints: false, targetPopulation: 0, status: "running", haltReason: null, limits: { maxGeneration: 0, maxLives: 0, maxRuntimeMin: 0, maxCostUsd: 0 } },
      traitDims: d.traitDims,
      traitSource: "mock",
      now: d.now,
      agents: [],
      players: [],
      stats: { alive, totalBirths: d.lives.length, totalDeaths: d.lives.filter((l) => l.status === "dead").length, maxGeneration: Math.max(1, ...d.lives.map((l) => l.generation)), families: d.lineages.filter((l) => l.living > 0).length, llmCalls: 0, llmCostUsd: 0 },
      story: null,
    };
  }
  async map() { return { cells: [], names: {} }; }
  async events() { return []; }
  stream(h: StreamHandlers) {
    const t = setTimeout(() => h.onStatus?.("open"), 0);
    return () => clearTimeout(t);
  }
  async objects() { return {}; }
  async lives(q: { since?: number; limit?: number } = {}): Promise<LivesResponse> {
    const since = q.since ?? -Infinity;
    const limit = Math.max(1, Math.min(q.limit ?? 500, 2000));
    const rows = this.data.lives.filter((l) => l.updatedAt > since).sort((a, b) => a.updatedAt - b.updatedAt);
    return { now: this.data.now, traitDims: this.data.traitDims, traitSource: "mock", lives: rows.slice(0, limit), more: rows.length > limit };
  }
  async life(lifeId: string) { return this.data.lives.find((l) => l.lifeId === lifeId) ?? null; }
  async lifeLog(lifeId: string) { return { lifeId, events: [], nextBefore: null }; }
  async lineages() { return { now: this.data.now, traitDims: this.data.traitDims, traitSource: "mock" as const, lineages: this.data.lineages }; }
  async deaths(q: { limit?: number } = {}) {
    const deaths = this.data.lives
      .filter((l) => l.status === "dead")
      .sort((a, b) => (b.diedAt ?? 0) - (a.diedAt ?? 0))
      .slice(0, q.limit ?? 50)
      .map((l) => ({ lifeId: l.lifeId, lineageId: l.lineageId, agentId: l.agentId, name: l.name, female: l.female, generation: l.generation, bornAt: l.bornAt, diedAt: l.diedAt!, ageAtDeath: l.ageAtDeath, deathReason: l.deathReason, traits: l.traits, inherited: l.inherited }));
    return { now: this.data.now, traitSource: "mock" as const, deaths };
  }
  async storyHistory() { return { history: [] }; }
  async inventions() { return { inventions: [] }; }
}

/** Install the synthetic client if the URL asks for it. Call before mount(). */
export function installSyntheticIfRequested(search: string, setClient: (c: ApiClient) => void): boolean {
  const q = new URLSearchParams(search);
  if (q.get("fixture") !== "synthetic") return false;
  const n = Math.max(0, Math.min(5000, Math.floor(Number(q.get("n") ?? 400)) || 0));
  const seed = Math.floor(Number(q.get("seed") ?? 1)) || 1;
  setClient(new SyntheticClient({ n, seed, nullWorld: q.get("null") === "1" }));
  return true;
}
