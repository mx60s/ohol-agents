# ohol-agents

LLM agents living in a private [One Hour One Life](https://onehouronelife.com/) (OHOL) server, through the real game protocol. They are born, get named by their mothers, are nursed, forage, craft, talk, die, and are reborn into whatever family exists. A web viewer shows what each one sees, says and thinks.

**Watch it live: https://mvonebers.com/ohol-agents/** (the live site: the current world, field notes, families and leadership, and the stream at [stream.html](https://mvonebers.com/ohol-agents/stream.html)). A recorded early run plays at [replay.html](https://mvonebers.com/ohol-agents/replay.html) (no backend; scrub and change speed with the bar at the bottom).

## What's here

- Stock OHOL server (v438 code, v437 data) with four small patches, built from source.
- N LLM agents (default 4, Gemini 3.8 Flash via OpenRouter, any OpenAI-compatible endpoint works) each controlling one character over a raw TCP connection. Each agent only sees what its own character has been told by the server.
- Web viewer: camera grid (one tile per agent: surroundings, nearby people drawn by age, held items, speech bubbles), map, agent cards, chat with who heard each line, timeline, and a Story panel.
- Narrator: every 30 s an LLM writes 1-3 sentences of plot-level narration from recent events. Omniscient, broadcast-only; agents never see it.
- Recorder + replay: `agents/src/tools/record.ts` records a live run from the HTTP API into JSONL; the viewer replays it (`?replay=<url>`). The hosted demo is `recordings/showcase.jsonl`.

Seen in runs, unprompted: Eves name themselves ("I AM EVE HOPE") and their babies ("YOU ARE FAITH"), carry babies to nurse them and set them down to eat, make a Sharp Stone from two stones, and a second Eve picks up the Sharp Stone the first one left behind. Early lives often end in starvation or cold.

## Layout

| Path | What |
| --- | --- |
| `server/build.sh` | Clones OneLife / minorGems / OneLifeData7 at pinned tags, applies `server/patches/`, builds the server, dumps game data to JSON. Linux and macOS. |
| `server/run.sh` | Runs the server from a run dir (world `.db` files go there). Copies stock settings, overlays `server/settings/*.ini`, then `OHOL_SETTING_<name>=<value>` env vars. |
| `server/patches/` | `absolute-coords.patch`: every client gets absolute world coordinates (stock server sends coords relative to each player's birth spot). `dump-game-data.patch`: `OHOL_DUMP_GAME_DATA=<path>` writes all objects + transitions as JSON and exits. `free-names.patch`: with `mtsFreeNames=1`, names are used as spoken instead of being snapped to the nearest entry in the server's name lists (stock OHOL forces Eve surnames and baby first names into `lastNames.txt`/`firstNames.txt`). Eves can say "I AM <FIRST> <FAMILY>". It also enforces the naming rules: a family name that a living family has, or any family named on this server had (`mtsFamilyNames.txt` in the run dir), is refused with a notice; a baby's first name may carry a numeral II-X (AURORA II DAWN, family DAWN), and a name already in use gets the next numeral. The agents apply the same rules before speaking, against every lineage they recorded (`agents/src/agent/naming.ts`). `new-player-food-bonus.patch`: with `mtsNewPlayerFoodBonus=1`, every life gets the stock new-player food bonus without a stats server (see Interventions). `player-saves.patch`: with `mtsPlayerSaves=1`, living players are saved to `playerSaves.txt` in the run dir (every 30 s and on SIGTSTP) and restored at startup, so a restart or crash keeps everyone alive; see [docs/research/game-saves.md](docs/research/game-saves.md). |
| `server/settings/` | Our overrides: no ticket/stats/lineage/etc. backend servers, no apocalypse, Eve naming allowed, new-player food bonus on (`mtsNewPlayerFoodBonus=1`, `newPlayerFoodDecrementSecondsBonus=18`, `newPlayerFoodEatingBonus=0`), and player saves on (`mtsPlayerSaves=1`), the Eve/baby ratios pinned at their stock values (`maxBabyAdultRatio=1.0`, `maxBabyMomRatio=1.0`; the starting setup depends on them, see "Run setup"). (We tried forcing all Eves to spawn at (0,0); it turned the spawn into a famine zone once the berries were eaten, so Eve placement is back to stock.) |
| `data/game-data.json.gz` | Output of the dump (11,401 objects incl. generated "use dummies", 53k transitions). Regenerate with `server/build.sh` when bumping upstream tags. |
| `agents/` | TypeScript (Node 24, tsx). See below. |
| `viewer/` | Vite + React static site ("Artificial Selection"): `index.html` home, `stream.html` 1920x1080 overlay, `agent.html?life=<lifeId>`, `agents.html` (how agents work), `study.html`, and the original dashboard at `replay.html`. `?api=<url>` points any page at an agents service, `?fixture=<name>` serves a captured snapshot from `viewer/fixtures/` (no API calls; `node scripts/capture-fixture.mjs <name>`), `?replay=<url>` / `?mock` (dashboard only). Shared code: `src/theme/`, `src/data/`, `src/shared/`. |
| `recordings/showcase.jsonl` | The recorded run behind the hosted demo. |

### Agents code

- `protocol/connection.ts`: TCP, `#`-framed messages, zlib `CM`/`MC` payloads, login. `protocol/messages.ts`: typed parsers (tests in `messages.test.ts`).
- `game/world.ts`: what one character has been told by the server (map cells, people, speech, food, heat, lineage). Each agent only sees its own world.
- `game/body.ts`: deterministic control. A* pathfinding, walking in legs of 15 tiles, and actions (use, drop, swap, take out, eat, pick up baby, feed, say, forage).
- `agent/observe.ts`: turns the world into the text observation. `agent/prompt.ts`: system prompt (game basics, broad objective, action JSON format).
- `agent/agent.ts`: one slot. Loop: observe, ask LLM, run action, record result. One reflex: if starving, forage. Memory is a yearly summary of this life (`MEMORY_SUMMARY`, every `MEMORY_SUMMARY_TURNS` turns, rewritten in the background; see `agent/memory.ts`), wiped at death unless `MEMORY_MODE=persistent`.
- `cadence.ts`: the fixed decision cycle and the contract for event-driven wake-ups. `logins.ts`: when each slot logs in (starting Eves, staggered joins, respawn delays, logins held while paused). `calibration.ts` + `tools/calibrate.ts`: model calibration scorecards. `tools/bench-endpoint.ts`: latency/throughput benchmark of any OpenAI-compatible endpoint. `tools/fake-llm.ts`: free local fake provider for end-to-end tests.
- `population.ts`: keeps N slots alive, enforces run limits, pauses the run on an LLM outage, records who heard each spoken line, builds the viewer state. `narrator.ts`: broadcast narrator. `api.ts`: HTTP + SSE. Contract in `api-types.ts` (copied to `viewer/src/`).
- `director.ts`: stream camera (which one character the stream page shows). `story.ts`: rolling "story so far". `safety.ts`: sanitizing model output and quoting agent text in prompts. See "Stream" below.
- Logs (JSONL, one dir per run under `LOG_DIR`): `events.jsonl`, `llm.jsonl` (every observation and reply; tokens incl. `cachedTokens`/`cacheWriteTokens`/`reasoningTokens`; cost; latency; `ttftMs` when streamed; the serving `provider`; and the model's `reasoning` text when the provider returns it, capped at 8k chars). Action events carry `turnMs` (observation built to action dispatched), `lives.jsonl`, `narration.jsonl`, `director.jsonl` (every director decision, prompt and reply), `outages.jsonl` (LLM outage pauses and resumes), `lives/<playerId>.jsonl` (per-life events). Across runs: `LOG_DIR/research/` (life records, spend ledger; see "Research data"). `LOG_DIR/story.jsonl` (outside the run dirs) holds every story version and is reloaded on startup.

## Stream (one character at a time)

For a 24/7 Twitch/X page that shows one character big.

**Director** (`director.ts`). Picks the living character the camera follows: `focus` on `/api/state`, plus a `"focus"` event on each change. Every `DIRECTOR_INTERVAL_MS` it may ask a model, given a digest of each living character (name, age, generation, family, goal, last thought/said/action, notable events in the last 30 s: births, deaths, starving, a baby left alone, first-time items, conversations) and the narrator's last 3 lines. It also flags big changes to the world: elders (age ≥ 45; ≥ 55 is near the end of their life) and whether they are starving or wounded, an elder's death (news for their family), founders (an Eve with living descendants) and the oldest of a family (weighted more), and first-time items being crafted (from the craft macro's progress report; 2 or fewer steps left = about to be made). A *major development* is an elder near the end of their life or in danger, a founder in danger, or a first-ever item about to be or just crafted; the instructions to every engine say such changes are worth switching for and routine foraging is not. `DIRECTOR_ENGINE` picks the model:
- `jev` (default when `LLM_BASE_URL` is OpenRouter): TypeSafe's Jev decision model (`DIRECTOR_JEV_MODEL`, default `typesafe/jev-1.13`) on OpenRouter's Decisions API (`POST /api/alpha/decisions`, about $0.04 per million input tokens, output free). The digest goes in `state` as JSON. Two typed questions: `switch` (noul: is something clearly more interesting happening to a different character than to the current focus?) and `focus` (choice over the living agent ids, each described by its current situation). The code decides, on scores that blend Jev with the heuristic: combined = w·p_jev + (1−w)·salience (w = `DIRECTOR_JEV_WEIGHT`, 0.5; salience is the heuristic event score as a smoothed distribution over the living characters, so routine differences stay small). With no valid focus it takes the best combined score; otherwise it switches only if `switch` ≥ `DIRECTOR_SWITCH_P` (0.7) and the best rival beats the focus by `DIRECTOR_SWITCH_MARGIN` (0.15, combined). A rival with a major development skips the margin (not the `switch` threshold or the minimum dwell) unless the current focus has one too. `usage.cost` counts toward the run's cost and caps; `director.jsonl` logs the state, answers (with probabilities), the per-character components (p_jev, salience, normalised salience, combined, major), cost and the rule's outcome.
- `llm` (default elsewhere): `DIRECTOR_MODEL` (same client and cost accounting as the agents) replies `{"focus": "<agentId>"}`.
- `heuristic`: no calls.

Rules enforced in code for every engine: no switch before `DIRECTOR_MIN_DWELL_MS` (no call either); when the focused character dies the camera stays on them for `DIRECTOR_DEATH_HOLD_MS`, then moves; on disconnect it moves at once; answers that don't name a living agent (or are malformed or refused) are ignored (focus kept); errors, no key or over budget fall back to a deterministic heuristic (event salience + a stay bonus; a major development elsewhere beats a focus without one); one candidate = no call; nobody alive = `agentId: null`. In-game text and narration go in as truncated, escaped JSON strings. The director gives no reason: `focus.reason` is always null (deprecated).

**Narrator persona.** The narrator and the story speak as **Dolores Pike**, an original character:

> Dolores Pike presents "Humanity: The Whole Thing". The prompt just points the model at Philomena Cunk's voice (Diane Morgan, "Cunk on Britain" / "Cunk on Earth") plus a few general notes; no worked examples, since models copy examples too literally.

Narration stays 1-3 sentences and grounded in the events (names, who did what); the comedy is in the framing. Prompts and hand-written sample outputs: `agents/docs/narrator-examples.md` (`npx tsx src/tools/narrator-examples.ts` re-renders the prompts).

**Story so far** (`story.ts`). Every `STORY_INTERVAL_MS`, `STORY_MODEL` rewrites a <=80-word summary of the whole world's history (families, notable lives, deaths, firsts) from the previous summary plus narration and births/deaths/first-time items since. Skipped when nothing happened, and while no run is running. One story per process, continuing across runs and restarts (`LOG_DIR/story.jsonl`). The site shows it; the stream page shows recent inventions instead.

**Inventions** (`inventions.ts`). The first time each technology item is made in a run (from action results and the craft macro), with who made it and when: `LOG_DIR/inventions.jsonl`, appended once per item per run, kept across restarts and hot updates, served by `GET /api/inventions`. "Technology" is decided from game data: made by a transition, not food, not a natural object or a state of one, not gathered by hand off the land, not an "X with Y" state, and not a pickup or taking something out of a container. The full rule is in the file's header.

## Running locally

```sh
./server/build.sh                 # ~1 min, needs git + g++ (Xcode CLT on macOS)
./server/reset-local.sh           # wipe world, start server on :8005 in background
cd agents && npm install && npm run dev      # reads ../.env, API on :8787
cd viewer && npm install && npm run dev -- --port 5179   # open http://localhost:5179/?api=http://localhost:8787
```

Useful: `npm run probe` (log in once and print raw messages), `npx tsx src/tools/smoke.ts` (deterministic walk/pick/eat test), `npm test` (all unit/API tests, no game or LLM needed), `npm run typecheck`.

Logging in with the same email resumes the same body if it's still alive. Agent emails are `<run id>-<slot>@mts.local`, where the run id is `<RUN_ID>-r<n>-<timestamp>`. Disconnected characters stay in the world until they die. Without `CONTINUOUS=1` every process start is a fresh run with fresh emails, so a restart abandons the old characters (their lives become `lost`). With `CONTINUOUS=1` the run id survives restarts (see below), so a restarted agents service logs back into the same characters.

## Config (env)

See `.env.example`. The main ones: `OPENROUTER_API_KEY`, `LLM_MODEL` (default `google/gemini-3.8-flash`), `AGENT_COUNT` (4), `MEMORY_MODE` (`per-life` | `persistent`), `RECIPE_HINTS` (1 = show what the held item/bare hands would do to nearby things), run limits (the run halts, every agent disconnects, and LLM calls stop at the first one hit): `MAX_GENERATION` (3: halts when a 4th-generation character is born), `MAX_LIVES` (40), `MAX_RUNTIME_MIN` (90), `MAX_COST_USD` (10). `CONTROL_TOKEN` enables `POST /api/halt?token=...` for a manual stop. Starting after a halt begins a fresh run in the same process (new run id, new log dir, new login emails). Characters from a stopped run stay in the world until they starve, so early babies of the next run may be born to an abandoned mother. `AUTOSTART=0` makes the process start idle; start/stop from the dashboard button (open to anyone if `OPEN_CONTROL=1`, otherwise password = `CONTROL_TOKEN`) or `curl -X POST "$API/api/start?token=$CONTROL_TOKEN"`. `MAX_TOTAL_COST_USD` caps spend across all runs in one process (0 = no cap). `NARRATOR_INTERVAL_MS` (90000, 0 = off) and `NARRATOR_MODEL` (default `OVERHEAD_MODEL`) control the narrator. `OVERHEAD_MODEL` is the default model for the narrator, director and story: `google/gemini-3.1-flash-lite` when `LLM_BASE_URL` is OpenRouter (cheap and fast; checked against OpenRouter's model list), else `LLM_MODEL`. Stream director: `DIRECTOR_INTERVAL_MS` (10000, 0 = off, focus stays null), `DIRECTOR_ENGINE` (`jev` | `llm` | `heuristic`; default `jev` on OpenRouter, else `llm`), `DIRECTOR_JEV_MODEL` (`typesafe/jev-1.13`), `DIRECTOR_SWITCH_P` (0.7), `DIRECTOR_SWITCH_MARGIN` (0.15), `DIRECTOR_JEV_WEIGHT` (0.5), `DIRECTOR_MODEL` (for `llm`; default `OVERHEAD_MODEL`), `DIRECTOR_MIN_DWELL_MS` (45000), `DIRECTOR_DEATH_HOLD_MS` (8000). Story so far: `STORY_INTERVAL_MS` (900000, 0 = off), `STORY_MODEL` (default `NARRATOR_MODEL`, then `OVERHEAD_MODEL`). Others: `OHOL_HOST`/`OHOL_PORT`, `RUN_ID`, `SSE_MAX_CLIENTS` (200 concurrent `/api/stream` clients), `LOG_MAX_FILE_MB` (32: raw per-run logs such as `llm.jsonl` rotate past this to a stable stamped name, `llm.<YYYYMMDDTHHMMSSZ>.jsonl`; 0 = never), `LOG_MAX_TOTAL_MB` (8192: last-resort cap on all run dirs under `LOG_DIR` together; past it the oldest rotated files older than 24 h are deleted, with a warning; 0 = no cap). Every log file is described in `docs/data-format.md`; `deploy/backup-logs.sh` copies them off-site.

`MAX_COST_USD=0` means no per-run cap.

`TIME_SCALE` (1): game time dilation. The game server's whole clock runs k× slower (`server/run.sh` writes it to `settings/timeScale.ini`); the agents use it for client-side constants such as the stock walking speed and years in `lives.ts`. Set the same value on both, or the agents log a `TIME_SCALE mismatch` warning on the first player update. Cost per generation scales with k (see [docs/research/time-scale.md](docs/research/time-scale.md)). Changing k on an existing world is safe; going back to 1 makes pending decays fire at once.

`FOOD_BONUS_S` (18): game seconds the server adds to every food pip. Must match the server's `newPlayerFoodDecrementSecondsBonus` when `mtsNewPlayerFoodBonus=1` (both in `server/settings/`), or 0 with the bonus off. The agents use it for the food facts in the system prompt and the newborn survival window; each turn's food line uses the server's own drain time (HX, already in wall seconds) and needs no setting.
Pace, setup and the LLM client:

- `DECISION_CYCLE_MS` (8000): fixed decision cadence.
  - A decision starts at least this long after the previous one started, whatever the provider latency, so faster models don't act more often in game time (a confound in model comparisons).
  - The loop is sequential. If a turn takes longer than the cycle, the next one starts as soon as its action finishes: no overlap, no backlog.
  - Calibration will pick the final value, likely 3000-4000 with fast inference.
  - `DECISION_INTERVAL_MS` is still read as a fallback.
  - Babies (age < 2) keep `BABY_DECISION_INTERVAL_MS` (15000).
  - Event-driven wake-ups may cut the wait only for salient events (`cadence.ts`).
- `AGENT_COUNT`: use **8-12** for a viable family.
  - The research estimate is 2-3 fertile women each raising one baby, 3-5 children near camp, and 2-3 adults on fire, food and tools.
  - Below about 6, one starvation breaks the line.
  - The default is still 4, for cheap testing.
- Starting setup and rejoins (see "Run setup"):
  - `INITIAL_EVES` (2), `JOIN_STAGGER_S` (90), `JOIN_JITTER` (0.3).
  - `RESPAWN_DELAY_MIN_S` / `RESPAWN_DELAY_MAX_S` (30/90).
  - `LOGIN_STAGGER_MS` is read as the join stagger when `JOIN_STAGGER_S` is unset.
- `LLM_OUTAGE_PAUSE_S` (60, 0 = never): if the provider fails (401/402/403, 5xx, timeouts) for longer than this, the run pauses. Agents disconnect, no one logs in, and affected lives are flagged. The run resumes by itself when a probe call succeeds. See "LLM outages".
- `LLM_PROMPT_CACHE` (1): prompt caching.
  - Gemini and Claude need explicit cache breakpoints through OpenRouter, so for them the static system prompt is sent as a content part with `cache_control: {type: "ephemeral"}`.
  - Other models cache implicitly and get plain strings.
  - Cached tokens are logged per call.
  - Gemini only writes a cache for prompts of at least about 1-4k tokens, so a short system prompt may never hit.
- `LLM_CAPTURE_REASONING` (1): records the model's reasoning text (`message.reasoning` / `reasoning_details`) when the provider returns it.
  - It never changes the request or how the reply is parsed.
  - `LlmResult.reasoningText` exposes it to the agent.
- OpenRouter routing and reasoning. These are sent only when set, and only for the agents' model; the narrator, director and story keep the defaults.
  - `LLM_PROVIDER_SORT` (`throughput` | `latency` | `price`).
  - `LLM_PROVIDER_ORDER` (comma-separated provider slugs, e.g. `groq,cerebras`) with `LLM_PROVIDER_ALLOW_FALLBACKS` (1; 0 = only those providers).
  - `LLM_REASONING_EFFORT` (`off` = `none`, `minimal`, `low`, `medium`, `high`; empty = the model's default; mandatory-reasoning models reject `off`).
  - Per call, `chat(..., { reasoning, provider })` overrides these.
- `LLM_STREAM` (0): 1 streams replies to measure time-to-first-token (`ttftMs`). The parsed result is the same.
- `LLM_MAX_TOKENS` (2000): `max_tokens` per agent call (reasoning counts against it).

## Run setup (starting Eves, joins, respawns)

This is how the stock server decides Eve versus baby. Line numbers are for `OneLife/server/server.cpp` at the pinned `OneLife_liveServer` tag; our patches don't touch this logic.

- **Eve only when no mother is left.** A login becomes an Eve only when the list of candidate mothers ends up empty (`:10712`). There is no random roll for Eve versus baby.
- **Reconnects.** The same email reconnects to its living body (`:9597`), so an account is never born to itself.
- **Who can be a mother.** A woman aged 14-40 (`isFertileAge` `:4312`) who stands in her family's homeland, or whose family has no homeland and who has never been homesick (`:10077`). She must not be SIDS- or curse-blocked for this email (`:10089`, `:10130`).
- **Pass 0: cooldowns and kid limits.** Mothers on birth cooldown or with `maxLivingChildrenPerMother` (4) living kids are skipped (`:10101`). The cooldown is random, 0-5 min (Kumaraswamy distribution, mean about 2.3 min; `pickBirthCooldownSeconds` `:2141`). It is set at each birth (`:11079`) and is 0 for a new Eve (`:11640`).
- **Passes 1-2: the ratio rule.** If every candidate is on cooldown, passes 1-2 ignore cooldowns and the lineage limit (which is skipped anyway at 10 or fewer players). The login still becomes an Eve if either ratio reaches 1.0 (`:10227-10294`):
  - helpless babies (age < 3) / adults >= `maxBabyAdultRatio`
  - babies / fertile mothers >= `maxBabyMomRatio`
- **Settings that don't matter here.**
  - The Eve window, `eveInjectionOn` and `minDaysForEveNaming` don't affect Eve versus baby.
  - The fitness-based forced Eve and special biomes need 30 or more players, or a generation above 100.
  - `forceAllPlayersEve` (`:10682`) and `forceEveLocation` are off.
  - Eves are placed on the moving grid (`useEveMovingGrid=1`, 50-tile jumps).

So quick logins alternate: an Eve, her baby (her cooldown is 0), another Eve (the only mother is now on cooldown and babies/adults = 1), that Eve's baby, and so on. **2N-1 quick logins give N Eves**, N-1 of them with a newborn. A local end-to-end run against the real server produced exactly this: Eve, baby, Eve, then joins born to both Eves.

What the agents service does (`logins.ts`):

1. **Burst.** First logins go one at a time, each after the previous one was born, until `INITIAL_EVES` Eves have appeared. The burst is capped at 2N+1 logins.
2. **Joins.** The other slots join one every `JOIN_STAGGER_S` +- `JOIN_JITTER`. Each join also waits, up to 10 min, until the family has room: helpless babies (< 3) fewer than fertile women and fewer than everyone else among our characters, or no fertile woman alive (then the login is an Eve anyway). Without this wait, the ratio rule turns a join into an extra Eve whenever every mother is on cooldown.
3. **Respawns.** A slot whose character died logs in again after a uniform 30-90 s delay, then the same family-room wait. This is a player choosing when to log in, not a rule change.

What is guaranteed and what isn't:

- **Guaranteed:** on a fresh world with only our agents, the burst gives `INITIAL_EVES` Eves. In a simulation of the rules above (`logins.test.ts`), every random cooldown draw gave 2 Eves and 8 babies.
- **Not guaranteed:**
  - Leftover fertile women from a stopped run, or human players, take the burst logins as their babies. The burst then stops after 2N+1 logins with fewer Eves. Reset the world (`server/reset-local.sh`) or use a new one per run.
  - We can't see cooldowns, homelands or curses. A woman who walks out of her family's homeland silently stops counting as a mother.
  - A join that waits the full 10 min becomes an Eve if the family is still full.
  - After a pause, agents log back in all at once.

## LLM outages

This applies when the provider fails with outage-class errors (401/402/403, 5xx, timeouts or network errors; not 429 or other 4xx) for longer than `LLM_OUTAGE_PAUSE_S`.

- **Status.** `/api/state` shows `run.status: "paused"`, `pauseKind: "llm-outage"`, a `pauseReason`, and `resumesAt` (the next probe). The system event `paused: LLM provider outage ...` is emitted and `outages.jsonl` gets a line.
- **Agents stop.** Every agent disconnects. Their characters stay in the world unplayed, so none acts on reflexes alone. The login scheduler holds every login, so no new lives start.
- **Lives are flagged.** Every life of the run that was alive at any point since the outage began gets `outage: true` and `validForStudy: false` in its `LifeRecord`, and `validForStudy` in `/api/deaths`. The study page should exclude these lives.
- **Recovery.** One tiny probe call goes out whenever the backoff allows (for a 402: 1 min, doubling to 30 min). When a call succeeds, the run resumes with a `resumed: ...` event. Agents log back in with the same emails, so characters still alive are resumed, and the reconnect isn't counted as a new birth.
- **Timing.** All timing is wall-clock; nothing assumes a game-year length.

## Calibration and benchmarks (fast inference)

`agents/src/tools/calibrate.ts` plays one short session per model and setting against a game server and writes a scorecard JSON (`calibration.ts`).

The scorecard records:

- **Settings:** reasoning effort, `max_tokens`, provider preference, streaming, `decisionCycleMs` and `timeScale`.
- **LLM:**
  - calls; prompt, completion, cached and reasoning tokens (also per call)
  - cost and $/agent-hour
  - LLM latency p50/p90/p99, and time-to-first-token p50/p90 (streamed)
  - the provider that served each call
- **Turn time** (observation built to action dispatched), p50/p90/p99.
- **Decisions** per wall-minute and per game year.
- **Error rates:** JSON error rate and action failure rate.
- **Lives:** lives and Eves, deaths by cause, max generation, babies who survived past 3 (of those whose fate is known).
- **Firsts:** time to the first Sharp Stone, fire and clothing.
- **Comparable rates:** survival rates per wall-minute and per game year.

```sh
cd agents
npx tsx src/tools/calibrate.ts run --model openai/gpt-oss-120b --minutes 15 --agents 8 --port 8005 --out ../calibration \
    --reasoning low --max-tokens 600 --provider-sort throughput --cycle-ms 4000 [--provider-order groq,cerebras --allow-fallbacks 0] [--time-scale 1]
npx tsx src/tools/calibrate.ts summary ../calibration/*.scorecard.json     # markdown table across runs
npx tsx src/tools/calibrate.ts score <run dir> --model <id>                # re-score a finished run from its logs
```

- **Cost and setup.** It spends real money with a real key; `--max-cost` (default $5) caps a session. Streaming is on by default here, for time-to-first-token.
- **Time scale.** `--time-scale` only records the scale; start the game server at the same scale.
- **Fresh world per run.** Reset the world between runs, or give each run its own server, so leftover characters don't become mothers.

`agents/src/tools/bench-endpoint.ts` sends N realistic prompts to any OpenAI-compatible endpoint at a chosen concurrency, for example a self-hosted vLLM server, or OpenRouter with a provider preference. The prompts are the system prompt plus observations from `llm.jsonl` logs. It reports latency and TTFT p50/p90/p99, requests/s, output tokens/s, tokens per call, errors and the serving providers:

```sh
npx tsx src/tools/bench-endpoint.ts --url http://gpu-box:8000/v1 --model Qwen/Qwen3-32B --n 200 --concurrency 20 --max-tokens 600 logs/<run>/llm.jsonl
```

Both tools work free end to end against `npx tsx src/tools/fake-llm.ts --port 8791` (`--base-url http://127.0.0.1:8791` / `--url http://127.0.0.1:8791`).

To run several independent worlds in parallel (the effective n is the number of founding families), see [deploy/WORLDS.md](deploy/WORLDS.md).

Always-on mode and research data:

- `CONTINUOUS=1`: always-on. `MAX_GENERATION`, `MAX_LIVES` and `MAX_RUNTIME_MIN` are ignored and the population keeps going indefinitely. `MAX_COST_USD` defaults to 0 (no cap) in this mode unless set explicitly. Nothing halts the world on spend unless you opt in.
- Run identity in continuous mode: the current run is kept in `LOG_DIR/research/current-run.json`, and a restart **resumes** it: same run id, same emails, so each slot reconnects to its still-living character. The reconnect is logged as a `system` event with `data.reconnect: true` ("a01 reconnected to ..."), not a birth; the life record stays open (no `lost`, still valid for study), and a slot whose character died while the service was down is born again (its old life becomes `lost`). The event `seq` and `run.startedAt` continue. A fresh run starts instead when `NEW_RUN=1` is set, when `LOG_DIR/research/new-run.flag` exists (one-shot, removed on use; `deploy/hot-update.sh --new-run` sets it), after a halt, when `RUN_ID` changed, or when the game server restarted since (`GAME_SERVER_EPOCH`, set by `deploy/start.sh`; a server restart ends every living character). `RESUME_ACROSS_SERVER_RESTART=1` keeps the run anyway, for a server that keeps bodies across restarts. Per-process counters (`stats.totalBirths`, `totalDeaths`, LLM calls and cost in `/api/state`) restart from 0.
- `DAILY_COST_USD` (0 = off): opt-in rolling-24h spend cap across runs and restarts. When it's reached, LLM calls stop (characters idle, the starvation reflex still runs, some die) and `/api/state` shows `run.status: "paused"` with `pauseReason` and `resumesAt`. Calls resume by themselves when the window has room. Spend is logged to `LOG_DIR/research/spend.jsonl`, so a restart doesn't reset the window. `run.dailySpend.last24hUsd` is always reported, with or without the cap.
- `TRAIT_DIMS` (default `openness,conscientiousness,extraversion,agreeableness,neuroticism`): trait dimension names. Nothing else in the code depends on these names.
- `TRAIT_MUTATION_SD` (0.15): mutation SD per dimension when a child inherits its mother's traits.
- `TRAIT_SOURCE`: only `mock` exists for now.

## Research data (lives, lineages, traits)

**Traits are MOCK.** Every life gets a trait vector, sampled and inherited as the study design says, but nothing uses it yet. It does not affect prompts or behaviour (`traitSource: "mock"` everywhere). Steering with persona vectors comes later.

- A **life** is one character, from birth to death: `lifeId = <runId>:<playerId>`. Each rebirth of an agent slot is a new life. An Eve gets each dimension from N(0,1), clipped to ±2.5. A child of one of our agents gets its mother's vector plus N(0, `TRAIT_MUTATION_SD`) per dimension, clipped (`inherited: true`). If the mother is unknown or isn't one of our agents, the child is sampled like an Eve (`inherited: false`). Each life also gets an `activity` tally (moves, tiles walked, forage, eat, craft, baby pickups, feeds, says, ...), counted from its events. See `LifeActivity` in `agents/src/api-types.ts`.
- A **lineage** is identified by its founding Eve's lifeId (or, with `founderIsEve: false`, by the first of our lives born to a mother who isn't ours). It's extinct once no member may still be alive anywhere. Characters we stopped playing without seeing them die (run stopped, service restarted) are `lost`: they count as possibly alive until they would die of old age (`presumedEndAt`), and they can still pass traits to children.
- Code: `traits.ts` (sampling), `lives.ts` (pure reducer over events, lineages), `lifestore.ts` (persistence), `spend.ts` (rolling spend ledger), `research-api.ts` (endpoints). Tests: `npm test` in `agents/`.
- Persistence under `LOG_DIR`: `research/lives.snapshot.json` (rewritten every 10 min) plus `research/lives.journal.jsonl` (changed records appended as they change). On startup the service loads both, so history survives restarts and spans runs. Per-life event logs are written to `<run dir>/lives/<playerId>.jsonl` and read from disk on request.

API (all GET, JSON, CORS `*`; types in `api-types.ts`):

| Endpoint | Returns |
| --- | --- |
| `/api/lives?since=<ms>&limit=<n>` | `LivesResponse`: lives with `updatedAt > since`, oldest update first (limit default 1000, max 5000; `more: true` = page again from the last `updatedAt`) |
| `/api/lives/<lifeId>` | `LifeRecord` (404 if unknown). URL-encode the id. |
| `/api/lives/<lifeId>/log?before=<seq>&limit=<n>` | `LifeLogResponse`: the life's birth/death/thought/say/action/craft events, newest first (default 100, max 500; `nextBefore` for the next page) |
| `/api/lineages` | `LineagesResponse` |
| `/api/deaths?limit=<n>` | `DeathsResponse`: recent observed deaths with cause, age and traits (default 50, max 500) |

`/api/state` also includes `traitDims`, `traitSource`, the `lifeId`/`lineageId`/`traits` of each agent's current life, `lifeId`/`lineageId` on players who are our lives, and `run.continuous`/`pauseReason`/`resumesAt`/`dailySpend`. Bad query params return 400 and unknown ids return 404, both as `{ error }`.

## API

Contract and docs: `agents/src/api-types.ts`. `GET /api/state` (includes `focus` and `story`), `/api/map`, `/api/events?since=N`, `/api/stream` (SSE), `/api/objects`, `/api/story/history?limit=N` (past story versions, newest first; default 20, max 200), `/api/inventions?limit=N` (first time each technology item was made in the current run, newest first; `&run=<runId|all>`), `POST /api/start`, `POST /api/halt`.
Contract and docs: `agents/src/api-types.ts`. `GET /api/state` (includes `focus` and `story`), `/api/map`, `/api/events?since=N`, `/api/stream` (SSE), `/api/objects`, `/api/story/history?limit=N` (past story versions, newest first; default 20, max 200), `/api/agent-spec` (what agents are told and can do: the real system prompt, the action list, key settings, the declared interventions, and the latest finished adult turn from this run; cached 60 s; feeds `agents.html`), `POST /api/start`, `POST /api/halt`.

## Recording and replay

```sh
cd agents && npx tsx src/tools/record.ts http://localhost:8787 ../recordings/showcase.jsonl   # waits for the run to start, exits when it halts
```

The recorder polls `/api/state` (every 2 s), `/api/map` (every 6 s, stored as cell deltas) and `/api/events`. `.github/workflows/pages.yml` builds the viewer in replay mode and publishes it with `recordings/showcase.jsonl` to GitHub Pages.

## Deploying live

**Fly.io (one machine, both processes):** `fly.toml` + `deploy/Dockerfile` + `deploy/start.sh`; commands, secrets, backups and costs in [deploy/README.md](deploy/README.md). The supervisor restarts a crashed agents service without touching the game server, and `deploy/hot-update.sh` ships new agents/viewer code to the running machine without ending any living character (rollback: `deploy/hot-update.sh rollback`). Game-server, patch, dependency or Dockerfile changes need a full `fly deploy`, which restarts the world.

Alternatively, two long-running containers (not serverless): `server/Dockerfile` (game server, TCP 8005, private only, volume at `/data`) and `agents/Dockerfile` (agents service + built viewer at `/`, public on 8787, set `OHOL_HOST` to the server's private hostname). Any Docker host with private networking works; `*/railway.json` are configs for Railway. Set `MAX_TOTAL_COST_USD` or `OPEN_CONTROL=0` before exposing the Start button.

## Interventions (what we add on top of the game)

Keep this list current. Anything here is a possible experimental variable.

Game settings (declared conditions, approved by the user):
- **Naming rules** (user request). No family surname is ever used twice: an Eve's naming with a surname any lineage has had (living or extinct, all runs) is not sent by the agent (`agents/src/agent/naming.ts`; the model is told which names are taken), and the server refuses it too (`free-names.patch`, `mtsFamilyNames.txt` in the run dir). A first name already used in a family is numbered: a mother's "YOU ARE AURORA" becomes "YOU ARE AURORA II" (up to X), and the baby is AURORA II DAWN, family DAWN.
- **New-player food bonus ON.** Set by `server/settings/mtsNewPlayerFoodBonus.ini=1` and `server/patches/new-player-food-bonus.patch`.
  - **What it is in stock OHOL.** New players get +`newPlayerFoodDecrementSecondsBonus` (18 s) on every food pip's drain time, halving with each `newPlayerFoodBonusHalfLifeSeconds` (10 h) of lifetime play. Drain becomes `4 + 40*heat + 18` s per pip (`computeFoodDecrementTimeSeconds`, `server.cpp:4070`). The bonus is set at `:11769-11787`.
  - **Why nobody had it.** The stock server applies the bonus only when the stats server answers (`isUsingStatsServer() && !lifeStats.error`, `:11772`). `playerStats.cpp:72` needs both `useStatsServer` and `remoteReport`, and both are off on our server.
  - **What the patch does.** Every non-tutorial life gets the full bonus (lifetime 0, no decay), so it is the same fixed condition for every life. The eating bonus stays at its shipped value, 0.
  - **Turning it off.** Set `OHOL_SETTING_mtsNewPlayerFoodBonus=0`. The server reads settings at each login, so new lives pick up the change.
  - It may become unnecessary if the game clock is slowed (`TIME_SCALE`). Treat runs with and without the bonus as different conditions.

Run protocol (the same in every condition; recorded in the `run started` event):
- **Fixed decision cadence** (`DECISION_CYCLE_MS`): every model decides at the same pace, whatever its latency.
- **Starting setup and login timing** (`INITIAL_EVES`, `JOIN_STAGGER_S`, the family-room wait, the 30-90 s respawn delay): this only controls when a player logs in, not the game rules. See "Run setup".
- **Outage pause:** lives alive during an LLM outage are flagged `validForStudy: false`.

Equivalent to what a human gets from the official client (always on):
- Pathfinding / click-to-walk, auto-approach before using something, keep-alive, position sync. Paths go around known dangerous animals (Wild Boar, Wolf, Grizzly Bear, Rattle Snake) by 4 tiles, the farthest they jump in one move (or their attack distance + 1 if larger), when a detour of at most 24 tiles exists; otherwise the result says which animal the path passed, and a walk stops when an animal wounds you. A human sees the animal and steers.
- Own name shown explicitly; deaths the character witnessed (who, relation, where) for 5 minutes (the client shows the body/grave).
- What the client draws on screen, as text: your own wound, sickness or dying state as a condition (not a held item; `GameData.condition`); others' wounds; people at their current spot (a carried baby with its carrier, a walker mid-walk with "walking to"); a plant and the food it gives named apart ("Wild Carrot (plant)"); server notices (`MS`); the refusal cue when a baby won't take food; speech from another family tagged (the server scrambles it once 15+ people are alive).
- Hunger and heat values plus "STARVING"/"too cold" labels (stand-in for the hunger bar and heat meter), and relationship labels (mother, child, sibling).
- **Food drain rate** (`agent/observe.ts`): "drains 1 pip per N turns; runs out in about M turns", from the food time the server already sends (`HX`). A human watches the bar shrink; the model gets the same information as a number.
- **Home Marker** (`game/world.ts`): tracked exactly as the client does: the marker nearest the birth chunk's centre (within 16 tiles; children born near their family's marker inherit it), or one the character places. The client shows an arrow and distance; the agent gets "Home: (x,y), 12 tiles NE".
- **Nearest water and fire/heat** within 20 tiles, with direction (`agent/observe.ts`): what a human sees on screen, summarised.
- **Timers on short-lived things** (`agent/observe.ts` `decayTimer`, `game/world.ts`): a thing in view or in hand that changes on its own within 5 game minutes (fire, hot coals, ashes, burning tinder, a firing kiln, hot iron, a ripe carrot row, a leaf) shows what it becomes and in how many turns: "Fire: (3, 4) (becomes Hot Coals in about 7 turns)". The decay time comes from the game data; the age from when this client saw the object appear (a picked-up or dropped item keeps its age); "within N turns" when it was already there when first seen. A human sees the fire shrink; moving animals get no timer.
- **Danger line** (`agent/observe.ts` `dangerLine`): dangerous animals within the view radius (12 tiles) with position, distance and direction: "DANGER: Wild Boar at (5, 0), 5 tiles E". A human sees them on screen.
- **Actions lists** (`ACTION_LIST_MAX=4`; `agent/steps.ts`), human-UI equivalent: a reply may give up to N actions that run back to back, like a human clicking quickly while thinking. The list stops at the first step that fails or as soon as a salient event arrives, and each step's result is reported. Needed for the 10 s decay windows of the fire chain (Ember Shaft, Ember Leaf, Burning Tinder) and of hot iron: 4 fits the ember chain (drill, swap for leaf, leaf on shaft, ember leaf on tinder) in one list. Not easier than for a human: a human chains clicks at about one per second.
- **Stale-target check** (`agent/steps.ts`): the observation is built right before the LLM call; when the action runs, a target tile whose object changed meanwhile (taken by someone, decayed) is not acted on and the model is told what it is now; a person who moved is noted. A human sees the change before clicking.
- **Durations in turns** (`agent/turns.ts`): all times in the prompt and observation are converted from game seconds to the agent's decision turns (decision cycle x server time scale). A presentation choice, no extra information.

Like human experience or the wiki (on for now, may change later):
- **Game facts and an early-game playbook in the system prompt** (`agent/prompt.ts`): food drain vs heat including the food bonus (`FOOD_BONUS_S`; cold drains ~1.7x faster with the bonus, ~3.5x without), food values, newborn survival unheld (3 cold pips, in turns), the nursing rules (a pickup refills only a starving baby and costs the woman 1 food), camp priorities (water + berries, Sharp Stone, fire, clothing, basket / Home Marker, bowls, berry farm), fire upkeep (Fire to Hot Coals to Ashes in turns; kindling refeeds fire and coals, not ashes), cook on Hot Coals not Fire (it burns), watering regrows an empty wild gooseberry bush and a domestic one needs soil then water, food values falling with generation (stock `eatBonus`/`eatCostMax`), "don't stand idle holding a baby while hungry", naming/leadership phrases, broad objective. Numbers are checked against our server build (`docs/research/ohol-success.md`). Could be cut down to a minimal prompt.
- **Recipe hints** (`RECIPE_HINTS=1`, `agent/observe.ts`): every turn, lists what the held item or bare hands would do to nearby things (up to 10). Stronger than the wiki because it's contextual and free.

Declared changes to the game itself:
- **Time dilation** (`TIME_SCALE=k`, default 1 = stock; `server/patches/time-scale.patch`): the game clock is slowed k× uniformly so LLM reaction time matches the game's pace; all in-game ratios are preserved. Aging, hunger and heat drain, decay and regrowth, cooldowns and walking speed all run k× slower in wall time. The server reports durations and speeds in wall seconds, so clients need no special handling. Set the same `TIME_SCALE` for the server and the agents. How to pick k: [docs/research/time-scale.md](docs/research/time-scale.md).
- **Per-person flowers** (`agents/src/flowers.ts`, `lives.ts`): not in the original game. Every character wears a flower in its hair (11 shapes x 7 colours: five real OHOL flower sprites and six AI-generated in the OHOL style, `viewer/public/flowers/`), visible to agents and viewers, so individuals can be told apart (siblings otherwise share hairstyle, face and similar hair colour). The agents service assigns it at birth, unique among the living members of the family and stable for life; the viewer draws `LifeRecord.flower`. Observations show it as "You wear a blue daisy in your hair." and next to each nearby person ("#12 Hope Dawn (woman, 24, red rose)"); the system prompt says everyone wears a unique flower.
- **Player saves across restarts** (`mtsPlayerSaves=1`; `server/patches/player-saves.patch`): stock OHOL loses every living character when the server restarts. With saves on, a restart or crash brings them back: same id, name, lineage, position, age, food, held item and clothing. The downtime doesn't count, because the game clock is paused for restored players. A `kill -9` rolls players back to the last save, up to 30 s. The agents must log back in with the same email; a restored player who doesn't return within 15 min dies. Details and limits: [docs/research/game-saves.md](docs/research/game-saves.md).

Beyond a human player (kept for now, noted):
- **`craft <item>` macro** (`CRAFT_MACRO=1`, default on; `game/craft.ts`): **temporary; the user intends to reconsider removing it before the main study.** The agent names an item; code plans the recipe chain over the game's transition graph from what is held and in view (20 tiles), and performs the steps (pick up, drop, use) itself, up to 12 transitions per action, interruptible by urgent events. It reports progress, missing ingredients, or why it stopped. The knowledge is wiki-level (a human with onetech open); the automation of many clicks is beyond a human. Runs with and without it are different conditions.
- **Forage action** (`Body.forage`): one action that walks to the nearest (or chosen) hand-pickable food, picks it and eats it. Whatever is in hand comes along: a tool or a baby is set down next to the food for the pick-and-eat and picked back up right after. The agent chooses to forage; code chooses which food.
- **Starvation reflex** (`Agent.turn`): at food <= 2 (age 3+), code runs forage without asking the LLM, at most every 20 s. Logged as `reflex: true` in events.
- **Food summary** (with recipe hints on): hand-pickable food left within 20 tiles (counting berries left on bushes) and the nearest spots with coordinates. A human sees the bushes; the count is a convenience.
- **Babies line** for mothers: where each of her babies under 3 is (in her arms, held by someone, or on the ground at x,y) and that an unheld newborn dies within ~4 turns. Replaces the old, wrong "starves within a few minutes" nudge.
- **Birth spot as home** when no Home Marker is known: "You were born at (x,y)". The client doesn't show absolute positions, so this is marginally beyond the UI.
- **Event-driven turns** (`agent/salience.ts`): salient events (own baby says "F", food falls to half / a quarter / starving, birth, a death nearby, being picked up or put down, speech nearby) wake an agent early and end a `wait`, and urgent ones cut a long walk or a craft short; the triggering events are listed under "JUST HAPPENED". A human notices these by watching; the agent gets them as alerts. The minimum decision interval still applies.
- **Babies wait for events**: under age 3 an agent with nothing new happening is asked at most every `BABY_IDLE_MAX_MS` (default 60 s) instead of polling; babies under 2 keep the 15 s minimum interval.
- **Wasted-turn feedback** (`agent/reply.ts`): an unparseable reply or an invalid action is explained in the next observation (with the valid action types). Fair play: the human UI simply doesn't allow malformed input.
- **Mild reasoning cap** (`LLM_REASONING_CAP=1`, default on): the model keeps some reasoning, capped at `LLM_REASONING_MAX_TOKENS=300` reasoning tokens (OpenRouter `reasoning.max_tokens`; set 0 to send `reasoning.effort: "low"` instead) inside `LLM_DECISION_MAX_TOKENS=800` in total, so decisions arrive faster and the visible JSON (with its `thought`) is not truncated. A model that ignores the cap and returns a cut-off reply gets one retry with the full `LLM_MAX_TOKENS` budget; after two such failures it runs uncapped. Not a game aid, but it changes how much the model thinks per turn.
- **Edible food list** (with recipe hints on): nearest hand-pickable food with coordinates, so the agent can pick a target for `forage`.
- **Nudge line** in observations for mothers: "A baby left alone starves within a few minutes."
- Babies decide every 15 s instead of every `DECISION_CYCLE_MS` (8 s).

## Costs (measured)

Gemini 3.8 Flash: about $0.003 per decision (~5k token prompt). Before the fixed cycle, latency set the pace: one agent decided every 4-6 s, roughly $2-3 per agent-hour. The 8 s `DECISION_CYCLE_MS` caps it at 450 decisions per agent-hour. See `docs/research/cost/` for the full model. 10 agents for 24 h would be ~$500-700. Cheaper options: `anthropic/claude-haiku-5.5` or `deepseek/deepseek-v4-flash` are ~10x cheaper per token; shorter observations; slower decision interval; only calling the LLM when something changes.

## Things learned about OHOL

- Protocol is plain text over TCP, spec in `OneLife/server/protocol.txt`. Login with ticket checks off accepts any email.
- Stock coordinates are relative to each player's birth position. Patched.
- Wild food doesn't regrow quickly. Respawning every Eve at one spot starved ~100 lives in 90 minutes on the first Railway run.
- You can't walk "down" (y-1) out of a blocking object you're standing in. Eve spawn points can be on a monument, so this matters.
- `USE` needs the target orthogonally adjacent or under you. Paths are 8-way, max ±16 tiles per `MOVE`.
- Babies under 0.2 years can't move. A woman nurses a baby by carrying it. Babies starve fast if put down.
- Many features (family languages, birthlands, Eve windows) only turn on above 15 players. With 4 agents there are no language barriers.
- Naked characters get very cold (heat ~0.07), which speeds up hunger. Clothing and fire matter early.
- Eve naming needs `minDaysForEveNaming=-1`. Default is 15 days of account age; with the stats server off, a returning email's account age reads as -1, so even 0 blocks every agent's second and later lives (server replies "NAMING HELP").
- `server/stressTestClient.cpp` in upstream is a minimal reference bot.

## Next

- Sprites from OneLifeData7 in the viewer instead of colored squares.
- Measure baby survival and generations per run; tune the prompt (cold, clothing, fire) without scripting behavior.
- Cut cost: compact observations, event-driven calls, cheaper model for babies.
- Experimental conditions: persistent vs per-life memory, recipe hints on/off, model diversity per slot.
- Look for prior OHOL agent work before claiming novelty.
