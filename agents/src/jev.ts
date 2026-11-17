// Minimal client for OpenRouter's Decisions API (alpha), used by the stream
// director with TypeSafe's Jev decision model. Jev answers typed questions
// ("noul" = probability of yes, "choice" = one option + probabilities) about a
// JSON state; it bills input tokens only and returns usage.cost in USD.
// Docs: https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-request.md

export const JEV_DEFAULT_MODEL = "typesafe/jev-1.13";
export const DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";

export type DecisionQuestion =
  | { type: "noul"; instructions?: string; criteria?: { true?: string; false?: string } }
  | { type: "choice"; instructions?: string; criteria: Record<string, string> };

export interface DecisionsRequest {
  model: string;
  state: unknown;
  questions: Record<string, DecisionQuestion>;
}

export interface DecisionsResult {
  /** raw answers, keyed by question name; validate before use */
  answers: Record<string, unknown>;
  usage: { inputTokens: number; outputTokens: number; costUsd: number };
  model: string | null;
  latencyMs: number;
}

/** What the director needs (lets tests inject a fake). */
export interface DecisionsClient {
  decide(req: DecisionsRequest): Promise<DecisionsResult>;
  readonly overBudget: boolean;
}

export interface JevClientOptions {
  apiKey: string;
  url?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** called with usage.cost after each successful call (run spend accounting) */
  onCost?: (usd: number) => void;
  overBudget?: () => boolean;
}

export class JevClient implements DecisionsClient {
  constructor(private o: JevClientOptions) {}

  get overBudget() {
    return this.o.overBudget?.() ?? false;
  }

  /** One request, no retries (the director simply tries again next interval). Throws on HTTP errors or a body without answers. */
  async decide(req: DecisionsRequest): Promise<DecisionsResult> {
    const t0 = Date.now();
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.o.timeoutMs ?? 20000);
    try {
      const res = await (this.o.fetch ?? fetch)(this.o.url ?? DECISIONS_URL, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.o.apiKey}`, "x-title": "ohol-agents" },
        body: JSON.stringify(req),
        signal: ctl.signal,
      });
      if (!res.ok) {
        const t = await res.text().catch(() => "");
        let msg = t;
        try {
          msg = String(JSON.parse(t)?.error?.message ?? t);
        } catch {
          // not JSON
        }
        throw new Error(`Jev HTTP ${res.status}: ${msg.slice(0, 200)}`);
      }
      const j = (await res.json()) as any;
      if (!j || typeof j.answers !== "object" || j.answers === null || Array.isArray(j.answers)) throw new Error("Jev response has no answers object");
      const u = j.usage ?? {};
      const costUsd = typeof u.cost === "number" && Number.isFinite(u.cost) && u.cost > 0 ? u.cost : 0;
      if (costUsd) this.o.onCost?.(costUsd);
      return {
        answers: j.answers,
        usage: { inputTokens: Number(u.input_tokens) || 0, outputTokens: Number(u.output_tokens) || 0, costUsd },
        model: typeof j.model === "string" ? j.model : null,
        latencyMs: Date.now() - t0,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
