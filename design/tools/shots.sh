#!/bin/bash
# usage: shots.sh [page ...]   (default: all)
D=/Users/mvonebers/ohol-stream/.claude/worktrees/agent-af2d2a6743df29ea3/design
O=/tmp/ohol-design-shots
mkdir -p $O
cd /tmp/ohol-design-work
pages=${@:-stream site-home site-agent site-study}
for p in $pages; do
  if [ "$p" = stream ]; then
    npx -y playwright screenshot --viewport-size=1920,1080 --wait-for-timeout=1500 "file://$D/stream.html" $O/stream-1920x1080.png >/dev/null 2>&1
    python3 -I -c "from PIL import Image; Image.open('$O/stream-1920x1080.png').resize((1280,720), Image.LANCZOS).save('$O/stream-720p.png')"
  else
    npx -y playwright screenshot --full-page --viewport-size=1920,1080 --wait-for-timeout=1500 "file://$D/$p.html" $O/$p-1920.png >/dev/null 2>&1
    npx -y playwright screenshot --full-page --viewport-size=1366,768 --wait-for-timeout=1500 "file://$D/$p.html" $O/$p-1366.png >/dev/null 2>&1
  fi
  echo done $p
done
