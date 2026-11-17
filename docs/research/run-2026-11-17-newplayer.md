# New-player baseline run, 2026-11-17 (run pilot1-r2-mwl6fqt0)

Settings: PROMPT_BASELINE new (controls, time/births, speech phrases, naming and flower rules; no recipes, food values, strategy or objective), CRAFT_MACRO off, TIME_SCALE 3, DECISION_CYCLE_MS 8000, ACTION_LIST_MAX 4, 28 slots, INITIAL_EVES 2, FAMILY_ROOM_MAX_HOLD_S 0, ghosts off, REGEN_ON_EXTINCTION on (180 s). Agents on self-hosted Qwen3-32B-FP8 + EAGLE-3 (RunPod Secure H200 `ruozytiawz0yqu`, $5.29/h). Times are PT. Poor play is data; only harness (F-class) issues get fixed.

## 13:05 check 0 (baseline)
- World regenerated 13:00 ("manual: new study condition"); run started 13:00:46. Status running, llmStatus ok. Log dir `/data/logs/pilot1-r2-mwl6fqt0-2026-11-17T21-00-46-850Z/`.
- Alive 4 of 28 (24 waiting): Eves a01 LILA PINE 14.4 (57,-71) and a03 UNNAMED THORN 14.4 (34,-63); babies a02 (of LILA, 13:00) and a04 (of THORN, 13:02). All heat 0.07–0.09.
- vLLM: /v1/models ok (`m` = Qwen/Qwen3-32B-FP8, max_model_len 16384); pod up 10 min. RunPod balance $148.26, spend $5.32/h.
- LLM: 55 calls, p50 3.2 s / p90 3.5 s / max 3.8 s, 0 errors, 0 empty, all stop. Reasoning tokens 400 (budget).
- Inventions: none yet.
- Phrase events:
  - LILA said "I AM LILA PINE" (family PINE).
  - **Accidental naming:** a03's observation read `#4 unnamed (woman, 14)` and she said "I AM UNNAMED THORN" (13:00). Her retry "I AM ARIA THORN" (13:01) did nothing (once only). Her name is UNNAMED THORN. The coordinator reclassified this as **F**: a human sees no name tag, but our label put "unnamed" where a name goes.
  - LILA says "I'M ..." sentences ("I'M GETTING THE ONION NOW"). These match the Eve naming phrase "I'M", but she's already named, so they have no effect.
- Play notes (data):
  - Baby a02 is held and nursed (food 4/4, "your food doesn't drain while she holds you") but says "F" every turn.
  - LILA hears "your baby #3 says F (hungry)" and tries to feed it: she fed it a Wild Rose Hip ("not food"), then ran `forage` 6x while full ("you're full"). It's an F-cry loop. The "(hungry)" label is the harness reading the F convention, and the baby's own food line is right. Watching it, not fixing.
  - THORN used bare hands on Flint 4x and on Burdock 2x. The hints correctly named the Sharp Stone.
- Parser watch (fix if it recurs):
  1. `"actions":[{"drop":{"x":57,"y":-71}},{"go":{...}}]` (type as key) was rejected: "step 1: action needs a type".
  2. `{"type":"say","message":"F"}` was rejected ("to speak, put the words in say"). The top-level "say" still spoke, so this one is harmless.
- 13:05: the coordinator ran a hot update for a viewer-only change (personality now shows "none"). My hourly hot-update window counts from it. Expect a new log dir and reconnects.
- 13:05: the coordinator's hot update went live (12f7099).
- Fix 7cd066f: a person with no name now reads `#4 (no name, woman, 14)`, and a nameless death reads `#7 (no name)`. No "unnamed" is left anywhere the agents read; the naming.ts/agent.ts hits are variable names only. There's a test, and 338/338 pass. It ships in my next hot update, after 14:05.
- Queued for my 14:05+ hot update: 7cd066f (no-name label) and the coordinator's 93124b6 (home page shows only the current run's lives and families; the observation adds "Your name is <NAME>."). I reviewed the diff; typecheck ok, tests 339/339. After deploy I need to confirm (1) the home page counts only pilot1-r2-mwl6fqt0 lives and (2) a named agent's prompt has the "Your name is" line.
- Also queued: the coordinator's 3a3468d. It adds one prompt line, "Name yourself as soon as you appear as an Eve, and name each baby you have while you hold it.", and the stream and home page now show wounds and sickness. Note for the study: this changes the new-player prompt mid-run (14:05+). It's one of our own naming rules, not game knowledge. Prompt-cache key unchanged; tests 339/339. After deploy, log whether mothers start naming babies ("YOU ARE ..." followed by a named baby in /api/lives).
- Also queued: the coordinator's 50de65d, which fixes speech tags. The server's private pointer line ("MY LADY *leader 2 *map 82 15") was being treated as speech: followers appeared to "say" it every turn. It's now a notice ("Your leader is #2 (your lady)."), and *follower/*map are stripped from orders. Also: `{"type":"say"}` without text is accepted when the reply has top-level "say" (parser watch item 2), and a sick mother's baby pickup gives the real reason. Reviewed; tests 342/342. So a follow ("I FOLLOW ...") already happened before 13:15. After deploy, check that no say event in events.jsonl contains "*leader", "*follower" or "*map".
- 13:29 (appVersion 20261117T212902Z-ab6b1b2): **the coordinator ran the hot update** with everything queued (7cd066f, 93124b6, 3a3468d, 50de65d) plus ab6b1b2. ab6b1b2 adds an age section to the prompt (what each age can do: under 3 fed only while held, stomach = age+4 from 3, carry a baby from 10, fertile 14–40, shrinking stomach after 44), says arms are full while carrying a baby, explains how orders travel (10 tiles, via superiors), adds elder PEACE/WAR, and cleans up order/pointer notices and the carrying-a-baby use reason. **Study note:** ab6b1b2 adds game-mechanics facts to the new-player prompt, which is more than our own world rules. My own 14:05 update is cancelled; my next hot update can come no earlier than ~14:30. (The coordinator's clock times ran ~5 min ahead of the machine's; times here are from the machine.)

## 13:31 false start ended: pilot1-r2-mwl6fqt0 (13:00:46–13:30:54, 30 min)
- At the user's request the coordinator regenerated the world for a clean start under the final prompt (ab6b1b2), via regen-request.json + SIGUSR2. Old world archived to `/data/worlds/archive/20261117T213052Z`. **Discard r2 from the study data**: its prompt changed mid-run and its harness had the bugs fixed above.
- r2 totals (/api/lives): 7 lives (2 Eves, 5 babies, all to LILA PINE except one to THORN), 4 deaths: 3 babies of hunger (2.4, 2.7, 7.9) and UNNAMED THORN 16.1 killed by a Wolf (`killed_418`, 13:07). The other 3 were `lost` at the regen. Max generation 2, no inventions.
- r2 phrase events:
  - LILA PINE said "I FOLLOW YOU" and "I FOLLOW".
  - Her children got the server's private line "MY LADY *leader 2 *map 82 15" (Eve as leader of her children), which our harness logged as their own speech (~37 times; fixed by 50de65d).
  - LILA gave orders: "ORDER, PICK UP BABY" (x13, plus "...FOLLOWER MAP" variants that copied the leaked tags back into speech), "ORDER, SECURE THE BABY PLEASE", "ORDER, DROP PEEL".
  - Namings: LILA PINE; UNNAMED THORN (accidental, then LUNA/ARIA THORN retries with no effect). No baby was named.

## 13:31 run pilot1-r3-mwl7ihsl started (the real start of this run's data)
- Started 13:30:54, appVersion 20261117T212902Z-ab6b1b2. Log dir `/data/logs/pilot1-r3-mwl7ihsl-2026-11-17T21-30-54-750Z/`.
- Eves a01 LUNA BREEZE and a03 JUNIPER GOOSE, both named at once (the new prompt line). a02 was born to LUNA at 13:30.

## 13:33 false start ended: pilot1-r3-mwl7ihsl (13:30:54–13:33:23, 2.5 min)
- The coordinator deployed afa90d9 and regenerated again. afa90d9 rewrites the prompt's "YOU ARE <FIRST>" line: it names the nameless baby you hold, or, with your arms empty, the nearest nameless person aged 5+ within 20 tiles. I checked this against server.cpp: the not-holding path uses `getClosestOtherPlayer(nextPlayer, babyAge=5, nameMustBeNULL)` with a 20-tile radius. **Discard r3.**
- r3: 4 lives, all `lost` at the regen. **First baby naming:** LUNA BREEZE said "YOU ARE AURORA", and baby a02 became AURORA BREEZE (/api/lives). The 3a3468d naming line works. The baby then said "FEED AURORA" 7x. Other babies spelled single letters ("U", "R", "A", "O", "I").

## 13:33 run pilot1-r4-mwl7lobm started (start of this run's data)
- Started 13:33:23, appVersion 20261117T213254Z-afa90d9 (prompt = ab6b1b2 + afa90d9). Log dir `/data/logs/pilot1-r4-mwl7lobm-2026-11-17T21-33-23-181Z/`. My hourly hot-update window counts from this deploy: next no earlier than 14:33.
- Eves a01 LUNA SAGE (49,-57) and a03 AURORA GOOSEBERRY (2,-150), both named on their first turn. Baby a02 (of LUNA) was born at 13:33, unheld at (48,-65), 8 tiles from her mother, food 2/4.

## 13:36 check 1 (r4, 3 min old)
- Run running, llm ok. Alive 4/28: Eves LUNA SAGE, AURORA GOOSEBERRY; babies a02 (LUNA), a04 (GOOSEBERRY, 13:34). Heat 0.43–0.57 (warmer biome than r2).
- vLLM ok; balance $145.15, spend $5.32/h. LLM 33 calls, p50 3.2 s / p90 3.5 s / max 3.7 s, 0 errors/empty, reasoning 400.
- Post-deploy checks:
  1. **Site**: the deployed home-page chunk `useSite-WPoE3yWz.js` filters lives with `l.runId===currentRun` whenever the current run has any lives, so it counts only pilot1-r4-mwl7lobm, which is 4 lives now. (I checked the served bundle, not a rendered page. The current run is r4, not r2: two regens happened since the request.)
  2. **"Your name is"**: 22 of 33 observations have it (all named agents), e.g. `Your name is LUNA SAGE.`
  3. **Speech tags**: 0 say events contain *leader/*follower/*map (r4 so far; no follows yet).
  4. **Baby naming**: r3 had LUNA BREEZE "YOU ARE AURORA" -> AURORA BREEZE. In r4, AURORA GOOSEBERRY said "YOU ARE LUNA" at 13:34; her baby a04 is still unnamed in /api/lives. Re-check next time.
- Parser: `"action":{"wait":{"turns":1}}` (type as the only key) was rejected 3x by baby a02 in 2 min (plus once as an actions list in r2). F (parser). Fix 66c358c accepts a single known type key with an object or null value; unknown or multiple keys are still errors. Tests 343/343. Deploy after 14:33.
- Other invalid replies: "say"-only replies with no action (babies, 2x) and one empty `{ }` (a01). These are the model's own, so left alone.
- 13:38 (machine time; appVersion 20261117T213836Z-2093da6): the coordinator hot-updated with no world restart. It ships my 66c358c (type-as-key parser) and 2093da6, a minor observation change: a heard naming line that just named someone gets "[this named #7]" (or "[this named you]"). This is the text version of the client showing the new name over that person. It matches only naming-phrase lines that contain the new first name, heard within 15 s. Reviewed. My next hot update can come no earlier than 14:38.
