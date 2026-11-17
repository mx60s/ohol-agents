#!/usr/bin/env bash
# Supervisor for the single-machine deploy (Fly): the OHOL game server and the
# agents service in one container, talking over 127.0.0.1.
#
#   1. first boot: create the world and log dirs on the volume
#   2. start the game server (server/run.sh, run dir = $WORLD_DIR), wait for its port
#   3. start the agents service (OHOL_HOST=127.0.0.1, LOG_DIR, CONTINUOUS, AUTOSTART)
#      from the hot-update override ($APP_ROOT/current, see deploy/app-switch.sh)
#      when it is valid and was installed on this image, else from the image
#   4. SIGTERM/SIGINT: stop the agents first (they write their research snapshot on
#      SIGTERM), then the game server (SIGTSTP is OneLifeServer's graceful quit), exit 0
#   5. the agents service exits on its own: restart only it, with exponential
#      backoff; after AGENTS_MAX_CRASHES quick crashes in a row, drop a hot-update
#      override (back to the image's code), or, already on the image, retry every
#      AGENTS_GIVEUP_RETRY_S. The game server (and every living character) stays up.
#   6. SIGUSR1: restart only the agents service, re-reading the override (hot update)
#   7. the game server exits: stop the agents and exit 1, so the platform restarts
#      the machine
#
# Everything is overridable via env, so the same script runs locally against an
# existing .ohol-build (see deploy/README.md, "Local test"). Plain bash 3.2+.
set -euo pipefail

DATA_DIR="${DATA_DIR:-/data}"
WORLD_DIR="${WORLD_DIR:-$DATA_DIR/world}"
export LOG_DIR="${LOG_DIR:-$DATA_DIR/logs}"
OHOL_BUILD="${OHOL_BUILD:-/opt/ohol}"      # holds OneLife/server/OneLifeServer
IMAGE_APP_DIR="${IMAGE_APP_DIR:-/app}"     # the image's agents/, viewer/dist, data/, IMAGE_STAMP
SERVER_DIR="${SERVER_DIR:-$IMAGE_APP_DIR/server}"    # run.sh + settings/*.ini overrides
AGENTS_DIR="${AGENTS_DIR:-$IMAGE_APP_DIR/agents}"
VIEWER_DIST="${VIEWER_DIST:-$IMAGE_APP_DIR/viewer/dist}"
APP_ROOT="${APP_ROOT:-$DATA_DIR/app}"      # hot updates: versions/<v>, current -> versions/<v>
GAME_PORT="${GAME_PORT:-8005}"
SERVER_START_TIMEOUT="${SERVER_START_TIMEOUT:-180}"  # s to wait for the game port
AGENTS_STOP_TIMEOUT="${AGENTS_STOP_TIMEOUT:-15}"     # s before SIGKILL
SERVER_STOP_TIMEOUT="${SERVER_STOP_TIMEOUT:-30}"     # s before SIGKILL
LOG_ROTATE_BYTES="${LOG_ROTATE_BYTES:-67108864}"     # rotate world log.txt past 64 MB
AGENTS_BACKOFF_BASE="${AGENTS_BACKOFF_BASE:-2}"      # s before the 1st restart, doubling per quick crash
AGENTS_BACKOFF_MAX="${AGENTS_BACKOFF_MAX:-60}"       # s, backoff ceiling
AGENTS_STABLE_S="${AGENTS_STABLE_S:-120}"            # a run this long resets the crash count
AGENTS_MAX_CRASHES="${AGENTS_MAX_CRASHES:-5}"        # quick crashes in a row = crash loop
AGENTS_GIVEUP_RETRY_S="${AGENTS_GIVEUP_RETRY_S:-300}" # crash loop on the image's code: retry this often
SUPERVISOR_PIDFILE="${SUPERVISOR_PIDFILE:-/tmp/as-supervisor.pid}"
SUPERVISOR_STATE="${SUPERVISOR_STATE:-/tmp/as-supervisor.state}"

export OHOL_HOST=127.0.0.1
export OHOL_PORT="$GAME_PORT"
export PORT_OVERRIDE="$GAME_PORT"   # run.sh writes it to settings/port.ini
export CONTINUOUS="${CONTINUOUS:-1}"
export AUTOSTART="${AUTOSTART:-1}"

log() { echo "[start.sh] $*"; }

server_pid=""
agents_pid=""
agents_started=0
agents_next_start=0
agents_crashes=0
agents_app=""          # dir the running agents service came from
agents_version=""
restart_requested=0
stopping=0

alive() { [ -n "$1" ] && kill -0 "$1" 2>/dev/null; }
now_s() { date +%s; }

# stop_proc <pid> <signal> <timeout_s> <name>
stop_proc() {
  local pid="$1" sig="$2" timeout="$3" name="$4" i=0
  alive "$pid" || return 0
  log "stopping $name (pid $pid, SIG$sig)"
  kill -s "$sig" "$pid" 2>/dev/null || true
  while alive "$pid" && [ "$i" -lt $((timeout * 10)) ]; do
    sleep 0.1
    i=$((i + 1))
  done
  if alive "$pid"; then
    log "$name still running after ${timeout}s, SIGKILL"
    kill -s KILL "$pid" 2>/dev/null || true
  fi
  wait "$pid" 2>/dev/null || true
}

shutdown_all() {
  stop_proc "$agents_pid" TERM "$AGENTS_STOP_TIMEOUT" agents
  agents_pid=""
  stop_proc "$server_pid" TSTP "$SERVER_STOP_TIMEOUT" OneLifeServer
  rm -f "$SUPERVISOR_PIDFILE"
}

on_signal() {
  [ "$stopping" = 1 ] && return
  stopping=1
  log "received $1, shutting down"
  shutdown_all
  log "clean shutdown"
  exit 0
}
trap 'on_signal TERM' TERM
trap 'on_signal INT' INT
trap 'restart_requested=1' USR1

port_open() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

# ---------- hot-update override ----------
# A version dir is valid if it has the agents source, resolvable deps and a
# built viewer. It belongs to one image: app-switch.sh copies the image's
# IMAGE_STAMP into it as BASE_IMAGE_STAMP. After a full deploy (new image) the
# override is stale: start.sh drops the `current` link and runs the image.
override_valid() {
  local d="$1"
  [ -f "$d/VERSION" ] && [ -f "$d/agents/src/main.ts" ] && [ -f "$d/agents/package.json" ] &&
    [ -f "$d/agents/node_modules/tsx/package.json" ] && [ -f "$d/viewer/dist/index.html" ]
}

disable_override() {
  local why="$1"
  local target
  target="$(readlink "$APP_ROOT/current" 2>/dev/null || echo "?")"
  rm -f "$APP_ROOT/current"
  echo "$(date -u +%FT%TZ) disabled $target: $why" >> "$APP_ROOT/disabled.log" 2>/dev/null || true
  log "hot-update override $target disabled: $why (running the image's code)"
}

# sets agents_app, agents_version
pick_app() {
  local cur="$APP_ROOT/current"
  agents_app="$IMAGE_APP_DIR"
  agents_version="image"
  [ -e "$IMAGE_APP_DIR/IMAGE_STAMP" ] && agents_version="image $(cat "$IMAGE_APP_DIR/IMAGE_STAMP")"
  if [ -L "$cur" ] || [ -e "$cur" ]; then
    local img base
    img="$(cat "$IMAGE_APP_DIR/IMAGE_STAMP" 2>/dev/null || true)"
    base="$(cat "$cur/BASE_IMAGE_STAMP" 2>/dev/null || true)"
    if ! override_valid "$cur"; then
      disable_override "invalid (missing VERSION, agents/src/main.ts, deps or viewer/dist)"
    elif [ -n "$img" ] && [ "$base" != "$img" ]; then
      disable_override "installed on image ${base:-unknown}, this is image $img (a full deploy replaced it)"
    else
      agents_app="$(cd "$cur" && pwd -P)"
      agents_version="$(head -n 1 "$cur/VERSION")"
    fi
  fi
}

write_state() {
  {
    echo "supervisor_pid=$$"
    echo "server_pid=$server_pid"
    echo "agents_pid=$agents_pid"
    echo "agents_started=$agents_started"
    echo "agents_app=$agents_app"
    echo "agents_version=$agents_version"
    echo "agents_crashes=$agents_crashes"
    echo "game_server_epoch=${GAME_SERVER_EPOCH:-}"
  } > "$SUPERVISOR_STATE.tmp" 2>/dev/null && mv -f "$SUPERVISOR_STATE.tmp" "$SUPERVISOR_STATE" || true
}

start_agents() {
  pick_app
  local adir="$AGENTS_DIR" vdist="$VIEWER_DIST"
  if [ "$agents_app" != "$IMAGE_APP_DIR" ]; then
    adir="$agents_app/agents"
    vdist="$agents_app/viewer/dist"
  fi
  # node directly (not npm/tsx CLI) so SIGTERM reaches main.ts's handler
  (cd "$adir" && VIEWER_DIST="$vdist" APP_VERSION="$agents_version" exec node --import tsx src/main.ts) &
  agents_pid=$!
  agents_started="$(now_s)"
  log "agents service pid $agents_pid from $adir ($agents_version; api :${PORT:-8787}, LOG_DIR=$LOG_DIR)"
  write_state
}

# the agents service exited on its own: schedule a restart with backoff
agents_exited() {
  local code ran delay
  wait "$agents_pid" 2>/dev/null && code=0 || code=$?
  ran=$(($(now_s) - agents_started))
  agents_pid=""
  if [ "$ran" -ge "$AGENTS_STABLE_S" ]; then agents_crashes=1; else agents_crashes=$((agents_crashes + 1)); fi
  log "agents service exited (code $code) after ${ran}s; quick crashes in a row: $agents_crashes/$AGENTS_MAX_CRASHES"
  if [ "$agents_crashes" -ge "$AGENTS_MAX_CRASHES" ]; then
    if [ "$agents_app" != "$IMAGE_APP_DIR" ]; then
      disable_override "crash loop ($agents_crashes quick crashes)"
      agents_crashes=0
      delay=1
    else
      delay="$AGENTS_GIVEUP_RETRY_S"
      log "agents service is crash-looping on the image's code; the game server stays up; retrying every ${delay}s"
    fi
  else
    delay=$((AGENTS_BACKOFF_BASE << (agents_crashes - 1)))
    [ "$delay" -gt "$AGENTS_BACKOFF_MAX" ] && delay="$AGENTS_BACKOFF_MAX"
  fi
  agents_next_start=$(($(now_s) + delay))
  log "restarting the agents service in ${delay}s"
  write_state
}

# ---------- 1. volume layout ----------
mkdir -p "$WORLD_DIR" "$LOG_DIR"
if [ ! -e "$WORLD_DIR/map.db" ]; then
  log "no map.db in $WORLD_DIR: first boot, the game server will create a new world"
fi
# the server appends to log.txt forever; keep one old copy
if [ -f "$WORLD_DIR/log.txt" ] && [ "$(wc -c < "$WORLD_DIR/log.txt")" -gt "$LOG_ROTATE_BYTES" ]; then
  mv -f "$WORLD_DIR/log.txt" "$WORLD_DIR/log.txt.1"
  log "rotated $WORLD_DIR/log.txt"
fi
if port_open "$GAME_PORT"; then
  log "port $GAME_PORT is already in use; refusing to start a second game server"
  exit 1
fi
echo $$ > "$SUPERVISOR_PIDFILE"

# ---------- 2. game server ----------
# run.sh links the build into the run dir, writes settings, then execs
# OneLifeServer, so $server_pid is the server itself.
"$SERVER_DIR/run.sh" "$OHOL_BUILD" "$WORLD_DIR" &
server_pid=$!
# the agents keep their run id (and characters) across their own restarts, but
# not across a game-server restart, which ends every living character
export GAME_SERVER_EPOCH="$(now_s)"
log "game server pid $server_pid, waiting for :$GAME_PORT"
waited=0
until port_open "$GAME_PORT"; do
  if ! alive "$server_pid"; then
    wait "$server_pid" 2>/dev/null && code=0 || code=$?
    log "game server exited during startup (code $code)"
    rm -f "$SUPERVISOR_PIDFILE"
    exit 1
  fi
  if [ "$waited" -ge $((SERVER_START_TIMEOUT * 2)) ]; then
    log "game server not listening after ${SERVER_START_TIMEOUT}s"
    shutdown_all
    exit 1
  fi
  sleep 0.5 & wait $! || true
  waited=$((waited + 1))
done
log "game server listening on :$GAME_PORT"

# ---------- 3. agents service ----------
start_agents

# ---------- 4-7. supervise ----------
# poll instead of `wait -n` (bash 3.2 has none); `sleep & wait` keeps traps prompt
while :; do
  [ "$stopping" = 1 ] && exit 0
  if ! alive "$server_pid"; then
    wait "$server_pid" 2>/dev/null && code=0 || code=$?
    log "game server exited unexpectedly (code $code); stopping the agents, exit 1 (machine restart)"
    stopping=1
    shutdown_all
    exit 1
  fi
  if [ "$restart_requested" = 1 ]; then
    restart_requested=0
    log "SIGUSR1: restarting the agents service (game server untouched)"
    stop_proc "$agents_pid" TERM "$AGENTS_STOP_TIMEOUT" agents
    agents_pid=""
    agents_crashes=0
    start_agents
  elif [ -n "$agents_pid" ] && ! alive "$agents_pid"; then
    agents_exited
  elif [ -z "$agents_pid" ] && [ "$(now_s)" -ge "$agents_next_start" ]; then
    start_agents
  fi
  sleep 1 & wait $! || true
done
