# Choosing TIME_SCALE (game time dilation)

`TIME_SCALE=k` slows the game server's whole clock k× (`server/patches/time-scale.patch`): aging, hunger and heat drain, decay and regrowth, cooldowns and walking speed. Every in-game ratio stays the same: a year still holds the same number of food pips, steps and berry regrowths. Only the wall-clock time per game second changes, so an LLM that needs ~8 s per decision gets k× more decisions in every game window.

## How it works

- **Server.** `mtsGameTime.h` is included in `server.cpp` and `map.cpp` right after `minorGems/system/Time.h` and routes every `Time::` call in those two files through a virtual clock, `E + (real − E) / k`. The patch adds no per-rate code: anything that reads the game clock, including `secondsPerYear`, food-decrement ETAs, `mapETA`/`autoDecaySeconds`, move ETAs and kill/emote cooldowns, slows by exactly k.
- **Protocol.** The server converts durations and speeds it sends back to wall seconds: PU `age_r` (60k s/year) and `move_speed` (3.75/k tiles/s), PM `total_sec`/`eta_sec`, FX `move_speed`, HX `food_time`, and MX animal `speed`. A client that trusts the server's numbers needs no changes; ours already does (`world.ts` age projection, move ETAs, food ETA).
- **What stays on the wall clock.** Sockets, keep-alive (the client sends `KA` every 15 s), web requests, message-flood batches, and the other server modules (curses, lineage limits, offspring tracking, logs).
- **Restarts.** The epoch E is saved in `timeScaleEpoch.txt` in the run dir, so a restart at the same k carries on the same game clock and the decay ETAs stored in the world DB stay valid. Switching from 1 to k > 1 is continuous. Switching back to 1 jumps the clock forward and pending decays fire at once.
- **Agents.** `config.timeScale` (same `TIME_SCALE` env var) is used for client-side constants: the walk-time fallback (`walkMs`), and `YEAR_MS` in `lives.ts`. `World` logs `TIME_SCALE mismatch` if the server's s/year doesn't match. Behaviour code should express waits in turns (`config.timeScale`, `config.decisionCycleMs`).

## Verification (local, patched server, `agents/src/tools/timescale-probe.ts`)

Scripted client, no LLM. Same binary run at k = 1 (90 s) and k = 3 (240 s) on test ports.

| quantity | k = 1 | k = 3 | ratio |
|---|---|---|---|
| wall s per game year, measured from server-reported ages | 60.2 | 179.4 | 2.98 |
| food pip interval, measured (cold Eve) | 6.93 s | 20.78 s | 3.00 |
| walking speed, measured (6-tile straight walks) | 3.72 tiles/s | 1.245 tiles/s | 2.99 |
| reported `age_r` / `move_speed` / PM s per tile | 60 / 3.75 / 0.267 | 180 / 1.25 / 0.800 | 3.00 |
| connection after the run | alive | alive | |

A restart at k = 3 reused the saved epoch, and the connection stayed up through a 45 s probe at 184 s/year (the age reading is quantized, so this is noisy). At k = 1 every value sent equals the stock value (x·1.0), and the clock functions return `Time::` unchanged.

## Stock windows → decisions per window

Cadence: the measured adult decision cycle is 7.9–9.3 s (p50) and 9.2–10.6 s (mean) (`cost/measured.json`, dev1 and showcase1). A fixed 8 s cadence is coming. Below: **decisions = window × k / 8 s**. At a 10 s cadence, multiply by 0.8.

Game constants come from `server.cpp` and the stock settings (`minFoodDecrementSeconds` 4, `maxFoodDecrementSeconds` 20, so drain per pip = 4 + 40·heat for heat ≤ 0.5). A newborn's capacity is 4 pips (age + 4) and an adult's is 20. Fertility runs from age 14 to 40. Transition data comes from `game-data.json`.

| window | game s | k = 1 | k = 2 | k = 3 | k = 4 |
|---|---|---|---|---|---|
| unheld newborn survives (4 pips, cold) | 35 | 4.4 | 8.8 | 13.1 | 17.5 |
| newborn food pip, i.e. a set-down baby with 1 pip left (cold) | 8.75 | 1.1 | 2.2 | **3.3** | 4.4 |
| cold adult food pip (heat ≈ 0.07) | 6.8 | 0.8 | 1.7 | **2.5** | 3.4 |
| cold adult food pip + food bonus (+18 s) | 24.8 | 3.1 | 6.2 | 9.3 | 12.4 |
| warm adult food pip (heat 0.5) | 24 | 3.0 | 6.0 | 9.0 | 12.0 |
| warm adult food pip + food bonus | 42 | 5.2 | 10.5 | 15.8 | 21.0 |
| cold adult, full (20 pips) to empty | 136 | 17 | 34 | 51 | 68 |
| fire stage (Fire → Hot Coals) | 60 | 7.5 | 15 | 22.5 | 30 |
| baby until it can act (age 3) | 180 | 22.5 | 45 | 67.5 | 90 |
| birth to fertility (age 14) | 840 | 105 | 210 | 315 | 420 |
| fertility window (14–40) | 1560 | 195 | 390 | 585 | 780 |
| watered wild gooseberry bush regrows | 600 | 75 | 150 | 225 | 300 |
| full lifespan (60 years) | 3600 | 450 | 900 | 1350 | 1800 |

Reading it: at k = 1 a cold adult loses more than a pip per decision. A baby set down with one pip left starves before the mother's next-but-one turn. Recovering from either takes a notice turn, a walk turn and an act turn, so about 3 turns. Walking slows k× too, so a walk costs the same game time at any k. What dilation buys back is the ~8 s of LLM thinking per turn, which costs only 8/k game seconds.

## Cost

At a fixed cadence the cost per wall-hour doesn't depend on k (same calls per slot-hour). Wall time per game event grows k×, so **cost per lifetime and per generation grow k×**, and generations per day shrink k×. Figures use $/slot-hour at the 8 s cadence from `cost/tables.md` (Gemini 3.8 Flash $1.50, Claude Haiku 5.5 $0.16, DeepSeek V4 Flash $0.11). A generation is taken as 20 game years (median childbearing age, roughly). Overhead is narrator + director + story at ~$68/day with 20 alive on Gemini ($2.83/wall-h).

| k | wall time per full life | wall time per generation | Gemini 3.8 Flash: per life / per generation (20 slots) | Haiku 5.5 | DeepSeek V4 Flash | overhead per generation (Gemini) | generations per 24 h |
|---|---|---|---|---|---|---|---|
| 1 | 60 min | 20 min | $1.50 / $10 | $0.16 / $1.1 | $0.11 / $0.7 | $0.9 | 72 |
| 2 | 120 min | 40 min | $3.00 / $20 | $0.32 / $2.1 | $0.22 / $1.5 | $1.9 | 36 |
| 3 | 180 min | 60 min | $4.49 / $30 | $0.48 / $3.2 | $0.33 / $2.2 | $2.8 | 24 |
| 4 | 240 min | 80 min | $5.98 / $40 | $0.64 / $4.3 | $0.44 / $2.9 | $3.8 | 18 |

Notes:
- A day still costs the same (~$790 per 20 slots × 24 h on Gemini). What changes is how many generations it buys, and that is what the lineage-selection study needs.
- A full life is rare today (median lives were 3–12 min in the pilots), so per-life cost today is far below the full-life figure. If dilation works, lives get longer in game years too, and spend per life rises on both counts.

## Food bonus

The food bonus (`newPlayerFoodDecrementSecondsBonus` = 18 game s added to every pip's drain, babies included; being enabled separately) is in game seconds, so it is dilated too: +18k wall s per pip. It and k multiply. With the bonus, the cold pip becomes 24.8 game s, and the decisions per pip are 24.8k/8.

The bonus is a change to the game's economy: it alters ratios such as food per year. TIME_SCALE leaves every ratio intact. The two can be reported separately. Note too that stock OHOL decays the bonus with a 10-hour half-life of a player's total play time when the stats server is on.

## Recommendation: **TIME_SCALE = 3**

- It meets both targets without relying on the food bonus. A set-down newborn with a single pip left gets 3.3 turns, and a full unheld newborn 13. A cold adult gets 2.5 turns per pip and 51 turns from full to empty. Warm adults get 9 turns per pip.
- With the food bonus on, a cold adult gets 9.3 turns per pip, which leaves a wide margin for the slow 10–18 s tail of the cycle distribution (p95 18 s still gives about 4 turns).
- k = 4 is the minimum if the bonus stays off and you want a strict ≥3 turns per cold pip. It costs a third more per generation. k = 2 is enough for adults only with the bonus on, and it leaves a set-down newborn about 2 turns.
- Cost: 3× per generation vs stock ($30 per 20-slot generation on Gemini, ~$3 on Haiku). That's 24 generations a day instead of 72, which is still plenty, since at k = 1 almost no lineage got past generation 2.

Revisit k once the fixed 8 s cadence is in and the calibration harness measures real decision counts per window.

## Risks / what doesn't scale cleanly

- **Client-side constants are on the agents.** Anything in agent code measured in wall ms (starvation-reflex spacing 20 s, baby decision interval, the "witnessed deaths for 5 minutes" window, recency in observations) doesn't scale by itself. It should be expressed in turns or multiplied by `config.timeScale`. The viewer's study page (`viewer/src/study/analysis.ts`, `YEAR_MS = 60_000`) still assumes stock years. Lives recorded under one k and analysed under another get the wrong `presumedEndAt`.
- **Game-clock side effects people may not expect.** The speech gap (1 game s → 3 wall s at k = 3), emote cooldowns and the 10 s login timeout all dilate. Emote display TTLs sent in PE are not converted (cosmetic only).
- **Server wakeups.** Poll timeouts are computed in game seconds but slept in wall seconds, so the server wakes up more often than it needs to. This is harmless: it does a little more idle polling.
- **Mixed clocks across modules.** Curse/lineage-limit/offspring timers stay on wall time (they're meta-game). No timestamps cross between those modules and `server.cpp`/`map.cpp`. Server-written logs from `server.cpp` (e.g. `familyDataLog.txt`) carry game-clock timestamps.
- **Changing k on a live world.** 1 → k is continuous. k → 1, or k → k′, starts a new epoch, and the clock jumps forward by (uptime since E)·(1 − 1/k). Pending decays fire and growth catches up. Wipe the world, or accept the jump.
- **Server and agents must agree.** Set one `TIME_SCALE` for both (on Fly, both processes share the env). A mismatch only affects client-side constants, since the server-reported rates are always right, and it logs a warning.
