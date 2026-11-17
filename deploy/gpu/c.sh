#!/bin/bash
# Talk to the pod control server (ctl.py, port 8001). Token: ~/.config/artificial-selection/gpu_ctl_token.
#   c.sh <pod> status | log [name] [n] | sh "<cmd>" [timeout] | run <name> "<cmd>" | bg <name> "<cmd>" | stop
P=$1; shift; U="https://$P-8001.proxy.runpod.net"; T=$(cat ~/.config/artificial-selection/gpu_ctl_token)
H=(-s -m 300 -A "Mozilla/5.0" -H "x-token: $T" -H "content-type: application/json")
case $1 in
  status) curl "${H[@]}" "$U/status";;
  log) curl "${H[@]}" "$U/log?name=${2:-}&n=${3:-60}";;
  stop) curl "${H[@]}" -X POST "$U/stop";;
  sh) curl "${H[@]}" -X POST "$U/sh" -d "$(python3 -c 'import json,sys;print(json.dumps({"cmd":sys.argv[1],"timeout":float(sys.argv[2])}))' "$2" "${3:-120}")" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d["out"]);print("rc",d["rc"])';;
  run|bg) curl "${H[@]}" -X POST "$U/$1" -d "$(python3 -c 'import json,sys;print(json.dumps({"name":sys.argv[1],"cmd":sys.argv[2]}))' "$2" "$3")";;
esac
echo
