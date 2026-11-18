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
#   8. SIGUSR2 with $REGEN_REQUEST_FILE (the agents found the world extinct):
#      regenerate the world without exiting. Stop the agents, then the game
#      server; commit (the request moves into $WORLDS_DIR/regen-pending); move
#      the world files out of the run dir, archive them to
#      $WORLDS_DIR/archive/<UTC stamp>/world.tar.gz (rotated by count and size),
#      set the new-run flag; start the game server, then the agents.
#      Crash-safe: a boot that finds regen-pending finishes the wipe before the
#      game server starts; a request that was never committed is dropped and
#      the old world starts as it was.
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
export SUPERVISOR_PIDFILE="${SUPERVISOR_PIDFILE:-/tmp/as-supervisor.pid}"
SUPERVISOR_STATE="${SUPERVISOR_STATE:-/tmp/as-supervisor.state}"
# world regeneration (8.): the agents write the request, then SIGUSR2 us
WORLDS_DIR="${WORLDS_DIR:-$DATA_DIR/worlds}"
WORLD_ARCHIVE_DIR="${WORLD_ARCHIVE_DIR:-$WORLDS_DIR/archive}"
WORLD_ARCHIVE_KEEP="${WORLD_ARCHIVE_KEEP:-10}"          # newest archives kept
WORLD_ARCHIVE_MAX_MB="${WORLD_ARCHIVE_MAX_MB:-1024}"    # all archives together
WORLD_ARCHIVE_MIN_FREE_MB="${WORLD_ARCHIVE_MIN_FREE_MB:-1024}" # skip the archive if the volume would have less free
export REGEN_REQUEST_FILE="${REGEN_REQUEST_FILE:-$WORLDS_DIR/regen-request.json}"
REGEN_PENDING="$WORLDS_DIR/regen-pending"
NEW_RUN_FLAG="$LOG_DIR/research/new-run.flag"
# The world, in the run dir (OHOL server source, verified against map.cpp
# wipeMapFiles() = the stock apocalypse wipe, plus what it keeps on purpose):
# - map DBs: map/mapTime/biome/floor/floorTime/grave/eve/meta/lookTime/playerStats .db
# - statue.db, statueTime.db (stock keeps statues across apocalypses; a fresh world doesn't)
# - map state: biomeRandSeed.txt (no seed = new terrain, map.cpp reseedMap),
#   lastEveLocation.txt, recentPlacements.txt, eveRadius.txt, landingLocations.txt,
#   shutdownLongLineagePos.txt, mapDummyRecall.txt
# - playerSaves.txt (+ .tmp, .bad) from server/patches/player-saves.patch
# - mtsLineageFamilies.txt (lineage id -> family name, free-names.patch; ids restart)
# - mtsLanguageLearning.txt (+ .tmp): who learned which family language, language-learning.patch
# Each name also as <name>.temp (DB_open_timeShrunk) and lookTime_temp.db.
# Kept: settings/, the build links, logs, curses.db / curseCount.db / trust.db
# (keyed by email; a new run has new emails), mtsFamilyNames.txt (surnames stay
# unique across worlds), timeScaleEpoch.txt (the game clock just goes on).
WORLD_FILES="map.db mapTime.db biome.db floor.db floorTime.db grave.db eve.db meta.db lookTime.db lookTime_temp.db
  playerStats.db statue.db statueTime.db biomeRandSeed.txt lastEveLocation.txt recentPlacements.txt eveRadius.txt
  landingLocations.txt shutdownLongLineagePos.txt mapDummyRecall.txt playerSaves.txt playerSaves.txt.tmp playerSaves.txt.bad
  mtsLineageFamilies.txt mtsLanguageLearning.txt mtsLanguageLearning.txt.tmp"

export OHOL_HOST=127.0.0.1
export OHOL_PORT="$GAME_PORT"
export PORT_OVERRIDE="$GAME_PORT"   # run.sh writes it to settings/port.ini
export CONTINUOUS="${CONTINUOUS:-1}"
export AUTOSTART="${AUTOSTART:-1}"
export MTS_CLOCK_DIR="${MTS_CLOCK_DIR:-$WORLD_DIR}"   # turn clock files (TURN_CLOCK=1): the server's run dir

log() { echo "[start.sh] $*"; }

server_pid=""
agents_pid=""
agents_started=0
agents_next_start=0
agents_crashes=0
agents_app=""          # dir the running agents service came from
agents_version=""
restart_requested=0
regen_requested=0
world_regens=0
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
trap 'regen_requested=1' USR2

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
    echo "regen_supported=1"
    echo "world_regens=$world_regens"
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

# ---------- game server ----------
# run.sh links the build into the run dir, writes settings, then execs
# OneLifeServer, so $server_pid is the server itself. Returns 1 if it doesn't
# come up (it is stopped then).
start_server() {
  local waited=0 code
  "$SERVER_DIR/run.sh" "$OHOL_BUILD" "$WORLD_DIR" &
  server_pid=$!
  # the agents keep their run id (and characters) across their own restarts, but
  # not across a game-server restart, which ends every living character
  export GAME_SERVER_EPOCH="$(now_s)"
  log "game server pid $server_pid, waiting for :$GAME_PORT"
  until port_open "$GAME_PORT"; do
    if ! alive "$server_pid"; then
      wait "$server_pid" 2>/dev/null && code=0 || code=$?
      log "game server exited during startup (code $code)"
      server_pid=""
      return 1
    fi
    if [ "$waited" -ge $((SERVER_START_TIMEOUT * 2)) ]; then
      log "game server not listening after ${SERVER_START_TIMEOUT}s"
      stop_proc "$server_pid" TSTP "$SERVER_STOP_TIMEOUT" OneLifeServer
      server_pid=""
      return 1
    fi
    sleep 0.5 & wait $! || true
    waited=$((waited + 1))
  done
  log "game server listening on :$GAME_PORT"
}

# ---------- world regeneration ----------
# Every step is idempotent, and $REGEN_PENDING (a directory, created by an
# atomic rename) is the commit point: once it exists, the wipe is finished,
# at the latest by the next boot, before any game server starts.

# archive_world <stage dir> <dest dir>: world.tar.gz + request.json into dest
archive_world() {
  local stage="$1" dest="$2" partial="$2.partial" need free
  [ -d "$dest" ] && return 0   # done before a crash
  rm -rf "$partial"
  [ -n "$(ls -A "$stage" 2>/dev/null)" ] || { log "nothing to archive"; return 1; }
  need="$(du -sk "$stage" 2>/dev/null | awk '{print $1}')"
  free="$(df -Pk "$WORLDS_DIR" 2>/dev/null | awk 'NR == 2 {print $4}')"
  if [ -z "$need" ] || [ -z "$free" ] || [ $((free - need)) -lt $((WORLD_ARCHIVE_MIN_FREE_MB * 1024)) ]; then
    log "not archiving the old world: ${need:-?} KB to pack, ${free:-?} KB free (keeping ${WORLD_ARCHIVE_MIN_FREE_MB} MB free)"
    return 1
  fi
  if mkdir -p "$partial" && tar -czf "$partial/world.tar.gz" -C "$stage" . &&
    { cp "$REGEN_PENDING/request.json" "$partial/request.json" 2>/dev/null || true; } && mv "$partial" "$dest"; then
    log "old world archived to $dest ($(du -sk "$dest" | awk '{print $1}') KB from $need KB)"
    return 0
  fi
  log "archiving the old world failed; it is deleted unarchived"
  rm -rf "$partial"
  return 1
}

# keep the newest WORLD_ARCHIVE_KEEP archives within WORLD_ARCHIVE_MAX_MB in total
rotate_archives() {
  local d kb total=0 kept=0
  [ -d "$WORLD_ARCHIVE_DIR" ] || return 0
  rm -rf "$WORLD_ARCHIVE_DIR"/*.partial
  for d in $(ls -1 "$WORLD_ARCHIVE_DIR" | sort -r); do
    [ -d "$WORLD_ARCHIVE_DIR/$d" ] || continue
    kb="$(du -sk "$WORLD_ARCHIVE_DIR/$d" | awk '{print $1}')"
    if [ "$kept" -lt "$WORLD_ARCHIVE_KEEP" ] && [ $((total + kb)) -le $((WORLD_ARCHIVE_MAX_MB * 1024)) ]; then
      kept=$((kept + 1))
      total=$((total + kb))
    else
      rm -rf "${WORLD_ARCHIVE_DIR:?}/$d"
      log "archive rotation: removed $d (${kb} KB)"
    fi
  done
}

# the request was committed: wipe the run dir, archive, flag a new run, clean up
finish_regen() {
  local p="$REGEN_PENDING" stamp f g moved=0 dest archive="null" request="null"
  stamp="$(cat "$p/stamp" 2>/dev/null || true)"
  [ -n "$stamp" ] || stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  mkdir -p "$p/stage"
  for f in $WORLD_FILES; do
    for g in "$f" "$f.temp"; do
      if [ -e "$WORLD_DIR/$g" ] || [ -L "$WORLD_DIR/$g" ]; then
        mv -f "$WORLD_DIR/$g" "$p/stage/$g" 2>/dev/null || rm -rf "${WORLD_DIR:?}/$g"
        moved=$((moved + 1))
      fi
    done
  done
  log "world regeneration: moved $moved world files out of $WORLD_DIR"
  # from here on the run dir holds no world; the rest is bookkeeping
  dest="$WORLD_ARCHIVE_DIR/$stamp"
  mkdir -p "$WORLD_ARCHIVE_DIR"
  archive_world "$p/stage" "$dest" && archive="\"$dest\""
  rotate_archives
  [ -d "$dest" ] || archive="null"   # rotated away at once (over the size cap)
  [ -s "$p/request.json" ] && request="$(tr -d '\n' < "$p/request.json")"
  mkdir -p "$(dirname "$NEW_RUN_FLAG")"
  printf '{"worldRegenerated":true,"at":"%s","archive":%s,"request":%s}\n' "$stamp" "$archive" "$request" > "$NEW_RUN_FLAG.tmp" &&
    mv -f "$NEW_RUN_FLAG.tmp" "$NEW_RUN_FLAG"
  rm -f "$REGEN_REQUEST_FILE"
  mv "$p" "$p.done" 2>/dev/null && rm -rf "$p.done"
  log "world regeneration done: fresh world, new run on the agents' next start"
}

# commit point: the request moves into $REGEN_PENDING (atomic rename)
commit_regen() {
  local stamp t="$REGEN_PENDING.tmp"
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  [ -e "$WORLD_ARCHIVE_DIR/$stamp" ] && stamp="$stamp-$$-$(now_s)"
  rm -rf "$t"
  mkdir -p "$t" && echo "$stamp" > "$t/stamp" && cp "$REGEN_REQUEST_FILE" "$t/request.json" && mv "$t" "$REGEN_PENDING"
}

# boot: finish a committed regeneration; drop one that was never committed
recover_regen() {
  rm -rf "$REGEN_PENDING.tmp" "$REGEN_PENDING.done"
  if [ -d "$REGEN_PENDING" ]; then
    log "an interrupted world regeneration was committed: finishing it before the game server starts"
    finish_regen
  elif [ -e "$REGEN_REQUEST_FILE" ]; then
    log "a world regeneration was requested but never started; starting the old world (the agents ask again if it is still extinct)"
    rm -f "$REGEN_REQUEST_FILE"
  fi
}

# SIGUSR2: regenerate the world, without exiting
regen_world() {
  if [ ! -f "$REGEN_REQUEST_FILE" ]; then
    log "SIGUSR2 without $REGEN_REQUEST_FILE: ignored"
    return 0
  fi
  log "SIGUSR2: world regeneration requested: $(head -c 300 "$REGEN_REQUEST_FILE")"
  stop_proc "$agents_pid" TERM "$AGENTS_STOP_TIMEOUT" agents
  agents_pid=""
  stop_proc "$server_pid" TSTP "$SERVER_STOP_TIMEOUT" OneLifeServer
  server_pid=""
  write_state
  if commit_regen; then
    finish_regen
    world_regens=$((world_regens + 1))
  else
    log "world regeneration: could not commit the request; restarting the old world"
    rm -rf "$REGEN_PENDING.tmp"
    rm -f "$REGEN_REQUEST_FILE"
  fi
  if ! start_server; then
    log "game server failed to start after the world regeneration; exit 1 (machine restart)"
    stopping=1
    shutdown_all
    exit 1
  fi
  agents_crashes=0
  start_agents
}

# ---------- 1. volume layout ----------
mkdir -p "$WORLD_DIR" "$LOG_DIR" "$WORLDS_DIR"
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
recover_regen
echo $$ > "$SUPERVISOR_PIDFILE"

# ---------- 2. game server ----------
if ! start_server; then
  shutdown_all
  exit 1
fi

# ---------- 3. agents service ----------
start_agents

# ---------- 4-8. supervise ----------
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
  if [ "$regen_requested" = 1 ]; then
    regen_requested=0
    regen_world
    restart_requested=0
  elif [ "$restart_requested" = 1 ]; then
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
