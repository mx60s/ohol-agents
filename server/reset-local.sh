#!/usr/bin/env bash
# Local dev only: stop the server, wipe the world, start fresh in background.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
pkill -f OneLifeServer || true
sleep 1
rm -rf "$HERE/../.ohol-run"
nohup "$HERE/run.sh" > /tmp/ohol-server.log 2>&1 &
for i in $(seq 1 60); do
  if lsof -iTCP:8005 -sTCP:LISTEN >/dev/null 2>&1; then echo "server up"; exit 0; fi
  sleep 1
done
echo "server did not start; see /tmp/ohol-server.log"; exit 1
