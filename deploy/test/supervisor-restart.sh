#!/usr/bin/env bash
# Local integration test: the world survives agents-service crashes, restarts
# and hot updates. Runs deploy/start.sh against a local .ohol-build on spare
# ports with the fake LLM (no paid calls, no Docker, nothing on Fly):
#
#   1. start: game server + agents (CONTINUOUS=1), wait for 2 living Eves
#   2. SIGKILL the agents service -> the supervisor restarts it (backoff);
#      same run id, same characters (player ids), ages continue, no birth/death/lost
#   3. SIGUSR1 to the supervisor -> agents-only restart, same checks
#   4. hot update (deploy/hot-update.sh with HOT_UPDATE_LOCAL=1) -> override
#      version live, same checks; then rollback to the image, same checks
#   5. a crash-looping override -> dropped after AGENTS_MAX_CRASHES, image code back
#   6. a stale override (installed on another image) -> ignored at restart
#   the game server's pid is the same throughout
#
#   deploy/test/supervisor-restart.sh            (OHOL_BUILD defaults to <repo>/.ohol-build)
#   GAME_PORT=8016 PORT=8896 FAKE_LLM_PORT=8797 OHOL_BUILD=... deploy/test/supervisor-restart.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OHOL_BUILD="${OHOL_BUILD:-$ROOT/.ohol-build}"
GAME_PORT="${GAME_PORT:-8016}"
PORT="${PORT:-8896}"
FAKE_LLM_PORT="${FAKE_LLM_PORT:-8797}"
WORK="${WORK:-$(mktemp -d "${TMPDIR:-/tmp}/as-restart-test.XXXXXX")}"
API="http://127.0.0.1:$PORT"
CHECK="node $ROOT/deploy/test/check.mjs"

[ -x "$OHOL_BUILD/OneLife/server/OneLifeServer" ] || { echo "no OneLifeServer in $OHOL_BUILD (set OHOL_BUILD)"; exit 2; }
for p in "$GAME_PORT" "$PORT" "$FAKE_LLM_PORT"; do
  if (exec 3<>"/dev/tcp/127.0.0.1/$p") 2>/dev/null; then echo "port $p is in use"; exit 2; fi
done

t0=$(date +%s)
step() { echo; echo "=== [$(($(date +%s) - t0))s] $*"; }
fail() { echo "FAIL: $*"; exit 1; }

# "image": the repo checkout itself, plus an IMAGE_STAMP
IMG="$WORK/image"
mkdir -p "$IMG/viewer"
ln -s "$ROOT/agents" "$IMG/agents"
ln -s "$ROOT/data" "$IMG/data"
ln -s "$ROOT/server" "$IMG/server"
mkdir -p "$IMG/viewer/dist" && echo "image viewer" > "$IMG/viewer/dist/index.html"
echo "test-image-1" > "$IMG/IMAGE_STAMP"

export DATA_DIR="$WORK/data" OHOL_BUILD GAME_PORT PORT IMAGE_APP_DIR="$IMG" APP_ROOT="$WORK/data/app"
export SUPERVISOR_PIDFILE="$WORK/supervisor.pid" SUPERVISOR_STATE="$WORK/supervisor.state"
export LLM_BASE_URL="http://127.0.0.1:$FAKE_LLM_PORT" LLM_API_KEY=fake OPENROUTER_API_KEY=fake
export AGENT_COUNT=2 INITIAL_EVES=2 JOIN_STAGGER_S=3 OHOL_SETTING_forceAllPlayersEve=1 RUN_ID=rt
export NARRATOR_INTERVAL_MS=0 DIRECTOR_INTERVAL_MS=0 STORY_INTERVAL_MS=0 LLM_OUTAGE_PAUSE_S=0
export AGENTS_BACKOFF_BASE=1 AGENTS_MAX_CRASHES=2 AGENTS_STABLE_S=600 AGENTS_STOP_TIMEOUT=10

pids=()
cleanup() {
  set +e
  if [ -n "${sup_pid:-}" ] && kill -0 "$sup_pid" 2>/dev/null; then
    kill -TERM "$sup_pid"
    for _ in $(seq 1 60); do kill -0 "$sup_pid" 2>/dev/null || break; sleep 0.5; done
    kill -KILL "$sup_pid" 2>/dev/null
  fi
  for p in "${pids[@]}"; do kill "$p" 2>/dev/null; done
  echo "logs: $WORK/start.log"
}
trap cleanup EXIT

step "fake LLM on :$FAKE_LLM_PORT"
(cd "$ROOT/agents" && exec node --import tsx src/tools/fake-llm.ts --port "$FAKE_LLM_PORT" --latency-ms 300) > "$WORK/fake-llm.log" 2>&1 &
pids+=($!)

step "start.sh (game :$GAME_PORT, api :$PORT, data $DATA_DIR)"
"$ROOT/deploy/start.sh" > "$WORK/start.log" 2>&1 &
sup_pid=$!

wait_for() { # <timeout_s> <desc> <cmd...>
  local t="$1" d="$2" out=""
  shift 2
  for _ in $(seq 1 "$t"); do
    if out="$("$@" 2>&1)"; then echo "  $out"; return 0; fi
    sleep 1
  done
  echo "  last: $out"
  fail "$d (after ${t}s)"
}
state_val() { grep "^$1=" "$SUPERVISOR_STATE" | cut -d= -f2-; }

wait_for 120 "2 characters alive" $CHECK alive "$API" 2
server_pid="$(state_val server_pid)"
echo "  game server pid $server_pid"
sleep 5   # let them act a little

step "1. SIGKILL the agents service (crash)"
$CHECK snapshot "$API" "$WORK/before1.json"
old="$(state_val agents_pid)"
kill -KILL "$old"
wait_for 60 "supervisor restarted the agents" bash -c "p=\$(grep ^agents_pid= '$SUPERVISOR_STATE' | cut -d= -f2); [ -n \"\$p\" ] && [ \"\$p\" != '$old' ] && echo agents pid $old '->' \$p"
wait_for 90 "same characters after the crash" $CHECK same "$API" "$WORK/before1.json"
[ "$(state_val server_pid)" = "$server_pid" ] && kill -0 "$server_pid" || fail "game server restarted"

step "2. SIGUSR1: agents-only restart"
sleep 5
$CHECK snapshot "$API" "$WORK/before2.json"
old="$(state_val agents_pid)"
kill -USR1 "$sup_pid"
wait_for 60 "agents restarted on SIGUSR1" bash -c "p=\$(grep ^agents_pid= '$SUPERVISOR_STATE' | cut -d= -f2); [ -n \"\$p\" ] && [ \"\$p\" != '$old' ] && echo agents pid $old '->' \$p"
wait_for 90 "same characters after SIGUSR1" $CHECK same "$API" "$WORK/before2.json"
kill -0 "$server_pid" || fail "game server died"

step "3. hot update (local mode)"
sleep 3
$CHECK snapshot "$API" "$WORK/before3.json"
HOT_UPDATE_LOCAL=1 APP_URL="$API" VERIFY_TIMEOUT_S=120 "$ROOT/deploy/hot-update.sh" --skip-viewer-ci 2>&1 | sed 's/^/  /'
[ "${PIPESTATUS[0]}" = 0 ] || fail "hot-update.sh failed"
ver="$(head -n 1 "$APP_ROOT/current/VERSION")"
grep -q "agents_app=$(cd "$APP_ROOT/current" && pwd -P)" "$SUPERVISOR_STATE" || fail "agents not running from the override"
wait_for 30 "same characters after the hot update" $CHECK same "$API" "$WORK/before3.json" --version "$ver"
curl -fsS "$API/" | grep -q "<div id=\"root\">" || fail "viewer not served from the override"
kill -0 "$server_pid" || fail "game server died"
bash "$ROOT/deploy/app-switch.sh" status | sed 's/^/  /'

step "4. rollback to the image"
sleep 3
$CHECK snapshot "$API" "$WORK/before4.json"
HOT_UPDATE_LOCAL=1 "$ROOT/deploy/hot-update.sh" rollback 2>&1 | sed 's/^/  /'
wait_for 90 "same characters after the rollback" $CHECK same "$API" "$WORK/before4.json" --version "image test-image-1"
[ ! -e "$APP_ROOT/current" ] || fail "current still set after rollback"
kill -0 "$server_pid" || fail "game server died"

step "5. a crash-looping override is dropped"
sleep 3
$CHECK snapshot "$API" "$WORK/before5.json"
bad="$APP_ROOT/versions/broken"
cp -R "$APP_ROOT/versions/$(ls -1t "$APP_ROOT/versions" | head -n 1)" "$bad"
echo "broken" > "$bad/VERSION"
echo 'throw new Error("broken build");' > "$bad/agents/src/main.ts"
ln -sfn versions/broken "$APP_ROOT/current"
kill -USR1 "$sup_pid"
wait_for 60 "override disabled after the crash loop" grep -q "disabled versions/broken: crash loop" "$APP_ROOT/disabled.log"
wait_for 90 "same characters on the image code" $CHECK same "$API" "$WORK/before5.json" --version "image test-image-1"
kill -0 "$server_pid" || fail "game server died"

step "6. a stale override (installed on another image) is ignored"
sleep 3
$CHECK snapshot "$API" "$WORK/before6.json"
good="$(ls -1t "$APP_ROOT/versions" | grep -v broken | head -n 1)"
ln -sfn "versions/$good" "$APP_ROOT/current"
echo "test-image-0" > "$APP_ROOT/versions/$good/BASE_IMAGE_STAMP"
kill -USR1 "$sup_pid"
wait_for 60 "stale override disabled" grep -q "disabled versions/$good: installed on image test-image-0" "$APP_ROOT/disabled.log"
wait_for 90 "same characters after ignoring the stale override" $CHECK same "$API" "$WORK/before6.json" --version "image test-image-1"
[ "$(state_val server_pid)" = "$server_pid" ] && kill -0 "$server_pid" || fail "game server restarted"

step "lives summary"
curl -fsS "$API/api/lives?since=0&limit=100" | node -e '
  let s=""; process.stdin.on("data",c=>s+=c).on("end",()=>{ for (const l of JSON.parse(s).lives)
    console.log(`  ${l.lifeId} ${l.agentId} ${l.status} born ${new Date(l.bornAt).toISOString().slice(11,19)} lost ${l.lostAt} died ${l.diedAt} valid ${l.validForStudy}`); });'
grep -c "reconnected to" "$WORK"/data/logs/rt-*/events.jsonl | sed 's/^/  reconnect events: /'
grep '\[start.sh\]' "$WORK/start.log" | sed 's/^/  /'

step "PASS ($(($(date +%s) - t0))s)"
