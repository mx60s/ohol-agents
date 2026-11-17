# Turn-based clock (lockstep)

Status: design, 2026-11-17. The user asked for it after the new-player runs showed
agents talking past each other: each agent ran its own 8 s loop while the world kept
moving, so replies landed on stale context, and model speed decided how often anyone
could act.

## The idea

The game clock only runs when the agents service says so. Each turn:

1. **Decide (world frozen).** Every agent that is free this turn builds its observation
   and calls the model, all at once. Nothing in the game moves, decays, ages or starves
   while they think, however long it takes.
2. **Act (world runs).** The service lets the game clock run for one turn's worth of game
   time. Agents send their actions (up to ACTION_LIST_MAX each) during this window;
   speech said now is heard by everyone before the next decision.
3. Repeat.

Speed and reasoning length no longer change what an agent can do in game time. That is
also what the steering study needs (no latency confound).

## Units

- `TURN_GAME_S` (default **2.4**): game seconds the clock runs per turn. 60 game s = one
  year of age, so a year is 25 turns, the same as the current prompt and observation
  ("A year passes every 25 turns"). All "in N turns" text must use this.
- During the act window the clock runs at its normal rate for `TIME_SCALE` (k): the window
  lasts `TURN_GAME_S * k` wall seconds. With k = 1 that is 2.4 wall s per turn plus the
  decide phase.

## Server <-> agents protocol (files in the game server's run dir, `$WORLD_DIR`)

Setting `mtsTurnClock` (settings/mtsTurnClock.ini, 1 = on; env `TURN_CLOCK=1` via
server/run.sh). When off, the server behaves exactly as today.

- **`mtsClockTarget.txt`** (written by the agents service, atomically: write a temp file,
  then rename): one decimal number, the game time in seconds the clock may run up to, in
  the same units as the server's game clock (`MTSGameTime::getCurrentTime()`).
  The server's game clock advances at the normal (1/k) rate while it is below the target
  and **holds exactly at the target** once it reaches it. A target at or below the
  current game time means "stay paused". A missing file with `mtsTurnClock=1` means
  paused (the clock holds at its current value from boot).
- **`mtsClockNow.txt`** (written by the server, atomically): `<gameTimeSeconds> <paused 0|1>`,
  rewritten whenever the paused state changes and at most every 100 ms while running.
  The agents service polls it (every ~50 ms during an act window) to know when the
  window has ended.
- The server re-reads the target when the file's mtime changes (stat at most every
  20 ms in its main loop). While paused, the main loop must keep serving the network
  (logins, speech, USE/DROP messages) and must not busy-spin or sleep through target
  changes: cap any socket wait at ~20 ms while paused.
- Game time is continuous across server restarts (it is persisted like
  timeScaleEpoch.txt), so player saves, ages and decay stay consistent.

## What runs on game time (frozen while paused)

Everything the server computes from its game clock: ages, hunger, heat, decay and regrowth
timers, walking (a walk only progresses while the clock runs), birth cooldowns, animal
movement. Network handling, logins and the server's own bookkeeping keep working.

## Agents service (TURN_CLOCK=1)

A `TurnCoordinator` in the Population replaces each agent's independent loop timing:

- **Decide phase:** every connected, alive agent that is not still busy executing a
  previous action list (e.g. mid-walk) and is not deliberately waiting gets one model
  call. The phase ends when all replies are in, or at `TURN_DECIDE_TIMEOUT_S` (default 20);
  late replies are dropped and that agent does nothing this turn ("you were too slow
  to act this turn" in its next observation history).
- **Act phase:** the coordinator raises the target by `TURN_GAME_S` and the agents start
  their action lists. The phase ends when the server reports the clock is paused at the
  target. Actions that need more game time (long walks) keep going in later act
  windows; that agent skips decide phases until its list finishes.
- `wait N` = skip N decide phases (no model call). Babies keep their idle rule, in turns:
  a baby with nothing salient decides at most every BABY_IDLE_TURNS turns.
- The craft macro budget, decay timers and every "in N turns" text use TURN_GAME_S.
- Logins and births happen whenever they happen; a newborn joins at the next decide phase.
- No agents connected / no one alive: the coordinator keeps the clock paused (nothing
  happens in an empty world) except that the regeneration-on-extinction grace period is
  measured in wall time as today.
- If the coordinator stops (agents service restart, hot update), the clock stays paused
  at its last target; nothing in the world moves until it comes back.
- Off (`TURN_CLOCK` unset): today's behaviour, unchanged.

## Stream

The world is still between act windows (characters freeze while everyone thinks, then move
for ~2.4 s). The stream should show this honestly; an optional small "thinking..." /
"turn 123" indicator is fine.

## Notes for the agents half (from the server half)

Implemented in `server/patches/turn-clock.patch` (extends `mtsGameTime.h` from
time-scale.patch); local check: `server/tools/turn-clock-test.sh` (use a fresh run dir).

- **File formats.** `mtsClockNow.txt` is `"%.6f %d\n"` (trailing newline). Game seconds
  are Unix-epoch sized (about 1.79e9), so write the target with at least 3 decimals.
  The server holds at exactly the parsed target, but it prints that value with 6 decimals, so
  don't compare floats for equality. Treat "window over" as `paused == 1 && g >= target - 0.001`.
- **Right after writing a target**, `mtsClockNow.txt` still says paused for up to about
  20-40 ms, until the server's next stat. Don't read that as "window over" (use the
  condition above).
- **Boot is always paused.** A `mtsClockTarget.txt` left over from before the server
  started is ignored until the file changes (new inode, size or mtime). After a server
  restart, compute the next target from `mtsClockNow.txt` (`g + TURN_GAME_S`), not from the
  last target you wrote, because the server may have restarted mid-window. Game time
  is persisted in `mtsClockGame.txt`. A restart resumes at the same game time, and player
  saves shift by about 0 s. World regeneration keeps the file, like timeScaleEpoch.txt.
- A target below the current game time never moves the clock back. Deleting the target
  file pauses the clock where it is.
- **Walking.** The server computes positions from game time, so a walk freezes mid-path
  while paused and continues on resume with no jump (tested: 8 tiles, 2.13 s walk, half
  run, 30 s + 3 s paused, arrived 1.09 s after resume, expected 1.07). But `PM` total/eta
  seconds (and `PU` age_r, `HX` food time) are wall seconds *assuming the clock runs*.
  Client-side extrapolation such as `world.ts` `moveEndsAt = now + etaSec` is wrong
  across pauses. Use `PU` done_moving for arrival. While paused mid-walk the server still
  has the player on the in-between tile, so an action that needs the destination
  must wait for done_moving.
- **SAY, USE, DROP, login** are handled immediately while paused. The SAY flood gap
  (stock: 1 game s) is **1 wall second** in turn mode. A second SAY within 1 s is silently
  dropped, paused or not.
- Housekeeping runs on the wall clock in turn mode. That covers the login timeout and
  closing a dead player's socket (10 wall s after death, even while paused). The server
  has no idle timeout on logged-in clients, and a client sat through a 30 s pause without
  trouble. The stock periodic step (re-reading shutdownMode, periodic placements, the global
  message queue) runs on game time, so it is frozen while paused.
- CPU while paused: about 1.5% of one core (the loop wakes every 20 ms). Stock idle is about 0.5%.
- With `TURN_CLOCK` off, `server/run.sh` moves `mtsClockGame.txt` aside, so turning it
  back on starts from the normal game clock (no jump backwards). Turning it off jumps
  game time forward to the normal clock (pending decays fire), as with time-scale.

## Agents half (as built)

`agents/src/turnclock.ts` (`TurnCoordinator`, `FileClockPort`); the agents' side in
`agent/agent.ts` (`decideTurn` / `actTurn`), wired in `population.ts`. Settings:
`TURN_CLOCK=1`, `TURN_GAME_S` (2.4), `TURN_DECIDE_TIMEOUT_S` (20), `BABY_IDLE_TURNS` (10),
`MTS_CLOCK_DIR` (default `$WORLD_DIR`, else `.ohol-run`; deploy/start.sh exports it).

- **Turn loop.** With someone in the world and the run playing: read `mtsClockNow.txt`
  (none yet: wait, one system event); if it says running, wait until it pauses; decide;
  then write `target = g + TURN_GAME_S` from a fresh read (never from the last target, so
  a server restart mid-window is fine) and poll every 50 ms until
  `paused == 1 && g >= target - 0.001`. Act timeout: 4x the window + 5 s, then a system
  event and the next turn (whose target again comes from the server's `g`, so the clock
  never runs ahead). Nobody in the world, outage pause, daily cap, halt: no turns, no writes.
- **Eligible** to decide: alive, connected, not still running an earlier action list (a
  walk, a `wait`), not still thinking from a timed-out decide phase. Babies (< 3): only
  with a salient event since their last decision, else every `BABY_IDLE_TURNS`. An agent
  that dies or disconnects mid-decide stops being waited for at once. Work from an earlier
  life never blocks a new one.
- **Act.** Every step of an action list waits for an open act window; lists that need
  more game time (long walks, craft) continue in later windows and the agent skips
  decide phases meanwhile. `wait N` = the agent skips the next N decide phases (a salient
  event ends it at the next decide phase, as the prompt says). Speech is spaced 1.1 wall s
  apart (the server's SAY flood gap). The starving reflex is that turn's plan.
- **Game-paced clock.** Each agent's `World` runs on `TurnCoordinator.now()`: anchored to
  the server's reported game time (x k x 1000 ms), extrapolated while a window runs, and
  standing still while paused (it creeps at 0.1% so timestamps stay ordered). So `PM`
  etas, ages, decay timers, walk deadlines, the craft budget and "N turns ago" all count
  game time, and a turn is exactly `TURN_GAME_S * k` s of it. Arrival still uses
  done_moving.
- **Stop** (halt, SIGTERM, hot update): the loop ends and writes nothing; the server runs to
  the last target and holds there. A decide phase cut short by a stop drops the replies
  without telling the agents they were slow.
- **State.** `/api/state` `run.turn = { n, phase: idle|decide|act, decided, total,
  gameTime, target, busy, turnGameS }` (absent when off). No per-turn event (it would
  flood events.jsonl).
- **Local check without a server:** `npx tsx agents/src/tools/turnclock-sim.ts` (real
  agents on FakeGame worlds, fake LLM over HTTP, fake server clock).
- **Reconnects after a restart:** ages lag wall time under the turn clock, so `lives.ts`
  `sameBody` (with `LifeBookOptions.gameClockLags`, from `TURN_CLOCK`) accepts a resumed
  character's age anywhere from `ageAtBirth - 0.5` up to the wall-time expectation + 3.
  `presumedEndAt` / `possiblyAlive` for lost lives still assume a wall-time lifespan (they
  err towards "maybe alive"). The login scheduler's respawn delays and join stagger are
  wall time (fine: logins happen whenever they happen).
- **End-to-end check (2026-11-17, laptop):** patched server + 4 agents + fake LLM
  (`fake-llm.ts --mixed`, 1.5 s latency): ~15 turns/min, decide phase 1.5 s, act 2.43 s; game
  clock never moved inside a decide phase (1694 samples); heard speech showed up in the
  hearer's next decision (turn N+1); walks of 8-10 tiles spanned 2-3 windows; killing and
  restarting the agents service reconnected all 4 characters to their open lives; a server
  restart resumed at the same game time (the coordinator logged one act timeout meanwhile).
