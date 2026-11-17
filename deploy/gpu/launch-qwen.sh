#!/bin/bash
# Launch the agents' self-hosted model on RunPod: Qwen3.8-27B-FP8 + MTP (k=3) on one H200,
# the config recommended in docs/research/selfhost-optimize.md. Prints the pod JSON.
# Endpoint: https://<podId>-8000.proxy.runpod.net/v1, model id "m", key in ~/.config/artificial-selection/vllm_key.
#   GPU=... CLOUD=SECURE deploy/gpu/launch-qwen.sh [name]
set -euo pipefail
W=$(cd "$(dirname "$0")" && pwd)
set -a; . ~/.config/persona-neurons/keys.env; set +a
ARGS="--model Qwen/Qwen3.8-27B-FP8 --served-model-name m --host 0.0.0.0 --port 8000 \
--max-model-len 16384 --gpu-memory-utilization 0.92 --enable-prefix-caching --enable-prompt-tokens-details \
--reasoning-parser qwen3 --reasoning-config.reasoning_start_str '<think>' --reasoning-config.reasoning_end_str '</think>' \
--language-model-only --max-num-seqs 64 --speculative-config.method mtp --speculative-config.num_speculative_tokens 3"
KEYENV=1 VLLM_KEY_FILE=~/.config/artificial-selection/vllm_key IMAGE=vllm/vllm-openai:v0.34.0 DISK=150 MINMEM=48 MINCPU=8 PORTS=8000/http \
  python3 "$W/rp.py" create "${1:-as-qwen}" "${GPU:-NVIDIA H200}" "${CLOUD:-COMMUNITY}" "$ARGS"
