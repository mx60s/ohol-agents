#!/usr/bin/env bash
# Fetch, patch, and build the stock OHOL server plus our dumpGameData tool.
#
# Usage: server/build.sh [build_dir]     (default: .ohol-build at repo root)
#
# Works on Linux (Docker/Railway) and macOS (local dev). Needs git, g++, make.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
BUILD="${1:-$HERE/../.ohol-build}"
mkdir -p "$BUILD"
BUILD="$(cd "$BUILD" && pwd)"

# Pinned upstream refs. Same combo the official install script picks:
# code from the OneLife_liveServer tag, latest tagged minorGems and data.
ONELIFE_REF="${ONELIFE_REF:-OneLife_liveServer}"
MINORGEMS_REF="${MINORGEMS_REF:-OneLife_v438}"
DATA_REF="${DATA_REF:-OneLife_v437}"
SERVER_CODE_VERSION="${SERVER_CODE_VERSION:-438}"

case "$(uname -s)" in
  Darwin) PLATFORM=2 ;;
  *) PLATFORM=1 ;;
esac
JOBS="$( (nproc || sysctl -n hw.ncpu) 2>/dev/null || echo 4)"

cd "$BUILD"

fetch() { # name ref [sparse dirs...]
  local name="$1" ref="$2"; shift 2
  if [ ! -d "$name/.git" ]; then
    if [ "$#" -gt 0 ]; then
      git clone -q --depth 1 --branch "$ref" --filter=blob:none --sparse \
        "https://github.com/jasonrohrer/$name.git" "$name"
      git -C "$name" sparse-checkout set "$@"
    else
      git clone -q --depth 1 --branch "$ref" "https://github.com/jasonrohrer/$name.git" "$name"
    fi
  fi
}

echo "== fetching sources"
fetch minorGems "$MINORGEMS_REF"
fetch OneLife "$ONELIFE_REF"
fetch OneLifeData7 "$DATA_REF" objects transitions categories tutorialMaps contentSettings

echo "== applying patches"
git -C OneLife checkout -q -- .
for p in "$HERE"/patches/*.patch; do
  git -C OneLife apply "$p"
  echo "applied $(basename "$p")"
done

echo "== building server"
cd "$BUILD/OneLife/server"
cp "$HERE/tools/mtsDumpGameData.h" ./mtsDumpGameData.h
./configure "$PLATFORM" > /dev/null
make -j"$JOBS" > /dev/null 2>&1 || make  # rerun serially to show errors
echo "$SERVER_CODE_VERSION" > serverCodeVersionNumber.txt

echo "== linking game data"
for d in objects transitions categories tutorialMaps contentSettings \
         dataVersionNumber.txt isAHAP.txt; do
  ln -sfn "../../OneLifeData7/$d" "$d"
done

echo "== dumping game data (objects + transitions JSON)"
# run in a scratch dir so the server's startup logs don't land in the build
SCRATCH="$BUILD/dump-scratch"
rm -rf "$SCRATCH" && mkdir -p "$SCRATCH"
for d in objects transitions categories tutorialMaps contentSettings \
         dataVersionNumber.txt isAHAP.txt settings; do
  ln -sfn "$BUILD/OneLife/server/$d" "$SCRATCH/$d"
done
(cd "$SCRATCH" && OHOL_DUMP_GAME_DATA="$BUILD/game-data.json" \
  "$BUILD/OneLife/server/OneLifeServer" > dump.log 2>&1) || {
  tail -20 "$SCRATCH/dump.log"; exit 1; }
echo "wrote $BUILD/game-data.json ($(wc -c < "$BUILD/game-data.json") bytes)"

echo "done: $BUILD/OneLife/server/OneLifeServer"
