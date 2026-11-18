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

## 15:26 coordinator announces a full fly deploy (~15:50)
- Contents: server free-names fix bc3e83d (family surname kept per lineage, given to children born before naming), my 3d8c074 (lifeIndex), pathing fix (starting inside an animal's 4-tile margin still routes around its biting range), speech without digits (the game drops them) with feedback, sickness use reason, eat/peel fix. World should survive via player saves (same run, same lives). My hourly window counts from this deploy. I won't deploy 3d8c074 separately.
- Pre-deploy snapshot (15:26, refreshed every 30 s until the version changes): run pilot1-r5-mwla4cnm, turn n=56, gameTime 1794956357.5; 9 open lives: a01#2 p9, a02 p3, a03 p4, a04 p5, a05 p10, a06 p7, a08 p12, a09 p13, a10 p14.

## 15:27 full fly deploy verified (image 20261117T232656Z)
- The deploy went live at ~15:27:15 (version change seen 15:27:21; last pre-deploy snapshot 15:26:51), earlier than the announced 15:50. My hourly window counts from 15:27: next ≥ 16:27.
- **Same run id** pilot1-r5-mwla4cnm, status running.
- **Same lives:** all 9 open lives back with the same agent/player ids (a01#2 p9, a02 p3, a03 p4, a04 p5, a05 p10, a06 p7, a08 p12, a09 p13, a10 p14); /api/lives diff before/after = only a08 gaining a name (ROSE CHEVALLIER, given by her mother SHALEI). 0 lost, 0 new lives. alive 9 = 9.
- **Game time continued:** pre 1794956364.6 (turn 58, 15:26:51) -> 1794956369.6 at 15:27:29 (+5.0 s, i.e. ~2 act windows; no jump back or forward).
- **Turns running:** n 2 -> 5 -> 8 -> 11 in 60 s (15:27:29–15:28:30), ~9 turns/min, 7–8 agents deciding per turn.
- Coordinator asks for two more things in each check and in the final report. (1) **Adoptions:** someone picks up, nurses or names a baby from another family (lineage); log who, which families, and whether the baby survived. (2) **Family languages:** they switch on at 15+ alive (minActivePlayersForLanguages=15). Log the first "[other family: their language differs from yours]" in an observation, and whether cross-family talk changes. Detector: scratchpad `tc/adopt.py`. As of 15:30: 0 cross-lineage pickups, 0 language-differs lines (alive 9). One naming note: SHALEI CHEVALLIER's (p3, forced name at ~8) surname differs from her mother LUNA VALLEY's. That is the bug bc3e83d fixes; her daughter ROSE CHEVALLIER kept CHEVALLIER.

## 15:35 coordinator hot update
- A drop onto a loose item now says plainly "swapped at (x,y): you put down the X and picked up the Y…". Agents had swapped peel<->banana and peel<->limestone back and forth 24x in 5 min, misreading the result as "nothing happened". My hourly window now counts from this update: next no earlier than ~16:35.
- Coordinator notes, logged as data, not bugs:
  - SHALEI CHEVALLIER plots a "fire threat" to coerce LUNA.
  - **Adoption:** LUNA THISTLE (THISTLE line) carries ROSE CHEVALLIER (p12, of SHALEI, VALLEY/CHEVALLIER line) and tries to rename her. Rose already has a name, so nothing happens.
  - LUNA says "I FOLLOW YOU ROSE" to a toddler.
- Correction to check 1: I called the 59 "drop at ...: nothing happened (the tile has a ...)" results the model's own. Some of them were actually swaps reported as "nothing happened", which is F. Fixed by c1951ba.

## 15:40 coordinator hot update (appVersion 20261117T234008Z-f7d7493)
- f7d7493 has two fixes. (1) drop: an item aimed at an occupied non-container tile goes on the nearest empty tile within 3, so there are no accidental swaps; the swap action still swaps on purpose. (2) lives under the turn clock: an open life that outlived its wall-clock presumedEnd fell out of findByPlayer. LUNA THISTLE's PlayerView had lifeId null, so the viewer showed the wrong hair and no flower, and a baby of such a mother could lose its mother link (none did in r5). My hourly window now counts from 15:40: next no earlier than 16:40.
- **Verified 15:41:** all 12 living players in /api/state have a lifeId (pilot1-r5-mwla4cnm:<pid>) and an agentId. Same run, turns running (n=5 after the restart, 12 deciding). /api/lives: 0 lost. **3d8c074 works:** the new lives a07 (p24) and a10 (p26) are lifeIndex 2.
- Since 15:26: a07 p11 died of hunger at 1.53 (15:25), a10 p14 died of hunger at 2.89 (15:35, SHALEI's). Births: p24 (SHALEI), p25 (LILY THISTLE, ~14; a year is ~3 wall min), p26 LILY II THISTLE (MARLIENE's, named), p27 (SHALEI). Alive 12. Player ids jumped from 14 to 24 after the full deploy (server restart); our lives are unaffected.

## 15:43:35 coordinator hot update (naming prompts)
- At birth a mother is now told to name the baby ("…name her or him while you hold the baby by saying YOU ARE <FIRST NAME>"), and every observation reminds a mother who is holding her own unnamed baby (the user asked for this). **Study note:** this is prompt guidance about our naming rule, not game knowledge. A full deploy will follow (coordinator) with forced naming at age 2 (server mtsForceNameSeconds=120). Hourly window counts from this update.
- To measure next check: the share of babies born after 15:43:35 that their mothers name ("YOU ARE ..." from the mother, before any forced name).
- 15:45: coordinator announces a full deploy for forced naming at age 2 (e0b3bf3, mtsForceNameSeconds=120); player saves keep the world. Hourly window counts from that deploy. To verify: same run, same lives, and unnamed children aged 2+ get named with their family surname. Pre-deploy snapshot loop running.

## 15:46 full deploy verified (image 20261117T234528Z, forced naming at age 2)
- The deploy went live at ~15:45:40 (last snapshot 15:45:22, version change seen 15:45:52). My hourly window counts from 15:46: next no earlier than 16:46.
- Same run pilot1-r5-mwla4cnm. All 14 open lives are back with the same agent and player ids, 0 lost, 0 new from the restart. Every living player has a lifeId. Game time continued: 1794956693.5 (pre) -> 1794956713.7 at 15:46:43 (+20 s of game time: the turns before the stop plus 7 turns after). Turns running, n 7 -> 13 in 40 s.
- **Forced naming works with the family surname.** Across the deploy, DAMAYAH CHEVALLIER (p24, ~4) and LIRA CHEVALLIER (p27, ~2.5) got names (SHALEI's children, surname CHEVALLIER, their line's surname since the free-names fix); SERENITY THISTLE (p29, born 15:44:47, MARLIENE's) too. All open lives except the newborn p44 have names.
- **Alive reached 15 at 15:47:23** (p44 born 15:47:20 to AURORA THISTLE). That is the family-language threshold (minActivePlayersForLanguages=15). Watch for "[other family: their language differs from yours]".

## 15:54 policy change (user, via coordinator)
- r5 is a **development run, not a baseline**: fixes go in as they're found, and prompt or harness changes are no longer flagged as data splits. I may hot-update tested F fixes as soon as they're ready (the one-per-hour limit is lifted; at most one every 10 min; verify reconnects after each one). The knowledge rule still holds: no recipes, strategy or advice in the prompt. The final report must list every change made during the run (input for freezing a baseline build).
- Coordinator will do a full deploy soon: family languages always on (not only at 15+ alive), with peaceful co-location learning between families. I'll log the time.

## 15:53 check 2 (r5, 70 min old)
- Alive 17/28 at 15:53. Lives 22: 5 dead (all hunger), 17 open, 0 lost. Max gen 3. Deaths since check 1: a07 p11 1.53 (15:25), a10 p14 2.89 (15:35); after the check, ROSE CHEVALLIER p12 9.22 (15:55:51) and IVY THISTLE p44 1.99 (15:56:11). All hunger.
- Births 15:20–15:54: 14. Mothers: LUNA THISTLE, SHALEI (5), MARLIENE (3), AURORA THISTLE (2), LILY THISTLE (3).
- **Turn clock degraded:** 90 s sample at 15:53 gave **3.4 turns/min**, decide+gap 17.8 s p50 / 18.4 max (near the 20 s timeout), act 2.39 s. Cause below (F, fixed 88e706b). Clock moved while paused: 0. Too slow: 1 (a03). Act timeouts: 0.
- LLM 15:20–15:55: 2463 calls; p50 by 10 min 4.4 -> 4.8 -> 5.3 -> 6.2 s (load grows with population); 33 finish=length, 29 empty replies, in bursts (15:26–27, 15:45, 15:54–55).
- **F: the reasoning-cap fallback breaks vLLM.** A capped call (thinking_token_budget 400, total 800) that runs out is retried uncapped. After 2 strikes per process, the *model* is uncapped for every agent ("model m keeps running out of tokens under the reasoning cap; using the full budget", 15:25:51, 15:44:44, 15:53:41). Uncapped Qwen thinks to the 2000-token LLM_MAX_TOKENS and returns nothing: 2000 completion, 1999 reasoning, ~13–17 s, empty reply. Each agents restart cleared the per-process state, which is why the bursts stopped at 15:27 and 15:45. From 15:53:41 every agent was uncapped: empty replies everywhere and ~3.4 turns/min. **Fix 88e706b:** for vLLM, the retry keeps thinking_token_budget and only lifts the total to LLM_MAX_TOKENS, and the model is never uncapped. Test added; typecheck ok, 374/374. **Hot-updated 15:58:21** (20261117T235821Z-88e706b). hot-update verify OK: same run, all 17 alive reconnected to the same player ids, /api/lives 0 lost. After it: **6.0 turns/min** with 17 agents (decide+gap 6.6 s p50, act 2.40 s).
- Speech heard next turn: 11617 of 12071 (96%) (say, hearer) pairs appear in the hearer's very next observation and 113 within the next 2; the rest are hearers who didn't decide again soon. OK.
- **Family languages:** the first "[other family: their language differs from yours]" was in an observation at **15:47:27**, right when alive reached 15. 386 observations carry it by 15:55. The coordinator is deploying always-on languages with peaceful co-location learning.
- **Adoptions:** LUNA THISTLE (THISTLE line) picked up ROSE CHEVALLIER (p12, VALLEY/CHEVALLIER line) at 15:27:51; Rose died of hunger at 9.22 (15:55). LUNA also picked up SHALEI's baby p14 at 15:28:27; p14 died of hunger at 2.89 (15:35). Neither adoptee survived.
- **Mother naming after ac017b7 (15:43):** 4 of 6 babies born since were named by their mothers: SERENITY, IVY, LILAC, SORAYA (THISTLE). p47 (LILY's) and p48 (MARLIENE's) are unnamed so far. LILY said "YOU ARE ELIAS" while presumably holding another child. MARLIENE said "YOU ARE LILAC" 2x, a name already used in the family (LILAC THISTLE p45). Check whether the naming rule's numeral reached the server.
- Inventions since check 1: only Banana Peel (LILY THISTLE 15:41). No fire. SHALEI: "AURORA, GET NEEDLES AND FLINT! MAKE FIRE OR BABY BURNS!"
- Conversation: it's now addressed to people. Examples: "MARILENE, COULD YOU WATCH MARIGOLD FOR A MOMENT? I NEED TO GET SOME FOOD." (LUNA), "AURORA, OIL PALM WEST. SEBASTIAN, OIL PALM EAST. WATCH SWARM." (LUNA), "LUNA, GIVE ME THE PEEL OR I WILL GET IT MYSELF" (SHALEI), "MOTHER, TAKE MARIGOLD PLEASE" (LILY). Orders: 67 phrase lines, mostly MARLIENE's "ORDER, SEBASTIAN TAKE/CARRY SERENITY THISTLE" (x8), and LILY/LUNA ordering food hand-offs. No follows, exiles or attacks since check 1.
- vLLM ok, balance $136.32 at 15:53 (spend $5.32/h).

## 16:12 coordinator hot update (e673ecc + 4b4dc15)
- **F fix e673ecc (mine):** feed/use on a person while carrying a baby now says "nothing happened (your arms are full: you're carrying baby X; put the baby down first)" and sends nothing. server.cpp UBABY/SELF: with holdingID < 0 the action isn't let through. AURORA THISTLE got a bare "used held item on #13: nothing happened" 5x in a row at 15:52–15:53 (the check-0 watch item, recurring). Test added; typecheck ok, 376/376. The coordinator deploys it in their 16:12 hot update together with 4b4dc15 (stream "Doing" line, viewer only). My next window is 16:22.
- Note: /health already showed 20261118T000336Z-ee315d4 at 16:08 (a coordinator hot update at ~16:03 that I didn't see announced; ee315d4 isn't on integrate).

## 16:20 coordinator full deploy: languages always on (3c1d46d)
- minActivePlayersForLanguages=1, so languages are always on. Families learn each other's language by staying within 16 tiles in peace, near-full after ~300 game s. Window counts from this deploy. I'll log a cross-family pair's understanding over time (scrambled vs clear).
- Stock OHOL is kept: race D people (person race 4; display ids 19/350/1007 women, 347/352/1008 men) understand everyone and everyone understands them. If one appears, log it and whether they act as a go-between.
- Before the deploy (16:14–16:19), a **hunger wave**: LUNA THISTLE (Eve) died at 38.23 (16:00), MARLIENE THISTLE 24.82 (16:04), AURORA THISTLE 18.12 (16:05), ELARA THISTLE p48 3.73 (16:11), FERNAN THISTLE p49 2.84 (16:13). All hunger. Before the deploy: 15–16 alive, 0 lost.
- 16:12 hot update (4b4dc15-dirty, with my e673ecc) went live 16:12:52; afterwards all 15 living players have lifeIds and /api/lives has 0 lost.
- **Languages deploy verified** (image 20261118T001548Z, live ~16:16:15; last snapshot 16:15:57). Same run. All 15 open lives back with the same ids, 0 lost. The only /api/lives change is a new birth, LILY III THISTLE (a04#2 p67, 16:17:46, mother SERAPHINA THISTLE p13): **generation 4**, named on birth. Every player has a lifeId. Game time continued: 1794957146.0 -> 1794957179.9 at turn 15 after the restart (16:18:13). Turns n 15 -> 19 in 40 s. Window counts from 16:16.
