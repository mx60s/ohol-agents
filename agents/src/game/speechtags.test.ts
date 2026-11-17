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
