// Stream camera crowd logic (node --test, .ts via type stripping): speech plan, chat lines, labels, collisions.
import assert from "node:assert/strict";
import test from "node:test";

import { CROWD_AT, chatLines, crowdMode, labelPriority, placeBoxes, planSpeech, shortName } from "../src/stream/crowd.ts";

let seq = 0;
const say = (playerId, text, t, extra = {}) => ({ seq: ++seq, t, kind: "say", agentId: null, playerId, name: null, text, ...extra });

test("crowdMode: on at CROWD_AT people, off again two below", () => {
  assert.equal(crowdMode(false, CROWD_AT - 1), false);
  assert.equal(crowdMode(false, CROWD_AT), true);
  assert.equal(crowdMode(true, CROWD_AT - 1), true);
  assert.equal(crowdMode(true, CROWD_AT - 2), false);
});

test("planSpeech: everything in full when not crowded", () => {
  const b = [{ key: "3", playerId: 3, text: "c" }, { key: "2", playerId: 2, text: "b" }, { key: "1", playerId: 1, text: "", emote: "HOMESICK" }];
  assert.deepEqual(planSpeech(b, false, 1), { full: b, pips: [] });
});

test("planSpeech: crowded, the focus and the newest other speaker on screen in full, pips for the rest, other emotes dropped", () => {
  const b = [
    { key: "9", playerId: 9, text: "far away" },
    { key: "5", playerId: 5, text: "newest here" },
    { key: "4", playerId: 4, text: "", emote: "HOMESICK" },
    { key: "3", playerId: 3, text: "older" },
    { key: "1", playerId: 1, text: "", emote: "HOME" },
  ];
  const p = planSpeech(b, true, 1, new Set([1, 3, 4, 5]));
  assert.deepEqual(p.full.map((x) => x.key), ["5", "1"]);
  assert.deepEqual(p.pips, [9, 3]);
  // without a view set the newest other line wins wherever it is
  assert.deepEqual(planSpeech(b, true, 1).full.map((x) => x.key), ["9", "1"]);
});

test("chatLines: on-screen speakers and the focus, oldest first, capped, windowed", () => {
  const people = { 1: { name: "EMBER THORNDALE", lineageId: "A" }, 2: { name: "REED TIDEWICK", lineageId: "B" }, 3: { name: "IVY THORNDALE", lineageId: "A" }, 4: { name: "FAR AWAY", lineageId: "A" } };
  const ev = [
    say(2, "too old", 1_000),
    say(3, "HELLO", 200_000),
    say(4, "not on screen", 201_000),
    say(1, "I AM HERE", 202_000),
    { seq: ++seq, t: 202_500, kind: "action", agentId: null, playerId: 2, name: null, text: "walk" },
    say(2, "+HOMESICK+", 203_000),
    say(2, "+HOMESICK+", 203_500),
    say(2, "  ", 204_000),
  ];
  const lines = chatLines(ev, { now: 205_000, inView: new Set([2, 3]), focusPlayerId: 1, focusLineageId: "A", who: (id) => people[id] });
  assert.deepEqual(
    lines.map((l) => [l.name, l.text, l.emote, l.cross, l.family]),
    [
      ["Ivy Thorndale", "HELLO", null, false, "Thorndale"],
      ["Ember Thorndale", "I AM HERE", null, false, "Thorndale"],
      ["Reed Tidewick", "", "HOMESICK", true, "Tidewick"],
    ],
  );
  assert.equal(chatLines(ev, { now: 205_000, inView: new Set([2, 3]), focusPlayerId: 1, who: (id) => people[id], max: 2 }).length, 2);
});

test("chatLines: strips invisible characters, falls back to the event's name", () => {
  const lines = chatLines([say(7, "HI‮THERE", 10, { name: "LARK HOLLY" })], { now: 20, inView: new Set([7]), focusPlayerId: null, who: () => null });
  assert.equal(lines[0].text, "HITHERE");
  assert.equal(lines[0].name, "Lark Holly");
});

test("shortName: first name (with numeral), unnamed people whole", () => {
  assert.equal(shortName("Ember Thorndale"), "Ember");
  assert.equal(shortName("Aurora II Dawn"), "Aurora II");
  assert.equal(shortName("Unnamed Valley"), "Unnamed Valley");
  assert.equal(shortName("Baby"), "Baby");
});

test("labelPriority: focus, then speakers, then the focus's babies, then others", () => {
  const f = labelPriority({ focus: true, speaking: true, focusBaby: false });
  const s = labelPriority({ focus: false, speaking: true, focusBaby: true });
  const b = labelPriority({ focus: false, speaking: false, focusBaby: true });
  const o = labelPriority({ focus: false, speaking: false, focusBaby: false });
  assert.ok(f < s && s < b && b < o);
});

test("placeBoxes: priority wins the spot, others nudge in their direction or hide", () => {
  const box = (key, x, y, prio, extra = {}) => ({ key, x, y, w: 100, h: 20, prio, dir: 1, ...extra });
  const out = placeBoxes([box("other", 100, 100, 6, { optional: true }), box("focus", 100, 100, 1)], 1000, 600);
  assert.deepEqual(out.get("focus"), { x: 100, y: 100, w: 100, h: 20 });
  // nudged one step down (its height + gaps)
  assert.equal(out.get("other").y, 124);

  // no room within its steps: an optional label hides, a required one keeps its spot
  const wall = [box("a", 100, 100, 1), box("b", 100, 124, 1), box("c", 100, 148, 1)];
  const hid = placeBoxes([...wall, box("x", 100, 100, 6, { optional: true, steps: 2 })], 1000, 600);
  assert.equal(hid.get("x"), null);
  // a required one still shows: half a width aside if that is free, else where it overlaps least
  const kept = placeBoxes([...wall, box("y", 100, 100, 6, { steps: 2 })], 1000, 600);
  assert.ok(kept.get("y"));
  const aside = placeBoxes([box("a", 100, 100, 1, { w: 50 }), box("y", 100, 100, 6, { steps: 0 })], 1000, 600);
  assert.deepEqual([aside.get("y").x, aside.get("y").y], [155, 100]);

  // bubbles nudge up; everything is clamped into the screen
  const up = placeBoxes([box("a", 100, 100, 1), box("b", 100, 100, 2, { dir: -1 })], 1000, 600);
  assert.equal(up.get("b").y, 76);
  const edge = placeBoxes([box("e", 990, 595, 1)], 1000, 600);
  assert.deepEqual([edge.get("e").x, edge.get("e").y], [892, 572]);
});

test("placeBoxes: side-by-side boxes do not collide", () => {
  const out = placeBoxes(
    [
      { key: "a", x: 0, y: 100, w: 100, h: 20, prio: 1, dir: 1 },
      { key: "b", x: 200, y: 100, w: 100, h: 20, prio: 2, dir: 1, optional: true },
    ],
    1000,
    600,
  );
  assert.equal(out.get("b").y, 100);
});

test("placeBoxes: an optional bubble (nudging up) may also step aside before it hides", () => {
  const out = placeBoxes(
    [
      { key: "a", x: 100, y: 8, w: 50, h: 20, prio: 1, dir: 1 },
      { key: "b", x: 100, y: 8, w: 100, h: 20, prio: 2, dir: -1, steps: 2, optional: true },
    ],
    1000,
    600,
  );
  assert.deepEqual([out.get("b").x, out.get("b").y], [155, 8]);
});
