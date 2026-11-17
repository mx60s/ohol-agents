// Fake RunEvents for tests (lives, lifestore, api).

import type { RunEvent, RunEventKind } from "./api-types.ts";

export class FakeEvents {
  seq = 0;
  t = 1_700_000_000_000;

  ev(kind: RunEventKind, agentId: string | null, playerId: number | null, data?: Record<string, unknown>, extra: Partial<RunEvent> = {}): RunEvent {
    this.t += 1000;
    return { seq: ++this.seq, t: this.t, kind, agentId, playerId, name: null, text: kind, ...(data ? { data } : {}), ...extra };
  }

  eve(agentId: string, playerId: number, x = 0, y = 0) {
    return this.ev("birth", agentId, playerId, { playerId, motherId: null, eve: true, generation: 1, lifeIndex: 1, x, y, age: 14, female: true, displayId: 19 });
  }

  child(agentId: string, playerId: number, motherId: number, generation = 2) {
    return this.ev("birth", agentId, playerId, { playerId, motherId, eve: false, generation, lifeIndex: 1, x: 0, y: 0, age: 0, female: true, displayId: 19 });
  }

  death(agentId: string, playerId: number, age = 30, reason = "reason_hunger") {
    return this.ev("death", agentId, playerId, { playerId, age, reason });
  }

  action(agentId: string, playerId: number, text: string, data: Record<string, unknown>) {
    return this.ev("action", agentId, playerId, data, { text });
  }

  /** advance the clock */
  wait(ms: number) {
    this.t += ms;
  }
}
