// Tester mode (TESTER_GOALS): a short test run where each family is given an
// ordered list of tech goals, to find interface and prompt problems along the
// tech tree. Off (no goals) = nothing here changes the prompt, the reply
// format or behaviour.
//
// - Each family (lineage) gets one task list: the run's lineage founders (Eves),
//   in founding order, take lists 0, 1, 2, ... round-robin (LifeBook.founderIndex).
// - The list goes into the observation (testTaskLine), never the system prompt,
//   so the system prompt stays cacheable; the reply format gains "issue".
// - A reply's "issue" is logged as an "issue" run event and to issues.jsonl.

import { cleanText } from "../safety.ts";

/** max length of a reply's "issue" */
export const ISSUE_CHARS = 500;

/** The reply-format field added in tester mode (prompt.ts replyFormat). */
export const ISSUE_FIELD = `"issue":"optional: anything about the game or its controls that seems wrong, confusing, or is blocking you"`;

/**
 * TESTER_GOALS: a JSON array of strings, one task list per family. Unset,
 * empty or invalid = [] (feature off; invalid is reported on stderr).
 */
export function parseTesterGoals(raw: string | undefined, warn: (msg: string) => void = console.error): string[] {
  if (!raw || !raw.trim()) return [];
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch (e) {
    warn(`TESTER_GOALS is not valid JSON (${(e as Error).message}); tester mode is OFF`);
    return [];
  }
  if (!Array.isArray(v) || !v.every((s) => typeof s === "string")) {
    warn(`TESTER_GOALS must be a JSON array of strings; tester mode is OFF`);
    return [];
  }
  return v.map((s: string) => s.trim()).filter(Boolean);
}

/** The task list for a family's founding position (0 = the run's first Eve). */
export function taskFor(goals: readonly string[], founderIndex: number | null): string | null {
  if (!goals.length || founderIndex == null || founderIndex < 0) return null;
  return goals[founderIndex % goals.length];
}

/** The observation's first line in tester mode. */
export function testTaskLine(task: string): string {
  const list = task.trim().replace(/[.\s]+$/, "");
  return `TEST TASK (this is a test run of the game): your family's task list, in order: ${list}. Work through it in order, moving on when one is done. Your family members share this list.`;
}

/** The reply's "issue", cleaned and capped; "" when absent. */
export function parseIssue(reply: Record<string, unknown>): string {
  return cleanText(reply.issue, ISSUE_CHARS);
}
