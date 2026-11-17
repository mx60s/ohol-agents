# Harness audit: barriers to competent play that aren't model error

**Date:** 2026-11-16 · **Code audited:** `integrate` at `493047a`. `d8d43bd` landed during the audit; it adds TIME_SCALE and shifts `world.ts` line numbers by about 30 (see below). Nothing else here changed.
**Scope:** `agents/src/agent/{agent,llm,prompt,observe}.ts`, `agents/src/game/{body,world,gameData}.ts`, `agents/src/protocol/*`, and the server source in `.ohol-build/OneLife/server/server.cpp`.
**Method:**
- Every reply in `agents/logs*/*/llm.jsonl` (1,801 replies) was replayed through the real `parseJsonReply` + `sanitizeAction`.
- Action results were tabulated from `events.jsonl`.
- Live tests ran on a private server copy on port 8011, driven by scripted clients built from the harness's own `Connection`/`World`/`Body`/`buildObservation`. No LLM calls were made.
- Server rules were read in `server.cpp`, and recipe timings in `data/game-data.json.gz`.

Label on every fix:
- **[friction]**: removes a harness barrier. It is human parity or below.
- **[easier]**: would make the game easier than for a human. These are flagged and not recommended.

---

## Ranked findings

| # | Sev | Finding | Fix label |
|---|---|---|---|
| 1 | Critical | The fire recipe has 5–10 s decay windows, but the harness allows one action per ~8.5 s turn (p90 17 s). Fire is effectively impossible. | friction |
| 2 | High | The character stands idle for 74–81% of every cycle. The observation is 5.5 s old (p90 11–12 s) when the action runs. | friction |
| 3 | High | Baby facts in the prompt and observation are wrong: "starves in a few minutes" (really ~20–50 s), "feed toddlers", "walk at 3". | friction |
| 4 | High | The mother is never woken when her baby is born. The `onPlayerAppeared` poke fires before `LN`, so `ancestors` is empty. Verified live. | friction |
| 5 | High | `pick_up_baby` with full hands fails silently. `forage` leaves a Banana Peel in hand, and the baby re-pick then fails. | friction |
| 6 | High | Your own wound or dying state is never shown. The boar wound "Hog Cut" reads as food, and agents tried to eat it. | friction |
| 7 | High | Auto-pathing walks agents next to boars, wolves and bears. `go` reported "arrived" while the agent arrived wounded (live). | friction |
| 8 | Med-High | `say` falsely tells adults their speech was cut off: limit = age+1 at every age. 330 false notices in the logs. | friction |
| 9 | Medium | Reasoning tokens eat `max_tokens`, truncating the JSON. That is 100% of parse failures. `finish_reason` is ignored, and the turn is lost plus 3 s. | friction |
| 10 | Medium | The parser breaks on `<think>` blocks containing braces, prose with braces, trailing text, trailing commas, and single quotes. Open models will hit this. | friction |
| 11 | Medium | Valid-but-unusual actions are dropped or turned into "invalid". A null action is not recorded, so the model is never told. | friction |
| 12 | Medium | Infra errors leak into the model's history ("confused (Error: LLM HTTP 402 …)"). | friction |
| 13 | Medium | No plan continuity: the last thought is not fed back. Each call sees only the goal, notebook and last 8 results. | friction |
| 14 | Medium | Plant and food share names (Wild Carrot, Wild Onion, Wild Garlic, …). This has caused failed forages. | friction |
| 15 | Medium | The PEOPLE list shows carried babies at their pick-up spot and walkers at their destination. | friction |
| 16 | Low-Med | Game-rule failures come back as a bare "nothing happened": baby refuses food, hands full, not edible, wound can't be dropped. | friction |
| 17 | Low-Med | Server notices (`MS`) are dropped: tool slots, inheritance, property. Tool slots activate at ≥15 players. | friction |
| 18 | Low | A newborn's observation says "STARVING - EAT NOW", but babies can't eat. | friction |
| 19 | Low | `go` onto a blocking tile walks next to it, then reports "no path found". | friction |
| 20 | Low | Recipe hints use the first transition only. A full Banana Plant "becomes Empty Banana Plant". | friction |
| 21 | Low | Other families' speech is translated or garbled by the server; the prompt never says so. | friction |
| 22 | Low | Small output bugs: wearing reads as "holding Reed Skirt -> nothing", and a 0.88-year baby dies "age 1". | friction |

Findings already covered by `docs/research/ohol-success.md` are not repeated in full here: halt on 402, forage drops tools, cold cost, food-drain display, camp/home. They are cross-referenced where they interact.

---

## 1. Parsing

### Replay results

| Run set | Replies | Parse failures | Cause | Recoverable by closing braces |
|---|---|---|---|---|
| dev1 (2026-11-16, max_tokens 2000) | 621 | 3 (0.48%) | all truncated mid-JSON | 3/3 |
| showcase1 (2026-10-30, 2000) | 915 | 4 (0.44%) | all truncated (1 is prose rambling) | 2/4 |
| t1–t4, ctl, halttest (2026-10-17/18, lower cap ~600) | 265 | 52 (19.6%) | all truncated mid-JSON | 3/52 |
| **Total** | **1,801** | **59 (3.3%)** | **100% truncation** | 8 |

Other checks on the same replies:
- Code fences: 0.
- Leading prose: 2.
- Non-object `action`: 0.
- Missing action: 0.
- Missing coordinates: 0.
- Unknown action types: 0.

Gemini Flash with `response_format: json_object` is well behaved. The only failure mode is truncation.

There are also 2,773 non-reply LLM errors. They are 402 "Insufficient credits", which `ohol-success.md` §3.1 covers.

### Why the replies truncate (finding 9)

- Replies are about 170 characters (~45 tokens), but the median completion is 370–440 tokens (p90 950–1,009, max 1,995).
- The difference is hidden reasoning, and it counts against `max_tokens` (`llm.ts:164`, `config.ts:35`).
- The old runs used a ~600 cap: 20% truncated. At 2,000 the rate is 0.46%.
- `finishReason` is returned by `Llm.chat` (`llm.ts:210`) but `agent.ts:246-250` neither logs nor checks it. The director and narrator do check it (`director.ts:383`, `narrator.ts:71`).
- **What a failure costs:**
  - The turn is lost, after the full latency.
  - Then `sleepInterruptible(3000)` runs (`agent.ts:243`).
  - Any `say` in the truncated reply is lost.
- **What the model is told:**
  - History records `think -> confused (Error: no JSON in reply)` (`agent.ts:242`).
  - That line appeared 183 times in later observations, plus 19 `SyntaxError` lines.
  - It never says *why* (too long), so the model can't adapt.

**Fix [friction]:**
- Send an explicit reasoning budget. On OpenRouter use `reasoning: {max_tokens: N}` or `{effort: "low"}`, and keep `max_tokens` = N + 400 for content.
- Log `finish_reason` and `usage.completion_tokens_details.reasoning_tokens` in `llm.jsonl`.
- On `finish_reason === "length"`, try a salvage parse: close the open strings and braces, then accept it if `action.type` is present. That recovered 8 of 59.
- Tell the model next turn: "Your last reply was cut off before it finished; keep `thought` to one sentence."

### Parser robustness for open models (finding 10)

`parseJsonReply` (`llm.ts:228-238`):
- strips a leading or trailing fence,
- then tries `JSON.parse`,
- then slices from the first `{` to the last `}`.

Synthetic replies through the real parser:

| Reply shape | Result |
|---|---|
| plain JSON, fenced JSON, prose + fence, fence + prose | OK |
| `<think>no braces</think>{json}` | OK |
| `<think>maybe {"type":"go"}? no…</think>{json}`: R1/Qwen3-style drafts | **FAIL** |
| prose containing `{…}` before the JSON | **FAIL** |
| JSON then an explanation containing `{…}` | **FAIL** |
| two JSON objects (draft then final) | **FAIL** |
| trailing commas, `//` comments, single quotes | **FAIL** |
| truncated after a complete `action` | **FAIL** (salvageable) |

On many OpenRouter providers, DeepSeek-R1, Qwen3, GLM and Kimi-thinking emit reasoning inside `content`, and it often drafts the JSON. That model family would lose a large share of turns.

Two more gaps:
- `message.content` can be `null` when only `message.reasoning` is filled. The code turns that into `""` → "no JSON".
- The 400 retry without `response_format` exists (`llm.ts:188`), which is good.

**Fix [friction]:**
- Strip `<think>…</think>` and `<reasoning>…</reasoning>` first.
- Then scan for *balanced* top-level `{…}` objects, honouring strings and escapes.
- Prefer the **last** one that has an `action` key.
- Before giving up, try a lenient pass: drop trailing commas and `//` comments, and convert single quotes.

### Unusual but valid actions (finding 11)

`sanitizeAction` (`agent.ts:387-399`) and `execute` (`agent.ts:298-350`):

| Reply | What happens |
|---|---|
| `"type":"Forage"`, `"pick up"`, `"pick-up-baby"` | becomes `type:"invalid"` → model told `unknown action type "invalid"`, not what it sent |
| `"person":"#12"` (the observation prints people as `#12`) | dropped → "need person id" |
| `"id":12` instead of `person` | dropped → "need person id" |
| `"pos":[3,4]`, `"target":{"x":3,"y":4}`, `"x":"(3, -4)"` | coordinates dropped → "need x,y" |
| `"action":"forage"` (string), top-level `"type"`, `"actions":[…]` | `action` null → **nothing executed, nothing recorded**; the model never learns the turn was wasted |
| `{"type":"say","text":"hi"}` | "unknown action type say"; the text is lost (`Action.text` exists but is unused) |

The logs contain none of these (Gemini follows the schema). They are the next failures to expect with other models.

**Fix [friction]:**
- Normalise the type: lowercase, map spaces and hyphens to `_`, and accept aliases.
- Accept `#12`, `id` and `target_id`, plus `pos`/`target`/`"(x, y)"` for coordinates.
- Accept a string action, a top-level type, or `actions[0]`.
- When no valid action is found, record `no valid action in your reply (got: …)` in history.

### Infra errors in the model's context (finding 12)

- When the LLM call throws (402, backoff), `agent.ts:242` records `confused (Error: LLM HTTP 402: {"error":{"message":"Insufficient credits…` in history.
- That raw text was then shown to the model 45 times.
- **Fix [friction]:** record only parse and format failures in the model's history. Log infra failures separately. (The halt-on-402 is `ohol-success.md` rec. 1.)

---

## 2. The observation → action loop

### What the model sees after acting

`Body.summarize` (`body.ts:174-180`) reports the before→after tile and held item, for example `use: tile (-67,-192) Tule Reeds -> Harvested Tule`. That is good, precise feedback, and it is the strongest part of the harness. The weak points:

- **Bare "nothing happened" for rule failures (finding 16).** The cause is knowable from the server rules and data, and a human sees the cue (refusal emote, wound sprite, hands full):
  - Live: `feed #6 with Gooseberry (baby food 4) -> used held item on #6: nothing happened`. Babies under 3 refuse food above 2 pips (`server.cpp` ~28090, `babyFeedingLevel=2`).
  - Live: `pick_up_baby #6 while holding Stone -> tried to pick up #6: nothing happened`.
  - Logs:
    - `eat` with Wild Rose Hip (food 0) → "use on self … nothing happened", 2 times.
    - `eat` with Hog Cut (a wound), 2 times.
    - `use` "nothing happened": 55/453 uses. Replaying them against the transition table:
      - 52 are recipe guesses with no transition.
      - 10 had a transition but still failed. Those include a boar wound received during the approach walk, and children 3–5 using milkweed.
  - **Fix [friction]:** append a reason when it is determinable:
    - "the baby isn't hungry enough to accept food (babies only eat at ≤2 food)"
    - "your hands are full"
    - "X isn't edible"
    - "you can't drop a wound"
    - "X needs age N"
    - "there is no known use of X on Y"

    The last one is the client's own no-op. If it feels too helpful, keep just "nothing happened".
- **Wearing** reads `use on self: holding Reed Skirt -> nothing` (live). It should say "you put on the Reed Skirt (bottom)".
- **The death list** prints `age 1` for a 0.88-year baby (`observe.ts:97`, `toFixed(0)`).

### Stale state (findings 2, 15)

- **The observation is built before the LLM call** (`agent.ts:223`). The action runs after the reply.
  - LLM latency: p50 5.5 s, p90 11–12 s, max 22–31 s (dev and showcase).
  - Everything the model sees is that old when it acts: babies, animals, others' positions, bushes emptied by others.
  - `execute` re-reads live state for the approach, so coordinates still resolve. But targets can be gone.
- **Carried players are shown at their pick-up coordinates.**
  - `observe.ts:83` prints `p.x, p.y`, not `w.posOf(p)`.
  - Live: the mother walked 4 tiles. The baby's raw position stayed (-30,-140) while the carrier was at (-26,-140).
  - The YOU line uses `posOf` correctly (`observe.ts:61`).
- **Walkers are shown at their destination.**
  - A `PM` immediately sets `p.x,p.y` to the end of the path (`world.ts:184-187` at 493047a; about 215-218 after d8d43bd).
  - Live: 200 ms into a 6-tile walk, `world.self` already reported the destination.
  - Your own position is fine, because actions await `doneMovingSeq`. Other people "teleport" in the observation.
- **The `moving` flag can stick.** `applyPU` only updates x/y when `doneMovingSeq>0 || forced || !moving` (`world.ts:307-314`). A move the server cancels silently (for example, a baby picked up mid-crawl) can leave `moving=true` and freeze the position. The live repro of that case did not freeze, so this is a risk, not a confirmed bug. Use `moveEndsAt` as a fallback.
- **Fix [friction]:**
  - Use `posOf` in the PEOPLE list.
  - For moving players, print `walking from (a,b) to (c,d)` or an interpolated position.
  - Set `moving=false` once `now > moveEndsAt`.

### Names and coordinates

- Coordinates are absolute everywhere: prompt, observation, actions and results. Chebyshev "N away". It is consistent.
- Person ids are `#N` in the observation and a number in the action schema; see finding 11 for `#12`.
- **Ambiguous object names (finding 14):**
  - 1,818 display names are shared by more than one object id.
  - 25 cases mix a wild or food object with a different edible/fixed/blocking kind:
    - `Wild Carrot` (404, a fixed plant) vs `Wild Carrot` (40, food 5)
    - `Wild Onion` 805/808
    - `Wild Garlic` 4251/4252
    - `Cooked Rabbit`, `Cooked Fish`, milk bottles, …
  - Logs: `use (23,-61) -> Seeding Wild Carrot -> Wild Carrot`. Then `forage (23,-61) -> nothing at (23,-61) gives food by hand`. The model reasonably read "Wild Carrot" as food.
  - A human sees different sprites.
  - **Fix [friction]:** add a suffix when names collide: `(plant)` for permanent non-food, `(food)` for edible.
- **The held wound "Hog Cut"** is in finding 6.

---

## 3. Action space: live results and failure rates

### Live tests

These ran on a private server (port 8011) with the harness's `Body`, and no LLM.

| Action | Live result | Notes |
|---|---|---|
| `go` 5 tiles | arrived, 1.4 s | |
| `go` 40 tiles (3 legs) | arrived, 11.5 s | |
| `go` 25 tiles NW | "arrived" but **now holding Hog Cut** (a boar wound) | finding 7 |
| `go` onto Tule Reeds / tree | "no path found". For the reeds it first walked next to them. | finding 19 |
| `use` (pick up Stone) | OK | |
| `use` Stone on Big Hard Rock | OK → Sharp Stone | |
| `drop` (no xy), `drop` baby | OK | |
| `pick_up` Sharp Stone | OK | |
| `forage` while full | "you're full" | |
| `forage` carrying baby | dropped the baby, ate Wild Onion, re-picked the baby. OK, 2.2 s. | |
| `pick_up_baby` newborn | OK. Baby food 2/4 → 4/4; mother −1. | |
| `pick_up_baby` while holding Stone | "nothing happened", no reason | finding 5 |
| `feed` baby at 4/4 | "nothing happened" (refused) | finding 16 |
| `say` (adult) | false "cut off" notice | finding 8 |
| `say "F"` baby, on the ground and while held | mother heard both | §4 |
| `undress` with nothing worn, `eat` with nothing | "nothing happened" / "not holding anything" | |
| Reed-skirt chain (22 actions) | OK in 40 s scripted; worn | §3 core loop |

### Logged failure rates (LLM-chosen actions)

Counts are dev / showcase.

| Action | n | Failure modes |
|---|---|---|
| `go` | 79 / 160 | 7/18 "no path found" (walking onto a blocking tile), 4/8 "movement interrupted" |
| `use` | 219 / 234 | 25/30 "nothing happened" (mostly recipe guesses), 2/3 unreachable |
| `drop` | 84 / 101 | 6/5 "nothing happened" |
| `forage` | 109 / 144 | about 12% did not eat: 5/8 bad target, 3/12 no food within 20, 2/2 couldn't free hands (wound) |
| `forage` with baby | — | baby re-pick failed 0 times (dev) and 6 times (showcase); 3 of the 6 had a Banana Peel in hand |
| `pick_up_baby` | 9 / 26 | 3/3 "nothing happened", 0/2 "isn't nearby", 0/1 "left" |
| `eat` | 8 / 13 | 4/5 "nothing happened": non-food (Wild Rose Hip) or a wound |
| reflex forage | 319 / 197 | 94% / 91% ate |

### Finding 5: hands-full baby pick-up

- `pickUpBaby` (`body.ts:310-317`) never checks the held item.
- The server rejects `BABY` unless the hands are empty.
- `forage` (`body.ts:302-305`) re-picks the baby straight after `self()`. Eating a Banana leaves a **Banana Peel** in hand, so the re-pick fails.
- The baby is left wherever the mother dropped it, and the result just says `tried to pick up #N: nothing happened`.
- Showcase: 3 of the 6 failed re-picks have `Holding: Banana Peel` in the next observation.
- **Fix [friction]:**
  - In `pickUpBaby`, if holding an object, drop it on a free adjacent tile first, or at least return "your hands are full (holding X)".
  - In `forage`, drop any residue before the re-pick.

### Finding 6: own wound or dying state is invisible

- `world.ts` tracks `dying` from `DY`/`HE` for everyone, but `observe.ts:56-70` never prints it for yourself. Only others get `WOUNDED/DYING` (`observe.ts:83`).
- The wound is a held object named **"Hog Cut"** (id 1364, from Wild Boar + hand → Attacking Wild Boar + Hog Cut). It shows as `Holding: Hog Cut.`
- In the dev logs, an agent tried to `eat` it twice. `drop` and `forage` fail with "couldn't free hands" 4 times.
- **Fix [friction]:**
  - YOU section: `You are WOUNDED: a Hog Cut (from a Wild Boar). Wounds can't be dropped; …`
  - Mark wound objects in `Holding:`. The server uses `holdingWound`; the client can flag objects that appear as the `newTarget` of an animal + hand transition, or that have `deadlyDistance` sources.
  - A human sees the wound sprite and blood.

### Finding 7: pathing ignores predators

- `findPath` (`body.ts:40-79`) treats every non-blocking tile as free. Wild Boar, Wolf, Grizzly Bear and Rattle Snake have `deadlyDistance>0` (109 such objects) and are not blocking.
- The model picks only the destination, so it can't steer around a boar the way a human does.
- **Fix [friction]:**
  - Add a large cost to tiles within `deadlyDistance`+1 of a deadly object, and refuse a path that ends adjacent to one unless it is the target.
  - When the self PU reports a wound mid-walk, stop and return `a Wild Boar wounded you at (x,y)`.

### Finding 19: `go` onto blocking tiles

- `walkTo` (`body.ts:82-108`) falls back to `ring(target, 2)`, walks next to the target, and then on the next leg returns "no path found".
- That is 11% of `go` actions.
- **Fix [friction]:** when the goal tile blocks walking, path to its free neighbours and return `X at (x,y) blocks walking; you're now next to it at (a,b)`.

### Finding 20: recipe hints

- `GameData.transition` returns the first transition for a pair (`gameData.ts:142-144`). That ignores last-use variants and probabilistic tool breaks.
- The full Banana Plant hint says "it becomes Empty Banana Plant" when it actually becomes the 6/7 state.
- Category (`@…`) transitions: 1,274 rows. Use dummies are expanded, which is good.
- **Fix [friction]:** prefer the non-`lastUse` variant for multi-use targets.

### Core loop: what is possible today

| Task | Possible? | What blocks or degrades it |
|---|---|---|
| **Find food → eat** | **Yes.** `forage` ate in 88% of LLM uses and 91–94% of reflexes. `eat` works. | Banana Peel residue (5). Plant/food name collisions (14). Stale far-away bushes. Your own wound blocks freeing hands (6). |
| **Pick up baby → nurse** | **Yes.** Live: `BABY` refills a baby at ≤2 food to full, and a fertile mother's carried baby doesn't drain. | No wake-up on birth (4). Hands-full silent failure (5). Wrong timing in the prompt (3). Stale PEOPLE coordinates for carried babies (15). |
| **Sharp Stone** | **Yes.** 2 actions (Stone → Big Hard Rock), 3.4 s live. | Big Hard Rock is often outside the 12-tile view. That is a fair constraint. |
| **Reed skirt** | **Yes.** 22 actions in 40 s scripted: Sharp Stone → Tule → Reed Bundle; 4 Milkweed → 2 Thread → Rope; Rope + Bundle → Skirt; wear. At the LLM cadence that is ~3.3 min. | Only immediate recipe hints. A model must know the chain. Wear feedback is unclear (22). |
| **Fire** | **No, blocked by the harness's time budget (1).** | See below. |

The fire chain, from `game-data.json.gz`:
- Fire Bow Drill + Long Straight Shaft → **Ember Shaft, which decays in 10 s**.
- Leaf + Ember Shaft → **Ember Leaf, which decays in 10 s**.
- Ember Leaf + Juniper Tinder → Smoldering Tinder → (5 s) Burning Tinder, **which decays in 10 s**.
- Kindling + Burning Tinder → Fire.

Each window needs 2–3 hand swaps: drop the drill, pick up the leaf, use it. At one action per ~8.5 s turn (p90 17 s), none of the windows can be met. A human does each in 2–3 s.

Kindling also needs a Stone Hatchet: Sharp Stone + Tied Short Shaft. That makes about 30 actions in total. The length is fine; the timers are not.

---

## 4. Hearing and speech

- **Radius.**
  - Server `maxSpeechRadius = 16`, Euclidean `intDist` (`server.cpp:5528`, ~33227).
  - The PEOPLE list uses 16 Chebyshev (`observe.ts:73`). People in the corners are listed but out of earshot. Trivial.
- **Delivery.**
  - `PS` → `World.heard`; the last 90 s, up to 12 lines, appear under HEARD RECENTLY with "Ns ago".
  - At the ~9 s cadence a line stays visible for about 10 turns. Adequate.
  - The speaker is shown as `#id name (sex, age)`. It is not tagged with the relation, but the PEOPLE list has it. If the speaker has left range, it shows a bare `#id`.
- **Logs.**
  - 94/111 (dev) and 209/237 (showcase) spoken lines reached at least one agent.
  - Baby "F": 16/16 and 51/57 were heard.
  - 339/618 and 684/911 observations contained someone else's speech.
- **Live, two clients.**
  - A newborn's `say F` reached the mother on the ground and while held, both at 0–1 s.
  - Your own echo arrives as `you: "…"`.
  - Speech pokes a sleeping agent (`agent.ts:111-113`). Good.
- **Finding 8: wrong say limit.**
  - `Body.say` (`body.ts:332-334`) claims the limit is `floor(age)+1` letters at every age.
  - The server's `getSayLimit` (`commonSource/sayLimit.cpp`) is age+1 under 8, a sigmoid from 9 to 66 between 8 and 16, then 66+.
  - Live, at age 14: the harness said `cut off: at your age you can only say 15 letters`, while the server echoed the full 20-character sentence.
  - 330 distinct false notices went to agents aged ≥8 in the logs. Adults learn to talk telegraphically ("EVE SAVE BABY").
  - **Fix [friction]:** port `getSayLimit`, or report the server's echo, which already lands in `lastSaid`.
- **Finding 21: other families' speech.**
  - The server translates speech between different Eve lineages (`translatePhraseFromSpeaker`, ~33354), so it comes out as garbled words.
  - The prompt doesn't say so. Humans learn it quickly.
  - **Fix [friction]:** one prompt line: "People from other families speak a different language; you'll hear their words scrambled."

---

## 5. Time to think

**What happens during a cycle (finding 2).** From the logs, per agent:

| | dev1 | showcase1 |
|---|---|---|
| Cycle (LLM call to LLM call) p10 / p50 / p90 | 4.2 / 8.5 / 16.9 s | 4.6 / 9.3 / 18.4 s |
| LLM latency p50 / p90 / max | 5.5 / 11.1 / 21.9 s | 5.4 / 12.4 / 30.7 s |
| Share of the cycle spent waiting for the model (p50) | **81%** | **74%** |
| Action execution after the reply, p50 / p90 | 1.3 / 3.7 s | 1.3 / 4.3 s |
| Observation → action-start gap | = LLM latency (above) | |

- The character stands still while the model thinks. Hunger keeps draining: a cold adult pays 1 food per 6.8 s, so each decision costs ~1.3 food (`ohol-success.md` §3.3).
- Actions do complete before the next observation:
  - `walkTo` awaits `done_moving`.
  - `act` waits for a self PU or a tile change, up to 2.5 s.
  - `pickUpBaby` polls 1 s.
- **Wasted time:**
  - 3 s sleep after every parse or LLM failure (`agent.ts:243`).
  - The 15 s baby cadence.
  - `wait` up to 30 s (model-chosen).
  - The poke on birth never fires (finding 4), so a mother in a `wait` or a long multi-leg walk notices her newborn late. A newborn arrives at **2/4 food**.
- **Finding 4: the birth wake-up never fires.**
  - `agent.ts:116-119` pokes when `p.ancestors[0] === world.selfId` in `onPlayerAppeared`.
  - But the server sends the newborn's `PU` before its `LN`, and `World.applyPU` fires `onPlayerAppeared` on the PU (`world.ts:320`).
  - Live, the Eve's client printed `onPlayerAppeared #6 ancestors at that moment: [] -> poke condition false`, then `<< LN 6 5 eve=5`.
  - **Fix [friction]:** fire the check from the `LN` handler as well (a new lineage entry whose mother is us). Or poke on any newcomer aged <0.1 within 1 tile.
- **Fix for the whole section [friction]:**
  - (a) An explicit, small reasoning budget (finding 9).
  - (b) **Let one reply carry a short plan**: `"actions":[…]`, up to 3–4 steps, run back to back, stopping at the first failure or surprise (new speech, food ≤ 3, a birth). That is motor parity: a human chains clicks at ~1/s while thinking. It is the only way to meet the 10 s fire windows at the planned cadence.
  - (c) TIME_SCALE (landed in d8d43bd), which stretches decay timers too. At k=3 the Ember windows become 30 s, which is still only ~3 turns at an 8 s cadence. Do (b) as well.
  - Flag: (b) is not easier than for a human, as long as plans abort on events.
- **Finding 13: no plan continuity.**
  - Each call is `[system, one user message]` (`agent.ts:231-234`). The previous `thought` is not shown back; only `goal` (if changed), the notebook and 8 action results.
  - Multi-step intentions ("drop the drill, then grab the leaf") have to be re-derived every turn.
  - **Fix [friction]:** add `Your last plan: <previous thought>` (1–3 entries) to the observation.

---

## 6. Information the model needs but doesn't get

| Item | Shown? | Note |
|---|---|---|
| Own food, heat, age, held, worn | Yes | |
| Own wound / dying / sickness | **No** (finding 6) | `self.dying` exists, unused |
| Food drain rate | No | `HX food_time` is available (live: 6.9 s/pip hot, 21 s normal); `ohol-success.md` rec. 3 |
| What nearby objects are | Name + coordinates (12 tiles, 45 kinds, 3 coordinates each) | ambiguous names (finding 14) |
| What you can do with them | Immediate recipe hints (held × visible) | first-transition only (finding 20) |
| Water, fire, family location | Water/fire only as object names; family only in view | home marker is `ohol-success.md` rec. 6 |
| Biome of nearby tiles | Own tile only | humans see ground colour; listing "jungle 6 tiles east (hot)" is parity |
| Is a baby mine | Yes, `[your child]` (after `LN`) | |
| Time of day / temperature | No day/night in OHOL; heat is shown | fine |
| What killed relatives | No cause (place, age, relation only) | humans see only bones; **adding causes would be [easier]**, so don't |
| Server notices (`MS`) | **Dropped** (finding 17) | `parseMessage` → OTHER; 44 send sites: tool slots ("YOU ALMOST LEARNED… REPEAT…"), inheritance, property |

Finding 17 is latent today, because tool slots are off below `minActivePlayersForToolSlots = 15` (live `TS 37 5` = all tools known). It becomes a silent "nothing happened" for unlearned tools at ≥15 players.

**Fix [friction]:** parse `MS` and show it as `Notice: …` in HEARD.

---

## 7. Prompt vs real game behaviour (finding 3, plus small items)

| Prompt / observation says | Reality (evidence) | Fix |
|---|---|---|
| "A baby left on the ground starves in a few minutes" (`prompt.ts:10`); "starves within a few minutes" (`observe.ts:87`) | Live: a newborn **arrives at 2/4 food**. A fed baby set down died in **46 s** (badlands, heat 0.93, 7 s per pip). Drain is `20·2·heat (folded above 0.5) + 4` s per pip, so ~5–24 s; a newborn has 3–5 pips → about 15–100 s. | "A newborn arrives nearly starving and dies in under a minute if not picked up; set down, a baby lasts well under a minute" (or in turns, per decisions.md) |
| "Toddlers can be fed by someone holding food and using feed" | Under-3s refuse food unless at ≤2 pips (`babyFeedingLevel`). Live: refused at 4/4. | Add "only when they're starving (≤2 food)" |
| "From about age 3 kids can walk" | `startWalkingAge = 0.2`: babies can crawl from ~12 s old. They can pick things up and eat from 3 (`minPickupAge`). | "Babies can crawl from a few months old; from 3 they can pick things up and eat" |
| "nursing costs her a little food" | Every pick-up costs the mother 1 food, even when the baby refuses (`nurseCost=1`). While held by a fertile woman the baby doesn't drain. Carried by a man or older woman, it does. | State it plainly |
| `say` result "at your age you can only say N letters" | Wrong for ≥8 (finding 8) | port `getSayLimit` |
| Baby's own observation: "Food: 2/4 STARVING - EAT NOW" (`observe.ts:62`) | Babies can't eat; their only actions are saying F and staying held | for age <3: "hungry — say F so a woman picks you up" (finding 18) |
| "drop … omit x,y to drop next to you" | Drops on your own tile first if it's empty (`body.ts:198`) | wording |
| `wait` "you'll be woken if someone speaks" | True. The *intended* wake on your baby's birth never fires (finding 4). | fix the code |

---

## Do not recommend: makes the game easier than for a human

- Showing the cause of other people's deaths, or any family member's position out of view.
- Babies saying "F" automatically. A human baby must type it, though it is a defensible convenience.
- Listing food sources beyond the visible area. `foodSources(maxDist=20)` already reaches 8 tiles past the 12-tile view (`body.ts:260`). Consider capping it to the view.
- The `craft <item>` macro: decisions.md already marks it as a temporary, wiki-equivalent intervention.
- Expanded "nothing happened" reasons that reveal recipe-graph facts the client doesn't show ("no known use of X on Y"). Keep those to rule failures that have a visible cue.

---

## Reproduction notes

- Parser replay and synthetic cases: run the replay against `agents/src/agent/llm.ts` `parseJsonReply` and `agent.ts` `sanitizeAction` over `agents/logs*/*/llm.jsonl`. The scripts were scratch files, outside the repo.
- Live tests used a fresh server from `server/run.sh .ohol-build <tmpdir>` with `PORT_OVERRIDE=8011`. The first login becomes Eve; a second login is born to her. Disconnected characters stay alive in the world, so start each test from a clean run dir.
- Line numbers refer to `493047a`. `d8d43bd` shifted `game/world.ts` by about 30 lines (TIME_SCALE) and changed the walk deadline in `body.ts:117`. No finding is affected.
