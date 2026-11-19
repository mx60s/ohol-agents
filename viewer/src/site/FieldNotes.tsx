// Field notes (home page): a researcher's write-up of the current run every 20 minutes.
// The newest in full; "Show all field notes (N)" expands the earlier ones, newest first.
// Text renders as React text nodes (escaped), split into paragraphs and bullet lists.

import { useState } from "react";
import type { FieldNote } from "../api-types.ts";
import { useFieldNotes } from "../data/index.ts";
import { FIELD_NOTES_EMPTY, noteBlocks, noteTimeLabel } from "./fieldnotes.ts";
import { Note } from "./ui.tsx";

function NoteText({ text }: { text: string }) {
  return (
    <div className="fn-text ugc">
      {noteBlocks(text).map((b, i) =>
        b.kind === "p" ? (
          <p key={i}>{b.text}</p>
        ) : (
          <ul key={i}>
            {b.items.map((x, j) => (
              <li key={j}>{x}</li>
            ))}
          </ul>
        ),
      )}
    </div>
  );
}

function OneNote({ n, latest }: { n: FieldNote; latest?: boolean }) {
  return (
    <article className={latest ? "fn-note is-latest" : "fn-note"}>
      <time className="fn-time" dateTime={new Date(n.t).toISOString()} title={new Date(n.t).toLocaleString()}>
        {noteTimeLabel(n)}
      </time>
      <NoteText text={n.text} />
    </article>
  );
}

export function FieldNotes() {
  const { notes, loading, error } = useFieldNotes();
  const [open, setOpen] = useState(false);
  if (!notes.length) return <Note>{loading ? "Loading…" : error ? "Can't load the field notes right now." : FIELD_NOTES_EMPTY}</Note>;
  const [latest, ...older] = notes;
  return (
    <div className="fn">
      <OneNote n={latest} latest />
      {older.length > 0 && (
        <>
          <button type="button" className="btn is-ghost sm fn-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? "Hide earlier field notes" : `Show all field notes (${notes.length})`}
          </button>
          {open && (
            <div className="fn-older">
              {older.map((n) => (
                <OneNote key={`${n.windowEnd}`} n={n} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
