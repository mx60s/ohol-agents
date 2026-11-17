#!/bin/bash
D=/tmp/ohol-art/repo; O=/tmp/ohol-design-work/sprites; mkdir -p $O
BASE=https://raw.githubusercontent.com/jasonrohrer/OneLifeData7/f053603fa85366c6d560cb5210cdd0ffc5e5a8b7/sprites
ids=$(for o in "$@"; do grep -o '^spriteID=[0-9]*' $D/objects/$o.txt | cut -d= -f2; done | sort -u)
n=0
for s in $ids; do
  [ -f $D/sprites/$s.tga ] && continue
  [ -s $O/$s.tga ] && continue
  curl -sfL -o $O/$s.tga $BASE/$s.tga && n=$((n+1))
done
echo got $n
