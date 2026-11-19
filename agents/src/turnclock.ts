// Turn-based clock (TURN_CLOCK=1): the game server's clock runs only in act
// windows the agents service opens. Contract: docs/turn-clock.md.
//
// Each turn:
//   1. decide: every eligible agent gets one model call, all at once, while the
//      world is frozen. Ends when all replies are in, or at TURN_DECIDE_TIMEOUT_S
//      (late replies are dropped; the agent's history says it was too slow).
//   2. act: the target in mtsClockTarget.txt goes up by TURN_GAME_S, the agents
//      run their action lists, and the phase ends when mtsClockNow.txt reports
//      the clock paused at the target.
//
// Eligible = in the world (alive, connected), not still running an earlier
// action list (a long walk, a `wait N`), and not still thinking from a decide
// phase that timed out. A baby (age < 3) is eligible only when something
// salient happened since its last decision, or every BABY_IDLE_TURNS turns.
//
// Nobody to play (no one in the world, run paused or halted): no turns, the
// clock stays paused. stop() just ends the loop: the server runs to the target
// already written and holds there.

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { TurnInfo } from "./api-types.ts";

export const CLOCK_TARGET_FILE = "mtsClockTarget.txt";
export const CLOCK_NOW_FILE = "mtsClockNow.txt";

/** What the server reports in mtsClockNow.txt. */
export interface ClockReading {
  /** game time in seconds (MTSGameTime::getCurrentTime) */
  gameTime: number;
  paused: boolean;
}

/** The two clock files, injectable so tests can use a fake server clock. */
export interface ClockPort {
  /** the server's latest report; null = no (valid) report yet */
  read(): ClockReading | null;
  /** let the clock run up to this game time */
  writeTarget(gameTime: number): void;
}

/** "<gameTimeSeconds> <paused 0|1>" -> reading, or null */
export function parseClockNow(text: string): ClockReading | null {
  const m = text.trim().match(/^(-?\d+(?:\.\d+)?(?:e[-+]?\d+)?)\s+([01])$/i);
  if (!m) return null;
  const gameTime = Number(m[1]);
  return Number.isFinite(gameTime) ? { gameTime, paused: m[2] === "1" } : null;
}

/** The files in the game server's run dir. The target is written atomically (temp file + rename). */
export class FileClockPort implements ClockPort {
  constructor(readonly dir: string) {}

  read(): ClockReading | null {
    try {
      return parseClockNow(readFileSync(path.join(this.dir, CLOCK_NOW_FILE), "utf8"));
    } catch {
      return null;
    }
  }

  writeTarget(gameTime: number) {
    const file = path.join(this.dir, CLOCK_TARGET_FILE);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${gameTime.toFixed(3)}\n`);
    renameSync(tmp, file);
  }
}

/** What the coordinator needs to know about an agent right now. */
export interface TurnStatus {
  /** in the world: alive, connected, with a body */
  ready: boolean;
  /** changes with every life (login); work from an earlier life is ignored */
  life: number;
  /** age < 3: decides only on salient events or every babyIdleTurns */
  baby: boolean;
  /** something salient happened since its last decision */
  news: boolean;
}

/** One agent slot as the coordinator drives it (Agent implements it). */
export interface TurnAgent<P = unknown> {
  readonly id: string;
  turnStatus(): TurnStatus;
  /** observe and call the model (world frozen); null = nothing to do this turn */
  decideTurn(): Promise<P | null>;
  /** run the decided actions; may outlast the act window (steps wait for the next one via TurnLink.actWindow) */
  actTurn(plan: P): Promise<void>;
  /** its reply missed the decide phase: it does nothing this turn */
  tooSlow(): void;
}

/** What an agent gets from the coordinator (AgentHooks.turns). */
export interface TurnLink {
  /** resolves when an act window is open (at once if one is) */
  actWindow(): Promise<void>;
  /**
   * `wait N`: resolves when the act window N turns from now opens, so the agent
   * skips N decide phases; or at the start of an earlier decide phase where
   * wake() is true. Resolves with the turns waited.
   */
  turns(n: number, wake: () => boolean): Promise<number>;
  /** the game-paced clock for World (stands still while the server is paused) */
  now(): number;
  /** turns started so far this run (TurnInfo.n) */
  n?(): number;
}

export interface TurnClockOptions {
  /** game seconds per turn (TURN_GAME_S) */
  turnGameS: number;
  /** TIME_SCALE k: the act window lasts turnGameS * k wall seconds */
  timeScale: number;
  decideTimeoutMs: number;
  babyIdleTurns: number;
  /** act window timeout (server not responding); default 4x the window + 5 s */
  actTimeoutMs?: number;
  /** poll interval for the clock file and replies (default 50 ms) */
  pollMs?: number;
  /** poll interval while there is nobody to play (default 250 ms) */
  idleMs?: number;
  /** true = no turns now (run paused/halted): the clock stays paused */
  paused?: () => boolean;
  /**
   * After a decide phase, with its plans: true = don't open the act window (the clock stays
   * paused) and try again after holdMs. Wired to "the model is failing and nobody got a reply",
   * so the world never runs on with nobody thinking (r9: a dead endpoint let everyone starve).
   */
  holdWhen?: (plans: unknown[]) => boolean;
  /** wait before the next decide phase after a held turn (default 5 s) */
  holdMs?: number;
  /** problems worth a system event (server clock silent, act window timed out) */
  warn?: (text: string) => void;
  /** after each act window closes (turn n, game time reached): e.g. the positions log */
  onActEnd?: (n: number, gameTime: number | null) => void;
  /** wall clock (tests) */
  wall?: () => number;
}

/** "window over" = paused and gameTime >= target - this (the server prints 6 decimals of an epoch-sized number) */
const TARGET_EPS = 0.001;
/** while the server is paused the game-paced clock still creeps at this rate, so timestamps stay strictly ordered */
const PAUSED_CREEP = 0.001;

interface Waiter {
  until: number;
  from: number;
  wake: () => boolean;
  resolve: (n: number) => void;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const tick = () => new Promise<void>((r) => setImmediate(r));

export class TurnCoordinator {
  /** turns started so far (the current one while running) */
  n = 0;
  phase: TurnInfo["phase"] = "idle";
  /** turns whose act window was withheld (holdWhen) */
  held = 0;
  private decided = 0;
  private deciding = 0;
  private stopped = false;
  private loop: Promise<void> | null = null;
  private target: number | null = null;
  private last: ClockReading | null = null;
  private lastReadAt = 0;
  private running = false;
  private actOpen = false;
  private openWaiters: (() => void)[] = [];
  private turnWaiters: Waiter[] = [];
  /** agent -> life of its unfinished action list */
  private busy = new Map<TurnAgent, number>();
  /** agent -> life of its model call still in flight (decide phase timed out) */
  private thinking = new Map<TurnAgent, number>();
  /** agent -> life and turn of its last decision */
  private lastDecision = new Map<TurnAgent, { life: number; turn: number }>();
  private warned = new Set<string>();
  private readonly wall: () => number;
  private readonly k: number;
  // game-paced clock: origin + gameTime * k * 1000 + creep
  private origin: number;
  private readonly wall0: number;
  private lastNow = -Infinity;

  constructor(
    private port: ClockPort,
    private agents: () => readonly TurnAgent[],
    private o: TurnClockOptions,
  ) {
    this.wall = o.wall ?? Date.now;
    this.k = o.timeScale > 0 ? o.timeScale : 1;
    this.wall0 = this.origin = this.wall();
  }

  start() {
    if (!this.loop) this.loop = this.run();
    return this;
  }

  /** Stop after the current step. Writes nothing: the server holds at the last target. */
  async stop() {
    this.stopped = true;
    this.actOpen = false;
    for (const r of this.openWaiters.splice(0)) r();
    for (const w of this.turnWaiters.splice(0)) w.resolve(this.n - w.from);
    await this.loop;
  }

  get stoppedNow() {
    return this.stopped;
  }

  /** for /api/state (run.turn) */
  info(): TurnInfo {
    const r = this.last;
    return {
      n: this.n,
      phase: this.phase,
      decided: this.decided,
      total: this.deciding,
      gameTime: r ? Math.round(this.gameTime() * 1000) / 1000 : null,
      target: this.target,
      busy: this.busy.size,
      turnGameS: this.o.turnGameS,
    };
  }

  /** The link agents use (AgentHooks.turns). */
  link(): TurnLink {
    return {
      actWindow: () => this.actWindow(),
      turns: (n, wake) => this.turns(n, wake),
      now: () => this.now(),
      n: () => this.n,
    };
  }

  actWindow(): Promise<void> {
    if (this.actOpen || this.stopped) return Promise.resolve();
    return new Promise((r) => this.openWaiters.push(r));
  }

  turns(n: number, wake: () => boolean): Promise<number> {
    if (this.stopped || n <= 0) return Promise.resolve(0);
    return new Promise((resolve) => this.turnWaiters.push({ until: this.n + n, from: this.n, wake, resolve }));
  }

  /** game time now (s), extrapolated while the clock runs */
  private gameTime(): number {
    const r = this.last;
    if (!r) return 0;
    if (!this.running) return r.gameTime;
    const t = r.gameTime + (this.wall() - this.lastReadAt) / 1000 / this.k;
    return this.target != null ? Math.min(this.target, Math.max(r.gameTime, t)) : t;
  }

  /** The game-paced clock (ms): advances like wall time while the game clock runs, (almost) stands still while it is paused. */
  now(): number {
    const v = this.origin + this.gameTime() * this.k * 1000 + (this.wall() - this.wall0) * PAUSED_CREEP;
    if (v > this.lastNow) this.lastNow = v;
    return this.lastNow;
  }

  private read(): ClockReading | null {
    const r = this.port.read();
    if (!r) return null;
    if (!this.last) {
      // first report: keep now() continuous
      const v = this.now();
      this.origin = v - r.gameTime * this.k * 1000 - (this.wall() - this.wall0) * PAUSED_CREEP;
    }
    this.last = r;
    this.lastReadAt = this.wall();
    if (this.target != null && r.paused && r.gameTime >= this.target - TARGET_EPS) this.running = false;
    return r;
  }

  private warnOnce(key: string, text: string) {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.o.warn?.(text);
  }

  private get pollMs() {
    return this.o.pollMs ?? 50;
  }

  private get actTimeoutMs() {
    return this.o.actTimeoutMs ?? this.o.turnGameS * this.k * 1000 * 4 + 5000;
  }

  private async run() {
    while (!this.stopped) {
      const ready = this.agents().filter((a) => a.turnStatus().ready);
      if (!ready.length || this.o.paused?.()) {
        this.phase = "idle";
        this.decided = this.deciding = 0;
        await sleep(this.o.idleMs ?? 250);
        continue;
      }
      const r = this.read();
      if (!r) {
        this.phase = "idle";
        this.warnOnce("noclock", "turn clock: no report from the game server yet (mtsClockNow.txt); waiting");
        await sleep(this.o.idleMs ?? 250);
        continue;
      }
      if (!r.paused) {
        // the clock is still running (to an earlier target): let it reach it first
        await this.waitPaused(this.target ?? r.gameTime);
        if (this.stopped) break;
      }
      this.warned.delete("noclock");
      await this.turn();
    }
    this.phase = "idle";
    this.actOpen = false;
  }

  /** One decide + act turn. */
  async turn() {
    this.n++;
    await this.wakeWaiters();
    const plans = await this.decide();
    if (this.stopped) return;
    if (this.o.holdWhen?.([...plans.values()])) {
      this.held++;
      this.phase = "idle";
      this.warnOnce("held", "turn clock: no agent got a reply from the model this turn; the clock stays paused until one does");
      await sleep(this.o.holdMs ?? 5000);
      return;
    }
    this.warned.delete("held");
    await this.act(plans);
  }

  /** `wait` that ends early (wake() true at the start of a decide phase) */
  private async wakeWaiters() {
    let woke = false;
    for (const w of [...this.turnWaiters]) {
      if (!w.wake()) continue;
      this.turnWaiters.splice(this.turnWaiters.indexOf(w), 1);
      w.resolve(this.n - 1 - w.from);
      woke = true;
    }
    // let the woken action lists finish, so their agents can decide this turn
    if (woke) for (let i = 0; i < 5; i++) await tick();
  }

  private eligible(a: TurnAgent): boolean {
    const s = a.turnStatus();
    if (!s.ready) return false;
    if (this.busy.get(a) === s.life || this.thinking.get(a) === s.life) return false;
    if (s.baby && !s.news) {
      const last = this.lastDecision.get(a);
      if (last && last.life === s.life && this.n - last.turn < this.o.babyIdleTurns) return false;
    }
    return true;
  }

  private async decide(): Promise<Map<TurnAgent, unknown>> {
    this.phase = "decide";
    const eligible = this.agents().filter((a) => this.eligible(a));
    const plans = new Map<TurnAgent, unknown>();
    const waiting = new Map<TurnAgent, number>();
    this.decided = 0;
    this.deciding = eligible.length;
    let open = true;
    for (const a of eligible) {
      const life = a.turnStatus().life;
      waiting.set(a, life);
      this.thinking.set(a, life);
      this.lastDecision.set(a, { life, turn: this.n });
      const done = (plan: unknown) => {
        if (this.thinking.get(a) === life) this.thinking.delete(a);
        if (!open || !waiting.has(a)) return; // late: dropped (tooSlow was called at the timeout)
        waiting.delete(a);
        this.decided++;
        if (plan != null) plans.set(a, plan);
      };
      let p: Promise<unknown>;
      try {
        p = a.decideTurn();
      } catch (e) {
        p = Promise.reject(e);
      }
      p.then(done, (e) => {
        console.error(a.id, "decide failed", e);
        done(null);
      });
    }
    const deadline = this.wall() + this.o.decideTimeoutMs;
    while (waiting.size && !this.stopped) {
      // gone (died, disconnected, logged in again): never wait for it
      for (const [a, life] of waiting) {
        const s = a.turnStatus();
        if (!s.ready || s.life !== life) waiting.delete(a);
      }
      if (!waiting.size || this.wall() >= deadline) break;
      await sleep(Math.min(this.pollMs, Math.max(1, deadline - this.wall())));
    }
    open = false;
    // stopping (halt, restart) isn't the agents' fault: drop the replies silently
    if (!this.stopped) for (const a of waiting.keys()) a.tooSlow();
    return plans;
  }

  private async act(plans: Map<TurnAgent, unknown>) {
    this.phase = "act";
    const r = this.read() ?? this.last!;
    const target = Math.round((r.gameTime + this.o.turnGameS) * 1000) / 1000;
    try {
      this.port.writeTarget(target);
    } catch (e) {
      this.warnOnce("write", `turn clock: can't write ${CLOCK_TARGET_FILE}: ${(e as Error).message}`);
      await sleep(this.o.idleMs ?? 250);
      return;
    }
    this.warned.delete("write");
    this.target = target;
    this.running = true;
    this.lastReadAt = this.wall();
    this.actOpen = true;
    for (const r of this.openWaiters.splice(0)) r();
    for (const w of [...this.turnWaiters]) {
      if (this.n < w.until) continue;
      this.turnWaiters.splice(this.turnWaiters.indexOf(w), 1);
      w.resolve(this.n - w.from);
    }
    for (const [a, plan] of plans) {
      const life = a.turnStatus().life;
      this.busy.set(a, life);
      let p: Promise<void>;
      try {
        p = a.actTurn(plan);
      } catch (e) {
        p = Promise.reject(e);
      }
      p.catch((e) => console.error(a.id, "act failed", e)).finally(() => {
        if (this.busy.get(a) === life) this.busy.delete(a);
      });
    }
    await this.waitPaused(target);
    this.actOpen = false;
    try {
      this.o.onActEnd?.(this.n, this.last ? Math.round(this.last.gameTime * 1000) / 1000 : null);
    } catch (e) {
      console.error("turn clock: onActEnd failed", e);
    }
  }

  /** until the server reports paused at `target`, or the act timeout */
  private async waitPaused(target: number) {
    const deadline = this.wall() + this.actTimeoutMs;
    while (!this.stopped) {
      await sleep(this.pollMs);
      const r = this.read();
      if (r && r.paused && r.gameTime >= target - TARGET_EPS) {
        this.running = false;
        this.warned.delete("act");
        return;
      }
      if (this.wall() >= deadline) {
        this.warnOnce("act", `turn clock: the game clock didn't reach ${target.toFixed(1)} s within ${Math.round(this.actTimeoutMs / 1000)} s (last report: ${r ? `${r.gameTime.toFixed(1)} s, ${r.paused ? "paused" : "running"}` : "none"}); going on`);
        this.running = false;
        return;
      }
    }
  }
}
