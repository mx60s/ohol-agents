#!/usr/bin/env bash
# Run the OHOL server out of a persistent run dir (world .db files and logs
# land there).
#
# Usage: server/run.sh [build_dir] [run_dir]
#   defaults: .ohol-build and .ohol-run at repo root
#
# Every start: links all build artifacts into the run dir, copies the stock
# settings, then overlays our overrides from server/settings/.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
BUILD="$(cd "${1:-$HERE/../.ohol-build}" && pwd)"
RUN="${2:-$HERE/../.ohol-run}"
mkdir -p "$RUN"
RUN="$(cd "$RUN" && pwd)"
SRC="$BUILD/OneLife/server"

cd "$RUN"

for f in "$SRC"/*; do
  name="$(basename "$f")"
  [ "$name" = "settings" ] && continue
  # never clobber something the server created in the run dir
  if [ -e "$name" ] && [ ! -L "$name" ]; then continue; fi
  ln -sfn "$f" "$name"
done

rm -rf settings
cp -R "$SRC/settings" settings
for f in "$HERE"/settings/*.ini; do
  cp "$f" settings/
done

# Env overrides: OHOL_SETTING_<name>=<value> writes settings/<name>.ini
# e.g. OHOL_SETTING_maxPlayers=80
while IFS='=' read -r key value; do
  name="${key#OHOL_SETTING_}"
  printf '%s' "$value" > "settings/$name.ini"
  echo "setting override: $name=$value"
done < <(env | grep '^OHOL_SETTING_' || true)

if [ -n "${PORT_OVERRIDE:-}" ]; then
  printf '%s' "$PORT_OVERRIDE" > settings/port.ini
fi

echo "starting OneLifeServer in $RUN on port $(cat settings/port.ini)"
exec "$SRC/OneLifeServer"
