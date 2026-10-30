// Minimal OpenAI-compatible chat client (OpenRouter by default).

import type { Config } from "../config.ts";

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

export class Llm {
  totalCost = 0;
  calls = 0;
  failures = 0;

  constructor(private cfg: Config) {}

  get overBudget() {
    return this.totalCost >= this.cfg.maxCostUsd;
  }

  async chat(messages: ChatMessage[], opts: { maxTokens?: number; model?: string; json?: boolean } = {}): Promise<LlmResult> {
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
      try {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 45000);
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
        clearTimeout(timer);
        if (!res.ok) {
          const errText = await res.text();
          // some providers reject response_format; retry without it
          if (res.status === 400 && body.response_format) {
            delete body.response_format;
            lastErr = new Error(`400: ${errText.slice(0, 200)}`);
            continue;
          }
          throw new Error(`LLM HTTP ${res.status}: ${errText.slice(0, 300)}`);
        }
        const j: any = await res.json();
        const text: string = j.choices?.[0]?.message?.content ?? "";
        const u = j.usage ?? {};
        const cost = typeof u.cost === "number" ? u.cost : 0;
        this.totalCost += cost;
        this.calls++;
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
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
    this.failures++;
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
