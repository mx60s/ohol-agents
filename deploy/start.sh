#!/usr/bin/env bash
# Supervisor for the single-machine deploy (Fly): the OHOL game server and the
# agents service in one container, talking over 127.0.0.1.
#
#   1. first boot: create the world and log dirs on the volume
#   2. start the game server (server/run.sh, run dir = $WORLD_DIR), wait for its port
#   3. start the agents service (OHOL_HOST=127.0.0.1, LOG_DIR, CONTINUOUS, AUTOSTART)
#   4. SIGTERM/SIGINT: stop the agents first (they write their research snapshot on
#      SIGTERM), then the game server (SIGTSTP is OneLifeServer's graceful quit), exit 0
#   5. either process exits on its own: stop the other one and exit 1, so the
#      platform restarts the machine
#
# Everything is overridable via env, so the same script runs locally against an
# existing .ohol-build (see deploy/README.md, "Local test"). Plain bash 3.2+.
set -euo pipefail

DATA_DIR="${DATA_DIR:-/data}"
WORLD_DIR="${WORLD_DIR:-$DATA_DIR/world}"
export LOG_DIR="${LOG_DIR:-$DATA_DIR/logs}"
OHOL_BUILD="${OHOL_BUILD:-/opt/ohol}"      # holds OneLife/server/OneLifeServer
SERVER_DIR="${SERVER_DIR:-/app/server}"    # run.sh + settings/*.ini overrides
AGENTS_DIR="${AGENTS_DIR:-/app/agents}"
GAME_PORT="${GAME_PORT:-8005}"
SERVER_START_TIMEOUT="${SERVER_START_TIMEOUT:-180}"  # s to wait for the game port
AGENTS_STOP_TIMEOUT="${AGENTS_STOP_TIMEOUT:-15}"     # s before SIGKILL
SERVER_STOP_TIMEOUT="${SERVER_STOP_TIMEOUT:-30}"     # s before SIGKILL
LOG_ROTATE_BYTES="${LOG_ROTATE_BYTES:-67108864}"     # rotate world log.txt past 64 MB

export OHOL_HOST=127.0.0.1
export OHOL_PORT="$GAME_PORT"
export PORT_OVERRIDE="$GAME_PORT"   # run.sh writes it to settings/port.ini
export CONTINUOUS="${CONTINUOUS:-1}"
export AUTOSTART="${AUTOSTART:-1}"

log() { echo "[start.sh] $*"; }

server_pid=""
agents_pid=""
stopping=0

alive() { [ -n "$1" ] && kill -0 "$1" 2>/dev/null; }

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
  stop_proc "$server_pid" TSTP "$SERVER_STOP_TIMEOUT" OneLifeServer
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

port_open() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

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

# ---------- 2. game server ----------
# run.sh links the build into the run dir, writes settings, then execs
# OneLifeServer, so $server_pid is the server itself.
"$SERVER_DIR/run.sh" "$OHOL_BUILD" "$WORLD_DIR" &
server_pid=$!
log "game server pid $server_pid, waiting for :$GAME_PORT"
waited=0
until port_open "$GAME_PORT"; do
  if ! alive "$server_pid"; then
    wait "$server_pid" 2>/dev/null && code=0 || code=$?
    log "game server exited during startup (code $code)"
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
# node directly (not npm/tsx CLI) so SIGTERM reaches main.ts's handler
(cd "$AGENTS_DIR" && exec node --import tsx src/main.ts) &
agents_pid=$!
log "agents service pid $agents_pid (api :${PORT:-8787}, LOG_DIR=$LOG_DIR)"

# ---------- 4/5. supervise ----------
# poll instead of `wait -n` (bash 3.2 has none); `sleep & wait` keeps traps prompt
while alive "$server_pid" && alive "$agents_pid"; do
  sleep 1 & wait $! || true
done
[ "$stopping" = 1 ] && exit 0
if alive "$server_pid"; then
  log "agents service exited unexpectedly"
else
  log "game server exited unexpectedly"
fi
stopping=1
shutdown_all
exit 1
