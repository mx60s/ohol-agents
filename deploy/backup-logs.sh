#!/bin/bash
# Incremental off-site backup of the always-on run's data, run on the laptop
# (launchd every 3 h and at login: deploy/com.ohol.backup.plist; README "Log backups").
#
#   1. lists /data/logs and /data/worlds/archive on the Fly machine (path, size, mtime);
#   2. compares with the local manifest (~/ohol-archive/manifest.tsv);
#   3. streams only new or changed files as one tar.gz over `fly ssh console`
#      (the list goes in on stdin, no argument-length limits);
#   4. verifies it (gzip -t, the tar listing against the expected files), puts it in
#      <Google Drive>/My Drive/ohol-archive/backups/ohol-<UTC stamp>.tar.gz
#      with ohol-<UTC stamp>.files.tsv next to it, verifies the Drive copy, and only
#      then appends the files to the manifest.
#
# Read-only on the server. Live files that are still growing (events.jsonl, llm.jsonl,
# positions.jsonl, lives/*.jsonl, research/lives.snapshot.json, ...) are included
# every time they changed, so the newest backup has the latest copy; rotated files
# (<stem>.<stamp>.jsonl) never change and are copied once. Restore: deploy/restore-logs.sh.
#
# Env overrides: OHOL_APP (artificial-selection), FLY (fly binary), OHOL_ARCHIVE_DIR
# (~/ohol-archive), OHOL_DRIVE_DIR (the "My Drive" folder; found automatically when
# there is exactly one Google Drive account), OHOL_START_DRIVE (1: start Google Drive for
# desktop in the background when it isn't running; 0: fail instead).
set -euo pipefail
umask 077
export LC_ALL=C

APP="${OHOL_APP:-artificial-selection}"
FLY="${FLY:-$(command -v fly || command -v flyctl || echo /usr/local/bin/fly)}"
ARCHIVE_DIR="${OHOL_ARCHIVE_DIR:-$HOME/ohol-archive}"
MANIFEST="$ARCHIVE_DIR/manifest.tsv"
LOCK="$ARCHIVE_DIR/backup.lock"
FIRST_ARCHIVE="$ARCHIVE_DIR/ohol-data-20261118T1945.tar.gz"
# the first manual backup's name in Drive: sorts by its UTC time among the others (19:45 PST)
FIRST_ARCHIVE_DRIVE_NAME="ohol-20261119T034500Z-initial.tar.gz"

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
die() { log "ERROR: $*" >&2; exit 1; }

mkdir -p "$ARCHIVE_DIR"

# --- one copy at a time
if ! mkdir "$LOCK" 2>/dev/null; then
  pid="$(cat "$LOCK/pid" 2>/dev/null || true)"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    log "another backup is running (pid $pid); not starting a second one"
    exit 0
  fi
  log "removing a stale lock (pid ${pid:-unknown} is gone)"
  rm -rf "$LOCK"
  mkdir "$LOCK" || die "can't take the lock $LOCK"
fi
echo $$ > "$LOCK/pid"
STAGE="$(mktemp -d "$ARCHIVE_DIR/.stage.XXXXXX")"
cleanup() { rm -rf "$STAGE" "$LOCK"; }
trap cleanup EXIT

# --- Google Drive must be there and online
if [ -z "${OHOL_DRIVE_DIR:-}" ]; then
  shopt -s nullglob
  drives=("$HOME"/Library/CloudStorage/GoogleDrive-*/"My Drive")
  shopt -u nullglob
  [ "${#drives[@]}" -ge 1 ] || die "Google Drive folder not found under ~/Library/CloudStorage (is Google Drive for desktop installed and signed in?)"
  [ "${#drives[@]}" -eq 1 ] || die "more than one Google Drive account found; set OHOL_DRIVE_DIR to the 'My Drive' folder to use"
  OHOL_DRIVE_DIR="${drives[0]}"
fi
drive_running() { pgrep -f "Google Drive.app/Contents/MacOS/Google Drive" >/dev/null 2>&1; }
if ! drive_running && [ "${OHOL_START_DRIVE:-1}" = "1" ] && [ -d "/Applications/Google Drive.app" ]; then
  log "Google Drive for desktop isn't running; starting it in the background"
  open -g -a "Google Drive" || true
  for _ in $(seq 1 60); do drive_running && break; sleep 1; done
  sleep 10 # let it reconnect its folder
fi
drive_running || die "Google Drive for desktop isn't running, so nothing would upload (Drive offline); start it and run again"
if ! ls_err="$(ls "$OHOL_DRIVE_DIR" 2>&1 >/dev/null)"; then
  case "$ls_err" in
    *"not permitted"*) die "macOS doesn't let this job read your Google Drive folder (${ls_err##*: }). Give /bin/bash Full Disk Access (System Settings > Privacy & Security), or allow the prompt, and run again" ;;
    *) die "Google Drive folder is missing or offline: My Drive is not readable (${ls_err##*: })" ;;
  esac
fi
DEST="$OHOL_DRIVE_DIR/ohol-archive/backups"
mkdir -p "$DEST" 2>/dev/null || die "can't create ohol-archive/backups in your Google Drive (offline?)"
probe="$DEST/.write-test.$$"
{ : > "$probe" && rm -f "$probe"; } 2>/dev/null || die "Google Drive folder is not writable (offline?)"

[ -x "$FLY" ] || die "fly CLI not found (set FLY=/path/to/fly)"

# --- once: the first manual backup goes to Drive too, and seeds the manifest
if [ -f "$FIRST_ARCHIVE" ] && [ ! -f "$DEST/$FIRST_ARCHIVE_DRIVE_NAME" ]; then
  log "copying the first manual backup to Drive as $FIRST_ARCHIVE_DRIVE_NAME"
  nice -n 10 cp "$FIRST_ARCHIVE" "$DEST/$FIRST_ARCHIVE_DRIVE_NAME.partial"
  cmp -s "$FIRST_ARCHIVE" "$DEST/$FIRST_ARCHIVE_DRIVE_NAME.partial" || die "the Drive copy of the first backup differs from the original"
  mv "$DEST/$FIRST_ARCHIVE_DRIVE_NAME.partial" "$DEST/$FIRST_ARCHIVE_DRIVE_NAME"
fi
if [ ! -f "$MANIFEST" ]; then
  printf 'path\tsize\tmtime\tuploaded_at\tarchive\n' > "$MANIFEST.new"
  if [ -f "$FIRST_ARCHIVE" ] && [ -f "$DEST/$FIRST_ARCHIVE_DRIVE_NAME" ]; then
    log "seeding the manifest from the first manual backup"
    at="$(date -u -r "$FIRST_ARCHIVE" +%Y-%m-%dT%H:%M:%SZ)"
    nice -n 10 python3 -I - "$FIRST_ARCHIVE" "$at" "$FIRST_ARCHIVE_DRIVE_NAME" >> "$MANIFEST.new" <<'PY'
import sys, tarfile
src, at, name = sys.argv[1:4]
with tarfile.open(src) as t:
    for m in t:
        if m.isfile() and "\t" not in m.name and "\n" not in m.name:
            print(f"{m.name}\t{m.size}\t{int(m.mtime)}\t{at}\t{name}")
PY
  fi
  mv "$MANIFEST.new" "$MANIFEST"
fi

# --- what is on the server (paths relative to /data)
log "listing the server's files"
"$FLY" ssh console -q -a "$APP" -C "sh -c 'cd /data && find logs worlds/archive -type f ! -name \"*.tmp\" -printf \"%p\t%s\t%T@\n\"'" \
  > "$STAGE/remote.raw" 2> "$STAGE/remote.err" || true
# keep well-formed lines only (path without tabs, numeric size and mtime)
awk -F'\t' 'NF == 3 && $1 ~ /^(logs|worlds\/archive)\// && $2 ~ /^[0-9]+$/ && $3 ~ /^[0-9.]+$/ { split($3, s, "."); print $1 "\t" $2 "\t" s[1] }' \
  "$STAGE/remote.raw" > "$STAGE/remote.tsv"
if [ ! -s "$STAGE/remote.tsv" ]; then
  grep -v -i -e token -e secret "$STAGE/remote.err" >&2 || true
  die "couldn't list the server's files (fly ssh failed?)"
fi
nremote="$(wc -l < "$STAGE/remote.tsv" | tr -d ' ')"

# --- new or changed since the manifest (the last line per path wins)
awk -F'\t' 'NR == FNR { if (FNR > 1) seen[$1] = $2 "\t" $3; next } !(($1) in seen) || seen[$1] != $2 "\t" $3' \
  "$MANIFEST" "$STAGE/remote.tsv" > "$STAGE/want.tsv"
nwant="$(wc -l < "$STAGE/want.tsv" | tr -d ' ')"
if [ "$nwant" -eq 0 ]; then
  log "nothing new or changed ($nremote files on the server, all backed up)"
  exit 0
fi
wantmb="$(awk -F'\t' '{ s += $2 } END { printf "%.1f", s / 1e6 }' "$STAGE/want.tsv")"
log "$nwant of $nremote files are new or changed ($wantmb MB before compression)"
cut -f1 "$STAGE/want.tsv" | sort > "$STAGE/want.paths"

# --- one tar.gz stream; the list goes in on stdin (tar -T -)
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
NAME="ohol-$STAMP.tar.gz"
log "downloading $NAME"
"$FLY" ssh console -q -a "$APP" \
  -C "sh -c 'cd /data && nice -n 19 tar --ignore-failed-read --warning=no-file-changed --warning=no-file-shrank --warning=no-file-removed -czf - --verbatim-files-from -T -'" \
  < "$STAGE/want.paths" > "$STAGE/$NAME" 2> "$STAGE/tar.err" || true
[ -s "$STAGE/$NAME" ] || { grep -v -i -e token -e secret "$STAGE/tar.err" >&2 || true; die "the download is empty"; }

# --- verify: a whole gzip stream, and the tar listing is the expected files
nice -n 10 gzip -t "$STAGE/$NAME" || die "$NAME is not a valid gzip file (download cut short?)"
nice -n 10 tar -tzf "$STAGE/$NAME" | grep -v '/$' | sort > "$STAGE/got.paths" || die "can't list $NAME"
extra="$(comm -13 "$STAGE/want.paths" "$STAGE/got.paths" | wc -l | tr -d ' ')"
missing="$(comm -23 "$STAGE/want.paths" "$STAGE/got.paths" | wc -l | tr -d ' ')"
[ "$extra" -eq 0 ] || die "$NAME has $extra files that weren't asked for"
if [ "$missing" -gt 0 ]; then
  # deleted or renamed on the server between listing and tar: not recorded, retried next time
  log "warning: $missing listed files weren't in the archive (gone meanwhile); they are retried next time:"
  comm -23 "$STAGE/want.paths" "$STAGE/got.paths" | head -20 | sed 's/^/  /'
fi
ngot="$(wc -l < "$STAGE/got.paths" | tr -d ' ')"
[ "$ngot" -gt 0 ] || die "$NAME has no files"

# the part's file list (live = still being written; rotated = final, never changes)
awk -F'\t' 'NR == FNR { got[$1] = 1; next } ($1 in got) {
    kind = ($1 ~ /\.[0-9]{8}T[0-9]{6}Z(-[0-9]+)?\.jsonl$/ || $1 ~ /\.jsonl\.[0-9]+$/ || $1 ~ /^worlds\/archive\//) ? "rotated" : "live"
    print $1 "\t" $2 "\t" $3 "\t" kind
  }' "$STAGE/got.paths" "$STAGE/want.tsv" > "$STAGE/part.tsv"
{ printf 'path\tsize\tmtime\tkind\n'; cat "$STAGE/part.tsv"; } > "$STAGE/ohol-$STAMP.files.tsv"

# --- to Drive (.partial, compared, then renamed), then the manifest
nice -n 10 cp "$STAGE/$NAME" "$DEST/$NAME.partial" || die "copy to Google Drive failed"
cmp -s "$STAGE/$NAME" "$DEST/$NAME.partial" || die "the Drive copy of $NAME differs from the download"
nice -n 10 gzip -t "$DEST/$NAME.partial" || die "the Drive copy of $NAME is not a valid gzip file"
mv "$DEST/$NAME.partial" "$DEST/$NAME"
cp "$STAGE/ohol-$STAMP.files.tsv" "$DEST/ohol-$STAMP.files.tsv"
at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
awk -F'\t' -v at="$at" -v name="$NAME" '{ print $1 "\t" $2 "\t" $3 "\t" at "\t" name }' "$STAGE/part.tsv" >> "$MANIFEST"

size="$(du -h "$DEST/$NAME" | cut -f1 | tr -d ' ')"
nlive="$(awk -F'\t' '$4 == "live"' "$STAGE/part.tsv" | wc -l | tr -d ' ')"
log "done: $NAME ($size, $ngot files: $((ngot - nlive)) rotated/final, $nlive live) in ohol-archive/backups on your Google Drive"
