// A free local stand-in for an OpenAI-compatible provider, for end-to-end
// tests of the agents service, the calibration harness and bench-endpoint
// without paid calls.
//
//   npx tsx src/tools/fake-llm.ts [--port 8791] [--latency-ms 800] [--json-error-rate 0.05] [--fail 402]
//   LLM_BASE_URL=http://127.0.0.1:8791 LLM_API_KEY=x npm run dev
//
// Replies with a random simple action (forage / wait / jump) in the agents'
// JSON format, plus usage with cached and reasoning tokens, a reasoning text
// and a `provider`, cost 0. --fail <status> answers every call with that HTTP
// status (e.g. 402 to test the outage pause); POST /fail?status=200 changes
// it at runtime. With "stream": true in the request it answers as SSE like
// OpenRouter: a reasoning delta at once, content after the latency, then a
// usage chunk and [DONE].

import http from "node:http";

export const FAKE_PROVIDER = "FakeHost";

export interface FakeLlmOptions {
  port?: number;
  latencyMs?: number;
  /** extra ms before the first streamed token (the rest of latencyMs comes after it) */
  ttftMs?: number;
  jsonErrorRate?: number;
  failStatus?: number;
  random?: () => number;
}

export function startFakeLlm(o: FakeLlmOptions = {}) {
  const rnd = o.random ?? Math.random;
  let fail = o.failStatus ?? 200;
  let calls = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  const bodies: any[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://x");
      if (url.pathname === "/fail") {
        fail = Number(url.searchParams.get("status") ?? 200);
        return res.end(JSON.stringify({ fail }));
      }
      calls++;
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      res.on("close", () => inFlight--);
      let body: any = {};
      try {
        body = JSON.parse(raw);
      } catch {
        // ignore
      }
      bodies.push(body);
      const ttft = o.ttftMs ?? 0;
      const rest = Math.max(0, (o.latencyMs ?? 0) - ttft);
      setTimeout(() => {
        if (fail !== 200) {
          res.statusCode = fail;
          return res.end(JSON.stringify({ error: { message: `fake provider failing with ${fail}`, code: fail } }));
        }
        const promptChars = JSON.stringify(body.messages ?? "").length;
        const r = rnd();
        const action = r < 0.5 ? { type: "forage" } : r < 0.7 ? { type: "wait", seconds: 3 } : r < 0.85 ? { type: "jump" } : { type: "wait", seconds: 1 };
        const reply = { thought: "fake model: keep eating", say: rnd() < 0.15 ? "HELLO" : undefined, action };
        const content = rnd() < (o.jsonErrorRate ?? 0) ? "I would like to forage now." : JSON.stringify(reply);
        const reasoning = "Fake reasoning: food is low, so forage.";
        const usage = {
          prompt_tokens: Math.round(promptChars / 4), completion_tokens: 60, cost: 0,
          prompt_tokens_details: { cached_tokens: Math.round(promptChars / 8), cache_write_tokens: 0 },
          completion_tokens_details: { reasoning_tokens: 40 },
        };
        const model = body.model ?? "fake";
        if (!body.stream) {
          setTimeout(() => {
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ model, provider: FAKE_PROVIDER, choices: [{ message: { role: "assistant", content, reasoning }, finish_reason: "stop" }], usage }));
          }, rest);
          return;
        }
        res.setHeader("content-type", "text/event-stream");
        res.write(": OPENROUTER PROCESSING\n\n");
        const send = (c: object) => res.write(`data: ${JSON.stringify({ model, provider: FAKE_PROVIDER, ...c })}\n\n`);
        send({ choices: [{ delta: { role: "assistant", reasoning } }] });
        setTimeout(() => {
          const half = Math.ceil(content.length / 2);
          send({ choices: [{ delta: { content: content.slice(0, half) } }] });
          send({ choices: [{ delta: { content: content.slice(half) }, finish_reason: "stop" }] });
          send({ choices: [], usage });
          res.end("data: [DONE]\n\n");
        }, rest);
      }, ttft);
    });
  });
  server.listen(o.port ?? 0, "127.0.0.1");
  return {
    server,
    bodies,
    ready: new Promise<number>((r) => server.once("listening", () => r((server.address() as { port: number }).port))),
    calls: () => calls,
    maxInFlight: () => maxInFlight,
    setFail: (s: number) => (fail = s),
    close: () => (server.closeAllConnections(), server.close()),
  };
}

if (process.argv[1]?.endsWith("fake-llm.ts")) {
  const a = process.argv.slice(2);
  const opt = (k: string, d: number) => {
    const i = a.indexOf(`--${k}`);
    return i >= 0 ? Number(a[i + 1]) : d;
  };
  const f = startFakeLlm({
    port: opt("port", 8791), latencyMs: opt("latency-ms", 800), ttftMs: opt("ttft-ms", 200),
    jsonErrorRate: opt("json-error-rate", 0.05), failStatus: opt("fail", 200),
  });
  f.ready.then((port) => console.log(`fake LLM provider on http://127.0.0.1:${port} (OpenAI-compatible /chat/completions)`));
}
