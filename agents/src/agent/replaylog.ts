// Replay-grade llm.jsonl fields: enough to rebuild each agent call exactly
// offline (teacher-forced activation analysis). See docs/data-format.md
// "Replaying a call".
//
// - each distinct system prompt is written once to <run dir>/prompts/<sha256>.txt;
//   the log line carries its sha and the message list with the system text
//   replaced by {role: "system", sha};
// - the raw assistant content and the exact request parameters (no credentials:
//   the key only ever goes in the Authorization header, never in the body);
// - serving.json per run dir: what we know about the serving endpoint.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Config } from "../config.ts";
import type { LlmResult } from "./llm.ts";

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** "<dir>\0<sha>" already on disk (or found there) in this process */
const written = new Set<string>();

/**
 * Write `text` to <dir>/prompts/<sha>.txt once (atomic: temp file + rename;
 * the temp name ends in .tmp, which the backup skips). Returns the sha.
 * Never throws: a failed write only costs the dedup file, not the decision.
 */
export function savePrompt(dir: string, text: string): string {
  const sha = sha256(text);
  const key = `${dir}\0${sha}`;
  if (written.has(key)) return sha;
  try {
    const pdir = path.join(dir, "prompts");
    const file = path.join(pdir, `${sha}.txt`);
    if (!existsSync(file)) {
      mkdirSync(pdir, { recursive: true });
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
      writeFileSync(tmp, text, "utf8");
      renameSync(tmp, file);
    }
    written.add(key);
  } catch (e) {
    console.error("prompt log write failed", (e as Error).message);
  }
  return sha;
}

/** text of a message's content: a string, or the text parts of a content-part array (cache_control breakpoints) */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p: any) => (typeof p?.text === "string" ? p.text : "")).join("");
  return String(content ?? "");
}

/**
 * The replay fields of one call: systemSha, messages (as sent, system text
 * replaced by its sha; a content-part system message is marked parts: true),
 * content (raw assistant content), request (the body minus messages) and
 * servedModel (the response's `model`). dir = the run dir for prompts/; null
 * = no prompt files (the sha is still logged). Empty when the result has no
 * wire record (fakes in tests).
 */
export function replayFields(r: LlmResult, dir: string | null) {
  if (!r.sentMessages) return {};
  let systemSha: string | undefined;
  const messages = r.sentMessages.map((m: any) => {
    if (m?.role !== "system") return m;
    const text = contentText(m.content);
    const sha = dir ? savePrompt(dir, text) : sha256(text);
    systemSha ??= sha;
    return { role: "system", sha, ...(Array.isArray(m.content) ? { parts: true } : {}) };
  });
  return { systemSha: systemSha ?? null, messages, content: r.text, request: r.request ?? null, servedModel: r.servedModel ?? null };
}

/** the request body as logged: everything but messages; credentials never enter the body, but drop any key-like field defensively */
export function requestForLog(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (k === "messages" || /authorization|api[_-]?key|secret|password/i.test(k)) continue;
    out[k] = v;
  }
  return out;
}

// --- serving.json

let modelsOnce: Promise<unknown> | null = null;
const servingWritten = new Set<string>();

/** vLLM's /v1/models (id, root, max_model_len per model), fetched once per process with the agents' key */
function fetchModels(cfg: Pick<Config, "llmBaseUrl" | "llmApiKey">): Promise<unknown> {
  modelsOnce ??= (async () => {
    try {
      const res = await fetch(`${cfg.llmBaseUrl}/models`, { headers: { authorization: `Bearer ${cfg.llmApiKey}` }, signal: AbortSignal.timeout(10_000) });
      if (!res.ok) return { error: `HTTP ${res.status}` };
      const j = (await res.json()) as any;
      return (Array.isArray(j?.data) ? j.data : []).map((m: any) => ({ id: m?.id ?? null, root: m?.root ?? null, max_model_len: m?.max_model_len ?? null }));
    } catch (e) {
      return { error: (e as Error).name === "TimeoutError" ? "timed out" : String((e as Error).message ?? e).slice(0, 200) };
    }
  })();
  return modelsOnce;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/**
 * Write <dir>/serving.json once per run dir: the agents' endpoint host (no
 * path, query or key), LLM_MODEL as sent, LLM_MODEL_NAME, the reasoning
 * style, quantization (LLM_QUANTIZATION, else "fp8" when the model name says
 * FP8, else null) and, for a self-hosted (vLLM-style) endpoint, /v1/models.
 * Fire and forget; never throws.
 */
export async function writeServing(dir: string, cfg: Config, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (servingWritten.has(dir)) return;
  servingWritten.add(dir);
  try {
    const selfHosted = cfg.llmReasoningStyle === "vllm" && !/openrouter\.ai/.test(cfg.llmBaseUrl);
    const models = selfHosted ? await fetchModels(cfg) : null;
    const names = [cfg.llmModelName, cfg.llmModel, ...(Array.isArray(models) ? models.flatMap((m: any) => [m.id, m.root]) : [])].filter((s): s is string => typeof s === "string");
    const quantization = env.LLM_QUANTIZATION || (names.some((n) => /fp8/i.test(n)) ? "fp8" : null);
    const rec = {
      writtenAt: new Date().toISOString(),
      pid: process.pid,
      baseUrlHost: hostOf(cfg.llmBaseUrl),
      model: cfg.llmModel,
      llmModelName: env.LLM_MODEL_NAME ?? null,
      modelName: cfg.llmModelName,
      reasoningStyle: cfg.llmReasoningStyle ?? null,
      quantization,
      models,
    };
    const file = path.join(dir, "serving.json");
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(rec, null, 2) + "\n");
    renameSync(tmp, file);
  } catch (e) {
    console.error("serving.json write failed", (e as Error).message);
  }
}
