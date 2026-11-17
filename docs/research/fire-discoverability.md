# Can a new player discover fire from the observation alone?

**Date:** 2026-11-17 · **Branch:** `integrate` · **Data:** `data/game-data.json.gz` via `GameData` · **Client reference:** `.ohol-build/OneLife/gameSource/LivingLifePage.cpp` (hint pane), `transitionBank.cpp` (object depth).

**Setup assumed:** `CRAFT_MACRO` off, no recipes in the system prompt, `RECIPE_HINTS=1`, `TIME_SCALE=3`, `DECISION_CYCLE_MS=8000` (effective 8–10 s per turn), `ACTION_LIST_MAX=4`. Everything was checked offline with `GameData` and `FakeGame`/`Body`. No LLM, GPU or server was used.

## Verdict

- **Before this change, no.** You could do the slow part of the chain (thread, rope, bow drill, hatchet) by following the held-item hints. The 10-second ignition steps were effectively hidden. Nothing pointed from the Fire Bow Drill or the Ember Shaft to the Leaf. The Ember Leaf's use only showed if Juniper Tinder already happened to be on the ground in view. Kindling only showed against Burning Tinder if you already held Kindling.
- **After this change, mostly yes.** We now show what the client's hint pane shows a human. You can find every step by clicking forward. The first ignition attempt will probably fail, because the Ember Leaf's 10 s window is too short to fetch tinder that isn't already placed. Failure costs almost nothing, though. The Ember Shaft turns back into a Long Straight Shaft, the Ember Leaf back into a Leaf, the drill never wears out, and Juniper Trees give unlimited tinder. The second attempt can lay everything out first.
- **Once known, it is doable at k=3 with L=4.** The whole ignition takes two action lists of four clicks each, with large margins (table below).
- **What is still missing:** a backward search. A human can type `/fire` in the client to see the chain that leads to fire. Our agent can only explore forward from what it holds (gap G4).

## How the hints worked (before the change)

`recipeHints()` in `agents/src/agent/observe.ts`:
- It lists only transitions where the **held item (or bare hands) is the actor**. It never shows uses where the held item is the target.
- It only considers the **nearest tile of each visible kind**, within radius 12. A target that isn't on the ground in view is never mentioned.
- It stops at **8 lines** (`MAX_HINTS`), nearest kind first. "eat" and "wear" lines count toward the 8.
- It never shows timed transitions. Timers are on the THINGS lines and the Holding line instead ("becomes Long Straight Shaft in about 4 turns").

What the human client shows (`LivingLifePage.cpp`):
- **When you pick something up**, the hint pane lists *all* its uses (`getAllUses`), as actor **and** as target, whether or not the other object is on screen. Decay and category transitions are left out (`getTransHintable`), there is one entry per other object, and the most basic other object comes first (`getObjectDepth`). You page through them.
- **After a use that leaves your hand unchanged** (or empty), the pane switches to the thing you just changed (lines ~25380–25430). For example, after drilling, it shows what goes on the Ember Shaft. **After a click that does nothing**, it shows the clicked object's uses.
- **`/word` filter:** shows the transitions that lead to the named object.

## The chain, verified against the data

Both rope and thread are needed. Bow Drill Bow is **Rope** on Small Curved Shaft, and Tied Short Shaft is **Rope** on Short Shaft. So you need 8 Milkweed Stalks, which make 4 Thread, which make 2 Rope. The hatchet takes a Sharp Stone in. Ember Shaft, Smoldering Tinder and Burning Tinder are **permanent**: they sit on the ground and can't be picked up. So the Long Straight Shaft and the Juniper Tinder must be on the ground when used.

Columns:
- **Hint before:** the in-view, actor-only hints (before).
- **Hint now:** after this change.
- **Window:** at k=3 with an 8 s turn (game s × 3 / 8). Walking is 3.75 tiles per game second at any k, which is 1.25 tiles per wall second, or about 10 tiles per turn.

| # | actor (held) | target | result | hint before | hint now | window | feasible |
|---|---|---|---|---|---|---|---|
| 1 | bare hands | Milkweed / Flowering / Fruiting Milkweed (grassland, mapChance 2) | Milkweed Stalk (+ Milkweed Debris) | yes if in view and among the nearest 8 bare-hand kinds (the 3 milkweed phases count as 3 kinds) | same | none (the plant cycles phases every 20 s, and every phase gives a stalk) | yes |
| 2 | Milkweed Stalk | Milkweed Stalk on the ground | Thread | only if a stalk is already on the ground in view | yes: the held stalk's list has one line, "use it on a Milkweed Stalk (none in view): … becomes Thread" | none | yes |
| 3 | Thread | Thread on ground | Rope | only if one is on the ground | yes (first in Thread's list) | none | yes |
| 4 | Stone | Big Hard Rock | Sharp Stone (rock stays) | yes if the rock is in view | yes (first in Stone's list) | none | yes |
| 5 | bare hands | Maple Tree (with branch) / Lombardy Poplar Tree (with branch) | Straight Branch / Small Curved Branch | yes if in view (8-line cap) | same | none | yes |
| 6 | Sharp Stone | Straight Branch on ground | Long Straight Shaft | only if the branch is on the ground in view; Sharp Stone has 73 uses, so it's not in its first page | yes from the branch side: holding a Straight Branch shows "a Sharp Stone used on it" (2nd line) | none | yes |
| 7 | Sharp Stone | Small Curved Branch on ground | Small Curved Shaft | same as 6 | yes, from the branch side | none | yes |
| 8 | Sharp Stone | Long Straight Shaft on ground | Short Shaft | in view only | yes, from the shaft side (Long Straight Shaft's list, 4th line) | none | yes |
| 9 | Rope | Small Curved Shaft on ground | Bow Drill Bow | in view only | yes: Rope's list (4th line), and the shaft's list ("a Rope used on it") | none | yes |
| 10 | Short Shaft | Bow Drill Bow on ground | Fire Bow Drill | in view only; holding the bow showed nothing (it has no actor uses) | yes: the bow's list is "a Short Shaft used on it" first | none | yes |
| 11 | Rope | Short Shaft on ground | Tied Short Shaft | in view only | yes, from the Short Shaft side (3rd line) | none | yes |
| 12 | Sharp Stone | Tied Short Shaft on ground | Stone Hatchet (stone used up) | in view only | yes: Tied Short Shaft's list is "a Sharp Stone used on it" first | none | yes |
| 13 | Stone Hatchet | Straight Branch / Small Curved Branch / shafts | Kindling (hatchet wears: ~10% per use) | in view only | yes (first lines of the hatchet's list) | none | yes |
| 14 | bare hands | Juniper Tree (grassland, prairie) | Juniper Tinder (tree stays; unlimited) | yes if in view | same | **tinder gone after 120 game s = 45 turns**, held or not | yes; gather it in the last ~40 turns |
| 15 | bare hands | Maple / Poplar Tree | Leaf | yes if in view | same | **Leaf gone after 120 s = 45 turns** | yes |
| 16 | Fire Bow Drill | Long Straight Shaft **on the ground** | Ember Shaft (drill stays) | only with a Long Straight Shaft on the ground in view | yes: the drill's list has it first even with none in view | none before; the Ember Shaft lasts **10 s = 3.75 turns** | yes |
| 17 | Leaf | Ember Shaft | Ember Leaf + Long Straight Shaft back | **no**, unless already holding a Leaf during the 3.75-turn window. Holding the drill showed nothing about the Ember Shaft | **yes**: "on the Ember Shaft you just made (x, y): a Leaf -> get Ember Leaf …" (the client's hint follows the changed target); also Leaf's list has it first | **3.75 turns** (30 wall s, 37 tiles of walking) | yes if a Leaf is placed or a tree is within ~8 tiles (see below) |
| 18 | Ember Leaf | Juniper Tinder **on the ground** | Smoldering Tinder + Leaf back | **only if tinder is already on the ground in view** | **yes**: "use it on a Juniper Tinder (none in view): get Leaf, it becomes Smoldering Tinder" (its only use) | Ember Leaf lasts **10 s = 3.75 turns** (Holding line shows the timer) | yes with tinder placed; first try without tinder usually no |
| 19 | (time) | Smoldering Tinder | Burning Tinder after **5 s = 1.9 turns** | timer on the THINGS line | same | | |
| 20 | Kindling | Burning Tinder | **Fire** | only if already holding Kindling | yes: Kindling's list (4th line); and a failed click on the Burning Tinder now says "what works on it: a Kindling (…becomes Fire)" | Burning Tinder lasts **10 s = 3.75 turns**, so kindling must land 15–45 wall s after lighting; then Spent Tinder | yes with kindling placed |

Wrong combinations (feedback, `Body.use`):
- A held item with no transition said "nothing happened (a Leaf does nothing on a Smoldering Tinder)". That was already clear.
- It now adds the client's hint for the clicked thing: "…does nothing on a Burning Tinder; what works on it: a Kindling (uses up the Kindling, it becomes Fire)".
- Bare hands on a permanent object with no bare-hand use used to say only "nothing happened". It now says "bare hands do nothing on a Big Hard Rock; what works on it: a Stone (you get Sharp Stone); …".
- Kindling on Smoldering Tinder (too early) says "does nothing" with no list, because nothing works on Smoldering Tinder. The THINGS line already says "becomes Burning Tinder in about 2 turns".

## Timing of the ignition, at k=3

Decay times come from the data: Ember Shaft 10 s, Ember Leaf 10 s, Smoldering Tinder 5 s, Burning Tinder 10 s, Leaf and Juniper Tinder 120 s. In wall time that is 30 / 30 / 15 / 30 / 360 s. A list step costs about 0.3–0.5 wall s for the server round trip, plus walking at 1.25 tiles per wall second. The `wait` action takes 1–4 turns and is allowed in a list.

**A player who knows the chain** lays it out first: Long Straight Shaft on the ground, and a Leaf, Juniper Tinder and Kindling on tiles next to it. Then two lists:
1. Drill on the shaft, swap the drill for the Leaf, Leaf on the Ember Shaft, Ember Leaf on the tinder. That is 4 clicks, about 2 wall s, well inside every window.
2. On the next turn (+8–10 s wall the tinder is still smouldering), send `wait` 1, swap the Leaf for the Kindling, Kindling on the tinder. Or send the swap now and the use on the turn after. Kindling must land 15–45 wall s after lighting. That gives 2–3 turns of slack.

Leaf and tinder have 45 turns, so laying them out has room to spare. **Feasible, with margin.**

**A player discovering it the first time:**
- **Turn T:** drill on the shaft (the hint shows it).
- **T+1:** about 3 game s gone, about 2.6 turns left. The hint now names the Leaf. If a Leaf is on the ground: [drop or swap the drill, take the Leaf, Leaf on the Ember Shaft], 3 clicks. If not, a Maple or Poplar within ~8 tiles: [drop the drill, bare hands on the tree, Leaf on the Ember Shaft], about 16 tiles of walking, which is about 4.3 game s. Tight but feasible. If it fails, the shaft simply returns.
- **Holding the Ember Leaf:** the hint now names Juniper Tinder. Without tinder on the ground, it takes [drop the Ember Leaf, bare hands on the Juniper Tree, drop the tinder, pick up the Ember Leaf] and then [Ember Leaf on tinder]. That is 5 clicks over 2 turns, about 6 game s plus walking. It only works if a Juniper Tree is within ~5 tiles. Usually the leaf goes out, and the player now knows to place tinder first.
- **Burning Tinder without Kindling ready:** making Kindling takes [take the hatchet, hatchet on a branch, swap the hatchet for the Kindling, Kindling on the tinder], 4+ clicks, and is only possible if the hatchet and a branch are next to the tinder. Usually the tinder is spent. The failed click names Kindling, so the next attempt works.

A first-time player should expect two or three ignition attempts. Each one costs only a few turns and a tinder.

## Harness gaps

| # | gap | human sees it? | status / minimal fix |
|---|---|---|---|
| G1 | After drilling, nothing said what goes on the Ember Shaft (Leaf). The only route was holding a Leaf during the 3.75-turn window. | Yes. The hint pane switches to the changed target after a use that leaves the hand unchanged. | **Fixed** (`observe.ts`). The thing our own last use just turned into something else, within 2 tiles and the last 1.5 turns, gets up to 3 lines of what works on it. Not shown when the use also changed the held item; the client follows the held item then. Needs `Cell.prev` (`world.ts`). |
| G2 | Hints were only for targets on the ground in view, and only with the held item as actor. The Ember Leaf's single use (Juniper Tinder) and the Bow Drill Bow's (a Short Shaft on it) were invisible unless laid out by chance. | Yes. Picking something up shows its full hint list, in both directions, regardless of what is on screen. | **Fixed** (`observe.ts`, `GameData.hints/depth`). Up to 4 extra lines from the client's list for the held object: same filter, one per other object, shallowest first. Uses whose target is in view stay on the in-view line with coordinates. |
| G3 | A click that did nothing told you only that. It didn't say what does work on the target (e.g. Kindling on Burning Tinder). | Yes. The client then shows the clicked object's hint. | **Fixed** (`body.ts` `worksOn`). Adds up to 3 "what works on it" entries, for a held item and for bare hands on a permanent object. |
| G4 | No backward search. Wanting fire, the agent can't ask what makes Fire. It must explore forward from what it holds. | Yes: typing `/fire` in the client lists the chain that leads to the named object. | **Open.** Add a `hint <word>` action that returns the client's filtered list (`getNumHints` with a filter string: steps that produce the object, deepest first, at most 10 matching objects). It is the same information the human client gives on demand. Declare it, because it hands over whole chains. |
| G5 | The in-view list is capped at 8 lines by distance. In busy grassland, 10+ bare-hand kinds compete, and Milkweed's three phases count as three. A Juniper Tree or Milkweed farther away can be cut. | A human sees the whole screen and can click anything. | **Open, minor.** Merge bare-hand lines that give the same thing ("bare hands on Milkweed / Flowering Milkweed: get Milkweed Stalk"), or raise the cap to ~12 for bare hands. Walking closer already fixes it. |
| G6 | Some held lists put the fire use past line 4. Rope (52 uses): Short Shaft isn't on the first page. Sharp Stone (73 uses): branches aren't. | A human pages through every entry. | **Open, minor.** The other object's list covers each of these (Short Shaft lists "a Rope used on it"; branches list "a Sharp Stone used on it"), as do the in-view lines. Raising `HELD_HINTS` would trade prompt length for coverage. A `hint` paging action like G4 would match the client exactly. |
| G7 | Kindling must land 15–45 wall s after the tinder is lit. Doing it right means waiting a turn. | A human watches the tinder catch. | **Not a gap at k=3.** The timer line plus the `wait` action cover it (see the timing section). |

None of these fixes adds strategy or recipes to the prompt. Each one is something the human client shows at the same moment.

## Changes in this commit

- `agents/src/game/gameData.ts`: `depth(id)` (a port of the client's `regenerateDepthMap`) and `hints(id)` (a port of the client's hint list: `getAllUses` filtered by `getTransHintable`, one per other object, sorted by depth).
- `agents/src/game/world.ts`: `Cell.prev`, the object that was on a tile before its last change.
- `agents/src/agent/observe.ts`: the YOU COULD section adds the held object's hint lines (G2) and "on the X you just made" lines (G1).
- `agents/src/game/body.ts`: a click that does nothing names what works on the target (G3).
- Tests:
  - `observe.test.ts`: the whole ignition, step by step, through `FakeGame` at k=3. Each step's hint appears before the step.
  - `observe.test.ts`: the hint list order.
  - `body.test.ts`: the new failure feedback.
