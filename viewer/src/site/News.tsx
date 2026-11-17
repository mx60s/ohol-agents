// World news (the narrator's lines, newest first, paged) and the story so far (every version, paged).

import { useMemo, useState } from "react";
import { useNow, useStory, useWorldState } from "../data/index.ts";
import { formatClock, formatRelative } from "../shared/index.ts";
import { Note, Pager } from "./ui.tsx";

export function WorldNews({ pageSize = 5 }: { pageSize?: number }) {
  const w = useWorldState();
  const now = useNow(15_000);
  const [page, setPage] = useState(0);
  const items = useMemo(() => w.events.filter((e) => e.kind === "narration" && e.text.trim()).reverse(), [w.events]);
  const pages = Math.max(1, Math.ceil(items.length / pageSize));
  const p = Math.min(page, pages - 1);
  if (!items.length) {
    return <Note>{w.connection === "offline" ? "Can't reach the world right now." : w.connection === "connecting" ? "Loading…" : "No news yet."}</Note>;
  }
  return (
    <>
      <ul className="news-list">
        {items.slice(p * pageSize, p * pageSize + pageSize).map((e) => (
          <li key={e.seq}>
            <time dateTime={new Date(e.t).toISOString()} title={new Date(e.t).toLocaleString()}>
              {formatClock(e.t)} · {formatRelative(e.t, now)}
            </time>
            <span className="ugc">{e.text}</span>
          </li>
        ))}
      </ul>
      <Pager page={p} pages={pages} onPage={setPage} />
    </>
  );
}

/** The current story so far, with older versions one page back each. */
export function StorySoFar() {
  const story = useStory(200);
  const now = useNow(30_000);
  const [i, setI] = useState(0);
  const n = story.history.length;
  if (!n) return <Note>{story.loading ? "Loading…" : story.error ? "Can't load the story right now." : "The story hasn't started yet."}</Note>;
  const k = Math.min(i, n - 1);
  const v = story.history[k];
  return (
    <div className="story">
      <p className="story-p ugc">{v.text}</p>
      <div className="story-foot">
        <span className="muted">
          {k === 0 ? "Latest" : `Version ${n - k} of ${n}`} · {formatClock(v.updatedAt)} · {formatRelative(v.updatedAt, now)}
        </span>
        {n > 1 && (
          <span className="story-nav">
            <button type="button" className="btn is-ghost sm" disabled={k >= n - 1} onClick={() => setI(k + 1)}>
              ← Older
            </button>
            <button type="button" className="btn is-ghost sm" disabled={k <= 0} onClick={() => setI(k - 1)}>
              Newer →
            </button>
          </span>
        )}
      </div>
    </div>
  );
}
