# Deploying the always-on world to Fly.io

A single Fly app (`artificial-selection`) runs one machine with both processes,
which talk over `127.0.0.1`. `deploy/start.sh` supervises them:

| process | port | data |
| --- | --- | --- |
| OHOL game server (`OneLifeServer`, compiled in `deploy/Dockerfile`) | 8005, internal only | `/data/world` (map/player DBs, server logs) |
| agents service + built viewer (`/` = site, `/api/*`) | 8787, public via `http_service` | `/data/logs` (`LOG_DIR`: run logs, `research/`, spend, story) |

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
   `OHOL_HOST=127.0.0.1`, `LOG_DIR=/data/logs`, `CONTINUOUS=1` and
   `AUTOSTART=1`.
4. On SIGTERM or SIGINT (`kill_signal = "SIGTERM"`, `kill_timeout = 60s`):
   - It sends SIGTERM to the agents service. The agents disconnect, mark the
     run's open lives as lost, flush the journal and write
     `research/lives.snapshot.json`.
   - It then sends **SIGTSTP** to OneLifeServer, the server's own graceful-quit
     signal. SIGTERM would just kill it.
   - It exits 0. Any process still running after its timeout gets SIGKILL.
5. If either process exits on its own, start.sh stops the other one and exits
   1. `[[restart]] policy = "always"` brings the machine back.

Note: Fly's HTTP checks only gate routing and deploys. They do not restart a
machine. The restart comes from start.sh exiting when a process dies.

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
| `OPENROUTER_API_KEY` | yes | LLM calls. Without it the agents service exits, start.sh exits 1, and the machine restart-loops. |
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
