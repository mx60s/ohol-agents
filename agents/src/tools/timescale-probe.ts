// Measures the game clock against the wall clock on a live server (no LLM):
// age rate (server-reported ages over wall time), food pip interval and
// walking speed (tiles per wall second), plus the rates the server reports.
// Used to verify TIME_SCALE (server/patches/time-scale.patch).
//
// Usage: npx tsx src/tools/timescale-probe.ts [host] [port] [seconds]
import { Connection } from "../protocol/connection.ts";
import { parseMessage } from "../protocol/messages.ts";
import type { PlayerUpdate } from "../protocol/types.ts";
import { GameData } from "../game/gameData.ts";
import { World } from "../game/world.ts";

const [host = "127.0.0.1", port = "8005", secs = "60"] = process.argv.slice(2);
const runMs = Number(secs) * 1000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const gd = new GameData();
const world = new World(gd);
const conn = new Connection({ host, port: Number(port), email: `tsprobe${Date.now()}@test.local` });
const t0 = Date.now();
const ages: { t: number; age: number }[] = [];
const food: { t: number; food: number }[] = [];
const reported = { ageRate: 0, moveSpeed: 0, foodTime: 0, pmTotalPerTile: [] as number[] };
let selfUpdates: PlayerUpdate[] = [];
let closed = false;

conn.on("message", (raw) => {
  const m = parseMessage(raw);
  world.handle(m);
  const now = Date.now();
  if (m.type === "PU" && world.selfId != null) {
    for (const u of m.updates) if (u.id === world.selfId && u.x != null) {
      ages.push({ t: now, age: u.age });
      reported.ageRate = u.ageRate;
      reported.moveSpeed = u.moveSpeed;
      selfUpdates.push(u);
    }
  } else if (m.type === "FX") {
    food.push({ t: now, food: m.food.food });
  } else if (m.type === "HX") {
    reported.foodTime = m.heat.foodTime;
  } else if (m.type === "PM") {
    for (const mv of m.moves) if (mv.id === world.selfId && mv.path.length) reported.pmTotalPerTile.push(mv.totalSec / mv.path.length);
  }
});
conn.on("close", () => (closed = true));

console.log("login:", await conn.connect());
await sleep(2000);

let seq = 1;
/** walk n tiles in a straight line (first walkable direction); returns tiles per wall second */
async function walk(n: number): Promise<number | null> {
  const s = world.self;
  if (!s) return null;
  if (world.forcedPos) {
    conn.send(`FORCE ${world.forcedPos[0]} ${world.forcedPos[1]}`);
    world.forcedPos = null;
  }
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    let ok = true;
    for (let i = 1; i <= n; i++) if (!world.walkable(s.x + dx * i, s.y + dy * i)) ok = false;
    if (!ok) continue;
    seq++;
    const deltas = Array.from({ length: n }, (_, i) => `${dx * (i + 1)} ${dy * (i + 1)}`).join(" ");
    const start = Date.now();
    conn.send(`MOVE ${s.x} ${s.y} @${seq} ${deltas}`);
    while (Date.now() - start < 60_000) {
      await sleep(20);
      if (world.doneMovingSeq >= seq) return n / ((Date.now() - start) / 1000);
      if (world.forcedPos) return null;
    }
    return null;
  }
  return null;
}

const speeds: number[] = [];
const walkEvery = Math.max(10_000, runMs / 4);
let nextWalk = 0;
while (Date.now() - t0 < runMs && !closed && !world.dead) {
  if (Date.now() - t0 >= nextWalk) {
    const v = await walk(6);
    if (v) speeds.push(v);
    nextWalk += walkEvery;
  }
  await sleep(200);
}

// age rate from server-reported ages (first vs last PU)
const a0 = ages[0], a1 = ages[ages.length - 1];
const wallSecPerYear = a0 && a1 && a1.age > a0.age ? (a1.t - a0.t) / 1000 / (a1.age - a0.age) : NaN;
// food pip interval: time between consecutive decrements
const drops: number[] = [];
for (let i = 1; i < food.length; i++) if (food[i].food === food[i - 1].food - 1) drops.push(food[i].t);
const pipIntervals = drops.slice(1).map((t, i) => (t - drops[i]) / 1000);
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

console.log(JSON.stringify({
  wallSeconds: Math.round((Date.now() - t0) / 1000),
  connectionAlive: !closed && !world.dead,
  dead: world.dead, deathReason: world.deathReason,
  measured: {
    wallSecPerYear: +wallSecPerYear.toFixed(2),
    agePoints: ages.length, ageSpan: a0 && a1 ? [a0.age, a1.age] : null,
    foodPipIntervalSec: +mean(pipIntervals).toFixed(2), pipIntervals: pipIntervals.map((x) => +x.toFixed(2)),
    tilesPerWallSec: +mean(speeds).toFixed(3), walks: speeds.map((x) => +x.toFixed(3)),
  },
  reported: {
    ageRateSecPerYear: reported.ageRate, moveSpeed: reported.moveSpeed, foodTimeSec: reported.foodTime,
    pmSecPerTile: reported.pmTotalPerTile.map((x) => +x.toFixed(3)),
  },
}, null, 2));
conn.close();
process.exit(0);
