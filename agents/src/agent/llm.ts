// Minimal OpenAI-compatible chat client (OpenRouter by default).

import type { Config } from "../config.ts";
import type { LlmStatus } from "../api-types.ts";
import { cleanPhrase } from "../safety.ts";
import { replayFields, requestForLog } from "./replaylog.ts";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
  /**
   * Static text worth caching (same on every call). System messages count as
   * cacheable unless this is false. See wireMessages().
   */
  cache?: boolean;
}

export interface LlmResult {
  text: string;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  latencyMs: number;
  model: string;
  finishReason: string | null;
  /** prompt tokens read from the provider's cache (usage.prompt_tokens_details.cached_tokens); 0 if not reported */
  cachedTokens?: number;
  /** prompt tokens written to the cache (usage.prompt_tokens_details.cache_write_tokens); 0 if not reported */
  cacheWriteTokens?: number;
  /** hidden reasoning tokens (usage.completion_tokens_details.reasoning_tokens); 0 if not reported */
  reasoningTokens?: number;
  /**
   * The model's reasoning text when the provider returns it (message.reasoning,
   * else the text/summary parts of message.reasoning_details); null when absent
   * or LLM_CAPTURE_REASONING=0. Untrusted model output, like `text`.
   */
  reasoningText?: string | null;
  /** ms from request to the first streamed token (LLM_STREAM=1); null when not streamed */
  ttftMs?: number | null;
  /** the upstream provider that served the call (OpenRouter's top-level `provider`), if reported */
  provider?: string | null;
  /** the messages exactly as sent (wireMessages), for replay logging */
  sentMessages?: unknown[];
  /** the request body as finally sent, minus messages (requestForLog: no credentials) */
  request?: Record<string, unknown>;
  /** the model the server reports (the response's `model`), null if absent */
  servedModel?: string | null;
}

/**
 * The per-call fields for an llm.jsonl line: tokens (incl. cached and
 * reasoning), cost, latency, model, the raw reasoning text (untrimmed and
 * uncapped, for exact replay; omitted when there is none) and the replay
 * fields (replaylog.ts: systemSha, messages, content, request, servedModel).
 * runDir: where prompts/<sha>.txt go (the run's log dir); null = none written.
 */
export function llmLogFields(r: LlmResult, runDir: string | null = null) {
  return {
    latencyMs: r.latencyMs, promptTokens: r.promptTokens, completionTokens: r.completionTokens,
    cachedTokens: r.cachedTokens ?? 0, cacheWriteTokens: r.cacheWriteTokens ?? 0, reasoningTokens: r.reasoningTokens ?? 0,
    costUsd: r.costUsd, model: r.model, provider: r.provider ?? null, ttftMs: r.ttftMs ?? null,
    ...(r.reasoningText ? { reasoning: r.reasoningText } : {}),
    ...replayFields(r, runDir),
  };
}

/** Models that only cache with explicit cache_control breakpoints through OpenRouter. */
export function needsExplicitCache(model: string): boolean {
  return /^~?(anthropic\/|google\/gemini)/.test(model);
}

/**
 * Messages as sent. For models that need explicit breakpoints, the last
 * cacheable message (the static system prompt) becomes a content-part array
 * with cache_control {type: "ephemeral"} (OpenRouter's documented format;
 * Gemini only uses the last breakpoint, Anthropic allows four). Other models
 * cache implicitly and get plain strings, which every OpenAI-compatible
 * endpoint accepts. The text is never changed.
 */
export function wireMessages(messages: ChatMessage[], model: string, cache: boolean): unknown[] {
  let mark = -1;
  if (cache && needsExplicitCache(model)) {
    messages.forEach((m, i) => {
      if (m.cache ?? m.role === "system") mark = i;
    });
  }
  return messages.map((m, i) =>
    i === mark
      ? { role: m.role, content: [{ type: "text", text: m.content, cache_control: { type: "ephemeral" } }] }
      : { role: m.role, content: m.content },
  );
}

/** Reasoning text from an OpenRouter chat message, or null. */
export function reasoningOf(message: any): string | null {
  if (typeof message?.reasoning === "string" && message.reasoning.trim()) return message.reasoning;
  // vLLM's reasoning parser
  if (typeof message?.reasoning_content === "string" && message.reasoning_content.trim()) return message.reasoning_content;
  const details = message?.reasoning_details;
  if (Array.isArray(details)) {
    const parts = details
      .map((d: any) => (d?.type === "reasoning.text" ? d.text : d?.type === "reasoning.summary" ? d.summary : null))
      .filter((t: unknown): t is string => typeof t === "string" && t.length > 0);
    if (parts.length) return parts.join("\n");
  }
  return null;
}

/** Optional spend hooks shared across runs (rolling daily cap, ledger). */
export interface SpendGate {
  /** called with the cost of every successful call */
  onCost(usd: number): void;
  /** non-null = LLM calls are paused, with the reason */
  pausedReason(): string | null;
}

/** HTTP failure from the provider (status kept for backoff decisions). */
export class LlmHttpError extends Error {
  constructor(readonly status: number, message: string, readonly retryAfterMs: number | null = null) {
    super(message);
  }
}

const SEC = 1000;
const MIN = 60 * SEC;

/**
 * Provider health, shared by every LLM caller (agents, narrator, director,
 * story) and across runs. After a failed call, no call is made until
 * retryAt; then exactly one probe call goes out (others keep waiting), and
 * its outcome resets or extends the backoff. Delays double per consecutive
 * failure:
 * - 401/402/403 (bad key, out of credits): 1 min, up to 30 min
 * - 429: the provider's Retry-After, else 5 s, up to 5 min
 * - 5xx, timeouts, network errors: 2 s, up to 5 min
 */
export class LlmHealth {
  private ok = true;
  private since: number | null = null;
  private lastError: string | null = null;
  private failures = 0;
  private retryAt: number | null = null;
  private probing = false;
  /** first outage-class failure (see isOutageStatus) of the current failing streak */
  private outageStart: number | null = null;

  constructor(private now: () => number = Date.now) {}

  /** true = don't call the provider now */
  get unavailable(): boolean {
    if (this.retryAt != null && this.now() < this.retryAt) return true;
    return !this.ok && this.probing;
  }

  /** claim the call slot; false = backing off (or another probe is in flight) */
  begin(): boolean {
    if (this.unavailable) return false;
    if (!this.ok) this.probing = true;
    return true;
  }

  success() {
    if (!this.ok) this.since = this.now();
    this.ok = true;
    this.failures = 0;
    this.retryAt = null;
    this.probing = false;
    this.outageStart = null;
  }

  failure(e: unknown) {
    const now = this.now();
    if (this.ok || this.since == null) this.since = now;
    this.ok = false;
    this.probing = false;
    this.failures++;
    this.lastError = describeLlmError(e);
    const n = Math.min(this.failures - 1, 20);
    const status = e instanceof LlmHttpError ? e.status : 0;
    if (this.outageStart == null && isOutageStatus(status)) this.outageStart = now;
    let delay: number;
    if (status === 401 || status === 402 || status === 403) delay = Math.min(30 * MIN, MIN * 2 ** n);
    else if (status === 429) delay = Math.min(5 * MIN, (e as LlmHttpError).retryAfterMs ?? 5 * SEC * 2 ** n);
    else delay = Math.min(5 * MIN, 2 * SEC * 2 ** n);
    this.retryAt = now + delay;
  }

  /** ms epoch when the current outage began (see isOutageStatus); null while ok or failing only with 429 / other 4xx */
  get outageSince(): number | null {
    return this.ok ? null : this.outageStart;
  }

  status(): LlmStatus {
    return {
      ok: this.ok, lastError: this.lastError, since: this.since, consecutiveFailures: this.failures, retryAt: this.ok ? null : this.retryAt,
      outageSince: this.outageSince,
    };
  }
}

/**
 * Failures that mean the provider can't serve us (they count toward the
 * outage pause, LLM_OUTAGE_PAUSE_S): bad key / no credits (401, 402, 403),
 * server errors (5xx), a missing endpoint (404, e.g. a terminated GPU pod), and
 * timeouts / network errors (status 0). Not 429 (slow down) or other 4xx (a bad request).
 */
export function isOutageStatus(status: number): boolean {
  // 404: the endpoint itself is gone (a terminated GPU pod's proxy), not a bad request
  return status === 401 || status === 402 || status === 403 || status === 404 || status >= 500 || status === 0;
}

/** Short, viewer-safe error text: "HTTP 402: Insufficient credits" (no links, no echoed payloads). */
export function describeLlmError(e: unknown): string {
  if (e instanceof LlmHttpError) return cleanPhrase(`HTTP ${e.status}: ${e.message}`, 160) || `HTTP ${e.status}`;
  const err = e as { name?: string; message?: string; cause?: { code?: string } } | null;
  if (err?.name === "AbortError" || err?.name === "TimeoutError") return "timed out";
  const code = err?.cause?.code;
  return cleanPhrase(code ? `network error (${code})` : err?.message ?? String(e), 160) || "error";
}

/** The provider's error message from a JSON error body, else the raw body start. */
function errorMessage(body: string): string {
  try {
    const j = JSON.parse(body);
    const m = j?.error?.message ?? j?.message;
    if (typeof m === "string") return m.slice(0, 200);
  } catch {
    // not JSON
  }
  return body.slice(0, 200);
}

function retryAfterMs(h: string | null): number | null {
  if (!h) return null;
  const s = Number(h);
  if (Number.isFinite(s) && s >= 0) return s * 1000;
  const t = Date.parse(h);
  return Number.isFinite(t) ? Math.max(0, t - Date.now()) : null;
}

export class Llm {
  totalCost = 0;
  calls = 0;
  failures = 0;
  readonly health: LlmHealth;

  constructor(private cfg: Config, private gate?: SpendGate, health?: LlmHealth, private timeoutMs = 45000) {
    this.health = health ?? new LlmHealth();
  }

  /** per-run cap (MAX_COST_USD) reached; 0 = no cap */
  get overRunBudget() {
    return this.cfg.maxCostUsd > 0 && this.totalCost >= this.cfg.maxCostUsd;
  }

  /** reason LLM calls are paused by the shared gate (rolling daily cap), else null */
  get pausedReason(): string | null {
    return this.gate?.pausedReason() ?? null;
  }

  /** true = make no LLM calls now (per-run cap reached, paused, or backing off after provider failures) */
  get overBudget() {
    return this.overRunBudget || this.pausedReason != null || this.health.unavailable;
  }

  /** Spend from a non-chat call on the same account (the director's Jev decisions): counts toward the run and daily caps. */
  addCost(usd: number) {
    if (!(usd > 0) || !Number.isFinite(usd)) return;
    this.totalCost += usd;
    this.gate?.onCost(usd);
  }

  /**
   * `extra`: optional provider fields merged into the request (e.g. OpenRouter
   * `reasoning`); dropped along with response_format if the provider rejects the request (400).
   */
  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<LlmResult> {
    if (this.overRunBudget || this.pausedReason != null) throw new Error(`LLM calls stopped: ${this.pausedReason ?? "run spend cap reached"}`);
    if (!this.health.begin()) throw new Error(`LLM backing off after errors: ${this.health.status().lastError ?? "unavailable"}`);
    const t0 = Date.now();
    const model = opts.model ?? this.cfg.llmModel;
    const stream = this.cfg.llmStream === true;
    const body: Record<string, unknown> = {
      model,
      messages: wireMessages(messages, model, this.cfg.llmPromptCache ?? true),
      max_tokens: opts.maxTokens ?? this.cfg.llmMaxTokens,
      temperature: 0.8,
      ...(opts.json === false ? {} : { response_format: { type: "json_object" } }),
      usage: { include: true },
      // routing/reasoning config is for the agents' model only; overhead models (narrator, director, story) keep defaults
      ...requestOptions(model === this.cfg.llmModel ? this.cfg : {}, opts),
      ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
      // agent-supplied fields (e.g. the reasoning cap) win over config defaults
      ...(opts.extra ?? {}),
    };
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      const ctl = new AbortController();
      // covers the whole exchange, body included (a stalled body used to hang the caller forever)
      const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
      try {
        const res = await fetch(`${this.cfg.llmBaseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.cfg.llmApiKey}`,
            "x-title": "ohol-agents",
          },
          body: JSON.stringify(body),
          signal: ctl.signal,
        });
        if (!res.ok) {
          const errText = await res.text();
          // some providers reject response_format; retry without it
          const extraKeys = Object.keys(opts.extra ?? {}).filter((k) => k in body);
          if (res.status === 400 && (body.response_format || extraKeys.length)) {
            delete body.response_format;
            for (const k of extraKeys) delete body[k];
            lastErr = new LlmHttpError(400, errorMessage(errText));
            continue;
          }
          throw new LlmHttpError(res.status, errorMessage(errText), retryAfterMs(res.headers.get("retry-after")));
        }
        const { j, ttftMs } = stream ? await readStream(res, t0) : { j: (await res.json()) as any, ttftMs: null };
        const message = j.choices?.[0]?.message;
        const text: string = message?.content ?? "";
        const u = j.usage ?? {};
        const cost = typeof u.cost === "number" ? u.cost : 0;
        this.totalCost += cost;
        this.calls++;
        this.gate?.onCost(cost);
        this.health.success();
        return {
          text,
          promptTokens: u.prompt_tokens ?? 0,
          completionTokens: u.completion_tokens ?? 0,
          costUsd: cost,
          latencyMs: Date.now() - t0,
          // the served id ("m") is reported under its real name (LLM_MODEL_NAME)
          model: (j.model ?? model) === this.cfg.llmModel && this.cfg.llmModelName ? this.cfg.llmModelName : j.model ?? model,
          finishReason: j.choices?.[0]?.finish_reason ?? null,
          cachedTokens: Number(u.prompt_tokens_details?.cached_tokens) || 0,
          cacheWriteTokens: Number(u.prompt_tokens_details?.cache_write_tokens) || 0,
          reasoningTokens: Number(u.completion_tokens_details?.reasoning_tokens) || 0,
          reasoningText: this.cfg.llmCaptureReasoning === false ? null : reasoningOf(message),
          ttftMs,
          provider: typeof j.provider === "string" ? j.provider : null,
          sentMessages: body.messages as unknown[],
          request: requestForLog(body),
          servedModel: typeof j.model === "string" ? j.model : null,
        };
      } catch (e) {
        lastErr = e;
        // only transient errors are worth retrying right away; 4xx (bad key, no credits, rate limit) are not
        if (e instanceof LlmHttpError && e.status < 500) break;
        if (attempt < 2) await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      } finally {
        clearTimeout(timer);
      }
    }
    this.failures++;
    this.health.failure(lastErr);
    throw lastErr;
  }
}

/**
 * Read an SSE chat-completions stream into the non-streaming response shape
 * ({ model, provider, choices: [{ message, finish_reason }], usage }), so the
 * caller parses both the same way. ttftMs = first content or reasoning delta.
 */
export async function readStream(res: Response, t0: number): Promise<{ j: any; ttftMs: number | null }> {
  let content = "";
  let reasoning = "";
  const details: any[] = [];
  let ttftMs: number | null = null;
  const j: any = { choices: [{ message: {}, finish_reason: null }] };
  const decoder = new TextDecoder();
  let buf = "";
  const handle = (line: string) => {
    if (!line.startsWith("data:")) return; // ": OPENROUTER PROCESSING" keep-alives, blank lines
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") return;
    let c: any;
    try {
      c = JSON.parse(data);
    } catch {
      return;
    }
    if (c.error) {
      const code = Number(c.error.code);
      throw new LlmHttpError(Number.isFinite(code) && code >= 400 ? code : 502, String(c.error.message ?? "stream error").slice(0, 200));
    }
    if (c.model) j.model = c.model;
    if (typeof c.provider === "string") j.provider = c.provider;
    if (c.usage) j.usage = c.usage;
    const ch = c.choices?.[0];
    if (!ch) return;
    const d = ch.delta ?? {};
    if (typeof d.reasoning !== "string" && typeof d.reasoning_content === "string") d.reasoning = d.reasoning_content;
    const got = (typeof d.content === "string" && d.content) || (typeof d.reasoning === "string" && d.reasoning) || (Array.isArray(d.reasoning_details) && d.reasoning_details.length);
    if (got && ttftMs == null) ttftMs = Date.now() - t0;
    if (typeof d.content === "string") content += d.content;
    if (typeof d.reasoning === "string") reasoning += d.reasoning;
    if (Array.isArray(d.reasoning_details)) details.push(...d.reasoning_details);
    if (ch.finish_reason) j.choices[0].finish_reason = ch.finish_reason;
  };
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      handle(buf.slice(0, i).replace(/\r$/, ""));
      buf = buf.slice(i + 1);
    }
  }
  if (buf) handle(buf);
  j.choices[0].message = { role: "assistant", content, ...(reasoning ? { reasoning } : {}), ...(details.length ? { reasoning_details: details } : {}) };
  return { j, ttftMs };
}

/** Per-call options. reasoning / provider override the config (LLM_REASONING_EFFORT, LLM_PROVIDER_*); null = send none. */
export interface ChatOptions {
  maxTokens?: number;
  model?: string;
  json?: boolean;
  /** OpenRouter `reasoning` object, e.g. { effort: "low" } or { max_tokens: 200 } */
  reasoning?: Record<string, unknown> | null;
  /** OpenRouter `provider` routing object, e.g. { sort: "throughput" } */
  provider?: Record<string, unknown> | null;
  /** extra provider fields merged last into the request (dropped on a 400 like response_format) */
  extra?: Record<string, unknown>;
}

/**
 * OpenRouter request extras from config, added only when set (so a plain
 * OpenAI-compatible endpoint sees an unchanged request):
 * - LLM_REASONING_EFFORT -> reasoning: { effort } ("off" is sent as "none";
 *   mandatory-reasoning models reject "none")
 * - LLM_PROVIDER_SORT / LLM_PROVIDER_ORDER / LLM_PROVIDER_ALLOW_FALLBACKS -> provider: { sort, order, allow_fallbacks }
 */
export function requestOptions(
  cfg: Partial<Pick<Config, "llmReasoningEffort" | "llmProviderSort" | "llmProviderOrder" | "llmProviderAllowFallbacks">>,
  opts: Pick<ChatOptions, "reasoning" | "provider"> = {},
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const effort = cfg.llmReasoningEffort?.trim();
  const reasoning = opts.reasoning !== undefined ? opts.reasoning : effort ? { effort: effort === "off" ? "none" : effort } : null;
  if (reasoning) out.reasoning = reasoning;
  let provider = opts.provider !== undefined ? opts.provider : null;
  if (opts.provider === undefined) {
    const p: Record<string, unknown> = {};
    if (cfg.llmProviderSort) p.sort = cfg.llmProviderSort;
    if (cfg.llmProviderOrder?.length) {
      p.order = cfg.llmProviderOrder;
      p.allow_fallbacks = cfg.llmProviderAllowFallbacks !== false;
    }
    if (Object.keys(p).length) provider = p;
  }
  if (provider) out.provider = provider;
  return out;
}

/** Pull the first JSON object out of a model reply. */
export function parseJsonReply(text: string): any {
  const t = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try {
    return JSON.parse(t);
  } catch {
    const s = t.indexOf("{");
    const e = t.lastIndexOf("}");
    if (s >= 0 && e > s) return JSON.parse(t.slice(s, e + 1));
    throw new Error("no JSON in reply");
  }
}
