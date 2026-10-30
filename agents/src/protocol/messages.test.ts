import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMessage } from "./messages.ts";
import type { RawMessage } from "./connection.ts";

const raw = (type: string, lines: string[], binary?: Buffer): RawMessage => ({ type, lines, binary });

// A valid 25-field PU line with overridable fields, to keep tests readable.
const PU_FIELDS = [
  "2", // p_id
  "1007", // po_id
  "0", // facing
  "0", // action
  "0", // action_target_x
  "0", // action_target_y
  "0", // o_id
  "0", // o_origin_valid
  "0", // o_origin_x
  "0", // o_origin_y
  "-1", // o_transition_source_id
  "0.50", // heat
  "1", // done_moving_seqNum
  "0", // force
  "0", // x
  "0", // y
  "14.00", // age
  "60.00", // age_r
  "3.75", // move_speed
  "0;0;0;0;0;0", // clothing_set
  "0", // just_ate
  "0", // last_ate_id
  "-1", // responsible_id
  "0", // held_yum
  "0", // held_learned
];
const puLine = (overrides: Record<number, string>, extra: string[] = []): string => {
  const f = [...PU_FIELDS];
  for (const [i, v] of Object.entries(overrides)) f[Number(i)] = v;
  return [...f, ...extra].join(" ");
};

test("PU parses the real captured line", () => {
  const msg = parseMessage(raw("PU", ["2 1007 0 0 0 0 0 0 0 0 -1 0.50 1 0 0 0 14.00 60.00 3.75 0;0;0;0;0;0 0 0 -1 0 0"]));
  assert.equal(msg.type, "PU");
  if (msg.type !== "PU") return;
  assert.equal(msg.updates.length, 1);
  const u = msg.updates[0];
  assert.equal(u.id, 2);
  assert.equal(u.displayId, 1007);
  assert.equal(u.facing, 0);
  assert.equal(u.action, false);
  assert.deepEqual(u.actionTarget, [0, 0]);
  assert.deepEqual(u.held, { id: 0, contained: [] });
  assert.equal(u.heldOriginValid, false);
  assert.deepEqual(u.heldOrigin, [0, 0]);
  assert.equal(u.heldTransitionSourceId, -1);
  assert.equal(u.heat, 0.5);
  assert.equal(u.doneMovingSeq, 1);
  assert.equal(u.forced, false);
  assert.equal(u.x, 0);
  assert.equal(u.y, 0);
  assert.equal(u.age, 14);
  assert.equal(u.ageRate, 60);
  assert.equal(u.moveSpeed, 3.75);
  assert.equal(u.clothing.length, 6);
  assert.deepEqual(u.clothing[0], { id: 0, contained: [] });
  assert.equal(u.justAte, false);
  assert.equal(u.lastAteId, 0);
  assert.equal(u.responsibleId, -1);
  assert.equal(u.heldYum, false);
  assert.equal(u.heldLearned, false);
  assert.equal(u.deathReason, undefined);
});

test("PU parses held container with sub-contained items", () => {
  // basket(292) holding a pouch(560) with two berries(214) inside, plus a flint(33)
  const msg = parseMessage(raw("PU", [puLine({ 6: "292,560:214:214,33", 7: "1", 8: "5", 9: "-3", 10: "291", 23: "1", 24: "1" })]));
  assert.equal(msg.type, "PU");
  if (msg.type !== "PU") return;
  const u = msg.updates[0];
  assert.deepEqual(u.held, {
    id: 292,
    contained: [
      { id: 560, sub: [214, 214] },
      { id: 33, sub: [] },
    ],
  });
  assert.equal(u.heldOriginValid, true);
  assert.deepEqual(u.heldOrigin, [5, -3]);
  assert.equal(u.heldTransitionSourceId, 291);
  assert.equal(u.heldYum, true);
  assert.equal(u.heldLearned, true);
});

test("PU negative held id means holding a baby", () => {
  const msg = parseMessage(raw("PU", [puLine({ 6: "-17" })]));
  assert.equal(msg.type, "PU");
  if (msg.type !== "PU") return;
  assert.deepEqual(msg.updates[0].held, { id: -17, contained: [] });
});

test("PU deleted player has null x/y and a death reason", () => {
  const msg = parseMessage(raw("PU", [puLine({ 12: "0", 14: "X", 15: "X" }, ["reason_hunger"])]));
  assert.equal(msg.type, "PU");
  if (msg.type !== "PU") return;
  const u = msg.updates[0];
  assert.equal(u.x, null);
  assert.equal(u.y, null);
  assert.equal(u.deathReason, "reason_hunger");

  const killed = parseMessage(raw("PU", [puLine({ 12: "0", 14: "X", 15: "X" }, ["reason_killed_123"])]));
  assert.equal(killed.type, "PU");
  if (killed.type !== "PU") return;
  assert.equal(killed.updates[0].deathReason, "reason_killed_123");
});

test("PU with multiple lines and clothing contents", () => {
  const line = puLine({ 0: "7", 19: "0;550,551;0;0;0;552,10:20" });
  const msg = parseMessage(raw("PU", [line, puLine({ 0: "8" })]));
  assert.equal(msg.type, "PU");
  if (msg.type !== "PU") return;
  assert.equal(msg.updates.length, 2);
  assert.deepEqual(msg.updates[0].clothing[1], { id: 550, contained: [{ id: 551, sub: [] }] });
  assert.deepEqual(msg.updates[0].clothing[5], { id: 552, contained: [{ id: 10, sub: [20] }] });
  assert.equal(msg.updates[1].id, 8);
});

test("PM expands path deltas to absolute waypoints", () => {
  const msg = parseMessage(raw("PM", ["5 10 20 6.000 5.500 0 1 0 1 1 0 1", "9 -3 -4 1.250 1.000 1 0 -2"]));
  assert.equal(msg.type, "PM");
  if (msg.type !== "PM") return;
  assert.equal(msg.moves.length, 2);
  const m = msg.moves[0];
  assert.equal(m.id, 5);
  assert.deepEqual(m.start, [10, 20]);
  assert.equal(m.totalSec, 6);
  assert.equal(m.etaSec, 5.5);
  assert.equal(m.truncated, false);
  assert.deepEqual(m.path, [
    [11, 20],
    [11, 21],
    [10, 21],
  ]);
  assert.equal(msg.moves[1].truncated, true);
  assert.deepEqual(msg.moves[1].path, [[-3, -6]]);
});

test("PO, DY, HE, BW parse id lists", () => {
  const po = parseMessage(raw("PO", ["1", "22", "333"]));
  assert.deepEqual(po, { type: "PO", ids: [1, 22, 333] });
  // DY lines may carry an optional isSick flag; only the id is kept
  const dy = parseMessage(raw("DY", ["4 1", "5"]));
  assert.deepEqual(dy, { type: "DY", ids: [4, 5] });
  const he = parseMessage(raw("HE", ["4", "5"]));
  assert.deepEqual(he, { type: "HE", ids: [4, 5] });
  const bw = parseMessage(raw("BW", ["6"]));
  assert.deepEqual(bw, { type: "BW", ids: [6] });
});

test("MX parses real captured lines", () => {
  const msg = parseMessage(raw("MX", ["0 12 0 1323 -1 0 11 4.000000", "0 11 0 0 -1"]));
  assert.equal(msg.type, "MX");
  if (msg.type !== "MX") return;
  assert.equal(msg.changes.length, 2);
  const a = msg.changes[0];
  assert.equal(a.x, 0);
  assert.equal(a.y, 12);
  assert.equal(a.floor, 0);
  assert.deepEqual(a.obj, { id: 1323, contained: [] });
  assert.equal(a.responsibleId, -1);
  assert.deepEqual(a.from, { x: 0, y: 11, speed: 4 });
  const b = msg.changes[1];
  assert.deepEqual(b.obj, { id: 0, contained: [] });
  assert.equal(b.from, undefined);
});

test("MX parses container new_id with sub-contained", () => {
  const msg = parseMessage(raw("MX", ["3 -7 88 292,560:214,33 42"]));
  assert.equal(msg.type, "MX");
  if (msg.type !== "MX") return;
  const c = msg.changes[0];
  assert.equal(c.floor, 88);
  assert.deepEqual(c.obj, {
    id: 292,
    contained: [
      { id: 560, sub: [214] },
      { id: 33, sub: [] },
    ],
  });
  assert.equal(c.responsibleId, 42);
});

test("MC decodes a 2x2 synthetic chunk", () => {
  // cells row-major from (-16, -15), y increasing per row
  const payload = "2:0:0 2:0:1157 0:0:133,33:44 1:4:0";
  const msg = parseMessage(raw("MC", ["2 2 -16 -15", `${payload.length} 12`], Buffer.from(payload, "latin1")));
  assert.equal(msg.type, "MC");
  if (msg.type !== "MC") return;
  const c = msg.chunk;
  assert.equal(c.x, -16);
  assert.equal(c.y, -15);
  assert.equal(c.w, 2);
  assert.equal(c.h, 2);
  assert.equal(c.cells.length, 4);
  // world pos of cell i = (x + i % w, y + floor(i / w))
  assert.deepEqual(c.cells[0], { biome: 2, floor: 0, obj: { id: 0, contained: [] } }); // (-16,-15)
  assert.deepEqual(c.cells[1], { biome: 2, floor: 0, obj: { id: 1157, contained: [] } }); // (-15,-15)
  assert.deepEqual(c.cells[2], {
    biome: 0,
    floor: 0,
    obj: { id: 133, contained: [{ id: 33, sub: [44] }] }, // container + sub-contained at (-16,-14)
  });
  assert.deepEqual(c.cells[3], { biome: 1, floor: 4, obj: { id: 0, contained: [] } }); // (-15,-14)
});

test("PS keeps text verbatim, including spaces and *map tokens", () => {
  const msg = parseMessage(raw("PS", [
    "1432/0 HELLO THERE",
    "1501/1 CURSE JOHN SMITH",
    "38499/0 :SPECIAL SPOT *map 13 6 92",
    "38501/0 OUTSIDER NAMELESS PERSON IS MY NEW FOLLOWER *visitor 38500 *map 3 0",
  ]));
  assert.equal(msg.type, "PS");
  if (msg.type !== "PS") return;
  assert.deepEqual(msg.says[0], { id: 1432, isCurse: false, text: "HELLO THERE" });
  assert.deepEqual(msg.says[1], { id: 1501, isCurse: true, text: "CURSE JOHN SMITH" });
  assert.deepEqual(msg.says[2], { id: 38499, isCurse: false, text: ":SPECIAL SPOT *map 13 6 92" });
  assert.equal(msg.says[3].text, "OUTSIDER NAMELESS PERSON IS MY NEW FOLLOWER *visitor 38500 *map 3 0");
});

test("LS parses x y and verbatim text", () => {
  const msg = parseMessage(raw("LS", ["0 25 HELLO THERE", "-342 3847 HELP ME"]));
  assert.deepEqual(msg, {
    type: "LS",
    says: [
      { x: 0, y: 25, text: "HELLO THERE" },
      { x: -342, y: 3847, text: "HELP ME" },
    ],
  });
});

test("FX parses the real captured line", () => {
  const msg = parseMessage(raw("FX", ["18 18 0 0 3.75 -1 0 0"]));
  assert.deepEqual(msg, {
    type: "FX",
    food: {
      food: 18,
      capacity: 18,
      lastAteId: 0,
      lastAteFillMax: 0,
      moveSpeed: 3.75,
      responsibleId: -1,
      yumBonus: 0,
      yumMultiplier: 0,
    },
  });
});

test("HX parses the real captured line", () => {
  const msg = parseMessage(raw("HX", ["0.43 21.32 0.00"]));
  assert.deepEqual(msg, { type: "HX", heat: { heat: 0.43, foodTime: 21.32, indoorBonus: 0 } });
});

test("LN parses eve-only and multi-ancestor lines", () => {
  const msg = parseMessage(raw("LN", ["2 eve=2", "5 4 3 2 eve=2"]));
  assert.equal(msg.type, "LN");
  if (msg.type !== "LN") return;
  assert.deepEqual(msg.lineages[0], { id: 2, ancestors: [], eveId: 2 });
  assert.deepEqual(msg.lineages[1], { id: 5, ancestors: [4, 3, 2], eveId: 2 });
});

test("NM parses names with and without last name", () => {
  const msg = parseMessage(raw("NM", ["2 EVE SMITH", "3 JOHN"]));
  assert.equal(msg.type, "NM");
  if (msg.type !== "NM") return;
  assert.deepEqual(msg.names[0], { id: 2, first: "EVE", last: "SMITH" });
  assert.deepEqual(msg.names[1], { id: 3, first: "JOHN" });
  assert.equal(msg.names[1].last, undefined);
});

test("PE parses emotes with optional ttl", () => {
  const msg = parseMessage(raw("PE", ["1432 4", "1501 6 30", "1449 17 -1"]));
  assert.equal(msg.type, "PE");
  if (msg.type !== "PE") return;
  assert.deepEqual(msg.emotes[0], { id: 1432, emot: 4 });
  assert.equal(msg.emotes[0].ttl, undefined);
  assert.deepEqual(msg.emotes[1], { id: 1501, emot: 6, ttl: 30 });
  assert.deepEqual(msg.emotes[2], { id: 1449, emot: 17, ttl: -1 });
});

test("CR, TS, FW, GV, LR, FM, PONG parse", () => {
  assert.deepEqual(parseMessage(raw("CR", ["40 2"])), { type: "CR", craving: { foodId: 40, bonus: 2 } });
  assert.deepEqual(parseMessage(raw("TS", ["37 5"])), { type: "TS", used: 37, total: 5 });
  assert.deepEqual(parseMessage(raw("FW", ["2 -1 -1", "5 9 3"])), {
    type: "FW",
    follows: [
      { followerId: 2, leaderId: -1, colorIndex: -1 },
      { followerId: 5, leaderId: 9, colorIndex: 3 },
    ],
  });
  assert.deepEqual(parseMessage(raw("GV", ["10 -4 77"])), { type: "GV", graves: [{ x: 10, y: -4, id: 77 }] });
  assert.deepEqual(parseMessage(raw("LR", ["560 441 462"])), { type: "LR", toolIds: [560, 441, 462] });
  assert.deepEqual(parseMessage(raw("FM", [])), { type: "FM" });
  assert.deepEqual(parseMessage(raw("PONG", ["12345"])), { type: "PONG", id: "12345" });
});

test("unknown tags map to OTHER with original tag and lines", () => {
  const msg = parseMessage(raw("AP", []));
  assert.deepEqual(msg, { type: "OTHER", tag: "AP", lines: [] });
  const vu = parseMessage(raw("VU", ["301 14"]));
  assert.deepEqual(vu, { type: "OTHER", tag: "VU", lines: ["301 14"] });
});

test("malformed input yields OTHER instead of throwing", () => {
  const cases: RawMessage[] = [
    raw("PU", ["2 1007 0"]), // too few fields
    raw("PU", [puLine({ 16: "notanumber" })]), // bad float
    raw("PM", ["5 10"]), // too few fields
    raw("MX", ["1 2 3"]), // too few fields
    raw("FX", ["18 18"]), // too few fields
    raw("HX", ["abc 1 2"]), // bad float
    raw("PS", ["noslashor space"]), // no p_id/isCurse prefix
    raw("LN", ["2"]), // missing eve
    raw("NM", ["2"]), // missing name
    raw("MC", ["2 2 0 0", "10 5"]), // missing binary
    raw("MC", ["2 2 0 0", "10 5"], Buffer.from("2:0:0 2:0:0", "latin1")), // too few cells
    raw("MC", ["2 2 0 0", "10 5"], Buffer.from("2:0 2:0:0 2:0:0 2:0:0", "latin1")), // bad cell
    raw("PO", ["notanint"]),
    raw("CR", ["40"]), // missing bonus
    raw("TS", ["37"]), // missing total
    raw("PONG", []), // missing id
  ];
  for (const c of cases) {
    const msg = parseMessage(c);
    assert.equal(msg.type, "OTHER", `expected OTHER for ${JSON.stringify(c)}`);
    if (msg.type === "OTHER") {
      assert.equal(msg.tag, c.type);
      assert.equal(msg.lines, c.lines);
    }
  }
});
