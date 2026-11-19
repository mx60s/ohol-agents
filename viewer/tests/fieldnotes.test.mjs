// Field notes on the home page: normalisation, text -> blocks (safe rendering), time labels, fixtures.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { normFieldNotes } from "../src/data/normalize.ts";
import { FIELD_NOTES_EMPTY, clock12, clockRange, noteBlocks, noteTimeLabel } from "../src/site/fieldnotes.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixtureFile = (name, file) => path.join(HERE, "..", "fixtures", name, file);
const MIN = 60_000;
const at = (h, m) => Date.UTC(2026, 10, 18, h, m);

test("normFieldNotes: drops malformed rows, newest first", () => {
  const r = normFieldNotes({
    notes: [
      { t: at(17, 0), runId: "r", windowStart: at(16, 40), windowEnd: at(17, 0), text: "Older.", model: "m" },
      { t: at(17, 20), runId: "r", windowStart: at(17, 0), windowEnd: at(17, 20), text: "Newer.\r\n- a", model: "m" },
      { t: 1, windowStart: 5, windowEnd: 4, text: "end before start" },
      { windowStart: 1, windowEnd: 2, text: "   " },
      { windowStart: "x", windowEnd: 2, text: "bad start" },
      "junk",
    ],
  });
  assert.deepEqual(r.notes.map((n) => n.text), ["Newer.\n- a", "Older."]);
  assert.deepEqual(normFieldNotes(null), { notes: [] });
  assert.deepEqual(normFieldNotes({ notes: "x" }), { notes: [] });
  // t defaults to the window end
  assert.equal(normFieldNotes({ notes: [{ windowStart: 1, windowEnd: 2, text: "x" }] }).notes[0].t, 2);
});

test("noteBlocks: paragraphs and bullet lists; markup stays plain text", () => {
  assert.deepEqual(noteBlocks("First line\ncontinues.\n\nSecond para.\n- one\n* two\n• three\nAfter list."), [
    { kind: "p", text: "First line continues." },
    { kind: "p", text: "Second para." },
    { kind: "ul", items: ["one", "two", "three"] },
    { kind: "p", text: "After list." },
  ]);
  // rendered as React text nodes: tags come through as literal text, never as elements
  assert.deepEqual(noteBlocks('<img src=x onerror="alert(1)"> hi'), [{ kind: "p", text: '<img src=x onerror="alert(1)"> hi' }]);
  assert.deepEqual(noteBlocks("\n\n"), []);
  assert.deepEqual(noteBlocks("-not a bullet"), [{ kind: "p", text: "-not a bullet" }]);
});

test("time labels: '5:20 pm · covering 5:00–5:20'; a long first note says 'the run so far'", () => {
  assert.equal(clock12(at(17, 20), "UTC"), "5:20 pm");
  assert.equal(clockRange(at(11, 50), at(12, 10), "UTC"), "11:50 am–12:10 pm");
  const n = { t: at(17, 20) + 30_000, runId: "r", windowStart: at(17, 0), windowEnd: at(17, 20), text: "x", model: "m" };
  assert.equal(noteTimeLabel(n, "UTC"), "5:20 pm · covering 5:00–5:20");
  const first = { ...n, windowStart: at(17, 20) - 105 * MIN };
  assert.equal(noteTimeLabel(first, "UTC"), "5:20 pm · covering the run so far, 3:35–5:20");
});

test("fixtures: live1 has three notes (newest first, bullets in the newest); edge has none -> the empty state", () => {
  const fx = normFieldNotes(JSON.parse(fs.readFileSync(fixtureFile("live1", "fieldnotes.json"), "utf8")));
  assert.equal(fx.notes.length, 3);
  assert.ok(fx.notes[0].windowEnd > fx.notes[1].windowEnd && fx.notes[1].windowEnd > fx.notes[2].windowEnd);
  assert.ok(noteBlocks(fx.notes[0].text).some((b) => b.kind === "ul"));
  assert.match(noteTimeLabel(fx.notes[2]), /the run so far/);
  for (const n of fx.notes) {
    const words = n.text.split(/\s+/).length;
    assert.ok(words >= 60 && words <= 300, `${words} words`);
  }
  assert.equal(fs.existsSync(fixtureFile("edge", "fieldnotes.json")), false);
  assert.deepEqual(normFieldNotes(null).notes, []);
  assert.equal(FIELD_NOTES_EMPTY, "No field notes yet: the first one comes about 20 minutes into a run.");
});
