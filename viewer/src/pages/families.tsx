// Families (families.html?family=<lineageId>): every lineage, its look, stats and an interactive tree; then every death.
import { useEffect, useMemo, useState } from "react";
import type { LifeRecord, LineageRecord } from "../api-types.ts";
import { queryParam, useNow } from "../data/index.ts";
import { formatClock, formatRelative, formatTrait, PersonPortrait } from "../shared/index.ts";
import { DeathsTable } from "../site/Deaths.tsx";
import { FamilyTree, TreeScroll, useFolds } from "../site/FamilyTree.tsx";
import { buildForest, meanTraits, sortBy, traitLabel, TRAIT_LIMIT } from "../site/logic.ts";
import { LivesState, Note } from "../site/ui.tsx";
import { useSite, type SiteData } from "../site/useSite.ts";
import "../site/site.css";
import { MockBadge, Panel, Pill, SiteLayout, StatTile, StatTiles } from "../theme/index.ts";
import { mount } from "./mount.tsx";

const MOCK_TITLE = "Mock: traits are assigned and inherited as designed, but nothing steers the agents yet";

/** The family's shared hairstyle + face, on a female and a male member (hair colour = the family's mean traits). */
function FamilyLook({ fam, members, site, size }: { fam: LineageRecord; members: LifeRecord[]; site: SiteData; size: number }) {
  const f = members.find((l) => l.female === true && l.displayId != null);
  const m = members.find((l) => l.female === false && l.displayId != null);
  const traits = Object.keys(fam.meanTraits).length ? fam.meanTraits : meanTraits(members, site.dims);
  const common = { lineageId: fam.lineageId, livingLineageIds: site.order, traits, traitDims: site.dims, age: 26, size };
  return (
    <span className="fam-look" aria-label="Family look">
      <span className="portrait-frame portrait-well round">
        <PersonPortrait {...common} displayId={f?.displayId ?? 19} female title="Family look (female)" />
      </span>
      <span className="portrait-frame portrait-well round">
        <PersonPortrait {...common} displayId={m?.displayId ?? 347} female={false} title="Family look (male)" />
      </span>
    </span>
  );
}

function FamilyDetail({ fam, site }: { fam: LineageRecord; site: SiteData }) {
  const now = useNow(30_000);
  const members = useMemo(() => site.lives.filter((l) => l.lineageId === fam.lineageId), [site.lives, fam.lineageId]);
  const forest = useMemo(() => buildForest(members), [members]);
  const folds = useFolds(forest, fam.lineageId, 40);
  const means = Object.keys(fam.meanTraits).length ? fam.meanTraits : meanTraits(members, site.dims);
  const living = members.filter((l) => l.status === "alive").length;
  const name = site.famName(fam.lineageId);
  const pos = (v: number) => ((Math.max(-TRAIT_LIMIT, Math.min(TRAIT_LIMIT, v)) + TRAIT_LIMIT) / (2 * TRAIT_LIMIT)) * 100;
  return (
    <div className="grid fam-detail">
      <div className="span-4 stack">
        <section className="panel">
          <div className="panel-head is-clay">
            <span className="ttl ugc">The {name} family</span>
          </div>
          <div className="panel-body fam-head">
            <FamilyLook fam={fam} members={members} site={site} size={84} />
            <p className="muted sm">Shared hairstyle and face. Hair colour varies with each person's traits.</p>
          </div>
          <StatTiles cols={2}>
            <StatTile value={members.length || fam.totalLives} label="Lives" />
            <StatTile value={fam.maxGeneration} label="Generations" />
            <StatTile tone={living ? "good" : undefined} value={living} label="Living now" />
            <StatTile value={fam.extinctAt != null ? formatClock(fam.extinctAt) : formatRelative(fam.foundedAt, now).replace(" ago", "")} label={fam.extinctAt != null ? "Died out" : "Age of family"} />
          </StatTiles>
        </section>
        <Panel title="Mean traits" variant="pink" badge={<MockBadge title={MOCK_TITLE} />}>
          {site.dims.map((d) => {
            const v = means[d];
            return (
              <div className="mrow" key={d}>
                <span className="nm">{traitLabel(d)}</span>
                <div className="ttrack sm">
                  <span className="zero" />
                  {v != null && <span className={`fill${v < 0 ? " neg" : ""}`} style={{ left: `${pos(Math.min(0, v))}%`, width: `${Math.abs(pos(v) - 50)}%` }} />}
                </div>
                <span className="val">{formatTrait(v)}</span>
              </div>
            );
          })}
        </Panel>
      </div>
      <div className="span-8">
        <Panel title="Family tree" variant="green" sub={`${members.length} lives`}>
          <div className="tree-tools">
            <button type="button" className="btn is-ghost sm" onClick={folds.expandAll}>
              Expand all
            </button>
            <button type="button" className="btn is-ghost sm" onClick={folds.collapseAll}>
              Fold
            </button>
          </div>
          {members.length ? (
            <TreeScroll className="big" resetKey={`${fam.lineageId}:${folds.folded.size === 0 ? "open" : "folded"}`}>
              <FamilyTree roots={forest} site={site} folded={folds.folded} onToggle={folds.toggle} portrait={46} />
            </TreeScroll>
          ) : (
            <Note>No members recorded.</Note>
          )}
        </Panel>
      </div>
    </div>
  );
}

function FamiliesPage() {
  const site = useSite();
  const [picked, setPicked] = useState<string | null>(() => queryParam("family"));
  const fams = useMemo(() => sortBy(site.lineages, (l) => (l.extinctAt == null ? 0 : 1), "asc", (a, b) => a.foundedAt - b.foundedAt), [site.lineages]);
  const current = fams.find((f) => f.lineageId === picked) ?? fams[0] ?? null;

  useEffect(() => {
    if (location.hash === "#deaths") document.getElementById("deaths")?.scrollIntoView();
  }, [site.lives.length > 0]);

  const pick = (id: string) => {
    setPicked(id);
    const u = new URL(location.href);
    u.searchParams.set("family", id);
    u.hash = "";
    history.replaceState(null, "", u.toString());
  };

  return (
    <SiteLayout active="families">
      <div className="as">
        <div className="page-title">
          <h1>Families</h1>
        </div>
        {!fams.length ? (
          <Panel title="Families" variant="orange">
            <LivesState site={site} empty="No families yet." />
          </Panel>
        ) : (
          <>
            <div className="fam-picker" role="tablist" aria-label="Families">
              {fams.map((f) => {
                const members = site.lives.filter((l) => l.lineageId === f.lineageId);
                return (
                  <button key={f.lineageId} type="button" role="tab" aria-selected={f === current} className={`fam-card${f === current ? " on" : ""}${f.extinctAt != null ? " is-extinct" : ""}`} onClick={() => pick(f.lineageId)}>
                    <FamilyLook fam={f} members={members} site={site} size={40} />
                    <span className="fc-txt">
                      <span className={`fam-name ugc${f.extinctAt != null ? " extinct" : ""}`}>{site.famName(f.lineageId)}</span>
                      <span className="row2">
                        {f.totalLives} {f.totalLives === 1 ? "life" : "lives"} · {f.maxGeneration} gen
                      </span>
                    </span>
                    {f.extinctAt != null ? <Pill tone="dead">extinct</Pill> : <Pill tone="alive">{f.living} alive</Pill>}
                  </button>
                );
              })}
            </div>
            {current && <FamilyDetail key={current.lineageId} fam={current} site={site} />}
          </>
        )}
        <Panel title="Deaths" variant="dark" id="deaths" style={{ marginTop: 20 }}>
          <DeathsTable site={site} />
        </Panel>
      </div>
    </SiteLayout>
  );
}

mount(<FamiliesPage />);
