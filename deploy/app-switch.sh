#!/usr/bin/env bash
# On-machine half of a hot update (deploy/hot-update.sh runs it over
# `fly ssh console`). Manages the agents/viewer override on the volume:
#
#   $APP_ROOT/versions/<version>/   agents/ (src, package*.json, node_modules -> image's),
#                                   viewer/dist (ohol/ art -> image's), data/, VERSION,
#                                   BASE_IMAGE_STAMP (the image it was installed on)
#   $APP_ROOT/current  -> versions/<version>   what start.sh runs (absent = the image)
#   $APP_ROOT/previous                          what `rollback` switches back to
#
# Usage:
#   app-switch.sh install <bundle.tgz> [--new-run]   unpack, validate, switch, restart the agents
#   app-switch.sh rollback [--image]                 switch to the previous version (or the image)
#   app-switch.sh restart                            restart only the agents service (SIGUSR1)
#   app-switch.sh status
#
# The switch is a symlink rename (atomic); only the agents service restarts,
# never the game server. Paths are env-overridable for local tests.
set -euo pipefail

DATA_DIR="${DATA_DIR:-/data}"
APP_ROOT="${APP_ROOT:-$DATA_DIR/app}"
IMAGE_APP_DIR="${IMAGE_APP_DIR:-/app}"
LOG_DIR="${LOG_DIR:-$DATA_DIR/logs}"
SUPERVISOR_PIDFILE="${SUPERVISOR_PIDFILE:-/tmp/as-supervisor.pid}"
SUPERVISOR_STATE="${SUPERVISOR_STATE:-/tmp/as-supervisor.state}"
KEEP_VERSIONS="${KEEP_VERSIONS:-5}"

say() { echo "[app-switch] $*"; }
die() { echo "[app-switch] error: $*" >&2; exit 1; }

valid() {
  local d="$1"
  [ -f "$d/VERSION" ] && [ -f "$d/agents/src/main.ts" ] && [ -f "$d/agents/package.json" ] &&
    [ -f "$d/agents/node_modules/tsx/package.json" ] && [ -f "$d/viewer/dist/index.html" ]
}

current_target() { readlink "$APP_ROOT/current" 2>/dev/null || echo image; }

# point `current` at versions/<v> (relative link), or remove it for "image"
switch_to() {
  local target="$1"
  if [ "$target" = image ]; then
    rm -f "$APP_ROOT/current"
    return
  fi
  ln -sfn "$target" "$APP_ROOT/.current.new"
  # GNU mv -T renames over the old link atomically; BSD mv (local tests) has no -T
  mv -T -f "$APP_ROOT/.current.new" "$APP_ROOT/current" 2>/dev/null || {
    rm -f "$APP_ROOT/current"
    mv -f "$APP_ROOT/.current.new" "$APP_ROOT/current"
  }
}

signal_supervisor() {
  local pid
  pid="$(cat "$SUPERVISOR_PIDFILE" 2>/dev/null || true)"
  if [ -z "$pid" ] || ! kill -0 "$pid" 2>/dev/null; then
    die "supervisor not running (no live pid in $SUPERVISOR_PIDFILE); the switch applies at the next start"
  fi
  kill -USR1 "$pid"
  say "asked the supervisor (pid $pid) to restart the agents service"
}

prune() {
  local keep_cur keep_prev n=0 v
  keep_cur="$(basename "$(current_target)")"
  keep_prev="$(basename "$(cat "$APP_ROOT/previous" 2>/dev/null || echo image)")"
  # newest first
  for v in $(ls -1t "$APP_ROOT/versions" 2>/dev/null); do
    n=$((n + 1))
    [ "$v" = "$keep_cur" ] || [ "$v" = "$keep_prev" ] || [ "$n" -le "$KEEP_VERSIONS" ] && continue
    rm -rf "${APP_ROOT:?}/versions/$v"
    say "pruned old version $v"
  done
}

cmd_install() {
  local tgz="${1:-}" new_run="${2:-}"
  [ -f "$tgz" ] || die "usage: app-switch.sh install <bundle.tgz> [--new-run]"
  [ -d "$IMAGE_APP_DIR/agents/node_modules/tsx" ] || die "$IMAGE_APP_DIR/agents/node_modules has no tsx; is IMAGE_APP_DIR right?"
  mkdir -p "$APP_ROOT/versions"
  tmp="$(mktemp -d "$APP_ROOT/versions/.incoming.XXXXXX")"   # global: the EXIT trap needs it
  trap 'rm -rf "$tmp"' EXIT
  tar xzf "$tgz" -C "$tmp"
  [ -f "$tmp/VERSION" ] || die "bundle has no VERSION"
  local ver
  ver="$(head -n 1 "$tmp/VERSION" | tr -cd 'A-Za-z0-9._-')"
  [ -n "$ver" ] || die "empty VERSION"

  # dependencies come from the image; a changed lockfile needs a full deploy
  if [ -f "$IMAGE_APP_DIR/agents/package-lock.json" ]; then
    cmp -s "$tmp/agents/package-lock.json" "$IMAGE_APP_DIR/agents/package-lock.json" ||
      die "agents/package-lock.json differs from the image's: dependencies changed, run a full 'fly deploy'"
  else
    say "warning: the image has no agents/package-lock.json to compare; assuming the dependencies match"
  fi
  ln -sfn "$IMAGE_APP_DIR/agents/node_modules" "$tmp/agents/node_modules"
  # the OHOL art (~14 MB) is not uploaded: reuse the image's
  if [ ! -e "$tmp/viewer/dist/ohol" ] && [ -d "$IMAGE_APP_DIR/viewer/dist/ohol" ]; then
    ln -s "$IMAGE_APP_DIR/viewer/dist/ohol" "$tmp/viewer/dist/ohol"
  fi
  [ -e "$tmp/data" ] || ln -s "$IMAGE_APP_DIR/data" "$tmp/data"
  if [ -f "$IMAGE_APP_DIR/IMAGE_STAMP" ]; then cp "$IMAGE_APP_DIR/IMAGE_STAMP" "$tmp/BASE_IMAGE_STAMP"; fi
  valid "$tmp" || die "bundle incomplete (needs VERSION, agents/src/main.ts, agents/package.json, viewer/dist/index.html)"

  local dest="$APP_ROOT/versions/$ver"
  [ -e "$dest" ] && dest="$dest-$(date +%s)"
  chmod 755 "$tmp"
  mv "$tmp" "$dest"
  trap - EXIT

  current_target > "$APP_ROOT/previous"
  switch_to "versions/$(basename "$dest")"
  say "current -> versions/$(basename "$dest") (previous: $(cat "$APP_ROOT/previous"))"
  if [ "$new_run" = "--new-run" ]; then
    mkdir -p "$LOG_DIR/research"
    : > "$LOG_DIR/research/new-run.flag"
    say "new-run flag set: the agents start a fresh run (new characters)"
  fi
  prune
  signal_supervisor
}

cmd_rollback() {
  local target cur
  cur="$(current_target)"
  if [ "${1:-}" = "--image" ]; then
    target=image
  else
    target="$(cat "$APP_ROOT/previous" 2>/dev/null || echo image)"
  fi
  if [ "$target" != image ] && ! valid "$APP_ROOT/$target"; then
    die "previous version $target is missing or invalid; use 'rollback --image'"
  fi
  [ "$target" = "$cur" ] && die "already on $cur"
  switch_to "$target"
  echo "$cur" > "$APP_ROOT/previous"
  say "rolled back: current -> $target (previous: $cur)"
  signal_supervisor
}

cmd_status() {
  echo "image:    $IMAGE_APP_DIR (stamp $(cat "$IMAGE_APP_DIR/IMAGE_STAMP" 2>/dev/null || echo none))"
  local cur
  cur="$(current_target)"
  if [ "$cur" = image ]; then
    echo "current:  image (no override)"
  else
    echo "current:  $cur ($(head -n 1 "$APP_ROOT/current/VERSION" 2>/dev/null || echo '?'), installed on image $(cat "$APP_ROOT/current/BASE_IMAGE_STAMP" 2>/dev/null || echo '?'))"
  fi
  echo "previous: $(cat "$APP_ROOT/previous" 2>/dev/null || echo none)"
  echo "versions: $(ls -1t "$APP_ROOT/versions" 2>/dev/null | tr '\n' ' ')"
  if [ -f "$SUPERVISOR_STATE" ]; then
    echo "supervisor state:"
    sed 's/^/  /' "$SUPERVISOR_STATE"
  fi
  [ -f "$APP_ROOT/disabled.log" ] && { echo "disabled overrides:"; tail -n 5 "$APP_ROOT/disabled.log" | sed 's/^/  /'; }
  return 0
}

case "${1:-}" in
  install) shift; cmd_install "$@" ;;
  rollback) shift; cmd_rollback "$@" ;;
  restart) signal_supervisor ;;
  status) cmd_status ;;
  *) die "usage: app-switch.sh install <bundle.tgz> [--new-run] | rollback [--image] | restart | status" ;;
esac
