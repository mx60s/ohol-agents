#!/usr/bin/env bash
# Local test of the supervisor's world regeneration (deploy/start.sh, SIGUSR2),
# in seconds: a fake game server (node, listens on GAME_PORT, writes world
# files, saves players on SIGTSTP) and a fake agents service that asks for a
# regeneration through the real agents/src/regen.ts requestRegen(). No OHOL
# build, no LLM.
#
#   1. boot, then a regeneration request: the agents and the game server stop
#      gracefully, the world files are archived (count rotation) and deleted,
#      kept files stay, a fresh world starts, the agents get the new-run flag
#      with the reason; the supervisor never exits
#   2. SIGUSR2 without a request: ignored
#   3. crash after the commit (regen-pending, half the files moved): the next
#      boot finishes the wipe before the game server starts
#   4. crash before the commit (a request, a regen-pending.tmp): the next boot
#      drops them and starts the old world as it was
#
#   deploy/test/world-regen.sh            (GAME_PORT defaults to 8026)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
GAME_PORT="${GAME_PORT:-8026}"
WORK="${WORK:-$(mktemp -d "${TMPDIR:-/tmp}/as-regen-test.XXXXXX")}"
if (exec 3<>"/dev/tcp/127.0.0.1/$GAME_PORT") 2>/dev/null; then echo "port $GAME_PORT is in use"; exit 2; fi
[ -d "$ROOT/agents/node_modules/tsx" ] || { echo "run npm ci in agents/ first"; exit 2; }

t0=$(date +%s)
step() { echo; echo "=== [$(($(date +%s) - t0))s] $*"; }
fail() { echo "FAIL: $*"; echo "--- start.log"; tail -n 40 "$WORK/start.log" 2>/dev/null; exit 1; }
ok() { echo "  ok: $*"; }

# ---------- fakes ----------
mkdir -p "$WORK/server" "$WORK/agents/src" "$WORK/image"
cat > "$WORK/fake-server.cjs" <<'EOF'
// fake OneLifeServer: a new world (random map.db) when there is none, saves on SIGTSTP
const fs = require("fs"), net = require("net");
if (!fs.existsSync("map.db")) {
  const w = `world-${Date.now()}-${Math.random()}`;
  for (const f of ["map.db", "mapTime.db", "biome.db", "lookTime.db", "playerStats.db", "eve.db", "statue.db"]) fs.writeFileSync(f, `${w} ${f}\n`.repeat(200));
  fs.writeFileSync("biomeRandSeed.txt", `${Math.floor(Math.random() * 1e9)} 7`);
  fs.writeFileSync("lastEveLocation.txt", "10,10");
}
fs.writeFileSync("playerSaves.txt", `living players of ${fs.readFileSync("map.db", "utf8").split(" ")[0]}\n`);
net.createServer((s) => s.end()).listen(Number(process.env.PORT_OVERRIDE), "127.0.0.1");
process.on("SIGTSTP", () => {
  fs.writeFileSync("playerSaves.txt", `final save of ${fs.readFileSync("map.db", "utf8").split(" ")[0]}\n`);
  fs.appendFileSync("fake-server.log", "graceful quit\n");
  process.exit(0);
});
EOF
cat > "$WORK/server/run.sh" <<EOF
#!/usr/bin/env bash
mkdir -p "\$2/settings" && cd "\$2" && exec node "$WORK/fake-server.cjs"
EOF
chmod +x "$WORK/server/run.sh"
ln -s "$ROOT/agents/node_modules" "$WORK/agents/node_modules"
cat > "$WORK/agents/src/main.ts" <<EOF
// fake agents service: logs its start (with the new-run flag it took), asks
// for a regeneration when \$WORK/trigger appears, logs a graceful stop
import fs from "node:fs";
import { regenSettingsFromEnv, requestRegen } from "$ROOT/agents/src/regen.ts";
const out = "$WORK/agents.log";
const rec = (r: object) => fs.appendFileSync(out, JSON.stringify({ pid: process.pid, ...r }) + "\n");
const flag = \`\${process.env.LOG_DIR}/research/new-run.flag\`;
let taken: string | null = null;
if (fs.existsSync(flag)) {
  taken = fs.readFileSync(flag, "utf8");
  fs.unlinkSync(flag);
}
rec({ event: "start", epoch: process.env.GAME_SERVER_EPOCH, flag: taken });
setInterval(() => {
  if (!fs.existsSync("$WORK/trigger")) return;
  fs.unlinkSync("$WORK/trigger");
  const err = requestRegen(regenSettingsFromEnv(process.env, true), { reason: "no living characters for 180s", runId: "rt-r1-test", at: Date.now() });
  rec({ event: "requested", err });
}, 200);
process.on("SIGTERM", () => {
  rec({ event: "stop" });
  process.exit(0);
});
EOF

export DATA_DIR="$WORK/data" GAME_PORT IMAGE_APP_DIR="$WORK/image" SERVER_DIR="$WORK/server" AGENTS_DIR="$WORK/agents"
export APP_ROOT="$WORK/data/app" OHOL_BUILD="$WORK/nobuild"
export SUPERVISOR_PIDFILE="$WORK/supervisor.pid" SUPERVISOR_STATE="$WORK/supervisor.state"
export WORLD_ARCHIVE_KEEP=3 WORLD_ARCHIVE_MIN_FREE_MB=1 AGENTS_STOP_TIMEOUT=5 SERVER_STOP_TIMEOUT=5
W="$DATA_DIR/world"
ARCH="$DATA_DIR/worlds/archive"
PENDING="$DATA_DIR/worlds/regen-pending"
REQ="$DATA_DIR/worlds/regen-request.json"
FLAG="$DATA_DIR/logs/research/new-run.flag"

sup_pid=""
cleanup() {
  set +e
  if [ -n "$sup_pid" ] && kill -0 "$sup_pid" 2>/dev/null; then
    kill -TERM "$sup_pid"
    for _ in $(seq 1 40); do kill -0 "$sup_pid" 2>/dev/null || break; sleep 0.25; done
    kill -KILL "$sup_pid" 2>/dev/null
  fi
  echo "work dir: $WORK"
}
trap cleanup EXIT

wait_for() { # <timeout_s> <desc> <cmd...>
  local t="$1" d="$2"
  shift 2
  for _ in $(seq 1 $((t * 5))); do
    if "$@" >/dev/null 2>&1; then return 0; fi
    sleep 0.2
  done
  fail "timed out waiting for: $d"
}
starts() { grep -c '"event":"start"' "$WORK/agents.log" 2>/dev/null || true; }
starts_ge() { [ "$(starts)" -ge "$1" ]; }
last_start() { grep '"event":"start"' "$WORK/agents.log" | tail -n 1; }
state() { sed -n "s/^$1=//p" "$SUPERVISOR_STATE"; }
world_id() { cut -d' ' -f1 "$W/map.db" | head -n 1; }
boot() {
  "$ROOT/deploy/start.sh" >> "$WORK/start.log" 2>&1 &
  sup_pid=$!
  local n="$1"
  wait_for 20 "agents start #$n" starts_ge "$n"
}
stop_sup() {
  kill -TERM "$sup_pid"
  for _ in $(seq 1 40); do kill -0 "$sup_pid" 2>/dev/null || break; sleep 0.25; done
  kill -0 "$sup_pid" 2>/dev/null && fail "supervisor did not stop"
  sup_pid=""
}

# ---------- 1. regeneration ----------
step "boot (fake game :$GAME_PORT, data $DATA_DIR)"
mkdir -p "$W" "$ARCH/20200101T000000Z" "$ARCH/20200102T000000Z" "$ARCH/20200103T000000Z"
echo "curses" > "$W/curses.db"
echo "Smith" > "$W/mtsFamilyNames.txt"
echo "old log" > "$W/log.txt"
boot 1
old_world="$(world_id)"
old_server="$(state server_pid)"
[ "$(state regen_supported)" = 1 ] || fail "state file lacks regen_supported=1"
ok "world $old_world, server pid $old_server"

step "the agents ask for a regeneration (requestRegen -> SIGUSR2)"
touch "$WORK/trigger"
wait_for 30 "agents start #2" starts_ge 2
grep -q '"event":"requested","err":null' "$WORK/agents.log" || fail "request failed: $(grep requested "$WORK/agents.log")"
kill -0 "$sup_pid" || fail "the supervisor exited"
grep -q '"event":"stop"' "$WORK/agents.log" || fail "agents not stopped gracefully"
grep -q "graceful quit" "$W/fake-server.log" || fail "game server not stopped with SIGTSTP"
new_world="$(world_id)"
[ "$new_world" != "$old_world" ] || fail "same world after regeneration"
[ "$(state server_pid)" != "$old_server" ] || fail "game server not restarted"
[ "$(state world_regens)" = 1 ] || fail "world_regens != 1"
ok "fresh world $new_world, new server pid $(state server_pid), supervisor $sup_pid still up"
for f in curses.db mtsFamilyNames.txt log.txt settings; do [ -e "$W/$f" ] || fail "kept file $f is gone"; done
ok "kept: curses.db, mtsFamilyNames.txt, log.txt, settings"
newest="$(ls -1 "$ARCH" | sort -r | head -n 1)"
[ -f "$ARCH/$newest/world.tar.gz" ] || fail "no archive in $ARCH/$newest"
tar -xzf "$ARCH/$newest/world.tar.gz" -C "$WORK" ./map.db ./playerSaves.txt ./biomeRandSeed.txt ./lastEveLocation.txt ./statue.db || fail "archive incomplete"
[ "$(cut -d' ' -f1 "$WORK/map.db" | head -n 1)" = "$old_world" ] || fail "archive holds the wrong world"
grep -q "final save of $old_world" "$WORK/playerSaves.txt" || fail "archive lacks the final player save"
grep -q "no living characters" "$ARCH/$newest/request.json" || fail "archive lacks the request"
ok "archived to $newest: map DBs, seed, final playerSaves.txt, request"
[ "$(ls -1 "$ARCH" | wc -l | tr -d ' ')" = 3 ] || fail "rotation: $(ls -1 "$ARCH" | tr '\n' ' ')"
[ ! -e "$ARCH/20200101T000000Z" ] || fail "rotation kept the oldest archive"
ok "rotation: $(ls -1 "$ARCH" | tr '\n' ' ')"
last_start | grep -q '"flag":"{\\"worldRegenerated\\":true' || fail "agents didn't get the regeneration flag: $(last_start)"
last_start | grep -q 'no living characters for 180s' || fail "flag lacks the reason"
[ ! -e "$PENDING" ] && [ ! -e "$REQ" ] && [ ! -e "$FLAG" ] || fail "leftover regen-pending / request / flag"
ok "agents restarted with the new-run flag: $(last_start | cut -c 1-160)..."

# ---------- 2. SIGUSR2 without a request ----------
step "SIGUSR2 without a request file"
agents_pid="$(state agents_pid)"
kill -USR2 "$sup_pid"
sleep 2
[ "$(state agents_pid)" = "$agents_pid" ] && [ "$(world_id)" = "$new_world" ] || fail "an unrequested SIGUSR2 changed something"
grep -q "SIGUSR2 without" "$WORK/start.log" || fail "not logged"
ok "ignored"

# ---------- 3. crash after the commit ----------
step "crash after the commit: regen-pending with half the files moved, then boot"
stop_sup
w3="$(world_id)"
mkdir -p "$PENDING/stage"
echo "20991231T000000Z" > "$PENDING/stamp"
echo '{"reason":"crash test","runId":"rt-r2-test","at":1}' > "$PENDING/request.json"
mv "$W/map.db" "$W/mapTime.db" "$PENDING/stage/"
echo '{"reason":"stale"}' > "$REQ"
boot 3
[ "$(world_id)" != "$w3" ] || fail "old world after an interrupted regeneration"
tar -tzf "$ARCH/20991231T000000Z/world.tar.gz" > "$WORK/list3" || fail "no archive for the interrupted regeneration"
for f in map.db mapTime.db biome.db playerSaves.txt biomeRandSeed.txt; do grep -q "^\./$f$" "$WORK/list3" || fail "archive lacks $f"; done
last_start | grep -q 'crash test' || fail "agents didn't get the flag: $(last_start)"
[ ! -e "$PENDING" ] && [ ! -e "$REQ" ] || fail "leftover regen-pending / request"
ok "finished at boot: fresh world $(world_id), both halves archived, new-run flag taken"

# ---------- 4. crash before the commit ----------
step "crash before the commit: a request and regen-pending.tmp, then boot"
stop_sup
w4="$(world_id)"
echo '{"reason":"uncommitted"}' > "$REQ"
mkdir -p "$PENDING.tmp" && echo junk > "$PENDING.tmp/stamp"
boot 4
[ "$(world_id)" = "$w4" ] || fail "the old world was not kept"
[ ! -e "$REQ" ] && [ ! -e "$PENDING.tmp" ] && [ ! -e "$PENDING" ] || fail "leftovers after an uncommitted request"
last_start | grep -q '"flag":null' || fail "a new-run flag after an uncommitted request: $(last_start)"
ok "old world $w4 kept, request dropped"

step "PASS ($(($(date +%s) - t0))s)"
