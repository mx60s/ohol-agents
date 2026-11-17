// Minimal OpenAI-compatible chat client (OpenRouter by default).

import type { Config } from "../config.ts";
import type { LlmStatus } from "../api-types.ts";
import { cleanPhrase } from "../safety.ts";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmResult {
  text: string;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  latencyMs: number;
  model: string;
  finishReason: string | null;
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
    let delay: number;
    if (status === 401 || status === 402 || status === 403) delay = Math.min(30 * MIN, MIN * 2 ** n);
    else if (status === 429) delay = Math.min(5 * MIN, (e as LlmHttpError).retryAfterMs ?? 5 * SEC * 2 ** n);
    else delay = Math.min(5 * MIN, 2 * SEC * 2 ** n);
    this.retryAt = now + delay;
  }

  status(): LlmStatus {
    return { ok: this.ok, lastError: this.lastError, since: this.since, consecutiveFailures: this.failures, retryAt: this.ok ? null : this.retryAt };
  }
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

  async chat(messages: ChatMessage[], opts: { maxTokens?: number; model?: string; json?: boolean } = {}): Promise<LlmResult> {
    if (this.overRunBudget || this.pausedReason != null) throw new Error(`LLM calls stopped: ${this.pausedReason ?? "run spend cap reached"}`);
    if (!this.health.begin()) throw new Error(`LLM backing off after errors: ${this.health.status().lastError ?? "unavailable"}`);
    const t0 = Date.now();
    const model = opts.model ?? this.cfg.llmModel;
    const body: Record<string, unknown> = {
      model,
      messages,
      max_tokens: opts.maxTokens ?? this.cfg.llmMaxTokens,
      temperature: 0.8,
      ...(opts.json === false ? {} : { response_format: { type: "json_object" } }),
      usage: { include: true },
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
          if (res.status === 400 && body.response_format) {
            delete body.response_format;
            lastErr = new LlmHttpError(400, errorMessage(errText));
            continue;
          }
          throw new LlmHttpError(res.status, errorMessage(errText), retryAfterMs(res.headers.get("retry-after")));
        }
        const j: any = await res.json();
        const text: string = j.choices?.[0]?.message?.content ?? "";
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
          model: j.model ?? model,
          finishReason: j.choices?.[0]?.finish_reason ?? null,
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
