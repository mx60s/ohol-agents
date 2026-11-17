// Starting setup (few Eves, staggered joins), respawn delays and paused logins,
// against a fake game server that follows the stock Eve/baby rules (no game, no LLM).
import { test } from "node:test";
import assert from "node:assert/strict";
import { LoginScheduler, BURST_BORN_TIMEOUT_MS, type LoginPlanConfig } from "./logins.ts";

/** Virtual time: sleep() timers fire only when the test advances the clock. */
class Clock {
  now = 1_000_000;
  private timers: { at: number; seq: number; fire: () => void }[] = [];
  private seq = 0;
  sleep = (ms: number) => new Promise<void>((r) => this.timers.push({ at: this.now + ms, seq: this.seq++, fire: r }));
  async flush() {
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  }
  /** run timers up to now + ms, in order, letting promise chains settle between them */
  async advance(ms: number) {
    const end = this.now + ms;
    await this.flush();
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
      const t = this.timers[0];
      if (!t || t.at > end) break;
      this.timers.shift();
      this.now = Math.max(this.now, t.at);
      t.fire();
      await this.flush();
    }
    this.now = end;
    await this.flush();
  }
}

/**
 * Stock processLoggedInPlayer, reduced to what decides Eve vs baby for our
 * accounts (separate emails, <= 10 players, no curses, no homelands):
 * pass 0 = fertile women (14-40) off cooldown with < 4 living kids; else, if
 * some are fertile, pass 1 ignores cooldown but forces an Eve when helpless
 * babies (< 3 y) / adults >= 1.0 or babies / fertile moms >= 1.0.
 */
class FakeServer {
  players: { agentId: string; female: boolean; bornAt: number; age0: number; cooldownUntil: number; kids: number }[] = [];
  log: { agentId: string; eve: boolean; mother: string | null }[] = [];
  constructor(private clock: Clock, private rnd: () => number, private yearMs = 60_000) {}
  age(p: FakeServer["players"][number]) {
    return p.age0 + (this.clock.now - p.bornAt) / this.yearMs;
  }
  login(agentId: string): { eve: boolean } {
    const now = this.clock.now;
    const fertile = this.players.filter((p) => p.female && this.age(p) >= 14 && this.age(p) <= 40);
    let moms = fertile.filter((p) => now >= p.cooldownUntil && p.kids < 4);
    if (!moms.length && fertile.length) {
      const babies = this.players.filter((p) => this.age(p) < 3).length;
      const adults = this.players.length - babies;
      if (babies / adults < 1 && babies / fertile.length < 1) moms = fertile;
    }
    const mom = moms.length ? moms[Math.floor(this.rnd() * moms.length)] : null;
    if (mom) {
      mom.kids++;
      mom.cooldownUntil = now + 300_000 * this.rnd();
    }
    this.players.push({ agentId, female: mom ? this.rnd() < 0.5 : true, bornAt: now, age0: mom ? 0 : 14, cooldownUntil: 0, kids: 0 });
    this.log.push({ agentId, eve: !mom, mother: mom?.agentId ?? null });
    return { eve: !mom };
  }
  /** what Population computes from our characters' ages: would a login now be born to a mother? */
  room = () => {
    const ages = this.players.map((p) => ({ p, age: this.age(p) }));
    const babies = ages.filter((a) => a.age < 3).length;
    const moms = ages.filter((a) => a.p.female && a.age >= 14 && a.age <= 40).length;
    return moms === 0 || (babies < moms && babies < ages.length - babies);
  };
}

function seeded(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

const plan = (over: Partial<LoginPlanConfig> = {}): LoginPlanConfig => ({
  agentCount: 8, initialEves: 2, joinStaggerMs: 90_000, joinJitter: 0.3, respawnDelayMinMs: 30_000, respawnDelayMaxMs: 90_000, ...over,
});

/** start every slot like Population does; the fake server answers each login after a 600 ms handshake */
function startSlots(sched: LoginScheduler, server: FakeServer, clock: Clock, n: number) {
  const ids = Array.from({ length: n }, (_, i) => `a${String(i + 1).padStart(2, "0")}`);
  for (const id of ids)
    void sched.beforeLogin(id, true).then(async () => {
      await clock.sleep(600);
      sched.onBorn(id, server.login(id).eve);
    });
  return ids;
}

for (const n of [1, 2, 3, 4]) {
  test(`starting setup: ${n} Eve(s) from a quick burst, then everyone else joins as babies`, async () => {
    const clock = new Clock();
    const rnd = seeded(n * 7);
    const sched = new LoginScheduler(plan({ initialEves: n, agentCount: 10 }), { now: () => clock.now, sleep: clock.sleep, random: rnd, familyRoom: () => server.room() });
    const server = new FakeServer(clock, rnd);
    startSlots(sched, server, clock, 10);
    await clock.advance(60_000);
    const eves = server.log.filter((l) => l.eve).length;
    assert.equal(eves, n, `burst gave ${n} Eves: ${JSON.stringify(server.log)}`);
    // Eve, baby, Eve, baby, ... : 2n-1 logins
    assert.equal(server.log.length, 2 * n - 1);
    assert.deepEqual(server.log.map((l) => l.eve), Array.from({ length: 2 * n - 1 }, (_, i) => i % 2 === 0));
    assert.ok(sched.admissions.slice(0, 2 * n - 1).every((a) => a.phase === "burst"));
    // the rest join one at a time, JOIN_STAGGER_S +- 30% apart, all born to mothers
    await clock.advance(40 * 60_000);
    assert.equal(server.log.length, 10);
    assert.equal(server.log.filter((l) => l.eve).length, n, `no extra Eves from staggered joins: ${JSON.stringify(server.log)}`);
    const joins = sched.admissions.filter((a) => a.phase === "join");
    assert.equal(joins.length, 10 - (2 * n - 1));
    const gaps = sched.admissions.slice(2 * n - 2).map((a, i, arr) => (i ? a.at - arr[i - 1].at : null)).filter((g): g is number => g != null);
    // at least the jittered stagger; longer when the family had no room (waits in 5 s polls)
    for (const g of gaps) assert.ok(g >= 63_000 - 1, `join gap ${g}`);
  });
}

test("starting setup: leftover fertile women absorb the burst -> the burst stops after 2N+1 logins", async () => {
  const clock = new Clock();
  const rnd = seeded(3);
  const sched = new LoginScheduler(plan({ initialEves: 2, agentCount: 10 }), { now: () => clock.now, sleep: clock.sleep, random: rnd });
  const server = new FakeServer(clock, rnd);
  // many adult women from an abandoned run, all fertile and off cooldown
  for (let i = 0; i < 12; i++) server.players.push({ agentId: `old${i}`, female: true, bornAt: clock.now, age0: 20, cooldownUntil: 0, kids: 0 });
  startSlots(sched, server, clock, 10);
  await clock.advance(60_000);
  assert.equal(server.log.filter((l) => l.eve).length, 0, "not guaranteed: all became babies of leftover mothers");
  assert.equal(sched.burstLogins, 5, "burst capped at 2N+1");
  assert.equal(sched.phase, "join");
});

test("burst: a login that never gets born doesn't stall the others", async () => {
  const clock = new Clock();
  const sched = new LoginScheduler(plan(), { now: () => clock.now, sleep: clock.sleep, random: () => 0.5 });
  const admitted: string[] = [];
  for (const id of ["a01", "a02"]) void sched.beforeLogin(id, true).then(() => admitted.push(id));
  await clock.advance(1000);
  assert.deepEqual(admitted, ["a01"]);
  await clock.advance(BURST_BORN_TIMEOUT_MS + 2000);
  assert.deepEqual(admitted, ["a01", "a02"]);
});

test("respawn: a dead slot logs in again 30-90 s after its death; a retry after a failed login doesn't wait", async () => {
  for (const r of [0, 0.5, 0.999]) {
    const clock = new Clock();
    const sched = new LoginScheduler(plan(), { now: () => clock.now, sleep: clock.sleep, random: () => r });
    await (async () => {
      const p = sched.beforeLogin("a01", true);
      await clock.advance(0);
      await p;
    })();
    sched.onBorn("a01", true);
    const diedAt = clock.now;
    sched.onDied("a01", diedAt);
    await clock.advance(8000); // agent.ts waits ~8 s after a death before asking
    let at = 0;
    void sched.beforeLogin("a01", false).then(() => (at = clock.now));
    await clock.advance(120_000);
    const expected = 30_000 + 60_000 * r;
    assert.ok(Math.abs(at - diedAt - expected) < 2, `respawned after ${at - diedAt} ms, expected ${expected}`);
    // a failed connect (no death) retries without the delay
    let retried = false;
    void sched.beforeLogin("a01", false).then(() => (retried = true));
    await clock.advance(0);
    assert.equal(retried, true);
  }
});

test("paused: no one logs in until the pause ends; close() releases every waiter", async () => {
  const clock = new Clock();
  let paused = true;
  const sched = new LoginScheduler(plan(), { now: () => clock.now, sleep: clock.sleep, random: () => 0.5, paused: () => paused });
  const done: string[] = [];
  void sched.beforeLogin("a01", true).then(() => done.push("a01"));
  sched.onDied("a02", clock.now);
  void sched.beforeLogin("a02", false).then(() => done.push("a02"));
  await clock.advance(10 * 60_000);
  assert.deepEqual(done, []);
  paused = false;
  await clock.advance(2000);
  assert.deepEqual(done.sort(), ["a01", "a02"]);

  const s2 = new LoginScheduler(plan(), { now: () => clock.now, sleep: clock.sleep, random: () => 0.5, paused: () => true });
  let released = false;
  void s2.beforeLogin("a01", true).then(() => (released = true));
  await clock.advance(5000);
  s2.close();
  await clock.flush();
  assert.equal(released, true);
});

test("INITIAL_EVES=0: no burst, every first login is staggered", async () => {
  const clock = new Clock();
  const sched = new LoginScheduler(plan({ initialEves: 0 }), { now: () => clock.now, sleep: clock.sleep, random: () => 0.5 });
  for (const id of ["a01", "a02", "a03"]) void sched.beforeLogin(id, true);
  await clock.advance(1000);
  assert.equal(sched.admissions.length, 1);
  await clock.advance(90_000);
  assert.equal(sched.admissions.length, 2);
  assert.ok(sched.admissions.every((a) => a.phase === "join"));
});

test("starting setup holds across random cooldowns: 2 Eves and 8 babies for 25 seeds", async () => {
  const extra: number[] = [];
  for (let seed = 1; seed <= 25; seed++) {
    const clock = new Clock();
    const rnd = seeded(seed * 101);
    const server: FakeServer = new FakeServer(clock, rnd);
    const sched = new LoginScheduler(plan({ initialEves: 2, agentCount: 10 }), { now: () => clock.now, sleep: clock.sleep, random: rnd, familyRoom: () => server.room() });
    startSlots(sched, server, clock, 10);
    await clock.advance(40 * 60_000);
    assert.equal(server.log.length, 10);
    extra.push(server.log.filter((l) => l.eve).length - 2);
  }
  assert.deepEqual(extra, Array(25).fill(0), "extra Eves per seed");
});
