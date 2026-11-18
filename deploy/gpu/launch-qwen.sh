#!/bin/bash
# Launch the agents' self-hosted model on RunPod, configs from docs/research/selfhost-optimize.md, on the
# image and vLLM install that study used: Qwen3.8-27B-FP8 + MTP (default) or Qwen3-32B-FP8 + EAGLE-3 (MODEL=q3).
# The pod runs ctl.py on :8001 (token-protected control: status, logs, restart); vLLM serves :8000.
# Endpoint: https://<podId>-8000.proxy.runpod.net/v1, model id "m", key ~/.config/artificial-selection/vllm_key.
#   MODEL=q3 GPUS=2 GPU=... CLOUD=SECURE deploy/gpu/launch-qwen.sh [name]      -> prints the pod id, then waits for ready
#   deploy/gpu/launch-qwen.sh --serve <podId>                    -> (re)start vLLM on an existing pod
set -euo pipefail
W=$(cd "$(dirname "$0")" && pwd)
set -a; . ~/.config/persona-neurons/keys.env; set +a
# MODEL=q38 (default): Qwen3.8-27B-FP8 + MTP. MODEL=q3: Qwen3-32B-FP8 + the thinking-trained EAGLE-3 head.
# GPUS=N: one model replica per GPU behind the same endpoint (vLLM data parallel), for more agents.
MODEL=${MODEL:-q38}; NG=${GPUS:-1}
# SPLIT=tp: one model split across the GPUs (tensor parallel: each reply is faster); default: one replica per GPU (more agents)
if [ "${SPLIT:-dp}" = tp ]; then PAR="--tensor-parallel-size $NG"; else PAR="--data-parallel-size $NG"; fi
if [ "$MODEL" = q3 ]; then
  MODEL_ARGS='Qwen/Qwen3-32B-FP8 --speculative-config "{\"method\":\"eagle3\",\"model\":\"RedHatAI/Qwen3-32B-Thinking-speculator.eagle3\",\"num_speculative_tokens\":3}"'
else
  MODEL_ARGS='Qwen/Qwen3.8-27B-FP8 --language-model-only --max-num-seqs 64 --speculative-config "{\"method\":\"mtp\",\"num_speculative_tokens\":3}"'
fi
SERVE='export HF_XET_HIGH_PERFORMANCE=1
[ -x /opt/vv/bin/vllm ] || { (command -v uv || pip install -q uv) && uv venv /opt/vv --python 3.12 -q && uv pip install -p /opt/vv/bin/python -q vllm==0.34.0; }
while true; do
  /opt/vv/bin/vllm serve '"$MODEL_ARGS"' '"$PAR"' --served-model-name m --host 0.0.0.0 --port 8000 \
    --max-model-len 16384 --gpu-memory-utilization 0.92 --enable-prefix-caching --enable-prompt-tokens-details \
    --reasoning-parser qwen3 --reasoning-config.reasoning_start_str "<think>" --reasoning-config.reasoning_end_str "</think>"
  echo "vllm exited $?; restarting in 10 s"; sleep 10
done'
if [ "${1:-}" = "--serve" ]; then "$W/c.sh" "$2" run qwen "$SERVE"; exit; fi
BOOT="bash -c 'mkdir -p /logs; echo \$CTL_SRC | base64 -d > /ctl.py; exec python3 /ctl.py'"
OUT=$(CTL=1 KEYENV=1 CTL_TOKEN_FILE=~/.config/artificial-selection/gpu_ctl_token VLLM_KEY_FILE=~/.config/artificial-selection/vllm_key \
  GPUS=$NG IMAGE=lmsysorg/sglang:v0.5.23-cu130 DISK=200 MINMEM=${MINMEM:-16} MINCPU=${MINCPU:-4} PORTS="8000/http,8001/http" \
  python3 "$W/rp.py" create "${1:-as-qwen}" "${GPU:-NVIDIA H200}" "${CLOUD:-COMMUNITY}" "$BOOT")
echo "$OUT"
POD=$(echo "$OUT" | python3 -c "import json,sys;print(json.load(sys.stdin)['data']['podFindAndDeployOnDemand']['id'])")
until [ "$(curl -s -m 8 -A Mozilla/5.0 "https://$POD-8001.proxy.runpod.net/health")" = ok ]; do sleep 15; done
echo "control up on $POD $(date +%T)"
"$W/c.sh" "$POD" run qwen "$SERVE"
K=$(cat ~/.config/artificial-selection/vllm_key)
until [ "$(curl -s -o /dev/null -w '%{http_code}' -m 10 -A Mozilla/5.0 -H "Authorization: Bearer $K" "https://$POD-8000.proxy.runpod.net/v1/models")" = 200 ]; do sleep 20; done
echo "vLLM ready on $POD $(date +%T): https://$POD-8000.proxy.runpod.net/v1"
