// Shared site helpers + data normalisation (node --test, .ts via type stripping).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { resolveDataMode, pageHref } from "../src/data/config.ts";
import { normDeaths, normInventions, normLife, normLineages, normLives, normState } from "../src/data/normalize.ts";
import { ageStage, deathReasonText, displayName, formatAge, formatDuration, formatMoney, formatRelative, formatTrait, truncate } from "../src/shared/format.ts";
import { lineageColor, lineageName, LINEAGE_PALETTE } from "../src/shared/lineage.ts";
import { personalityBlurb, personalityText } from "../src/shared/personality.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIMS = ["openness", "conscientiousness", "extraversion", "agreeableness", "neuroticism"];
const fixture = (name, file) => JSON.parse(fs.readFileSync(path.join(HERE, "..", "fixtures", name, file), "utf8"));

test("resolveDataMode: fixture > api > env > localhost", () => {
  assert.deepEqual(resolveDataMode("?fixture=live1&api=http://x", "http://y"), { kind: "fixture", name: "live1" });
  assert.deepEqual(resolveDataMode("?api=http://x:1/", undefined), { kind: "http", base: "http://x:1" });
  assert.deepEqual(resolveDataMode("", "same-origin"), { kind: "http", base: "" });
  assert.deepEqual(resolveDataMode("", "fixture:edge"), { kind: "fixture", name: "edge" });
  assert.deepEqual(resolveDataMode("", "replay"), { kind: "http", base: "http://localhost:8787" });
  assert.equal(pageHref("agent", { life: "r:1" }), "agent.html?life=r%3A1");
});

test("format helpers", () => {
  assert.equal(formatAge(51.7), "51 y");
  assert.equal(formatAge(null), "? y");
  assert.equal(ageStage(1), "baby");
  assert.equal(ageStage(20), "adult");
  assert.equal(formatRelative(1000, 1000 + 4000), "4 s ago");
  assert.equal(formatRelative(0, 5), "never");
  // future (clock skew, coarse page clock): never "in 13 s"
  assert.equal(formatRelative(20_000, 7_000), "just now");
  assert.equal(formatRelative(10_000_000, 1000), "just now");
  assert.equal(formatRelative(1, 1 + 120_000), "2 min ago");
  assert.equal(formatDuration(41 * 60_000), "41 min");
  assert.equal(formatDuration(125 * 60_000), "2 h 5 min");
  assert.equal(formatMoney(3.123), "$3.12");
  assert.equal(formatMoney(0.0041), "$0.004");
  assert.equal(formatMoney(98765.43), "$99k");
  assert.equal(formatTrait(1.3175), "+1.32");
  // bad data (1e300, -1e12) stays short enough for a trait column
  assert.equal(formatTrait(1e300), ">+99");
  assert.equal(formatTrait(-1e12), "<−99");
  assert.equal(formatTrait(99.5, 1), "+99.5");
  assert.equal(displayName("EVE DAWN"), "Eve Dawn");
  assert.equal(displayName(""), "Unnamed");
  // bidi overrides, zero-width and control characters are stripped; ZWJ emoji survive
  assert.equal(displayName("\u202EEVIL DAWN"), "Evil Dawn");
  assert.equal(displayName("ZE\u200BRO\uFEFF \u2066HOPE\u2069"), "Zero Hope");
  assert.equal(displayName("\u200B\u200B"), "Unnamed");
  assert.equal(displayName("\u0007BELL"), "Bell");
  assert.equal(displayName("🧑\u200D🌾 ADA"), "🧑\u200D🌾 Ada");
  assert.equal(truncate("👶🏽👶🏽👶🏽", 2), "👶…");
  assert.equal(deathReasonText("hunger"), "starved");
  assert.equal(deathReasonText("killed_418"), "killed");
});

test("lineageColor is stable and keeps visible lineages apart", () => {
  assert.deepEqual(lineageColor("a:1"), lineageColor("a:1"));
  const ids = ["r:1", "r:2", "r:3", "r:4", "r:5", "r:6"];
  const slots = new Set(ids.map((id) => lineageColor(id, ids).slot));
  assert.equal(slots.size, LINEAGE_PALETTE.length);
  assert.equal(lineageColor(null).name, "other");
  assert.equal(lineageName({ eveName: "DAWN HOPE", lineageId: "x:4" }), "Hope");
  assert.equal(lineageName({ eveName: null, lineageId: "x:4" }), "Family 4");
});

test("numbered repeat first names: 'AURORA II DAWN' is family Dawn, shown as Aurora II", async () => {
  const { firstNameOf, surnameOf } = await import("../src/shared/format.ts");
  assert.equal(displayName("AURORA II DAWN"), "Aurora II Dawn");
  assert.equal(displayName("AURORA IX"), "Aurora IX");
  assert.equal(displayName("IVY VI HOPE"), "Ivy VI Hope");
  assert.equal(displayName("VI HOPE"), "Vi Hope", "a first name is never a numeral");
  assert.equal(surnameOf("Aurora II Dawn"), "Dawn");
  assert.equal(surnameOf("Aurora II"), null);
  assert.equal(surnameOf("Aurora"), null);
  assert.equal(firstNameOf("Aurora II Dawn"), "Aurora II");
  assert.equal(firstNameOf("Joy Hope"), "Joy");
  assert.equal(lineageName({ eveName: "AURORA II DAWN", lineageId: "x:4" }), "Dawn");
  assert.equal(lineageName({ eveName: "AURORA II", lineageId: "x:4" }), "Aurora");
});

test("personalityBlurb is tentative; personalityText reads \"none\" while traits are hidden", () => {
  const b = personalityBlurb({ openness: 1.3, agreeableness: -1.2, extraversion: 0.1 }, DIMS);
  assert.match(b, /^Seems curious about new things, and perhaps blunt and independent\.$/);
  assert.match(personalityBlurb({ openness: 0.1 }, DIMS), /middle-of-the-road/);
  assert.match(personalityBlurb(null, DIMS), /early/);
  assert.doesNotThrow(() => personalityBlurb({ openness: 1e300, neuroticism: -1e12 }, DIMS));
  // traits are placeholders for now (TRAITS_SHOWN false unless VITE_SHOW_TRAITS=1): every life reads "none"
  assert.deepEqual(personalityText({ traits: null, personalitySummary: "Neuron says hi." }, DIMS), { text: "none", source: "mock" });
  assert.deepEqual(personalityText({ traits: { openness: 2 } }, DIMS), { text: "none", source: "mock" });
});

test("normalisers tolerate garbage and missing fields", () => {
  const s = normState({});
  assert.deepEqual(s.agents, []);
  assert.equal(s.stats.alive, 0);
  assert.equal(s.story, null);
  assert.equal(normLife({ nope: 1 }), null);
  const l = normLife({ lifeId: "r:9", diedAt: 5 });
  assert.equal(l.status, "dead");
  assert.equal(l.activity.thoughts, 0);
  assert.deepEqual(l.childLifeIds, []);
  assert.equal(normLife({ lifeId: "r:9", traits: { a: "x", b: Infinity } }).traits, null);
  assert.deepEqual(normLives(null).lives, []);
});

test("fixtures parse: live1 and edge", () => {
  for (const name of ["live1", "edge"]) {
    const st = normState(fixture(name, "state.json"));
    assert.ok(st.run.id);
    const lives = normLives(fixture(name, "lives.json")).lives;
    assert.ok(lives.length > 0);
    normLineages(fixture(name, "lineages.json"));
    normDeaths(fixture(name, "deaths.json"));
  }
  const edge = normLives(fixture("edge", "lives.json")).lives;
  assert.equal(edge.length, 500);
  assert.equal(edge.filter((l) => l.status === "alive").length, 0);
  assert.ok(edge.some((l) => Array.from(l.name ?? "").length === 200 && l.name.includes("<img src=x onerror=alert(1)>")));
  assert.equal(normState(fixture("edge", "state.json")).story, null);
  assert.ok(normLineages(fixture("edge", "lineages.json")).lineages.some((l) => l.extinctAt != null));
});

test("no dangerouslySetInnerHTML in site code", () => {
  const roots = ["src/theme", "src/shared", "src/data", "src/pages"].map((d) => path.join(HERE, "..", d));
  for (const r of roots)
    for (const f of fs.readdirSync(r, { recursive: true })) {
      if (!/\.(tsx?|mjs)$/.test(f)) continue;
      assert.ok(!fs.readFileSync(path.join(r, f), "utf8").includes("dangerouslySetInner" + "HTML"), f);
    }
});

// ------------------------------------------------------------------ model provider / pause state

test("thinkingState / lostInThought / thinkingLabel: outage, failing, daily cap, recovery", async () => {
  const { thinkingState, lostInThought, thinkingLabel, LOST_IN_THOUGHT, STREAM_BANNER_GRACE_MS } = await import("../src/shared/runStatus.ts");
  const T = 1_800_000_000_000;
  const ok = { ok: true, lastError: "HTTP 402: Insufficient credits", since: T - 5000, consecutiveFailures: 0, retryAt: null, outageSince: null };
  const failing = (since) => ({ ok: false, lastError: "HTTP 503: upstream", since, consecutiveFailures: 4, retryAt: T + 8000, outageSince: since });
  const run = (o) => ({ status: "running", pauseKind: null, pauseReason: null, resumesAt: null, llmStatus: ok, ...o });
  const ago = formatDuration;

  // healthy, idle, halted: nothing to say (lastError kept after recovery doesn't matter)
  for (const r of [run({}), run({ status: "idle", llmStatus: failing(T - 60_000) }), run({ status: "halted", llmStatus: failing(T - 60_000) }), null, undefined]) {
    assert.deepEqual(thinkingState(r), { kind: "ok" });
    assert.equal(lostInThought(r, T), false);
    assert.equal(thinkingLabel(thinkingState(r), ago, T), null);
  }

  // paused for an outage: banner at once, run bar says how long
  const outage = run({ status: "paused", pauseKind: "llm-outage", pauseReason: "model provider down", resumesAt: T + 30_000, llmStatus: failing(T - 4 * 60_000) });
  assert.deepEqual(thinkingState(outage), { kind: "llm-outage", since: T - 4 * 60_000, resumesAt: T + 30_000 });
  assert.equal(lostInThought(outage, T), true);
  assert.equal(thinkingLabel(thinkingState(outage), ago, T), "paused: model provider unavailable · 4 min");

  // failing but not paused yet: banner only after the grace period (a lone 5xx doesn't flash it)
  const blip = run({ llmStatus: failing(T - 3000) });
  assert.equal(thinkingState(blip).kind, "llm-failing");
  assert.equal(lostInThought(blip, T), false);
  assert.equal(lostInThought(run({ llmStatus: failing(T - STREAM_BANNER_GRACE_MS) }), T), true);
  assert.equal(thinkingLabel(thinkingState(blip), ago, T), "model provider unavailable · 3 s");

  // daily cap: run bar only, never the stream banner; older backends without pauseKind = cap
  const cap = run({ status: "paused", pauseKind: "daily-cap", pauseReason: "daily spend cap reached", resumesAt: T + 2 * 3600_000 });
  assert.equal(lostInThought(cap, T), false);
  assert.equal(thinkingLabel(thinkingState(cap), ago, T), "paused: daily spend cap · resumes in 2 h");
  assert.equal(thinkingState(run({ status: "paused", pauseKind: undefined, llmStatus: undefined })).kind, "daily-cap");

  // recovery clears it: back to running with llmStatus ok
  assert.equal(lostInThought(run({ llmStatus: { ...ok, since: T } }), T), false);
  // the stream text never carries the provider error
  assert.ok(!/HTTP|credit|503/.test(LOST_IN_THOUGHT));
});

test("normState keeps pauseKind, llmStatus and timeScale", () => {
  const s = normState({ run: { id: "r", status: "paused", pauseKind: "llm-outage", llmStatus: { ok: false, lastError: "x", since: 5, consecutiveFailures: 3, retryAt: 9, outageSince: 4 }, timeScale: 2 }, agents: [], players: [] });
  assert.equal(s.run.pauseKind, "llm-outage");
  assert.deepEqual(s.run.llmStatus, { ok: false, lastError: "x", since: 5, consecutiveFailures: 3, retryAt: 9, outageSince: 4 });
  assert.equal(s.run.timeScale, 2);
  const old = normState({ run: { id: "r", status: "paused", pauseKind: "bogus", llmStatus: "nope" }, agents: [], players: [] });
  assert.equal(old.run.pauseKind, null);
  assert.equal(old.run.llmStatus, undefined);
  assert.equal(old.run.timeScale, 1);
});

test("normInventions: drops malformed rows, newest first; the live1 fixture has a few", () => {
  const r = normInventions({
    inventions: [
      { item: "Sharp Stone", objectId: 34, lifeId: "r:2", name: "EVE", t: 100, runId: "r" },
      { item: "", t: 300 },
      { item: "Basket", objectId: "x", lifeId: null, name: null, t: 200, runId: "r" },
      "junk",
      { item: "Rope" },
    ],
  });
  assert.deepEqual(r.inventions.map((x) => x.item), ["Basket", "Sharp Stone"]);
  assert.equal(r.inventions[0].objectId, undefined);
  assert.equal(r.inventions[1].objectId, 34);
  assert.deepEqual(normInventions(null), { inventions: [] });
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const fx = normInventions(JSON.parse(fs.readFileSync(path.join(HERE, "../fixtures/live1/inventions.json"), "utf8")));
  assert.deepEqual(fx.inventions.map((x) => x.item), ["Basket", "Reed Skirt", "Fire Bow Drill", "Kindling", "Sharp Stone"]);
  assert.ok(fx.inventions.every((x) => x.objectId && x.lifeId && x.name));
});

test("players carry a wound or sickness; junk conditions are dropped", () => {
  const s = normState({ players: [
    { id: 1, condition: { kind: "wound", name: " Bite Wound " } },
    { id: 2, condition: { kind: "sickness", name: "Sick Person" } },
    { id: 3, condition: { kind: "mark", name: "x" } },
    { id: 4, condition: "wound" },
    { id: 5 },
  ] });
  assert.deepEqual(s.players.map((p) => p.condition), [{ kind: "wound", name: "Bite Wound" }, { kind: "sickness", name: "Sick Person" }, null, null, null]);
});

test("family body: every member of a family (per sex) gets the same body of the server's race", async () => {
  const { familyBodyId, FEMALE_POOL, MALE_POOL } = await import("../src/ohol/appearance.ts");
  const raceOf = (id) => [...FEMALE_POOL, ...MALE_POOL].find((p) => p.id === id)?.race;
  for (const lin of ["run:1", "run:27", "pilot1-r4-mwl7lobm:2"]) {
    const sisters = [19, 350, 1007].map((d) => familyBodyId(d, true, lin)); // three race-D sprites
    assert.equal(new Set(sisters).size, 1, `${lin}: ${sisters}`);
    assert.equal(raceOf(sisters[0]), "D");
    const brothers = [347, 352, 1008].map((d) => familyBodyId(d, false, lin));
    assert.equal(new Set(brothers).size, 1);
    assert.equal(raceOf(brothers[0]), "D");
  }
  assert.equal(familyBodyId(99999, true, "x"), 99999, "an unknown sprite is kept");
});

test("withFamilyNames: unnamed people show their family name; records with names and nameless families untouched", async () => {
  const { withFamilyNames } = await import("../src/shared/format.ts");
  const lives = [
    { lifeId: "1", name: "LUNA VALLEY", lineageId: "A", bornAt: 1 },
    { lifeId: "2", name: null, lineageId: "A", bornAt: 2 },
    { lifeId: "3", name: null, lineageId: "B", bornAt: 3 },
    { lifeId: "4", name: "LUNA", lineageId: "A", bornAt: 4 },
    { lifeId: "5", name: "AURORA II", lineageId: "A", bornAt: 5 },
  ];
  const out = withFamilyNames(lives);
  assert.deepEqual(out.map((l) => l.name), ["LUNA VALLEY", "UNNAMED VALLEY", null, "LUNA VALLEY", "AURORA II VALLEY"]);
  assert.equal(lives[1].name, null, "input not mutated");
  const same = [lives[0]];
  assert.equal(withFamilyNames(same), same, "nothing to fill: same array");
});

test("describeAction: plain sentences for hands-on actions, null for walking/speech/babies", async () => {
  const { describeAction } = await import("../src/stream/logic.ts");
  const cases = [
    ["use (61, 5) -> use: tile (61,5) Banana Plant (4/7 left) -> Banana Plant (3/7 left); holding nothing -> Banana", "picked up a Banana"],
    ["use (3, 4) -> use: tile (3,4) Big Hard Rock -> Big Hard Rock; holding Stone -> Sharp Stone", "made a Sharp Stone on the Big Hard Rock"],
    ["use (5, 4) -> use: tile (5,4) Wild Carrot -> Dug Wild Carrot; holding Sharp Stone -> Sharp Stone", "used a Sharp Stone on the Wild Carrot: it became a Dug Wild Carrot"],
    ["drop (2, 2) -> drop: tile (2,2) nothing -> Banana Peel; holding Banana Peel -> nothing", "put down a Banana Peel"],
    ["forage (48, 6) -> ate Banana; food 4 -> 12/12", "ate a Banana"],
    ["forage (48, 6) -> you're full, so you didn't eat: you picked a Banana and are holding it", "picked a Banana to carry"],
    ["use (44, 2) -> use at (44,2): nothing happened", "tried to use something: nothing happened"],
  ];
  for (const [inp, want] of cases) assert.equal(describeAction(inp), want, inp);
  for (const inp of ["go (3, 4) -> arrived", "pick_up_baby #3 -> picked up baby #3", 'say "F" -> said "F"', "wait -> waited 2 turns", "jump -> wiggled"]) assert.equal(describeAction(inp), null, inp);
});

test("motion: a 30-tile move between polls walks (fast) instead of warping; a 80-tile jump snaps", async () => {
  const { retarget, sampleMotion, MAX_WALK_MS } = await import("../src/stream/logic.ts");
  const start = retarget(undefined, 0, 0, 0);
  const walk = retarget(start, 30, 0, 1000);
  assert.ok(walk.dur > 0 && walk.dur <= MAX_WALK_MS, `walks (${walk.dur} ms)`);
  const mid = sampleMotion(walk, 1000 + walk.dur / 2);
  assert.ok(mid.x > 5 && mid.x < 25, `in between halfway (${mid.x})`);
  assert.equal(retarget(start, 80, 0, 1000).dur, 0, "a respawn-sized jump snaps");
});
