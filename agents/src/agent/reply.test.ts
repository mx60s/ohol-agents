// Reply parsing and action checking, including real replies from past runs
// (fixtures/llm-replies.json: every 40th reply from agents/logs*/, plus every
// reply the old parser failed on).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseReply, checkAction, checkActions, validActionTypes } from "./reply.ts";
import { stepFailed } from "./steps.ts";
import { buildSystemPrompt, systemPromptFor } from "./prompt.ts";
import { parseJsonReply } from "./llm.ts";
import { actionList } from "./prompt.ts";

const fixtures: { raw: string; kind: "ok" | "failed" }[] = JSON.parse(readFileSync(new URL("./fixtures/llm-replies.json", import.meta.url), "utf8"));

test("real replies: everything the old parser read still parses, to the same object", () => {
  const ok = fixtures.filter((f) => f.kind === "ok");
  assert.ok(ok.length > 30);
  for (const f of ok) {
    let old: unknown;
    try {
      old = parseJsonReply(f.raw);
    } catch {
      continue; // logged as a reply but unreadable before too
    }
    const r = parseReply(f.raw);
    assert.ok(r.ok, `should parse: ${f.raw.slice(0, 120)}`);
    assert.deepEqual(r.value, old);
  }
});

test("real replies the old parser failed on: each gets a recovery or a clear reason, never a throw", () => {
  const failed = fixtures.filter((f) => f.kind === "failed");
  assert.ok(failed.length > 20);
  let recovered = 0;
  for (const f of failed) {
    const r = parseReply(f.raw);
    if (r.ok) {
      recovered++;
      // a recovered reply must still pass the action check or say why not
      const c = checkAction(r.value, true);
      assert.ok("action" in c || /did nothing/.test(c.error));
    } else assert.match(r.reason, /cut off|no JSON|malformed|empty/);
  }
  assert.ok(recovered >= 1, "at least the reply missing only its final brace is recovered");
});

test("a reply cut off right before its closing brace is closed; a cut-off number is not completed", () => {
  const r = parseReply('{\n  "thought": "go",\n  "action": { "type": "use", "x": 36, "y": 130 }\n');
  assert.ok(r.ok);
  assert.deepEqual(r.value.action, { type: "use", x: 36, y: 130 });
  assert.equal(parseReply('{"thought":"x","action":{"type":"use","x":13,"y":-15').ok, false);
  const nl = parseReply('{"thought":"x","action":{"type":"use","x":13,"y":-154\n');
  assert.ok(nl.ok, "a number followed by a line break is complete");
});

test("last complete object wins; trailing commas and fences are tolerated", () => {
  const two = parseReply('{"action":{"type":"go","x":1,"y":1}} oops, correction: {"action":{"type":"go","x":2,"y":3}}');
  assert.ok(two.ok);
  assert.deepEqual(two.value.action, { type: "go", x: 2, y: 3 });
  const comma = parseReply('```json\n{"thought":"a, b",\n "action":{"type":"eat",},}\n```');
  assert.ok(comma.ok);
  assert.deepEqual(comma.value, { thought: "a, b", action: { type: "eat" } });
  assert.deepEqual(parseReply('{"t":"} not a brace {"}').ok ? "ok" : "no", "ok", "braces inside strings don't confuse it");
  assert.match((parseReply("") as { reason: string }).reason, /empty/);
  assert.match((parseReply("I will go north.") as { reason: string }).reason, /no JSON/);
});

test("every way an action can be wasted gets an explanation", () => {
  const err = (reply: unknown, craft = true) => {
    const c = checkAction(reply as Record<string, unknown>, craft);
    assert.ok("error" in c, JSON.stringify(reply));
    return c.error;
  };
  assert.match(err({ thought: "hm" }), /no "action"/);
  assert.match(err({ action: "go" }), /"go" needs numeric "x" and "y"/, "a bare string is a type without arguments");
  assert.match(err({ action: { x: 1 } }), /needs a "type"/);
  assert.match(err({ action: { type: "fly" } }), /unknown action type "fly"; valid types: use, drop/);
  assert.match(err({ action: { type: "go'; DROP" } }), /unknown action type/);
  assert.match(err({ action: { type: "use", x: 3 } }), /"use" needs numeric "x" and "y"/);
  assert.match(err({ action: { type: "pick_up_baby" } }), /needs "person"/);
  assert.match(err({ action: { type: "craft" } }), /"craft" needs "item"/);
  assert.match(err({ action: { type: "undress", slot: 9 } }), /slot/);
  assert.match(err({ action: { type: "craft", item: "Sharp Stone" } }, false), /unknown action type "craft"/, "craft off: not a valid type");
  const ok = checkAction({ action: { type: "craft", item: "  Sharp   Stone!! " } }, true);
  assert.ok("action" in ok);
  assert.deepEqual(ok.action, { type: "craft", item: "Sharp Stone" });
});

test("the prompt's action list names exactly the types the checker accepts", () => {
  for (const craft of [true, false]) {
    const listed = [...actionList({ craft }).matchAll(/^- \{"type":"([a-z_]+)"/gm)].map((m) => m[1]);
    assert.deepEqual(listed.sort(), validActionTypes(craft).sort());
  }
});

// Reply shapes open models produce (audit finding 10): each must yield the final action.
const FINAL = { type: "use", x: 3, y: -4 };
const finalJson = JSON.stringify({ thought: "pick the stone", action: FINAL });
const shapes: [string, string][] = [
  ["<think> with a drafted JSON inside", `<think>maybe {"action":{"type":"go","x":1,"y":1}}? no, better the stone. {oops</think>\n${finalJson}`],
  ["<think> with unbalanced braces", `<think>I could {go north... or not</think>${finalJson}`],
  ["dangling </think> (provider dropped the opener)", `drafting {"action":{"type":"go","x":9,"y":9}} hmm</think>\n${finalJson}`],
  ["<reasoning> block", `<reasoning>{"action":{"type":"eat"}}</reasoning>${finalJson}`],
  ["prose with braces before", `I see {a stone} and {a rock}. ${finalJson}`],
  ["prose with an unclosed brace before", `Plan { step one: stone. ${finalJson}`],
  ["JSON then prose with braces", `${finalJson}\nExplanation: the {stone} is at {3,-4}.`],
  ["drafted JSON, then the final one", `{"thought":"draft","action":{"type":"go","x":0,"y":0}}\nWait, correction:\n${finalJson}`],
  ["final JSON followed by a note-only object", `${finalJson}\n{"note":"remember the rock"}`],
  ["single quotes", `{'thought': 'it's my stone', 'action': {'type': 'use', 'x': 3, 'y': -4}}`],
  ["bare keys and // comments", `{thought: "go", // why\n action: {type: "use", x: 3, y: -4,},}`],
  ["fenced with trailing text", "```json\n" + finalJson + "\n```\nDone."],
];
for (const [name, text] of shapes) {
  test(`parser: ${name}`, () => {
    const r = parseReply(text);
    assert.ok(r.ok, `${name}: ${"reason" in r ? r.reason : ""}`);
    const c = checkAction(r.value, true);
    assert.ok("action" in c, JSON.stringify(c));
    assert.deepEqual(c.action, FINAL);
  });
}

test("parser: reasoning only, or a reply cut off inside its reasoning, gets a clear reason", () => {
  assert.match((parseReply("<think>let me think about {this") as { reason: string }).reason, /only reasoning/);
  assert.match((parseReply("<think>hmm</think>") as { reason: string }).reason, /only reasoning/);
});

test("actions: case, spacing and aliases are accepted; intent is never guessed beyond them", () => {
  const act = (a: unknown) => {
    const c = checkAction({ action: a } as Record<string, unknown>, true);
    assert.ok("action" in c, `${JSON.stringify(a)} -> ${JSON.stringify(c)}`);
    return c.action;
  };
  assert.equal(act({ type: "Forage" }).type, "forage");
  assert.equal(act({ type: " PICK-UP-BABY ", person: 12 }).type, "pick_up_baby");
  assert.deepEqual(act({ type: "pick up", x: 3, y: 4 }), { type: "use", x: 3, y: 4 }, "pick up a thing = bare-hand use");
  assert.deepEqual(act({ type: "pick up", person: "#12" }), { type: "pick_up_baby", person: 12 }, "pick up a person = pick_up_baby");
  assert.equal(act({ type: "walk", x: 1, y: 2 }).type, "go");
  assert.equal(act({ type: "Put Down" }).type, "drop");
  assert.equal(act({ type: "wear" }).type, "eat");
  assert.deepEqual(act({ type: "feed", person: "#12" }), { type: "feed", person: 12 });
  assert.deepEqual(act({ type: "pick_up_baby", id: 7 }), { type: "pick_up_baby", person: 7 });
  assert.deepEqual(act({ type: "go", pos: [3, -4] }), { type: "go", x: 3, y: -4 });
  assert.deepEqual(act({ type: "go", target: { x: 3, y: -4 } }), { type: "go", x: 3, y: -4 });
  assert.deepEqual(act({ type: "go", x: "(3, -4)" }), { type: "go", x: 3, y: -4 });
  assert.deepEqual(act("forage"), { type: "forage" }, "a bare string action");
  assert.deepEqual(act({ type: "say", text: "hello" }), { type: "say", text: "hello" });
  // top-level action fields
  const top = checkAction({ type: "go", x: 1, y: 2 }, true);
  assert.ok("action" in top && top.action.type === "go");
  // not aliases: rejected with what was sent
  const bad = checkAction({ action: { type: "dance" } }, true);
  assert.ok("error" in bad && /unknown action type "dance"/.test(bad.error));
  const fly = checkAction({ action: "teleport home" }, true);
  assert.ok("error" in fly && /unknown action type "teleport home"/.test(fly.error));
});

test("actions lists: an \"actions\" array (or an array under \"action\"), bare strings inside, capped", () => {
  const ok = checkActions({ actions: [{ type: "swap", x: 1, y: 2 }, "eat", { type: "Use", x: 3, y: 4 }] }, true, 3);
  assert.ok("steps" in ok);
  assert.deepEqual(ok.steps.map((s) => s.type), ["swap", "eat", "use"]);
  assert.deepEqual(ok.notes, []);
  const arr = checkActions({ action: [{ type: "drop" }, { type: "go", x: 1, y: 1 }] }, true, 3);
  assert.ok("steps" in arr && arr.steps.length === 2);
  const capped = checkActions({ actions: ["eat", "eat", "eat", "eat"] }, true, 3);
  assert.ok("steps" in capped && capped.steps.length === 3 && /only 3 steps/.test(capped.notes[0]));
  const one = checkActions({ actions: ["eat", "drop"] }, true, 1);
  assert.ok("steps" in one && one.steps.length === 1 && /only one action runs per turn/.test(one.notes[0]));
  const wrapped = checkActions({ action: { type: "actions", actions: [{ type: "drop" }, { type: "pick_up_baby", person: 5 }] } }, true, 4);
  assert.ok("steps" in wrapped);
  assert.deepEqual(wrapped.steps.map((s) => s.type), ["drop", "pick_up_baby"]);
  for (const k of ["steps", "items"]) {
    const w = checkActions({ action: { type: "actions", [k]: [{ type: "drop" }, { type: "eat" }] } }, true, 4);
    assert.ok("steps" in w && w.steps.length === 2, k);
  }
  const empty = checkActions({ actions: [] }, true, 3);
  assert.ok("error" in empty && /empty/.test(empty.error));
  const bad1 = checkActions({ actions: [{ type: "go" }, "eat"] }, true, 3);
  assert.ok("error" in bad1 && /^step 1: "go" needs numeric/.test(bad1.error));
});

test("step results: failures stop an actions list, successes don't", () => {
  for (const r of ["use at (3,4): nothing happened", "couldn't reach (1,2): no path found", "no path found", "stopped walking at (1,2): baby", "tried to pick up #4: your hands are full (holding Stone); drop it first", "not holding anything", "Ember Shaft at (3,4) is gone since you looked (now Long Straight Shaft); you did nothing", "error: boom"])
    assert.ok(stepFailed(r), r);
  for (const r of ["arrived", "use: tile (3,4) Stone -> nothing; holding nothing -> Stone", "ate Gooseberry; food 3 -> 8/20", "picked up baby #5", 'said "HI"', "waited 1 turn", "drop: tile (1,1) nothing -> Wild Gooseberry Bush (3/6 left)"])
    assert.ok(!stepFailed(r), r);
});

test("the prompt explains actions lists only when they are on", () => {
  const clock = { cycleMs: 8000, timeScale: 1 };
  assert.match(buildSystemPrompt(clock, { craft: true, actionListMax: 3 }), /"actions": a list of up to 3 actions done back to back/);
  assert.doesNotMatch(buildSystemPrompt(clock, { craft: true, actionListMax: 1 }), /"actions"/);
  assert.match(systemPromptFor({ promptBaseline: "playbook" }), /"actions": a list of up to 4 actions/, "default ACTION_LIST_MAX is 4 (the ember chain fits one list)");
});

test('{"type":"say"} without text is fine when the reply has top-level "say" words; alone it is still an error', () => {
  const ok = checkActions({ say: "ORDER, DIG", action: { type: "say" } }, false, 4);
  assert.ok(!("error" in ok), JSON.stringify(ok));
  if (!("error" in ok)) assert.equal(ok.steps[0].type, "say");
  const bad = checkActions({ action: { type: "say" } }, false, 4);
  assert.ok("error" in bad);
});

test('the type written as the only key is accepted: {"wait":{"turns":1}}, lists of {"drop":{x,y}}', () => {
  const w = checkActions({ action: { wait: { turns: 1 } } }, false, 4);
  assert.ok(!("error" in w), JSON.stringify(w));
  if (!("error" in w)) assert.deepEqual([w.steps[0].type, w.steps[0].turns], ["wait", 1]);
  const l = checkActions({ actions: [{ drop: { x: 57, y: -71 } }, { go: { x: 61, y: -73 } }, { eat: {} }] }, false, 4);
  assert.ok(!("error" in l), JSON.stringify(l));
  if (!("error" in l)) assert.deepEqual(l.steps.map((s) => [s.type, s.x, s.y]), [["drop", 57, -71], ["go", 61, -73], ["eat", undefined, undefined]]);
  assert.ok("error" in checkActions({ action: { banana: { x: 1, y: 2 } } }, false, 4), "unknown key is still an error");
  assert.ok("error" in checkActions({ action: { go: { x: 1, y: 2 }, use: { x: 1, y: 2 } } }, false, 4), "two keys: ambiguous");
});

test('plain-value type-as-key replies: {"wait":1} and {"say":"F"}', () => {
  const w = checkAction({ action: { wait: 2 } }, false);
  assert.ok(!("error" in w), JSON.stringify(w));
  if (!("error" in w)) assert.deepEqual([w.action.type, w.action.turns], ["wait", 2]);
  const s = checkAction({ action: { say: "F" } }, false);
  assert.ok(!("error" in s), JSON.stringify(s));
  if (!("error" in s)) assert.deepEqual([s.action.type, s.action.text], ["say", "F"]);
  assert.ok("error" in checkAction({ action: { go: 3 } }, false), "other types still need an object");
});

test("give: needs a person; hand/pass are aliases", () => {
  const ok = checkAction({ action: { type: "give", person: 4 } }, false);
  assert.ok(!("error" in ok) && ok.action.type === "give");
  const alias = checkAction({ action: { type: "hand", person: 4 } }, false);
  assert.ok(!("error" in alias) && alias.action.type === "give");
  assert.ok("error" in checkAction({ action: { type: "give" } }, false));
});

test("a reply with a say and no action is a say turn, not an invalid reply", () => {
  const c = checkActions({ thought: "x", say: "HELLO" }, false, 4);
  assert.ok("steps" in c && c.steps.length === 1 && c.steps[0].type === "say" && !c.steps[0].text, JSON.stringify(c));
  assert.ok("error" in checkActions({ thought: "x", say: "  " }, false, 4), "no words and no action: did nothing");
});

test("a refused far target counts as a failed step", () => {
  assert.ok(stepFailed("drop at (0,0): not done: (0,0) is 130 tiles from you at (-130,57); drop works on tiles up to 24 away"));
  assert.ok(!stepFailed("spoke; no other action this turn"));
});

test("search: parsed with its aliases and shapes; \"\" clears; no words is an error", () => {
  const act = (a: unknown) => {
    const c = checkAction({ action: a }, false);
    assert.ok("action" in c, JSON.stringify(c));
    return c.action;
  };
  assert.deepEqual(act({ type: "search", what: "Fire" }), { type: "search", what: "Fire" });
  for (const t of ["lookup", "look up", "how", "how_to_make", "recipe"]) assert.equal(act({ type: t, what: "Reed Skirt" }).type, "search", t);
  assert.deepEqual(act({ type: "search", item: "Sharp Stone" }), { type: "search", what: "Sharp Stone" });
  assert.deepEqual(act({ type: "lookup", query: "fire!!" }), { type: "search", what: "fire" });
  assert.deepEqual(act({ search: "basket" }), { type: "search", what: "basket" });
  assert.deepEqual(act({ type: "search", what: "" }), { type: "search", what: "" });
  const bad = checkAction({ action: { type: "search" } }, false);
  assert.ok("error" in bad && /"search" needs "what"/.test(bad.error));
});

test("the action list's search line describes it and nothing more", () => {
  for (const craft of [true, false])
    assert.ok(actionList({ craft }).includes(`- {"type":"search","what":"<thing>"}  look up how a thing is made, step by step (the game's hint search)`));
  const clock = { cycleMs: 8000, timeScale: 1 };
  for (const baseline of ["new", "playbook"] as const) assert.match(buildSystemPrompt(clock, { craft: false, baseline }), /"type":"search"/);
});
