#!/bin/bash
# Reassemble the run data from the backups made by deploy/backup-logs.sh.
#
#   deploy/restore-logs.sh <out dir> [runId ...]
#
# Extracts every ohol-<UTC stamp>*.tar.gz in the backups folder in stamp order,
# so a later copy of a live file (events.jsonl, llm.jsonl, positions.jsonl,
# lives.snapshot.json, ...) overwrites an earlier one, and rotated files
# (<stem>.<stamp>.jsonl), which never change, land once. The result is the
# server's /data layout: <out dir>/logs/<runId>-<startStamp>/..., <out dir>/logs/research/...,
# <out dir>/worlds/archive/... With run ids, only logs/<runId>-<stamp>/ plus the
# cross-run files (logs/research, logs/*.jsonl) are extracted.
# To read one file's full history in a run dir: docs/data-format.md "Rotation".
#
# Env: OHOL_BACKUPS (the backups folder; default <Google Drive>/My Drive/ohol-archive/backups).
set -euo pipefail
export LC_ALL=C

[ $# -ge 1 ] || { echo "usage: $0 <out dir> [runId ...]" >&2; exit 2; }
OUT="$1"
shift

if [ -z "${OHOL_BACKUPS:-}" ]; then
  shopt -s nullglob
  drives=("$HOME"/Library/CloudStorage/GoogleDrive-*/"My Drive")
  shopt -u nullglob
  [ "${#drives[@]}" -eq 1 ] || { echo "set OHOL_BACKUPS to the backups folder (found ${#drives[@]} Google Drive folders)" >&2; exit 1; }
  OHOL_BACKUPS="${drives[0]}/ohol-archive/backups"
fi
[ -d "$OHOL_BACKUPS" ] || { echo "backups folder not found (Google Drive offline?)" >&2; exit 1; }

# ohol-<YYYYMMDDTHHMMSSZ>[-initial].tar.gz sorts by time
archives=()
while IFS= read -r f; do archives+=("$f"); done < <(ls "$OHOL_BACKUPS" | grep -E '^ohol-[0-9]{8}T[0-9]{6}Z[^/]*\.tar\.gz$' | sort)
[ "${#archives[@]}" -gt 0 ] || { echo "no backups in $OHOL_BACKUPS" >&2; exit 1; }

# with run ids: logs/<runId>-<stamp>/..., logs/research/..., logs/<file> (exact regex over the member list)
filter=""
if [ $# -gt 0 ]; then
  runs="$(printf '%s\n' "$@" | sed 's/[.[\*^$()+?{}|]/\\&/g' | paste -sd'|' -)"
  filter="^logs/(($runs)-[^/]+/|research/|[^/]+$)"
fi

mkdir -p "$OUT"
list="$(mktemp)"
trap 'rm -f "$list"' EXIT
for a in "${archives[@]}"; do
  echo "extracting $a"
  if [ -n "$filter" ]; then
    tar -tzf "$OHOL_BACKUPS/$a" | grep -v '/$' | grep -E "$filter" > "$list" || true
    [ -s "$list" ] && tar -xzf "$OHOL_BACKUPS/$a" -C "$OUT" -T "$list"
  else
    tar -xzf "$OHOL_BACKUPS/$a" -C "$OUT"
  fi
done
echo "restored ${#archives[@]} backups into $OUT"
