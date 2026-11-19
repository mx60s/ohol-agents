// Who an agent knows by name (people.ts): family, heard namings and introductions, its own
// remembered names; strangers shown without #id or name everywhere; x,y person targeting;
// persistence; whose body a fresh grave is.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { GameData } from "../game/gameData.ts";
import { World, GraveBook, type GraveEntry } from "../game/world.ts";
import { FakeGame } from "../game/fakeGame.ts";
import { Body } from "../game/body.ts";
import type { PlayerUpdate, ServerMessage } from "../protocol/types.ts";
import { Acquaintances, PeopleView, knownNamesPath, rememberedName } from "./people.ts";
import { buildObservation, seenText, thingName } from "./observe.ts";
import { bodyEvents, deathEvent, speechEvent } from "./salience.ts";
import { checkActions } from "./reply.ts";
import { personAt, seenForNotes } from "./agent.ts";
import { actionList } from "./prompt.ts";

const gd = new GameData();
const FRESH = gd.idByName("Fresh Grave")!;
const OLD = gd.idByName("Grave")!;
const STONE = gd.idByName("Stone")!;

const EMPTY = { id: 0, contained: [] };
function pu(id: number, x: number, y: number, age: number, female: boolean, held = 0, over: Partial<PlayerUpdate> = {}): PlayerUpdate {
  return {
    id, displayId: female ? 19 : 347, facing: 0, action: false, actionTarget: [0, 0], held: { id: held, contained: [] }, heldOriginValid: false, heldOrigin: [0, 0],
    heldTransitionSourceId: 0, heat: 0.5, doneMovingSeq: 0, forced: false, x, y, age, ageRate: 60, moveSpeed: 3.75, clothing: [EMPTY, EMPTY, EMPTY, EMPTY, EMPTY, EMPTY],
    justAte: false, lastAteId: 0, responsibleId: -1, heldYum: false, heldLearned: false, ...over,
  };
}

const FLOWERS: Record<number, string> = { 1: "yellow tulip", 2: "blue daisy", 3: "red rose", 4: "white lily", 6: "red rose", 7: "pink peony" };
const flowerOf = (id: number) => FLOWERS[id] ?? null;

/**
 * Me (#1, woman 30, family of Eve #100), my sister #2 ANNA STONE, and strangers of other families:
 * #3 LIRA TIDEWICK (woman 30, red rose, holding a Stone), #4 ASH TIDEWICK (man 25), #5 an unnamed
 * baby girl carried by #3, #6 a woman 30 with a red rose of a third family (named WREN OAK, holding nothing).
 */
function busyWorld() {
  let t = 1_000_000;
  const w = new World(gd, {}, () => t);
  w.seenMergeMs = 8000;
  const send = (m: ServerMessage) => w.handle(m);
  send({ type: "MC", chunk: { x: -30, y: -30, w: 61, h: 61, cells: Array.from({ length: 61 * 61 }, () => ({ biome: 0, floor: 0, obj: EMPTY })) } });
  send({ type: "PU", updates: [pu(2, 1, 0, 28, true), pu(3, 4, 4, 30, true, -5), pu(4, -5, 2, 25, false), pu(5, 4, 4, 0.5, true), pu(6, -4, -4, 30, true), pu(1, 0, 0, 30, true)] });
  send({
    type: "LN",
    lineages: [
      { id: 1, ancestors: [100], eveId: 100 },
      { id: 2, ancestors: [100], eveId: 100 },
      { id: 3, ancestors: [200], eveId: 200 },
      { id: 4, ancestors: [200], eveId: 200 },
      { id: 5, ancestors: [3, 200], eveId: 200 },
      { id: 6, ancestors: [300], eveId: 300 },
    ],
  });
  send({ type: "NM", names: [{ id: 1, first: "MARA", last: "STONE" }, { id: 2, first: "ANNA", last: "STONE" }, { id: 3, first: "LIRA", last: "TIDEWICK" }, { id: 4, first: "ASH", last: "TIDEWICK" }, { id: 6, first: "WREN", last: "OAK" }] });
  const acq = new Acquaintances();
  acq.reset(1);
  return { w, acq, send, tick: (ms: number) => (t += ms), now: () => t };
}

const obs = (w: World, acq: Acquaintances | null, now: number, extra: Record<string, unknown> = {}) =>
  buildObservation(w, gd, { recipeHints: false, history: [], pastLifeNotes: [], goal: null, now, flowerOf, people: acq, ...extra });

test("knowledge: self and family are known; strangers are not, until heard named, introduced or remembered", () => {
  const { w, acq, send, tick } = busyWorld();
  assert.ok(acq.knows(w, 1) && acq.knows(w, 2), "self and sister");
  assert.ok(!acq.knows(w, 3) && !acq.knows(w, 4) && !acq.knows(w, 5));
  // an introduction by an already named speaker teaches their real name
  send({ type: "PS", says: [{ id: 4, isCurse: false, text: "I AM ASH" }] });
  acq.sync(w);
  assert.deepEqual(acq.names.get(4), { name: "ASH TIDEWICK" });
  // "I AM HUNGRY" is not an introduction (the word isn't their name)
  send({ type: "PS", says: [{ id: 3, isCurse: false, text: "I AM HUNGRY" }] });
  acq.sync(w);
  assert.ok(!acq.knows(w, 3));
  // a naming heard: the baby is named in front of us (the mark arrives with the name, after the line)
  tick(500);
  send({ type: "PS", says: [{ id: 3, isCurse: false, text: "YOU ARE MIRA" }] });
  acq.sync(w);
  assert.ok(!acq.knows(w, 5), "not before the name arrives");
  send({ type: "NM", names: [{ id: 5, first: "MIRA", last: "TIDEWICK" }] });
  acq.sync(w);
  assert.deepEqual(acq.names.get(5), { name: "MIRA TIDEWICK" });
  assert.ok(!acq.knows(w, 3), "the namer stays a stranger");
  // a remembered name is the character's own, replaced by the real one when heard
  assert.ok(acq.learn(3, "LILA", true));
  assert.ok(acq.knows(w, 3) && !acq.knowsTruly(w, 3));
  send({ type: "PS", says: [{ id: 3, isCurse: false, text: "MY NAME IS LIRA" }] });
  acq.sync(w);
  assert.deepEqual(acq.names.get(3), { name: "LIRA TIDEWICK" });
  assert.equal(acq.learn(3, "LILA", true), false, "an own name never replaces a real one");
});

test("knowledge: a naming heard scrambled teaches nothing unless the name came through", () => {
  const { w, acq, send } = busyWorld();
  send({ type: "PU", updates: [pu(8, 3, 0, 6, false)] });
  send({ type: "LN", lineages: [{ id: 8, ancestors: [300], eveId: 300 }] });
  // another family's language: the words reached us as made-up words, the name with them
  send({ type: "PS", says: [{ id: 6, isCurse: false, text: "YOU ARE ZUGA" }] });
  send({ type: "NM", names: [{ id: 8, first: "KARA", last: "OAK" }] });
  acq.sync(w);
  assert.ok(!acq.knows(w, 8));
  // the name itself came through: learned
  send({ type: "PU", updates: [pu(9, 3, 1, 6, true)] });
  send({ type: "LN", lineages: [{ id: 9, ancestors: [300], eveId: 300 }] });
  send({ type: "PS", says: [{ id: 6, isCurse: false, text: "YOU ARE TESS" }] });
  send({ type: "NM", names: [{ id: 9, first: "TESS", last: "OAK" }] });
  acq.sync(w);
  assert.deepEqual(acq.names.get(9), { name: "TESS OAK" });
});

test("labels: strangers by sex, age and flower; 'no name' vs 'you don\'t know their name'; look-alikes told apart without ids", () => {
  const { w, acq, now } = busyWorld();
  const pv = new PeopleView(w, gd, acq, flowerOf);
  // #3 and #6 are both "a woman, 30, with a red rose": told apart by what they hold
  assert.equal(pv.label(w.players.get(3)!), "a woman, 30, with a red rose, carrying a baby (you don't know their name)");
  assert.equal(pv.label(w.players.get(6)!), "a woman, 30, with a red rose, empty-handed (you don't know their name)");
  assert.equal(pv.label(w.players.get(5)!), "a baby girl, 0.5 (no name)");
  assert.equal(pv.label(w.players.get(2)!, true), "#2 ANNA STONE (woman, 28, blue daisy)", "family as before");
  // same hands: their position tells them apart
  w.players.get(6)!.held = { id: -99, contained: [] };
  const pv2 = new PeopleView(w, gd, acq, flowerOf);
  assert.equal(pv2.describe(w.players.get(3)!), "a woman, 30, with a red rose, at (4, 4)");
  assert.equal(pv2.describe(w.players.get(6)!), "a woman, 30, with a red rose, at (-4, -4)");
  // where the line prints the position right after (PEOPLE) it is not repeated; elsewhere (HEARD, WHAT YOU SAW NEARBY) it stays
  assert.equal(pv2.label(w.players.get(3)!, false, true), "a woman, 30, with a red rose (you don't know their name)");
  assert.equal(pv2.label(w.players.get(3)!), "a woman, 30, with a red rose, at (4, 4) (you don't know their name)");
  // a name the character gave: shown as its own
  acq.learn(4, "BRAN", true);
  assert.equal(new PeopleView(w, gd, acq, flowerOf).label(w.players.get(4)!), "#4 BRAN (as you know him), man, 25, with a white lily");
  const o = obs(w, acq, now());
  assert.match(o, /- a woman, 30, with a red rose \(you don't know their name\) \[other family\] at \(4, 4\), 4 away, holding a baby girl, 0\.5 \(no name\)/);
  assert.match(o, /- #4 BRAN \(as you know him\), man, 25, with a white lily \[other family\]/);
  // without name rules (tools, older tests) everyone is shown as before
  assert.match(obs(w, null, now()), /- #3 LIRA TIDEWICK \(woman, 30, red rose\) \[other family\]/);
});

test("no leaks: a busy observation, the salience reasons, notes transcript and action results never show a stranger's name or id", async () => {
  const { w, acq, send, tick, now } = busyWorld();
  const meId = 1;
  // they follow each other; #3 speaks, names herself again, picks things up, a naming tag on her line
  send({ type: "FW", follows: [{ followerId: meId, leaderId: 3, colorIndex: 0 }, { followerId: 6, leaderId: meId, colorIndex: 0 }] });
  tick(1000);
  send({ type: "PS", says: [{ id: 3, isCurse: false, text: "HELLO THERE" }] });
  w.heard.push({ t: now(), speakerId: 6, x: -4, y: -4, text: "YOU ARE KIT [this named #6]", named: 6, spoken: "YOU ARE KIT" }); // a mark whose name didn't come through
  send({ type: "MX", changes: [{ x: 5, y: 4, floor: 0, obj: { id: STONE, contained: [] }, responsibleId: 3 }] });
  send({ type: "PU", updates: [pu(6, -4, -4, 30, true, STONE)] });
  w.seeTried(3, { kind: "feed", x: 4, y: 4, held: STONE, target: 0, person: 6 });
  send({ type: "PU", updates: [pu(4, -5, 2, 25, false, 0, { x: null, y: null, deathReason: "reason_hunger" })] });
  send({ type: "MX", changes: [{ x: -5, y: 2, floor: 0, obj: { id: FRESH, contained: [] }, responsibleId: -1 }] });
  acq.sync(w);
  const pv = new PeopleView(w, gd, acq, flowerOf);
  const ref = (id: number) => pv.ref(id);
  const texts = [
    obs(w, acq, now()),
    ...w.seen.map((e) => seenText(w, gd, e, pv)),
    ...w.seen.map((e) => seenForNotes(w, gd, e, pv) ?? ""),
    speechEvent(w, w.heard[w.heard.length - 2], now(), ref)?.reason ?? "",
    bodyEvents({ food: 10, cap: 20, carrierId: null }, { food: 10, cap: 20, carrierId: 3 }, w, now(), ref).map((s) => s.reason).join(" "),
    deathEvent(w, w.players.get(6)!, now(), ref)?.reason ?? "",
    thingName(w, gd, pv, -5, 2),
  ];
  const all = texts.join("\n");
  for (const bad of ["LIRA", "TIDEWICK", "WREN", "OAK", "ASH", "#3", "#4", "#5", "#6"]) assert.ok(!all.includes(bad), `${bad} leaked:\n${all}`);
  // the family is still named, and the strangers are there, described
  assert.match(all, /#2 ANNA STONE/);
  assert.match(all, /You follow a woman, 30, with a red rose/);
  assert.match(all, /Your followers: a woman, 30, with a red rose/);
  assert.match(all, /a woman, 30, with a red rose, carrying a baby \(you don't know their name\) \[other family[^\]]*\]: "HELLO THERE"/);
  assert.match(all, /\[this named a woman, 30, with a red rose/);
  assert.match(all, /a man, 25, with a white lily \(you don't know their name\) \[other family\] died at \(-5, 2\): starved/);
  assert.match(all, /Fresh Grave of a man, 25, with a white lily \[other family\]: \(-5, 2\)/);
  assert.match(all, /tried a Stone on a woman, 30, with a red rose, holding a Stone \(you don't know their name\) \[other family\]: nothing happened/);

  // action results (Body): a stranger by description, never by id
  const g = new FakeGame(gd);
  g.addPlayer({ id: 1, x: 0, y: 0, age: 30, held: 0, female: true });
  g.addPlayer({ id: 7, x: 1, y: 0, age: 30, held: 0, female: false });
  g.start();
  g.world.handle({ type: "NM", names: [{ id: 7, first: "OSKAR", last: "VALE" }] });
  g.world.handle({ type: "LN", lineages: [{ id: 1, ancestors: [100], eveId: 100 }, { id: 7, ancestors: [400], eveId: 400 }] });
  const a2 = new Acquaintances();
  a2.reset(1);
  const body = new Body(g.conn, g.world, gd);
  body.who = (id, fb) => new PeopleView(g.world, gd, a2, flowerOf).ref(id, fb ?? `#${id}`);
  const r = await body.pickUpBaby(7);
  assert.equal(r, "tried to pick up a man, 30, with a pink peony: nothing happened (a man, 30, with a pink peony is 30: only someone under 5 can be carried)");
  assert.ok(!/OSKAR|VALE|#7/.test(r));
  // an id never shown resolves, but without the name
  assert.match(await body.useOnPerson(7), /^used bare hands on a man, 30, with a pink peony: nothing happened/);
});

test("graves: GV says whose body; the death and a fresh grave close by link; ambiguous ones get no label; the label goes when it decays", () => {
  const { w, acq, send, tick, now } = busyWorld();
  // #3 (stranger) dies; a fresh grave appears next to her: linked
  send({ type: "PU", updates: [pu(3, 4, 4, 30, true, 0, { x: null, y: null, deathReason: "reason_age" })] });
  tick(300);
  send({ type: "MX", changes: [{ x: 5, y: 4, floor: 0, obj: { id: FRESH, contained: [] }, responsibleId: -1 }] });
  const pv = () => new PeopleView(w, gd, acq, flowerOf);
  assert.equal(thingName(w, gd, pv(), 5, 4), "Fresh Grave of a woman, 30, with a red rose [other family]");
  // the sister dies: family, named with the relation
  send({ type: "PU", updates: [pu(2, 1, 0, 28, true, 0, { x: null, y: null, deathReason: "reason_hunger" })] });
  send({ type: "MX", changes: [{ x: 1, y: 1, floor: 0, obj: { id: FRESH, contained: [] }, responsibleId: -1 }] });
  assert.equal(thingName(w, gd, pv(), 1, 1), "Fresh Grave of your sibling ANNA STONE");
  assert.match(obs(w, acq, now()), /- Fresh Grave of your sibling ANNA STONE: \(1, 1\)/);
  // a name the character learned shows; everyone else's grave by description
  acq.learn(3, "LILA", true);
  assert.equal(thingName(w, gd, pv(), 5, 4), "Fresh Grave of LILA (as you knew her) [other family]");
  // two deaths equally near one grave: no label
  send({ type: "PU", updates: [pu(10, 10, 10, 40, false), pu(11, 12, 10, 40, false)] });
  send({ type: "PU", updates: [pu(10, 10, 10, 40, false, 0, { x: null, y: null, deathReason: "reason_age" }), pu(11, 12, 10, 40, false, 0, { x: null, y: null, deathReason: "reason_age" })] });
  send({ type: "MX", changes: [{ x: 11, y: 10, floor: 0, obj: { id: FRESH, contained: [] }, responsibleId: -1 }] });
  assert.equal(thingName(w, gd, pv(), 11, 10), "Fresh Grave");
  // too far from any death: no label
  send({ type: "MX", changes: [{ x: -20, y: -20, floor: 0, obj: { id: FRESH, contained: [] }, responsibleId: -1 }] });
  assert.equal(thingName(w, gd, pv(), -20, -20), "Fresh Grave");
  // decays into a Grave: the label goes, and doesn't come back
  send({ type: "MX", changes: [{ x: 5, y: 4, floor: 0, obj: { id: OLD, contained: [] }, responsibleId: -1 }] });
  assert.equal(thingName(w, gd, pv(), 5, 4), "Grave");
  assert.equal(w.graveBook.at(5, 4), undefined);
  // GV (the server's grave message) links exactly, even for someone we didn't see die (family: named)
  send({ type: "LN", lineages: [{ id: 12, ancestors: [2, 100], eveId: 100 }] });
  send({ type: "NM", names: [{ id: 12, first: "OLGA", last: "STONE" }] });
  send({ type: "MX", changes: [{ x: 8, y: -8, floor: 0, obj: { id: FRESH, contained: [] }, responsibleId: -1 }] });
  send({ type: "GV", graves: [{ x: 8, y: -8, id: 12 }] });
  assert.equal(thingName(w, gd, pv(), 8, -8), "Fresh Grave of OLGA STONE [same family]");
  // the YOU line
  send({ type: "PU", updates: [pu(1, 1, 1, 30, true, 0, { doneMovingSeq: 5 })] });
  assert.match(obs(w, acq, now()), /Under you: Fresh Grave of your sibling ANNA STONE\./);
});

test("graves: the book is shared and saved; another agent's world shows the grave by its own name rules", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "graves-"));
  try {
    const file = path.join(dir, "graves.json");
    const book = new GraveBook(file);
    const e: GraveEntry["person"] = { id: 3, name: "LIRA TIDEWICK", female: true, age: 30, ancestors: [200], eveId: 200, flower: "red rose" };
    book.link(5, 4, e);
    const again = new GraveBook(file);
    assert.equal(again.at(5, 4)?.person.name, "LIRA TIDEWICK", "survives a restart");
    const { w, acq, send } = busyWorld();
    w.graveBook = again;
    send({ type: "MX", changes: [{ x: 5, y: 4, floor: 0, obj: { id: FRESH, contained: [] }, responsibleId: -1 }] });
    assert.equal(thingName(w, gd, new PeopleView(w, gd, acq), 5, 4), "Fresh Grave of a woman, 30, with a red rose [other family]");
    acq.learn(3, "LIRA TIDEWICK");
    assert.equal(thingName(w, gd, new PeopleView(w, gd, acq), 5, 4), "Fresh Grave of LIRA TIDEWICK [other family]");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("remember: a name stated for exactly one visible stranger is recorded; anything vaguer is not", () => {
  const { w, acq } = busyWorld();
  const pv = new PeopleView(w, gd, acq, flowerOf);
  const r = (t: string) => rememberedName(t, pv);
  // #4 is the only stranger with a white lily
  assert.deepEqual(r("the man with the white lily is ASH"), { id: 4, name: "ASH", who: "the man with the white lily" });
  assert.deepEqual(r("the man at (-5, 2) is called Ash Grove"), { id: 4, name: "ASH GROVE", who: "the man with the white lily" });
  assert.deepEqual(r("white lily man's name is BRAN TIDE."), { id: 4, name: "BRAN TIDE", who: "the man with the white lily" });
  // red rose: two women wear one; the position picks one
  assert.equal(r("the woman with the red rose is LIRA"), null, "two match");
  assert.deepEqual(r("the woman with the red rose at (4, 4) is LIRA"), { id: 3, name: "LIRA", who: "the woman with the red rose" });
  // negatives
  for (const t of [
    "the man with the white lily is hungry", // not capitalised
    "the man with the white lily is HUNGRY", // not a name
    "the man with the white lily is a friend",
    "ASH is nice", // no reference
    "the man is ASH", // sex alone is no reference
    "the woman with the white lily is ASH", // the lily wearer is a man
    "the man at (20, 20) is ASH", // nobody there
    "the man with the white lily is ASH and he is kind", // the name isn't the end of the statement
    "my sister with the blue daisy is ANNA", // family: not a stranger
  ])
    assert.equal(r(t), null, t);
});

test("x,y person targeting: parsed, resolved to whoever stands at or next to the tile, and in the prompt", () => {
  const ok = checkActions({ action: { type: "pick_up_baby", x: 4, y: 4 } }, false, 4);
  assert.ok(!("error" in ok) && ok.steps[0].x === 4 && ok.steps[0].person === undefined);
  const give = checkActions({ action: { type: "give", x: 3, y: 4 } }, false, 4);
  assert.ok(!("error" in give));
  const bad = checkActions({ action: { type: "feed" } }, false, 4);
  assert.ok("error" in bad && /"person".*or "x" and "y"/.test(bad.error));
  const { w } = busyWorld();
  assert.equal(personAt(w, 4, 4), 3, "the carrier stands on the tile (her baby too: the lower id first)");
  assert.equal(personAt(w, -4, -3), 6, "within 1 tile");
  assert.equal(personAt(w, -10, -10), null);
  assert.equal(personAt(w, 0, 0), 2, "never ourselves");
  // where the model saw them when it looked
  assert.equal(personAt(w, 20, 20, new Map([[6, [20, 21]]])), 6);
  assert.match(actionList({ craft: false }), /the person is "person":ID or "x":X,"y":Y of where they stand/);
});

test("persistence: what an agent knows survives a restart of the same life, not a new life", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "known-"));
  try {
    const file = knownNamesPath(dir, "run1", "a1");
    const a = new Acquaintances(file);
    a.reset(42);
    a.learn(3, "LIRA TIDEWICK");
    a.learn(4, "BRAN", true);
    const b = new Acquaintances(file);
    assert.equal(b.restore(42), true);
    assert.deepEqual([...b.names], [[3, { name: "LIRA TIDEWICK" }], [4, { name: "BRAN", own: true }]]);
    const c = new Acquaintances(file);
    assert.equal(c.restore(43), false, "another life");
    assert.equal(c.names.size, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("agent: a remember note names a stranger (history says so, then the observation shows its own name); x,y targets a person", async () => {
  const { Agent } = await import("./agent.ts");
  const g = new FakeGame(gd);
  g.addPlayer({ id: 1, x: 0, y: 0, age: 30, held: 0, female: true });
  g.addPlayer({ id: 7, x: 2, y: 0, age: 30, held: 0, female: false });
  g.food = 15;
  g.start();
  g.world.handle({ type: "NM", names: [{ id: 7, first: "OSKAR", last: "VALE" }] });
  g.world.handle({ type: "LN", lineages: [{ id: 1, ancestors: [100], eveId: 100 }, { id: 7, ancestors: [400], eveId: 400 }] });
  const replies = [
    '{"thought":"t","remember":"the man with the pink peony is called ASH","action":{"type":"feed","x":2,"y":0}}',
    '{"action":{"type":"wait"}}',
  ];
  const seen: string[] = [];
  const llm = {
    overBudget: false,
    chat: async (m: { content: unknown }[]) => {
      seen.push(String(m[m.length - 1].content));
      return { text: replies.shift() ?? '{"action":{"type":"wait"}}', promptTokens: 0, completionTokens: 0, costUsd: 0, latencyMs: 1, model: "fake", finishReason: "stop" };
    },
  };
  const log = { emitEvent: () => {}, write: () => {} };
  const cfg = { runId: "t", recipeHints: false, craftMacro: false, llmModel: "fake", llmReasoningCap: false, decisionIntervalMs: 50, babyDecisionIntervalMs: 50, babyIdleMaxMs: 400, decisionCycleMs: 300, memoryMode: "per-life", memorySummary: false, actionListMax: 3 };
  const a = new Agent("a1", cfg as never, gd, llm as never, log as never, undefined, { flowerOf });
  const A = a as unknown as Record<string, any>;
  A.world = g.world;
  A.conn = { closed: false, close() {} };
  A.body = new Body(g.conn, g.world, gd);
  A.body.who = (id: number, fb?: string) => a.personRef(id, fb ?? `#${id}`);
  a.acq.reset(1);
  A.acqLive = true;
  A.sleepInterruptible = async () => {};
  await A.turn();
  assert.match(seen[0], /- a man, 30, with a pink peony \(you don't know their name\) \[other family\] at \(2, 0\)/);
  assert.doesNotMatch(seen[0], /OSKAR|VALE|#7/);
  const hist = A.history.map((h: { action: string; result: string }) => `${h.action} -> ${h.result}`);
  assert.ok(hist.includes(`remember "the man with the pink peony is called ASH" -> kept; you'll know the man with the pink peony as ASH`), hist.join("\n"));
  assert.ok(hist.some((h: string) => /^feed \(2, 0\) -> used bare hands on #7 ASH \(as you know him\): nothing happened/.test(h)), hist.join("\n"));
  await A.turn();
  assert.match(seen[1], /- #7 ASH \(as you know him\), man, 30, with a pink peony \[other family\]/);
  assert.doesNotMatch(seen[1], /OSKAR|VALE/);
});
