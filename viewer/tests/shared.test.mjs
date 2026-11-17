// Shared site helpers + data normalisation (node --test, .ts via type stripping).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { resolveDataMode, pageHref } from "../src/data/config.ts";
import { normDeaths, normLife, normLineages, normLives, normState } from "../src/data/normalize.ts";
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
  assert.equal(formatRelative(1, 1 + 120_000), "2 min ago");
  assert.equal(formatDuration(41 * 60_000), "41 min");
  assert.equal(formatDuration(125 * 60_000), "2 h 5 min");
  assert.equal(formatMoney(3.123), "$3.12");
  assert.equal(formatMoney(0.0041), "$0.004");
  assert.equal(formatMoney(98765.43), "$99k");
  assert.equal(formatTrait(1.3175), "+1.32");
  assert.equal(formatTrait(1e300), "+1.0e+300");
  assert.equal(displayName("EVE DAWN"), "Eve Dawn");
  assert.equal(displayName(""), "Unnamed");
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

test("personalityBlurb is tentative, prefers a backend summary", () => {
  const b = personalityBlurb({ openness: 1.3, agreeableness: -1.2, extraversion: 0.1 }, DIMS);
  assert.match(b, /^Seems curious about new things, and perhaps blunt and independent\.$/);
  assert.match(personalityBlurb({ openness: 0.1 }, DIMS), /middle-of-the-road/);
  assert.match(personalityBlurb(null, DIMS), /early/);
  assert.doesNotThrow(() => personalityBlurb({ openness: 1e300, neuroticism: -1e12 }, DIMS));
  assert.deepEqual(personalityText({ traits: null, personalitySummary: "Neuron says hi." }, DIMS), { text: "Neuron says hi.", source: "backend" });
  assert.equal(personalityText({ traits: { openness: 2 } }, DIMS).source, "mock");
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
