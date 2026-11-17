#!/usr/bin/env node
// Hand-crafted edge-case fixture: viewer/fixtures/edge/ (deterministic; re-run to regenerate).
//   node scripts/make-edge-fixture.mjs
// - zero living agents (everyone dead), story null, no focus
// - one life with a 200-char name full of emoji + HTML (<img src=x onerror=alert(1)>)
// - huge trait values (1e9, -1e12, 1e300), missing optional fields everywhere
// - 500 lives in 6 lineages, one extinct

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(HERE, "..", "fixtures", "edge");
const RUN = "edge-run";
const NOW = 1794870000000;
const DIMS = ["openness", "conscientiousness", "extraversion", "agreeableness", "neuroticism"];
const fileId = (id) => id.replace(/[^A-Za-z0-9._-]/g, "_");

let seed = 7;
const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-9)) * Math.cos(2 * Math.PI * rnd());
const clip = (v) => Math.max(-2.5, Math.min(2.5, v));
const r6 = (v) => Math.round(v * 1e6) / 1e6;

const EVIL = "<img src=x onerror=alert(1)>";
let evilName = `🔥👑 ${EVIL} <script>alert("x")</script> Zoë 💀🌾 `;
while (Array.from(evilName).length < 200) evilName += "👶🏽🧑‍🌾&amp;<b>bold</b>";
evilName = Array.from(evilName).slice(0, 200).join("");

const FIRST = ["ADA", "BRAM", "CORA", "DELL", "EDDA", "FINN", "GWEN", "HUGO", "IRIS", "JUNO", "KAI", "LARK", "MIRA", "NED", "ODA", "PIP"];
const SURN = ["HOPE", "ASHGROVE", "KETTLE", "MOSS", "REED", "STONE"];
const FEMALE_IDS = [19, 350, 1009, 1011];
const MALE_IDS = [347, 352, 1010];
const ACT_KEYS = ["thoughts", "actions", "failedActions", "moves", "tilesWalked", "maxDistFromBirth", "forage", "reflexForage", "eat", "pickUp", "drop", "craft", "wear", "babyPickups", "feeds", "says", "saysHeard"];

const lives = [];
const lineages = [];
let t = NOW - 6 * 3600_000;
for (let li = 0; li < 6; li++) {
  const eveId = `${RUN}:${100 + li}`;
  lineages.push({ id: eveId, surname: SURN[li], members: [] });
}
for (let i = 0; i < 500; i++) {
  const li = i < 6 ? i : Math.floor(rnd() * 6);
  const L = lineages[li];
  const isEve = i < 6;
  const playerId = isEve ? 100 + li : 1000 + i;
  const lifeId = `${RUN}:${playerId}`;
  const mother = isEve ? null : L.members[Math.floor(rnd() * L.members.length)];
  const female = rnd() < 0.5;
  const traits = Object.fromEntries(DIMS.map((d) => [d, r6(mother ? clip(mother.traits[d] + gauss() * 0.3) : clip(gauss()))]));
  const bornAt = (t += 30_000 + Math.floor(rnd() * 20_000));
  const ageAtBirth = isEve ? 14 : 0;
  const ageAtDeath = r6(ageAtBirth + rnd() * (rnd() < 0.4 ? 3 : 46));
  const diedAt = bornAt + Math.round((ageAtDeath - ageAtBirth) * 60_000);
  const act = Object.fromEntries(ACT_KEYS.map((k) => [k, Math.floor(rnd() * 40)]));
  const life = {
    lifeId,
    runId: RUN,
    agentId: `a${String((i % 12) + 1).padStart(2, "0")}`,
    lifeIndex: Math.floor(i / 12) + 1,
    playerId,
    name: `${isEve ? "EVE" : FIRST[i % FIRST.length]} ${L.surname}`,
    female,
    displayId: (female ? FEMALE_IDS : MALE_IDS)[i % (female ? 4 : 3)],
    lineageId: L.id,
    motherLifeId: mother?.lifeId ?? null,
    motherPlayerId: mother?.playerId ?? null,
    generation: mother ? mother.generation + 1 : 1,
    traits,
    inherited: !!mother,
    traitSource: "mock",
    bornAt,
    ageAtBirth,
    birthX: Math.floor(rnd() * 200) - 100,
    birthY: Math.floor(rnd() * 200) - 100,
    diedAt,
    ageAtDeath,
    deathReason: ["hunger", "age", "killed_418", "disconnected", "hunger", "hunger"][Math.floor(rnd() * 6)],
    lostAt: null,
    presumedEndAt: null,
    status: "dead",
    childLifeIds: [],
    activity: act,
    updatedAt: diedAt,
  };
  if (mother) mother.childLifeIds.push(lifeId);
  L.members.push(life);
  lives.push(life);
}

// edge cases on specific lives
const evil = lives[7];
evil.name = evilName;
evil.traits = { openness: 1e9, conscientiousness: -1e12, extraversion: 1e300, agreeableness: -2.5, neuroticism: 0 };
const sparse = lives[8]; // missing optional fields
for (const k of ["lifeIndex", "displayId", "female", "ageAtBirth", "birthX", "birthY", "ageAtDeath", "deathReason", "motherPlayerId", "lostAt", "presumedEndAt", "activity", "childLifeIds"]) delete sparse[k];
sparse.name = null;
sparse.traits = null;
const lost = lives[9];
Object.assign(lost, { status: "lost", diedAt: null, ageAtDeath: null, deathReason: null, lostAt: lost.bornAt + 60_000, presumedEndAt: lost.bornAt + 30 * 60_000 });
lives[10].traits = { openness: 2.5, extraversion: -2.5 }; // fewer dims than traitDims
lives[11].name = "";

// lineage records; lineage 5 (STONE) is extinct early, every lineage is extinct now (nobody alive)
const lineageRecs = lineages.map((L, li) => {
  const ms = L.members;
  const mean = Object.fromEntries(
    DIMS.map((d) => {
      const vs = ms.map((m) => m.traits?.[d]).filter((v) => typeof v === "number" && Math.abs(v) < 10);
      return [d, r6(vs.reduce((a, b) => a + b, 0) / Math.max(1, vs.length))];
    }),
  );
  return {
    lineageId: L.id,
    eveLifeId: L.id,
    eveName: li === 1 ? evilName : ms[0].name,
    founderIsEve: li !== 4,
    foundedAt: ms[0].bornAt,
    extinctAt: Math.max(...ms.map((m) => m.diedAt ?? m.presumedEndAt ?? 0)),
    living: 0,
    livingLifeIds: [],
    totalLives: ms.length,
    maxGeneration: Math.max(...ms.map((m) => m.generation)),
    meanTraits: mean,
  };
});
lineageRecs.sort((a, b) => b.foundedAt - a.foundedAt);

const deaths = lives
  .filter((l) => l.status === "dead" && l.diedAt)
  .sort((a, b) => b.diedAt - a.diedAt)
  .map((l) => ({ lifeId: l.lifeId, lineageId: l.lineageId, agentId: l.agentId, name: l.name, female: l.female ?? null, generation: l.generation, bornAt: l.bornAt, diedAt: l.diedAt, ageAtDeath: l.ageAtDeath ?? null, deathReason: l.deathReason ?? null, traits: l.traits, inherited: l.inherited }));

const events = [
  { seq: 1, t: NOW - 6 * 3600_000, kind: "system", agentId: null, playerId: null, name: null, text: "run started" },
  { seq: 2, t: NOW - 5000, kind: "say", agentId: "a08", playerId: evil.playerId, name: evilName, text: `${EVIL} hello <b>world</b> 🔥`, data: { heardBy: [] } },
  { seq: 3, t: NOW - 4000, kind: "death", agentId: "a08", playerId: evil.playerId, name: evilName, text: "died of hunger" },
  { seq: 4, t: NOW - 3000, kind: "narration", agentId: null, playerId: null, name: null, text: "Everyone is gone. The berries grow back anyway." },
  { seq: 5, t: NOW - 2000, kind: "focus", agentId: null, playerId: null, name: null, text: "nobody is alive", data: { lifeId: null, previous: "a08", cause: "empty" } },
];

const state = {
  run: { id: RUN, startedAt: NOW - 6 * 3600_000, model: "test/edge-model", memoryMode: "per-life", recipeHints: true, targetPopulation: 12, status: "running", haltReason: null, limits: { maxGeneration: 0, maxLives: 0, maxRuntimeMin: 0, maxCostUsd: 0 } },
  // no control, no dailySpend, no continuous
  traitDims: DIMS,
  traitSource: "mock",
  now: NOW,
  agents: Array.from({ length: 12 }, (_, i) => ({ agentId: `a${String(i + 1).padStart(2, "0")}`, lifeIndex: 42, status: "waiting", playerId: null, name: null, x: null, y: null, age: null, female: null, food: null, foodCapacity: null, heat: null, held: null, motherId: null, eveId: null, generation: null, goal: null, lastThought: null, lastAction: null, lastSaid: null, lifeId: null, lineageId: null, traits: null })),
  players: [],
  stats: { alive: 0, totalBirths: 500, totalDeaths: deaths.length, maxGeneration: Math.max(...lives.map((l) => l.generation)), families: 0, llmCalls: 123456, llmCostUsd: 98765.4321 },
  focus: { agentId: null, lifeId: null, since: NOW - 2000, reason: null },
  story: null,
};

const evilLog = { lifeId: evil.lifeId, events: [...events.slice(1, 3)].reverse().map((e) => ({ ...e })), nextBefore: null };

await fs.rm(out, { recursive: true, force: true });
const w = async (rel, data) => {
  await fs.mkdir(path.dirname(path.join(out, rel)), { recursive: true });
  await fs.writeFile(path.join(out, rel), JSON.stringify(data) + "\n");
};
await w("state.json", state);
await w("map.json", { cells: [], names: {} });
await w("events.json", { events });
await w("objects.json", { names: {} });
await w("lives.json", { now: NOW, traitDims: DIMS, traitSource: "mock", lives: [...lives].sort((a, b) => a.updatedAt - b.updatedAt), more: false });
await w("lineages.json", { now: NOW, traitDims: DIMS, traitSource: "mock", lineages: lineageRecs });
await w("deaths.json", { now: NOW, traitSource: "mock", deaths });
await w("story-history.json", { history: [] });
await w(`life/${fileId(evil.lifeId)}.json`, evil);
await w(`log/${fileId(evil.lifeId)}.json`, evilLog);
await w("meta.json", { name: "edge", handmade: true, evilLifeId: evil.lifeId, sparseLifeId: sparse.lifeId, lostLifeId: lost.lifeId });
console.log(`fixture edge: ${lives.length} lives, ${lineageRecs.length} lineages, evil life ${evil.lifeId}`);
