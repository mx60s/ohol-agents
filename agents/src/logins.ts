// When each agent slot logs in: the starting setup (a few Eves, the rest
// joining over time as babies), respawn delays, and holding logins while the
// run is paused. Pure timing logic; Population wires it to the agents
// (Agent hooks.beforeLogin) and feeds it birth/death events.
//
// How the stock server decides Eve vs baby (server.cpp, processLoggedInPlayer;
// line numbers are upstream OneLife_liveServer v438, see README "Run setup"):
// - A login becomes an Eve only when no candidate mother is left (:10712).
//   A candidate is a woman aged 14-40 (isFertileAge :4312) standing in her
//   homeland (:10077), not SIDS/curse-blocked by this email (:10089, :10130).
// - Pass 0 also skips mothers on birth cooldown (random 0-5 min after each
//   birth, pickBirthCooldownSeconds :2141, set at :11079; 0 for a new Eve,
//   :11640) or with maxLivingChildrenPerMother (4) living kids (:10101).
// - If only cooled-down mothers are left, passes 1-2 ignore cooldown (and
//   the lineage limit), but the login becomes an Eve anyway when helpless
//   babies (age < 3) / adults >= maxBabyAdultRatio (1.0) or babies / fertile
//   mothers >= maxBabyMomRatio (1.0) (:10227-10294).
// So logins in quick succession alternate: Eve, her baby (her cooldown is 0),
// Eve (the only mother is on cooldown and babies/adults = 1), that Eve's
// baby, Eve... 2N-1 quick logins give N Eves, N-1 of them with a newborn.
// We don't assume it: the burst logs in one slot at a time, waits for each
// birth, and stops as soon as INITIAL_EVES Eves have appeared (or after
// 2N+1 logins, e.g. when leftover fertile women from an earlier run absorb
// the logins as their babies). Everyone else joins JOIN_STAGGER_S apart.
//
// The same ratio rule would turn a staggered join into an extra Eve whenever
// every mother is on cooldown and babies >= adults or babies >= mothers
// (e.g. 2 Eves with a newborn each, both on cooldown). So after the stagger a
// join (and a respawn) also waits until the family has room: helpless babies
// < fertile women and < adults among our characters, or no fertile woman at
// all (then it's an Eve anyway). It waits at most FAMILY_ROOM_MAX_HOLD_MS.
// That is a player choosing when to log in, not a rule change. Not
// guaranteed: we can't see cooldowns, and leftover players count too.

export interface LoginPlanConfig {
  agentCount: number;
  initialEves: number;
  joinStaggerMs: number;
  /** 0..1, relative jitter on joinStaggerMs */
  joinJitter: number;
  respawnDelayMinMs: number;
  respawnDelayMaxMs: number;
}

export interface LoginDeps {
  now(): number;
  /** resolves after ms (the scheduler can cut its own sleeps short on close()) */
  sleep(ms: number): Promise<void>;
  random(): number;
  /** true = hold every login (run paused) */
  paused(): boolean;
  /**
   * true = a login now would be born to a mother rather than forced to Eve
   * (see above). Ages come from the game, so this works at any time scale.
   */
  familyRoom(): boolean;
}

/** gap between burst logins once the previous one was born, so the server sees them in order */
export const BURST_GAP_MS = 1000;
/** max wait for a burst login to be born before moving on */
export const BURST_BORN_TIMEOUT_MS = 30_000;
/** longest a join or respawn waits for family room before logging in anyway */
export const FAMILY_ROOM_MAX_HOLD_MS = 10 * 60_000;
const PAUSE_POLL_MS = 1000;
const ROOM_POLL_MS = 5000;

const realDeps: LoginDeps = {
  now: Date.now,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms).unref()),
  random: Math.random,
  paused: () => false,
  familyRoom: () => true,
};

export class LoginScheduler {
  /** "burst" = starting Eves, one login at a time; "join" = staggered */
  phase: "burst" | "join";
  eves = 0;
  burstLogins = 0;
  readonly maxBurst: number;
  /** admission log, for tests and the run's events: [agentId, phase, ms epoch] */
  readonly admissions: { agentId: string; phase: "burst" | "join"; at: number }[] = [];
  private chain: Promise<void> = Promise.resolve();
  private admitted = new Set<string>();
  private born = new Set<string>();
  private bornWaiters = new Map<string, () => void>();
  private diedAt = new Map<string, number>();
  private lastAdmitted: string | null = null;
  private wakers = new Set<() => void>();
  private closed = false;
  private deps: LoginDeps;

  /** slots of a resumed run that still have a living character: they log in at once to reconnect */
  private resumeSlots: Set<string>;
  /** constructed for a resumed run: even the first new login waits its stagger and family room */
  private readonly resuming: boolean;

  /**
   * resumeSlots: a resumed run (CONTINUOUS restart, see runstate.ts). Those
   * slots log in immediately (the server hands back their bodies), and there
   * is no starting burst: the world already has our families, so any other
   * slot joins on the stagger.
   */
  constructor(private plan: LoginPlanConfig, deps: Partial<LoginDeps> = {}, resumeSlots: Iterable<string> = []) {
    this.deps = { ...realDeps, ...deps };
    this.resumeSlots = new Set(resumeSlots);
    this.resuming = this.resumeSlots.size > 0;
    const n = Math.max(0, Math.floor(plan.initialEves));
    this.maxBurst = Math.min(plan.agentCount, n > 0 ? 2 * n + 1 : 0);
    this.phase = n > 0 && this.resumeSlots.size === 0 ? "burst" : "join";
  }

  /** a slot's character was born (first life or later) */
  onBorn(agentId: string, eve: boolean) {
    if (!this.born.has(agentId) && eve) this.eves++;
    this.born.add(agentId);
    const w = this.bornWaiters.get(agentId);
    if (w) {
      this.bornWaiters.delete(agentId);
      w();
    }
  }

  /** a slot's character died at t (starts its respawn delay) */
  onDied(agentId: string, t: number) {
    this.diedAt.set(agentId, t);
  }

  /** Resolves when this slot may log in. firstLife = the slot has never been born. */
  async beforeLogin(agentId: string, firstLife: boolean): Promise<void> {
    if (firstLife && this.resumeSlots.delete(agentId)) {
      this.admitted.add(agentId);
      this.admissions.push({ agentId, phase: this.phase, at: this.deps.now() });
      return this.whilePaused();
    }
    if (firstLife && !this.admitted.has(agentId)) {
      const turn = this.chain.then(() => this.firstLoginTurn(agentId));
      this.chain = turn.catch(() => {});
      return turn;
    }
    const died = this.diedAt.get(agentId);
    if (died != null) {
      this.diedAt.delete(agentId);
      const wait = died + this.respawnDelayMs() - this.deps.now();
      if (wait > 0) await this.sleep(wait);
      await this.waitFamilyRoom();
    }
    await this.whilePaused();
  }

  /** uniform in [respawnDelayMinMs, respawnDelayMaxMs] */
  respawnDelayMs(): number {
    const { respawnDelayMinMs: lo, respawnDelayMaxMs: hi } = this.plan;
    return lo + Math.max(0, hi - lo) * this.deps.random();
  }

  /** joinStaggerMs +- joinJitter */
  joinDelayMs(): number {
    const j = Math.min(1, Math.max(0, this.plan.joinJitter));
    return Math.max(0, this.plan.joinStaggerMs * (1 + j * (2 * this.deps.random() - 1)));
  }

  /** stop waiting: every pending login resolves now (the agents see they were stopped) */
  close() {
    this.closed = true;
    for (const w of [...this.wakers]) w();
    for (const w of [...this.bornWaiters.values()]) w();
    this.bornWaiters.clear();
  }

  private async firstLoginTurn(agentId: string) {
    const prev = this.lastAdmitted;
    if ((prev != null || this.resuming) && !this.closed) {
      if (this.phase === "burst") {
        if (prev != null) await this.waitBorn(prev, BURST_BORN_TIMEOUT_MS);
        if (this.eves < this.plan.initialEves && this.burstLogins < this.maxBurst) await this.sleep(BURST_GAP_MS);
        else {
          this.phase = "join";
          await this.sleep(this.joinDelayMs());
        }
      } else await this.sleep(this.joinDelayMs());
      if (this.phase === "join") await this.waitFamilyRoom();
    }
    await this.whilePaused();
    if (this.phase === "burst") this.burstLogins++;
    this.admitted.add(agentId);
    this.lastAdmitted = agentId;
    this.admissions.push({ agentId, phase: this.phase, at: this.deps.now() });
  }

  private waitBorn(agentId: string, timeoutMs: number): Promise<void> {
    if (this.born.has(agentId) || this.closed) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        this.bornWaiters.delete(agentId);
        resolve();
      };
      this.bornWaiters.set(agentId, finish);
      void this.sleep(timeoutMs).then(finish);
    });
  }

  /** hold until a login would be born into a family (see top), at most FAMILY_ROOM_MAX_HOLD_MS */
  private async waitFamilyRoom() {
    const until = this.deps.now() + FAMILY_ROOM_MAX_HOLD_MS;
    while (!this.closed && !this.deps.familyRoom() && this.deps.now() < until) await this.sleep(ROOM_POLL_MS);
  }

  private async whilePaused() {
    while (!this.closed && this.deps.paused()) await this.sleep(PAUSE_POLL_MS);
  }

  private sleep(ms: number): Promise<void> {
    if (this.closed) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const done = () => {
        this.wakers.delete(done);
        resolve();
      };
      this.wakers.add(done);
      void this.deps.sleep(ms).then(done);
    });
  }
}
