# Self-hosting with mild reasoning: making it fast and cheap

Measured 2026-11-16/17 on RunPod (H100 SXM, H100 NVL, H200, B200, B300) with vLLM 0.34.0 (released 2026-11-16) and SGLang 0.5.23. The load is real agent prompts replayed from `agents/logs*/…/llm.jsonl`. Every configuration keeps **mild reasoning: thinking on, `thinking_token_budget` 300** (one row uses 400). It follows [selfhost-bench.md](selfhost-bench.md), which found Qwen3-32B-FP8 at p50 9.9 s with 20 in flight on one H100, and Qwen3.8-27B 2.5–4× slower.

**GPU spend: $25.10** of the $40 cap (balance $139.15 → $114.04). Every pod was terminated, and RunPod's `myself { pods }` returned `[]` at the end ([Spend log](#spend-log)).

## Summary

**Mild reasoning for 20 agents at an ~8 s cycle fits on one GPU.** That is the target the previous study priced at 2–3 H100s. Four changes did it; none of them shortens the reasoning:

1. **Speculative decoding: the biggest lever, about 1.7× lower latency.**
   - Qwen3-32B with the `RedHatAI/Qwen3-32B-Thinking-speculator.eagle3` draft head. That head was trained on thinking traces and accepts 2.2 tokens per step on our prompts.
   - Qwen3.8-27B with its built-in MTP head, which accepts 2.6 tokens per step.
   - Spec decoding is lossless: the valid-action rate was 97.7% with it and 97.9% without, over 3,740 Qwen3-32B replies.
2. **Serving Qwen3.8 correctly.** With `--language-model-only` (drops the vision tower), DeepGEMM left on, vLLM 0.34 and MTP, Qwen3.8-27B is now *faster* than Qwen3-32B on the same H100 or H200 (p50 4.8 vs 5.5 s and 4.0 vs 4.6 s), where before it was 2.5–4× slower. On B200 FP8 the two are about equal. It also has the best valid-action rate (99–100%).
3. **Hardware.**
   - Decode is memory-bandwidth-bound, so an H200 ($3.59/h community) beats an H100 per dollar for this load.
   - A B200 with NVFP4 weights runs the same 20 agents at a ~5 s cycle with p90 ≈ 2 s.
4. **Pick the right draft.** The two other Qwen3-32B EAGLE-3 heads, a Qwen3-0.6B draft model and n-gram lookup were all worse; AngelSlim's head accepted only 1.55 tokens per step. INT4 (AWQ/W4A16) was *slower* than FP8 at this batch size on H100.

Headline numbers, 20 agents in the agent loop (closed loop with the real action-time distribution, [Method](#method)), mild reasoning (≤300 thinking tokens):

| setup | p50 / p90 latency | natural cycle | decisions/s | valid | $/day (community / secure) |
|---|---|---|---|---|---|
| before: Qwen3-32B-FP8, H100 SXM, no spec decode | 9.0 / 9.9 s | 12.6 s | 1.59 | 99.0% | $65 / $105 |
| **Qwen3.8-27B-FP8 + MTP, H100 SXM** | **4.8 / 5.7 s** | **8.2 s** | 2.43 | **100%** | **$65 / $105** |
| **Qwen3.8-27B-FP8 + MTP, H200** | **4.0 / 4.9 s** | **7.4 s** | 2.72 | 99.0% | **$86 / $127** |
| Qwen3-32B-FP8 + EAGLE-3, H100 SXM | 5.5 / 6.3 s | 9.0 s | 2.21 | 95.5% ¹ | $65 / $105 |
| Qwen3-32B-FP8 + EAGLE-3, H200 | 4.6 / 5.6 s | 8.1 s | 2.46 | 97.5% | $86 / $127 |
| Qwen3.8-27B-NVFP4 + MTP, B200 | 1.7 / 2.1 s | 4.9 s | 4.05 | 99.0% | $144 / $192 |
| Qwen3-32B-NVFP4 + EAGLE-3, B200 | 1.9 / 2.2 s | 5.2 s | 3.87 | 97.0% | $144 / $192 |
| upgrade: Qwen3.8-Flash-Next-FP8 (125B MoE, 6B active) + MTP, B300 | 3.8 / 4.4 s | 7.2 s | 2.78 | 98.0% | $167 / $216 |

¹ Within noise. Pooled over all runs, the rate is 97.7% with spec decoding and 97.9% without. See [Quality](#quality-valid-actions-and-reasoning).

"Natural cycle" is LLM latency plus the agent's action time (mean ≈ 3.1 s). The harness enforces an 8 s floor (`DECISION_CYCLE_MS`), so any setup with a natural cycle ≤ 8 s runs at exactly 8 s, i.e. 2.5 decisions/s for 20 agents.

## Recommendations

**Qwen3-32B, mild reasoning (baseline):**
- **Setup:** one H200, FP8 weights, vLLM 0.34, EAGLE-3 with `RedHatAI/Qwen3-32B-Thinking-speculator.eagle3` (k=3), JSON mode on, prefix caching on.
- **Result:** p90 5.6 s at 20 agents and an 8.1 s natural cycle, so it holds the 8 s floor.
- **Cost:** $86/day community, $127 secure.
- **On one H100 SXM** ($65/$105) the same stack gives p90 6.3 s and a 9 s cycle: fine for a 9–10 s cycle, marginal for 8 s.

**Qwen3.8-27B, mild reasoning (stretch goal): no longer blocked, and the better pick.**
- **Setup:** FP8, vLLM 0.34, `--language-model-only --max-num-seqs 64`, MTP k=3, JSON mode on.
- **One H100 SXM:** p90 5.7 s and an 8.2 s natural cycle with 100% valid actions, at $65/$105/day.
- **One H200:** p90 4.9 s and a 7.4 s cycle, at $86/$127/day. It also carried 28 agents at p90 5.8 s and 3.6 decisions/s, which leaves headroom for narrator/director calls or more agents.

For a 5–6 s cycle, use a B200 with NVFP4 weights for either model, at $144/day community or $192 secure. That gives about 4 decisions/s with p90 ≈ 2 s.

**Against Claude Haiku 5.5 (~$120–135/day for 20 agents):**
- One H100 or H200 running Qwen3.8-27B with mild reasoning costs **$65–86/day community** (about half of Haiku) or **$105–127/day secure** (at parity or a little below).
- Self-hosted cost is flat per hour: reasoning length, call rate, narrator calls and extra agents up to the measured headroom add nothing.
- The previous study's estimate for mild reasoning was $96–316/day on 2–3 H100s.

## Results

All rows below use thinking on with a 300-token budget (`thinking_token_budget` on vLLM), `temperature 0.8`, `response_format: json_object` (unless noted), streaming, and `max_tokens 800`. Requests go from the laptop through RunPod's HTTPS proxy.

**Load column:**
- **"20 agents"** is the agent loop: 20 workers. Each sends a decision, waits for the reply, then sleeps for an action time sampled from the empirical distribution (mean 3.1 s, p50 1.3 s, p90 ≈ 10 s), then repeats. This puts about 12–16 requests in flight, like the real harness.
- **"closed cN"** keeps N requests always in flight, the same as the previous study's concurrency runs. It gives worst-case latency and capacity.

**Other columns:**
- **decisions/s:** in the agent loop, steady state, 20 / mean cycle; in closed loop, the throughput.
- **cycle:** mean start-to-start time per agent.
- **accept len:** mean tokens committed per decoding step (1 + accepted/drafts) from vLLM's spec-decode metrics.
- **$/1k decisions:** the community hourly price divided by measured decisions per hour.
- **$/day:** one GPU for 24 h on RunPod community / secure.

| model | quant | engine | spec decode | think budget | GPU | load | latency p50 / p90 / p99 (s) | decisions/s | cycle (s) | accept len | tok/reply | valid action | $/1k decisions (community) | $/day 1 GPU (community / secure) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Qwen3-32B | FP8 | vLLM 0.34 | none | ≤300 | H100 SXM | 20 agents | 9.01 / 9.85 / 10.29 | 1.59 | 12.57 | - | 367 | 99.0% | $0.47 | $65 / $105 |
| Qwen3-32B | FP8 | vLLM 0.34 | EAGLE-3 (RedHat Thinking) k3 | ≤300 | H100 SXM | 20 agents | 5.48 / 6.34 / 7.58 | 2.21 | 9.04 | 2.21 | 366 | 95.5% | $0.34 | $65 / $105 |
| Qwen3-32B | FP8 | vLLM 0.34 | EAGLE-3 (RedHat Thinking) k3 | ≤300 | H200 | 20 agents | 4.61 / 5.57 / 6.21 | 2.46 | 8.14 | 2.21 | 366 | 97.5% | $0.41 | $86 / $127 |
| Qwen3-32B | FP8 | vLLM 0.34 | EAGLE-3 (RedHat Thinking) k3 | ≤300 | B200 | 20 agents | 2.64 / 3.00 / 3.29 | 3.32 | 6.02 | 2.24 | 366 | 96.5% | $0.50 | $144 / $192 |
| Qwen3.8-27B | FP8 | vLLM 0.34 | MTP k3 | ≤300 | H100 SXM | 20 agents | 4.84 / 5.70 / 6.43 | 2.43 | 8.23 | 2.59 | 360 | 100.0% | $0.31 | $65 / $105 |
| Qwen3.8-27B | FP8 | vLLM 0.34 | MTP k3 | ≤300 | H200 | 20 agents | 3.98 / 4.89 / 5.78 | 2.72 | 7.35 | 2.58 | 361 | 99.0% | $0.37 | $86 / $127 |
| Qwen3.8-27B | FP8 | vLLM 0.34 | MTP k3 | ≤300 | B200 | 20 agents | 2.89 / 3.62 / 4.20 | 3.22 | 6.22 | 2.67 | 362 | 100.0% | $0.52 | $144 / $192 |
| Qwen3.8-Flash-Next (125B, 6B active) | FP8 | vLLM 0.34 | MTP k3 | ≤300 | B300 | 20 agents | 3.76 / 4.43 / 5.00 | 2.78 | 7.19 | 2.18 | 380 | 98.0% | $0.69 | $167 / $216 |
| Qwen3-32B | FP8 | vLLM 0.34 | none | ≤300 | H100 SXM | closed c8 | 7.54 / 8.45 / 8.97 | 1.01 | - | - | 369 | 97.9% | $0.74 | - |
| Qwen3-32B | FP8 | vLLM 0.34 | EAGLE-3 (RedHat Thinking) k3 | ≤300 | H100 SXM | closed c8 | 4.57 / 5.63 / 6.55 | 1.64 | - | 2.21 | 366 | 97.9% | $0.46 | - |
| Qwen3-32B | FP8 | vLLM 0.34 | EAGLE-3 (RedHat Thinking) k3 | ≤300 | H200 | closed c8 | 4.03 / 4.42 / 5.22 | 1.87 | - | 2.22 | 371 | 97.9% | $0.53 | - |
| Qwen3-32B | FP8 | vLLM 0.34 | EAGLE-3 (RedHat Thinking) k3 | ≤300 | B200 | closed c8 | 2.49 / 2.77 / 3.25 | 3.13 | - | 2.2 | 368 | 100.0% | $0.53 | - |
| Qwen3.8-27B | FP8 | vLLM 0.34 | MTP k3 | ≤300 | H100 SXM | closed c8 | 4.13 / 4.86 / 6.07 | 1.84 | - | 2.6 | 357 | 95.8% | $0.41 | - |
| Qwen3.8-27B | FP8 | vLLM 0.34 | MTP k3 | ≤300 | H200 | closed c8 | 3.41 / 4.11 / 4.64 | 2.3 | - | 2.62 | 349 | 95.8% | $0.43 | - |
| Qwen3.8-27B | FP8 | vLLM 0.34 | MTP k3 | ≤300 | B200 | closed c8 | 2.71 / 3.09 / 3.49 | 2.86 | - | 2.59 | 376 | 100.0% | $0.58 | - |
| Qwen3.8-Flash-Next (125B, 6B active) | FP8 | vLLM 0.34 | MTP k3 | ≤300 | B300 | closed c8 | 3.20 / 3.67 / 3.95 | 2.41 | - | 2.19 | 385 | 97.9% | $0.80 | - |
| Qwen3-32B | FP8 | vLLM 0.34 | none | ≤300 | H100 SXM | closed c20 | 10.29 / 11.55 / 13.12 | 1.91 | - | - | 366 | 98.0% | $0.39 | - |
| Qwen3-32B | FP8 | vLLM 0.34 | EAGLE-3 (RedHat Thinking) k3 | ≤300 | H200 | closed c20 | 6.65 / 7.85 / 9.69 | 2.91 | - | 2.2 | 373 | 99.0% | $0.34 | - |
| Qwen3-32B | FP8 | vLLM 0.34 | EAGLE-3 (RedHat Thinking) k3 | ≤300 | B200 | closed c20 | 3.59 / 4.48 / 5.48 | 4.98 | - | 2.23 | 374 | 99.0% | $0.33 | - |
| Qwen3.8-27B | FP8 | vLLM 0.34 | MTP k3 | ≤300 | H200 | closed c20 | 4.42 / 5.12 / 5.89 | 4.43 | - | 2.58 | 365 | 99.0% | $0.23 | - |
| Qwen3-32B | FP8 | vLLM 0.34 | EAGLE-3 (RedHat generic) k3 | ≤300 | H100 SXM | 20 agents | 5.84 / 6.84 / 8.13 | 2.12 | 9.42 | 2.06 | 372 | 98.0% | $0.35 | $65 / $105 |
| Qwen3-32B | FP8 | vLLM 0.34 | EAGLE-3 (RedHat Thinking) k5 | ≤300 | H100 SXM | 20 agents | 5.89 / 6.99 / 7.66 | 2.1 | 9.53 | 2.36 | 373 | 98.0% | $0.36 | $65 / $105 |
| Qwen3-32B | FP8 | vLLM 0.34 | EAGLE-3 (RedHat Thinking) k2 | ≤300 | H100 SXM | 20 agents | 6.02 / 6.88 / 7.62 | 2.1 | 9.54 | 2 | 366 | 97.5% | $0.36 | $65 / $105 |
| Qwen3-32B | FP8 | vLLM 0.34 | draft Qwen3-0.6B k4 | ≤300 | H100 SXM | 20 agents | 7.33 / 8.29 / 9.16 | 1.84 | 10.87 | 2.41 | 366 | 98.5% | $0.41 | $65 / $105 |
| Qwen3-32B | FP8 | vLLM 0.34 | ngram k4 | ≤300 | H100 SXM | 20 agents | 8.97 / 10.09 / 10.99 | 1.59 | 12.57 | 1.18 | 371 | 98.5% | $0.47 | $65 / $105 |
| Qwen3-32B | AWQ W4A16 | vLLM 0.34 | none | ≤300 | H100 SXM | 20 agents | 9.44 / 10.54 / 11.47 | 1.53 | 13.06 | - | 377 | 98.5% | $0.49 | $65 / $105 |
| Qwen3-32B | AWQ W4A16 | vLLM 0.34 | EAGLE-3 (RedHat Thinking) k3 | ≤300 | H100 SXM | 20 agents | 6.55 / 7.79 / 8.76 | 1.98 | 10.08 | 2.19 | 374 | 98.5% | $0.38 | $65 / $105 |
| Qwen3-32B | AWQ W4A16 | vLLM 0.34 | EAGLE-3 (RedHat Thinking) k3 | ≤300 | H100 SXM | closed c8 | 5.03 / 5.97 / 6.82 | 1.51 | - | 2.16 | 371 | 100.0% | $0.49 | - |
| Qwen3-32B | FP8 + FP8 KV | vLLM 0.34 | EAGLE-3 (RedHat Thinking) k3 | ≤300 | H100 SXM | 20 agents | 5.59 / 6.54 / 7.17 | 2.19 | 9.14 | 2.21 | 369 | 99.5% | $0.34 | $65 / $105 |
| Qwen3-32B | FP8 | vLLM 0.34, no JSON grammar | EAGLE-3 k2 | ≤300 | H100 SXM | 20 agents | 6.00 / 6.83 / 11.54 | 2.06 | 9.7 | 2.02 | 384 | 95.5% | $0.36 | $65 / $105 |
| Qwen3-32B | FP8 | vLLM 0.34, "think briefly" prompt | EAGLE-3 k2 | ≤300 | H100 SXM | 20 agents | 6.06 / 6.87 / 7.69 | 2.09 | 9.56 | 1.99 | 370 | 96.5% | $0.36 | $65 / $105 |
| Qwen3-32B | FP8 | vLLM 0.34, "think briefly" prompt | EAGLE-3 k2 | ≤400 | H100 SXM | 20 agents | 7.24 / 8.08 / 9.06 | 1.85 | 10.79 | 2.02 | 467 | 100.0% | $0.40 | $65 / $105 |
| Qwen3-32B | FP8 | vLLM 0.34 | none | ≤300 | H200 | 20 agents | 7.57 / 8.42 / 9.19 | 1.8 | 11.1 | - | 368 | 96.0% | $0.55 | $86 / $127 |
| Qwen3-32B | NVFP4 | vLLM 0.34 | EAGLE-3 (RedHat Thinking) k3 | ≤300 | B200 | 20 agents | 1.85 / 2.17 / 2.42 | 3.87 | 5.17 | 2.17 | 373 | 97.0% | $0.43 | $144 / $192 |
| Qwen3.8-27B | NVFP4 | vLLM 0.34 | MTP k3 | ≤300 | B200 | 20 agents | 1.71 / 2.05 / 2.31 | 4.05 | 4.94 | 2.57 | 369 | 99.0% | $0.41 | $144 / $192 |
| Qwen3-32B | FP8 | vLLM 0.34 | EAGLE-3 (AngelSlim) k3 | ≤300 | B200 | 20 agents | 3.62 / 4.09 / 4.57 | 2.82 | 7.1 | 1.55 | 368 | 98.0% | $0.59 | $144 / $192 |
| Qwen3.8-27B | FP8 | vLLM 0.34 | MTP k3 | ≤300 | H200 | 28 agents | 4.75 / 5.78 / 6.62 | 3.57 | 7.85 | 2.61 | 355 | 98.4% | $0.28 | - |
| Qwen3.8-Flash-Next (125B, 6B active) | FP8 | vLLM 0.34 | MTP k3 | ≤300 | B300 | 28 agents | 4.74 / 6.01 / 7.07 | 3.44 | 8.13 | 2.16 | 380 | 98.8% | $0.56 | - |
| Qwen3.8-27B | FP8 | vLLM 0.34 | none | ≤300 | H100 NVL | 20 agents | 10.90 / 12.78 / 14.19 | 1.41 | 14.15 | - | 356 | 100.0% | $0.51 | $62 / $77 |
| Qwen3.8-27B | FP8 | vLLM 0.34 | MTP k3 | ≤300 | H100 NVL | 20 agents | 8.34 / 10.14 / 12.17 | 1.72 | 11.65 | 2.6 | 359 | 99.5% | $0.42 | $62 / $77 |
| Qwen3.8-27B | FP8 | vLLM 0.34 | MTP k3 | ≤300 | H100 NVL | closed c8 | 5.96 / 6.87 / 8.63 | 1.35 | - | 2.59 | 359 | 100.0% | $0.53 | - |
| Qwen3.8-27B | FP8 | vLLM 0.34, no JSON grammar | MTP k3 | ≤300 | H100 NVL | 20 agents | 8.28 / 10.29 / 12.61 | 1.71 | 11.66 | 2.64 | 355 | 98.5% | $0.42 | $62 / $77 |
| Qwen3.8-27B | INT4 W4A16 (RedHat) | vLLM 0.34 | MTP k3 | ≤300 | H100 NVL | 20 agents | 9.00 / 10.74 / 12.07 | 1.6 | 12.49 | 2.54 | 358 | 98.0% | $0.45 | $62 / $77 |
| Qwen3.8-27B | INT4 W4A16 (RedHat) | vLLM 0.34 | MTP k3 | ≤300 | H100 NVL | closed c8 | 5.89 / 7.19 / 7.91 | 1.33 | - | 2.54 | 359 | 100.0% | $0.54 | - |
| Qwen3.8-27B | FP8 | vLLM 0.34 | DSpark k7 (RedHat) | ≤300 | H100 NVL | 20 agents | 7.81 / 9.93 / 11.59 | 1.79 | 11.2 | 3.05 | 357 | 98.5% | $0.40 | $62 / $77 |

SGLang rows aren't in the table, because neither comparison is valid ([Engine](#3-engine-vllm-034-vs-sglang-0523)).

Notes on hardware:
- **The H100 NVL rows came from one pod that ran ~1.7× slower than an H100 SXM** on the identical Qwen3.8 MTP config (p50 8.3 vs 4.8 s). An NVL has more memory bandwidth than an SXM, so this is most likely that host (the NVL's 400 W cap or throttling). The cause wasn't isolated.
  - Use the NVL rows only to compare configs with each other (base vs MTP vs no-JSON vs INT4 vs DSpark), not against other GPUs.
- **The H100 SXM pod was in India** (RunPod picked it). The laptop→proxy round trip is about 0.6 s per new connection, so H100 SXM latencies carry roughly 0.2–0.4 s more network time than the US/EU pods. The baseline still reproduced the previous study: c8 p50 7.5 s vs 7.05 s, c20 10.3 vs 9.9 s.

## What each lever did

### 1. Speculative decoding (the big win)

Qwen3-32B-FP8 on H100 SXM, 20 agents:

| draft | accept len | p50 / p90 (s) | vs. no spec |
|---|---|---|---|
| none | — | 9.01 / 9.85 | — |
| **EAGLE-3 `RedHatAI/Qwen3-32B-Thinking-speculator.eagle3`, k=3** | **2.21** | **5.48 / 6.34** | **−39%** |
| EAGLE-3 same head, k=2 / k=5 | 2.00 / 2.36 | 6.02 / 6.88, 5.89 / 6.99 | −33% / −35% |
| EAGLE-3 `RedHatAI/Qwen3-32B-speculator.eagle3` (generic), k=3 | 2.06 | 5.84 / 6.84 | −35% |
| EAGLE-3 `AngelSlim/Qwen3-32B_eagle3`, k=3 (on B200) | 1.55 | 3.62 / 4.09 vs 2.64 / 3.00 with the RedHat thinking head | 37% slower than RedHat |
| draft model `Qwen/Qwen3-0.6B`, k=4 | 2.41 | 7.33 / 8.29 | −19% |
| n-gram prompt lookup, k=4 | 1.18 | 8.97 / 10.09 | 0% |

**Findings on the drafts:**
- The thinking-trained EAGLE-3 head is the best, because most output tokens are reasoning.
- k=3 is the sweet spot. k=5 accepts more but wastes verify compute at ~15 in flight.
- The 0.6B draft model accepts about as many tokens as EAGLE-3, but running 28 draft layers serially costs too much.
- N-gram lookup is useless: reasoning doesn't copy the prompt.
- On B200 the gain holds: FP8 p50 2.64 s with EAGLE-3. B200 without spec decoding wasn't measured. H200 without spec decoding was 7.57 s, and with it 4.61 s.

**Qwen3.8-27B MTP (built into the checkpoint):**
- Accepts 2.6 tokens per step on every GPU.
- On the H100 NVL pod, MTP cut p50 from 10.9 to 8.3 s at 20 agents.
- The `RedHatAI/Qwen3.8-27B-speculator.dspark` draft (k=7) accepted 3.05 tokens per step and was a bit faster still on the same pod (p50 7.8 s). It is worth a retest on a healthy GPU, but MTP needs no extra download and is the safe default.

**Valid actions are unaffected.** Spec decoding is lossless (rejection sampling against the target). Pooled valid-action rates: Qwen3-32B 97.9% without (n=748) and 97.7% with (n=2,992); Qwen3.8 100% without (n=200) and 98.9% with (n=2,192).

### 2. Quantisation

| config (20 agents) | GPU | p50 / p90 (s) | notes |
|---|---|---|---|
| Qwen3-32B FP8 + EAGLE-3 | H100 SXM | 5.48 / 6.34 | reference |
| Qwen3-32B AWQ W4A16 (`Qwen/Qwen3-32B-AWQ`) + EAGLE-3 | H100 SXM | 6.55 / 7.79 | 20% slower |
| Qwen3-32B AWQ W4A16, no spec | H100 SXM | 9.44 / 10.54 | slower than FP8 (9.01) |
| Qwen3-32B FP8 + FP8 KV cache + EAGLE-3 | H100 SXM | 5.59 / 6.54 | no change; KV isn't the bottleneck at 20 agents |
| Qwen3.8 INT4 W4A16 (`RedHatAI/Qwen3.8-27B-INT4`) + MTP | H100 NVL | 9.00 / 10.74 | 8% slower than FP8 on the same pod (8.34) |
| Qwen3-32B NVFP4 (`nvidia/Qwen3-32B-NVFP4`) + EAGLE-3 | B200 | 1.85 / 2.17 | **30% faster than FP8 on B200 (2.64)** |
| Qwen3.8 NVFP4 (`nvidia/Qwen3.8-27B-NVFP4`) + MTP | B200 | 1.71 / 2.05 | **41% faster than FP8 on B200 (2.89)** |

**What this means for each GPU:**
- **On Hopper, keep FP8.** W4A16 halves the weight bytes, but the Marlin dequant path costs more than it saves once ~15 sequences × 4 speculative tokens are verified per step.
- **On Blackwell, NVFP4 (W4A4 with native FP4 tensor cores) is a clear win.**
- **Output quality held** in every quantised config: 97–100% valid actions, the same as FP8. A read of 20 replies found no coherence difference, though this reading can't detect subtle capability loss; the NVFP4 model cards report near-parity on standard benchmarks.

### 3. Engine: vLLM 0.34 vs SGLang 0.5.23

- **vLLM 0.34 vs 0.33:** on the same Qwen3-32B-FP8 config the numbers matched the previous study (c8 p50 7.5 vs 7.05 s, c20 10.3 vs 9.9 s; the gap is the India network). The version itself changes little. What fixed Qwen3.8 was the flags, below.
- **SGLang wasn't usable for this workload on 0.5.23**, for three reasons:
  1. **The 300-token thinking budget isn't enforced on Qwen3.8.**
     - The chat API accepts `custom_params.thinking_budget`, but it only acts when the reasoner token filter is enabled.
     - The built-in `Qwen3ThinkingBudgetLogitProcessor` hardcodes Qwen3's `<think>`/`</think>` token ids, which are wrong for Qwen3.8's 248k vocabulary.
     - So replies ran to `max_tokens` (723 tokens, 18% valid) and latency isn't comparable.
     - The decode engine itself was on par: Qwen3.8 FP8 + MTP (`EAGLE 3/1/4`) accepted 2.6 tokens per step at 57 tok/s per stream with 20 agents, against vLLM's 53 on the same pod.
  2. **SGLang can't load the RedHat `speculators`-format EAGLE-3 heads.** It needs a `model_type` in config.json.
  3. **With `AngelSlim/Qwen3-32B_eagle3` on B200**, CUDA-graph capture crashed (`Missing TRTLLM-GEN kernel (decode) … headDimQk=80`).
- **Verdict: stay on vLLM.** It also has the steering fork (EasySteer is vLLM-based).
- **Tuning knobs:** CUDA graphs and chunked prefill were on (vLLM defaults). `--max-num-seqs 64` is still required for Qwen3.8 on 80 GB. FP8 KV did nothing. `--gpu-memory-utilization 0.92` was used throughout. A full scheduling sweep wasn't worth the budget: at 12–16 sequences in flight the GPU is decode-bandwidth-bound, not scheduler-bound.

### 4. Structured output: JSON grammar vs plain generation

| config (20 agents) | p50 / p90 / p99 (s) | valid | truncated |
|---|---|---|---|
| Qwen3-32B + EAGLE-3 k2, `json_object` | 6.02 / 6.88 / 7.62 | 97.5% | 0 |
| same, **no** `response_format` (tolerant `parseReply`) | 6.00 / 6.83 / 11.54 | 95.5% | 9 |
| Qwen3.8 + MTP (H100 NVL), `json_object` | 8.34 / 10.14 / 12.17 | 99.5% | 0 |
| same, **no** `response_format` | 8.28 / 10.29 / 12.61 | 98.5% | 0 |

- **The grammar costs nothing measurable on vLLM 0.34** (xgrammar backend) for either model, including Qwen3.8's 248k vocabulary.
- **Turning it off hurts:** more invalid replies and runaway outputs.
- **The previous Qwen3.8 slowness wasn't the grammar.** It was the serving setup:
  - no `--language-model-only`, so vLLM reserved memory for the vision encoder and fewer Mamba/KV blocks were left;
  - `VLLM_USE_DEEP_GEMM=0`;
  - no MTP.
- With those fixed it is the faster model. Keep `json_object`.

### 5. Reasoning efficiency, without giving up reasoning

- **The 300-token budget clips nearly every Qwen3-32B thought.** Median reasoning is about 1,120 characters ≈ 300 tokens; the 10th percentile is about 1,040.
- **The cut causes failures.** About 1.1% of Qwen3-32B replies are an empty `{}`: forced out of thinking mid-sentence, the model closes the JSON at once.
- **Qwen3.8 ends its thoughts naturally more often** (10th percentile about 735 characters) and almost never emits `{}` (0.1%). Its reasoning is terser and more telegraphic, and reads as goal-directed.
- **"Think briefly" in the system prompt didn't shorten Qwen3-32B's thinking at all** (same length, same latency).
- **Raising the budget to 400** (with the brief-thinking prompt) removed the `{}` failures (100% valid, 0/200) at +1.2 s p50, about 470 tokens per reply. That buys *more* reasoning, and the headroom on H200 and B200 pays for it.
- **Budgets of 150/200 were deliberately not run**, per the decision not to trade reasoning away.

**Side note, adaptive reasoning (not recommended, measured offline only):**
- A rule close to `salience.ts` (new nearby speech, own name, a baby's F, a food band, carrier change, death) would mark about **38% of turns** salient; urgent events alone mark about 11%.
- Thinking only on those turns would cut mean output from ~365 to ~185 tokens per decision, roughly halving decode load.
- It isn't needed: the setups above already meet the 8 s cycle with reasoning on every turn.
- The bench driver has `--adaptive 1` if anyone wants to measure it.

### 6. Hardware

Same stack per model (Qwen3-32B FP8 + EAGLE-3 / Qwen3.8 FP8 + MTP), 20 agents, latencies in seconds:

| GPU (HBM bandwidth) | $/h community / secure | Qwen3-32B p50 / p90 | Qwen3.8 p50 / p90 | Qwen3.8 natural cycle | $/1k decisions (Qwen3.8, community) |
|---|---|---|---|---|---|
| H100 SXM 80 GB (3.35 TB/s) | 2.69 / 4.39 | 5.48 / 6.34 | 4.84 / 5.70 | 8.2 s | $0.31 |
| H200 141 GB (4.8 TB/s) | 3.59 / 5.29 | 4.61 / 5.57 | 3.98 / 4.89 | 7.4 s | $0.37 |
| B200 180 GB (8 TB/s), FP8 | 5.98 / 7.99 | 2.64 / 3.00 | 2.89 / 3.62 | 6.2 s | $0.52 |
| B200, NVFP4 | 5.98 / 7.99 | 1.85 / 2.17 | 1.71 / 2.05 | 4.9 s | $0.41 |

- **Capacity per GPU**, taking the closed-loop c20 throughput as the ceiling:
  - H100 + Qwen3.8 at 20 agents: about 2.4 decisions/s at p90 < 6 s.
  - H200 + Qwen3.8: 4.4 decisions/s closed loop at p90 5.1 s; 28 agents ran at 3.6/s with p90 5.8 s.
  - B200 + Qwen3-32B FP8: 5.0 decisions/s closed loop at p90 4.5 s.
- **$/decision at a fixed 8 s cycle:** the cheapest GPU that holds the cycle wins. That is an H100 SXM at $65/day community for Qwen3.8, or an H200 ($86) for margin and for Qwen3-32B.
- **For faster cycles, or for packing more agents per GPU:** B200 + NVFP4 does about 4 decisions/s for 20 agents (5 s cycle). Its ceiling is well above that: about 5 decisions/s closed loop on FP8, and NVFP4 is 30–40% faster again.
- **L40S, A100, RTX PRO 6000: not measured.** The RTX PRO 6000 was out of stock and L40S/A100 were skipped to stay in budget.
  - Rough estimates from bandwidth ratios against the measured H100: an A100 80 GB (2.0 TB/s, no FP8 tensor cores, so W8A16 or AWQ) would land around a 13–15 s cycle, and an L40S (0.86 TB/s, 48 GB) would struggle to fit 32B FP8 plus KV and would be about 3× slower. Neither is competitive per decision.
  - An RTX PRO 6000 (1.8 TB/s, 96 GB, FP4) with NVFP4 is the interesting untested cheap option at $1.69/h community.
- **TP=2 vs two replicas (estimated, not measured):**
  - Two independent single-GPU replicas, each serving 10 agents, sit at about the closed-c8 numbers: Qwen3.8 on H100 p50 4.1 s, p90 4.9 s.
  - TP=2 on two H100s would cut per-token latency by about 1.6–1.8× at 20 agents (p50 ≈ 3 s) but pays NVLink all-reduce on every layer, and per-request steering hooks become sharded.
  - At this scale, prefer **one bigger GPU** (H200/B200) over TP=2, and **replicas** over TP once a single GPU is full.

### 7. Providers and prices (checked 2026-11-16, $/GPU-hour, single GPU)

| provider | H100 SXM | H200 | B200 | other | source |
|---|---|---|---|---|---|
| RunPod community / secure | 2.69 / 4.39 | 3.59 / 5.29 | 5.98 / 7.99 | H100 NVL 2.59 / 3.19; RTX PRO 6000 1.69 / 2.69; B300 6.94 / 8.99; L40S 0.79 / 1.09; A100 SXM 1.39 / 2.19 | RunPod GraphQL `gpuTypes` (live), [runpod.io/pricing](https://www.runpod.io/pricing) |
| Vast.ai (verified hosts, min / median of live offers) | 1.73 / 2.34 | 3.82 / 4.61 | 6.00 / 7.50 | RTX PRO 6000 1.14 / 1.64; interruptible H100 bids from 0.65 | cloud.vast.ai/api/v0/bundles |
| Lambda (1× on-demand) | 4.89 | — | 7.99 | H100 PCIe 3.79 | [lambda.com/pricing](https://lambda.com/pricing) |
| Together AI clusters (OD / 31–90 d reserved / preemptible) | 3.99 / 3.45 / 1.99 | 5.99 / 4.15 / 2.99 | 9.29 / 7.99 / 4.65 | | [together.ai/pricing](https://www.together.ai/pricing) |
| Nebius on-demand | 4.50 | 5.40 | 8.50 | RTX PRO 6000 1.80 | [nebius.com/prices](https://nebius.com/prices) |
| Modal (serverless, per second) | 3.95 | 4.54 | 6.25 | | [modal.com/pricing](https://modal.com/pricing) |
| DigitalOcean (OD / 12-month reserved) | 4.41 / 3.26 | 4.47 / 3.40 | — | | [digitalocean.com/pricing/gpu-droplets](https://www.digitalocean.com/pricing/gpu-droplets) |
| Hyperbolic | from 3.19 | from 3.99 | from 5.99 | | hyperbolic.ai/marketplace |
| CoreWeave (8-GPU nodes only, per GPU) | 6.16 | 6.31 | 8.60 | | [coreweave.com/pricing](https://www.coreweave.com/pricing) |
| Hetzner (dedicated, monthly) | — | — | — | RTX PRO 6000 Max-Q: €999/month (≈ €1.37/h at 24/7) + €999 setup | hetzner.com dedicated GPU matrix |

- **Cheapest per day for 20 agents with mild reasoning:**
  - Vast.ai H100 SXM at about $1.73–2.34/h, i.e. **$42–56/day**, if a verified host is acceptable.
  - RunPod community H100 at **$65/day**, or H200 at **$86/day**.
- **Availability:**
  - Today, RunPod's community H100 SXM, B200, RTX PRO 6000 and B300 were sold out at least once. Secure stock was always there.
  - A 24/7 study should reserve capacity or keep a secure-cloud fallback.
  - On RunPod a stopped pod still bills its disk; terminate between runs.
- Tiers marked "from" or "bid" are floors, not guaranteed prices. The Fluidstack/Shadeform figures (H100 ≈ $2.10–2.50) are second-hand and were left out.

### 8. Prompt structure and caching (offline estimate from the replayed prompts)

Today the shared system prompt (1,419 Qwen tokens) is the only cached prefix: 44–47% of a ~3,190-token prompt, which matches the measured 44.5–48%. The observation that follows starts with volatile lines (the age changes every turn), so consecutive turns of the same agent share almost nothing beyond the system prompt.

| layout | observation tokens reused per turn | cache hit |
|---|---|---|
| current | ~10–40 | 45–47% |
| sections reordered most-stable-first, volatile YOU lines (age, position, food, holding) moved to a final "NOW" block, notebook / past-life notes right after the system prompt | mean 100–145 (p90 213–389) | 48–52% |
| ceiling (every unchanged line reused, any order) | ~750 | ~68% |

- **Payoff: about 90–130 prefill tokens saved per call**, which is 5–8% of uncached prefill and only ~15–20 ms of TTFT. Prefill is under 15% of a reasoning decision, so this is a small win. **Restructuring is not worth doing for speed alone.**
- **It becomes worth doing with steering.** Per-agent steering vectors make KV vector-specific, so the system prompt can no longer be shared across agents. The only reuse left is each agent's own previous prompt, and that needs a stable per-agent prefix.
- **Code to change in `buildObservation` (`agents/src/agent/observe.ts`):**
  - split the age out of `playerLabel`;
  - move the `Age … At (x,y)` line, `foodLine`, heat/holding/wearing/under-you and `resourceLines` to the end;
  - put NOTEBOOK and NOTES FROM YOUR PAST LIVES right after identity;
  - HEARD and LAST ACTIONS use `turnsAgo()` sliding windows, so put them last.

### 9. Harness-side overlap (estimate)

- **What happens now.** `playLife` → `turn()` awaits the LLM call, then runs the steps to completion (`runSteps`), then `betweenTurns(t0)` pads to the 8 s floor. The cycle is max(8 s, L + A) with no overlap.
- **The action time A (2,380 adult turns):** p10 0.26 s, p50 1.27 s, p90 5.4 s, mean 2.3 s on the old logs. The agent-loop driver uses the full distribution, mean 3.1 s including waits.

Starting the next LLM call when the current action starts, from an observation snapshot (projected for go/use/drop):

| L (LLM latency) | cycle now (8 s floor) | cycle with overlap | gain | requests in flight |
|---|---|---|---|---|
| 4 s | 8.6 s | 8.3 s | +4% | 9.3 → 9.7 |
| 6 s | 9.1 s | 8.3 s | +11% | 13 → 14.5 |
| 8 s | 10.3 s | 8.3 s | +25% | 15.5 → 19.4 |

- **When it pays.** With the setups above, L is 4–5 s on H100/H200, so overlap gains only about 4–8%. It matters if you stay on slower hardware (L ≈ 8 s) or drop the floor.
- **What it costs.** It raises concurrency to nearly 20, which feeds back into L.
- **The risks:**
  - The model decides without the current action's result. 12% of actions fail.
  - About 11% of overlapped calls would see a salient event arrive mid-action (about 3% urgent).
  - Overall, 15–25% of speculative calls risk being discarded or acting on a wrong premise.
- **How to do it, if wanted:** cancel the in-flight call on an urgent `noteSalient`; reuse `staleness()` from `steps.ts`; never overlap a `wait`.
- **Verdict: not needed with H200 or B200; optional on H100.**

## Quality: valid actions and reasoning

- **Valid action** means the agents' own `parseReply` plus `checkActions(…, craft, 3)` accepted the reply. JSON parse rate was 99–100% with `json_object`.
- **Qwen3-32B failures:**
  - empty `{}` replies (~1.1%, from the cut-off budget);
  - truncation at `max_tokens` when the model keeps reasoning inside a JSON string (~0.5%);
  - occasionally a malformed action, e.g. `swap` without x/y.
- **Qwen3.8:** 98.4–100%, and almost no `{}` replies.
- **Reasoning coherence**, from a read of 20 replies (10 per model, H200 runs, recommended configs):
  - **Qwen3-32B** reasons in full sentences and stays on topic: recipes, positions, food. Every thought is cut at the budget, sometimes mid-sentence, and the JSON `thought` then summarises a conclusion the reasoning hadn't reached yet. One note claimed an action as done before doing it.
  - **Qwen3.8** reasons tersely ("Need sharp stone: Stone on Big Hard Rock. Stones at (51,-123)…"), checks the action list, catches inconsistencies (its own name vs what it said), and reaches a conclusion inside the budget.
  - Both handle baby/parent and starvation situations sensibly.
  - Speculative decoding and quantisation produced no visible change.

## Steering compatibility (persona vectors, e.g. EasySteer on vLLM)

| option | compatible with per-request residual-stream steering? | notes |
|---|---|---|
| vLLM (any version) | via the EasySteer fork | EasySteer tracks vLLM 0.29; upstream has no per-request steering. Porting the hook (a per-token gather+add on the residual) to 0.34 is about 50 lines. |
| SGLang | no maintained option | would need a custom hook; not recommended |
| FP8 / NVFP4 / AWQ weights | yes | steering adds to bf16 activations; weight format is irrelevant |
| FP8 KV cache | yes | |
| EAGLE-3 draft head (Qwen3-32B) | yes, likely lower acceptance | Verification runs the steered target, so outputs stay exact. The draft head reads unsteered-trained hidden-state features, so acceptance (2.2) may drop for strong vectors and part of the 1.7× gain may be lost. Untested; EasySteer + spec decode + CUDA graphs is an open question. |
| MTP head (Qwen3.8) | yes, likely lower acceptance | Same reasoning; MTP reads the final steered hidden state, which probably helps it stay accurate. |
| Qwen3-32B architecture | **safe case** | plain transformer; EasySteer supports the Qwen3 family |
| Qwen3.8-27B architecture | **risky** | hybrid Gated DeltaNet / attention (`qwen3_5` in vLLM); not in EasySteer's tested models; residual-stream steering is architecture-agnostic in principle |
| Qwen3.8-Flash-Next | **risky** | new `qwen4_exp` MoE + QSA architecture; needs a port |
| prefix caching | partly | Steering the prompt tokens makes KV vector-specific: use `cache_salt` per vector, which loses the shared-system-prompt hit (44% → per-agent reuse only; see §8). Steering only generated tokens keeps prefix sharing. |
| TP=2 | harder | hooks must handle sharded hidden states; avoid |

**Path that keeps steering open:**
- Qwen3-32B + EAGLE-3 on one H200 is the lowest-risk stack.
- Qwen3.8 + MTP is faster and better at the task, but steering it needs the hybrid-model hook ported and validated.
- Plan a short steering-on benchmark (acceptance and latency with 0 / mild / strong vectors) before committing.

## Upgrade tier: a stronger open model with mild reasoning

The user is open to a smarter, more expensive model. Candidates that fit 1–8 GPUs, with model-card benchmarks (from the Qwen3.8-Flash-Next card):

| model | params (active) | IFBench | CoWorkBench | JobBench | Toolathlon | GPQA-D |
|---|---|---|---|---|---|---|
| Qwen3.8-27B (recommended above) | 27B dense | 79.5 | 70.7 | 33.4 | 67.1 | 89.2 |
| **Qwen3.8-Flash-Next** | 125B MoE (6B active) + 51B n-gram embedding + MTP | **81.3** | **73.9** | **55.7** | **73.5** | **91.7** |
| Qwen3.7-Plus | 397B (17B active) | 79.1 | 65.1 | 27.6 | 50.6 | 90.3 |
| DeepSeek-V4-Flash | 284B (13B active) | 79.2 | 45.1 | 41.3 | 70.3 | 90.8 |

**Qwen3.8-Flash-Next is the clear upgrade.**
- It is stronger than everything else in reach on agent and long-horizon work.
- It is cheap to serve: only 6B parameters are active per token, so decode is fast, and it has MTP.
- The 185 GB FP8 checkpoint fits on **one B300 (288 GB)**, two H200s, or two B200s.

**Measured on one B300 (vLLM 0.34, FP8, MTP k=3, thinking ≤300):**

| load | p50 / p90 / p99 (s) | decisions/s | cycle | accept len | valid |
|---|---|---|---|---|---|
| 20 agents | 3.76 / 4.43 / 5.00 | 2.78 | 7.2 s | 2.18 | 98.0% |
| 28 agents | 4.74 / 6.01 / 7.07 | 3.44 | 8.1 s | 2.16 | 98.8% |
| closed c8 | 3.20 / 3.67 / 3.95 | 2.41 | — | 2.19 | 97.9% |

- **It meets the 20-agent, 8 s target on one GPU** with slightly lower latency than Qwen3.8-27B on an H200, and valid actions are as good.
- **No prefix-cache hits were reported.** `cached_tokens` was 0 throughout, so its sparse-attention (QSA) path appears not to use vLLM's prefix cache yet. It is fast anyway, because only 6B parameters are active.
- **Serving gotchas:**
  1. The first start JIT-compiles FlashInfer's `fused_moe_trtllm_sm100` for about 8 minutes on one CPU core.
  2. With `VLLM_USE_RUST_FRONTEND=1` (the recipe default) the frontend gave up after ~10 minutes ("Frontend process failed during engine core initialization") and killed the first attempt.
  3. The second attempt used the Python frontend with `VLLM_ENGINE_READY_TIMEOUT_S=3600` and came up after 13 minutes.
- **For production,** bake the FlashInfer JIT cache (`~/.cache/flashinfer`) into the image or onto a volume.

**Upgrade cost for 20 agents with mild reasoning at a 5–8 s cycle:**

| setup | GPUs | $/day community / secure | status |
|---|---|---|---|
| Qwen3.8-Flash-Next-FP8 + MTP, 1× B300 | 1 | $167 / $216 | **measured**: 20 agents p50 3.76 s / p90 4.43 s, cycle 7.2 s; 28 agents p90 6.0 s |
| Qwen3.8-Flash-Next-FP8, 2× H200 TEP2 (`--enable-expert-parallel --moe-backend triton`; plain TP isn't supported for the FP8 checkpoint) | 2 | $172 / $254 | estimate, not measured: per-GPU bandwidth is below the B300's, offset by splitting the experts; expect latency similar to the B300 plus expert-parallel all-to-all overhead. It is the option if B300s are sold out. |
| Qwen3.8-Flash-Next-NVFP4, 2× B200 TEP2 | 2 | $287 / $384 | estimate: fastest, overkill for 20 agents |
| Qwen3.7-Plus / DeepSeek-V4-Flash, FP8 on 4× H200 or 2× B300 | 2–4 | $333–345 / $431–508 | not worth it: weaker than Flash-Next on the agent benchmarks |

Flash-Next costs about 1.2–1.4× Claude Haiku 5.5 on community cloud ($167/day) and 1.6–1.8× on secure ($216/day). That buys the strongest open agent model in reach, with mild reasoning at a 7 s cycle.

## Production launch commands

All commands use vLLM 0.34.0 (`pip install vllm==0.34.0` in a CUDA 13 image; the runs here used `lmsysorg/sglang:v0.5.23-cu130` plus a uv venv, see [Reproduction](#reproduction)). `$KEY` is the API key. The agents need `LLM_BASE_URL=http://<host>:8000/v1`, `LLM_MODEL=m`, and the per-request body below.

**Qwen3.8-27B, mild reasoning (recommended; one H100 SXM or H200):**
```bash
vllm serve Qwen/Qwen3.8-27B-FP8 --served-model-name m --api-key $KEY --host 0.0.0.0 --port 8000 \
  --max-model-len 16384 --gpu-memory-utilization 0.92 --enable-prefix-caching --enable-prompt-tokens-details \
  --reasoning-parser qwen3 --reasoning-config.reasoning_start_str '<think>' --reasoning-config.reasoning_end_str '</think>' \
  --language-model-only --max-num-seqs 64 \
  --speculative-config '{"method":"mtp","num_speculative_tokens":3}'
```
Do **not** set `VLLM_USE_DEEP_GEMM=0`. The first start JIT-warms about 4k DeepGEMM kernels (~6 min); later starts reuse the cache in `~/.cache/vllm`.

**Qwen3.8-27B on B200 (5 s cycle):** the same flags with `nvidia/Qwen3.8-27B-NVFP4` in place of the FP8 checkpoint.

**Qwen3-32B, mild reasoning (one H200; H100 SXM for a ≥9 s cycle):**
```bash
vllm serve Qwen/Qwen3-32B-FP8 --served-model-name m --api-key $KEY --host 0.0.0.0 --port 8000 \
  --max-model-len 16384 --gpu-memory-utilization 0.92 --enable-prefix-caching --enable-prompt-tokens-details \
  --reasoning-parser qwen3 --reasoning-config.reasoning_start_str '<think>' --reasoning-config.reasoning_end_str '</think>' \
  --speculative-config '{"method":"eagle3","model":"RedHatAI/Qwen3-32B-Thinking-speculator.eagle3","num_speculative_tokens":3}'
```
On B200, use `nvidia/Qwen3-32B-NVFP4` with the same speculator.

**Upgrade, Qwen3.8-Flash-Next (one B300):**
```bash
VLLM_USE_RUST_FRONTEND=1 vllm serve Qwen/Qwen3.8-Flash-Next-FP8 --served-model-name m --api-key $KEY --host 0.0.0.0 --port 8000 \
  --max-model-len 16384 --gpu-memory-utilization 0.92 --enable-prefix-caching --enable-prompt-tokens-details \
  --reasoning-parser qwen3 --reasoning-config.reasoning_start_str '<think>' --reasoning-config.reasoning_end_str '</think>' \
  --language-model-only --max-num-seqs 64 --kv-cache-dtype fp8 --attention-config.indexer_kv_dtype fp8 \
  --speculative-config '{"method":"mtp","num_speculative_tokens":3}'
```
The first start JIT-compiles FlashInfer's `fused_moe_trtllm_sm100` (about 13 min to the first ready on a fresh pod); later starts reuse `~/.cache/flashinfer`.

**Per request (what the agents send):**
```json
{"model":"m","temperature":0.8,"max_tokens":800,"response_format":{"type":"json_object"},
 "chat_template_kwargs":{"enable_thinking":true},"thinking_token_budget":300, "stream":true}
```
Use `thinking_token_budget` 400 for Qwen3-32B if the ~1% empty `{}` replies matter (+1.2 s p50). Qwen3.8 doesn't need it.

## Method

**Prompts.** The prompts are the same 2,770 as the previous study: the current system prompt plus logged observations, built by `promptsFromLogs` in `agents/src/tools/bench-endpoint.ts` from `agents/logs-dev/dev1-r1-mwjtcz8f-…/llm.jsonl` and `agents/logs/showcase1-r1-mvvlsrb7-…/llm.jsonl`. They are shuffled with a fixed seed, and each run takes a fresh slice. A shared offset counter across parallel pods may have overlapped a few slices; this only matters for the H200 Qwen3.8 c20 row, whose 84% cache hit is inflated.

**Agent loop (new).** The driver ([Appendix A](#appendix-a-benchmark-driver-benchmts)) runs `--agent-loop 1 --concurrency 20`:
- Each of 20 workers sends a decision and waits for the full streamed reply.
- It then sleeps for an action time drawn from the empirical distribution of (next call start − previous reply) in the same logs (mean 3.1 s, heavy tail up to 60 s).
- Agents start desynchronised over 0–4 s.
- 200 decisions per run (about 10 per agent).
- The cycle is measured start-to-start per agent.

The 8 s harness floor was *not* applied (`--cycle-ms 0`), so "natural cycle" shows each setup's own speed.

**Request body.** Requests match the agents (see above). Each server got 6 warm-up requests first. Valid actions use the agents' own `parseReply` + `checkActions`. Spec-decode acceptance comes from vLLM `/metrics` deltas.

**Serving.** All vLLM servers used the common flags shown above. Variants added only the flag named in the row. SGLang used `--context-length 16384 --reasoning-parser qwen3 --mem-fraction-static 0.85` plus the spec flags.

**Infrastructure.** A small control server on each pod ([Appendix B](#appendix-b-pod-control-server-ctlpy)) let one pod run many configurations in sequence: it restarts the engine without re-pulling the 16 GB image or re-downloading weights. A config switch took 1.5–4 minutes, against about 15 for a fresh pod. The laptop only sent HTTP.

## Spend log

| pod | GPU | price | what ran | approx. cost |
|---|---|---|---|---|
| opt-q3 | H100 SXM (IN), secure | $4.39/h | Qwen3-32B: baseline, 5 spec-decode drafts, AWQ, FP8 KV, k=2, JSON off, brief-thinking prompt ×2; Qwen3.8 MTP; SGLang attempt | ~$5.60 |
| opt-q38 (stuck in image pull, terminated) | H100 SXM (US), secure | $4.39/h | nothing | ~$1.10 |
| opt-q38b | H100 NVL, secure | $3.19/h | Qwen3.8: base, MTP, JSON off, SGLang ×2, INT4 + MTP, DSpark | ~$3.00 |
| opt-h200 | H200, community | $3.59/h | Qwen3-32B base + EAGLE-3; Qwen3.8 MTP (20 and 28 agents) | ~$2.40 |
| opt-b200 | B200, secure | $7.99/h | both models FP8 and NVFP4, AngelSlim EAGLE-3, SGLang attempt | ~$7.60 |
| opt-b300 (first try; the Rust frontend timed out during JIT) | B300, secure | $8.99/h | nothing usable | ~$2.30 |
| opt-b300b | B300, secure | $8.99/h | Qwen3.8-Flash-Next-FP8 + MTP (20 and 28 agents, c8) | ~$2.70 |
| **total** (balance $139.15 → $114.04; per-pod figures are estimated from run times) | | | | **$25.10** |

**Safety measures:**
- A watchdog (`watchdog.sh`, [Appendix C](#appendix-c-helpers)) polled the balance every 60 s. It would terminate every pod once spend reached $38.50, or after 6 h.
- Every pod was terminated explicitly as soon as its queue finished.
- The final `myself { pods }` check returned `[]`.

## Reproduction

The laptop only sends HTTP. The RunPod key is read from `~/.config/persona-neurons/keys.env`; the vLLM/control key is in `vllm.key`. Run from **bash**.

```bash
W=~/selfhost-opt; mkdir -p $W && cd $W   # put the appendix files here (rp.py is the bench doc's Appendix B plus the CTL/GPUS/CUDAV patch below)
umask 077; python3 -c 'import secrets;print(secrets.token_urlsafe(24))' > vllm.key
nohup ./watchdog.sh $(python3 rp.py balance | jq .data.myself.clientBalance) 38.5 21600 > watchdog.log 2>&1 &
./mk.sh opt-h200 "NVIDIA H200" COMMUNITY 16 4 200          # sglang:v0.5.23-cu130 image + control server on :8001
./c.sh <pod> bg setup "$(cat setup_vllm.sh)"; ./c.sh <pod> bg dl "$(cat dl_hw.sh)"
./cfg.sh <pod> h200-q38-mtp3 ac "/opt/vv/bin/vllm serve Qwen/Qwen3.8-27B-FP8 $(cat vcommon.txt) --language-model-only --max-num-seqs 64 --speculative-config '{\"method\":\"mtp\",\"num_speculative_tokens\":3}'"
python3 rp.py terminate-all; python3 rp.py list     # must print []
```
`cfg.sh` starts the server and waits for `/health`, then runs `suite.sh`: warm-up, `a20` (agent loop, 20 agents) and `c8`; add `z` for closed c20. `python3 table.py` builds the results table from `res/*.json` and `meta.json`.

## Appendix A: benchmark driver (bench.mts)

This is the previous study's driver, extended with `--agent-loop 1` (the 20-agent loop with empirical action times), `--engine sglang`, `--extra '<json>'` (extra request fields for thinking requests), `--concise 1` (the "think briefly" system-prompt line), `--adaptive 1` (thinking only on salient observations), spec-decode acceptance, full reasoning text in the per-call output, and SGLang metrics. Save it outside the repo; it imports the agents' prompt builder and reply checker by absolute path.

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
import { writeFileSync, readFileSync } from "node:fs";
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
const engine = opt.engine ?? "vllm";
const extra = opt.extra ? JSON.parse(opt.extra) : {};
const concise = opt.concise === "1";
const adaptive = opt.adaptive === "1";
// agent-loop mode: each worker is one agent; after a reply it "executes" its action
// (sampled from the empirical action-time distribution of the dev log) and respects a
// cycle floor (start-to-start >= cycleMs), like the real harness.
const agentLoop = opt["agent-loop"] === "1";
const cycleMs = Number(opt["cycle-ms"] ?? 0);
const durationS = Number(opt.duration ?? 0);
const ACTION_MS = (() => {
  const out: number[] = [];
  const by = new Map<string, [number, number][]>();
  for (const f of files) for (const line of readFileSync(f, "utf8").split("\n")) {
    try { const r = JSON.parse(line); if (r.latencyMs == null) continue; const k = r.agentId + ":" + r.lifeIndex; if (!by.has(k)) by.set(k, []); by.get(k)!.push([r.t, r.latencyMs]); } catch {}
  }
  for (const v of by.values()) { v.sort((a, b) => a[0] - b[0]); for (let i = 1; i < v.length; i++) { const g = v[i][0] - v[i][1] - v[i - 1][0]; if (g >= 0 && g < 60000) out.push(g); } }
  return out;
})();
const CONCISE = "\n\nThink briefly: a few short sentences about the situation and your next step, then answer.";
function salient(obs: string): boolean {
  const sec = (name: string) => { const m = obs.match(new RegExp("== " + name + " ==\\n([\\s\\S]*?)(\\n== |$)")); return m ? m[1].trim() : ""; };
  const heard = sec("HEARD RECENTLY");
  if (heard && !/^Nothing/.test(heard)) return true;
  const fm = obs.match(/Food: (\d+)\/(\d+)/);
  if (fm && Number(fm[1]) <= Number(fm[2]) / 4) return true;
  if (/STARVING|picked you up|attacked|wounded|bleeding/i.test(obs)) return true;
  return false;
}

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
      const m = line.match(/^(vllm:(?:prefix_cache_\w+|num_preemptions\w*|prompt_tokens_total|generation_tokens_total|spec_decode_\w+)|sglang:(?:spec_accept\w*|cache_hit_rate|num_running_reqs|gen_throughput|num_queue_reqs|prompt_tokens_total|generation_tokens_total|cached_tokens_total|spec\w*))(?:\{[^}]*\})?\s+([0-9.eE+-]+)$/);
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

interface Call { thinking?: boolean; reasoning?: string; startMs?: number; endMs?: number; ok: boolean; status: number; latencyMs: number; ttftMs: number | null; ttfcMs: number | null; promptTokens: number; completionTokens: number; cachedTokens: number; reasoningChars: number; finish: string | null; parseOk: boolean; actionOk: boolean; why?: string; content?: string }

async function one(messages0: any[]): Promise<Call> {
  const t0 = Date.now();
  const thinkThis = think && (!adaptive || salient(String(messages0[1]?.content ?? "")));
  const messages = concise && thinkThis ? [{ ...messages0[0], content: messages0[0].content + CONCISE }, ...messages0.slice(1)] : messages0;
  const think_ = thinkThis;
  const body: any = {
    model: opt.model, messages, max_tokens: think_ ? maxTokens : Math.min(maxTokens, 2000), temperature: 0.8, stream: true, stream_options: { include_usage: true },
    chat_template_kwargs: { enable_thinking: think_ },
    ...(json ? { response_format: { type: "json_object" } } : {}),
    ...(think_ && budget && engine === "vllm" ? { thinking_token_budget: budget } : {}),
    ...(think_ ? extra : {}),
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
    return { ok: true, status: 200, latencyMs: Date.now() - t0, ttftMs: ttft, ttfcMs: ttfc, promptTokens: usage.prompt_tokens ?? 0, completionTokens: usage.completion_tokens ?? 0, cachedTokens: usage.prompt_tokens_details?.cached_tokens ?? 0, reasoningChars: reasoning.length, finish, parseOk: p.ok, actionOk, why: why?.slice(0, 160), content, reasoning, thinking: think_, startMs: t0, endMs: Date.now() };
  } catch (e: any) {
    return fail(0, e?.name === "AbortError" ? "timeout" : String(e?.message ?? e));
  } finally { clearTimeout(timer); }
}

const m0 = await metrics();
const gp = sampleGpu();
const calls: Call[] = [];
let next = 0;
const t0 = Date.now();
const sleep = (ms: number) => new Promise((s) => setTimeout(s, ms));
if (!agentLoop) {
  await Promise.all(Array.from({ length: Math.min(conc, n) }, async () => { while (next < n) { const i = next++; calls.push(await one(prompts[i])); } }));
} else {
  const rr = rng(7);
  const deadline = durationS ? t0 + durationS * 1000 : Infinity;
  await Promise.all(Array.from({ length: conc }, async (_, a) => {
    await sleep(rr() * 4000); // desynchronise agents
    while (next < n && Date.now() < deadline) {
      const i = next++; const s0 = Date.now();
      const c: any = await one(prompts[i]); c.agent = a; calls.push(c);
      const act = ACTION_MS[Math.floor(rr() * ACTION_MS.length)] ?? 3000;
      const wait = Math.max(act, cycleMs - (Date.now() - s0));
      await sleep(wait);
    }
  }));
}
const wall = Date.now() - t0;
sampling = false; await gp;
const m1 = await metrics();
const ok = calls.filter((c) => c.ok);
const pct = (xs: number[]) => ({ p50: percentile(xs, 50), p90: percentile(xs, 90), p99: percentile(xs, 99) });
const mean = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
const dm: Record<string, number> = {};
for (const k of Object.keys(m1)) dm[k] = Math.round((m1[k] - (m0[k] ?? 0)) * 100) / 100;
const cyc: number[] = [];
for (let a = 0; a < conc; a++) { const st = calls.filter((c: any) => c.agent === a).map((c) => c.startMs!).sort((x, y) => x - y); for (let i = 1; i < st.length; i++) cyc.push(st[i] - st[i - 1]); }
const cycMean = cyc.length ? cyc.reduce((x, y) => x + y, 0) / cyc.length : null;
const thinkFrac = calls.length ? Math.round((calls.filter((c) => c.thinking).length / calls.length) * 1000) / 1000 : 0;
const actMean = ACTION_MS.length ? Math.round(ACTION_MS.reduce((a, b) => a + b, 0) / ACTION_MS.length) : null;
const report = {
  agentLoop, cycleMs, actionMsMean: agentLoop ? actMean : null, thinkFrac, concise, adaptive, engine,
  decisionsPerS: Math.round((ok.length / (wall / 1000)) * 100) / 100,
  impliedCycleS: agentLoop && cycMean ? Math.round(cycMean / 10) / 100 : null,
  cycleP90S: agentLoop && cyc.length ? Math.round(percentile(cyc, 90)! / 10) / 100 : null,
  steadyDecisionsPerS: agentLoop && cycMean ? Math.round((conc / (cycMean / 1000)) * 100) / 100 : null,
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
  vllmMetricsDelta: dm, metricsEnd: Object.fromEntries(Object.entries(m1).filter(([k]) => k.startsWith("sglang"))),
  specAcceptLen: dm["vllm:spec_decode_num_drafts_total"] ? Math.round((1 + dm["vllm:spec_decode_num_accepted_tokens_total"] / dm["vllm:spec_decode_num_drafts_total"]) * 100) / 100 : null,
};
console.log(JSON.stringify(report, null, 1));
if (opt.out) writeFileSync(opt.out, JSON.stringify({ report, calls }, null, 1));
```

## Appendix B: pod control server (ctl.py)

The control server runs on port 8001 inside the `lmsysorg/sglang:v0.5.23-cu130` image. The pod's start command is `bash -c 'mkdir -p /logs; echo $CTL_SRC | base64 -d > /ctl.py; exec python3 /ctl.py'`; `rp.py` passes the file base64-encoded in `CTL_SRC` and the key in `CTL_TOKEN`. vLLM is installed beside SGLang in a uv venv (`setup_vllm.sh`).

```python
"""Pod control server (port 8001). Token in env CTL_TOKEN, sent as header x-token.
GET  /health                      no auth
GET  /status                      current server job + nvidia-smi
GET  /log?name=X&n=200            tail of /logs/X.log (default: current server)
POST /run   {name, cmd}           stop current server job, start cmd (bash) in its own process group
POST /stop                        stop current server job
POST /bg    {name, cmd}           start a background job (does not touch the server job)
POST /sh    {cmd, timeout}        run synchronously, return output (last 20 KB)
"""
import http.server, json, os, signal, subprocess, time, urllib.parse

TOK = os.environ["CTL_TOKEN"]
LOG = "/logs"
os.makedirs(LOG, exist_ok=True)
cur = {"p": None, "name": None, "cmd": None, "t": None}
bg = {}


def gpu_pids():
    try:
        out = subprocess.run(["nvidia-smi", "--query-compute-apps=pid", "--format=csv,noheader"], capture_output=True, text=True, timeout=20).stdout
        return [int(x) for x in out.split() if x.strip().isdigit()]
    except Exception:
        return []


def stop():
    p = cur["p"]
    if p and p.poll() is None:
        try:
            os.killpg(p.pid, signal.SIGTERM)
        except Exception:
            pass
        for _ in range(40):
            if p.poll() is not None:
                break
            time.sleep(0.5)
        try:
            os.killpg(p.pid, signal.SIGKILL)
        except Exception:
            pass
    for pid in gpu_pids():
        try:
            os.kill(pid, signal.SIGKILL)
        except Exception:
            pass
    for _ in range(30):
        if not gpu_pids():
            break
        time.sleep(1)


def spawn(name, cmd):
    f = open(f"{LOG}/{name}.log", "ab")
    return subprocess.Popen(["bash", "-lc", cmd], stdout=f, stderr=subprocess.STDOUT, start_new_session=True)


def tail(path, n):
    try:
        with open(path, "rb") as f:
            f.seek(0, 2)
            size = f.tell()
            f.seek(max(0, size - 200_000))
            lines = f.read().decode(errors="replace").splitlines()
        return "\n".join(lines[-n:])
    except Exception as e:
        return f"(no log: {e})"


class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def out(self, code, obj):
        b = (obj if isinstance(obj, str) else json.dumps(obj)).encode()
        self.send_response(code)
        self.send_header("content-type", "text/plain" if isinstance(obj, str) else "application/json")
        self.send_header("content-length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def authed(self):
        if self.headers.get("x-token") != TOK:
            self.out(401, {"error": "unauthorized"})
            return False
        return True

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        q = dict(urllib.parse.parse_qsl(u.query))
        if u.path == "/health":
            return self.out(200, "ok")
        if not self.authed():
            return
        if u.path == "/status":
            p = cur["p"]
            smi = subprocess.run(["nvidia-smi", "--query-gpu=name,memory.used,memory.total,utilization.gpu", "--format=csv,noheader"], capture_output=True, text=True).stdout
            return self.out(200, {"name": cur["name"], "running": bool(p and p.poll() is None), "rc": p.poll() if p else None,
                                  "uptime": round(time.time() - cur["t"]) if cur["t"] else None, "gpu": smi.strip(),
                                  "bg": {k: v.poll() for k, v in bg.items()}})
        if u.path == "/log":
            name = q.get("name") or cur["name"] or "none"
            return self.out(200, tail(f"{LOG}/{name}.log", int(q.get("n", 200))))
        self.out(404, {"error": "not found"})

    def do_POST(self):
        if not self.authed():
            return
        n = int(self.headers.get("content-length") or 0)
        body = json.loads(self.rfile.read(n) or b"{}")
        if self.path == "/run":
            stop()
            cur.update(p=spawn(body["name"], body["cmd"]), name=body["name"], cmd=body["cmd"], t=time.time())
            return self.out(200, {"started": body["name"], "pid": cur["p"].pid})
        if self.path == "/stop":
            stop()
            return self.out(200, {"stopped": True})
        if self.path == "/bg":
            bg[body["name"]] = spawn(body["name"], body["cmd"])
            return self.out(200, {"bg": body["name"]})
        if self.path == "/sh":
            try:
                r = subprocess.run(["bash", "-lc", body["cmd"]], capture_output=True, text=True, timeout=float(body.get("timeout", 120)))
                return self.out(200, {"rc": r.returncode, "out": (r.stdout + r.stderr)[-20000:]})
            except subprocess.TimeoutExpired as e:
                return self.out(200, {"rc": -1, "out": f"timeout; partial: {str(e.stdout)[-5000:]}"})
        self.out(404, {"error": "not found"})


http.server.ThreadingHTTPServer(("0.0.0.0", 8001), H).serve_forever()
```

## Appendix C: helpers

`rp.py` is the previous study's Appendix B with three additions to the `create` input:
- `"gpuCount": int(os.environ.get("GPUS", "1"))`;
- with `CTL=1`, the env vars `CTL_TOKEN` (from `vllm.key`) and `CTL_SRC` (base64 of `ctl.py`);
- `allowedCudaVersions` from `CUDAV`, if set.

`vcommon.txt` holds the common vLLM flags: `--served-model-name m --api-key $KEY --host 0.0.0.0 --port 8000 --max-model-len 16384 --gpu-memory-utilization 0.92 --enable-prefix-caching --enable-prompt-tokens-details --reasoning-parser qwen3 --reasoning-config.reasoning_start_str '<think>' --reasoning-config.reasoning_end_str '</think>'`.

```bash
# setup_vllm.sh (runs on the pod)
export HF_XET_HIGH_PERFORMANCE=1
(command -v uv || pip install -q uv) >/dev/null 2>&1
uv venv /opt/vv --python 3.12 -q && uv pip install -p /opt/vv/bin/python -q vllm==0.34.0 && /opt/vv/bin/python -c "import vllm;print('VLLM_OK',vllm.__version__)"

# watchdog.sh <start_balance> <limit_usd> <max_seconds>
#!/bin/bash
# Budget + time watchdog: terminate all pods if spend >= LIMIT or elapsed >= MAXS.
W=$(dirname "$0"); START=$1; LIMIT=$2; MAXS=$3; t0=$(date +%s)
set -a; . ~/.config/persona-neurons/keys.env; set +a
while true; do
  b=$(python3 $W/rp.py balance | python3 -c "import json,sys;print(json.load(sys.stdin)['data']['myself']['clientBalance'])" 2>/dev/null)
  el=$(( $(date +%s) - t0 ))
  echo "$(date +%T) elapsed=${el}s balance=$b"
  if [ -n "$b" ] && python3 -c "import sys;sys.exit(0 if $START-$b >= $LIMIT else 1)"; then echo "BUDGET HIT"; python3 $W/rp.py terminate-all; fi
  if [ $el -ge $MAXS ]; then echo "TIME HIT"; python3 $W/rp.py terminate-all; exit 0; fi
  sleep 60
done

# mk.sh <name> <gpuTypeId> <COMMUNITY|SECURE> [mem] [cpu] [disk]
#!/bin/bash
# mk.sh <name> <gpuTypeId> <COMMUNITY|SECURE> [mem] [cpu] [disk]  -> prints pod id or error
W=$(cd "$(dirname "$0")" && pwd)
set -a; . ~/.config/persona-neurons/keys.env; set +a
BOOT="bash -c 'mkdir -p /logs; echo \$CTL_SRC | base64 -d > /ctl.py; exec python3 /ctl.py'"
CTL=1 IMAGE=${IMAGE:-lmsysorg/sglang:v0.5.23-cu130} DISK=${6:-200} MINMEM=${4:-32} MINCPU=${5:-8} PORTS="8000/http,8001/http" \
  python3 $W/rp.py create "$1" "$2" "$3" "$BOOT" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d['errors'][0]['message'][:100] if d.get('errors') else json.dumps(d['data']['podFindAndDeployOnDemand']))"

# c.sh: control-server client
#!/bin/bash
# c.sh <pod> get <path>  |  c.sh <pod> post <path> <json>  |  c.sh <pod> sh "<cmd>" [timeout]  |  c.sh <pod> run <name> "<cmd>" | c.sh <pod> bg <name> "<cmd>"
W=$(cd "$(dirname "$0")" && pwd); P=$1; shift; U="https://$P-8001.proxy.runpod.net"; T=$(cat $W/vllm.key)
H=(-s -m 300 -A "Mozilla/5.0" -H "x-token: $T" -H "content-type: application/json")
case $1 in
  get) curl "${H[@]}" "$U$2";;
  post) curl "${H[@]}" -X POST "$U$2" -d "$3";;
  sh) curl "${H[@]}" -X POST "$U/sh" -d "$(python3 -c 'import json,sys;print(json.dumps({"cmd":sys.argv[1],"timeout":float(sys.argv[2])}))' "$2" "${3:-120}")" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d["out"]);print("rc",d["rc"])';;
  run|bg) curl "${H[@]}" -X POST "$U/$1" -d "$(python3 -c 'import json,sys;print(json.dumps({"name":sys.argv[1],"cmd":sys.argv[2]}))' "$2" "$3")";;
  log) curl "${H[@]}" "$U/log?name=$2&n=${3:-60}";;
esac
echo

# srv.sh <pod> <name> "<server cmd>": start and wait for /health
#!/bin/bash
# srv.sh <pod> <name> <full server command>  -> starts it, waits for /health on 8000 (max ~15 min), prints status
W=$(cd "$(dirname "$0")" && pwd); P=$1; N=$2; CMD=$3
$W/c.sh $P run $N "$CMD" >/dev/null
for i in $(seq 1 180); do
  sleep 5
  if [ "$(curl -s -m 5 -o /dev/null -w '%{http_code}' -A Mozilla/5.0 https://$P-8000.proxy.runpod.net/health)" = 200 ]; then echo "READY $N after $((i*5))s"; exit 0; fi
  st=$($W/c.sh $P get /status)
  if echo "$st" | grep -q '"running": false'; then echo "DIED $N"; $W/c.sh $P log $N 40; exit 1; fi
done
echo "TIMEOUT $N"; $W/c.sh $P log $N 30; exit 1

# cfg.sh <pod> <tag> <a|c|z...> "<server cmd>" [bench args]
#!/bin/bash
# cfg.sh <pod> <tag> <which> "<server cmd>" [bench args...]
W=$(cd "$(dirname "$0")" && pwd); P=$1; T=$2; WH=$3; CMD=$4; shift 4
t0=$(date +%s); $W/srv.sh $P $T "$CMD" || exit 1; echo "startup $(( $(date +%s)-t0 ))s"
$W/suite.sh $P $T $WH "$@"

# suite.sh <pod> <tag> <a|c|z...> [bench args]
#!/bin/bash
# suite.sh <pod> <tag> [which: a|c|ac|w] [extra bench args...]
W=$(cd "$(dirname "$0")" && pwd); P=$1; TAG=$2; WH=${3:-ac}; shift 3
U=https://$P-8000.proxy.runpod.net
off() { f=$W/offset.txt; o=$(cat $f 2>/dev/null || echo 0); echo $(( (o + $1) % 2700 )) > $f; echo $o; }
$W/b.sh $U $TAG-warm --n 6 --concurrency 3 --mode think --budget 300 --offset 2700 "$@" >/dev/null
[[ $WH == *a* ]] && $W/b.sh $U $TAG-a20 --n 200 --concurrency 20 --agent-loop 1 --mode think --budget 300 --offset $(off 200) "$@"
[[ $WH == *c* ]] && $W/b.sh $U $TAG-c8 --n 48 --concurrency 8 --mode think --budget 300 --offset $(off 48) "$@"
[[ $WH == *z* ]] && $W/b.sh $U $TAG-c20 --n 100 --concurrency 20 --mode think --budget 300 --offset $(off 100) "$@"
exit 0

# dl_hw.sh (runs on the pod; EXTRA_MODELS adds more repos)
export HF_XET_HIGH_PERFORMANCE=1
for m in Qwen/Qwen3-32B-FP8 RedHatAI/Qwen3-32B-Thinking-speculator.eagle3 Qwen/Qwen3.8-27B-FP8 $EXTRA_MODELS; do hf download $m >/dev/null 2>&1 && echo "DL_OK $m" || echo "DL_FAIL $m"; done

# b.sh <url> <name> [bench args]
#!/bin/bash
# usage: b.sh <url-base> <outname> [bench args...]   (runs from agents/, both logs)
W=$(cd "$(dirname "$0")" && pwd); URL=$1; NAME=$2; shift 2
cd /Users/mvonebers/ohol-stream/agents
L="logs-dev/dev1-r1-mwjtcz8f-2026-11-16T22-06-56-607Z/llm.jsonl logs/showcase1-r1-mvvlsrb7-2026-10-30T23-28-47-683Z/llm.jsonl"
set -a; . ~/.config/persona-neurons/keys.env; set +a
mkdir -p $W/res
npx tsx $W/bench.mts --url "$URL" --key "$(cat $W/vllm.key)" --model m "$@" --out $W/res/$NAME.json $L > $W/res/$NAME.report.json 2>$W/res/$NAME.err
python3 $W/summ.py $W/res/$NAME.json
```
