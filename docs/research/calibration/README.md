# Model calibration, 2026-11-16 (local, 5 runs)

Five sequential 20-minute sessions against a fresh local world each, on a laptop. Per-run scorecards are next to this file (`run<N>-<model>.scorecard.json`, made with `calibrate.ts score`, then patched with the whole-run cost from `/api/state` and the run settings). Raw logs are in `agents/logs/calibration-2026-11-16/run<N>/` (gitignored).

## Setup (same in every run)

- Patched server `.ohol-build/OneLife/server/OneLifeServer` (built 19:14), started with `server/run.sh` into a new run dir per run, game port 8031, `TIME_SCALE` set on the server. Each start logged `MTS timeScale = k` and wrote `timeScale.ini=k`. `mtsNewPlayerFoodBonus=1` and `newPlayerFoodDecrementSecondsBonus=18` were in the run dir's settings. The observed pip times match the bonus: a cold adult at k=2 had about 120 wall s per pip, and the stock rate would be about 14 s.
- Agents: `npx tsx src/main.ts`, not `calibrate.ts run`, because the calibrate tool turns the narrator, director and story off. Settings: `AGENT_COUNT=8 INITIAL_EVES=2 CONTINUOUS=1 LLM_STREAM=1`, API port 8931, default mild reasoning cap (300 reasoning / 800 total tokens), the narrator, director and story on with the default overhead model `google/gemini-3.1-flash-lite`, and `MAX_COST_USD` 8 (20 for Kimi). The runs were stopped with `POST /api/halt` at 20 min.
- Every model id was checked in `/api/v1/models` first. All five existed as given.
- **The code changed under the runs.** Another session committed to `integrate` during this calibration, and each run loaded the code that was there when it started:
  - Runs 1-2 ran on `55b76c2`.
  - Run 3 also had the narrator persona commits. These don't change agent behaviour.
  - Run 4 also had `29f87cc` (narrator every 90 s instead of 30 s), `e812d21` (the observation shows the age-based speech letter limit) and the Jev director.
  - Run 5 also had `7e1f84e` and `a5b8774` (per-person flowers shown to agents).
  - So runs 4-5 used slightly different observations and much less narrator overhead than runs 1-3.

## Summary

| # | model | k | cycle s | served by | turn p50/p90 s | LLM latency p50/p90 s | TTFT p50 s | reasoning tok/call | calls | run cost $ (agents + overhead) | $/agent-h (8 slots) | $/alive agent-h (agents only) | projected $/day, 20 agents | cache hit | parse fail | wasted (empty/truncated) replies | action fail | deaths (cause) | babies past 3 | max gen | game yrs | survival / game-yr | first Sharp Stone | first clothing (made) | first fire |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | anthropic/claude-haiku-5.5 | 2 | 4.7 | Claude Platform on AWS (100%) | 3.0 / 5.2 | 2.7 / 4.7 | 2.3 | 359 | 1011 | 0.52 (0.47 + 0.05) | 0.196 | 0.239 | 118 | 47% | 0.0% | 0.2% | 24.6% | 0 | 6/6 | 2 | 10.0 | 100% | 0.2 yr | - | - |
| 2 | anthropic/claude-haiku-5.5 | 3 | 6.0 | Claude Platform on AWS (100%) | 3.1 / 6.5 | 2.6 / 5.6 | 2.1 | 383 | 653 | 0.35 (0.31 + 0.05) | 0.133 | 0.185 | 92 | 49% | 0.0% | 0.9% | 21.5% | 0 | 4/4 | 2 | 6.7 | 100% | 1.4 yr | 3.9 yr (worn at 4.9 yr) | - |
| 3 | openai/gpt-oss-120b | 1.5 | 4.0 | Groq 1364, Near AI 16 (fallback) | 0.9 / 1.5 | 0.8 / 1.5 | 0.3 | 190 | 1380 | 0.64 (0.60 + 0.04) | 0.247 | 0.294 | 144 | 50% | 0.0% | 0.1% | 41.2% | 0 | 6/6 | 2 | 12.9 | 100% | 0.3 yr | - | - |
| 4 | google/gemini-3.8-flash | 3 | 5.8 | Google 241, AI Studio 20 | 3.6 / 7.3 | 3.6 / 9.3 | 3.2 | ~0 (not reported) | 261 | 0.55 (0.55 + 0.01) | 0.207 | 0.329 | 158 | 4% | 0.0% | 0% | 9.4% | 0 | 4/4 | 2 | 6.7 | 100% | 0.1 yr | - | 6.0 yr |
| 5 | moonshotai/kimi-k3.1-pro | 2 | 4.7 | DigitalOcean (100%) | 3.3 / 8.5 | 3.2 / 9.7 | 0.7 | 804 | 594 | 8.46 (8.46 + ~0) | 3.166 | 4.264 | ~2,050 | 0% | 0.0% | **17.7%** (105 cut at 2000 tokens, 97 empty) | 10.3% | 0 | 6/6 | 2 | 10.0 | 100% | 0.1 yr | 0.5 yr (worn at 0.8 yr) | 2.9 yr |

Notes on the columns:
- **Projected $/day for 20 agents** = agent-only $ per alive agent-hour × 20 × 24, plus measured overhead per hour × 24. "Alive agent-hours" counts each life from birth to the end of the run, 1.7-2.0 h per run. These populations were mostly babies and young children, who decide less often, so an adult-heavy steady state costs more. The time-scale doc estimates $134/day for Haiku at k=2.
- **Overhead.** With the narrator every 30 s (runs 1-3) it was $0.12-0.15 per wall-hour. With the 90 s narrator (runs 4-5) it was about $0.02 per hour. Either way it's under $4/day.
- **Decisions per agent per game year:** Haiku 12.6 (k=2) and 12.2 (k=3), gpt-oss 13.4, Gemini 4.9, Kimi 7.4. Gemini and Kimi often pick `wait 4` (and Kimi wastes turns), so the cycle is an upper bound on decisions, not the actual rate.
- **Turn p99:** Haiku 7.8 / 10.2 s, gpt-oss 4.2 s, Gemini 14.5 s, Kimi 12.5 s.
- **Parse failures** are 0 everywhere. The scorecard counts only unparseable JSON, though. An empty reply after the reasoning budget runs out (`finish_reason: length`) is logged as a reply and not counted. That hides Kimi's 17.7% wasted turns (see Harness findings).
- **Action failures**, by top cause:
  - Haiku: `forage` when already full (about 40 per run), `use` → nothing happened, feeding a baby that won't eat, and hands locked by Yellow Fever (jungle mosquitoes).
  - gpt-oss: `use`/`swap` → nothing happened (284), forage when full (120), and failed baby pickups (73).
  - Gemini and Kimi: mostly `use` → nothing happened.
- **No deaths in any run.** Twenty minutes is 6.7-12.9 game years. With the food bonus on, Eves start near full and babies are carried, so survival, deaths by cause and generations can't be told apart at this length. Max generation is 2 everywhere, because generation 3 needs a daughter aged 14 or older. All 8 slots were filled by the end of each run: 2 Eves plus 6 babies, with joins held back by the family-room rule.
- **"First clothing"** in the scorecard is the first clothing item produced, not worn. Wearing happened only in runs 2 and 5.

## Qualitative notes (15 random decisions each, plus action and failure tallies)

**Run 1, Haiku 5.5, k=2 / 4.7 s.**
- **Competent and coherent, very social.** Eves name themselves and their babies ("YOU ARE NOLA", "I AM MIRA SOL"). Both Eves spawned together, and they nursed each other's babies by asking ("THANK, PLEASE TAKE MY BABY. SHE IS STARVING").
- **Uses the tools.** It drops a held item and picks up a starving newborn in one action list, forages while carrying a baby, and tries `craft Fire Bow Drill`. Overall: 94 baby pickups, 26 feeds and 64 action lists.
- **But no fire or clothing in 10 game years.** Time went to babies, hot jungle and Yellow Fever, which locks the hands; the model handled that sensibly by waiting and asking another woman to keep nursing.
- **Weirdness.** Many `forage` attempts while full. Reasoning ran about 360 tokens per call, a bit over the 300 cap.

**Run 2, Haiku 5.5, k=3 / 6.0 s.**
- **Same character as run 1, slightly more productive per game year.** First Sharp Stone at 1.4 yr. A Reed Skirt was made at 3.9 yr and worn at 4.9 yr. The camp had a pond, gooseberries and notes like "Need Reed Skirt and fire".
- **Heavy baby handling.** 123 pickups and 112 action lists, mostly drop-then-pick-up.
- **Odd order to a child.** An Eve told her 5-year-old daughter to pick up a baby. Children can't do that, so 24 failed pickups followed.
- **Weirdness.** A `craft Tinder` reply was rejected as ambiguous; that was correct behaviour.

**Run 3, gpt-oss-120b on Groq, k=1.5 / 4.0 s.**
- **Fast and cheap, but the least competent.**
  - Replies are terse ("Free hands, pick baby, craft Sharp Stone"). Eves didn't name themselves for the first ~10 minutes. Later they took "EVE HEYDENBURG"-style names.
  - It spammed `use`/`swap` on things that do nothing, giving the highest failure rate (41%). It tried 7-step lists, which the code cuts to 3, and also wrote the lists in a non-standard way (`{"type":"actions","actions":[...]}`, `"next":{...}`). The parser accepted these.
- **Nursing:** frequent and in the right direction (219 pickups, 55 feeds). It fed bananas to babies and picked them up again.
- **Never got past the Sharp Stone**, despite many attempts at a Fire Bow Drill.
- **Serving:** 99% Groq (16 calls fell back to Near AI). TTFT 0.3 s, turns well under the cycle.

**Run 4, Gemini 3.8 Flash, k=3 / 5.8 s (baseline).**
- **Coherent but passive.** Mothers mostly answered `wait 4` while holding a baby until age 3 ("holding her until age 3 so she survives safely"). Only 261 calls in 20 min, so half the decisions of Haiku at the same k.
- **Once children were 3, mothers put them down** by food and started crafting: a Home Marker, then a Fire Bow Drill.
- **The only cheap model that made fire.** A 6-year-old daughter lit it at 6.0 yr, via the craft macro and a Large Fast Fire.
- **Names in the stock style** ("EVE HOPE", "FAITH HOPE").
- **Weirdness.** Reasoning tokens weren't reported, and the cache hit rate was only 4% with prompts of about 2.7k tokens. The LLM latency tail is long: p90 9.3 s and turn p99 14.5 s, so a 5.8 s cycle at k=3 still has room, but it's tight at lower k.

**Run 5, Kimi K3.1 Pro on DigitalOcean, k=2 / 4.7 s.**
- **Clearly the most competent.**
  - Firsts: a Reed Skirt made at 0.5 yr and worn by 0.8 yr, and a fire at 2.9 yr, rebuilt and fed later.
  - The family works in roles: children fetch milkweed stalks for thread, a branch is left for a sibling's bow, and a mother drops a baby by the berries to craft a Sharp Stone and then picks it back up. Notes and plans hold across turns.
- **Problems.**
  - It ignores the reasoning cap. Reasoning was 804 tokens per call, and 18% of calls hit the 2000-token limit even after the retry, which gives an empty reply and a wasted turn.
  - Latency p50 grew from 1.6 s to 3.2 s as the run went on. p90 was 9.7 s, so slower than the 2.7 s that `docs/research/cost/v2` measured.
  - Cost: $8.46 for 20 min. The prompt is uncached, about $0.014 per call.
- **Weirdness.** It used `eat` to put on clothing (there's a `wear` action). The harness refused this with "you're full, can't eat now" when food was full, and the same move worked once food had dropped.

## Harness findings (not patched; for the user to decide)

1. **The food drain is shown about k times too slow (high impact for every k > 1).**
   - `world.ts:283` stores `HX food_time` as **wall** seconds, since the server already applies TIME_SCALE.
   - `observe.ts foodLine()` passes it through `drainSeconds()` into `turnsFor()`, which multiplies by `timeScale` again. So "Drains 1 pip every ~N turns; runs out in about M turns" is k× too optimistic. At k=2, a cold adult was told about 25-30 turns per pip; the true figure is about 12-13.
   - Babies see the same error. It's still at HEAD `d9765e6`.
   - It didn't cause deaths here, because the bonus was on and the runs were short. But it biases every TIME_SCALE comparison and the "Durations in turns" intervention.
2. **The counterfactual "warm it would be 1 per ~N turns" leaves out the food bonus** (`drainSecondsPerPip(0.5)` is the stock value). Together with bug 1 it says being warm drains *faster* than being cold, which is the wrong way round.
3. **The "[other family: their language differs from yours]" tag appears with only 8 players**, although the server scrambles speech only at 15 or more alive. The speech was readable, but the tag says otherwise.
4. **The scorecard doesn't count empty or truncated replies as failed decisions** (`calibration.ts`: `jsonErrors` only counts `{error, raw}` lines). Kimi showed 0% parse failures while wasting 18% of its turns.
5. **`eat` while holding clothing is refused by the "you're full" pre-check** (`agent.ts:487`) instead of being sent as a self-use (wear), as it would be on the real client.
6. **The mild reasoning cap is soft:** Haiku went over 300 tokens by about 20%, and Kimi ignored it.

## Recommendation

**Use `anthropic/claude-haiku-5.5` at TIME_SCALE = 2 with a 4700 ms cycle** (or about 5000 ms for more headroom over the turn p90 of 5.2 s), with the default provider.

- **Cost.** About $120/day for 20 agents including overhead (at most about $135 adult-heavy), with a 47% cache hit rate, zero parse failures and zero call errors.
- **Speed.** Turn p50 is 3.0 s, under the cycle. p90 of 5.2 s slightly overruns 4.7 s, which the sequential loop absorbs.
- **Quality.** The best of the affordable models: coherent speech, naming, mutual nursing, and action lists used the intended way.
- **k=2 vs k=3** gave the same decisions per agent per game year (12.6 vs 12.2), because the cycle was scaled with k. k=2 gives 1.5× the generations per day for about 1.3× the dollars per day, so it's cheaper per generation: about $3.3 vs $3.8 per 20-agent generation. With the food bonus on, neither run came close to starving anyone.
- **Kimi K3.1 Pro is the quality ceiling,** with fire and worn clothing within 3 game years and real division of labour. But it's about 17× Haiku's cost (~$2,000/day for 20 agents on DigitalOcean) and wastes about 18% of its turns on truncation. Use it, if at all, for a few "elite" slots or a short showcase, not 24/7.
- **Gemini 3.8 Flash** costs more than Haiku ($158/day projected) and plays passively, though it was the only cheap model to make fire.
- **gpt-oss-120b on Groq** is the fastest by far, but its 41% action failure rate and shallow play rule it out as the main model.

Before the main study:
- (a) Fix finding 1, because it changes what every agent believes about hunger.
- (b) Re-run Haiku at k=2 for 60-90 min, so that deaths, babies past 3 and generation 3 can be measured; 20 minutes can't separate the conditions on survival.
- (c) Count empty or truncated replies as failures in the scorecard.

## Spend

- **Credit balance:** before 19:38 PST, $485.54 remaining (560 − 74.458 used). After the last run (21:21), $458.70 remaining (560 − 101.304). That's a delta of **$26.85**.
- **These runs' own billed cost** (OpenRouter's `usage.cost` per call, summed by the client) is **$10.52**: $0.52, $0.35, $0.64, $0.55 and $8.46.
- **The rest of the delta was not from these runs.** The same key's usage kept rising after every calibration process had stopped: +$0.51 between 21:21 and 21:24 with nothing of ours running. So another session was using the key at the same time.
