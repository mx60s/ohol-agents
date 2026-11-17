import { useEffect, useMemo, useState } from "react";
import { queryParam, useLineages, useLives } from "../data/index.ts";
import { lineageName } from "../shared/lineage.ts";
import { formatCount } from "../shared/format.ts";
import { MockBadge, SiteLayout } from "../theme/index.ts";
import type { LifeRecord } from "../api-types.ts";
import { ADULT_AGE, computeStudy, dataWindow, MIN_FAMILIES, MIN_N_FOR_CLAIMS, traitTests, verdict, YEAR_MS, type StudyRequest, type StudyResult } from "./analysis.ts";
import { fmt } from "./charts.tsx";
import { downloadText, livesCsv } from "./csv.ts";
import { Ribbon } from "./Figure.tsx";
import { Adulthood, Survival } from "./Q1.tsx";
import { Descendants } from "./Q2.tsx";
import { RoleConcentration, RoleMatrix } from "./Q3.tsx";
import { GenerationStrips, MotherChild, Trajectories } from "./Q4.tsx";
import "./study.css";

let worker: Worker | null | undefined;
function getWorker(): Worker | null {
  if (worker === undefined) {
    try {
      worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    } catch {
      worker = null;
    }
  }
  return worker;
}

/** permutation-heavy analyses in a Web Worker (falls back to the main thread); keeps the last result while recomputing */
function useStudyResults(lives: LifeRecord[], dims: string[], now: number): StudyResult | null {
  const [res, setRes] = useState<StudyResult | null>(null);
  useEffect(() => {
    const req: StudyRequest = { id: Math.random(), lives, dims, now };
    const w = getWorker();
    let cancelled = false;
    if (w) {
      const onMsg = (e: MessageEvent<StudyResult>) => {
        if (!cancelled && e.data.id === req.id) setRes(e.data);
      };
      const onErr = () => {
        if (!cancelled) setRes(computeStudy(req));
      };
      w.addEventListener("message", onMsg);
      w.addEventListener("error", onErr);
      w.postMessage(req);
      return () => {
        cancelled = true;
        w.removeEventListener("message", onMsg);
        w.removeEventListener("error", onErr);
      };
    }
    const t = setTimeout(() => !cancelled && setRes(computeStudy(req)), 0);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [lives, dims, now]);
  return res;
}

export function StudyPage() {
  const L = useLives();
  const lin = useLineages();
  const lives = L.lives;
  const dims = useMemo(() => (L.traitDims.length ? L.traitDims : Object.keys(lives.find((l) => l.traits)?.traits ?? {})), [L.traitDims, lives]);
  // ages depend on "now": recompute at most once a game year (one real minute)
  const now = L.now ?? 0;
  const nowBucket = Math.ceil(now / YEAR_MS) * YEAR_MS;

  const [dim, setDim] = useState<string | null>(() => queryParam("trait"));
  const sel = dim && dims.includes(dim) ? dim : (dims[0] ?? null);
  useEffect(() => {
    if (!dim || !sel) return;
    const u = new URL(window.location.href);
    u.searchParams.set("trait", sel);
    window.history.replaceState(null, "", u);
  }, [dim, sel]);

  const study = useStudyResults(lives, dims, nowBucket);
  const per = useMemo(() => study?.per ?? {}, [study]);
  const q3 = study?.q3 ?? null;
  const win = useMemo(() => dataWindow(lives), [lives]);
  const families = useMemo(() => new Set(lives.filter((l) => l.traits).map((l) => l.lineageId)).size, [lives]);
  const tests = useMemo(() => traitTests(per, q3), [per, q3]);
  const v = useMemo(() => verdict(tests, Math.max(0, ...Object.values(per).map((r) => r.surv.n)), families), [tests, per, families]);
  const pageQ = useMemo(() => {
    const m = new Map(tests.map((t) => [`${t.dim}\u0000${t.outcome}`, t.q]));
    return (dim: string, outcome: string) => m.get(`${dim}\u0000${outcome}`) ?? null;
  }, [tests]);

  const nameOf = useMemo(() => {
    const byLin = new Map((lin.data?.lineages ?? []).map((l) => [l.lineageId, lineageName(l)]));
    const byLife = new Map(lives.map((l) => [l.lifeId, l]));
    return (id: string) => byLin.get(id) ?? lineageName({ eveName: byLife.get(id)?.name ?? null, lineageId: id });
  }, [lin.data, lives]);

  const r = sel ? per[sel] : null;
  const loading = (L.loading && !lives.length) || (!study && lives.length > 0);

  return (
    <SiteLayout active="study">
      <div className="page-title">
        <h1 className="sparkle">The study</h1>
      </div>

      <section className="panel study-banner" id="about">
        <div className="win">
          <MockBadge />
          <span>
            <b>{formatCount(win.lives)}</b> lives
          </span>
          <span>
            <b>{formatCount(win.runs)}</b> run{win.runs === 1 ? "" : "s"}
          </span>
          <span>
            <b>{formatCount(families)}</b> famil{families === 1 ? "y" : "ies"}
          </span>
          <span>
            <b>{formatCount(win.alive)}</b> alive
          </span>
          {win.lost > 0 && (
            <span>
              <b>{formatCount(win.lost)}</b> lost
            </span>
          )}
        </div>
        <p className="verdict">
          {loading ? (
            "Loading lives…"
          ) : v.state === "too-small" ? (
            <>
              <b>Nothing here is significant at this n.</b> {v.n} lives in {v.families} famil{v.families === 1 ? "y" : "ies"} (claims need ≥ {MIN_N_FOR_CLAIMS} and ≥ {MIN_FAMILIES})
              {v.minR != null && <>; a single real effect would need a family-level |r| above ~{fmt(v.minR)} to show</>}.
            </>
          ) : v.state === "none" ? (
            <>
              <b>Nothing is significant yet:</b> 0 of {v.tests} trait tests pass FDR 5%. With {v.families} families, a single real effect needs a family-level |r| above ~{fmt(v.minR)} to show (80% power).
            </>
          ) : (
            <>
              <b>
                {v.significant.length} of {v.tests} trait tests pass FDR 5%:
              </b>{" "}
              {v.significant
                .slice(0, 4)
                .map((t) => t.label)
                .join(", ")}
              {v.significant.length > 4 ? ` +${v.significant.length - 4} more` : ""}.
            </>
          )}{" "}
          <span className="muted">p-values permute family trait centres between families, so n is effectively the number of families.</span>
          {win.outOfRange > 0 && <span className="muted"> {win.outOfRange} out-of-range trait values ignored.</span>}
        </p>
        <button type="button" className="btn is-ghost csv" disabled={!lives.length} onClick={() => downloadText(`artificial-selection-lives-${new Date(now || Date.now()).toISOString().slice(0, 10)}.csv`, livesCsv(lives, dims, nowBucket))}>
          Download CSV
        </button>
      </section>

      <div className="controls">
        Trait
        <div className="seg" role="tablist" aria-label="Trait">
          {dims.map((d) => (
            <button type="button" key={d} role="tab" aria-selected={d === sel} className={d === sel ? "on" : undefined} onClick={() => setDim(d)}>
              {d}
            </button>
          ))}
          {!dims.length && <span>no traits yet</span>}
        </div>
      </div>

      {r && sel && q3 ? (
        <>
          <section className="q">
            <Ribbon q="Q1">Do traits affect survival and reaching adulthood?</Ribbon>
            <div className="grid">
              <Survival res={r.surv} dim={sel} />
              <Adulthood res={r.adult} dim={sel} />
            </div>
          </section>

          <section className="q">
            <Ribbon q="Q2">Who leaves descendants?</Ribbon>
            <div className="grid">
              <Descendants res={r.desc} dim={sel} />
            </div>
          </section>

          <section className="q">
            <Ribbon q="Q3">Who takes which role, beyond chance?</Ribbon>
            <div className="grid">
              <RoleMatrix res={q3} dims={dims} pageQ={pageQ} />
              <RoleConcentration res={q3} />
            </div>
          </section>

          <section className="q">
            <Ribbon q="Q4">Do traits persist, drift or converge across generations?</Ribbon>
            <div className="grid">
              <GenerationStrips byDim={Object.fromEntries(dims.map((d) => [d, per[d]?.gens ?? []]))} dims={dims} />
              <Trajectories tracks={r.tracks} dim={sel} nameOf={nameOf} />
              <MotherChild res={r.hered} dim={sel} />
            </div>
            <p className="note q4-note">
              Traits are assigned, not measured: a child gets its mother's values plus small random noise. So change across generations here is only that noise (clipped at ±2.5) plus selection (who survives and has children, and which families grow), and selection is a real signal; drift from social pressure could only show once behaviour or activations are measured.
            </p>
          </section>
        </>
      ) : (
        <section className="panel placeholder">
          <h2>{loading ? "Computing…" : "Not enough data yet"}</h2>
          <p>{L.error ? `Can't reach the data: ${L.error.message}` : loading ? `Running the permutation tests on ${win.lives} lives…` : `No lives with traits recorded yet. Charts appear once the first lives are in (adult = ${ADULT_AGE}).`}</p>
        </section>
      )}
    </SiteLayout>
  );
}
