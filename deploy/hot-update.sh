#!/usr/bin/env bash
# Hot update: ship new agents + viewer code to the running Fly machine and
# restart ONLY the agents service. The game server, the world and every living
# character stay up; in CONTINUOUS mode the agents keep their run id and log
# back into the same bodies. Run from the repo root on your laptop.
#
#   deploy/hot-update.sh [--new-run] [--skip-viewer-ci]   build, upload, switch, verify
#   deploy/hot-update.sh rollback [--image]               previous version (or the image's code)
#   deploy/hot-update.sh status
#
# What it does: builds viewer/dist (VITE_API_URL=same-origin; the OHOL art is
# not uploaded, the machine links the image's), packs agents/{src,package*.json,
# tsconfig.json} + data/ + viewer/dist + VERSION into a tarball, uploads it with
# `fly ssh sftp put`, runs deploy/app-switch.sh install on the machine (new
# versioned dir under /data/app/versions, atomic switch of /data/app/current,
# SIGUSR1 to the supervisor), then polls /api/state until every character that
# was alive before is alive again with the same player id under the same run id.
#
# Needs a full `fly deploy` instead (restarts the game server and ends every
# living character): game-server or server/patches changes, server/settings,
# Dockerfile or start.sh changes, agents dependency changes (package-lock.json),
# fly.toml [env] changes. See deploy/README.md.
#
# Env: FLY_APP (default from fly.toml), APP_URL (default https://<app>.fly.dev),
# VERIFY_TIMEOUT_S (default 240).
# HOT_UPDATE_LOCAL=1 runs the "remote" steps on this machine instead (tests:
# same APP_ROOT / IMAGE_APP_DIR / SUPERVISOR_PIDFILE env as start.sh).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FLY_APP="${FLY_APP:-$(sed -n 's/^app *= *"\(.*\)"/\1/p' "$ROOT/fly.toml" | head -n 1)}"
APP_URL="${APP_URL:-https://$FLY_APP.fly.dev}"
VERIFY_TIMEOUT_S="${VERIFY_TIMEOUT_S:-240}"
LOCAL="${HOT_UPDATE_LOCAL:-0}"

say() { echo "[hot-update] $*"; }
die() { echo "[hot-update] error: $*" >&2; exit 1; }

remote_put() { # <local> <remote>
  if [ "$LOCAL" = 1 ]; then cp "$1" "$2"; else fly ssh sftp put -a "$FLY_APP" "$1" "$2" >/dev/null; fi
}
remote_exec() { # <args...> (no shell on the remote side: plain words only)
  if [ "$LOCAL" = 1 ]; then "$@"; else fly ssh console -a "$FLY_APP" -C "$*"; fi
}
switch_script() { # the image's copy (rollback/status)
  if [ "$LOCAL" = 1 ]; then echo "$ROOT/deploy/app-switch.sh"; else echo /app/deploy/app-switch.sh; fi
}

state_json() { curl -fsS --max-time 10 "$APP_URL/api/state"; }

# prints "<runId> <agentId>:<playerId> ..." for living agents
summarize() {
  node -e '
    let s = ""; process.stdin.on("data", (c) => (s += c)).on("end", () => {
      const j = JSON.parse(s);
      const alive = j.agents.filter((a) => a.status === "alive" && a.playerId != null).map((a) => `${a.agentId}:${a.playerId}`);
      console.log([j.run.id, ...alive.sort()].join(" "));
    });'
}

case "${1:-}" in
  rollback)
    shift
    remote_exec bash "$(switch_script)" rollback "$@"
    exit 0
    ;;
  status)
    remote_exec bash "$(switch_script)" status
    exit 0
    ;;
esac

NEW_RUN=""
VIEWER_CI=1
for a in "$@"; do
  case "$a" in
    --new-run) NEW_RUN="--new-run" ;;
    --skip-viewer-ci) VIEWER_CI=0 ;;
    *) die "unknown option $a (usage: hot-update.sh [--new-run] [--skip-viewer-ci] | rollback [--image] | status)" ;;
  esac
done

# ---------- build ----------
sha="$(git -C "$ROOT" rev-parse --short HEAD)"
dirty=""
[ -n "$(git -C "$ROOT" status --porcelain -- agents viewer data)" ] && dirty="-dirty"
VERSION="$(date -u +%Y%m%dT%H%M%SZ)-$sha$dirty"
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/as-hot-update.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT
APP="$STAGE/app"
mkdir -p "$APP/agents" "$APP/viewer" "$APP/deploy"
say "version $VERSION"

if git -C "$ROOT" diff --quiet HEAD -- server deploy/Dockerfile deploy/start.sh fly.toml 2>/dev/null; then :; else
  say "warning: uncommitted changes under server/, deploy/Dockerfile, deploy/start.sh or fly.toml are NOT part of a hot update (full deploy needed)"
fi

say "type-checking the agents"
(cd "$ROOT/agents" && npx tsc --noEmit)

say "building the viewer (VITE_API_URL=same-origin)"
if [ "$VIEWER_CI" = 1 ] || [ ! -d "$ROOT/viewer/node_modules" ]; then (cd "$ROOT/viewer" && npm ci --no-audit --no-fund >/dev/null); fi
(cd "$ROOT/viewer" && VITE_API_URL=same-origin npm run build -- --outDir "$APP/viewer/dist" --emptyOutDir >/dev/null)
# never ship the art: a local public/ohol gets copied into dist by vite
rm -rf "$APP/viewer/dist/ohol"

cp "$ROOT/agents/package.json" "$ROOT/agents/package-lock.json" "$ROOT/agents/tsconfig.json" "$APP/agents/"
(cd "$ROOT/agents" && tar cf - --exclude '*.test.ts' src) | (cd "$APP/agents" && tar xf -)
cp -R "$ROOT/data" "$APP/data"
cp "$ROOT/deploy/app-switch.sh" "$APP/deploy/"
echo "$VERSION" > "$APP/VERSION"
git -C "$ROOT" log -1 --format='%H %s' >> "$APP/VERSION"
tar czf "$STAGE/bundle.tgz" -C "$APP" .
say "bundle $(du -h "$STAGE/bundle.tgz" | cut -f1)"

# ---------- before ----------
before=""
if s="$(state_json 2>/dev/null)"; then before="$(echo "$s" | summarize)"; fi
if [ -n "$before" ]; then say "before: run ${before%% *}; alive: ${before#* }"; else say "warning: $APP_URL/api/state unreachable before the update"; fi
[ "$before" = "${before%% *}" ] && before="$before " # no one alive

# ---------- upload + switch ----------
rtgz="/tmp/as-bundle-$VERSION.tgz"
rsh="/tmp/as-app-switch-$VERSION.sh"
say "uploading"
remote_put "$STAGE/bundle.tgz" "$rtgz"
remote_put "$ROOT/deploy/app-switch.sh" "$rsh"
remote_exec bash "$rsh" install "$rtgz" $NEW_RUN
remote_exec rm -f "$rtgz" "$rsh" || true

# ---------- verify ----------
say "waiting for the agents service (up to ${VERIFY_TIMEOUT_S}s)"
deadline=$(($(date +%s) + VERIFY_TIMEOUT_S))
want_run="${before%% *}"
want_alive="${before#* }"
sleep 3
ok=0
missing=""
while [ "$(date +%s)" -lt "$deadline" ]; do
  if h="$(curl -fsS --max-time 5 "$APP_URL/health" 2>/dev/null)" && echo "$h" | grep -q "\"appVersion\":\"$VERSION\""; then
    now="$(state_json 2>/dev/null | summarize 2>/dev/null || true)"
    run="${now%% *}"
    if [ -n "$NEW_RUN" ]; then
      [ -n "$run" ] && [ "$run" != "$want_run" ] && { ok=1; break; }
    elif [ -n "$want_run" ] && [ "$run" != "$want_run" ]; then
      die "run id changed: $want_run -> $run (characters abandoned). Roll back: deploy/hot-update.sh rollback"
    else
      missing=""
      for p in $want_alive; do case " ${now#* } " in *" $p "*) ;; *) missing="$missing $p" ;; esac; done
      if [ -z "$missing" ]; then ok=1; break; fi
    fi
  fi
  sleep 5
done
after="$(state_json 2>/dev/null | summarize 2>/dev/null || true)"
say "after:  run ${after%% *}; alive: ${after#* }"
if [ "$ok" = 1 ]; then
  if [ -n "$NEW_RUN" ]; then say "OK: $VERSION is live with a fresh run ${after%% *}"
  else say "OK: $VERSION is live; run ${want_run:-?} unchanged; reconnected:${want_alive:+ $want_alive}"; fi
else
  say "NOT VERIFIED after ${VERIFY_TIMEOUT_S}s (version live? characters back?)${missing:+; missing:$missing}"
  say "check: deploy/hot-update.sh status; fly logs. Roll back: deploy/hot-update.sh rollback"
  exit 1
fi
