# ohol-agents

LLM agents living in a private [One Hour One Life](https://onehouronelife.com/) (OHOL) server, through the real game protocol. They are born, get named by their mothers, are nursed, forage, craft, talk, die, and are reborn into whatever family exists. A web viewer shows what each one sees, says and thinks.

**Watch a recorded run: https://mvonebers.com/ohol-agents/** (static replay, no backend; scrub and change speed with the bar at the bottom)

## What's here

- Stock OHOL server (v438 code, v437 data) with three small patches, built from source.
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
| `server/patches/` | `absolute-coords.patch`: every client gets absolute world coordinates (stock server sends coords relative to each player's birth spot). `dump-game-data.patch`: `OHOL_DUMP_GAME_DATA=<path>` writes all objects + transitions as JSON and exits. `free-names.patch`: with `mtsFreeNames=1`, names are used as spoken instead of being snapped to the nearest entry in the server's name lists (stock OHOL forces Eve surnames and baby first names into `lastNames.txt`/`firstNames.txt`). Eves can say "I AM <FIRST> <FAMILY>". |
| `server/settings/` | Our overrides: no ticket/stats/lineage/etc. backend servers, no apocalypse, Eve naming allowed. (We tried forcing all Eves to spawn at (0,0); it turned the spawn into a famine zone once the berries were eaten, so Eve placement is back to stock.) |
| `data/game-data.json.gz` | Output of the dump (11,401 objects incl. generated "use dummies", 53k transitions). Regenerate with `server/build.sh` when bumping upstream tags. |
| `agents/` | TypeScript (Node 24, tsx). See below. |
| `viewer/` | Vite + React static site ("Artificial Selection"): `index.html` home, `stream.html` 1920x1080 overlay, `agent.html?life=<lifeId>`, `study.html`, and the original dashboard at `replay.html`. `?api=<url>` points any page at an agents service, `?fixture=<name>` serves a captured snapshot from `viewer/fixtures/` (no API calls; `node scripts/capture-fixture.mjs <name>`), `?replay=<url>` / `?mock` (dashboard only). Shared code: `src/theme/`, `src/data/`, `src/shared/`. |
| `recordings/showcase.jsonl` | The recorded run behind the hosted demo. |

### Agents code

- `protocol/connection.ts`: TCP, `#`-framed messages, zlib `CM`/`MC` payloads, login. `protocol/messages.ts`: typed parsers (tests in `messages.test.ts`).
- `game/world.ts`: what one character has been told by the server (map cells, people, speech, food, heat, lineage). Each agent only sees its own world.
- `game/body.ts`: deterministic control. A* pathfinding, walking in legs of 15 tiles, and actions (use, drop, swap, take out, eat, pick up baby, feed, say, forage).
- `agent/observe.ts`: turns the world into the text observation. `agent/prompt.ts`: system prompt (game basics, broad objective, action JSON format).
- `agent/agent.ts`: one slot. Loop: observe, ask LLM, run action, record result. One reflex: if starving, forage. Memory is a per-life notebook, wiped at death unless `MEMORY_MODE=persistent`.
- `population.ts`: keeps N slots alive, enforces run limits, records who heard each spoken line, builds the viewer state. `narrator.ts`: broadcast narrator. `api.ts`: HTTP + SSE. Contract in `api-types.ts` (copied to `viewer/src/`).
- `director.ts`: stream camera (which one character the stream page shows). `story.ts`: rolling "story so far". `safety.ts`: sanitizing model output and quoting agent text in prompts. See "Stream" below.
- Logs (JSONL, one dir per run under `LOG_DIR`): `events.jsonl`, `llm.jsonl` (every observation, reply, tokens, cost, latency), `lives.jsonl`, `narration.jsonl`, `director.jsonl` (every director decision, prompt and reply), `lives/<playerId>.jsonl` (per-life events). Across runs: `LOG_DIR/research/` (life records, spend ledger; see "Research data"). `LOG_DIR/story.jsonl` (outside the run dirs) holds every story version and is reloaded on startup.

## Stream (one character at a time)

For a 24/7 Twitch/X page that shows one character big.

**Director** (`director.ts`). Picks the living character the camera follows: `focus` on `/api/state`, plus a `"focus"` event on each change. Every `DIRECTOR_INTERVAL_MS` it may ask `DIRECTOR_MODEL` (same client and cost accounting as the agents, so it counts toward `MAX_COST_USD`) with a digest of each living character (name, age, generation, family, goal, last thought/said/action, notable events in the last 30 s: births, deaths, starving, a baby left alone, first-time items, conversations). The model replies `{"focus": "<agentId>", "reason": "<short phrase>"}`. Rules enforced in code: no switch before `DIRECTOR_MIN_DWELL_MS` (no LLM call either); when the focused character dies the camera stays on them for `DIRECTOR_DEATH_HOLD_MS`, then moves; on disconnect it moves at once; replies that aren't one JSON object naming a living agent are ignored (focus kept); LLM errors, no key or over budget fall back to a deterministic heuristic (event salience + a stay bonus); one candidate = no LLM call; nobody alive = `agentId: null`. In-game text goes into the prompt as truncated, escaped JSON strings, and the reason is stripped of control chars, links, mentions and markup and capped at 80 chars.

**Narrator persona.** The narrator and the story speak as **Dolores Pike**, an original character:

> Dolores Pike presents "Humanity: The Whole Thing", a live documentary she has been told covers all of history, and she is taking that very seriously.
> She is deadpan, earnest and a little baffled, frames gooseberries as turning points of civilisation, and is often confidently wrong about the wider world but never about what just happened on screen.

Narration stays 1-3 sentences and grounded in the events (names, who did what); the comedy is in the framing. Prompts and hand-written sample outputs: `agents/docs/narrator-examples.md` (`npx tsx src/tools/narrator-examples.ts` re-renders the prompts).

**Story so far** (`story.ts`). Every `STORY_INTERVAL_MS`, `STORY_MODEL` rewrites a <=150-word summary of the whole world's history (families, notable lives, deaths, firsts) from the previous summary plus narration and births/deaths/first-time items since. Skipped when nothing happened, and while no run is running. One story per process, continuing across runs and restarts (`LOG_DIR/story.jsonl`).

## Running locally

```sh
./server/build.sh                 # ~1 min, needs git + g++ (Xcode CLT on macOS)
./server/reset-local.sh           # wipe world, start server on :8005 in background
cd agents && npm install && npm run dev      # reads ../.env, API on :8787
cd viewer && npm install && npm run dev -- --port 5179   # open http://localhost:5179/?api=http://localhost:8787
```

Useful: `npm run probe` (log in once and print raw messages), `npx tsx src/tools/smoke.ts` (deterministic walk/pick/eat test), `npm test` (all unit/API tests, no game or LLM needed), `npm run typecheck`.

Logging in with the same email resumes the same body if it's still alive. Agent emails are `<RUN_ID>-<slot>@mts.local`, so restarting the agents process reconnects to the same characters. Disconnected characters stay in the world until they die.

## Config (env)

See `.env.example`. The main ones: `OPENROUTER_API_KEY`, `LLM_MODEL` (default `google/gemini-3.8-flash`), `AGENT_COUNT` (4), `MEMORY_MODE` (`per-life` | `persistent`), `RECIPE_HINTS` (1 = show what the held item/bare hands would do to nearby things), run limits (the run halts, every agent disconnects, and LLM calls stop at the first one hit): `MAX_GENERATION` (3: halts when a 4th-generation character is born), `MAX_LIVES` (40), `MAX_RUNTIME_MIN` (90), `MAX_COST_USD` (10). `CONTROL_TOKEN` enables `POST /api/halt?token=...` for a manual stop. Starting after a halt begins a fresh run in the same process (new run id, new log dir, new login emails). Characters from a stopped run stay in the world until they starve, so early babies of the next run may be born to an abandoned mother. `AUTOSTART=0` makes the process start idle; start/stop from the dashboard button (open to anyone if `OPEN_CONTROL=1`, otherwise password = `CONTROL_TOKEN`) or `curl -X POST "$API/api/start?token=$CONTROL_TOKEN"`. `MAX_TOTAL_COST_USD` caps spend across all runs in one process (0 = no cap). `NARRATOR_INTERVAL_MS` (30000, 0 = off) and `NARRATOR_MODEL` control the narrator. Stream director: `DIRECTOR_INTERVAL_MS` (10000, 0 = off, focus stays null), `DIRECTOR_MODEL` (default `LLM_MODEL`), `DIRECTOR_MIN_DWELL_MS` (45000), `DIRECTOR_DEATH_HOLD_MS` (8000). Story so far: `STORY_INTERVAL_MS` (300000, 0 = off), `STORY_MODEL` (default `NARRATOR_MODEL`, then `LLM_MODEL`). Others: `OHOL_HOST`/`OHOL_PORT`, `RUN_ID`, `DECISION_INTERVAL_MS`, `SSE_MAX_CLIENTS` (200 concurrent `/api/stream` clients), `LOG_MAX_FILE_MB` (32: raw per-run logs such as `llm.jsonl` rotate to `<file>.1` past this; 0 = never).

`MAX_COST_USD=0` means no per-run cap.

Always-on mode and research data:

- `CONTINUOUS=1`: always-on. `MAX_GENERATION`, `MAX_LIVES` and `MAX_RUNTIME_MIN` are ignored and the population keeps going indefinitely. `MAX_COST_USD` defaults to 0 (no cap) in this mode unless set explicitly. Nothing halts the world on spend unless you opt in.
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

Contract and docs: `agents/src/api-types.ts`. `GET /api/state` (includes `focus` and `story`), `/api/map`, `/api/events?since=N`, `/api/stream` (SSE), `/api/objects`, `/api/story/history?limit=N` (past story versions, newest first; default 20, max 200), `POST /api/start`, `POST /api/halt`.

## Recording and replay

```sh
cd agents && npx tsx src/tools/record.ts http://localhost:8787 ../recordings/showcase.jsonl   # waits for the run to start, exits when it halts
```

The recorder polls `/api/state` (every 2 s), `/api/map` (every 6 s, stored as cell deltas) and `/api/events`. `.github/workflows/pages.yml` builds the viewer in replay mode and publishes it with `recordings/showcase.jsonl` to GitHub Pages.

## Deploying live

**Fly.io (one machine, both processes):** `fly.toml` + `deploy/Dockerfile` + `deploy/start.sh`; commands, secrets, backups and costs in [deploy/README.md](deploy/README.md).

Alternatively, two long-running containers (not serverless): `server/Dockerfile` (game server, TCP 8005, private only, volume at `/data`) and `agents/Dockerfile` (agents service + built viewer at `/`, public on 8787, set `OHOL_HOST` to the server's private hostname). Any Docker host with private networking works; `*/railway.json` are configs for Railway. Set `MAX_TOTAL_COST_USD` or `OPEN_CONTROL=0` before exposing the Start button.

## Interventions (what we add on top of the game)

Keep this list current. Anything here is a possible experimental variable.

Equivalent to what a human gets from the official client (always on):
- Pathfinding / click-to-walk, auto-approach before using something, keep-alive, position sync.
- Own name shown explicitly; deaths the character witnessed (who, relation, where) for 5 minutes (the client shows the body/grave).
- Hunger and heat values plus "STARVING"/"too cold" labels (stand-in for the hunger bar and heat meter), and relationship labels (mother, child, sibling).

Like human experience or the wiki (on for now, may change later):
- **Game facts in the system prompt** (`agent/prompt.ts`): nursing by carrying, naming phrases ("I AM EVE X", "YOU ARE X"), babies say "F", leadership/property phrases, broad objective. Could be cut down to a minimal prompt.
- **Recipe hints** (`RECIPE_HINTS=1`, `agent/observe.ts`): every turn, lists what the held item or bare hands would do to each nearby thing. Stronger than the wiki because it's contextual and free.

Beyond a human player (kept for now, noted):
- **Forage action** (`Body.forage`): one action that picks the nearest hand-pickable food, walks there, picks, eats, and puts down / re-picks a carried baby. The agent chooses to forage; code chooses which food.
- **Starvation reflex** (`Agent.turn`): at food <= 2 (age 3+), code runs forage without asking the LLM, at most every 20 s. Logged as `reflex: true` in events.
- **Edible food list** (with recipe hints on): nearest hand-pickable food with coordinates, so the agent can pick a target for `forage`.
- **Nudge line** in observations for mothers: "A baby left alone starves within a few minutes."
- Babies decide every 15 s instead of every 2.5 s.

## Costs (measured)

Gemini 3.8 Flash: about $0.003 per decision (~5k token prompt). One agent makes a decision every 4-6 s, so roughly $2-3 per agent-hour. 10 agents for 24 h would be ~$500-700. Cheaper options: `anthropic/claude-haiku-5.5` or `deepseek/deepseek-v4-flash` are ~10x cheaper per token; shorter observations; slower decision interval; only calling the LLM when something changes.

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
