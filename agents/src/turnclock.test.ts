// TurnCoordinator against a fake server clock and fake agents (docs/turn-clock.md).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { FileClockPort, TurnCoordinator, parseClockNow, type TurnAgent, type TurnLink, type TurnStatus } from "./turnclock.ts";
import { FakeClockPort } from "./game/fakeClock.ts";
import { turnClock, turnsFor, turnsText, turnsAgo } from "./agent/turns.ts";
import { craftBudgetMs } from "./game/craft.ts";
import { buildSystemPrompt } from "./agent/prompt.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

class FakeAgent implements TurnAgent<string> {
  status: TurnStatus = { ready: true, life: 1, baby: false, news: false };
  decideMs = 2;
  /** turn numbers of each decision / act / tooSlow */
  decided: number[] = [];
  acted: number[] = [];
  slow: number[] = [];
  /** was the clock paused when the model was called? */
  pausedAtDecide: boolean[] = [];
  link!: TurnLink;
  hang = false;
  act: (plan: string) => Promise<void> = async () => {};
  constructor(readonly id: string, private h: Harness) {}
  turnStatus() {
    return { ...this.status };
  }
  async decideTurn() {
    this.decided.push(this.h.coord.n);
    this.pausedAtDecide.push(this.h.port.paused);
    if (this.hang) await new Promise(() => {});
    await sleep(this.decideMs);
    return `plan-${this.h.coord.n}`;
  }
  async actTurn(plan: string) {
    this.acted.push(this.h.coord.n);
    await this.act(plan);
  }
  tooSlow() {
    this.slow.push(this.h.coord.n);
  }
}

interface Harness {
  port: FakeClockPort;
  coord: TurnCoordinator;
  agents: FakeAgent[];
  warnings: string[];
  add(id: string): FakeAgent;
  until(pred: () => boolean, ms?: number): Promise<void>;
}

/** 2.4 game s per turn at 200 game s per wall s: a 12 ms act window */
function harness(o: { decideTimeoutMs?: number; babyIdleTurns?: number; paused?: () => boolean; onActEnd?: (n: number, gameTime: number | null) => void } = {}): Harness {
  const port = new FakeClockPort(1000, 200);
  const agents: FakeAgent[] = [];
  const warnings: string[] = [];
  const coord = new TurnCoordinator(port, () => agents, {
    turnGameS: 2.4, timeScale: 1, decideTimeoutMs: o.decideTimeoutMs ?? 150, babyIdleTurns: o.babyIdleTurns ?? 4,
    pollMs: 2, idleMs: 5, paused: o.paused, warn: (t) => warnings.push(t), onActEnd: o.onActEnd,
  });
  const h: Harness = {
    port, coord, agents, warnings,
    add(id) {
      const a = new FakeAgent(id, h);
      a.link = coord.link();
      agents.push(a);
      return a;
    },
    async until(pred, ms = 3000) {
      const end = Date.now() + ms;
      while (!pred()) {
        if (Date.now() > end) throw new Error("timed out waiting");
        await sleep(2);
      }
    },
  };
  return h;
}

test("parseClockNow reads '<gameTime> <paused>'", () => {
  assert.deepEqual(parseClockNow("1234.5 1\n"), { gameTime: 1234.5, paused: true });
  assert.deepEqual(parseClockNow("17 0"), { gameTime: 17, paused: false });
  assert.equal(parseClockNow(""), null);
  assert.equal(parseClockNow("12.5"), null);
  assert.equal(parseClockNow("x 1"), null);
});

test("FileClockPort writes the target atomically and reads the server's report", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "clock-"));
  try {
    const p = new FileClockPort(dir);
    assert.equal(p.read(), null);
    p.writeTarget(1002.4);
    assert.equal(readFileSync(path.join(dir, "mtsClockTarget.txt"), "utf8").trim(), "1002.400");
    writeFileSync(path.join(dir, "mtsClockNow.txt"), "1001.25 0\n");
    assert.deepEqual(p.read(), { gameTime: 1001.25, paused: false });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("every agent decides while the world is frozen, then all act; the target rises by TURN_GAME_S per turn", async () => {
  const h = harness();
  const a = h.add("a"), b = h.add("b"), c = h.add("c");
  b.decideMs = 20;
  h.coord.start();
  await h.until(() => h.coord.n >= 4);
  await h.coord.stop();
  for (const x of [a, b, c]) {
    assert.ok(x.decided.length >= 3);
    assert.ok(x.pausedAtDecide.every((p) => p), "clock paused while thinking");
    // acted in the turn it decided, after everyone decided
    for (const t of x.decided.slice(0, 3)) assert.ok(x.acted.includes(t));
  }
  const w = h.port.writes;
  assert.ok(w.length >= 3);
  for (let i = 1; i < w.length; i++) assert.ok(Math.abs(w[i] - w[i - 1] - 2.4) < 1e-6, `step ${w[i] - w[i - 1]}`);
  assert.equal(w[0], 1002.4);
});

test("onActEnd runs once after each act window with the turn and the game time reached (positions.jsonl)", async () => {
  const ends: [number, number | null][] = [];
  const h = harness({ onActEnd: (n, g) => ends.push([n, g]) });
  h.add("a");
  h.coord.start();
  await h.until(() => ends.length >= 3);
  await h.coord.stop();
  assert.deepEqual(ends.slice(0, 3).map((e) => e[0]), [1, 2, 3]);
  for (const [n, g] of ends.slice(0, 3)) assert.ok(g != null && Math.abs(g - (1000 + 2.4 * n)) < 0.01, `turn ${n}: ${g}`);
});

test("a slow agent times out: its reply is dropped, it is told so, and it isn't asked again while still thinking", async () => {
  const h = harness({ decideTimeoutMs: 40 });
  const fast = h.add("fast");
  const slow = h.add("slow");
  slow.decideMs = 120;
  h.coord.start();
  await h.until(() => h.coord.n >= 4);
  await h.coord.stop();
  assert.equal(slow.slow[0], 1);
  assert.ok(!slow.acted.includes(1), "late plan not acted on");
  // turn 2 was not held up by it: it was still thinking, so it was skipped
  assert.ok(!slow.decided.includes(2));
  assert.ok(fast.decided.includes(2) && fast.acted.includes(2));
});

test("a busy walker skips decide phases until its action list finishes", async () => {
  const h = harness();
  const walker = h.add("walker");
  const other = h.add("other");
  let first = true;
  walker.act = async () => {
    if (!first) return;
    first = false;
    // a walk that needs 3 act windows (7.2 game s)
    const until = h.port.gameTime + 7;
    while (h.port.gameTime < until) {
      await sleep(2);
      await walker.link.actWindow();
    }
  };
  h.coord.start();
  await h.until(() => h.coord.n >= 7);
  await h.coord.stop();
  assert.equal(walker.decided[0], 1);
  // walking through turns 2..3 at least: no decisions then
  assert.ok(walker.decided[1] >= 4, `next decision at turn ${walker.decided[1]}`);
  assert.ok(other.decided.includes(2) && other.decided.includes(3));
});

test("wait 3 skips exactly 3 decide phases", async () => {
  const h = harness();
  const a = h.add("a");
  h.add("b");
  let waited: number | null = null;
  a.act = async () => {
    if (waited == null) waited = await a.link.turns(3, () => false);
  };
  h.coord.start();
  await h.until(() => h.coord.n >= 7);
  await h.coord.stop();
  assert.equal(waited, 3);
  assert.deepEqual(a.decided.slice(0, 2), [1, 5]);
});

test("wait ends early at a decide phase when something salient happened", async () => {
  const h = harness();
  const a = h.add("a");
  let news = false;
  let waited: number | null = null;
  a.act = async () => {
    if (waited == null) waited = await a.link.turns(4, () => news);
  };
  h.coord.start();
  await h.until(() => h.coord.n >= 2);
  news = true;
  await h.until(() => waited != null);
  await h.until(() => a.decided.length >= 2);
  await h.coord.stop();
  assert.ok(waited! < 4);
  assert.ok(a.decided[1] <= 4);
});

test("an agent dying mid-decide doesn't hold up the turn", async () => {
  const h = harness({ decideTimeoutMs: 5000 });
  const a = h.add("a");
  const dying = h.add("dying");
  dying.hang = true;
  h.coord.start();
  await h.until(() => dying.decided.length === 1);
  const t0 = Date.now();
  dying.status = { ...dying.status, ready: false };
  await h.until(() => a.acted.includes(1));
  assert.ok(Date.now() - t0 < 1000, "turn went on without waiting for the timeout");
  await h.until(() => h.coord.n >= 3);
  await h.coord.stop();
  assert.deepEqual(dying.slow, []);
  assert.deepEqual(dying.decided, [1]);
});

test("a login mid-turn joins at the next decide phase; a new life isn't blocked by the old one's work", async () => {
  const h = harness();
  const a = h.add("a");
  const late = h.add("late");
  late.status = { ...late.status, ready: false };
  let hold = true;
  late.act = async () => {
    while (hold) await sleep(2);
  };
  h.coord.start();
  await h.until(() => h.coord.n >= 2);
  late.status = { ...late.status, ready: true };
  await h.until(() => late.decided.length === 1);
  assert.ok(late.decided[0] > 2);
  // stuck in its action list; then it dies and logs in again (a new life)
  await h.until(() => late.acted.length === 1);
  const stuckAt = h.coord.n;
  await h.until(() => h.coord.n >= stuckAt + 2);
  assert.equal(late.decided.length, 1, "busy: skipped");
  late.status = { ...late.status, life: 2 };
  await h.until(() => late.decided.length === 2);
  hold = false;
  await h.coord.stop();
  assert.ok(a.decided.length >= 3);
});

test("nobody to play: no turns, the clock stays paused", async () => {
  const h = harness();
  const a = h.add("a");
  a.status = { ...a.status, ready: false };
  h.coord.start();
  await sleep(60);
  assert.deepEqual(h.port.writes, []);
  assert.equal(h.coord.info().phase, "idle");
  assert.ok(h.port.paused);
  // the run is paused (outage, daily cap): same
  const paused = true;
  const h2 = harness({ paused: () => paused });
  h2.add("b");
  h2.coord.start();
  await sleep(40);
  assert.deepEqual(h2.port.writes, []);
  await h.coord.stop();
  await h2.coord.stop();
});

test("babies decide on salient events, else every BABY_IDLE_TURNS turns", async () => {
  const h = harness({ babyIdleTurns: 4 });
  const baby = h.add("baby");
  baby.status = { ...baby.status, baby: true };
  h.add("adult");
  h.coord.start();
  await h.until(() => h.coord.n >= 9);
  assert.deepEqual(baby.decided.slice(0, 3), [1, 5, 9]);
  baby.status = { ...baby.status, news: true };
  const n = h.coord.n;
  await h.until(() => h.coord.n >= n + 2);
  await h.coord.stop();
  assert.ok(baby.decided.some((t) => t > n && t < n + 3), "salient event: decides at once");
});

test("stop leaves the clock paused at the last target and writes nothing more", async () => {
  const h = harness();
  h.add("a");
  h.coord.start();
  await h.until(() => h.coord.n >= 3 && h.coord.phase === "act");
  await h.coord.stop();
  assert.deepEqual(h.agents[0].slow, [], "nobody is told they were too slow because we stopped");
  const writes = h.port.writes.length;
  const last = h.port.writes[writes - 1];
  await sleep(40);
  assert.equal(h.port.writes.length, writes);
  assert.ok(h.port.paused);
  assert.equal(h.port.gameTime, last);
});

test("server clock silent: one warning, no turns", async () => {
  const h = harness();
  h.port.reporting = false;
  h.add("a");
  h.coord.start();
  await sleep(40);
  await h.coord.stop();
  assert.equal(h.coord.n, 0);
  assert.equal(h.warnings.length, 1);
});

test("the game-paced clock stands (almost) still while paused and runs in act windows", async () => {
  const h = harness({ decideTimeoutMs: 1000 });
  const a = h.add("a");
  a.decideMs = 60;
  const link = h.coord.link();
  h.coord.start();
  await h.until(() => h.coord.phase === "decide" && a.decided.length === 1);
  const t0 = link.now();
  await sleep(40);
  const t1 = link.now();
  assert.ok(t1 - t0 < 2, `paused drift ${t1 - t0}`);
  assert.ok(t1 > t0, "strictly increasing");
  await h.until(() => h.coord.n >= 3);
  await h.coord.stop();
  // two act windows of 2.4 game s at k = 1 -> ~4800 ms on the game-paced clock
  const t2 = link.now();
  assert.ok(t2 - t1 > 4000 && t2 - t1 < 8000, `ran ${t2 - t1}`);
});

test("turn units at TURN_GAME_S 2.4: a year is 25 turns, at any TIME_SCALE", () => {
  for (const k of [1, 3]) {
    const clock = turnClock({ turnClock: true, turnGameS: 2.4, timeScale: k, decisionCycleMs: 8000 });
    assert.equal(clock.lockstep, true);
    assert.ok(Math.abs(turnsFor(60, clock) - 25) < 1e-9);
    assert.equal(turnsText(60, clock), "about 25 turns");
    assert.equal(turnsText(2.4, clock), "1 turn");
    // the game-paced clock runs 2.4 * k s per turn
    assert.equal(turnsAgo(0, 2 * 2400 * k, clock), "2 turns ago");
    // craft budget: at least 30 game s (12.5 turns) on the game-paced clock
    assert.equal(craftBudgetMs(clock.turnGameMs ?? clock.cycleMs, k), 30_000 * k);
    const prompt = buildSystemPrompt(clock, { craft: false, actionListMax: 4, foodBonusS: 18, baseline: "new" });
    assert.match(prompt, /A year passes every 25 turns\./);
  }
  // off: unchanged
  assert.deepEqual(turnClock({ decisionCycleMs: 8000, timeScale: 1, turnGameS: 2.4 }), { cycleMs: 8000, timeScale: 1 });
});
