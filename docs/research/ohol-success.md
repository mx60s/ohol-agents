# Getting LLM agents to established OHOL settlements

Research note, 2026-11-16. Scope: why agents in this repo mostly starve, what human players do instead, and what to change, ranked by impact ÷ effort. No repo code was changed.

Sources:
- **Repo:** `agents/src/**`, run logs under `agents/logs/showcase1-*` and `agents/logs-dev/dev1-*`.
- **Server:** the server source and data under `.ohol-build/OneLife/server`, `gameSource` and `OneLifeData7`.
- **Web:** the OHOL wiki (read through its MediaWiki API, since the fandom site blocks scraping), the official forums, Jason Rohrer's OneLife GitHub, and agent papers on arXiv. URLs are inline.

---

## 0. TL;DR

1. **Most of the logged "failure" is not the agents.** Both long runs ran out of OpenRouter credits (HTTP 402). The showcase run lost its LLM at minute 41.5 of 75, with 46% of all calls failing. The dev run lost it at minute 27.7 of 229, with 73% failing. After that, agents were brainless bodies running only the starvation reflex. In the dev run, 130 of 143 born-baby deaths came from that brainless period: newborns that nobody picked up, dying at age 0.6 (36–38 s). Any analysis has to use only the pre-402 windows. The numbers below do.
2. **Agents are freezing the whole time.** In 96–99% of adult observations, body heat was ≤0.2 (median 0.07). Food drain time is `4 + 40·heat` seconds per pip (`server.cpp: computeFoodDecrementTimeSeconds`, `maxFoodDecrementSeconds=20`, `min=4`). That is **6.8 s per pip at heat 0.07 versus 24 s at 0.5, so agents starve 3.5× faster.** A full adult bar lasts about 2¼ minutes. None of 734 adult observations in the showcase run showed any clothing, and no fire was ever lit in any run.
3. **One LLM decision takes about 8 s in total** (2.5 s interval plus a median 5.4 s latency; p90 12 s). That is roughly one food pip per decision. A gooseberry gives 5 pips (34 s when cold), so an agent has to spend about 1 decision in 4–5 on eating just to break even. It spent 21%. There is no slack for nursing, walking, crafting, or 15–30 s latency spikes. Starvation is the expected outcome.
4. **Babies die mostly downstream of the mother's food crisis, not from neglect.** Pickup after birth took a median of about 15 s. Newborns start with **2 food**, so one left unpicked dies in about 35 s. Our prompt says "a few minutes". Of 18 born babies in the showcase window, 7 died after their mother died, and 6 died aged 3–10 after weaning, when they were too slow to feed themselves at 7–14 pip capacity.
5. **Highest-leverage fixes:**
   - (a) Stop runs when the LLM is down.
   - (b) Correct and condense the facts in the system prompt into an early-game playbook.
   - (c) Show the real food-drain rate (already received from the server in `HX`) in the observation.
   - (d) Cut LLM latency by capping reasoning.
   - (e) Fix two `forage` macro bugs.
   - (f) Give agents a "follow a recipe" skill and push the warmth chain (fire first).
   - (g) Run 8–12 agents, not 4.
   - Nothing on this list requires changing game rules. Section 4 flags the one optional game-setting lever (the stock new-player food bonus).

---

## 1. What human players know (with sources)

### 1.1 Core numbers, verified in our server build

**Food and heat**

| Fact | Value | Source |
|---|---|---|
| Food drain time per pip | `4 + 40·heat` s (mirrored above 0.5), so 24 s at 0.5 and 6.8 s at heat 0.07 | `server.cpp` `computeFoodDecrementTimeSeconds`; settings `maxFoodDecrementSeconds=20`, `minFoodDecrementSeconds=4`; wiki https://onehouronelife.fandom.com/wiki/Food_Meter; Rohrer: https://onehouronelife.com/forums/viewtopic.php?pid=46648 |
| Naked heat by biome (our logs, 1,700+ observations) | grassland 0.07, prairie 0.07, swamp 0.07, badlands 0.07, jungle 0.92 (too hot, so also fast drain), desert ~0.5 (n=3) | `agents/logs*/llm.jsonl`; ground heat files `OneLifeData7/objects/groundHeat_{4,5,6}.txt` (tundra −1.1, desert 18.6, jungle 17.5, others 0) |
| Reed skirt alone | heat 0.07 → 0.11, i.e. 6.8 → 8.4 s per pip (+23%) | our logs (6 observations); wiki insulation 12%: https://onehouronelife.fandom.com/wiki/Clothing |
| Heat sources | fire 4, large fire 6–8, hot coals 3 (radiant, falls off with distance) | https://onehouronelife.fandom.com/wiki/Temperature |
| Indoor bonus | +20 s per pip when enclosed (adults only) | `indoorFoodDecrementSecondsBonus=20` |
| New-player bonus (official servers) | +18 s per pip, halving every 10 h of a player's total play | `newPlayerFoodDecrementSecondsBonus=18`, `newPlayerFoodBonusHalfLifeSeconds=36000`; **only applied when the stats server is on**, and ours is off (`server/settings/useStatsServer.ini=0`) |

**Bodies and babies**

| Fact | Value | Source |
|---|---|---|
| Food capacity | age + 4, capped at 20 from 16, shrinking after 44 | `computeFoodCapacity` |
| Newborn food | **2** (Eves start full) | `server.cpp` ~10855 "babies start out almost starving" |
| Unheld newborn survives | **36–38 s** (130 such deaths at age 0.6 in the dev run) | logs |
| Holding by a fertile woman | baby's food does not drain at all | `server.cpp` ~30740 |
| Pickup by a fertile woman | refills the baby to full **only if the baby is at ≤2 food** (`babyFeedingLevel=2`), and costs the mother 1 food every time | `server.cpp` ~27640 |
| Fertile window | women aged 14–40. Men and women over 40 can't nurse, and a baby held by them still starves | `isFertileAge` |
| Births | cooldown random 0–5 min (mean about 2), max 4 living children per mother | `pickBirthCooldownSeconds`, `maxLivingChildrenPerMother=4` |
| Who gets the next baby | warm, well-fed (high yum) mothers are preferred | https://onehouronelife.fandom.com/wiki/Life_Stages |
| Babies forced to be girls | while the family has fewer than 4 fertile women | `minPotentialFertileFemalesPerFamily=4` (our build) |

**Food values** (wiki total = base + `eatBonus` 2). Our logs show a gooseberry giving +5.

| Food | Value | Notes |
|---|---|---|
| Gooseberry | 5 | 6 per wild bush, no regrowth |
| Wild onion | 6 | |
| Wild carrot | 7 | needs sharp stone |
| Burdock | 9 | needs sharp stone |
| Banana | 9 | |
| Cooked rabbit | 12 | |
| Berry/rabbit pies | 10–22 | |

Food sources: https://onehouronelife.fandom.com/wiki/Food, https://onehouronelife.fandom.com/wiki/Wild_Gooseberry_Bush, https://onehouronelife.fandom.com/wiki/Regeneration

**Yum and cravings**
- Each new food eaten this life raises a multiplier, and the bonus goes into a store that drains first. Cravings start at age 10. About 20 distinct foods in a life yield about 200 free food.
- Sources: https://onehouronelife.fandom.com/wiki/Yum_Bonus, `minAgeForCravings=10`, `canYumChainBreak=0`.

### 1.2 Eve's early game: the canonical order

From the wiki Eve guide (https://onehouronelife.fandom.com/wiki/Eve) and the Starting Guide (https://onehouronelife.fandom.com/wiki/Starting_Guide):

1. **Pick a camp, don't wander.** Look for a natural spring (a future well, and iron on the fault line) with gooseberries, milkweed, tule reeds, trees, soil and goose ponds in reach. A grassland/swamp/prairie border is best. Since the Feb 2019 heat change, jungle is no longer a comfortable naked spot (https://onehouronelife.com/forums/viewtopic.php?pid=46648). Wild food doesn't regrow, so an Eve who walks around eats her way through finite food and then has nothing near her babies.
2. **Make a Sharp Stone** (round stone used on a Big Hard Rock). It unlocks carrots and burdock (the high-value wild foods), cutting reeds, and shafts.
3. **Make a basket** (2 reed bundles) and a **Home Marker** (skewer + round stone).
   - The home marker is a real in-game object. The official client shows an arrow, the word "home" and the distance to it (https://onehouronelife.fandom.com/wiki/Home_Marker).
   - A child born where a marker is in view inherits it: `LivingLifePage.cpp` lines 16589 and 17252 ("Found starting home marker").
4. **Fire, because it is the heat source.** The chain:
   - **Rope:** 2 milkweed stalks make a thread, and 2 threads make a rope.
   - **Bow drill:** sharp stone on a poplar Small Curved Branch gives a Small Curved Shaft. Add rope for a Bow Drill Bow, then add a Short Shaft.
   - **Hatchet:** Short Shaft + rope, then add a sharp stone. Use it to make kindling.
   - **Lighting:** bow drill on a Long Straight Shaft gives an ember. Add a leaf, then tinder, then kindling.
   - Sources: https://onehouronelife.fandom.com/wiki/Fire_Bow_Drill, https://onehouronelife.fandom.com/wiki/Kindling, https://onehouronelife.fandom.com/wiki/Tinder
5. **Kiln and clay bowls, for water and storing berries.**
   - Round stone on clay makes a wet bowl.
   - The Adobe Kiln needs 3 adobe.
   - Water comes from ponds early, and from a well later: 10 stones on a spring, dug with an iron shovel. Sources: https://onehouronelife.fandom.com/wiki/Well_Site, https://onehouronelife.fandom.com/wiki/Shallow_Well
6. **Farming.**
   - Berry farm: flint chip on a berry gives a seed. Plant it in a Deep Tilled Row and water it; it fruits in 12 minutes with 7 berries.
   - Carrot rows: leave one row of 5 to seed.
   - Sources: https://onehouronelife.fandom.com/wiki/Domestic_Gooseberry_Bush, https://onehouronelife.fandom.com/wiki/Stone_Hoe
7. **Clothing.**
   - Reed skirt (+12% insulation).
   - Rabbit snares lead to fur clothing: coat 30%, hat 21%. Snare only *family* rabbit holes.
   - Later sheep and wool.
   - Source: https://onehouronelife.fandom.com/wiki/Clothing
8. **Gen 2–3 onward.** Sheep pen, compost, forge, then smithing: hammer, shovel (dug well), steel axe, pick, then hoe/adze/froe/shears.

How a village divides the work (Eve and Life Stages wiki pages):
- Kids tend berries.
- Adults handle pies, stew and the tech.
- Elders teach.
- A town lives or dies on water and compost.

### 1.3 Baby care as humans do it

From the Life Stages wiki page (https://onehouronelife.fandom.com/wiki/Life_Stages) and the forums (https://onehouronelife.com/forums/viewtopic.php?id=1362, https://onehouronelife.com/forums/viewtopic.php?id=3339):
- Pick the newborn up immediately.
- Name it.
- Put it down on a **warm** tile, near the fire.
- Pick it up again when it says "F" (≤2 pips); this refills it to full.
- With fire, a child can be raised on about 3 feedings.

Why babies die in human play:
- The mother wanders off.
- The tile is cold, so the baby drains 3.5× faster.
- The mother starves.

Our agents have all three.

### 1.4 Common deaths and standard advice

Sources: https://onehouronelife.fandom.com/wiki/Death and the Starting Guide.

| Cause | Standard advice |
|---|---|
| Starvation, the top cause | Stay where food is, eat high-value food, keep warm |
| Clutter: hands full, no free tile ("many a character has starved because they could not free their hands") | Keep hands and space free |
| Animals (wolf, boar, snake, bear), mosquitoes in jungle, yellow fever | Avoid them |
| Thermal shock from crossing biomes | Avoid sudden biome changes |
| Picking babies up too often | It costs the mother food |
| Babies running away | Poor etiquette: it blocks the mother from births for a while |

### 1.5 What keeps a line going

- **Several fertile, warm, fed women at once.** The game itself targets 15 players per family (`targetPlayersPerFamily=15`) and forces girls until there are 4 fertile women.
- **A fixed camp, so kids are born next to food.**
- **Lineage ban.** After about 30 minutes in a family, a player is reborn elsewhere for 1.5 h (https://onehouronelife.fandom.com/wiki/Lineage_Ban; settings `lineageLimitOneLineHours=0.5`, `OtherLine=1.5`). On a stock server, a single player can't carry a family alone. With 4 slots this limit is hit constantly, and the server falls back to ignoring it.

---

## 2. Prior work

**OHOL bots**
- Upstream `stressTestClient.cpp` only connects clients and walks them randomly: https://github.com/jasonrohrer/OneLife/blob/master/server/stressTestClient.cpp
- Hobby bots with no survival logic:
  - plannerbot (recipe-graph planner, no pathfinding): https://github.com/marius851000/plannerbot
  - https://github.com/N1teshift/ohol_bot
  - https://github.com/webmsgr/oholbotframework
- **I found no published LLM or RL work on OHOL.**

**Survival-crafting agents, and what transfers**

| Work | Technique | What transfers here |
|---|---|---|
| Voyager (https://arxiv.org/abs/2305.16291) | Automatic curriculum, a library of verified code skills, iterative prompting with environment feedback | A skill library of verified macros (`make_sharp_stone`, `make_fire`, `nurse_when_F`). A stage curriculum ("warmth before baskets"). |
| GITM (https://arxiv.org/abs/2305.17144) | Goal decomposition over a text recipe tree, structured actions, text plan memory | A "craft X" skill driven by the transition graph we already load (`GameData.transition`) |
| SPRING (https://arxiv.org/abs/2305.15486) | The LLM reads the game paper as context and answers a question chain | A condensed wiki playbook in the system prompt |
| DEPS (https://arxiv.org/abs/2302.01560) | Describe/explain failures, re-plan, prefer near goals | A death post-mortem written into cross-life lessons |
| Generative Agents (https://arxiv.org/abs/2304.03442) | Memory stream, reflection, plans | Reflection at death; daily-plan analogue = a "life plan" per stage |
| Project Sid / PIANO (https://arxiv.org/abs/2411.00114) | Concurrent fast modules plus a slow central decision; 10–1000 agents; roles emerge | Keep reflexes and macros fast and below the LLM. Specialisation needs numbers. |
| JARVIS-1 (https://arxiv.org/abs/2311.05997) | Memory of successful episodes, retrieved by situation | Retrieve successful plans by situation |
| Crafter (https://arxiv.org/abs/2109.06780), BALROG (https://arxiv.org/abs/2411.13543) | Achievement-based evaluation; LLMs weak at long-horizon survival without structure | Score achievements as milestones |

Crafter-style milestones we could score: fire, bowl, berry farm, child reaching 14, gen-3 birth. BALROG's general finding: LLMs are weak at long-horizon survival unless given structure.

**What transfers most:**
1. Fast deterministic layers under the LLM (Sid).
2. Macro skills with checked preconditions (Voyager/GITM).
3. Game knowledge in context (SPRING).
4. Post-failure reflection carried across lives (DEPS/Generative Agents).

---

## 3. Diagnosis from our logs

**Method**
- Scripts parse `events.jsonl` and `llm.jsonl`.
- Windows: showcase minutes 0–41.5 and dev minutes 0–27.7. These are the periods before the first credit-exhaustion 402.
- I read full observation→reply traces for 5 lives:
  - showcase a02/21 (Eve, died at 16.4)
  - a04/10 (Eve, 30.4)
  - a01/2 (Eve, 26.1)
  - a02/6 (child, 9.8)
  - a01/13

### 3.1 Run validity

| Run | Length | LLM calls | Failed with 402 | First 402 |
|---|---|---|---|---|
| showcase1 | 75 min | 1,696 | 778 (46%) | min 41.5 |
| dev1 | 229 min (server restarts) | 2,284 | 1,663 (73%) | min 27.7 |

After the 402s, agents keep playing on the reflex only. They never pick up babies, so every newborn dies at age 0.6. The run summaries ("37 births / 33 deaths", "most babies die when put down") are dominated by this outage.

Side observation: reflex-only Eves (no LLM, eating whenever food ≤2) lived to 41–60 years in the dev run. LLM-driven Eves died at 17–38. The reflex Eves were not nursing, so this isn't a fair comparison. It does show that **eating promptly is enough to survive cold, and the LLM's slowness and priorities are what lose the food race**.

### 3.2 Deaths (valid windows)

| | Showcase (41.5 min) | Dev (27.7 min) |
|---|---|---|
| Births (Eves / born) | 25 (7 / 18) | 9 (4 / 5) |
| Deaths | 21: 20 hunger, 1 Wild Boar | 5, all hunger |
| Eve age at death | 16.4, 20.1 (boar), 26.1, 30.4, 30.6 → median 26 | 26.4, 30.9 |
| Born-baby deaths by age | <3: 9; 3–14: 6; ≥14: 1 | <3: 0; 3–14: 3 |
| Max generation | 3 | 2 |
| Cold deaths | 0 coded as cold; cold acts through faster hunger | same |

Of the 18 born babies in the showcase:
- **3 were never picked up** (mother busy or dead).
- 1 pickup attempt failed: the mother had walked 15+ tiles away right after the birth (a01/2, "baby #3").
- The others were picked up after a median of about 15 s (range 3–33 s).
- **7 died after their mother died.**

### 3.3 Failure modes, with counts

**1. Cold, so hunger runs ×3.5.**
- Showcase: 96% of 734 adult observations at heat <0.2 (median 0.07); 0 clothed.
- Dev: 99% of 558; 6 clothed (reed skirt, worth +0.04).
- Agents mention "cold" in their thoughts, but nothing in the prompt or observation says what cold *costs*. The prompt's "Body heat matters" is too weak.
- They harvested tule six times "for skirts later" and never made one in the showcase. One reed skirt and one Fire Bow Drill were made across both runs; **no fire was lit**.

**2. Decision throughput versus drain.**
- Median latency is 5.4 s (p90 12.4 s; 154/908 calls over 10 s; max 31 s), plus the 2.5 s interval. So 1 decision ≈ 1–1.5 food pips when cold.
- Latency scales with output tokens: 4.8 s under 500 completion tokens, 8.5 s at 500–1,000, 13 s at 1,000–1,500, and 18.6 s above 1,500.
- Median completion is 370 tokens; Gemini Flash reasons by default.
- Example: child a02/6 died *during* a 27 s, 1,962-token reply while holding food.

**3. Idle holding.**
- 47 (showcase) and 33 (dev) `wait` actions while holding a baby, usually 15 s each, for 3 minutes straight. The baby is fine, but the mother drains and does nothing (traces a01/2 and a04/10).
- Overall, 216 waits took 1,926 s of agent time in the showcase window. Each slot spent about 19% of the window waiting, 159 of those waits as babies, which is expected.

**4. Forage macro bugs.**
- (a) With a tool in hand, `forage` drops it and does not re-pick it. That happened 31 and 27 times, each followed by an LLM turn to pick the tool back up, so about 60 wasted decisions.
- (b) With a baby in hand, `forage` drops the baby **where the mother stands**, walks up to 20 tiles, eats, and walks back. The baby is down for 5–15 s, and the re-pick failed 6 times in the showcase. In one case (a01/2, Charity) the baby starved because of it.
- (c) Every re-pick of a not-yet-hungry baby costs the mother 1 food and gives the baby nothing (`babyFeedingLevel` rule). 63 baby-holding forages in the showcase cost about 63 pips, roughly 7 minutes of cold-adult life across the run.

**5. Children 3–10 starve.**
- Capacity is 7–14 pips at 6.8 s, so 48–95 s per full bar. A child with 8 s decisions must eat every 6–12 decisions.
- Six showcase deaths at ages 3.0–9.8.
- In the traces, children wander off "to scout" and eat 1 carrot at a time with drop/pick tool churn.

**6. Wandering and camp choice.**
- Eves walk 15–30 tiles in their first turns, "scouting for grassland". The first baby is born while she is away (a01/2), or she settles where a previous family stripped the bushes (a02/21: "the immediate area has been stripped").
- Showcase Eves were mostly placed on the same moving-grid region, so later Eves find earlier families' empty bushes.

**7. Recipe guessing.**
- `use` → "nothing happened" in 30/234 (13%) and 25/219 (11%) of uses.
- Examples: rope on skewer; curved branch on rope; picking up flint bare-handed.
- Recipe hints only cover *held item × visible thing*. The agent has no view of multi-step chains.

**8. Spatial errors.**
- `go` "no path found" or unreachable in 18/159 (11%).
- Typical cause: walking *onto* a spring or blocking tile.
- Pathing interrupted: 8.

**9. Invalid actions and JSON.** 4/912 and 3/621 parse errors (~0.4%), and zero unknown action types. Not a problem.

**10. Token truncation.** 4 and 6 replies hit ≥1,900 of the 2,000 `LLM_MAX_TOKENS`. Rare, but those are the slowest turns.

Bottom line: the model's *knowledge and priorities* (no warmth, idle holding, wandering) and its *speed* are the main problems. Formatting and action validity are not.

---

## 4. Recommendations, ranked by impact ÷ effort

"Game change?" means a change to server rules or settings, which the proposal wants to keep rare. Everything else is agent-side.

| # | Change | Where | Impact | Effort | Game change? |
|---|---|---|---|---|---|
| 1 | Stop the run when the LLM is down | `agents/src/agent/llm.ts`, `agent.ts`, population | Data validity | XS | No |
| 2 | Correct facts and add a concise early-game playbook | `agent/prompt.ts` | High | S | No |
| 3 | Show the real food-drain rate and time-to-empty | `observe.ts` (uses `world.foodTime` from `HX`) | High | XS | No (human sees the bar draining) |
| 4 | Cap reasoning to cut latency | `llm.ts` / config | High | XS | No |
| 5 | Fix `forage`: keep the tool, carry the baby to the food | `game/body.ts` | Med-High | S | No (reflex/macro is already a noted intervention) |
| 6 | Camp/home and resource summary in the observation | `observe.ts`, `world.ts` | Med-High | S-M | No; Home Marker is an in-game object |
| 7 | Event-driven decisions: wake on baby "F", births, food thresholds; slower idle polling | `agent.ts` | Med | S | No |
| 8 | 8–12 agents and staggered rejoin | config / `population` | High for generations | S (cost ↑) | No |
| 9 | `craft <item>` macro over the transition graph | `body.ts`, `gameData.ts` | High for fire/bowls/farm | M | Beyond-human-UI, wiki-equivalent; note it in Interventions |
| 10 | Death post-mortem → persistent lessons | `agent.ts` (memoryMode), new reflect call | Med, compounding | S-M | No (players learn) |
| 11 | Try a stronger or faster model per role | config | Med-High | XS to test | No |
| 12 | Optional: turn on the stock new-player food bonus | server setting/patch | High | S | **Yes, a game setting**, though it is what the original gives newcomers |

### 1. Stop the run when the LLM is down

- **Change:**
  - On repeated 402s or quota errors, halt the run: disconnect agents and stop relogging, using the run-halt path that already exists for `maxCostUsd`.
  - Emit a `system` event, and mark the run segment invalid in `lives.jsonl` and the research snapshot.
  - Optionally, alert through the dashboard.
- **Why:** 46–73% of calls failed. The brainless period produced most of the deaths and every 0.6-year baby death.
- **Measure:** 402 count is 0 within valid runs. Analysis scripts treat the halt as the run's end.

### 2. Correct the system prompt and add an early-game playbook

- **Change:** add about 25 lines to `prompt.ts`, kept as facts and priorities, not a script. Draft (numbers from section 1):
  ```
  Survival facts:
  - Food drains 1 pip every 4+40*heat seconds (24 s at heat 0.5, ~7 s naked in grassland at 0.07).
    Being cold makes you starve ~3.5x faster. A full bar lasts ~2 min when cold, ~8 min when warm.
  - Wild food never regrows. A wild gooseberry bush has 6 berries (+5 each). Carrots +7, burdock +9
    need a sharp stone. Eat high-value food; eat different foods (variety and cravings give bonus).
  - A newborn has almost no food: if nobody holds it, it dies in ~35 seconds. Pick it up at once.
    While a woman aged 14-40 holds a baby, the baby uses no food. Picking a baby up refills it only
    when it is starving (it says "F"); otherwise it just costs you 1 food. Men and women over 40
    cannot nurse.
  - From age 3 children feed themselves but have tiny stomachs (age+4 pips): they must stay next to food.
  Priorities for an Eve (in order):
   1. Stay put near a camp: water (pond/spring) + berry bushes + milkweed + reeds + trees. Don't roam;
      your babies are born where you stand.
   2. Sharp Stone (round Stone on Big Hard Rock). 3. Warmth: a fire beats clothing (reed skirt only
      +0.04 heat). Fire chain: thread(2 milkweed) -> rope(2 thread) -> bow drill ... -> kindling + tinder.
   4. Basket, Home Marker (skewer + stone) at camp. 5. Clay bowls/kiln, then a berry farm.
  Babies: hold the newborn ~1 min, then set it down next to you on the warmest tile (by the fire)
  and work within a few tiles; pick it up when it says F. Don't stand idle holding a baby while you
  are hungry.
  Children: stay at camp, eat berries, help by fetching things; don't wander off to explore.
  ```
  - Also fix "A baby left on the ground starves in a few minutes", which is wrong; it is about 35 s for a newborn. Fix the same wording in the `observe.ts` nudge line.
- **Why:**
  - Section 1.2 is the canonical human order.
  - Logs show 0% clothed, no fire, idle baby holding, and Eves wandering.
  - The baby-feeding rule (refill only at ≤2) is not in most guides, and our forage macro burns food against it.
- **Game change?** No. Wiki-level knowledge, already listed under "Like human experience or the wiki" in the Interventions.
- **Measure:**
  - Share of adult observations with heat ≥0.3.
  - Time to first fire, bowl and berry farm.
  - Idle-holding waits.
  - Eve median age at death; target >40.

### 3. Show the real food-drain rate in the observation

- **Change:** the server already sends `HX heat foodDrainTime indoorBonus`, and `world.foodTime` holds it, but `observe.ts` never uses it. Add a line:
  - `Food drains 1 pip every 6.8 s (cold: at heat 0.5 it would be 24 s). Food 9/20 lasts ~61 s.`
  - Optionally add `Nearest food: gooseberry bush (3 left) 4 tiles away`.
- **Why:** a human sees the hunger bar shrinking. Agents today misjudge the time they have; their thoughts at 6/20 talk about "a bit longer".
- **Game change?** No. It is a UI equivalent.
- **Measure:** fewer reflex forages per life; fewer deaths with food in sight.

### 4. Cap reasoning to cut latency

- **Change:**
  - Set the provider's reasoning effort to low or none for the routine turn. On OpenRouter that is the `reasoning: {effort: "low"}` / `max_tokens` field.
  - Lower `LLM_MAX_TOKENS` to about 600.
  - Ask for `thought` of at most 1 sentence.
  - Optionally, allow a "deep think" turn only on events (birth, death, new goal).
- **Why:** latency rises from 4.8 s to 18.6 s with output length. Cold food math leaves about 7 s per pip. At least one death happened mid-think.
- **Measure:** median and p90 decision latency (target <3 s and <6 s); deaths during in-flight calls.

### 5. Fix the `forage` macro

`body.ts: forage()` has three problems:
- (a) If holding a tool, drop it on a free adjacent tile and **pick it back up after eating**.
- (b) If holding a baby, **walk with the baby to a tile next to the food**, set it down there, pick, eat, and re-pick. The baby is down for 2–3 s instead of 5–15 s.
- (c) When the baby isn't hungry, either skip the re-pick and leave it beside the mother, or say in the result that it cost 1 food.
- Also: the reflex should hand the same baby back, and report "baby left at x,y" if the re-pick fails.

**Why:** about 60 wasted decisions and 7 failed baby re-picks across the two windows, plus one baby death.
**Game change?** No.
**Measure:** baby re-pick failures (target 0); `use` actions that re-pick a dropped tool.

### 6. Camp/home and resources in the observation

**Change:**
- (a) Track the **Home Marker** like the official client does:
  - The nearest homeMarker object (`Home Marker`, `homeMarker=1`) in view at birth becomes home.
  - Placing one makes it home.
  - Show `Home: (x,y), 12 tiles NE`.
- (b) Until a marker exists, show `Your birth spot` / `Your mother's position at your birth`. The protocol gives this through absolute coordinates; the client doesn't, so it is marginally beyond the UI. Keep (b) optional.
- (c) Add a "Resources within 20 tiles" summary:
  - berries left (sum of bush counts)
  - water (ponds/springs)
  - nearest fire or heat source
  - ground heat of the current biome versus neighbours, e.g. "jungle to the east is hot"
- (d) **Family knowledge:** a Home Marker built by an ancestor is inherited in the real client by children born in view of it. That *is* true to the game, so it is the legitimate way to give a family a "home". Teach Eves to build one early (rec 2).

**Why:**
- The camp concept (section 1.2, wiki Eve guide).
- Eves wander and settle on stripped areas.
- Children wander off "scouting" and starve.

**Game change?** (a), (c) and (d) no. (b) is minor and should be noted in Interventions.
**Measure:**
- Mean distance of family members from home.
- Fraction of births within 10 tiles of home.
- Child (3–14) survival.

### 7. Event-driven turns

**Change:**
- Wake an agent immediately on: own baby born, nearby baby saying "F", own food crossing 50% and 25%, a heat change >0.15.
- Babies: a turn only on events. A baby's useful actions are saying "F" and not jumping, so babies could even say "F" automatically at ≤2 food (beyond human? A human baby must type it. It is a convenience; flag it).
- Adults: the 2.5 s interval is fine; latency dominates.

**Why:**
- Babies made 174 decisions (159 waits) in the showcase window.
- Mothers miss the ~35 s newborn window: 3 of 18 newborns were never picked up.

**Measure:** time from birth to first pickup (target <8 s); LLM cost per life.

### 8. Population: run 8–12 agents and stagger rejoins

**Why 4 is too few:**
- With 4 slots, every death immediately respawns as a baby of the 1–2 fertile women. Their workload rises exactly when food is lowest.
- There is no slack for specialisation.
- The lineage-limit fallback keeps sending the same players back into the same family.

**The demographic constraint:**
- A girl needs 14 minutes to become fertile.
- A mother needs about 3 minutes of attention per baby.
- Births come about every 2 minutes per mother.
- A line survives only if each generation raises at least one girl to 14 while 1–2 adults keep the camp fed and warm.

**Minimum viable population estimate: about 8–12 concurrent agents in one family.**
- 2–3 fertile women each raising one baby at a time.
- 3–5 children and teens near camp eating and fetching.
- 2–3 adults or elders on fire, bowls and farm.
- Below about 6, one starvation breaks the line, as observed.
- The stock game's own targets (15 per family, 4 fertile women) suggest 15+ for a robust village, and 15 also switches on Eve windows, languages and birthlands.

**Change:**
- `AGENT_COUNT=8`, then 12.
- Add an agent-side rejoin delay: a dead slot waits 30–90 s, or until some fertile woman is not holding a baby. This is a player choosing when to log in, not a rule change.

**Measure:** the generation reached, and the number of girls reaching 14 per hour.

**Starting setup ("20 Eves at once")**
- Stock settings can do it: `forceAllPlayersEve=1` (`server.cpp` ~10682). That is a game-setting change, toggled for the first logins.
- Eves are placed on the **Eve moving grid** (`useEveMovingGrid=1`, `eveMovingGridJump=50`), so you get many separate one-woman camps, not a village.
- `forceEveLocation` puts them all on one tile, where they strip the wild food. The README already reports that this starved about 100 lives.
- Without settings, simultaneous logins mostly produce an alternating Eve/baby pattern. This is my reading of the code, not tested:
  - The first login is an Eve.
  - The next becomes her baby.
  - Then birth cooldown plus `maxBabyAdultRatio=1.0` and `maxBabyMomRatio=1.0` force new Eves.
- **Recommendation:** don't start with 20 Eves. Start 1–2 Eves and stagger the other logins by 1–2 minutes so babies arrive at a rate mothers can absorb.

### 9. A `craft <item>` macro over the recipe graph

**Change:**
- An action `{"type":"craft","target":"Fire"}`. Code searches the loaded transition graph (`GameData`) for a plan using items visible within 20 tiles.
- It executes step by step, re-checking after each step.
- It returns progress, or "missing: Long Straight Shaft (none in view)".
- Start with a whitelist:
  - Sharp Stone
  - Thread, Rope
  - Basket
  - Reed Skirt
  - Home Marker
  - Fire Bow Drill, Fire
  - Wet Clay Bowl
  - Kindling
- Optional: the macro surfaces the next step instead of executing it (a hint mode), which is closer to a human with onetech open.

**Why:**
- 11–13% of `use` attempts did nothing (recipe guessing).
- The fire chain is 10+ steps, and at 8 s per decision with 7 s per pip the LLM can't afford to explore it.
- Voyager and GITM show skill libraries are what unlock deep tech.

**Game change?** No. It goes beyond a human's UI (it automates clicks) but is equivalent to wiki/onetech knowledge. Add it under "Beyond a human player".
**Measure:** time to first fire per Eve; the number of distinct crafted items per run; the "nothing happened" rate.

### 10. Death post-mortems carried across lives

**Change:**
- At death, one cheap LLM call summarises "why I died, what I'd do differently" from the last 20 history lines and the notebook.
- Store it in `pastLifeNotes` (persistent mode), deduplicated.
- Cap it at about 10 lessons.

**Why:**
- Human players improve across lives; this is "player experience", not world knowledge.
- DEPS and Generative Agents show reflection helps.

**Game change?** No.
**Measure:** A/B per-life against persistent memory; Eve lifespan over lifeIndex.

### 11. Model choice

See section 5.

### 12. Optional game-setting lever: the new-player food bonus

**Change:** grant `personalFoodDecrementSecondsBonus` (stock +18 s per pip for new players). It would need the stats server on, or a small patch to apply it without one.

**Why:** on official servers every real newcomer gets this. At heat 0.07 it takes drain from 6.8 to 24.8 s per pip. That is the same relief as a perfect temperature.

**Caveat:** **this changes the game relative to veterans**, so treat it as a declared experimental condition. Prefer recs 2–9 first.

---

## 5. Model capabilities and candidates

What the failures say matters, in order:

1. **Latency / throughput.** The binding constraint is about 7 s of cold food per pip. Fast models with reasoning off or low beat smart slow ones for routine turns.
2. **Prioritisation and instruction following.** The agent must follow a playbook ("warmth first, don't wander, don't idle") and juggle hunger against tasks. A stronger model helps here, especially once rec 2 is in place.
3. **Multi-step planning over recipes.** Today this is weak (13% failed uses). It is better solved with the `craft` skill (rec 9) than with a bigger model.
4. **Spatial reasoning over coordinates.** It matters moderately: 11% of `go` failures, and choosing nearby food or camp. The camp/resource summaries (rec 6) reduce the load.
5. **JSON reliability.** Already fine (~0.4% errors).
6. **Long context.** Not needed. The prompt is about 3k tokens.

A smarter model would help with (2), but only if it stays fast. Suggested design: a fast model every turn, plus an occasional slow "planner" call on events (birth, death, every ~60 s) that sets a goal or plan the fast model follows.

**Candidates.** Leave pricing to the cost analysis.

| Model | Type | Role |
|---|---|---|
| `google/gemini-3.8-flash` (current) | closed | Baseline. Run it with reasoning capped (rec 4) before switching. |
| Claude Haiku 5.5 (`claude-haiku-5-5`, OpenRouter `anthropic/claude-haiku-5.5`) | closed | Fast, strong instruction following; the per-turn actor |
| Claude Sonnet 5.5 (`claude-sonnet-5-5`) | closed | The event-driven planner, or the Eve slot only |
| `deepseek/deepseek-v4-flash` (named in the README) | open-weight | Cheap per-turn actor |
| A Qwen3-class instruct MoE, or gpt-oss-120b | open-weight | Per-turn actor; low latency on fast hosts. Check current versions on OpenRouter |

**Measure:** run the same seeded conditions per model and compare decision latency, Eve lifespan, child survival and generations.

---

## 6. Scorecard to track per run

Valid minutes only, stopping at the first LLM outage.

- Eve median age at death.
- Share of babies reaching 3, and of children reaching 14.
- Maximum generation, and the number of girls reaching 14 per hour.
- Adult observations with heat ≥0.3 (%).
- Time to first fire, bowl and berry farm; distinct items crafted.
- Decision latency, median and p90.
- Decisions per food pip.
- `use` actions that did nothing (%).
- Baby re-pick failures.
- Births within 10 tiles of home (%).

**Target for "an established settlement":** a gen-4+ birth at a camp with a fire, bowls and a berry farm, and at least 3 adults living there at once.
