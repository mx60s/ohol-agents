# Deploying the always-on world to Fly.io

A single Fly app (`artificial-selection`) runs one machine with both processes,
which talk over `127.0.0.1`. `deploy/start.sh` supervises them:

| process | port | data |
| --- | --- | --- |
| OHOL game server (`OneLifeServer`, compiled in `deploy/Dockerfile`) | 8005, internal only | `/data/world` (map/player DBs, server logs) |
| agents service + built viewer (`/` = site, `/api/*`) | 8787, public via `http_service` | `/data/logs` (`LOG_DIR`: run logs, `research/`, spend, story) |
| (hot updates) | | `/data/app` (`versions/<v>`, `current`, `previous`) |

`/data` is a single Fly volume, `as_data`.

**Why one machine:** Fly's private network (6PN) is IPv6-only, and the game
server binds IPv4 only. In minorGems `network/linux/SocketServerLinux.cpp` it
calls `socket(AF_INET, …)` and binds `sin_addr.s_addr = INADDR_ANY`, which is
`0.0.0.0` with no `AF_INET6`. A second app could not reach it over
`*.internal` without patching the server. On one machine, loopback IPv4 works
and there is only one VM to pay for.

The GitHub Pages site (`.github/workflows/pages.yml`) calls this API
cross-origin. `SITE_API_URL` defaults to `https://artificial-selection.fly.dev`,
or set the repository variable `SITE_API_URL`.

## What start.sh does

1. On first boot, it creates `/data/world` and `/data/logs` on the empty
   volume. `server/run.sh` then links the build into `/data/world`, and the
   server creates a new world. Each boot after that reuses the existing world.
   If the server's `log.txt` grows past 64 MB, start.sh rotates it to
   `log.txt.1`.
2. Starts `server/run.sh /opt/ohol /data/world` and waits up to 180 s for
   `127.0.0.1:8005`.
3. Starts the agents service (`node --import tsx src/main.ts`) with
   `OHOL_HOST=127.0.0.1`, `LOG_DIR=/data/logs`, `CONTINUOUS=1`,
   `AUTOSTART=1` and `GAME_SERVER_EPOCH` (when it launched the game server).
   The code comes from the hot-update override `/data/app/current` if it is
   valid and was installed on this image (see [Hot update](#hot-update)),
   otherwise from the image (`/app/agents`, `/app/viewer/dist`).
4. On SIGTERM or SIGINT (`kill_signal = "SIGTERM"`, `kill_timeout = 60s`):
   - It sends SIGTERM to the agents service. The agents disconnect, flush the
     journal and write `research/lives.snapshot.json`. In continuous mode the
     open lives stay open: the next start resumes the run (below).
   - It then sends **SIGTSTP** to OneLifeServer, the server's own graceful-quit
     signal. SIGTERM would just kill it.
   - It exits 0. Any process still running after its timeout gets SIGKILL.
5. If the **agents service** exits on its own (crash, OOM, missing key), only
   the agents service is restarted. The game server and every living
   character stay up, and the restarted agents log back into their
   characters. Backoff doubles from `AGENTS_BACKOFF_BASE` (2 s) up to
   `AGENTS_BACKOFF_MAX` (60 s); a run of `AGENTS_STABLE_S` (120 s) resets it.
   After `AGENTS_MAX_CRASHES` (5) quick crashes in a row it is a crash loop:
   a hot-update override is dropped (back to the image's code, logged in
   `/data/app/disabled.log`); already on the image's code, it retries every
   `AGENTS_GIVEUP_RETRY_S` (300 s) and leaves the world running.
6. **SIGUSR1** restarts only the agents service (graceful SIGTERM, then a new
   start that re-reads the override). This is how a hot update applies.
7. If the **game server** exits, start.sh stops the agents and exits 1.
   `[[restart]] policy = "always"` brings the machine back (a new world
   epoch: the agents start a fresh run).

start.sh writes its pid to `/tmp/as-supervisor.pid` and its state (pids,
which code the agents run, crash count) to `/tmp/as-supervisor.state`.

Note: Fly's HTTP checks only gate routing and deploys. They do not restart a
machine. The restart comes from start.sh exiting when the game server dies.

### Run identity across restarts

The agents' login emails derive from the run id, and OHOL hands a still-living
body back to the same email. With `CONTINUOUS=1` the current run is kept in
`/data/logs/research/current-run.json` and a restart of the agents service
(crash, SIGUSR1, hot update) reuses it, so every slot reconnects to its
character. Reconnects are `system` events with `data.reconnect: true`, never
births; the life records stay open and valid. A fresh run (new emails, new
characters, the old ones become `lost`) starts on:
- a game-server restart (full deploy, machine restart): stock OHOL ends every
  living character then, and reused emails could be confused with recycled
  player ids (`RESUME_ACROSS_SERVER_RESTART=1` turns this off);
- a halt (`/api/halt`, spend cap);
- `NEW_RUN=1`, or the one-shot flag `/data/logs/research/new-run.flag`
  (`deploy/hot-update.sh --new-run` sets it);
- a changed `RUN_ID`.

## Updating: hot update vs full deploy

| change | how | the world |
| --- | --- | --- |
| `agents/src/**`, `viewer/**`, `data/game-data.json.gz` | `deploy/hot-update.sh` | keeps running; agents reconnect within seconds |
| `server/**` (patches, settings, run.sh), the OHOL pins | `fly deploy` | restarts: every living character ends, fresh run |
| `deploy/start.sh`, `deploy/Dockerfile`, `deploy/app-switch.sh` | `fly deploy` | restarts |
| agents dependencies (`agents/package-lock.json`) | `fly deploy` (hot-update refuses) | restarts |
| `fly.toml` `[env]`, `fly secrets set` | `fly deploy` / secrets apply | restarts |
| viewer art (`npm run assets`, the OneLifeData7 pin) | `fly deploy` | restarts |

### Hot update

Run from the repo root on your laptop, with `fly` logged in:

```sh
deploy/hot-update.sh                 # build, upload, switch, restart the agents, verify
deploy/hot-update.sh --new-run       # same, and start a fresh run (new characters)
deploy/hot-update.sh --skip-viewer-ci   # reuse viewer/node_modules instead of npm ci
deploy/hot-update.sh status          # what the machine runs, versions, supervisor state
deploy/hot-update.sh rollback        # back to the previous version (toggles)
deploy/hot-update.sh rollback --image   # back to the image's own code
```

Steps:
1. Type-checks the agents. Builds the viewer (`npm ci`, then `npm run build`
   with `VITE_API_URL=same-origin`) into a staging dir. The OHOL art is not
   uploaded: the machine links the image's `/app/viewer/dist/ohol`.
2. Packs `agents/{src,package.json,package-lock.json,tsconfig.json}` (no
   tests), `data/`, `viewer/dist`, `deploy/app-switch.sh` and `VERSION`
   (`<UTC time>-<git sha>[-dirty]`) into a tarball, about 1 MB.
3. Uploads it and `app-switch.sh` with `fly ssh sftp put`, then runs
   `app-switch.sh install` over `fly ssh console`. It:
   - unpacks into `/data/app/versions/<version>`;
   - refuses if `agents/package-lock.json` differs from the image's;
   - links the image's `node_modules`, art and data;
   - records the image's `IMAGE_STAMP`;
   - atomically switches the `/data/app/current` link (the old target goes to
     `/data/app/previous`);
   - keeps the 5 newest versions;
   - sends SIGUSR1 to the supervisor.
4. Polls `/health` until it reports the new `appVersion`, then `/api/state`
   until every character that was alive before is alive again with the same
   player id under the same run id. Exit 1 if not verified within
   `VERIFY_TIMEOUT_S` (240 s); roll back then.

Env: `FLY_APP` (default from `fly.toml`), `APP_URL` (default
`https://<app>.fly.dev`). The first hot update needs an image built from this
version of `deploy/` (start.sh with the override and SIGUSR1 support), so run
one full deploy first.

During the restart (a few seconds, plus tsx's startup) the characters are
connected but unplayed, like a short lag. A character that dies in that window
is recorded when the slot logs in again (its life becomes `lost`).

### Full deploy and a stale override

A full `fly deploy` restarts the machine: the game server and every living
character end, and the agents start a fresh run. An override belongs to the
image it was installed on. On the first start of a new image, start.sh sees
that `current/BASE_IMAGE_STAMP` differs from `/app/IMAGE_STAMP`, logs it,
unlinks `current` and runs the image's code. The versions stay on the volume
for inspection. A deploy always runs the code it was built from, so a deploy
never silently runs an older hot update.

Commit before hot-updating. A later full deploy builds from your working tree,
so hot-updated code that was never committed is lost then.

## First deploy

These commands need the user's go-ahead because they create billable
resources. Run them from the repo root (where `fly.toml` lives).

```sh
fly auth login                          # if needed
fly apps create artificial-selection    # add --org <org> if not personal
fly volumes create as_data --size 3 --region sjc -y

# secrets (staged: stored now, applied by the first deploy)
fly secrets set --stage \
  OPENROUTER_API_KEY='sk-or-...' \
  CONTROL_TOKEN="$(openssl rand -hex 24)"
# write the CONTROL_TOKEN down: it is the dashboard's start/stop password

fly deploy                              # remote builder, deploy/Dockerfile
```

`fly deploy` builds on Fly's remote builder, so local Docker isn't needed. The
build compiles OHOL and clones OneLifeData7 twice: once for the server and once
for the viewer's art. Expect several minutes.

### Secrets

| name | required | what |
| --- | --- | --- |
| `OPENROUTER_API_KEY` | yes | LLM calls. Without it the agents service exits on start; start.sh retries it with backoff (then every 5 min). The game server stays up, but nobody plays. |
| `CONTROL_TOKEN` | strongly recommended | password for `POST /api/start` and `/api/halt` (`?token=` or `Authorization: Bearer`). If it is unset, nobody can start or stop runs, because `OPEN_CONTROL=0`. |

Non-secret settings live in `[env]` in `fly.toml`. Edit them and run
`fly deploy`, or use `fly secrets set` for one-off overrides:
- `CONTINUOUS=1`, `AUTOSTART=1`, `OPEN_CONTROL=0`, `AGENT_COUNT=4`
- the model
- the narrator, director and story intervals
- `DAILY_COST_USD` and `MAX_TOTAL_COST_USD`, both 0 (off)

**Consider setting `DAILY_COST_USD`.** With `CONTINUOUS=1` there is no per-run
cap, so LLM spend is unbounded by default. Game settings use
`OHOL_SETTING_<name>=<value>` (see `server/run.sh`).

## CORS and control

- Every response carries `access-control-allow-origin: *`, so
  `https://mvonebers.com` (and any other origin) can GET `/api/state`,
  `/api/lives`, `/api/stream` (SSE) and so on. All of that data is public and
  read-only.
- Control endpoints need `POST` and the correct token. Without it they return
  403 from any origin: no token, wrong token, or GET with the right token. The
  only bypass is `OPEN_CONTROL=1`, and fly.toml sets 0.

## Check it

```sh
fly status                       # machine state, checks
fly checks list                  # /health and /api/state
fly logs                         # live stdout: [start.sh] lines, agents, game server
curl -s https://artificial-selection.fly.dev/health
curl -s https://artificial-selection.fly.dev/api/state | head -c 400
open https://artificial-selection.fly.dev/            # site served by the agents service
fly ssh console                  # shell on the machine
fly ssh console -C "du -sh /data/world /data/logs"
fly volumes list                 # size / auto-extend
```

Start/stop from a shell:
`curl -X POST -H "Authorization: Bearer $CONTROL_TOKEN" https://artificial-selection.fly.dev/api/halt`
(or `/api/start`).

## Back up and restore /data

**Volume snapshots** are the primary backup.
- Fly takes one daily (`snapshot_retention = 7` days in fly.toml).
- They are block-level and crash-consistent.

```sh
fly volumes list                              # note the vol_... id
fly volumes snapshots create <vol_id>         # take one now (e.g. before a risky deploy)
fly volumes snapshots list <vol_id>
```

To restore a snapshot, swap the volume:

```sh
fly machine list                              # note the machine id
fly machine destroy <machine_id> --force      # the volume survives
fly volumes create as_data --snapshot-id <snap_id> --size 3 --region sjc -y
fly deploy                                    # new machine attaches the unattached as_data volume
fly volumes destroy <old_vol_id>              # only after checking the restored world
```

If two unattached `as_data` volumes exist, destroy or rename the old one
before `fly deploy` so the deploy picks the right one.

**Off-site copy (tarball).** The game server writes continuously. For a clean
copy, halt the agents first (`/api/halt`). Pulling a tarball while it runs
still works, but it is only crash-consistent.

```sh
fly ssh console -C "tar czf /tmp/as-data.tgz -C /data ."
fly sftp get /tmp/as-data.tgz ./as-data-$(date +%F).tgz
```

To restore from a tarball, upload it, unpack it over `/data`, then restart.
Restarting stops both processes, and the world loads from the restored files.

```sh
fly sftp put ./as-data-YYYY-MM-DD.tgz /tmp/as-data.tgz
fly ssh console -C "sh -c 'cd /data && tar xzf /tmp/as-data.tgz'"
fly machine restart <machine_id>
```

Caveat: unpacking while the server is running can race with its writes. The
safest order is snapshot first, then restore, then restart right away.

## Roll back

A hot update rolls back with `deploy/hot-update.sh rollback` (see
[Hot update](#hot-update)). That keeps the world running. A full release
rolls back like this, which restarts the world:

```sh
fly releases --image                          # past releases with their image refs
fly deploy --image registry.fly.io/artificial-selection:deployment-<id>
```

The volume is not rolled back, because world and research data persist across
releases. If a bad release corrupted data, restore a snapshot as above.

## Stop / tear down

```sh
fly scale count 0             # stop the world (the volume is still billed)
fly scale count 1             # bring it back
fly apps destroy artificial-selection   # deletes the machine and volumes: back up first
```

## Sizing: shared-cpu-1x, 1 GB

Measured on the dev machine: physical footprint from macOS `footprint`, with
the stack running for about 3 h, 4 agents and continuous mode.

| process | footprint (peak) | `ps` RSS |
| --- | --- | --- |
| OneLifeServer (world from that session) | 93 MB | 10 MB (most pages compressed) |
| agents service (`node` + tsx loader) | 171 MB (175 MB) | 50 MB |
| agents service, fresh start (local test) | – | 57 MB |

Together that is about 265 MB, with Linux and the Fly init taking roughly
another 100 MB. 1 GB leaves about 3x headroom for:
- the game server's DB caches growing with the map
- the lives book growing in memory
- tsx's esbuild transform at startup

Both processes are mostly idle. The agents service waits on LLM calls, and the
game server ticks a small world. CPU use was 1–2 % each, so a shared vCPU is
enough.

If memory climbs over weeks (check `fly ssh console -C "ps -o rss,comm -e"` or
the Fly metrics dashboard), run `fly scale memory 2048`.

On disk: the 3-hour world was 2.2 MB (`map.db` 27 KB, `playerStats.db`
640 KB, `log.txt` 584 KB), and all local agent logs were 5.7 MB. Two things
grow over time, the game's `log.txt` (about 5 MB/day at this rate, rotated
past 64 MB) and the research data, so 3 GB lasts a long time. The volume also
auto-extends to at most 10 GB once it is 80 % full.

## Estimated monthly cost (Fly, sjc)

Sources, checked 2026-11-16:
- [Fly pricing docs](https://fly.io/docs/about/pricing/): shared-cpu-1x/1GB
  costs $6.70/mo in iad/ewr, the cheapest regions. Extra RAM is $6.00/GB/mo.
  Volumes are $0.15/GB/mo provisioned. Snapshots are $0.08/GB/mo, with the
  first 10 GB free. North America egress is $0.02/GB. The shared IPv4 and
  IPv6 addresses are free.
- [fly.io/pricing](https://fly.io/pricing/): the sjc region multiplier is
  1.192 (shared-cpu-1x 256MB is $2.62 there).

| item | per month |
| --- | --- |
| shared-cpu-1x, 1 GB, always on, sjc ($6.70 × 1.192) | ≈ $7.99 |
| volume 3 GB × $0.15 | $0.45 |
| snapshots (7 daily, a few hundred MB at most; first 10 GB free) | $0 |
| egress (estimate ~20 GB: site assets + SSE viewers, × $0.02) | ≈ $0.40 |
| **total** | **≈ $9 / month** |

With 2 GB RAM, the machine costs ($2.19 + 1.75 GB × $6) × 1.192 ≈ $15.13, for
about $16/month in total.

The app needs no dedicated IPv4 ($2/mo). It is HTTP-only, and the game port is
not exposed. You would only need one to let human OHOL clients join over raw
TCP, which would also require a `[[services]]` block for 8005.

**OpenRouter LLM spend is separate and is likely the bigger cost.** Cap it with
`DAILY_COST_USD`.

## Local test (no Docker)

start.sh takes its paths from the environment, so it runs against a local
build on spare ports:

```sh
export DATA_DIR=/tmp/as-flytest/data OHOL_BUILD=$PWD/.ohol-build \
  SERVER_DIR=$PWD/server AGENTS_DIR=$PWD/agents VIEWER_DIST=$PWD/viewer/dist \
  GAME_PORT=8006 PORT=8898 OPENROUTER_API_KEY=... AGENT_COUNT=2
deploy/start.sh
```

start.sh refuses to start if `GAME_PORT` is already taken.

`deploy/test/supervisor-restart.sh` runs the restart scenarios end to end on
spare ports (game 8016, API 8896, fake LLM 8797), with `.ohol-build` and the
fake LLM, so no paid calls are made. It takes about a minute. The scenarios:
- SIGKILL the agents service;
- SIGUSR1 to the supervisor;
- a hot update in local mode (`HOT_UPDATE_LOCAL=1`), then a rollback;
- a crash-looping override;
- a stale override.

After each one it checks four things:
- the run id is the same;
- every character that was alive is alive again with the same player id and
  an older age;
- its life record is open and valid, with no new life, birth or death;
- the event seq continued and the game-server pid is unchanged.
