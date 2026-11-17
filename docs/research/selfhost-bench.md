# Self-hosting Qwen for the agents (H100 benchmark)

Measured 2026-11-16 on RunPod H100 SXM 80GB (secure cloud, $4.39/h; community H100s were sold out all evening) with vLLM 0.33.0, replaying real agent prompts. **Total GPU spend: $10.74.** All pods were terminated, and RunPod's `myself { pods }` returned `[]` at the end.

## Results

| model | reasoning | conc | ok/n | latency p50 / p90 / p99 (s) | TTFT p50 / p90 (s) | req/s | out tok/s | per-stream tok/s | tokens/reply | GPU util (RunPod, mean) | JSON parse | valid action | truncated |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Qwen3.8-27B-FP8 ¹ | off | 8 | 80/80 | 4.68 / 7.48 / 11.37 | 0.96 / 3.24 | 1.63 | 113 | 24 | 69 | 29% | 100% | 100.0% | 0 |
| Qwen3.8-27B-FP8 ¹ | off | 20 | 120/120 | 10.88 / 18.54 / 23.08 | 2.72 / 8.09 | 1.67 | 115 | 11 | 69 | 100% | 100% | 99.2% | 0 |
| Qwen3.8-27B-FP8 ¹ | think ≤300 | 8 | 80/80 | 10.20 / 12.22 / 15.88 | 0.83 / 2.27 | 0.78 | 281 | 41 | 361 | 100% | 100% | 100.0% | 0 |
| Qwen3.8-27B-FP8 ¹ | think ≤300 | 20 | 120/120 | 17.61 / 22.48 / 28.73 | 1.20 / 6.01 | 1.13 | 408 | 26 | 362 | 100% | 100% | 98.3% | 0 |
| Qwen3-32B-FP8 | off | 8 | 80/80 | 2.52 / 3.10 / 4.83 | 0.40 / 0.72 | 3.11 | 263 | 42 | 84 | 0% ² | 100% | 97.5% ³ | 0 |
| Qwen3-32B-FP8 | off | 20 | 120/120 | **4.03 / 5.77 / 7.52** | 0.50 / 1.66 | **4.71** | 358 | 25 | 76 | 55% | 100% | 98.3% ³ | 0 |
| Qwen3-32B-FP8 | think ≤300 | 8 | 80/80 | 7.05 / 7.58 / 7.98 | 0.49 / 1.01 | 1.12 | 411 | 57 | 366 | 100% | 100% | 100.0% ³ | 0 |
| Qwen3-32B-FP8 | think ≤300 | 20 | 120/120 | 9.91 / 11.13 / 12.75 | 0.61 / 2.16 | 1.95 | 713 | 41 | 366 | 100% | 100% | 97.5% ³ | 0 |

Prompt caching (thinking off, conc 8, n 60). "Off" gives every request a random `cache_salt`, which disables prefix sharing on the same server:

| model | cache | TTFT p50 / p90 (s) | latency p50 (s) | cached / prompt tokens | vLLM prefix hits / queries |
|---|---|---|---|---|---|
| Qwen3.8-27B-FP8 ¹ | on | 1.23 / 4.79 | 5.69 | 24.5% (prompt 3,285 tok) | 48,256 / 197,101 (24.5%) |
| Qwen3.8-27B-FP8 ¹ | off | 1.32 / 3.51 | 5.60 | 0% | 0 / 196,918 |
| Qwen3-32B-FP8 | on | **0.35** / 1.03 | **2.32** | **44.5%** (prompt 3,111 tok) | 83,136 / 186,659 (44.5%) |
| Qwen3-32B-FP8 | off | 0.54 / 1.39 | 3.03 | 0% | 0 / 188,620 |

**How to read the columns.**
- **Latency** is end to end from the laptop through RunPod's HTTPS proxy, so it includes a little network time.
- **req/s** is the throughput of a closed loop with `conc` requests always in flight.
- **valid action** means the agent's own `parseReply` + `checkActions(…, craft, 3)` from `agents/src/agent/reply.ts` accepted the reply.
- **truncated** counts replies that ended with `finish_reason=length`.
- With "think ≤300", replies average about 365 tokens, roughly 300 reasoning plus the JSON. The budget held: no reply hit `max_tokens` 800.

Footnotes:
1. **Qwen3.8 config.** Measured with `VLLM_USE_DEEP_GEMM=0`; see [Serving gotchas](#serving-gotchas-qwen38-on-vllm-033). I started a DeepGEMM-on comparison but stopped it before any data, so whether DeepGEMM recovers the speed is untested.
2. **GPU utilisation** comes from RunPod's `pod.runtime.gpus`, sampled every 2 s. It updates with a lag, so short runs can read 0. Treat it as coarse: 100% means the GPU was busy for the whole run.
3. **Scoring of these runs.** They were scored with a single-action check during the run and re-scored afterwards with `checkActions`, using the stored replies. Those replies were kept only up to 300 characters, so a few long replies that may have had a valid `"actions"` list further on still count as invalid. These rates are therefore lower bounds.

**What the invalid replies were.** The 0–2.5% of failures are model mistakes, not format breakage: a `"say"` placed inside `action`, a reply with only thought/goal/note and no action, or `"actions"` used as an action type. JSON always parsed (100%), since `response_format: json_object` makes vLLM constrain the output to valid JSON.

## Verdict

**One H100 can serve 20 agents at a ~4–6 s cycle only with thinking off, on Qwen3-32B-FP8.** Neither model manages it with mild (~300-token) reasoning, and Qwen3.8 as served here manages neither mode.

- **Qwen3-32B, thinking off: meets the target.** At concurrency 20, the worst case where every agent waits at once:
  - 4.7 decisions/s, against the 3.3–5/s that 20 agents on a 4–6 s cycle need;
  - p50 latency 4.0 s and p90 5.8 s;
  - 98% valid actions.
  - At the realistic 3–8 requests in flight, p50 is 2.5 s and p90 3.1 s.
- **Qwen3-32B, mild reasoning: misses it.** Each decision is about 365 tokens, and one stream decodes at most about 57 tok/s on an H100. That makes a decision take about 7 s even at concurrency 8 (p50 7.05 s), so a 4–6 s cycle is impossible at any load.
  - At concurrency 20 it gives 1.95 decisions/s with a p50 of 9.9 s.
  - Mild reasoning needs about a 10 s cycle on one H100, or 2–3 H100s for an 8 s cycle.
- **Qwen3.8-27B (benchmarks say it's the stronger model): 2.5–4× slower than Qwen3-32B in this setup.**
  - Thinking off at concurrency 20: 1.67 decisions/s, p50 10.9 s.
  - Mild reasoning at concurrency 20: 1.13 decisions/s, p50 17.6 s.
  - Its valid-action rate is as good or better (98–100%).
  - The slowdown is probably serving overhead, not the model. Per-stream decode is 11–24 tok/s with thinking off, below the 26–41 tok/s with thinking on. When thinking is on, the reasoning tokens aren't grammar-constrained. So per-token JSON-grammar masking over Qwen3.8's 248k vocabulary is a likely cost, on top of the non-DeepGEMM FP8 kernels and hybrid-cache bookkeeping.
  - A rerun with DeepGEMM on and `response_format` off (or `structured_outputs` with a lighter grammar backend) is the next thing to try before ruling it out. I started that run but stopped it to finish.
- **Prefix caching works on Qwen3-32B.** 44.5% of prompt tokens hit the cache, which is the shared system prompt, about half of each prompt as predicted. TTFT fell from 0.54 to 0.35 s p50 and latency from 3.0 to 2.3 s p50.
  - On Qwen3.8 it hits only 24.5% and brings no TTFT gain. vLLM uses Mamba "align" cache mode for this hybrid, which can only reuse prefixes at coarse block boundaries.

**Recommendation for the study today:**
- **Setup:** Qwen3-32B-FP8 on vLLM 0.33.0, one H100, prefix caching on, thinking off (`chat_template_kwargs: {"enable_thinking": false}`), agents' JSON mode unchanged.
- **If mild reasoning is a must:** budget 2–3 H100s, or accept a ~10 s cycle.
- **Qwen3.8-27B is not ready to adopt.** It has the better benchmarks and equal-or-better JSON discipline here, but needs the serving fixes below and a speed re-test (DeepGEMM on, grammar backend, MTP speculative decoding).

## Cost per day vs Claude Haiku 5.5 (~$120–135/day for 20 agents)

Prices are RunPod's GPU price sheet on 2026-11-16, for one H100 running 24 hours.

| setup | GPUs | community cloud ($2.69/h SXM, $1.99/h PCIe) | secure cloud ($4.39/h SXM, what I got) |
|---|---|---|---|
| Qwen3-32B, thinking off, 4–6 s cycle | 1 | **$48–65/day** | **$105/day** |
| Qwen3-32B, mild reasoning, ~8 s cycle | 2–3 | $96–194/day | $211–316/day |
| Qwen3-32B, mild reasoning, ~10 s cycle | 1 | $48–65/day | $105/day |

- **Thinking off:** self-hosting costs **about half of Haiku** on community cloud and is still a bit cheaper on secure cloud.
- **Mild reasoning at the same cycle:** it costs as much as Haiku or more.
- **Availability:** community H100 stock was empty for the whole session (two hours of retries), so plan around secure-cloud prices or a reserved instance.
- **Fixed cost:** self-hosted cost is per hour, not per token. It doesn't grow with reasoning length or call rate, but it bills idle hours unless the pod is stopped between runs.

## Serving gotchas (Qwen3.8 on vLLM 0.33)

Getting Qwen3.8-27B-FP8 to start took most of the session. The official image crash-loops silently, so I could only read the errors by running vLLM from a shell-entrypoint image (`nvidia/cuda:13.0.2-devel-ubuntu24.04` plus `pip install vllm==0.33.0`, with logs served over HTTP):

1. **`max_num_seqs` must be lowered.** vLLM aborts with `ValueError: max_num_seqs (1024) exceeds available Mamba cache blocks (750). Each decode sequence requires one Mamba cache block, so CUDA graph capture cannot proceed.`
   - The fix is `--max-num-seqs 64`.
   - The hybrid model keeps a fixed-size linear-attention state per sequence, and the default of 1,024 sequences doesn't fit next to the KV cache on 80 GB.
   - The official image crash-looped on this. The recipe's `vllm/vllm-openai:qwen38` image crash-looped too, apparently for the same reason.
2. **DeepGEMM.** The FP8 block-scale path JIT-compiles DeepGEMM kernels at load time and needs a CUDA toolkit. All Qwen3.8 numbers above use `VLLM_USE_DEEP_GEMM=0`, which selects `CutlassFp8BlockScaledMMKernel`. The DeepGEMM-on run (`--max-num-seqs 64` alone) was stopped before any data, so whether DeepGEMM was ever a problem on the official image, or would recover the speed, is unknown.
3. **Prefix caching.** vLLM turns it on by default for this model, in Mamba "align" mode.
4. **No CUDA toolkit on bare Python images.** Plain `python:3.12` images can't run vLLM 0.33. FlashInfer JIT-compiles its sampler and needs `nvcc`.
5. **Thinking budget works.** `--reasoning-config.reasoning_start_str <think> --reasoning-config.reasoning_end_str </think>` passed through RunPod `dockerArgs` without quoting problems on both models, and per-request `thinking_token_budget: 300` held: about 300 reasoning tokens, no truncation.

Qwen3-32B-FP8 started cleanly on the stock image with the plain flags.

## Models

Candidates from the Qwen org on Hugging Face (`/api/models?author=Qwen&sort=createdAt`):

| model | params | FP8 weights | fits 1× H100 80GB? | notes |
|---|---|---|---|---|
| [Qwen3.8-27B-FP8](https://huggingface.co/Qwen/Qwen3.8-27B-FP8) (Aug 2026) | 27B dense, hybrid Gated DeltaNet + gated attention (3:1), MTP head | ~31 GB | yes | pick (a) |
| [Qwen3.6-35B-A3B-FP8](https://huggingface.co/Qwen/Qwen3.6-35B-A3B-FP8) (Apr 2026) | 35B MoE, 3B active | ~36 GB | yes | faster per token, weaker on agent/IF benchmarks; same hybrid architecture family |
| [Qwen3.6-27B-FP8](https://huggingface.co/Qwen/Qwen3.6-27B-FP8) (Apr 2026) | 27B dense hybrid | ~28 GB | yes | superseded by 3.8-27B |
| [Qwen3.8-Flash-Next-FP8](https://huggingface.co/Qwen/Qwen3.8-Flash-Next-FP8) (Aug 2026) | 180B total | ~180 GB | no | out |
| [Qwen3-32B-FP8](https://huggingface.co/Qwen/Qwen3-32B-FP8) (2025) | 32.8B dense, full attention | ~34 GB | yes | baseline (b) |

**Why Qwen3.8-27B was pick (a).** Its model card compares it with Qwen3.6-27B, which already beats Qwen3.6-35B-A3B on every row both cards share:

| benchmark (model cards) | Qwen3.8-27B | Qwen3.6-27B | Qwen3.6-35B-A3B |
|---|---|---|---|
| IFBench (instruction following) | **79.5** | 69.1 | — |
| CoWorkBench (long-horizon agent) | **70.7** | 61.0 | — |
| Terminal-Bench (agentic) | 73.0 (TB 2.1) | 59.3 (TB 2.0) | 51.5 (TB 2.0) |
| GPQA Diamond | 89.2 | 87.8 | 86.0 |
| SWE-bench Pro / Verified | 61.7 (Pro) | 77.2 (Verified) | 73.4 (Verified) |

Instruction following and agent work matter most for agents that must emit a strict JSON action every turn. In this benchmark, Qwen3.8 did reach 98–100% valid actions against Qwen3-32B's 97.5–100%.

## Method

**Load.** The prompts are those `agents/src/tools/bench-endpoint.ts` builds (`promptsFromLogs`): the current system prompt plus logged observations from `logs-dev/dev1-r1-mwjtcz8f-…/llm.jsonl` and `logs/showcase1-r1-mvvlsrb7-…/llm.jsonl`.
- 2,770 prompts, shuffled with a fixed seed.
- Every run takes a disjoint slice, so no run gets full-prompt cache hits from an earlier one.
- Prompts average about 3,100–3,300 tokens. About 1.2k of those are the shared system prompt.

**Driver.** The driver ([Appendix A](#appendix-a-benchmark-driver)) is a closed loop: `conc` requests are always in flight. Each request matches the agents' own:
- `temperature: 0.8`, `response_format: {"type":"json_object"}`, streaming.
- Thinking off: `chat_template_kwargs: {"enable_thinking": false}` and `max_tokens: 2000`.
- Mild reasoning: `enable_thinking: true`, `thinking_token_budget: 300` and `max_tokens: 800`, the same as the agents' `LLM_REASONING_MAX_TOKENS` / `LLM_DECISION_MAX_TOKENS`.
- A 10-request warm-up runs first on each server.

**Serving flags.**
- Both models: `--max-model-len 16384 --gpu-memory-utilization 0.92 --enable-prefix-caching --enable-prompt-tokens-details --reasoning-parser qwen3 --reasoning-config.reasoning_start_str <think> --reasoning-config.reasoning_end_str </think>`, with `--api-key` set.
- Qwen3.8 additionally: `--max-num-seqs 64` and the env var `VLLM_USE_DEEP_GEMM=0`.

## Spend log

| item | pods | cost |
|---|---|---|
| Qwen3-32B run (one pod, ~16 min) | 1 | ~$1.20 |
| Qwen3.8 crash-loops: official image, `qwen38` image, flag variants, NGC (image pull never finished), Python base, CUDA-devel base | 11 | ~$7.30 |
| Qwen3.8 working run (~12 min) plus the stopped DeepGEMM-on comparison (~6 min) | 3 | ~$2.20 |
| **total** (balance $149.97 → $139.23) | 15 | **$10.74** |

A 120-minute watchdog was armed for the whole session. Every pod was terminated explicitly, and the final API check returned an empty pod list.

## Steering readiness

- **[EasySteer](https://github.com/ZJU-REAL/EasySteer)** (ZJU-REAL, Apache-2.0, last push 2026-11-16) is maintained.
  - It is a vLLM fork (`vllm.steer_vectors`) with continuous batching, CUDA graphs and prefix-cache-compatible steering.
  - Its [OpenAI-compatible server](https://zju-real.github.io/EasySteer/latest/user-guide/openai-server/) supports per-request and server-level steering vectors.
  - Paper: [arXiv 2509.25175](https://arxiv.org/abs/2509.25175), EMNLP 2026 demos.
- **Caveats:**
  - It tracks **vLLM v0.29.0**, four releases behind what was used here.
  - Hooking Qwen3.8's hybrid layers is untested, and given the gotchas above it would be risky.
  - **Qwen3-32B is the safe case:** a plain transformer, and the model that performed best here.
- **Upstream vLLM** has no built-in per-request steering.

## Reproduction

The laptop only sends HTTP; everything heavy runs on the pod. Secrets stay in files: the RunPod key comes from `~/.config/persona-neurons/keys.env` and the vLLM key from `vllm.key`. Run the commands from **bash**: zsh doesn't word-split `$L`.

```bash
W=~/selfhost-bench; mkdir -p $W && cd $W        # put rp.py (Appendix B) and bench.mts (Appendix A) here
umask 077; python3 -c 'import secrets;print(secrets.token_urlsafe(24))' > vllm.key
rp() { ( set -a; . ~/.config/persona-neurons/keys.env; set +a; python3 $W/rp.py "$@" ); }
rp balance                                       # must be positive

COMMON="--served-model-name m --api-key $(cat vllm.key) --host 0.0.0.0 --port 8000 --max-model-len 16384 \
 --gpu-memory-utilization 0.92 --enable-prefix-caching --enable-prompt-tokens-details --reasoning-parser qwen3 \
 --reasoning-config.reasoning_start_str <think> --reasoning-config.reasoning_end_str </think>"

# 1. Hard watchdog first.
( sleep 7200; rp terminate-all ) > watchdog.log 2>&1 &

# 2. One pod per model (image vllm/vllm-openai:v0.33.0 by default; falls back to SECURE if COMMUNITY is sold out).
MINMEM=60 MINCPU=8 rp create selfhost-qwen3 "NVIDIA H100 80GB HBM3" SECURE "--model Qwen/Qwen3-32B-FP8 $COMMON"
MINMEM=60 MINCPU=8 EXTRAENV="VLLM_USE_DEEP_GEMM=0" rp create selfhost-qwen38 "NVIDIA H100 80GB HBM3" SECURE \
  "--model Qwen/Qwen3.8-27B-FP8 $COMMON --max-num-seqs 64"

# 3. Wait for /health (~10-12 min: image pull + ~31-34 GB download + load). If it never answers, the container
#    is crash-looping: terminate it. RunPod exposes no logs for these images.
POD=<podId>; until curl -sf -A "Mozilla/5.0" https://$POD-8000.proxy.runpod.net/health; do sleep 20; done

# 4. Runs (from agents/), disjoint --offset per run.
cd /Users/mvonebers/ohol-stream/agents
L="logs-dev/dev1-r1-mwjtcz8f-2026-11-16T22-06-56-607Z/llm.jsonl logs/showcase1-r1-mvvlsrb7-2026-10-30T23-28-47-683Z/llm.jsonl"
b() { name=$1; shift; ( set -a; . ~/.config/persona-neurons/keys.env; set +a
      npx tsx $W/bench.mts --url https://$POD-8000.proxy.runpod.net --key "$(cat $W/vllm.key)" --model m --pod $POD \
        "$@" --out $W/$POD-$name.json $L ); }
b warm       --n 10  --concurrency 2  --mode off                --offset 2700
b off-c8     --n 80  --concurrency 8  --mode off                --offset 0
b off-c20    --n 120 --concurrency 20 --mode off                --offset 100
b think-c8   --n 80  --concurrency 8  --mode think --budget 300 --offset 300
b think-c20  --n 120 --concurrency 20 --mode think --budget 300 --offset 400
b nocache-c8 --n 60  --concurrency 8  --mode off --salt 1       --offset 600
b cache-c8   --n 60  --concurrency 8  --mode off                --offset 700

# 5. Always: terminate and verify.
rp terminate-all          # terminates every pod in pods.txt and on the account; prints "remaining: []"
rp list                   # must be []
```

## Appendix A: benchmark driver

Save as `bench.mts`, outside the repo. It imports the agents' own prompt builder and reply checker by absolute path.

```ts
// vLLM benchmark driver for the self-host study. Same prompts as
// agents/src/tools/bench-endpoint.ts (system prompt + logged observations), but
// sends vLLM-native thinking controls, checks each reply with the agent's own
// parser (parseReply + checkAction), samples GPU util from the RunPod API and
// diffs vLLM /metrics around the run.
//
//   npx tsx bench.ts --url https://<pod>-8000.proxy.runpod.net --key K --model m \
//     --n 120 --concurrency 20 --mode off|think [--budget 300] [--max-tokens 800] \
//     [--salt 0|1] [--offset 0] [--pod <podId>] --out result.json <llm.jsonl>...
import { writeFileSync } from "node:fs";
import { promptsFromLogs } from "/Users/mvonebers/ohol-stream/agents/src/tools/bench-endpoint.ts";
import { parseReply, checkActions } from "/Users/mvonebers/ohol-stream/agents/src/agent/reply.ts";
import { percentile } from "/Users/mvonebers/ohol-stream/agents/src/calibration.ts";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) bench/1.0";
const argv = process.argv.slice(2);
const opt: Record<string, string> = {};
const files: string[] = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith("--")) opt[argv[i].slice(2)] = argv[++i];
  else files.push(argv[i]);
}
const base = opt.url.replace(/\/+$/, "");
const n = Number(opt.n ?? 60), conc = Number(opt.concurrency ?? 8), offset = Number(opt.offset ?? 0);
const think = opt.mode === "think";
const maxTokens = Number(opt["max-tokens"] ?? (think ? 800 : 2000));
const budget = opt.budget ? Number(opt.budget) : null;
const salt = opt.salt === "1";
const json = opt.json !== "0";

// deterministic shuffle so runs take disjoint slices (no cross-run full-prompt cache hits)
function rng(seed: number) { return () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff); }
const all = promptsFromLogs(files);
const r = rng(42);
for (let i = all.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [all[i], all[j]] = [all[j], all[i]]; }
const prompts = Array.from({ length: n }, (_, i) => all[(offset + i) % all.length]);

async function metrics(): Promise<Record<string, number>> {
  try {
    const t = await (await fetch(`${base}/metrics`, { headers: { "user-agent": UA } })).text();
    const out: Record<string, number> = {};
    for (const line of t.split("\n")) {
      const m = line.match(/^(vllm:(?:prefix_cache_\w+|num_preemptions\w*|prompt_tokens_total|generation_tokens_total|spec_decode_\w+))(?:\{[^}]*\})?\s+([0-9.eE+-]+)$/);
      if (m) out[m[1]] = (out[m[1]] ?? 0) + Number(m[2]);
    }
    return out;
  } catch { return {}; }
}

const gpu: number[] = [], gmem: number[] = [];
let sampling = true;
async function sampleGpu() {
  const key = process.env.RUNPOD_API_KEY;
  if (!opt.pod || !key) return;
  while (sampling) {
    try {
      const res = await fetch("https://api.runpod.io/graphql", {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}`, "user-agent": UA },
        body: JSON.stringify({ query: `{ pod(input:{podId:"${opt.pod}"}) { runtime { gpus { gpuUtilPercent memoryUtilPercent } } } }` }),
      });
      const g = (await res.json())?.data?.pod?.runtime?.gpus?.[0];
      if (g) { gpu.push(g.gpuUtilPercent); gmem.push(g.memoryUtilPercent); }
    } catch {}
    await new Promise((s) => setTimeout(s, 2000));
  }
}

interface Call { ok: boolean; status: number; latencyMs: number; ttftMs: number | null; ttfcMs: number | null; promptTokens: number; completionTokens: number; cachedTokens: number; reasoningChars: number; finish: string | null; parseOk: boolean; actionOk: boolean; why?: string; content?: string }

async function one(messages: any[]): Promise<Call> {
  const t0 = Date.now();
  const body: any = {
    model: opt.model, messages, max_tokens: maxTokens, temperature: 0.8, stream: true, stream_options: { include_usage: true },
    chat_template_kwargs: { enable_thinking: think },
    ...(json ? { response_format: { type: "json_object" } } : {}),
    ...(think && budget ? { thinking_token_budget: budget } : {}),
    ...(salt ? { cache_salt: Math.random().toString(36).slice(2) } : {}),
  };
  const fail = (status: number, why: string): Call => ({ ok: false, status, latencyMs: Date.now() - t0, ttftMs: null, ttfcMs: null, promptTokens: 0, completionTokens: 0, cachedTokens: 0, reasoningChars: 0, finish: null, parseOk: false, actionOk: false, why });
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 180_000);
  try {
    const res = await fetch(`${base}/v1/chat/completions`, { method: "POST", signal: ctl.signal, headers: { "content-type": "application/json", authorization: `Bearer ${opt.key}`, "user-agent": UA }, body: JSON.stringify(body) });
    if (!res.ok) return fail(res.status, (await res.text()).slice(0, 300));
    let content = "", reasoning = "", buf = "", ttft: number | null = null, ttfc: number | null = null, finish: string | null = null, usage: any = {};
    const dec = new TextDecoder();
    for await (const chunk of res.body as any as AsyncIterable<Uint8Array>) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line.startsWith("data:")) continue;
        const d = line.slice(5).trim();
        if (!d || d === "[DONE]") continue;
        let c: any; try { c = JSON.parse(d); } catch { continue; }
        if (c.usage) usage = c.usage;
        const ch = c.choices?.[0]; if (!ch) continue;
        const rs = ch.delta?.reasoning ?? ch.delta?.reasoning_content;
        if (typeof rs === "string" && rs) { reasoning += rs; ttft ??= Date.now() - t0; }
        if (typeof ch.delta?.content === "string" && ch.delta.content) { content += ch.delta.content; ttft ??= Date.now() - t0; ttfc ??= Date.now() - t0; }
        if (ch.finish_reason) finish = ch.finish_reason;
      }
    }
    const p = parseReply(content);
    let actionOk = false, why: string | undefined;
    if (p.ok) { const a = checkActions(p.value, true, 3); actionOk = "steps" in a; if (!actionOk) why = (a as any).error; } else why = p.reason;
    return { ok: true, status: 200, latencyMs: Date.now() - t0, ttftMs: ttft, ttfcMs: ttfc, promptTokens: usage.prompt_tokens ?? 0, completionTokens: usage.completion_tokens ?? 0, cachedTokens: usage.prompt_tokens_details?.cached_tokens ?? 0, reasoningChars: reasoning.length, finish, parseOk: p.ok, actionOk, why: why?.slice(0, 160), content };
  } catch (e: any) {
    return fail(0, e?.name === "AbortError" ? "timeout" : String(e?.message ?? e));
  } finally { clearTimeout(timer); }
}

const m0 = await metrics();
const gp = sampleGpu();
const calls: Call[] = [];
let next = 0;
const t0 = Date.now();
await Promise.all(Array.from({ length: Math.min(conc, n) }, async () => { while (next < n) { const i = next++; calls.push(await one(prompts[i])); } }));
const wall = Date.now() - t0;
sampling = false; await gp;
const m1 = await metrics();
const ok = calls.filter((c) => c.ok);
const pct = (xs: number[]) => ({ p50: percentile(xs, 50), p90: percentile(xs, 90), p99: percentile(xs, 99) });
const mean = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
const dm: Record<string, number> = {};
for (const k of Object.keys(m1)) dm[k] = Math.round((m1[k] - (m0[k] ?? 0)) * 100) / 100;
const report = {
  label: opt.label ?? null, model: opt.model, mode: think ? `think(budget ${budget ?? "-"}, max ${maxTokens})` : `off(max ${maxTokens})`, n, concurrency: conc, salt, json,
  ok: ok.length, errors: calls.filter((c) => !c.ok).map((c) => `${c.status}:${c.why?.slice(0, 80)}`).slice(0, 5), errorCount: calls.length - ok.length,
  wallS: wall / 1000, reqPerS: Math.round((ok.length / (wall / 1000)) * 100) / 100,
  outTokPerS: Math.round(ok.reduce((a, c) => a + c.completionTokens, 0) / (wall / 1000)),
  latencyMs: pct(ok.map((c) => c.latencyMs)), ttftMs: pct(ok.map((c) => c.ttftMs!).filter((x) => x != null)), ttfcMs: pct(ok.map((c) => c.ttfcMs!).filter((x) => x != null)),
  promptTokMean: mean(ok.map((c) => c.promptTokens)), completionTokMean: mean(ok.map((c) => c.completionTokens)), reasoningCharsMean: mean(ok.map((c) => c.reasoningChars)),
  perStreamTokPerS: mean(ok.filter((c) => c.ttftMs != null && c.latencyMs > c.ttftMs!).map((c) => c.completionTokens / ((c.latencyMs - c.ttftMs!) / 1000))),
  cachedFrac: Math.round((ok.reduce((a, c) => a + c.cachedTokens, 0) / Math.max(1, ok.reduce((a, c) => a + c.promptTokens, 0))) * 1000) / 1000,
  finishLength: ok.filter((c) => c.finish === "length").length,
  jsonParseRate: Math.round((ok.filter((c) => c.parseOk).length / Math.max(1, ok.length)) * 1000) / 1000,
  validActionRate: Math.round((ok.filter((c) => c.actionOk).length / Math.max(1, ok.length)) * 1000) / 1000,
  invalidExamples: ok.filter((c) => !c.actionOk).slice(0, 3).map((c) => ({ why: c.why, finish: c.finish, content: c.content?.slice(0, 300) })),
  gpuUtil: { mean: mean(gpu), max: gpu.length ? Math.max(...gpu) : null, samples: gpu.length }, gpuMemPct: gmem.length ? Math.max(...gmem) : null,
  vllmMetricsDelta: dm,
};
console.log(JSON.stringify(report, null, 1));
if (opt.out) writeFileSync(opt.out, JSON.stringify({ report, calls }, null, 1));
```

## Appendix B: RunPod helper

Save as `rp.py`. It reads `RUNPOD_API_KEY` from the environment, never prints it, and logs created pod IDs to `pods.txt`. Optional environment variables: `IMAGE`, `DISK`, `MINCPU`, `MINMEM`, `PORTS`, `EXTRAENV` (`K=V,K2=V2`), and `KEYENV=1`, which passes `vllm.key` as `VLLM_API_KEY`.

```python
"""Minimal RunPod GraphQL helper. RUNPOD_API_KEY from env (never printed).
  rp.py balance | list | status <id> | terminate <id> | terminate-all
  rp.py create <name> <gpuTypeId> <COMMUNITY|SECURE> <dockerArgs>
Every created pod id is appended to pods.txt next to this file."""
import json, os, sys, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
KEY = os.environ["RUNPOD_API_KEY"]


def gql(query, variables=None):
    req = urllib.request.Request("https://api.runpod.io/graphql", method="POST",
                                 data=json.dumps({"query": query, "variables": variables or {}}).encode(),
                                 headers={"content-type": "application/json", "authorization": f"Bearer {KEY}", "user-agent": "curl/8.4.0"})
    try:
        return json.load(urllib.request.urlopen(req, timeout=60))
    except urllib.error.HTTPError as e:
        return {"errors": [{"message": f"HTTP {e.code}: {e.read()[:300]!r}"}]}


cmd = sys.argv[1]
if cmd == "balance":
    print(json.dumps(gql("{ myself { clientBalance currentSpendPerHr } }")))
elif cmd == "list":
    print(json.dumps(gql("{ myself { pods { id name desiredStatus costPerHr lastStatusChange runtime { uptimeInSeconds } } } }")["data"]["myself"]["pods"], indent=1))
elif cmd == "status":
    print(json.dumps(gql('query($id:String!){ pod(input:{podId:$id}) { id name desiredStatus costPerHr lastStatusChange machine { gpuDisplayName location } runtime { uptimeInSeconds gpus { gpuUtilPercent memoryUtilPercent } container { cpuPercent memoryPercent } } } }', {"id": sys.argv[2]})))
elif cmd == "create":
    name, gpu, cloud, args = sys.argv[2:6]
    inp = {"cloudType": cloud, "gpuCount": 1, "gpuTypeId": gpu, "name": name, "imageName": os.environ.get("IMAGE", "vllm/vllm-openai:v0.33.0"),
           "containerDiskInGb": int(os.environ.get("DISK", "120")), "volumeInGb": 0, "ports": os.environ.get("PORTS", "8000/http"), "dockerArgs": args,
           "minVcpuCount": int(os.environ.get("MINCPU", "2")), "minMemoryInGb": int(os.environ.get("MINMEM", "15")), "startSsh": False, "startJupyter": False,
           "env": [{"key": "VLLM_LOGGING_LEVEL", "value": "INFO"}] + ([{"key": "VLLM_API_KEY", "value": open(os.path.join(HERE, "vllm.key")).read().strip()}] if os.environ.get("KEYENV") else []) + [{"key": kv.split("=",1)[0], "value": kv.split("=",1)[1]} for kv in os.environ.get("EXTRAENV","").split(",") if "=" in kv]}
    r = gql("mutation($input: PodFindAndDeployOnDemandInput!){ podFindAndDeployOnDemand(input:$input){ id costPerHr machine { gpuDisplayName location } } }", {"input": inp})
    p = (r.get("data") or {}).get("podFindAndDeployOnDemand")
    if p and p.get("id"):
        with open(os.path.join(HERE, "pods.txt"), "a") as f:
            f.write(p["id"] + "\n")
    print(json.dumps(r))
elif cmd == "terminate":
    print(json.dumps(gql('mutation($id:String!){ podTerminate(input:{podId:$id}) }', {"id": sys.argv[2]})))
elif cmd == "terminate-all":
    ids = set()
    if os.path.exists(os.path.join(HERE, "pods.txt")):
        ids |= {l.strip() for l in open(os.path.join(HERE, "pods.txt")) if l.strip()}
    ids |= {p["id"] for p in gql("{ myself { pods { id } } }")["data"]["myself"]["pods"]}
    for i in sorted(ids):
        print(i, json.dumps(gql('mutation($id:String!){ podTerminate(input:{podId:$id}) }', {"id": i})))
    print("remaining:", json.dumps(gql("{ myself { pods { id desiredStatus } } }")["data"]["myself"]["pods"]))
```
