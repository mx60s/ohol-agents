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

# TIME_SCALE=k (same var the agents read): game clock runs k x slower, see
# server/patches/time-scale.patch. OHOL_SETTING_timeScale wins if both set.
if [ -n "${TIME_SCALE:-}" ]; then
  printf '%s' "$TIME_SCALE" > settings/timeScale.ini
  echo "setting override: timeScale=$TIME_SCALE (TIME_SCALE)"
fi

# TURN_CLOCK=1 (same var the agents read): game clock runs only up to the
# target in mtsClockTarget.txt, see server/patches/turn-clock.patch and
# docs/turn-clock.md. Default off. OHOL_SETTING_mtsTurnClock wins if both set.
if [ -n "${TURN_CLOCK:-}" ]; then
  printf '%s' "$TURN_CLOCK" > settings/mtsTurnClock.ini
  echo "setting override: mtsTurnClock=$TURN_CLOCK (TURN_CLOCK)"
fi

# Env overrides: OHOL_SETTING_<name>=<value> writes settings/<name>.ini
# e.g. OHOL_SETTING_maxPlayers=80
while IFS='=' read -r key value; do
  name="${key#OHOL_SETTING_}"
  printf '%s' "$value" > "settings/$name.ini"
  echo "setting override: $name=$value"
done < <(env | grep '^OHOL_SETTING_' || true)

# The turn clock persists its game time in mtsClockGame.txt. With the turn
# clock off the server doesn't update that file, so set it aside: switching
# back on then starts from the normal game clock instead of jumping back.
tc="$(tr -d '[:space:]' < settings/mtsTurnClock.ini 2>/dev/null || true)"
if [ "${tc:-0}" = 0 ] && [ -f mtsClockGame.txt ]; then
  mv -f mtsClockGame.txt mtsClockGame.txt.off
  echo "turn clock off: moved mtsClockGame.txt to mtsClockGame.txt.off"
fi

if [ -n "${PORT_OVERRIDE:-}" ]; then
  printf '%s' "$PORT_OVERRIDE" > settings/port.ini
fi

echo "starting OneLifeServer in $RUN on port $(cat settings/port.ini)"
exec "$SRC/OneLifeServer"
