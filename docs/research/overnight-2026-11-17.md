# Overnight watchdog log, 2026-11-16/17 (run pilot1-r1-mwkdnbvz)

Settings: TIME_SCALE 3, DECISION_CYCLE_MS 8000, ACTION_LIST_MAX 4, CRAFT_MACRO 1, AGENT_COUNT 10, INITIAL_EVES 2. Agents on self-hosted Qwen3.8-27B-FP8 (RunPod H200 `oiiihblxzrzz8l`, $5.29/h). Times are PT.

## 23:40 check 0 (baseline)
- Run started 23:34 (07:34Z). Status running, llmStatus ok. Alive: a01 Eve AURORA WILLOW 14.3, a02 baby AURORA II 0.3 (gen 2), a03 Eve LUMEN ASH 14.3; the other 7 slots join ~every 90 s.
- vLLM: /v1/models ok (`m` = Qwen3.8-27B-FP8, max_model_len 16384); pod running, uptime 17 min. RunPod balance $112.56, spend $5.32/h.
- LLM: 24 calls, latency p50 2.6 s / p90 3.1 s, 0 errors, 0 empty, all finish=stop. Reasoning tokens pinned at 299 (the vLLM thinking budget), so most reasoning is truncated by design.
- Inventions: Sharp Stone (23:35, LUMEN ASH).
- Notes: run limits read `maxRuntimeMin 90, maxGeneration 3, maxLives 40` with `continuous: true`. Checked `population.ts`: continuous mode skips all three, so no halt.

## 00:08 check 1
- Run running, llm ok. 10/10 alive: Eves a01 AURORA WILLOW 25, a03 LUMEN ASH 24.9; gen-2 children 1.3–10.9 (a02 10.9, a04 NEMA ASH 10.3). Births 7 (a04–a10), deaths 0. All heat 0.07 (no fire yet).
- vLLM ok, pod uptime 48 min, GPU 100%. Balance $109.45.
- Inventions (16): Sharp Stone 23:35; Thread, Rope, Bow Drill Bow, Long Straight Shaft, Short Shaft 23:43; Fire Bow Drill 23:44; Reed Bundle 23:52; Reed Skirt, Pile of Yew Branches 23:55; Stone Hatchet 23:56; Kindling, Small Curved Shaft 23:57; Stakes 23:58; Tied Short Shaft 23:59; Kindling Pile 00:00.
- LLM: 1097 calls, p50 2.8 s / p90 3.4 s / max 7.3 s, 0 errors, 0 empty, all stop; reasoning tokens 299 (budget). Narration 20 lines, focus switched 3 times.
- Actions 849, ~32% failed (use 159/247 "nothing happened", feed 56/57).
- Issues:
  1. **Fire chain misstated in the prompt** ("Kindling ... on tinder lit with a Fire Bow Drill"). Agents use the drill directly on tinder/kindling: a04 used (-278,58) 16x holding the drill on Juniper Tinder ("Stand on tinder tile and use the drill on it." -> nothing happened); a02 18x on (-446,-99); a01 "use drill on kindling from my tile". Real chain (game data): drill on Long Straight Shaft -> Ember Shaft (10 s); Leaf on it -> Ember Leaf (10 s); Ember Leaf on Juniper Tinder -> Smoldering (5 s) -> Burning Tinder (10 s); Kindling on Burning Tinder -> Fire. Nobody tried `craft Fire`. F (knowledge parity).
  2. **"I GIVE YOU THIS" misstated** as handing over the held item. Server: youGivingPhrases transfer property ownership only. Children tried to hand tinder/stones to mothers via `feed` ~40x (a05 11x tinder on #2, a06 9x on #4) and said GIVE/I GIVE ~45x. F.
  3. **`{"action":{"type":"actions","actions":[...]}}`** rejected as unknown type: 13 turns lost, all clear lists (a03 "drop the branch so I can pick her up"). F (parser).
  4. Children under 10 pick_up_baby -> bare "nothing happened" (a06 6x on #9). Server minPickupBabyAge=10. F (explain).
- Action: commit 63506c2 (parser unwrap; prompt fire chain + give phrase facts; pickup-age and use-on-person failure reasons; tests 312/312). Hot update 00:11, all 10 reconnected.

## 00:42 check 2
- NOTE: the 00:11 hot update opened a new log dir for the same run: `/data/logs/pilot1-r1-mwkdnbvz-2026-11-17T08-11-13-834Z/` (each agents restart does this). Narration also lives in `narration.jsonl`.
- Run running, llm ok, appVersion 20261117T081058Z-63506c2. 10/10 alive. Eves 36.2. Gen 3 now born (CYPRESS WILLOW, LUNA WILLOW). Heat up to 0.73 by the fire.
- **FIRE at 00:22** (AURORA II WILLOW, gen 2): Ember Shaft 00:19, Ember Leaf + Smoldering Tinder 00:21, Fire 00:22, Large Fast Fire 00:23. Also Pile of Straight Branches 00:15, Pile of Sharp Stones 00:16, Sugarcane Bundle 00:18. (Fire came 11 min after the prompt fix.)
- Births 3, deaths 3, all animals: ZAYAH ASH 12.0 (Wolf, 00:21), ZAYAH II ASH 9.2 (Wolf, 00:22), AURORA III WILLOW 17.6 (Wild Boar, 00:36).
- LLM 1917 calls, p50 2.9 s / p90 3.5 s / max 6.2 s, 0 errors/empty. vLLM ok, balance $106.35. Narration 20, focus 11 changes.
- Actions 1094, 39% failed; 286 "use ... nothing happened" (hatchet 39, Short Shaft 31, tinder 30, kindling 26, leaf 23). The `actions` wrapper error appeared once more (00:14, before reconnect finished?), then none.
- Issues:
  1. **Branch trees indistinguishable.** `Maple Tree#Branch` (63) and `Maple Tree` (48, branch taken; regrows by epoch decay) both display as "Maple Tree"; same for Poplar and Yew. The macro said "missing (none in view): Maple Tree (branch)" while a04 stood next to a "Maple Tree" and used a hatchet on it 16x. The hatchet use was also poor play (branches are bare-hand), but the agent could not tell the tree had no branch, which a human sees. F.
  2. **Healing myth.** The wound line said "unless someone heals you" with no means. Dying kids and mothers spent 86 replies on "Milkweed bandage" (LUMEN ASH left camp to find milkweed; ZAYAH: "Bleeding; crawl north to find mom LUMEN or her milkweed"). Only a Sterile Wool Pad treats Bite Wound/Hog Cut (unreachable this early, so the deaths are game, not harness). F (fact).
  - Poor play, not harness: Short Shaft used on tinder/rocks (a07 14x), Leaf on Juniper Tinder (a01).
- Action: commit c8b7afb (wound healer names + branch suffix; tests 314/314). Hot update waits until after 01:11 (1/h rule).

## 01:03 check 3
- Run running, llm ok. 10/10 alive; Eves AURORA WILLOW and LUMEN ASH 43.4. Births 0, deaths 0 since 00:42. Ash family keeps a fire at (-345,4) (heat 0.22–0.86 near it); Willow camp (-450,-117) is still cold (0.07).
- Inventions: Yew Shaft 00:46; Flint Arrowhead, Flint-tipped Bow Drill, Wheat Sheaf 00:51; Firebrand 00:59; Home Marker, Skewer 01:02.
- LLM 1152 calls, p50 2.9 s / p90 3.5 s; one outlier 16.7 s with 1599 reasoning tokens (budget overshoot, a01 00:5x), 0 errors/empty. vLLM ok; balance $104.58.
- Actions 869, 49% failed; "use ... nothing happened" 322.
  - a04 NEMA ASH is still stuck on the branchless Maple (-264,58): 36 more uses plus 31 `craft Long Straight Shaft` ("missing (none in view): Maple Tree (branch)"). The branch regrows only on epoch decay. This is issue 1 of check 2; fix c8b7afb is pending deploy.
  - a03/a07: Kindling on Large Fast Fire 40x, "nothing happened" (no transition; only Butt Log/Firewood upgrade a Large Fast Fire). The prompt says kindling on Fire/Hot Coals, which is correct. Poor play, not harness.
- Action: hot update 01:12, c8b7afb live, all 10 reconnected.

## 01:43 check 4
- Third log dir after the 01:12 restart: `...T09-12-26-896Z`. Run running, llm ok, 10/10 alive. Eves 56.6 (both die of age at 60, ~01:55). No births/deaths since 01:12 (population at the 10 cap).
- Both camps now have fire: Willow fire (-430,-92) from 01:2x (heat 0.39–0.5); Ash fire at (-345,4), now Hot Coals.
- Inventions: Basket 01:19, Goose Feather 01:31 (LINETH ASH).
- LLM 1912 calls, p50 3.0 s / p90 3.7 s / max 8.2 s, 0 errors/empty, reasoning 299. vLLM ok; balance $101.03 (~$3.5/h burn observed).
- Branch fix works: macro steps now read "bare hands on Maple Tree (with branch)"; a04 left the bare Maple.
- Actions 1263, 50% failed; "use ... nothing happened" 492/687 uses. Biggest: Kindling on the Willow fire (-430,-92). Timeline: 8 successes ("Fire -> Large Fast Fire") vs ~70 failures by a02/a09/a10/a05, all Kindling on an already Large Fast Fire (no transition). The fire never died, so this is not impossible-world, just a bare "nothing happened" with no reason. Same for a04 Ember Leaf on a Juniper *Tree* (20x) and drill on (-190,69).
- Action: commit f0ad2ec: `use` failures with no game transition for held+target now say "(a Kindling does nothing on a Large Fast Fire)"; tests 315/315. Deploy after 02:12 (1/h).

## 02:13 check 5
- Run running, llm ok. 9 alive + a03 waiting to respawn. Gen 4 born (AURORA V WILLOW, CYPRESS II WILLOW). Oldest now NEMA ASH 52.3 / AURORA II 52.9.
- Births 4, deaths 5: AURORA WILLOW 60.0 (age, 01:52), LUMEN ASH 60.0 (age, 01:52), LINETH ASH 34.8 (hunger, 02:07), RIVA ASH 45.4 (hunger, 02:09), a03 child 5.9 (hunger, 02:11).
- Inventions: Burning Tinder 01:57 (TRAVIEN WILLOW). Fire is going in the Willow camp (-430,-92).
- LLM 1802 calls, p50 2.9 s / p90 3.6 s / max 5.6 s, 0 errors/empty. vLLM ok; balance $98.37.
- Ash camp hunger deaths at (-345,4). Reflex forage: "no food you can pick by hand within 20 tiles". They held only Wild Squash / Wild Potato Tubers (food 0 in game data; squash needs a Stone -> Squash Seeds, tubers are for planting). LINETH: "I am starving, so I must eat the tubers I am holding" -> "the Wild Potato Tubers is not food". No harness fault: the harness reports correctly and nobody walked beyond 20 tiles. Poor play plus a depleted area. Note for the user: the prompt says "Don't roam" (camp priority 1), which may be anchoring starving agents to an empty camp. Changing that is steering, so I left it.
- Parser: the `actions` wrapper still came through with other keys: `{"type":"actions","steps":[...]}` (a07, starving: "Drop the unusable squash, then forage") and `"items"` (a04). Fixed in 6e6f24e.
- Action: hot update 02:14 with f0ad2ec (no-transition reason on `use`) + 6e6f24e; all 9 living reconnected.

## 02:45 check 6
- Log dir `...T10-14-42-589Z`. Run running, llm ok. 7 alive, 3 slots waiting (FAMILY_ROOM hold: the only fertile woman is the new Eve LUMEN EMBER 19.9). Willow elders: LUNA 47.4 (food 1), AURORA IV 51.6, TRAVIEN 53.9 (Bite Wound, dying), CYPRESS 42.6. **Ash line extinct** (NEMA ASH died). New Eve LUMEN EMBER (family EMBER) at 02:27 at (-533,-36). Gen 5 reached at 02:36 (a03, died 2.8).
- Births 5, deaths 7: hunger 6 (CYPRESS II WILLOW 5.8, ROSE WILLOW 4.3, a06 7.6, NEMA ASH 59.1, AURORA V WILLOW 14.7, a03 2.8), age 1 (AURORA II WILLOW 60.0).
- Inventions: none new.
- LLM 1636 calls, p50 2.9 s / p90 3.5 s / max 5.2 s, 0 errors/empty. vLLM ok; balance $95.72.
- f0ad2ec works: "nothing happened (a Stone Hatchet does nothing on a Maple Tree)" etc. ~100 of 376 failed uses now carry the reason. The healer fact also reached TRAVIEN ("final plea for the pad").
- **Famine** around both old camps: reflex forage "no food you can pick by hand within 20 tiles" before every hunger death. What's left is wheat (Ripe Wheat -> Wheat Seed Head, not food; bread needs threshing + baking), Cold Goose Egg (needs a Hot Flat Rock, not Hot Coals; a06 7.6: "cook the goose egg on the coals" -> "does nothing on a Hot Coals"), Wild Potato Tubers (planting only). No water within 20 tiles of the Willow camp, so the wild bushes can't regrow. Checked against game data: the harness is correct, and nobody walked out of the depleted area. This is not impossible-world, but it is the main killer now. **User decision:** prompt camp priority 1 says "Don't roam: babies are born where you stand". Every starving agent stayed put. Possible F/G: a fact that wild bushes don't regrow without water. Already in the prompt ("an empty wild bush fruits again ~N turns after you water it"). Left as is.

## 03:16 check 7
- Run running, llm ok, 10/10 alive. Families: EMBER (Eve LUMEN EMBER 30.1, 5 kids at (-530,-37)); FERN (Eve AURORA FERN 19.6, 02:59, at (-562,42)); WILLOW down to CYPRESS 52.8 (alone, lit an Ember Shaft by himself). Generation depth this run: 5.
- Births 7, deaths 5: TRAVIEN WILLOW 54.4 (Wolf, after a Bite Wound), LUNA WILLOW 48.2 (hunger), LUNA BERRY 18.4 (hunger; Eve spawned 02:48 at the depleted old Ash camp (-346,5)), a10 child 5.0 (hunger), AURORA IV WILLOW 60.0 (age).
- Inventions: Pile of Stakes 03:01.
- LLM 1623 calls, p50 2.8 s / p90 3.4 s / max 5.0 s, 0 errors/empty. vLLM ok; balance $93.05.
- Issue: **baby drop refused by the harness.** LUNA BERRY (Eve, starving, holding a baby): "drop -> no empty spot nearby to drop on" (2x at (-346,5)). Body.drop() with no x,y needed an empty tile, but server.cpp DROP sets a baby down on any non-blocking tile. F. Fixed in 5a2ce4e (+test, 316/316), hot update 03:17, all 10 reconnected. (Her death was mostly the depleted spawn spot, which is G/server Eve placement: a new Eve can spawn inside an eaten-out old camp. Note for the user.)
- The new reasons show the Ember family's fire confusion is knowledge, not harness: "a Fire Bow Drill does nothing on a Ember Shaft", "a Leaf does nothing on a Long Straight Shaft".
- Children under 10 now read "you can't carry a baby until you are 10" (13x) instead of a bare failure.

## 03:48 check 8
- Log dir `...T11-17-58-468Z`. Run running, llm ok, 10/10 alive: EMBER family 7 (Eve LUMEN EMBER 40.8), FERN family 3 (Eve AURORA FERN 30.3). **Willow line extinct** (CYPRESS WILLOW 60.0, age, 03:37). Fire near (-460,9) (heat 0.86).
- Births 1, deaths 1 (age). No hunger deaths: the new families are in fresh land.
- Inventions: Wooden Tongs 03:29; Fertile Soil Pit, Basket of Soil 03:30; Two Curved Shafts 03:32; Pile of Short Shafts 03:39; Threshed Wheat, Straw, Weak Skewer 03:46.
- LLM 1819 calls, p50 2.9 s / p90 3.5 s / max 5.5 s, 0 errors/empty. vLLM ok; balance $89.96 (~$5.3/h, ~16 h left).
- Actions 1679, 41% failed. Fire-chain confusion (drill on Ember Shaft 19x, tinder on shaft/drill/tree ~37x) is knowledge; the results now name each pair. 33 bare "drop ... nothing happened", mostly onto occupied tiles (a10 tinder onto a Juniper Tree / an Empty Gooseberry Bush). Fix 6a87557: drop failure on an occupied non-container tile now says so (, tests 317/317). Deploy after 04:17.

## 04:19 check 9
- Run running, llm ok, 10/10 alive (EMBER 7, FERN 3). Eves LUMEN EMBER 51.2, AURORA FERN 40.7. Fires burning at both camps (heat 0.23–0.55).
- Births 0, deaths 0, inventions 0 in this window.
- LLM 1637 calls, p50 2.9 s / p90 3.7 s / max 6.0 s, 0 errors/empty. vLLM ok; balance $87.30.
- Behaviour: lots of `wait` (about 1/3 of replies since 03:17). Agents stand at the fire holding Kindling and wait for "Large Fast Fire -> Fire" (39 tries of Kindling on a Large Fast Fire, now explained in the result). Narrator: "everyone is so busy waiting for someone else to put a stick on the fire". Poor play, not harness: the observation shows "(becomes Fire in N turns)".
- Action: hot update 04:19 with 6a87557 (drop-onto-occupied reason); all 10 reconnected.

## 04:50 check 10
- Log dir `...T12-19-54-463Z`. Run running, llm ok, 10/10 alive (EMBER 7, FERN 3). Gen 3 is the deepest alive. FERN camp fire (-565,54) heat 0.86.
- Births 1, deaths 1: LUMEN EMBER 60.0 (age, 04:45; first Eve of the EMBER line).
- Inventions: Pile of Arrowheads 04:31, Pile of Letter Stock 04:32, Pile of Yew Shafts 04:41.
- LLM p50 2.9 s / p90 3.7 s, 0 errors/empty. vLLM ok; balance $84.63.
- Issue: **craft macro gives no reason** on ~70 of 139 failed crafts: "can't make Rope from what you can see. Recipe: Thread on Thread" with no missing list (a02 had 1 Milkweed Stalk in view; Rope needs 4). explainMissing() stopped at the first in-view copy. F. Fixed in 688989a: a counted walk names the shortage ("missing: more Milkweed"); tests 318/318. Deploy after 05:19.

## 05:22 check 11
- Run running, llm ok, 10/10 alive. FERN Eve AURORA FERN died 60.0 (age, 05:17); births 1 (gen 4). The population is aging: 7 of 10 are 43–57, and only AURORA II EMBER (34.6) is a fertile woman, so births will thin out.
- Inventions: Two Shafts 05:07. LLM 1854 calls, p50 3.0 s / p90 3.8 s, 0 errors/empty; balance $81.54.
- EMBER camp has had no fire for >1 h (heat 0.07). The failed uses are knowledge, now spelled out in the results: "Ember Leaf does nothing on a Juniper Tree" (19, wants Juniper Tinder), "Leaf does nothing on a Long Straight Shaft" (14, needs the Ember Shaft first), "Fire Bow Drill does nothing on a Ember Shaft" (10). Not harness.
- Action: hot update 05:22 with 688989a (craft shortage reason); all 10 reconnected.

## 05:53 check 12
- Log dir `...T13-22-50-428Z`. Run running, llm ok. 9 alive + a02 waiting (family-room hold: CORALEI EMBER 22.0 is the only fertile woman). Ages: 4 at 54–60, AURORA II EMBER 44.9, 3 children. FERN line (2 women, 54.6 and 56.8) will end within ~10 min wall.
- Births 1 (gen 4), deaths 2 (LORECE EMBER 60.0, AURORA EMBER 60.0, age). No inventions.
- LLM 1622 calls, p50 2.9 s / p90 3.6 s, 0 errors/empty. vLLM ok; balance $78.88.
- 688989a works: "craft Fire Bow Drill ... missing: more Milkweed" (24x), "craft Rope ... missing: more Milkweed".
- Open item, not fixed: `craft Fire` still fails with no reason (9x), as do Kindling (4) and Long Straight Shaft (2). The usual-recipe walk finds nothing short, so the extraction search itself gives up (top-3 options per item, budget 3000, MAX_DEPTH, asActor/permanence rules). Offline with the radius-12 inventory from the observation I get a proper reason ("missing: Maple Tree (with branch)"), so the failing case depends on objects at radius 13–20. Needs the exact inventory logged to debug. For the morning.

## 06:24 check 13
- Run running, llm ok, 10/10 alive, all EMBER. **Gen 5 reached** (5 babies of AURORA III EMBER 22.1, the only fertile woman). Adults: AURORA II EMBER 55.2, LUMEN II EMBER 60 (see below). **FERN line extinct** (both daughters 60.0, age).
- Births 7, deaths 6: age 4 (SOLA EMBER, AURORA III FERN, AURORA II FERN, ALEY EMBER), hunger 2 (CORALEI EMBER 25.0 at the EMBER home (-493,-63), "no food you can pick by hand within 20 tiles"; a03 child 2.8).
- Inventions: Letter Stock 06:08.
- LLM 1208 calls, p50 2.8 s / p90 3.3 s / max 5.1 s, 0 errors/empty. vLLM ok; balance $76.22.
- LUMEN II EMBER has been "age 60.0" for >30 min and still acts ("Rest at the fire spot until death"). Server: allowGhosts=1, ghostChance=0.01 (stock), so she became a surviving ghost (age fixed at 60). Game feature, not harness. The observation still says "Age 60.0 of at most 60"; minor, left as is.
- The famine pattern repeats at each home after ~1.5 h: hand food within 20 tiles runs out, no water to regrow bushes, and nobody moves.

## 06:56 check 14
- Run running, llm ok, 10/10 alive, all EMBER: 7 of gen 5 (ages 5.6–15.9), 2 of gen 4 (20.6, 23.6), AURORA III EMBER 32.7, ghost LUMEN II 60. Fire near (-289,-9) (heat 0.28–0.67).
- Births 1, deaths 1 (AURORA II EMBER 60.0, age). Hunger deaths 0.
- **Pottery started**: Wet Clay Bowl 06:30, Wet Bowl in Wooden Tongs 06:32 (AURORA II EMBER). There's no kiln yet; the agents tried the wet bowl on a Large Fast Fire 9x (no transition; the reason is shown). Kiln timing is trap #7 in techtree-audit.md, so watch it.
- LLM 1779 calls, p50 2.9 s / p90 3.5 s / max 5.7 s, 0 errors/empty. vLLM ok; balance $73.56.
- Failed actions down to 32%. No new harness issues.

## 07:12 fix (coordinator report)
- **Hand-freeing needed an adjacent empty tile.** forage: "couldn't free your hands next to the food: no empty spot nearby to drop on" (LUMEN ASH 00:06/00:07, NEMA ASH 00:11, AURORA FERN 03:10 x2). Craft blocked setting down an arrowhead (AURORA II EMBER 06:23/06:31). drop() without x,y checked only own + 4 side tiles. Server rule holds: an item needs an empty tile (DROP isMapSpotEmpty), but a player steps aside to find one. F. Fixed in db4e4aa: drop() walks next to the nearest empty walkable tile within 3 steps. forage and the craft macro use it. 2 tests, verified failing without the fix; 320/320. Hot update 07:12, all 10 reconnected.
- **Side effect of the 07:12 hot update** (found by the coordinator): the ghost LUMEN II EMBER (pid 22, past presumedEndAt) failed the sameBody check, so her reconnect was recorded as a birth. Because pid 22 <= maxPid, epochStart moved to 07:12. Every later reconnect (AURORA III, SHAINA, KILN, AVALA, LUNA, a10 baby) was then recorded as a new motherless life ".2:<pid>" with its own lineage, and the originals got lostAt 07:12. The game is fine; only the life records are split. The coordinator is fixing lives.ts and owns the next hot update. **Hot updates on hold** until they say otherwise.
- Resolved by the coordinator: e364a21 deployed 07:27 (sameBody trusts the reported age; healSplitReconnects() merged the 7 split copies, 12 lineages -> 5, Ember = 22 lives). **Counting note:** events.jsonl has 7 fake "birth" events at 07:12. Take birth/death totals from /api/lives. Hot updates resume; the hourly limit counts from 07:27.

## 08:10 check 15 (counts from /api/lives)
- The timer notification came late, so this check is ~40 min after the planned 07:27. Log dir `...T15-27-55-919Z` (coordinator deploy e364a21). Run running, llm ok, 10/10 alive, all EMBER. **Gen 6 reached** (LUNA II, SPARK, NURMUHAMMAD, WESTAN EMBER). Fires at (-266,17) and (-535,-84) (heat 0.4–0.72).
- Since 06:56: births 5, deaths 5, **all hunger**: EVELINDA 15.1 (07:05), AURORA III 38.1 (07:12, the only fertile mother at 06:24), SHAINA 21.6 (07:13), KILN 24.0 (07:25), AVALA 28.6 (07:45; "Cold Goose Egg is not food" -> reflex forage "no food ... within 20 tiles"). Same famine pattern at the (-289,-9) camp.
- Run totals (/api/lives): 48 lives, 38 dead: hunger 20, age 14, Wolf 3, Wild Boar 1.
- Inventions: Two Curved Branches 07:30.
- LLM 2310 calls, p50 2.9 s / p90 3.4 s; one call overran the thinking budget (2000 reasoning tokens, finish=length, empty reply, 18.5 s). 0 errors. vLLM ok; balance $66.91.
- No new harness issues. Remaining failures are fire-chain knowledge (Ember Leaf/Leaf on a Juniper Tree 37, Kindling on a Large Fast Fire 31) and are explained in the results.

## 08:41 check 16
- Run running, llm ok, 10/10 alive (EMBER; slots full, so no births). Births 0, deaths 0, inventions 0. Fires at (-266,17) and (-535,-84).
- LLM 1630 calls, p50 2.9 s / p90 3.5 s / max 4.1 s, 0 errors/empty. vLLM ok; balance $64.25.
- Failures are knowledge-level and explained (Kindling on a Large Fast Fire 32, Stone Hatchet on a Poplar/Yew with branch 34; bare hands take branches). No harness issues. The narrator says LUMEN II "finally" died, but she is a living ghost (narrator inaccuracy, cosmetic).

## 09:11 check 17
- Run running, llm ok, 10/10 alive. **Gen 7 reached** (ASH EMBER 4.5). New Eve NOVA CLOUD (family CLOUD) at (-312,-6).
- Births 4, deaths 4: CORALEI II EMBER 60 (age), LUMEN III EMBER 60 (age), the ghost LUMEN II EMBER (hunger at 60, 08:56), SPARK EMBER 27.3 (hunger, 09:08). SPARK tried to skewer and cook a Cold Goose Egg (it needs a Hot Flat Rock) while reflex forage said "no food ... within 20 tiles". Knowledge plus famine again.
- Run totals: 52 lives, 42 dead: hunger 22, age 16, Wolf 3, Wild Boar 1.
- Inventions: Broken Small Stone Tool 08:49.
- llm.jsonl rotated at 09:07 (to llm.jsonl.1, 33.5 MB). My fetcher now handles rotation. The 221-call sample: p50 2.9 s / p90 3.4 s, 0 errors. vLLM ok; balance $61.59.

## 09:30 final check
- Run running, llm ok, 10/10 alive: EMBER 7 (gen 5–6, oldest SOL 57.0), CLOUD 3 (Eve NOVA CLOUD 21.0 plus 2 babies). Deaths since 09:11: LUNA EMBER 56.7 and ASH EMBER 7.2 (gen 7), both hunger.
- Run totals (/api/lives, 23:34–09:30): **54 lives, 44 deaths: hunger 24, age 16, Wolf 3, Wild Boar 1.** Max generation 7. Oldest age 60 (16 lives reached it; one ghost).
- LLM last window: 1045 calls, p50 2.9 s / p90 3.5 s, 0 errors. Whole night: 0 LLM errors, 0 outage minutes, p50 ~2.9 s, p90 ~3.5 s. 3 calls overran the 300-token thinking budget (max 2000 tokens, 18.5 s, 1 empty reply).
- RunPod: one pod `oiiihblxzrzz8l`, 10.2 h up. Balance $112.56 (23:37) -> $59.82, spent $52.74 (~$5.2/h).
- Harness commits tonight: 63506c2, c8b7afb, f0ad2ec, 6e6f24e, 5a2ce4e, 6a87557, 688989a, db4e4aa (mine); e364a21 (coordinator, lives.ts).
