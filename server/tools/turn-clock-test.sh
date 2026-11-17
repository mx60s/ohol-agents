#!/usr/bin/env bash
# Local check of the turn clock (server/patches/turn-clock.patch).
#
# Usage: server/tools/turn-clock-test.sh [run_dir] [pause_seconds]
#   run_dir: scratch run dir (default: a fresh mktemp dir). Use a new one:
#            in a world with living players the client is born a baby and
#            can't walk, so the walk checks fail.
#   pause_seconds: how long the client sits through a pause (default 30)
#
# Starts a server with TURN_CLOCK=1 TIME_SCALE=1 on a spare port, and checks:
#   1. boots paused (mtsClockNow.txt "<g> 1")
#   2. a target of now+2.4 runs the clock ~2.4 s and holds exactly there
#   3. CPU use while paused (ps, 10 s)
#   4. a fake agent: login, SAY x2, walk while paused, stay connected through
#      the pause, walk resumes only when the clock runs (turn-clock-client.mts;
#      needs agents/node_modules)
#   5. restart (SIGTSTP, start again): resumes paused at the same game time
# Kills every server it started. Exit 1 if a check failed.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
BUILD="$ROOT/.ohol-build"
RUN="${1:-$(mktemp -d "${TMPDIR:-/tmp}/turn-clock-test.XXXXXX")}"
PAUSE_S="${2:-30}"
PORT="${PORT:-18005}"
mkdir -p "$RUN"
RUN="$(cd "$RUN" && pwd)"
LOG="$RUN/test-server.log"
NOW="$RUN/mtsClockNow.txt"
TARGET="$RUN/mtsClockTarget.txt"
FAILED=0
SERVER_PID=""

say() { echo "== $*"; }
bad() { echo "FAIL: $*"; FAILED=1; }

start_server() {
  rm -f "$NOW"
  TURN_CLOCK=1 TIME_SCALE=1 PORT_OVERRIDE="$PORT" \
    "$ROOT/server/run.sh" "$BUILD" "$RUN" >> "$LOG" 2>&1 &
  SERVER_PID=$!
  for _ in $(seq 1 120); do
    if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 && [ -f "$NOW" ]; then
      return 0
    fi
    sleep 0.5
  done
  bad "server did not start (see $LOG)"; return 1
}

stop_server() {
  [ -n "$SERVER_PID" ] || return 0
  kill -TSTP "$SERVER_PID" 2>/dev/null   # graceful: saves + persists clock
  for _ in $(seq 1 40); do
    kill -0 "$SERVER_PID" 2>/dev/null || break
    sleep 0.25
  done
  kill -9 "$SERVER_PID" 2>/dev/null
  wait "$SERVER_PID" 2>/dev/null
  SERVER_PID=""
}
trap stop_server EXIT

if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "port $PORT is busy; set PORT=..."; exit 1
fi

say "run dir $RUN, port $PORT"
start_server || exit 1

say "1. boot state: $(cat "$NOW")"
[ "$(awk '{print $2}' "$NOW")" = 1 ] || bad "not paused at boot"

say "2. run to now+2.4 and hold"
python3 - "$NOW" "$TARGET" <<'EOF' || FAILED=1
import os, sys, time
now_f, target_f = sys.argv[1:3]
def now():
    g, p = open(now_f).read().split()
    return float(g), p == "1"
g0, _ = now()
target = g0 + 2.4
with open(target_f + ".tmp", "w") as f:
    f.write("%.3f" % target)
t0 = time.time()
os.rename(target_f + ".tmp", target_f)
started = stopped = None
while time.time() - t0 < 6:
    g, p = now()
    if started is None and not p:
        started = time.time() - t0
    if started is not None and p:
        stopped = time.time() - t0
        break
    time.sleep(0.005)
time.sleep(1.0)
g2, p2 = now()
print("   start latency %.3f s, stopped after %.3f s (expect 2.4), held at %.6f, target %.6f, diff %.6f, 1 s later %.6f paused=%d"
      % (started or -1, stopped or -1, g, target, g - target, g2, p2))
ok = started is not None and stopped is not None and abs(g - target) < 1e-3 \
    and g2 == g and p2 and abs(stopped - 2.4) < 0.2
sys.exit(0 if ok else 1)
EOF

say "3. CPU while paused (10 s)"
cpu() { ps -o time= -p "$1" | awk -F'[:.]' '{ if (NF==3) print $1*60+$2+$3/100; else print $1*3600+$2*60+$3+$4/100 }'; }
c0=$(cpu "$SERVER_PID"); sleep 10; c1=$(cpu "$SERVER_PID")
awk -v a="$c0" -v b="$c1" 'BEGIN { printf "   %.2f CPU s in 10 s = %.1f%%\n", b-a, (b-a)*10 }'
awk -v a="$c0" -v b="$c1" 'BEGIN { exit !((b-a) < 1.0) }' || bad "paused server uses >10% CPU"
echo "   ps: $(ps -o %cpu=,rss= -p "$SERVER_PID")"

TSX="$ROOT/agents/node_modules/.bin/tsx"
if [ -x "$TSX" ]; then
  say "4. fake agent through a ${PAUSE_S} s pause"
  "$TSX" "$HERE/turn-clock-client.mts" 127.0.0.1 "$PORT" "$RUN" "$PAUSE_S" || bad "client checks"
else
  say "4. skipped (no agents/node_modules; run npm install in agents/)"
fi

say "5. restart continuity"
before="$(cat "$NOW")"
stop_server
saved="$(cat "$RUN/mtsClockGame.txt")"
sleep 2
start_server || exit 1
after="$(cat "$NOW")"
echo "   before stop: $before | persisted: $saved | after start: $after"
[ "$(awk '{print $1}' <<<"$before")" = "$(awk '{print $1}' <<<"$after")" ] \
  || bad "game time changed across restart"
[ "$(awk '{print $2}' <<<"$after")" = 1 ] || bad "not paused after restart"
grep "MTS turn clock" "$LOG" | tail -2 | sed 's/^/   log: /'

stop_server
if [ "$FAILED" = 0 ]; then say "all checks passed"; else say "some checks FAILED"; fi
exit "$FAILED"
