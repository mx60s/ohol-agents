// A stand-in for the game server's side of the turn clock (docs/turn-clock.md),
// for tests and local simulation: the game clock runs at `speed` game seconds
// per wall second (1 / TIME_SCALE on a real server) while below the target,
// and holds exactly at the target. Evaluated lazily on every call; no timers.

import type { ClockPort, ClockReading } from "../turnclock.ts";

export class FakeClockPort implements ClockPort {
  gameTime: number;
  target: number | null = null;
  /** targets written, in order */
  readonly writes: number[] = [];
  /** false = the server never reports (mtsClockNow.txt missing) */
  reporting = true;
  private at: number;

  constructor(
    gameTime = 1000,
    /** game s per wall s while running */
    public speed = 1,
    private wall: () => number = Date.now,
  ) {
    this.gameTime = gameTime;
    this.at = wall();
  }

  private advance() {
    const now = this.wall();
    if (this.target != null && this.gameTime < this.target) {
      this.gameTime = Math.min(this.target, this.gameTime + ((now - this.at) / 1000) * this.speed);
    }
    this.at = now;
  }

  get paused(): boolean {
    this.advance();
    return this.target == null || this.gameTime >= this.target;
  }

  read(): ClockReading | null {
    if (!this.reporting) return null;
    const paused = this.paused;
    return { gameTime: this.gameTime, paused };
  }

  writeTarget(t: number) {
    this.advance();
    this.target = t;
    this.writes.push(t);
  }
}
