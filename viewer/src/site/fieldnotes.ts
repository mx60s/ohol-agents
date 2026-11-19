// Field notes (home page): pure helpers, no React, so node --test can import them.
import type { FieldNote } from "../api-types.ts";

export type NoteBlock = { kind: "p"; text: string } | { kind: "ul"; items: string[] };

export const FIELD_NOTES_EMPTY = "No field notes yet: the first one comes about 20 minutes into a run.";

/**
 * Note text -> paragraphs and bullet lists (rendered as React text nodes, never as HTML).
 * Blank lines separate paragraphs; lines starting "- ", "* " or "• " are bullets; other
 * consecutive lines join into one paragraph.
 */
export function noteBlocks(text: string): NoteBlock[] {
  const out: NoteBlock[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push({ kind: "p", text: para.join(" ") });
    para = [];
  };
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trim();
    const bullet = /^(?:[-*•])\s+(.*)$/.exec(line);
    if (!line) flush();
    else if (bullet) {
      flush();
      const last = out[out.length - 1];
      if (last?.kind === "ul") last.items.push(bullet[1]);
      else out.push({ kind: "ul", items: [bullet[1]] });
    } else {
      // a plain line right after a list starts a new paragraph
      para.push(line);
    }
  }
  flush();
  return out;
}

const parts = (t: number, timeZone?: string) => {
  const s = new Date(t).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true, timeZone }).toLowerCase().replace(/\s+/g, " ");
  const m = /^(\S+) (am|pm)$/.exec(s);
  return m ? { hm: m[1], ap: m[2] } : { hm: s, ap: "" };
};

/** "5:20 pm" */
export function clock12(t: number, timeZone?: string): string {
  const p = parts(t, timeZone);
  return p.ap ? `${p.hm} ${p.ap}` : p.hm;
}

/** "5:00–5:20" (same am/pm), "11:50 am–12:10 pm" (different) */
export function clockRange(a: number, b: number, timeZone?: string): string {
  const x = parts(a, timeZone), y = parts(b, timeZone);
  return x.ap === y.ap ? `${x.hm}–${y.hm}` : `${clock12(a, timeZone)}–${clock12(b, timeZone)}`;
}

/** "5:20 pm · covering 5:00–5:20"; a note spanning over an hour (a run's first) says so */
export function noteTimeLabel(n: FieldNote, timeZone?: string): string {
  const long = n.windowEnd - n.windowStart > 60 * 60_000;
  return `${clock12(n.t, timeZone)} · covering ${long ? "the run so far, " : ""}${clockRange(n.windowStart, n.windowEnd, timeZone)}`;
}
