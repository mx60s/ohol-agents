# Running several independent worlds

**Why.** For trait analyses the effective n is the number of founding
families (see `docs/decisions.md`). The survival research, though, says each
world should start with only a few Eves (`INITIAL_EVES` 2-4) and then grow by
births, because many Eves in one world scatter into one-woman camps
(`docs/research/ohol-success.md` §8). Several small worlds running in
parallel give both: few Eves per world, and many founding families overall.
Worlds must be fully independent, with no shared map and no cross-world
births, so that each family is a separate replicate.

## What "one world" is

One world is one OHOL game server with its own run dir (map and player DBs),
driven by one agents service with its own:

| setting | per world | why |
| --- | --- | --- |
| game server run dir (`WORLD_DIR` / `server/run.sh <build> <run dir>`) | yes | the map, players and lineages live in it |
| game port (`PORT_OVERRIDE` for the server, `OHOL_PORT` for the agents) | yes | |
| `OHOL_HOST` | per host | 127.0.0.1 when both processes share a machine |
| `RUN_ID` | **yes, unique** | login emails are `<run>-<slot>@mts.local`, and lifeIds are `<RUN_ID>-r<n>-<ts>:<playerId>`. Distinct `RUN_ID`s keep lifeIds globally unique, so the worlds' life records can be merged for analysis without collisions |
| `LOG_DIR` | **yes, separate** | holds `research/` (lives snapshot and journal, spend ledger) and `story.jsonl`. Two processes writing one `LOG_DIR` would corrupt the snapshot |
| `PORT` (agents API) | yes | each world has its own `/api` |
| `DAILY_COST_USD`, `MAX_TOTAL_COST_USD` | per world | the caps and the spend ledger are per process. To cap total spend, divide the budget by N, or use a provider-side limit (an OpenRouter key credit limit) |
| model, cadence, interventions (`LLM_MODEL`, `DECISION_CYCLE_MS`, `RECIPE_HINTS`, the food bonus...) | same in every world of one condition | a world is a replicate. Record each world's config with its data: the `run started` event carries it |

I checked the code for anything that assumes a single world. Every host, port
and path comes from env (`agents/src/config.ts`), and nothing is shared
between processes except the provider account. Only the local helper
`server/reset-local.sh` hardcodes port 8005.

## Option A (recommended): N independent (game server + agents service) pairs

Run `deploy/start.sh` N times, each with its own env. The script already reads
`WORLD_DIR`, `LOG_DIR`, `GAME_PORT` and `PORT` from the environment:

```sh
for i in 1 2 3 4; do
  WORLD_DIR=/data/w$i/world LOG_DIR=/data/w$i/logs GAME_PORT=$((8004 + i)) PORT=$((8786 + i)) \
  RUN_ID=w$i INITIAL_EVES=2 AGENT_COUNT=10 \
    deploy/start.sh > /data/w$i/start.log 2>&1 &
done
```

Locally, without start.sh: `PORT_OVERRIDE=800$i server/run.sh .ohol-build .ohol-run-w$i`, then in `agents/`
`OHOL_PORT=800$i RUN_ID=w$i LOG_DIR=./logs-w$i PORT=878$i npm run dev`.

- **Isolation:** a crash, outage pause, halt or restart affects one world
  only. Worlds can't leak births or characters into each other.
- **No code changes.** It works today. The single-world code path is what's
  tested.
- **Cost of the extra processes:** measured locally, an idle game server uses
  under 1% of a core and a few MB of resident memory; it uses more with
  players and a big explored map. An agents service is one Node process. With 4 worlds of
  10 agents, the LLM bill dominates by orders of magnitude, and one 2-4 vCPU
  machine is enough. On Fly, keep everything on one machine: the game server
  binds IPv4 only, so a server and its agents must share loopback (see
  `deploy/README.md`). That means one supervisor running N start.sh
  instances, or N machines with one pair each.
- **Downsides:**
  - There are N APIs. The viewer takes `?api=<url>` per world, so the site
    needs a world picker, or one page per world.
  - The study page must read and merge N `/api/lives` feeds (lifeIds don't
    collide when `RUN_ID`s differ). Alternatively, a nightly job can merge
    the N `research/lives.snapshot.json` files.
  - The spend caps are per world.
  - The narrator, director and story run per world, so their overhead is
    N times. Set `DIRECTOR_INTERVAL_MS=0` and `STORY_INTERVAL_MS=0` on worlds
    nobody streams.

## Option B: one agents service managing N worlds

One process holds N `RunController`s, one per `(OHOL_HOST, OHOL_PORT,
RUN_ID, LOG_DIR)`, behind one API (`/api/w/<world>/state`, ...) with a
merged `/api/lives`.

- **Upsides:** one URL, one spend cap across worlds, and one place to merge
  the research data.
- **Downsides:**
  - It needs real changes: world-scoped API routes and SSE, per-world
    config objects instead of the global `config`, and a viewer contract
    change.
  - One process becomes a shared failure domain: a crash or event-loop stall
    hits every world.
  - Shared state is the most likely way for worlds to stop being
    independent, for example one shared `LlmHealth`, which would pause every
    world on a single outage.

## Recommendation

Use **Option A**. It is simpler, it keeps worlds statistically independent by
construction, and it needs no code. Add two small things when the study
starts:

1. A supervisor that runs N `start.sh` with `RUN_ID=w<i>` and a distinct
   `LOG_DIR`, `WORLD_DIR`, `GAME_PORT` and `PORT` per world.
2. A merge step for analysis: fetch each world's `/api/lives` or snapshot,
   tag each record with its world, and concatenate. Exclude records with
   `validForStudy: false`. The family-aware tests then treat each world's
   founding families as clusters.

Revisit Option B only if one public URL for all worlds becomes a hard
requirement. Even then, a thin proxy in front of N Option A services is
cheaper than merging the processes.

**How many worlds?** Each world should run `AGENT_COUNT` 8-12, the minimum
viable family, with 2-4 Eves. If about 80 founding families are needed and
each world founds 2-4 families per run plus more over time as lines die out
and new Eves appear, plan for about 4-8 worlds over several runs. Founding
families are what count, not world-hours.
