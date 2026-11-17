// Client half of server/tools/turn-clock-test.sh (run it from there).
// Logs in one fake agent to a TURN_CLOCK=1 server and checks, while the
// clock is paused: login works, SAY is heard (twice, 1.5 s apart), a walk
// does not progress, the client stays connected through a long pause; and
// that the walk finishes only once the clock runs again, without a jump.
//
// Usage: tsx server/tools/turn-clock-client.mts <host> <port> <runDir> [pauseSeconds]
// Prints one JSON line of results; exit code 1 if a check failed.
import fs from "node:fs";
import path from "node:path";
import { Connection } from "../../agents/src/protocol/connection.ts";
import { parseMessage } from "../../agents/src/protocol/messages.ts";

const [host = "127.0.0.1", port = "8005", runDir = ".", pauseArg = "30"] = process.argv.slice(2);
const pauseS = Number(pauseArg);
const nowFile = path.join(runDir, "mtsClockNow.txt");
const targetFile = path.join(runDir, "mtsClockTarget.txt");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function readNow(): { g: number; paused: boolean } {
  const [g, p] = fs.readFileSync(nowFile, "utf8").trim().split(/\s+/);
  return { g: Number(g), paused: p === "1" };
}
function setTarget(t: number) {
  fs.writeFileSync(targetFile + ".tmp", t.toFixed(3));
  fs.renameSync(targetFile + ".tmp", targetFile);
}
/** waits until the server reports it is paused at (or past) the target */
async function waitHeldAt(target: number, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const n = readNow();
    if (n.paused && n.g >= target - 0.001) return true;
    await sleep(20);
  }
  return false;
}

const res: Record<string, unknown> = {};
const fail: string[] = [];
const check = (ok: boolean, what: string) => { if (!ok) fail.push(what); };

let selfId: number | null = null;
let firstPU = true;
let pos: [number, number] | null = null;
const arrivals: { at: number; x: number | null; y: number | null; seq: number }[] = [];
const heard: { at: number; text: string }[] = [];
let myMove: { at: number; totalSec: number; path: [number, number][] } | null = null;
let closedAt = 0;
let moveSeq = -1; // seq of the MOVE we sent; done_moving echoes it

const conn = new Connection({ host, port: Number(port), email: `turnclock${Date.now()}@test.local` });
conn.on("close", () => { closedAt = Date.now(); });
conn.on("message", (raw) => {
  const m = parseMessage(raw);
  if (m.type === "PU") {
    if (firstPU && m.updates.length && selfId == null) selfId = m.updates[m.updates.length - 1].id;
    firstPU = false;
    for (const u of m.updates) {
      if (u.id !== selfId) continue;
      if (pos == null && u.x != null && u.y != null) pos = [u.x, u.y];
      if (moveSeq > 0 && u.doneMovingSeq === moveSeq) arrivals.push({ at: Date.now(), x: u.x, y: u.y, seq: u.doneMovingSeq });
    }
  } else if (m.type === "PS") {
    for (const s of m.says) if (s.id === selfId) heard.push({ at: Date.now(), text: s.text });
  } else if (m.type === "PM") {
    for (const mv of m.moves) if (mv.id === selfId) myMove = { at: Date.now(), totalSec: mv.totalSec, path: mv.path };
  }
});

try {
  check(readNow().paused, "clock not paused before login");
  res.login = await conn.connect();
  await sleep(2000);
  check(selfId != null && pos != null, "no self PU after login");
  res.self = { id: selfId, pos };
  const g0 = readNow().g;

  // speech while paused, twice (flood gap is 1 wall s in turn mode)
  conn.send("SAY 0 0 HELLO PAUSED");
  await sleep(1500);
  conn.send("SAY 0 0 SECOND LINE");
  await sleep(1000);
  res.heardWhilePaused = heard.map((h) => h.text);
  check(heard.length === 2, `heard ${heard.length}/2 lines while paused`);

  // walk while paused: try a few directions until the server accepts one
  const dirs: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  let seq = 2;
  for (const [dx, dy] of dirs) {
    const steps = Array.from({ length: 8 }, (_, i) => `${dx * (i + 1)} ${dy * (i + 1)}`).join(" ");
    moveSeq = seq;
    conn.send(`MOVE ${pos![0]} ${pos![1]} @${seq} ${steps}`);
    await sleep(800);
    if (myMove) break;
    seq++;
  }
  check(myMove != null, "no PM for our walk");
  if (!myMove) throw new Error("walk not accepted");
  const mv = myMove as { at: number; totalSec: number; path: [number, number][] };
  res.walk = { tiles: mv.path.length, totalSec: mv.totalSec };

  // long pause: connected, not arriving, clock unchanged
  await sleep(pauseS * 1000);
  const n1 = readNow();
  res.pauseSeconds = pauseS;
  res.clockMovedDuringPause = n1.g - g0;
  check(n1.paused && n1.g === g0, "clock moved during pause");
  check(closedAt === 0, "disconnected during pause");
  check(arrivals.length === 0, "walk finished while paused");

  // run half the walk, then pause again
  const half = mv.totalSec / 2;
  const tRun1 = Date.now();
  setTarget(n1.g + half);
  check(await waitHeldAt(n1.g + half, 5000 + half * 1000), "clock did not stop after half walk");
  const n2 = readNow();
  res.halfRunWallS = (Date.now() - tRun1) / 1000;
  await sleep(3000);
  check(arrivals.length === 0, "walk finished after only half its time");

  // run the rest: arrival should come ~half a walk after resuming
  const tRun2 = Date.now();
  const t3 = n2.g + mv.totalSec + 1;
  setTarget(t3);
  const end = Date.now() + (mv.totalSec + 5) * 1000;
  while (arrivals.length === 0 && Date.now() < end) await sleep(20);
  check(arrivals.length > 0, "walk never finished after resume");
  if (arrivals.length) {
    const a = arrivals[0];
    const dest = mv.path[mv.path.length - 1];
    res.arrivalAfterResumeS = (a.at - tRun2) / 1000;
    res.expectedAfterResumeS = mv.totalSec - half;
    res.arrivedAt = [a.x, a.y];
    check(a.x === dest[0] && a.y === dest[1], "arrived somewhere else");
    check(Math.abs((a.at - tRun2) / 1000 - (mv.totalSec - half)) < 0.6, "arrival time off after resume");
  }
  await waitHeldAt(t3, 5000);
  check(closedAt === 0, "disconnected at the end");
} catch (e) {
  fail.push(String(e));
}
res.fail = fail;
console.log(JSON.stringify(res));
conn.close();
process.exit(fail.length ? 1 : 0);
