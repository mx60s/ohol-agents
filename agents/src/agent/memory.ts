// Yearly notes by a separate note-taker (replaces the per-turn notebook).
// Every N of the agent's turns (a game year under the turn clock: N * the turn
// length of the game-paced clock; otherwise N decisions) a background call to
// the agents' own model, under a third-person "note-taker" system prompt,
// rewrites the notes of this life from the previous notes plus a transcript
// of the year: the agent's actions and their results, what it saw nearby
// (people, others' doings, animals, births, deaths, naming), game notices,
// and what others said, labelled as claims. The agent's own thoughts are left
// out: summarized, plans and guesses came back as facts. Fire and forget: it
// never delays a decide or act phase, and at most one is in flight per agent.
// A failure, timeout, reply cut by the token limit or reply that is reasoning
// keeps the old notes and the year's transcript for the next try.
//
// Year lines (MEMORY_SUMMARY=years) reuse the same transcript and schedule:
// each completed year becomes ONE line of facts from that year's transcript
// alone (no earlier lines in the input, so nothing compounds), shown as YOUR
// PAST YEARS, the last MEMORY_YEAR_LINES of them. A failed year is retried on
// the next decisions (up to YEAR_LINE_TRIES) and then dropped, never merged
// into the next year. Saved per agent for the current life, like kept.ts.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ChatMessage, LlmResult } from "./llm.ts";
import { cleanText } from "../safety.ts";

/** the notes' headings, in order; a heading with no lines under it is dropped */
export const NOTE_HEADINGS = ["What worked", "What didn't work", "What you learned", "Major life events", "Novel situations"];

export const SUMMARY_SYSTEM =
  `You keep the memory notes for a player in a survival game. From their previous notes and the transcript of their last year, write their notes for this life in second person ("you"), at most 10 short lines under these headings, only what the transcript supports: ${NOTE_HEADINGS.join(" / ")}. Facts only, no advice or plans. Say what people said as said, not as fact. Keep what still matters from the previous notes. If the player asked you to remember things, include them unless the transcript shows they are wrong; for them you may use up to 3 more lines. Reply with the headings and the lines only: each heading on its own line ending with ":", then its lines starting with "- ".`;

/** fact lines in the notes (headings not counted) */
export const MEMORY_MAX_LINES = 10;
/** extra fact lines allowed when the player asked to remember things (one per item, up to this) */
export const REMEMBER_EXTRA_LINES = 3;
/** "remember" items kept between notes updates (oldest dropped first) */
export const REMEMBER_MAX = 8;
export const MEMORY_LINE_CHARS = 160;
/** a year line's length (models write ~170-200; 160 cut the outcome off the end) */
export const YEAR_LINE_CHARS = 240;
/** input budget for the transcript plus the previous notes (~3,000 tokens at ~4 chars per token) */
export const SUMMARY_INPUT_CHARS = 12_000;
export const SUMMARY_TIMEOUT_MS = 30_000;
/** visible reply room for the notes: 10 lines of 160 chars (13 with remember items) and 5 headings at ~3 chars per token */
export const SUMMARY_REPLY_TOKENS = 800;

export const YEAR_LINE_SYSTEM =
  `You write one line of a player's life record in a survival game. From the transcript of one year of their life, write ONE line in second person ("you"), at most ${YEAR_LINE_CHARS} characters: what they did and made, where, who they were with, and notable events (births, deaths, injuries). You may say at a high level what they were trying to do ("goal:" lines: "you tried to...", "you wanted to...") and whether it worked, failed or was left unfinished. Otherwise only what the transcript shows happened: no advice, guesses, how-to or plans for later. Say what people said as said, not as fact. Reply with the line only.`;
/** visible reply room for one year line (160 chars at ~3 chars per token, with slack) */
export const YEAR_LINE_REPLY_TOKENS = 200;
/** attempts at one year's line before that year is dropped */
export const YEAR_LINE_TRIES = 3;
/** year lines kept per life (only the last MEMORY_YEAR_LINES are shown) */
export const YEAR_LINES_KEPT = 60;
/** finished years waiting for their line (oldest dropped first) */
const YEAR_QUEUE_MAX = 3;

/** max_tokens for a summary call: the reasoning budget plus room for the reply (the notes by default), never below a decision's */
export function summaryMaxTokens(decisionMaxTokens: number, reasoningMaxTokens: number, replyTokens = SUMMARY_REPLY_TOKENS): number {
  return Math.max(decisionMaxTokens, reasoningMaxTokens + replyTokens);
}

/** the reply was cut by the token limit */
function cutOff(r: LlmResult): boolean {
  return r.finishReason === "length" || r.finishReason === "max_tokens";
}

/**
 * The reply reads as the model's reasoning, not lines of facts: an unclosed
 * <think>, or a first line like "Need interpret: ...", "We need to ...",
 * "Okay, so ...", "Let me ...". (r7: such replies were stored as memory.)
 */
export function looksLikeReasoning(text: string): boolean {
  if (/<think>/i.test(text.replace(/<think>[\s\S]*?<\/think>/gi, ""))) return true;
  const first = text.replace(/<think>[\s\S]*?<\/think>/gi, "").split(/\r?\n/).find((l) => l.trim()) ?? "";
  return /^\s*(?:need\b|we need\b|i need\b|we have to\b|we should\b|we must\b|let me\b|let's\b|lets\b|okay\b|ok,|alright\b|hmm\b|so,|wait\b|the user\b|i should\b|i will\b|i'll\b|first,|thinking\b)/i.test(first);
}
/** transcript lines kept between summaries (oldest dropped first) */
const LOG_MAX = 600;
const ENTRY_CHARS = 300;

/** "What worked", "## What worked:", "**What worked**" -> its NOTE_HEADINGS entry; null if not a heading */
function headingOf(line: string): string | null {
  const h = splitHeading(line);
  return h && !h[1] ? h[0] : null;
}

/** "What worked: built a fire" -> ["What worked", "built a fire"]; "What worked:" -> ["What worked", ""]; else null */
function splitHeading(line: string): [string, string] | null {
  const t = line.replace(/^\s*(?:[-*•#]+\s*)?/, "").replace(/\*\*/g, "").replace(/[’]/g, "'").trim();
  for (const h of NOTE_HEADINGS) {
    if (t.slice(0, h.length).toLowerCase() !== h.toLowerCase()) continue;
    const rest = t.slice(h.length);
    if (!rest.trim()) return [h, ""];
    const m = /^\s*:\s*(.*)$/.exec(rest);
    if (m) return [h, m[1].trim()];
  }
  return null;
}

/**
 * The note-taker's reply as notes: headings as "What worked:", facts with bullets and numbering
 * stripped, at most maxLines facts (10, up to 13 with remember items) of 160 chars; a heading with no facts under it is dropped.
 */
export function trimSummary(text: string, maxLines = MEMORY_MAX_LINES): string[] {
  const out: string[] = [];
  let pending: string | null = null;
  let facts = 0;
  for (const raw of text.replace(/<think>[\s\S]*?<\/think>/g, "").split(/\r?\n/)) {
    if (/^\s*```/.test(raw)) continue;
    const sh = splitHeading(raw);
    if (sh) pending = `${sh[0]}:`;
    if (sh && !sh[1]) continue;
    const line = cleanText((sh ? sh[1] : raw).replace(/^\s*(?:[-*•·–—]+|\d+[.)]|#+)\s*/, "").replace(/^\*\*(.*)\*\*$/, "$1"), MEMORY_LINE_CHARS);
    // a fragment with no words (")") is not a fact
    if (!line || !/\p{L}/u.test(line)) continue;
    if (pending) {
      out.push(pending);
      pending = null;
    }
    out.push(line);
    if (++facts >= maxLines) break;
  }
  return out;
}

/**
 * The note-taker's user content: the previous notes, then the year's transcript oldest first
 * (actions and results, what was seen, notices, claims), trimmed oldest first to the budget.
 * Things the player asked to remember come between the two, with how many turns ago each was marked.
 */
export function summaryInput(prev: string[], entries: string[], maxChars = SUMMARY_INPUT_CHARS, remember: { text: string; turnsAgo: number }[] = []): string {
  const notes = prev.length ? `Previous notes:\n${prev.map((l) => (headingOf(l) ? l : `- ${l}`)).join("\n")}\n\n` : "No previous notes for this life.\n\n";
  const asked = remember.length
    ? `Things the player asked to remember (include them in the notes unless the transcript shows they are wrong; you may shorten them):\n${remember.map((r) => `- (${agoText(r.turnsAgo)}) ${r.text}`).join("\n")}\n\n`
    : "";
  return transcriptText(notes + asked, "the last year", entries, maxChars);
}

/** head, then the transcript oldest first, trimmed oldest first so the whole fits maxChars */
function transcriptText(head: string, what: string, entries: string[], maxChars: number): string {
  const title = `Transcript of ${what}, oldest first ("you:" is the player's action and its result; "saw:" happened nearby; "game:" is a game notice; "claim:" is what someone said, not checked; "goal:" is what the player set out to do):\n`;
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

/** one completed year of this life: ages (whole years) at its start and end, and its line */
export interface YearLine {
  from: number;
  to: number;
  text: string;
}

/** "Age 30-31", or "Age 30" when the year started and ended at the same whole age */
export function yearLabel(y: { from: number; to: number }): string {
  return y.to > y.from ? `Age ${y.from}-${y.to}` : `Age ${y.from}`;
}

/** The year-line writer's user content: the ages, then that year's transcript only (no earlier lines). */
export function yearLineInput(from: number, to: number, entries: string[], maxChars = SUMMARY_INPUT_CHARS): string {
  const ages = to > from ? `${from} to ${to}` : `${from}`;
  return transcriptText(`The player's age during this year: ${ages}.\n\n`, "this year", entries, maxChars);
}

/** The writer's reply as one line: the first line with words, bullets, quotes and an echoed "Age 30-31:" label stripped, at most YEAR_LINE_CHARS; "" if none. */
export function trimYearLine(text: string): string {
  for (const raw of text.replace(/<think>[\s\S]*?<\/think>/gi, "").split(/\r?\n/)) {
    if (/^\s*```/.test(raw)) continue;
    let l = raw.replace(/^\s*(?:[-*•·–—]+|\d+[.)]|#+)\s*/, "").replace(/^\*\*(.*)\*\*$/, "$1").trim();
    l = l.replace(/^(?:\*\*)?(?:age|ages|year)\s*\d+(?:\s*(?:-|–|to)\s*\d+)?(?:\*\*)?\s*[:.\-–—]\s*/i, "");
    l = l.replace(/^"(.*)"$/, "$1").replace(/^“(.*)”$/, "$1");
    const line = cleanText(l, YEAR_LINE_CHARS);
    if (line && /\p{L}/u.test(line)) return line;
  }
  return "";
}

/** what is saved per agent for year lines (one file, the current life) */
export interface YearLinesFile {
  playerId: number;
  years: YearLine[];
}

/** where an agent's year lines are saved: LOG_DIR/research/year-lines/<run>/<agent>.json */
export function yearLinesPath(logDir: string, runId: string, agentId: string): string {
  const safe = (s: string) => s.replace(/[^A-Za-z0-9_.-]/g, "_");
  return path.join(logDir, "research", "year-lines", safe(runId), `${safe(agentId)}.json`);
}

function agoText(turns: number): string {
  return turns <= 0 ? "this turn" : turns === 1 ? "1 turn ago" : `${turns} turns ago`;
}

/** near-identical "remember" items match: case, punctuation and spacing ignored */
function rememberKey(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

export interface YearMemoryOptions {
  /** "notes" (MEMORY_SUMMARY=1): rewrite the headed notes; "years" (MEMORY_SUMMARY=years): one line per completed year */
  mode?: "notes" | "years";
  /** years mode: where this life's lines are saved (yearLinesPath); null/absent = not saved */
  yearsFile?: string | null;
  /** summarize every this many turns (MEMORY_SUMMARY_TURNS) */
  everyTurns: number;
  /** turn clock: count turns as time on the game-paced clock (cycleMs per turn) instead of decisions */
  lockstep: boolean;
  cycleMs: number;
  /** the note-taker's model call (the agent's own Llm and model, under the reasoning cap) */
  call: (messages: ChatMessage[]) => Promise<LlmResult>;
  /** each finished attempt, for the log */
  onDone?: (r: { ok: true; input: string; result: LlmResult; memory: string[] } | { ok: false; input: string; error: string }) => void;
  timeoutMs?: number;
}

/** a completed year waiting for its line */
interface YearBatch {
  from: number;
  to: number;
  entries: string[];
  tries: number;
}

export class YearMemory {
  /** this life's notes: heading lines ("What worked:") and facts */
  memory: string[] = [];
  /** the year's transcript, oldest first, each line labelled (you:, saw:, game:, claim:) */
  private entries: string[] = [];
  private inFlight: Promise<void> | null = null;
  /** bumped by reset(): a summary from an earlier life is dropped */
  private gen = 0;
  private decisions = 0;
  private lastAt: number | null = null;
  /** decisions this life (the turn a "remember" item was marked, for "N turns ago") */
  private turns = 0;
  /** what the player asked to remember since the last notes update, oldest first */
  private asked: { text: string; turn: number }[] = [];
  /** years mode: this life's year lines, oldest first */
  years: YearLine[] = [];
  /** years mode: the life (player id) the year lines belong to (saved under it) */
  playerId: number | null = null;
  /** years mode: the whole age when the current year started (null until the first tick with an age) */
  private yearFrom: number | null = null;
  /** years mode: completed years waiting for their line, oldest first */
  private queue: YearBatch[] = [];

  constructor(private o: YearMemoryOptions) {}

  get mode(): "notes" | "years" {
    return this.o.mode ?? "notes";
  }

  get busy() {
    return this.inFlight != null;
  }

  private push(line: string) {
    const l = cleanText(line, ENTRY_CHARS);
    if (!l) return;
    this.entries.push(l);
    if (this.entries.length > LOG_MAX) this.entries.shift();
  }

  /** an action of the agent and its result */
  add(line: string) {
    if (line.trim()) this.push(`you: ${line}`);
  }

  /** the agent set a new goal (the reply's "goal") */
  goal(line: string) {
    if (line.trim()) this.push(`goal: ${line}`);
  }

  /** something the agent saw happen nearby (a WHAT YOU SAW NEARBY line) */
  saw(line: string) {
    if (line.trim()) this.push(`saw: ${line}`);
  }

  /** a game notice */
  notice(line: string) {
    if (line.trim()) this.push(`game: ${line}`);
  }

  /** something another person said (a claim, not a checked fact) */
  heard(line: string) {
    if (line.trim()) this.push(`claim: ${line}`);
  }

  /**
   * The player asked to remember this (the reply's "remember"): kept for the next notes update.
   * A near-identical item is not added twice; past REMEMBER_MAX the oldest is dropped.
   */
  remember(text: string): boolean {
    const t = cleanText(text, MEMORY_LINE_CHARS);
    const key = rememberKey(t);
    if (!key) return false;
    if (this.asked.some((r) => rememberKey(r.text) === key)) return true;
    this.asked.push({ text: t, turn: this.turns });
    if (this.asked.length > REMEMBER_MAX) this.asked.shift();
    return true;
  }

  /** the remember items waiting for the next notes update, oldest first */
  get pendingRemember(): string[] {
    return this.asked.map((r) => r.text);
  }

  /**
   * A new life: no memory, no entries, no remember items, no year lines; an in-flight summary is
   * discarded when it lands. With a player id (years mode) the empty list is saved for that life.
   */
  reset(playerId?: number | null) {
    this.gen++;
    this.memory = [];
    this.entries = [];
    this.asked = [];
    this.turns = 0;
    this.decisions = 0;
    this.lastAt = null;
    this.inFlight = null;
    this.years = [];
    this.yearFrom = null;
    this.queue = [];
    if (playerId !== undefined) {
      this.playerId = playerId;
      this.saveYears();
    }
  }

  /** years mode, the same life after a restart: the year lines saved for it (false if none were saved for this player) */
  restoreYears(playerId: number): boolean {
    this.playerId = playerId;
    this.years = [];
    if (!this.o.yearsFile) return false;
    try {
      const d = JSON.parse(readFileSync(this.o.yearsFile, "utf8")) as YearLinesFile;
      if (d?.playerId !== playerId || !Array.isArray(d.years)) return false;
      for (const y of d.years) if (typeof y?.text === "string" && y.text && Number.isFinite(y.from) && Number.isFinite(y.to)) this.years.push({ from: y.from, to: y.to, text: y.text });
      this.years = this.years.slice(-YEAR_LINES_KEPT);
      return true;
    } catch {
      return false;
    }
  }

  private saveYears() {
    const file = this.o.yearsFile;
    if (this.mode !== "years" || !file || this.playerId == null) return;
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify({ playerId: this.playerId, years: this.years } satisfies YearLinesFile) + "\n");
      renameSync(tmp, file);
    } catch (e) {
      console.error("year lines save failed", e);
    }
  }

  /**
   * Called once per decision (before it). Starts a background summary when a
   * year is due and none is in flight; never awaits it. Returns the started
   * summary's promise (tests), else null. `age` (the character's age in
   * years) labels the year lines in years mode.
   */
  tick(now: number, age?: number): Promise<void> | null {
    this.decisions++;
    this.turns++;
    if (this.lastAt == null) this.lastAt = now;
    const due = this.o.lockstep ? now - this.lastAt >= this.o.everyTurns * this.o.cycleMs : this.decisions >= this.o.everyTurns;
    if (this.mode === "years") return this.tickYears(now, due, age);
    if (!due || this.inFlight || (!this.entries.length && !this.asked.length)) return null;
    this.decisions = 0;
    this.lastAt = now;
    return this.start();
  }

  /** years mode: a due year is cut off with its transcript and queued; the oldest queued year gets its line when none is in flight */
  private tickYears(now: number, due: boolean, age?: number): Promise<void> | null {
    const whole = age != null && Number.isFinite(age) ? Math.max(0, Math.floor(age)) : null;
    if (this.yearFrom == null) this.yearFrom = whole;
    if (due) {
      const from = this.yearFrom ?? whole ?? 0;
      const to = Math.max(from, whole ?? from);
      const entries = this.entries.splice(0);
      // a year with nothing in its transcript gets no line
      if (entries.length) {
        this.queue.push({ from, to, entries, tries: 0 });
        if (this.queue.length > YEAR_QUEUE_MAX) this.queue.shift();
      }
      this.decisions = 0;
      this.lastAt = now;
      this.yearFrom = whole ?? to;
    }
    if (this.inFlight || !this.queue.length) return null;
    return this.startYear(this.queue[0]);
  }

  private startYear(batch: YearBatch): Promise<void> {
    const input = yearLineInput(batch.from, batch.to, batch.entries);
    return this.run([
      { role: "system", content: YEAR_LINE_SYSTEM },
      { role: "user", content: input },
    ], input, (text) => {
      const line = trimYearLine(text);
      if (!line) throw new Error("empty year line");
      this.years.push({ from: batch.from, to: batch.to, text: line });
      if (this.years.length > YEAR_LINES_KEPT) this.years.shift();
      this.queue = this.queue.filter((b) => b !== batch);
      this.saveYears();
      return [`${yearLabel(batch)}: ${line}`];
    }, () => {
      // retried on the next decisions; after YEAR_LINE_TRIES that year gets no line (never merged into the next)
      if (++batch.tries >= YEAR_LINE_TRIES) this.queue = this.queue.filter((b) => b !== batch);
    });
  }

  private start(): Promise<void> {
    const taken = this.entries.splice(0);
    // remember items stay pending until a notes update with them succeeds
    const asked = this.asked.slice();
    const input = summaryInput(this.memory, taken, SUMMARY_INPUT_CHARS, asked.map((r) => ({ text: r.text, turnsAgo: this.turns - r.turn })));
    const maxLines = MEMORY_MAX_LINES + Math.min(REMEMBER_EXTRA_LINES, asked.length);
    return this.run([
      { role: "system", content: SUMMARY_SYSTEM },
      { role: "user", content: input },
    ], input, (text) => {
      const lines = trimSummary(text, maxLines);
      if (!lines.length) throw new Error("empty summary");
      this.memory = lines;
      this.asked = this.asked.filter((r) => !asked.includes(r));
      return lines;
    }, () => {
      // keep the old notes; the year's transcript goes back for the next attempt
      this.entries = [...taken, ...this.entries].slice(-LOG_MAX);
    });
  }

  /**
   * One background call: `accept` turns the reply into what is stored (throws if unusable),
   * `failed` restores state after an error. A reply from an earlier life is dropped.
   */
  private run(messages: ChatMessage[], input: string, accept: (text: string) => string[], failed: () => void): Promise<void> {
    const gen = this.gen;
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
        // a reply cut by the token limit or reasoning in place of facts is not stored
        if (cutOff(result)) throw new Error(`summary cut off (finish_reason ${result.finishReason})`);
        if (looksLikeReasoning(result.text)) throw new Error("summary is reasoning, not notes");
        const memory = accept(result.text);
        try {
          this.o.onDone?.({ ok: true, input, result, memory });
        } catch {
          // logging must not undo a good summary
        }
      } catch (e) {
        if (gen !== this.gen) return;
        failed();
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
