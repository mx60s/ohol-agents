# Tech-tree red team: timing and mechanics traps

**Date:** 2026-11-16 · **Data:** `data/game-data.json.gz` (via `agents/src/game/gameData.ts`), raw `OneLifeData7` transition/object files, `OneLife/server/server.cpp`, `map.cpp`, `transitionBank.cpp`, stock server settings plus `server/settings/*.ini`. **Code:** `integrate` at `ad71f5d`. Analysis only; scripts live in `/tmp/techtree-audit/` (not in the repo).

## How to read the numbers

- **D** is a window in *game* seconds. The wall-clock window is D·k.
- **Decisions in window** = D·k / cycle. A cycle is one LLM decision; `DECISION_CYCLE_MS` is a minimum gap, so a 7–10 s Qwen turn makes the effective cycle 8–10 s.
- **R** = how many *new* decisions must happen inside the window (with `ACTION_LIST_MAX` = L). Actions chained in one list cost ~0.3–1 s each plus walking, so R = 0 means "fits in one list".
- **Verdict:** IMPOSSIBLE if decisions < R, **marginal** if < R + 2 (one slow turn or one wrong action loses it; measured turn p90 is ~17 s), OK otherwise.
- **Walking is not dilated in game time.** Agents walk 3.75 tiles per *game* second at any k. TIME_SCALE only buys back the LLM's thinking time.
- **Action counts** come from a plan-order simulation of the cheapest recipe from natural materials. It reuses tools, counts pick-up and drop actions, and builds everything from scratch (`/tmp/techtree-audit/sim.ts`). These are idealized lower bounds: they assume perfect ordering, no failures, and 0.8 game-s of walking per action plus 43 s per trip to another biome. "% of life" is measured against half of a productive life: (60 − 3 years) × 60 s × 0.5 = 1710 game-s. The other half goes to food, babies and talk.

## Ranked traps

Settings column abbreviations: k = TIME_SCALE, c = cycle in seconds, L = ACTION_LIST_MAX. Fix classes: **F** = harness friction removal (OK to do), **G** = declared game-setting change, **E** = would make the game easier than for a human (avoid).

| # | Tech | Mechanism | Numbers | Verdict tonight (k=3, c 8–10, L=3) | Recommended fix (class) |
|---|---|---|---|---|---|
| 1 | Fire (gates kiln, cooking, warmth, iron) | Ignition chain. Ember Shaft lasts **10 s** → Ember Leaf lasts **10 s** → Smoldering Tinder (5 s) → Burning Tinder lasts **10 s**, so kindling must land 5–15 s after lighting. The shortest manual sequence from holding the drill is: drill on shaft, swap drill for leaf, leaf on Ember Shaft, Ember Leaf on tinder. That's 4 actions, one more than L=3, and the kindling step can't be in the same list because Kindling on *Smoldering* Tinder has no transition. | R=1 for each 10 s window. Decisions in window: k1: 2.0 (c5) / 1.0 (c10); k2: 4.0 / 2.0; k3: 6.0 / 3.0 (3.8 at c8) | **OK to marginal** (k=1 marginal; k=2 with c10 marginal) | L=4 puts the Ember chain in one list (F). Add a list step "wait until target becomes X (≤ N s)", or make a `use` on a tile in a known timed pre-state wait for the next state (F; a human watches the tinder catch). The craft macro already handles both. |
| 2 | Fire, via the craft macro | **Perishables gathered too early.** Leaf and Juniper Tinder both vanish **120 s** after gathering, held or not (held items decay at the normal rate; dropping keeps the timer). The planner gets the target first unless it decays within 30 s, and when it reverses the order for a fast target it builds the target's *whole subtree* after the actor. So Leaf is picked before the whole bow drill (37 actions) and Juniper Tinder 42 actions before use. | Macro: ~42 actions ≈ 34 game-s of walking + 3 decisions → OK at k≥2, marginal at k=1 if the LLM does anything in between. Manual (14 decisions): k1 c10 **IMPOSSIBLE** (12 available), k1 c5 OK (24), k3 OK (36–72) | **OK** at k=3; at k=1 tinder rots and the plan silently restarts | In `craft.ts` `extract()`: build the fast target's ingredients first, then the actor, then the final step. Treat anything with 0 < D ≤ 300 s (Leaf, Juniper Tinder, Gooseberry Seed) as gather-last (F). |
| 3 | Fire upkeep | **The fire dies and the observation never says so.** Fire lasts 60 s, then Hot Coals 120 s, then Ashes 120 s, then nothing. Ashes can't be relit. With the drill kept, relighting costs about 6 transitions (shaft, leaf, tinder, kindling) plus the 10 s windows of trap 1. Kindling on Fire gives Large Fast Fire (+60 s); Firewood or a Butt Log gives Large Slow Fire (+240 s). | A kindling is needed every ≤180 s: 54–108 decisions per window at k=3 | **OK numerically, behaviourally marginal**: nothing prompts it | Show timers in the observation: "Fire (burns down in about 7 turns)", "Hot Coals (ash in about 15 turns)". `turnsText()` exists (F; a human sees the flames shrink). |
| 4 | Cooking | **Food on Fire burns.** Skewered Rabbit, Goose or Fish on Fire gives *Burnt* X. You must cook on **Hot Coals**, which exist only 60–180 s after the last kindling. Hot Flat Rock (tortillas) lasts 120 s. | Coals window 120 s (36–72 decisions at k=3) | **marginal (knowledge)**: the YOU COULD line does show "get Burnt Rabbit", which helps | Prompt line: "cook on Hot Coals, not Fire; fire burns food" (F; wiki knowledge). |
| 5 | Every macro craft at k>1 | **Macro budget is in wall time, not scaled by k.** `maxMs = max(30 s, 8·cycle)` (`agent.ts:537`) is 64–80 s. At k=3 walking is 1.25 tiles per wall-second, so 12 steps of ~3 tiles each need ~60–90 s and routinely stop "out of time". A 60-game-s wait (planner limit `MAX_DECAY_WAIT_S`) is 180 s wall and can **never** finish inside one call. | 12-step call ≈ 24 protocol actions ≈ 58 s wall walking alone at k=3 | **marginal** (wastes a decision per call, so roughly halves macro throughput) | `maxMs = max(30 s, 8·cycle) · timeScale` (F). |
| 6 | Water, bowls, farming | **Water is far and needs a fired container.** Natural water is the Canada Goose Pond, in **swamp** only (with Wild Boars), or rare Natural Springs (chance 0.1). A Clay Bowl needs an Adobe Kiln, Wooden Tongs and fire: **81 transitions / 160 actions**. The alternative, a Water Pouch, needs rabbit fur and a bone needle. The prompt lists "clay bowls fired for water" as a camp priority as if it were cheap. | Bowl of Water ≈ 206–340 game-s idealized (12–20% of productive life at k=3) | **OK for a dedicated adult; a multi-person project in practice** | Prompt: name the true chain length and suggest splitting it (F). |
| 7 | Kiln / pottery | **The kiln burns 30 s.** Firebrand (taken from a live Fire) lasts 60 s and must be carried to a Wood-filled Adobe Kiln, then Firing Adobe Kiln → Adobe Kiln after **30 s**. The wet bowl must already be **in Wooden Tongs** (a hidden second tool). [firebrand on kiln, swap for tongs, tongs on kiln] fits one L=3 list if the tongs lie side-adjacent. A second bowl per firing needs another decision inside 30 s. The kiln should sit within ~10 tiles of the fire. | R=1 for a 2nd item: 9–18 decisions at k=3 (3–6 at k=1) | **OK** | Observation timer on Firing kiln (F); prompt: "wet clay goes in with Wooden Tongs" (F). |
| 8 | Food supply | **The prompt's "wild food never regrows" is wrong, and so is the strategy it implies.** An Empty Wild Gooseberry Bush **regrows 600 s after watering** (Bowl of Water or Water Pouch); unwatered it stays empty forever. A Domestic Gooseberry Bush (7 berries) goes Empty → **120 s** → Languishing, which needs a Bowl of Soil (Dry), then a Bowl of Water (Vigorous) → 480 s → full. Left alone it goes Languishing → 1800 s → Dying → 1 epoch (3600 s) → Dead. Gooseberry Seed rots in 300 s. | Per 7 berries: 2 bowl trips (~8 actions) per 600 s | **OK in timing, wrong in knowledge** | Fix the prompt line (F). |
| 9 | All food, long run | **Food value falls each generation** (stock settings: `eatCostMax` 5, `eatCostGrowthRate` 0.1, `eatBonus` 2 halving every 4 gens). The prompt quotes generation-0 values. | Gooseberry pips: gen0 5, gen4 4, gen8 2–3, gen12 2, gen16+ 1. Carrot: 7 → 2 at gen20. Cooked rabbit: 12 → 7 at gen20 (table below) | **Trap after ~10 generations**: berry-only families starve | Decide and declare: keep stock (intended pressure toward farming and cooking) or set `eatCostMax=0` (G). In both cases, compute the real value client-side from generation for the prompt (F). |
| 10 | Survival / danger | **One bite is death.** An animal on your tile hits with certainty (no roll). The wound kills in **60 s** (`deathStaggerTime`); a second hit halves it. The only cure is a Sterile Wool Pad, which needs sheep and wool, so it's unreachable early. Wild Wolf, Boar and Rattle Snake *flee* the nearest player (move=2). They jump up to 4 tiles every 3 s (snake every 10 s), so bites happen when a path crosses them or they flee into you. A Hungry Grizzly chases. Mosquito Swarms (jungle, map chance 0.5, random walk every 3 s) give Yellow Fever, which **locks the hands for 35 s**. | Pathing avoid radius = deadly + 1 = **2 tiles**, but animals jump 4. Zones are recomputed per leg (≤15 tiles ≈ 4 game-s, which allows 1–2 jumps). The observation has **no danger line**; the only warning is a note after the walk. | **marginal** (rare, but always fatal) | List DANGER animals with distance in the observation and say "a bite kills in ~N turns, no cure yet" in the prompt (F). Avoid radius 4–5 for 3 s movers (F). Don't remove animals or auto-heal (E). |
| 11 | Iron / smithing | **Every hot step lasts 10 s** (about 50 recipes: Hot Iron Bloom in tongs → on Flat Rock → hammer with a Stone, plus axe, hoe and shovel heads, ingots, crucibles). Firing Forge lasts 30 s, like the kiln. Placing the bloom on a Flat Rock leaves Tongs in hand, so it takes swap + use: 4 actions from the forge. | R=1 at L=3, R=0 at L=4. Decisions: k1 1–2, k2 2–4, k3 3–6 | **OK to marginal** | L=4 (F). |
| 12 | Iron (source) | **The iron source is rare.** Iron Ore comes from a Muddy Iron Vein: map chance 0.01, badlands (wolves), on a 40-tile grid. It needs a Well Site and spring water before ore can be dug; later veins need a Steel Mining Pick (steel bootstraps from the first ore). | Wrought Iron 179 transitions / 365 actions; Smithing Hammer 240 / 485; Steel Axe 268 / 539 | **Multi-life**: 47–85% of a productive life for Wrought Iron alone, >100% for a Hammer at k=1 manual; real LLM efficiency is several times worse | Needs inherited camps and tools; no fix (by design). |
| 13 | Long chains in general | Idealized game time per tech is in the table below. Fire alone is 5–16% of productive life. Kiln, bowl and water are 11–35%. Carrot farm 29–55%, domestic berry farm 56–83% (including 725 s of growth waits that can overlap other work). | | **Fire and clothing are one-life techs; pottery and farming are one-life only for a focused adult; iron needs several generations** | Cooperation and persistence (notebook, camp marker) are the levers (F). |
| 14 | Farming (carrots) | **Carrots go to seed in 300 s.** Planting needs a Deep Tilled Row (Skewer or Stone Hoe on Fertile Soil Pile), a Carrot Seed Head and water. Then 120 s + 120 s growth to a Carrot Row (5 carrots). After **300 s** it becomes Seeding Carrots (seeds only, no food). The last carrot leaves a Hardened Row that must be re-tilled. Wheat doesn't spoil once ripe. | Harvest window 90–180 decisions at k=3 | **OK if someone is there**; a planted-and-forgotten crop is lost | Observation timer on crops in view (F). |
| 15 | Sheep / wool / healing | **A domestic lamb starves in 60 s.** Domestic Lamb → Hungry after 30 s → Dead after 60 s unless fed a *Bowl of Gooseberries and Carrot* (bowl + carrot farm first). Mouflon flee and live in badlands with wolves. | 60 s: 18 decisions at k=3, 6 at k=1 c10 | **OK** at k=3, but needs bowl + carrot + berries ready first | Prompt / recipe hint (F). |
| 16 | Observation horizon | The THINGS list covers radius 12, at most 20 kinds and 2 coordinates per kind. The biome is shown for your own tile only. The craft macro plans from radius **20**, so the LLM and the macro disagree about what is "in view". Raw materials are spread across biomes: fire needs grassland (Maple, Poplar, Milkweed, Juniper); clay, reeds and water need swamp; Flat Rock needs badlands or desert; rabbits need prairie. In busy grassland the 20-kind cap can hide a needed resource. | | **marginal** for anything needing two biomes | Show biomes within the visible radius and their direction (F; humans see ground colour). Never truncate kinds the current craft goal needs (F). Don't add a map-wide resource finder (E). |
| 17 | Newborns / nursing | (From `time-scale.md`.) An unheld newborn lasts 35 s cold; a set-down baby with 1 pip, 8.75 s. Under 10 you can't pick up a baby; under 3 you can't do transitions that leave your hand empty. | 35 s: 3.5 decisions at k1 c10, 10–21 at k=3 | **OK** at k=3 | Prompt: "children under 10 can't carry babies" (calibration saw 24 failed pickups) (F). |
| 18 | Tools | Wear is random, not a fixed count (`useChance`): Stone Hatchet 10% per use (~50 uses expected), Skewer 50% (~8), Stone Hoe 20% (~25), Steel Axe 4%. "(4/5 left)" counts use-steps, not uses. The bow drill never wears out. | | OK | Prompt mention optional (F). |
| 19 | Placement / containers | Use, drop and take-out reach only the 4 side neighbours (`body.ts` handles this). Dropping on an occupied tile throws the item to the nearest free spot, or **deletes it** if there is none. Containers don't slow decay in this data (`timeStretch=1` everywhere), so a basket doesn't keep tinder fresh. | | OK | none needed |

### Food value per bite across generations (stock settings)

The server rounds with `lrint` (half-to-even), so the generation-8 bonus is 0, not 1. Gooseberry is then 2 at gen 8, not 3 as below.

| generation | eatCost | eatBonus | gooseberry (3) | carrot (5) | cooked rabbit (10) | cooked goose (15) |
|---|---|---|---|---|---|---|
| 0 | 0 | 2 | 5 | 7 | 12 | 17 |
| 4 | 0 | 1 | 4 | 6 | 11 | 16 |
| 8 | 1 | 0–1 | 2–3 | 4–5 | 9–10 | 14–15 |
| 12 | 1 | 0 | 2 | 4 | 9 | 14 |
| 16 | 2 | 0 | 1 | 3 | 8 | 13 |
| 20 | 3 | 0 | 1 | 2 | 7 | 12 |
| 30 | 4 | 0 | 1 | 1 | 6 | 11 |

## Decision windows by setting

Decisions available (D·k/c), with the verdict at L=3:

| window | D (game s) | R (L=3) | k=1, 5s | k=1, 10s | k=2, 5s | k=2, 10s | k=3, 5s | k=3, 8s | k=3, 10s |
|---|---|---|---|---|---|---|---|---|---|
| Ember Leaf → tinder (R=0 at L=4) | 10 | 1 | 2.0 marginal | 1.0 marginal | 4.0 OK | 2.0 marginal | 6.0 OK | 3.8 OK | 3.0 OK |
| Burning Tinder catch, 5–15 s after lighting | 10 | 1 | 2.0 marginal | 1.0 marginal | 4.0 OK | 2.0 marginal | 6.0 OK | 3.8 OK | 3.0 OK |
| Ember Shaft, leaf not adjacent (R=0 at L=4) | 10 | 1 | 2.0 marginal | 1.0 marginal | 4.0 OK | 2.0 marginal | 6.0 OK | 3.8 OK | 3.0 OK |
| Hot iron/steel on Flat Rock (R=0 at L=4) | 10 | 1 | 2.0 marginal | 1.0 marginal | 4.0 OK | 2.0 marginal | 6.0 OK | 3.8 OK | 3.0 OK |
| Firing kiln/forge, 2nd item | 30 | 1 | 6.0 OK | 3.0 OK | 12 OK | 6.0 OK | 18 OK | 11 OK | 9.0 OK |
| Yellow Fever / lamb gets hungry | 30 | 2 | 6.0 OK | 3.0 marginal | 12 OK | 6.0 OK | 18 OK | 11 OK | 9.0 OK |
| Newborn unheld (cold) | 35 | 2 | 7.0 OK | 3.5 marginal | 14 OK | 7.0 OK | 21 OK | 13 OK | 10.5 OK |
| Wound → death (needs a healer with a pad) | 60 | 3 | 12 OK | 6.0 OK | 24 OK | 12 OK | 36 OK | 22 OK | 18 OK |
| Firebrand carried to kiln | 60 | 1 | 12 OK | 6.0 OK | 24 OK | 12 OK | 36 OK | 22 OK | 18 OK |
| Leaf / Juniper Tinder life, manual 42-action gap | 120 | 14 | 24 OK | 12 **IMPOSSIBLE** | 48 OK | 24 OK | 72 OK | 45 OK | 36 OK |
| Hot Coals cooking | 120 | 2 | 24 OK | 12 OK | 48 OK | 24 OK | 72 OK | 45 OK | 36 OK |
| Fire alive without kindling | 180 | 1 | 36 OK | 18 OK | 72 OK | 36 OK | 108 OK | 68 OK | 54 OK |
| Carrot Row harvest | 300 | 2 | 60 OK | 30 OK | 120 OK | 60 OK | 180 OK | 113 OK | 90 OK |

Reading it: **k=1 is only workable at a 5 s cycle and fails at 10 s. k=2 with a 10 s cycle is marginal on every 10 s window. k=3 clears every window at a 5–10 s cycle**, with the 10 s windows at 3–3.8 decisions against R=1. L=4 removes R for three of the four 10 s windows.

## Critical path per tech (idealized)

Columns give game-seconds, with % of productive life (1710 game-s) in parentheses. "Manual" = 3 actions per decision; "macro" = 12 transitions per call, ×1.5 for re-plans.

| tech | transitions | protocol actions | timed waits | manual k=1, 8s | manual k=3, 8s | manual k=3, 10s | macro k=1, 8s | macro k=3, 8s | macro k=3, 10s |
|---|---|---|---|---|---|---|---|---|---|
| Basket | 7 | 13 | 0 s | 72 (4%) | 45 (3%) | 48 (3%) | 49 (3%) | 37 (2%) | 38 (2%) |
| Reed Skirt | 11 | 22 | 0 s | 103 (6%) | 60 (4%) | 66 (4%) | 60 (3%) | 46 (3%) | 47 (3%) |
| Fire, from nothing | 38 | 76 | 5 s | 274 (16%) | 135 (8%) | 152 (9%) | 144 (8%) | 92 (5%) | 96 (6%) |
| Cooked Rabbit (fire + snare) | 64 | 126 | 95 s | 553 (32%) | 329 (19%) | 357 (21%) | 340 (20%) | 258 (15%) | 264 (15%) |
| Firing Adobe Kiln (incl. fire) | 71 | 139 | 5 s | 514 (30%) | 263 (15%) | 294 (17%) | 265 (16%) | 180 (11%) | 186 (11%) |
| Clay Bowl | 81 | 160 | 5 s | 586 (34%) | 298 (17%) | 334 (20%) | 302 (18%) | 204 (12%) | 211 (12%) |
| Bowl of Water | 82 | 163 | 5 s | 597 (35%) | 303 (18%) | 340 (20%) | 306 (18%) | 206 (12%) | 213 (12%) |
| Rabbit Fur Hat | 96 | 193 | 125 s | 842 (49%) | 495 (29%) | 539 (32%) | 495 (29%) | 380 (22%) | 388 (23%) |
| Carrot Row (incl. bowl) | 96 | 187 | 245 s | 941 (55%) | 605 (35%) | 647 (38%) | 608 (36%) | 494 (29%) | 502 (29%) |
| Domestic Gooseberry Bush (incl. bowl) | 97 | 194 | 725 s | 1422 (83%) | 1075 (63%) | 1118 (65%) | 1087 (64%) | 963 (56%) | 972 (57%) |
| Wrought Iron | 179 | 365 | 125 s | 1457 (85%) | 806 (47%) | 888 (52%) | 807 (47%) | 590 (34%) | 605 (35%) |
| Smithing Hammer | 240 | 485 | 175 s | 1923 (112%) | 1059 (62%) | 1167 (68%) | 1061 (62%) | 772 (45%) | 792 (46%) |
| Steel Axe | 268 | 539 | 225 s | 2160 (126%) | 1200 (70%) | 1320 (77%) | 1212 (71%) | 884 (52%) | 907 (53%) |

Raw materials (from scratch):
- **Fire:** 4 Maple branches, 1 Big Hard Rock + 2 Stones, 8 Milkweed, 1 Juniper, 1 Lombardy Poplar (all grassland).
- **Clay Bowl:** adds 4 Clay, 3 Tule Reeds (swamp) and 1 Flint.
- **Wrought Iron:** about 15 Stones, 7 Clay, 6 Reeds, 22 Milkweed, 12 Maple, 2 Flat Rocks, 1 Muddy Iron Vein and a spring.

Calibration runs show real models are several times slower than these bounds. Kimi lit fire at 2.9 years; Haiku never did in 10 years. So treat **fire and clothing as one-life techs, kiln/bowl/farm as one focused life or a family project, and iron as multi-generation**. The Newcomen engine is out of scope.

## What agents are and aren't told

Sources: `prompt.ts`, `observe.ts`, `reply.ts`, `steps.ts`.

- **Not shown:** decay timers, anywhere. You only find out after the fact ("had become X").
- **No warning about dangerous animals.** The prompt never mentions danger, wounds or healing.
- **YOU COULD** (≤8 lines) shows only one-step transitions of the held item on visible kinds. It shows no timed transitions, no second tool, and no chains. It does show "get Burnt Rabbit", which hints at trap 4.
- **Missing from the prompt:** hot coals vs fire, fire burning out, kiln timing, tongs, watering wild bushes (it says the opposite), soil for domestic bushes, generation food decline, lamb feeding, tool wear, and the age limits on carrying babies.
- **Not modelled by the planner:** `useChance` (it assumes deterministic wear). It excludes timed steps over 60 s and permanent actors, so crops and iron-vein steps aren't plannable. Its 30 s "fast" threshold misses the 120 s perishables (trap 2).

## Fixes by class

**Harness friction removal (do):**
1. `ACTION_LIST_MAX=4` (traps 1 and 11). A human clicks those 4 in ~3 s.
2. Planner order: build a fast target's ingredients first, gather perishables (D ≤ 300 s) last (trap 2).
3. Scale the craft macro's `maxMs` by `timeScale` (trap 5).
4. A "wait until X becomes Y (≤ N s)" list step, or auto-wait on a known timed pre-state (trap 1, tinder catch).
5. Observation timers for timed objects in view or held: fire, coals, firing kiln/forge, crops, Hot items, Burning Tinder (traps 3, 7, 14).
6. A DANGER line with animal distance, and a wider avoid radius for 4-tile jumpers (trap 10).
7. Prompt knowledge parity (wiki facts): cook on coals; feed the fire; water wild bushes (fix "never regrows"); soil + water for domestic bushes; tongs for firing; 2-minute tinder and leaf; bite = death; under-10s can't carry babies; real food values for the agent's generation (traps 3, 4, 7, 8, 9, 10, 15, 17).
8. Biomes visible within view radius; never truncate kinds the current goal needs (trap 16).

**Declared game-setting changes:**
- `TIME_SCALE=3` (already declared; see `time-scale.md`).
- Decide on `eatCostMax` / `eatBonus` (keep stock = intended late-generation pressure; or `eatCostMax=0`) and write it down (trap 9).

**Would make the game easier than for a human (avoid):**
- Editing individual decay timers in the data (e.g. Ember Leaf 10 → 30 s). Use global TIME_SCALE instead.
- Macro automation that keeps fires fed or farms watered on its own.
- Removing animals, auto-healing wounds, or perfect auto-flee.
- A map-wide resource locator beyond what a screen shows.

## Recommended settings for tonight's Qwen3-32B run (turns ~7–10 s)

| setting | value | why |
|---|---|---|
| `TIME_SCALE` | **3** | Every window clears at a 8–10 s effective cycle: 10 s windows get 3.0–3.8 decisions against R≤1. k=2 is marginal at 10 s turns; k=1 fails. k=4 adds slack but makes a life 4 wall-hours. |
| `DECISION_CYCLE_MS` | **8000** | It is a minimum gap. With 7–10 s turns the effective cycle is 8–10 s; 10000 would only add idle time. |
| `ACTION_LIST_MAX` | **4** | Puts the full Ember chain (drill → swap → leaf → tinder) and the hot-forge sequence in one list. Calibration showed models already try longer lists. |
| `CRAFT_MACRO` | **1** | The macro handles the 5–15 s tinder catch and gets the order mostly right. Land the `maxMs × timeScale` fix first if possible; without it, expect roughly half the macro throughput at k=3. |

If only one code change lands before tonight, make it the `maxMs` scaling. Second choice: the planner's perishable ordering. The prompt corrections (coals, watering, fire burning out) are the cheapest wins after that.
