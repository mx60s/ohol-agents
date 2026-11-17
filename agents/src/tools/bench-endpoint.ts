// Latency/throughput benchmark for any OpenAI-compatible endpoint (a vLLM
// server, OpenRouter with a provider preference, ...), using realistic agent
// prompts taken from llm.jsonl logs (the system prompt plus each logged
// observation, exactly as the agents send them).
//
//   npx tsx src/tools/bench-endpoint.ts --url http://gpu-box:8000/v1 --model Qwen/Qwen3-32B \
//       --n 200 --concurrency 20 [--key K] [--max-tokens 600] [--reasoning off|low|...] \
//       [--provider-sort throughput] [--provider-order a,b] [--allow-fallbacks 0|1] \
//       [--stream 1] [--json-mode 1] [--out bench.json] logs/<run>/llm.jsonl [more llm.jsonl ...]
//
// Prints latency (total and time-to-first-token) p50/p90/p99, requests/s and
// output tokens/s, error counts by status, and the providers that served the
// calls. --key defaults to LLM_API_KEY / OPENROUTER_API_KEY. Spends money on
// paid endpoints; test it free against src/tools/fake-llm.ts.

import { readFileSync, writeFileSync } from "node:fs";
import { systemPromptFor } from "../agent/prompt.ts";
import { config } from "../config.ts";
import { LlmHttpError, readStream, requestOptions, wireMessages, type ChatMessage } from "../agent/llm.ts";
import { percentile } from "../calibration.ts";

export interface BenchOptions {
  url: string;
  model: string;
  key?: string;
  prompts: ChatMessage[][];
  n: number;
  concurrency: number;
  maxTokens?: number;
  reasoningEffort?: string;
  providerSort?: string;
  providerOrder?: string[];
  allowFallbacks?: boolean;
  stream?: boolean;
  jsonMode?: boolean;
  timeoutMs?: number;
}

export interface BenchCall {
  ok: boolean;
  status: number;
  latencyMs: number;
  ttftMs: number | null;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  provider: string | null;
  error?: string;
}

export interface BenchReport {
  url: string;
  model: string;
  n: number;
  concurrency: number;
  settings: { maxTokens: number | null; reasoningEffort: string | null; providerSort: string | null; providerOrder: string[]; allowFallbacks: boolean | null; stream: boolean; jsonMode: boolean };
  ok: number;
  errors: Record<string, number>;
  wallMs: number;
  requestsPerSec: number;
  outputTokensPerSec: number;
  latencyMs: { p50: number | null; p90: number | null; p99: number | null; mean: number | null };
  ttftMs: { p50: number | null; p90: number | null; p99: number | null };
  promptTokensMean: number;
  completionTokensMean: number;
  reasoningTokensMean: number;
  cacheHitRate: number;
  providers: Record<string, number>;
}

/** Agent prompts (system + observation) from llm.jsonl files, in log order. */
export function promptsFromLogs(files: string[], system = systemPromptFor(config)): ChatMessage[][] {
  const out: ChatMessage[][] = [];
  for (const f of files) {
    for (const line of readFileSync(f, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        if (typeof r.observation === "string" && r.observation)
          out.push([
            { role: "system", content: system },
            { role: "user", content: r.observation + "\n\nWhat do you do next? Reply with JSON only." },
          ]);
      } catch {
        // torn line
      }
    }
  }
  return out;
}

async function oneCall(o: BenchOptions, messages: ChatMessage[]): Promise<BenchCall> {
  const t0 = Date.now();
  const stream = o.stream !== false;
  const body: Record<string, unknown> = {
    model: o.model,
    messages: wireMessages(messages, o.model, true),
    max_tokens: o.maxTokens ?? 2000,
    temperature: 0.8,
    ...(o.jsonMode !== false ? { response_format: { type: "json_object" } } : {}),
    usage: { include: true },
    ...requestOptions({ llmReasoningEffort: o.reasoningEffort, llmProviderSort: o.providerSort, llmProviderOrder: o.providerOrder, llmProviderAllowFallbacks: o.allowFallbacks }),
    ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
  };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), o.timeoutMs ?? 120_000);
  const fail = (status: number, error: string): BenchCall => ({
    ok: false, status, latencyMs: Date.now() - t0, ttftMs: null, promptTokens: 0, completionTokens: 0, reasoningTokens: 0, cachedTokens: 0, provider: null, error,
  });
  try {
    const res = await fetch(`${o.url.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(o.key ? { authorization: `Bearer ${o.key}` } : {}), "x-title": "ohol-agents-bench" },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    if (!res.ok) return fail(res.status, (await res.text()).slice(0, 200));
    const { j, ttftMs } = stream ? await readStream(res, t0) : { j: (await res.json()) as any, ttftMs: null };
    const u = j.usage ?? {};
    return {
      ok: true, status: res.status, latencyMs: Date.now() - t0, ttftMs,
      promptTokens: Number(u.prompt_tokens) || 0, completionTokens: Number(u.completion_tokens) || 0,
      reasoningTokens: Number(u.completion_tokens_details?.reasoning_tokens) || 0,
      cachedTokens: Number(u.prompt_tokens_details?.cached_tokens) || 0,
      provider: typeof j.provider === "string" ? j.provider : null,
    };
  } catch (e) {
    if (e instanceof LlmHttpError) return fail(e.status, e.message);
    const err = e as { name?: string; message?: string };
    return fail(0, err?.name === "AbortError" ? "timeout" : String(err?.message ?? e));
  } finally {
    clearTimeout(timer);
  }
}

/** Send n prompts (cycling through o.prompts) with at most `concurrency` in flight. */
export async function runBench(o: BenchOptions): Promise<{ report: BenchReport; calls: BenchCall[] }> {
  if (!o.prompts.length) throw new Error("no prompts (llm.jsonl lines with an observation)");
  const calls: BenchCall[] = [];
  let next = 0;
  const t0 = Date.now();
  const worker = async () => {
    while (next < o.n) {
      const i = next++;
      calls.push(await oneCall(o, o.prompts[i % o.prompts.length]));
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(o.concurrency, o.n)) }, worker));
  const wallMs = Date.now() - t0;
  const ok = calls.filter((c) => c.ok);
  const errors: Record<string, number> = {};
  for (const c of calls) if (!c.ok) errors[String(c.status || c.error)] = (errors[String(c.status || c.error)] ?? 0) + 1;
  const providers: Record<string, number> = {};
  for (const c of ok) if (c.provider) providers[c.provider] = (providers[c.provider] ?? 0) + 1;
  const lat = ok.map((c) => c.latencyMs);
  const ttft = ok.map((c) => c.ttftMs).filter((x): x is number => x != null);
  const mean = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : 0);
  const prompt = ok.reduce((a, c) => a + c.promptTokens, 0);
  const report: BenchReport = {
    url: o.url, model: o.model, n: o.n, concurrency: o.concurrency,
    settings: {
      maxTokens: o.maxTokens ?? null, reasoningEffort: o.reasoningEffort || null, providerSort: o.providerSort || null, providerOrder: o.providerOrder ?? [],
      allowFallbacks: o.providerOrder?.length ? o.allowFallbacks !== false : null, stream: o.stream !== false, jsonMode: o.jsonMode !== false,
    },
    ok: ok.length, errors, wallMs,
    requestsPerSec: Math.round((ok.length / (wallMs / 1000)) * 100) / 100,
    outputTokensPerSec: Math.round((ok.reduce((a, c) => a + c.completionTokens, 0) / (wallMs / 1000)) * 10) / 10,
    latencyMs: { p50: percentile(lat, 50), p90: percentile(lat, 90), p99: percentile(lat, 99), mean: lat.length ? mean(lat) : null },
    ttftMs: { p50: percentile(ttft, 50), p90: percentile(ttft, 90), p99: percentile(ttft, 99) },
    promptTokensMean: mean(ok.map((c) => c.promptTokens)),
    completionTokensMean: mean(ok.map((c) => c.completionTokens)),
    reasoningTokensMean: mean(ok.map((c) => c.reasoningTokens)),
    cacheHitRate: prompt ? Math.round((ok.reduce((a, c) => a + c.cachedTokens, 0) / prompt) * 1000) / 1000 : 0,
    providers,
  };
  return { report, calls };
}

export function formatReport(r: BenchReport): string {
  const s = (ms: number | null) => (ms == null ? "-" : `${(ms / 1000).toFixed(2)}s`);
  return [
    `${r.model} @ ${r.url}  n=${r.n} concurrency=${r.concurrency}  ok=${r.ok}  errors=${JSON.stringify(r.errors)}`,
    `latency  p50 ${s(r.latencyMs.p50)}  p90 ${s(r.latencyMs.p90)}  p99 ${s(r.latencyMs.p99)}`,
    `ttft     p50 ${s(r.ttftMs.p50)}  p90 ${s(r.ttftMs.p90)}  p99 ${s(r.ttftMs.p99)}`,
    `throughput ${r.requestsPerSec} req/s, ${r.outputTokensPerSec} output tok/s over ${(r.wallMs / 1000).toFixed(1)}s`,
    `tokens/call: prompt ${r.promptTokensMean}, completion ${r.completionTokensMean} (reasoning ${r.reasoningTokensMean}); cache hit ${(r.cacheHitRate * 100).toFixed(1)}%`,
    `served by ${JSON.stringify(r.providers)}`,
  ].join("\n");
}

async function main() {
  const argv = process.argv.slice(2);
  const files: string[] = [];
  const opt: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const [k, v] = argv[i].slice(2).split("=", 2);
      opt[k] = v ?? argv[++i] ?? "";
    } else files.push(argv[i]);
  }
  if (!opt.url || !opt.model || !files.length) {
    console.error("usage: bench-endpoint.ts --url <base url> --model <id> [--n 50] [--concurrency 4] [options] <llm.jsonl>...");
    process.exit(2);
  }
  const { report } = await runBench({
    url: opt.url, model: opt.model, key: opt.key ?? process.env.LLM_API_KEY ?? process.env.OPENROUTER_API_KEY,
    prompts: promptsFromLogs(files), n: Number(opt.n ?? 50), concurrency: Number(opt.concurrency ?? 4),
    maxTokens: opt["max-tokens"] ? Number(opt["max-tokens"]) : undefined, reasoningEffort: opt.reasoning,
    providerSort: opt["provider-sort"], providerOrder: opt["provider-order"]?.split(",").map((x) => x.trim()).filter(Boolean),
    allowFallbacks: opt["allow-fallbacks"] != null ? opt["allow-fallbacks"] !== "0" : undefined,
    stream: opt.stream !== "0", jsonMode: opt["json-mode"] !== "0",
  });
  console.log(formatReport(report));
  if (opt.out) writeFileSync(opt.out, JSON.stringify(report, null, 2) + "\n");
}

if (process.argv[1]?.endsWith("bench-endpoint.ts")) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
