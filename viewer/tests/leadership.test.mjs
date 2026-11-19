// Leadership on the families page: normalisation, tree building (roots, nesting, Eves, cycles), rows, empty state, fixtures.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { normLeadership } from "../src/data/normalize.ts";
import { buildLeadershipTree, COMPACT_AT, LEADERSHIP_EMPTY, leadershipRows, unattachedLine } from "../src/site/leadership.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixtureFile = (name, file) => path.join(HERE, "..", "fixtures", name, file);

const person = (id, name, o = {}) => ({ id, name, age: 30, female: true, isEve: false, family: name?.split(" ").pop() ?? null, alive: true, lifeId: null, flower: null, ...o });
const resp = (people, edges) => ({ runId: "r", at: 1, people, edges: edges.map(([follower, leader]) => ({ follower, leader })) });
const names = (rows) => rows.map((r) => (r.kind === "person" ? r.prefix + r.person.name : r.prefix + r.people.map((p) => p.name).join(", ")));

test("normLeadership: drops malformed and dead people, edges to unknown people and self-follows; canonical flowers", () => {
  const r = normLeadership({
    runId: "run1",
    at: 5,
    people: [
      { id: 1, name: " AURORA WILLOWHOLLOW ", age: 40, female: true, isEve: true, family: "WILLOWHOLLOW", alive: true, flower: { shape: "rose", color: "red", label: "red rose" } },
      { id: 2, name: "WREN THORNDALE", age: "x", isEve: "yes" },
      { id: 2, name: "DUPLICATE" },
      { id: 3, name: "GONE", alive: false },
      { id: 1.5, name: "BAD ID" },
      "junk",
    ],
    edges: [{ follower: 2, leader: 1 }, { follower: 3, leader: 1 }, { follower: 1, leader: 1 }, { follower: 2, leader: 9 }, { follower: "2", leader: 1 }, null],
  });
  assert.equal(r.runId, "run1");
  assert.deepEqual(r.people.map((p) => [p.id, p.name, p.age, p.isEve]), [[1, "AURORA WILLOWHOLLOW", 40, true], [2, "WREN THORNDALE", 0, false]]);
  assert.equal(r.people[1].flower, null);
  assert.deepEqual(r.edges, [{ follower: 2, leader: 1 }]);
  assert.deepEqual(normLeadership(null), { runId: "", at: 0, edges: [], people: [] });
});

test("buildLeadershipTree: roots lead someone and follow nobody; nesting; people outside are counted", () => {
  const people = [
    person(1, "AURORA WILLOWHOLLOW", { isEve: true }),
    person(2, "WREN THORNDALE", { isEve: true }),
    person(3, "EMBER THORNDALE"),
    person(4, "IVY THORNDALE"),
    person(5, "MOSS WILLOWHOLLOW"),
    person(6, "SOLO ONE"),
    person(7, "SOLO TWO"),
    person(8, "BIRCH OAKS", { isEve: true }),
    person(9, "FERN OAKS"),
  ];
  const t = buildLeadershipTree(resp(people, [[2, 1], [3, 2], [4, 2], [5, 1], [9, 8]]));
  assert.deepEqual(t.roots.map((r) => r.person.id), [1, 8]); // biggest group first
  assert.equal(t.roots[0].size, 4);
  assert.equal(t.roots[0].children[0].person.name, "WREN THORNDALE");
  assert.equal(t.roots[0].children[0].person.isEve, true); // the Eve badge's data
  assert.deepEqual(t.roots[0].children[0].children.map((c) => c.person.name), ["EMBER THORNDALE", "IVY THORNDALE"]);
  assert.equal(t.unattached, 2);
  assert.deepEqual(names(leadershipRows(t.roots)), [
    "AURORA WILLOWHOLLOW",
    "├── WREN THORNDALE",
    "│   ├── EMBER THORNDALE",
    "│   └── IVY THORNDALE",
    "└── MOSS WILLOWHOLLOW",
    "BIRCH OAKS",
    "└── FERN OAKS",
  ]);
  assert.equal(unattachedLine(t.unattached), "2 people follow no one");
  assert.equal(unattachedLine(1), "1 person follows no one");
  assert.equal(unattachedLine(0), "");
});

test("buildLeadershipTree: a cycle still shows everyone once, rooted at its lowest id", () => {
  const people = [person(1, "A A"), person(2, "B B"), person(3, "C C"), person(4, "D D"), person(5, "E E")];
  // 1 -> 2 -> 3 -> 1, 4 follows 3; 5 is outside
  const t = buildLeadershipTree(resp(people, [[1, 2], [2, 3], [3, 1], [4, 3]]));
  assert.deepEqual(names(leadershipRows(t.roots)), ["A A", "└── C C", "    ├── B B", "    └── D D"]);
  assert.equal(t.unattached, 1);
  // a two-person loop, and a self-follow (ignored)
  const t2 = buildLeadershipTree(resp([person(7, "X X"), person(8, "Y Y")], [[7, 8], [8, 7], [7, 7]]));
  assert.equal(leadershipRows(t2.roots).length, 2);
});

test("leadershipRows: 10+ direct followers -> the ones who lead nobody as one comma list, sub-leaders still nested", () => {
  const people = [person(1, "BIG BOSS")];
  const edges = [];
  for (let i = 0; i < COMPACT_AT; i++) {
    people.push(person(10 + i, `F${String(i).padStart(2, "0")} X`));
    edges.push([10 + i, 1]);
  }
  people.push(person(99, "SUB FOLLOWER"));
  edges.push([99, 10]);
  const rows = leadershipRows(buildLeadershipTree(resp(people, edges)).roots);
  assert.equal(rows.length, 4);
  assert.deepEqual(names(rows).slice(0, 3), ["BIG BOSS", "├── F00 X", "│   └── SUB FOLLOWER"]);
  assert.equal(rows[3].kind, "list");
  assert.equal(rows[3].prefix, "└── ");
  assert.equal(rows[3].people.length, COMPACT_AT - 1);
  // 9 followers: one row each
  assert.equal(leadershipRows(buildLeadershipTree(resp(people.slice(0, 10), edges.slice(0, 9))).roots).length, 10);
});

test("empty state: no data or nobody leading -> no rows, and the message", () => {
  assert.equal(LEADERSHIP_EMPTY, 'Nobody leads anyone yet. People become followers by saying "I FOLLOW YOU".');
  assert.deepEqual(buildLeadershipTree(null), { roots: [], unattached: 0 });
  const t = buildLeadershipTree(resp([person(1, "A A"), person(2, "B B")], []));
  assert.deepEqual(leadershipRows(t.roots), []);
  assert.equal(t.unattached, 2);
});

test("fixtures: live1 has a chain of two (an Eve leads), one person outside; edge has none -> empty", () => {
  const fx = normLeadership(JSON.parse(fs.readFileSync(fixtureFile("live1", "leadership.json"), "utf8")));
  const t = buildLeadershipTree(fx);
  assert.deepEqual(names(leadershipRows(t.roots)), ["EVE DAWOD", "└── DAWN HOPE", "    └── JOY HOPE"]);
  assert.equal(t.roots[0].person.isEve, true);
  assert.equal(t.unattached, 1);
  assert.equal(fs.existsSync(fixtureFile("edge", "leadership.json")), false);
  assert.deepEqual(buildLeadershipTree(normLeadership(null)).roots, []);
});
