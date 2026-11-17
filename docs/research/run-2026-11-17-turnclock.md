# Turn-clock run, 2026-11-17 (run pilot1-r5-mwla4cnm)

Settings: first run on the turn-based clock (docs/turn-clock.md). TURN_CLOCK 1, TURN_GAME_S 2.4 (a year = 25 turns), TURN_DECIDE_TIMEOUT_S 20, BABY_IDLE_TURNS 10, TIME_SCALE 1. PROMPT_BASELINE new, CRAFT_MACRO off, ACTION_LIST_MAX 4, 28 slots, INITIAL_EVES 2, ghosts off, REGEN_ON_EXTINCTION on. Agents on self-hosted Qwen3-32B-FP8 + EAGLE-3 (RunPod Secure H200 `7kdcewk4x17t85`, $5.29/h). Image 20261117T223314Z (c788763). Times are PT (machine clock). Poor play is data; only harness (F-class) issues get fixed. Watch planned until ~23:15.

Turn metrics come from sampling the server's `/data/world/mtsClockNow.txt` + `mtsClockTarget.txt` every ~0.1 s for 60–90 s (`act` = target write -> paused at target; `decide+gap` = paused -> next target write, i.e. decide phase plus coordinator overhead).

## 14:47 check 0 (baseline, run 3 min old)
- World regenerated 14:43:53 ("manual: turn-based clock"); run started 14:43:53. Status running, llm ok. Log dir `/data/logs/pilot1-r5-mwla4cnm-2026-11-17T22-43-53-761Z/`.
- Alive 4/28: Eves a01 LUNA VALLEY and a03 LUNA THISTLE (both named on turn 1); babies a02 AURORA VALLEY (named by her mother "YOU ARE AURORA VALLEY", 14:44) and a04 (of THISTLE, 14:45, unnamed). Both babies held.
- Turn clock (60 s sample): **9.2 turns/min**, act 2.39 s p50 / 2.50 max, decide+gap 3.6 s p50 / 4.1 max. Game time advanced 23.6 s in 59 s wall. Clock moved while paused at target: 0 samples. turn n=26 at 14:46.
- vLLM ok (models 200), pod up 13 min. Balance $142.08, spend $5.32/h. LLM 60 calls, p50 3.5 s / p90 3.9 s / max 4.2 s, 0 errors, all stop. 0 too-slow.
- Invalid: 2 baby replies with no "action" (model's own).
- Watch (possible F): `feed #5` while carrying baby #5 returns "used held item on #5: nothing happened" (2x, LUNA THISTLE). The "held item" is the baby itself; the result doesn't say why. Fix if it recurs.
- Forage with made-up/typo coords ("(56, 57)" for (56,-57)) -> "nothing at ... gives food by hand": model's own.

## 15:05 coordinator hot update (appVersion 20261117T230534Z-2ed99a9)
- Ships 25faa2e (site/stream show an unnamed person as "Unnamed <Family>"; records unchanged) and 2ed99a9 (forage while full picks the food into empty hands instead of "you're full", which one agent repeated 22x; jump says when a baby under 1 can't get out of its own mother's arms). **Study note:** the forage change alters an action result mid-run (harness, not knowledge). My hourly hot-update window counts from here: next no earlier than ~16:06.
- Coordinator also reports a subagent is debugging baby naming: the server ignored a correct "YOU ARE AURORA VALLEY" while the mother held the baby, and forced naming at age 8 isn't firing. May need a full deploy (coordinator's call). In /api/lives that baby (a02, p3) is now "SHALEI CHEVALLIER".
- **Reconnect check (15:06):** /api/lives has 8 lives, 5 open (a01#2 p9, a02 p3, a03 p4, a04 p5, a06 p7), 3 dead, **0 lost, no new life after the restart** (latest birth a01#2 at 15:03:32). /api/state alive 5 matches. Coordinator turn counter restarted (n=2 at 15:06); stats.totalBirths reset to 0 (in-memory counter; /api/lives is the record).
- Deaths so far, all hunger: a05 baby 1.53 (14:55, of THISTLE), **Eve LUNA VALLEY 19.55** (14:58), a07 baby 2.95 (15:03, of LUNA VALLEY, died 5 min after its mother).

## 15:09 coordinator hot update (appVersion 20261117T230940Z-712c6d7)
- 712c6d7: baby-naming fix. Cause was the harness: a reply's top-level "say" went out before its actions, so "YOU ARE X" + pick_up_baby reached the server with empty arms. Naming lines now go out after the pickup step. Forced naming at age 8 (480 game s) verified locally under the turn clock, so unnamed 5–7-year-olds are expected. (F-class; this explains r5's AURORA VALLEY miss.) Hourly window still counts from 15:05 for my purposes (next ≥ ~16:10 to be safe).
- **Reconnect check (15:10):** same 5 open lives (a01#2 p9, a02 p3, a03 p4, a04 p5, a06 p7), 0 lost, no new lives. Turn counter restarted again (n=2).
- Names by 15:10: a01#2 (p9, born 15:03) is now AURORA THISTLE; a04 (p5, ~8) is MARLIENE THISTLE (likely the age-8 forced name); a02 SHALEI CHEVALLIER (forced, ~8); a06 (p7, ~5) unnamed. To verify next check: babies born after 15:10 get named by their mothers.

## 15:18 check 1 (r5, 35 min old)
- More coordinator hot updates: 15:16 (535c66c, merged map keeps a known biome; stream only) and 15:19 (ffe8b97, eat: "you're full" only when holding food; a Banana Peel in hand now says it isn't food; agents had waited to get hungry to "eat" peels 25x). 4 agents-service restarts so far (15:05, 15:09, 15:16, 15:19); every one reconnected all open slots to the same lives (system events "aNN reconnected to ..."; /api/lives 0 lost, no duplicate lives).
- Alive 8/28 at 15:24 (after 2 births at 15:20 and 15:22). Gen 3 reached: a08 (p12) born 15:22 to SHALEI CHEVALLIER (p3). Lives total 11: 3 dead (all hunger, listed above), 8 open, 0 lost. Max age so far LUNA THISTLE ~28 (alive).
- Turn clock (90 s sample, 15:20): **8.0 turns/min**, act 2.39 s p50 / 2.50 max, decide+gap 4.6 s p50 / 4.8 max (up from 3.6 s with 4 agents to 6–8 agents). Clock moved while paused at target: 0. 0 too-slow timeouts, 0 act-window timeouts since start. Game time ~31 s per 90 s wall (≈ 0.35x real time), so a year ≈ 3 wall min.
- **Speech heard one turn later:** of 1945 (say, hearer) pairs where the hearer decided again within 2 min, 1936 (99.5%) appear in the hearer's very next observation, 3 in the one after. Works as designed.
- LLM: 1398 calls 14:47–15:20, p50 3.7 s / p90 4.1 s / max 17.1 s, 0 >20 s, 0 errors, 1 finish=length. vLLM ok, balance $139.41, spend $5.32/h.
- Inventions: Sharp Stone 15:06:58, Pile of Bananas 15:07:04 (LUNA THISTLE), Flint Chips 15:07:10, Flint Chip 15:09:48, Wheat Sheaf 15:14:51 (all SHALEI CHEVALLIER unless noted). No fire.
- Naming after 712c6d7: **SEBASTIAN THISTLE** (a05 p10, born 15:11) named by his mother ("YOU ARE SEBASTIAN THISTLE", 15:16, heard by 4). LILY THISTLE (a06, ~9) and MARLIENE THISTLE (a04) named. p11/p12 (born 15:20/15:22) not yet named; re-check.
- Phrases: LUNA THISTLE orders "ORDER, CARRY BABY" x4, "ORDER, LILY CARRY BABY" x6 (to a 9-year-old, under the carry age 10), "ORDER, LILY DROP PEEL". She also tried `"type":"order"` as an action 2x (rejected, model's own). No follows, exiles, attacks yet.
- Speech is mostly self-narration from Eves ("I WILL FEED MY BABY WITH BANANA.") and short child words ("MAMA", "SIBLIN", "I GO SAFE N"); little real back-and-forth yet.
- Play (data): "you're full" 87x + "you're full ..., so you can't eat" 36x before ffe8b97; drops onto occupied tiles 59x (the result names the occupant: explained, model's own). Babies' replies without an action ~12 (model's own).
- **F found and fixed (3d8c074, not yet deployed):** a restarted agents process starts every slot's lifeIndex at 0, so a slot that was dead at the restart starts again at "life 1": a05 has two life-1 records (p6 dead, p10) and a07 too (p8 dead, p11). lifeIds (runId:playerId) are unaffected, so it is cosmetic in /api/lives but wrong bookkeeping. Fix: Agent takes max(own, LifeStore's highest lifeIndex for the slot in the run) + 1 for a new life. Test added; typecheck ok, 369/369 pass (tree also had the coordinator's uncommitted body.ts/start.sh/free-names.patch edits, not mine; not committed by me). Deploy ≥16:10, unless a coordinator hot update ships it first.
