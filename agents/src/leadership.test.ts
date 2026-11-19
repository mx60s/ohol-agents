import assert from "node:assert/strict";
import test from "node:test";
import { GameData } from "./game/gameData.ts";
import { World } from "./game/world.ts";
import { buildLeadership, familyOf, mergeLeadership, type LeaderPlayer, type LeaderView } from "./leadership.ts";

const all = () => true;
/** a view from [follower, leader | null, receivedAt] reports */
const reports = (...rs: [number, number | null, number][]) => ({
  leaders: new Map(rs.filter((r) => r[1] != null).map((r) => [r[0], r[1]!] as [number, number])),
  leaderSeen: new Map(rs.map((r) => [r[0], r[2]] as [number, number])),
});

test("World keeps when each FW arrived, also for 'follows no one'", () => {
  let t = 1000;
  const w = new World(new GameData(), {}, () => t);
  w.handle({ type: "FW", follows: [{ followerId: 2, leaderId: 1, colorIndex: 0 }] });
  t = 2000;
  w.handle({ type: "FW", follows: [{ followerId: 3, leaderId: -1, colorIndex: 0 }] });
  assert.deepEqual([...w.leaders], [[2, 1]]);
  assert.deepEqual([...w.leaderSeen], [[2, 1000], [3, 2000]]);
});

test("mergeLeadership: the most recently received report about a follower wins, including 'follows no one'", () => {
  const a = reports([2, 1, 100], [3, 1, 300], [4, 1, 100]);
  const b = reports([2, 5, 200], [3, null, 200], [4, null, 50]);
  // 2: b is newer (follows 5); 3: a is newer (follows 1); 4: a is newer (follows 1)
  assert.deepEqual(mergeLeadership([a, b], all), [
    { follower: 2, leader: 5 },
    { follower: 3, leader: 1 },
    { follower: 4, leader: 1 },
  ]);
  // b says 4 follows no one, newer than a
  assert.deepEqual(mergeLeadership([a, reports([4, null, 500])], all).map((e) => e.follower), [2, 3]);
  // order of views doesn't matter
  assert.deepEqual(mergeLeadership([b, a], all), mergeLeadership([a, b], all));
});

test("mergeLeadership: drops edges whose ends are dead, and self-follows", () => {
  const v = reports([2, 1, 1], [3, 2, 1], [4, 9, 1], [5, 5, 1]);
  const alive = (id: number) => id !== 9 && id !== 1;
  assert.deepEqual(mergeLeadership([v], alive), [{ follower: 3, leader: 2 }]);
});

test("mergeLeadership: a cycle is broken at its least recently reported edge", () => {
  // 1 -> 2 -> 3 -> 1 (3 -> 1 is the oldest), and 4 -> 1 hanging off it
  const v = reports([1, 2, 30], [2, 3, 20], [3, 1, 10], [4, 1, 40]);
  const edges = mergeLeadership([v], all);
  assert.deepEqual(edges, [
    { follower: 1, leader: 2 },
    { follower: 2, leader: 3 },
    { follower: 4, leader: 1 },
  ]);
  // two-person cycle across views
  assert.deepEqual(mergeLeadership([reports([1, 2, 5]), reports([2, 1, 7])], all), [{ follower: 2, leader: 1 }]);
});

test("familyOf: the surname", () => {
  assert.equal(familyOf("AURORA WILLOWHOLLOW"), "WILLOWHOLLOW");
  assert.equal(familyOf("EVE"), null);
  assert.equal(familyOf(null), null);
});

type P = LeaderPlayer & { age: number };
const player = (id: number, name: string | null, age: number, lastSeen = 1, eveId: number | null = null): P => ({ id, name, female: true, lastSeen, eveId, age });
function view(o: { self: number; dead?: boolean; players: P[]; lineage?: [number, number[]][]; names?: [number, string][]; fw?: [number, number | null, number][] }): LeaderView<P> {
  const r = reports(...(o.fw ?? []));
  return {
    selfId: o.self,
    dead: o.dead ?? false,
    players: new Map(o.players.map((p) => [p.id, p])),
    names: new Map(o.names ?? []),
    lineage: new Map((o.lineage ?? []).map(([id, ancestors]) => [id, { ancestors }])),
    leaders: r.leaders,
    leaderSeen: r.leaderSeen,
    currentAge: (p) => p.age,
  };
}

test("buildLeadership: living people from every view (newest sighting), Eves, families, edges among the living", () => {
  const a = view({
    self: 1,
    players: [player(1, "AURORA WILLOWHOLLOW", 40.04), player(2, null, 20, 1), player(7, "GONE GIRL", 30)],
    names: [[2, "EMBER THORNDALE"]],
    lineage: [[1, []], [2, [3]]],
    fw: [[3, 1, 10], [2, 3, 10], [7, 1, 10]],
  });
  // b is dead: its own body isn't listed; it saw #2 more recently (older age reading wins by lastSeen)
  const b = view({ self: 7, dead: true, players: [player(7, "GONE GIRL", 30)] });
  const c = view({ self: 3, players: [player(3, "WREN THORNDALE", 35), player(2, "EMBER THORNDALE", 20.5, 5)], fw: [[2, 3, 20]] });
  const lives = {
    playerFields: (id: number) => (id === 3 ? { lifeId: "run1:3", flower: { shape: "rose", color: "red", label: "red rose" } } : { lifeId: null, flower: null }),
    generationOf: (id: number) => (id === 3 ? 1 : null),
  };
  const r = buildLeadership("run1", [a, c], lives, 99);
  assert.equal(r.runId, "run1");
  assert.equal(r.at, 99);
  assert.deepEqual(
    r.people.map((p) => [p.id, p.name, p.age, p.isEve, p.family, p.alive]),
    [
      [1, "AURORA WILLOWHOLLOW", 40, true, "WILLOWHOLLOW", true],
      [2, "EMBER THORNDALE", 20.5, false, "THORNDALE", true],
      [3, "WREN THORNDALE", 35, true, "THORNDALE", true], // no lineage seen: generation 1 from our records
      [7, "GONE GIRL", 30, false, "GIRL", true],
    ],
  );
  assert.equal(r.people[2].flower?.label, "red rose");
  assert.deepEqual(r.edges, [
    { follower: 2, leader: 3 },
    { follower: 3, leader: 1 },
    { follower: 7, leader: 1 },
  ]);
  // #7 dies (its agent's world is dead and nobody else sees it): its edge goes
  const a2 = view({ self: 1, players: [player(1, "AURORA WILLOWHOLLOW", 40)], fw: [[7, 1, 10], [3, 1, 10]] });
  const r2 = buildLeadership("run1", [a2, b, c], null, 0);
  assert.deepEqual(r2.people.map((p) => p.id), [1, 2, 3]);
  assert.deepEqual(r2.edges, [
    { follower: 2, leader: 3 },
    { follower: 3, leader: 1 },
  ]);
});

test("buildLeadership: nobody alive -> empty", () => {
  assert.deepEqual(buildLeadership("r", [], null, 1), { runId: "r", at: 1, edges: [], people: [] });
});
