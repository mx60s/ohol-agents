// Server metadata on speech lines (*leader, *follower, *baby, *map) is for the client's arrows, not words.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readSpeechTags } from "./world.ts";

test("an order keeps its words and names the nearest follower; tags are stripped", () => {
  assert.deepEqual(readSpeechTags("ORDER, PICK UP BABY *follower 3 *map 82 15 0"), { text: "ORDER, PICK UP BABY", notice: null, followerId: 3 });
  assert.deepEqual(readSpeechTags("HELLO THERE"), { text: "HELLO THERE", notice: null, followerId: null });
  assert.deepEqual(readSpeechTags("THIS WAY *map 4 -9 1794900000"), { text: "THIS WAY", notice: null, followerId: null });
  assert.equal(readSpeechTags("MY LADY *leader 2 *map 82 15").pointerId, 2);
});

test("private pointer lines become notices: leader, new baby, others", () => {
  assert.equal(readSpeechTags("MY LADY *leader 2 *map 82 15").notice, "Your leader is #2 (your lady).");
  assert.equal(readSpeechTags("MY BARON *leader 17 *map -3 4\n#").notice, "Your leader is #17 (your baron).");
  assert.equal(readSpeechTags("A NEW OFFSPRING BABY *baby 43 *map -279 -17").notice, "A NEW OFFSPRING BABY (a new baby in your family: #43)");
  assert.equal(readSpeechTags("EXPERT *expert 9 *map 1 2").notice, "EXPERT (an expert: #9)");
});

import { FakeGame } from "./fakeGame.ts";
import { GameData } from "./gameData.ts";

test("a heard naming line is marked with who it named once the name arrives", () => {
  const g = new FakeGame(new GameData());
  g.addPlayer({ id: 1, x: 0, y: 0, age: 10, held: 0, female: false });
  g.addPlayer({ id: 2, x: 1, y: 0, age: 22, held: -3, female: true });
  g.addPlayer({ id: 3, x: 1, y: 0, age: 0.1, held: 0, female: true });
  g.start();
  g.world.handle({ type: "PS", says: [{ id: 2, isCurse: false, text: "YOU ARE AURORA BREEZE" }] });
  g.world.handle({ type: "PS", says: [{ id: 2, isCurse: false, text: "AURORA IS HUNGRY" }] });
  g.world.handle({ type: "NM", names: [{ id: 3, first: "AURORA", last: "BREEZE" }] });
  const texts = g.world.heard.map((h) => h.text);
  assert.ok(texts.includes("YOU ARE AURORA BREEZE [this named #3]"), texts.join(" | "));
  assert.ok(texts.includes("AURORA IS HUNGRY"), "a later line that only mentions the name is left alone");
  assert.equal(texts.filter((t) => t.includes("[this named")).length, 1, "only one line is marked");
  // a renamed (already named) player doesn't mark anything
  g.world.handle({ type: "NM", names: [{ id: 3, first: "AURORA", last: "BREEZE" }] });
  assert.equal(g.world.heard.filter((h) => h.text.includes("[this named")).length, 1);
});
