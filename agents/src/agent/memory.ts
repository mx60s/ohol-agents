// Yearly memory summary (replaces the per-turn notebook). Every N of the
// agent's turns (a game year under the turn clock: N * the turn length of the
// game-paced clock; otherwise N decisions) a background call rewrites the
// agent's memory of this life from the previous memory plus the year's
// actions, results, heard lines and thoughts. Fire and forget: it never delays
// a decide or act phase, and at most one is in flight per agent. A failure or
// timeout keeps the old memory.

import type { ChatMessage, LlmResult } from "./llm.ts";
import { cleanText } from "../safety.ts";

export const SUMMARY_SYSTEM =
  "Rewrite your memory of this life as at most 8 short lines of facts: where useful things and people are, what worked, what did not work and why, important events. No plans or intentions. Keep what still matters from your previous memory. Reply with the lines only, one fact per line.";

export const MEMORY_MAX_LINES = 8;
export const MEMORY_LINE_CHARS = 160;
/** input budget for the year's entries plus the previous memory (~2,500 tokens at ~4 chars per token) */
export const SUMMARY_INPUT_CHARS = 10_000;
export const SUMMARY_TIMEOUT_MS = 30_000;
/** entries kept between summaries (oldest dropped first) */
const LOG_MAX = 400;
const ENTRY_CHARS = 300;

/** The model's reply as memory lines: bullets and numbering stripped, at most 8 lines of 160 chars. */
export function trimSummary(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.replace(/<think>[\s\S]*?<\/think>/g, "").split(/\r?\n/)) {
    if (/^\s*```/.test(raw)) continue;
    const line = cleanText(raw.replace(/^\s*(?:[-*•·–—]+|\d+[.)]|#+)\s*/, "").replace(/^\*\*(.*)\*\*$/, "$1"), MEMORY_LINE_CHARS);
    if (!line) continue;
    out.push(line);
    if (out.length >= MEMORY_MAX_LINES) break;
  }
  return out;
}

/** The summary call's user content: the previous memory, then the year's entries, oldest trimmed to fit the budget. */
export function summaryInput(prev: string[], entries: string[], maxChars = SUMMARY_INPUT_CHARS): string {
  const head = prev.length ? `Your memory so far:\n${prev.map((l) => `- ${l}`).join("\n")}\n\n` : "You have no memory of this life yet.\n\n";
  const title = "What happened since (oldest first):\n";
  let budget = maxChars - head.length - title.length;
  const kept: string[] = [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const l = `- ${entries[i]}`;
    if (l.length + 1 > budget) break;
    budget -= l.length + 1;
    kept.push(l);
  }
  kept.reverse();
  return head + title + (kept.length ? kept.join("\n") : "- (nothing new)");
}

export interface YearMemoryOptions {
  /** summarize every this many turns (MEMORY_SUMMARY_TURNS) */
  everyTurns: number;
  /** turn clock: count turns as time on the game-paced clock (cycleMs per turn) instead of decisions */
  lockstep: boolean;
  cycleMs: number;
  /** the model call (the agent's own Llm and model, under the reasoning cap) */
  call: (messages: ChatMessage[]) => Promise<LlmResult>;
  /** each finished attempt, for the log */
  onDone?: (r: { ok: true; input: string; result: LlmResult; memory: string[] } | { ok: false; input: string; error: string }) => void;
  timeoutMs?: number;
}

export class YearMemory {
  /** this life's memory, one fact per line */
  memory: string[] = [];
  private entries: string[] = [];
  private inFlight: Promise<void> | null = null;
  /** bumped by reset(): a summary from an earlier life is dropped */
  private gen = 0;
  private decisions = 0;
  private lastAt: number | null = null;

  constructor(private o: YearMemoryOptions) {}

  get busy() {
    return this.inFlight != null;
  }

  /** a year's entry: an action and its result, a heard line, a thought */
  add(line: string) {
    const l = cleanText(line, ENTRY_CHARS);
    if (!l) return;
    this.entries.push(l);
    if (this.entries.length > LOG_MAX) this.entries.shift();
  }

  /** a new life: no memory, no entries; an in-flight summary is discarded when it lands */
  reset() {
    this.gen++;
    this.memory = [];
    this.entries = [];
    this.decisions = 0;
    this.lastAt = null;
    this.inFlight = null;
  }

  /**
   * Called once per decision (before it). Starts a background summary when a
   * year is due and none is in flight; never awaits it. Returns the started
   * summary's promise (tests), else null.
   */
  tick(now: number): Promise<void> | null {
    this.decisions++;
    if (this.lastAt == null) this.lastAt = now;
    const due = this.o.lockstep ? now - this.lastAt >= this.o.everyTurns * this.o.cycleMs : this.decisions >= this.o.everyTurns;
    if (!due || this.inFlight || !this.entries.length) return null;
    this.decisions = 0;
    this.lastAt = now;
    return this.start();
  }

  private start(): Promise<void> {
    const gen = this.gen;
    const taken = this.entries.splice(0);
    const input = summaryInput(this.memory, taken);
    const messages: ChatMessage[] = [
      { role: "system", content: SUMMARY_SYSTEM },
      { role: "user", content: input },
    ];
    const timeoutMs = this.o.timeoutMs ?? SUMMARY_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, rej) => {
      timer = setTimeout(() => rej(new Error(`summary timed out after ${timeoutMs} ms`)), timeoutMs);
    });
    const p = (async () => {
      try {
        // the call is started on a later tick so a synchronous throw can't reach the caller
        await Promise.resolve();
        const result = await Promise.race([this.o.call(messages), timeout]);
        if (gen !== this.gen) return;
        const lines = trimSummary(result.text);
        if (!lines.length) throw new Error("empty summary");
        this.memory = lines;
        try {
          this.o.onDone?.({ ok: true, input, result, memory: lines });
        } catch {
          // logging must not undo a good summary
        }
      } catch (e) {
        if (gen !== this.gen) return;
        // keep the old memory; the year's entries go back for the next attempt
        this.entries = [...taken, ...this.entries].slice(-LOG_MAX);
        try {
          this.o.onDone?.({ ok: false, input, error: String((e as Error)?.message ?? e) });
        } catch {
          // ignore
        }
      } finally {
        clearTimeout(timer);
        if (gen === this.gen) this.inFlight = null;
      }
    })();
    this.inFlight = p;
    return p;
  }
}
