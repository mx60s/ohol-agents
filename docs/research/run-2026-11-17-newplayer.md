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
