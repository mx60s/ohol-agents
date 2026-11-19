// Site home (index.html): field notes, world status, the people, map, personality cloud, families, deaths, news, story.
import { TRAITS_SHOWN } from "../shared/personality.ts";
import { useMemo, useState } from "react";
import type { LifeRecord } from "../api-types.ts";
import { pageHref } from "../data/index.ts";
import { deathReasonText, displayName, formatAge } from "../shared/index.ts";
import { PersonalityCloud } from "../site/Cloud.tsx";
import { RecentDeaths } from "../site/Deaths.tsx";
import { FieldNotes } from "../site/FieldNotes.tsx";
import { median, sortBy } from "../site/logic.ts";
import { StorySoFar, WorldNews } from "../site/News.tsx";
import { LifeFigure, LifePortrait, LivesState, Seg, Sex } from "../site/ui.tsx";
import { useSite, type SiteData } from "../site/useSite.ts";
import { WorldMap } from "../site/WorldMap.tsx";
import "../site/site.css";
import { MockBadge, Panel, Pill, SiteLayout, StatTile, StatTiles, Sticker } from "../theme/index.ts";
import { mount } from "./mount.tsx";

const MOCK_TITLE = "Mock: traits are assigned and inherited as designed, but nothing steers the agents yet";

function Hero({ site }: { site: SiteData }) {
  const living = site.lives.filter((l) => l.status === "alive");
  const fams = new Set(living.map((l) => l.lineageId)).size;
  const maxGen = site.lives.reduce((m, l) => Math.max(m, l.generation), 0);
  const shown = sortBy(living, (l) => l.bornAt).slice(0, 9);
  return (
    <section className="hero">
      <div className="in">
        <div className="hero-people" aria-hidden>
          {shown.map((l, i) => (
            <span key={l.lifeId} className="hp" style={{ transform: `translateY(${(i % 3) * 6}px)` }}>
              <LifeFigure life={l} site={site} size={124} eager />
            </span>
          ))}
        </div>
        <div className="hello">
          <h1 className="sparkle">Welcome to the grassland!</h1>
          <p>
            {site.loading
              ? "Loading the world…"
              : site.failed
                ? "Can't reach the world right now."
                : living.length
                  ? `${living.length} alive in ${fams} ${fams === 1 ? "family" : "families"}, ${site.lives.length} lives so far.`
                  : `Nobody is alive right now. ${site.lives.length} lives so far.`}
          </p>
        </div>
        {maxGen >= 2 && (
          <Sticker size={96} className="hero-burst">
            GEN {maxGen}
            <br />
            REACHED!
          </Sticker>
        )}
      </div>
    </section>
  );
}

function WorldStatus({ site }: { site: SiteData }) {
  const s = useMemo(() => {
    const L = site.lives;
    const alive = L.filter((l) => l.status === "alive");
    const dead = L.filter((l) => l.status === "dead");
    const babies = L.filter((l) => (l.ageAtBirth ?? 0) < 1);
    const grownUp = babies.filter((l) => (site.ageOf(l) ?? 0) >= 14).length;
    const medAge = median(dead.map((l) => l.ageAtDeath ?? NaN));
    const oldest = alive.reduce((m, l) => Math.max(m, site.ageOf(l) ?? 0), 0);
    return {
      alive: alive.length,
      lives: L.length,
      deaths: dead.length,
      gen: L.reduce((m, l) => Math.max(m, l.generation), 0),
      famLiving: site.lineages.filter((l) => l.extinctAt == null).length,
      famAll: site.lineages.length,
      grownUp,
      babies: babies.length,
      medAge,
      oldest: alive.length ? oldest : null,
    };
  }, [site]);
  const d = (v: number | null) => (v == null ? "–" : v);
  // no data yet (loading, or the API was down from the start): dashes, not a world of zeros
  const none = site.lives.length === 0 && (site.loading || site.failed);
  const n = (v: number) => (none ? "–" : v);
  return (
    <Panel title="World status" bare>
      <StatTiles cols={4}>
        <StatTile tone="good" value={n(s.alive)} label="Alive now" />
        <StatTile value={n(s.lives)} label="Lives so far" />
        <StatTile tone="bad" value={n(s.deaths)} label="Deaths" />
        <StatTile value={s.gen || "–"} label="Deepest generation" />
        <StatTile value={n(s.famLiving)} suffix={none ? undefined : `/ ${s.famAll}`} label="Families alive" />
        <StatTile value={n(s.grownUp)} suffix={none ? undefined : `/ ${s.babies}`} label="Babies who grew up" />
        <StatTile value={s.medAge == null ? "–" : s.medAge.toFixed(1)} suffix={s.medAge == null ? undefined : "y"} label="Median age at death" />
        <StatTile value={d(s.oldest == null ? null : Math.floor(s.oldest))} suffix={s.oldest == null ? undefined : "y"} label="Oldest alive" />
      </StatTiles>
    </Panel>
  );
}

type Who = "living" | "dead" | "all";
type Order = "family" | "age" | "hungry";

function PersonCard({ l, site }: { l: LifeRecord; site: SiteData }) {
  const a = site.agentByLife.get(l.lifeId);
  const p = site.playerByLife.get(l.lifeId);
  const age = site.ageOf(l);
  const starving = l.status === "alive" && a?.food != null && a.food <= 3;
  const dying = l.status === "alive" && p?.dying;
  const cond = l.status === "alive" ? p?.condition ?? null : null;
  const doing =
    l.status === "dead"
      ? `Died at ${formatAge(l.ageAtDeath)}, ${deathReasonText(l.deathReason)}`
      : l.status === "lost"
        ? "Out of sight"
        : a?.held && !/^nothing$/i.test(a.held.trim())
            ? `Holding ${displayName(a.held.replace(/^baby:?\s*/i, ""))}`
            : "";
  return (
    <a className={`card${l.status === "dead" ? " is-dead" : ""}`} href={pageHref("agent", { life: l.lifeId })}>
      <LifePortrait life={l} site={site} size={64} />
      <div className="card-txt">
        <div className="nm ugc">{displayName(l.name)}</div>
        <div className="meta">
          <Sex female={l.female} /> {formatAge(age)} · gen {l.generation}
        </div>
        {doing && <div className="doing ugc">{doing}</div>}
        {(starving || dying || cond) && (
          <span className="flag">
            <Pill tone="danger">⚠ {dying ? "dying" : cond ? (cond.kind === "sickness" ? "sick" : "wounded") : "starving"}</Pill>
          </span>
        )}
      </div>
    </a>
  );
}

function People({ site }: { site: SiteData }) {
  const [who, setWho] = useState<Who>("living");
  const [order, setOrder] = useState<Order>("family");
  const counts = useMemo(() => {
    const living = site.lives.filter((l) => l.status === "alive").length;
    const dead = site.lives.filter((l) => l.status === "dead").length;
    return { living, dead, all: site.lives.length };
  }, [site.lives]);
  const rows = useMemo(() => {
    const f = site.lives.filter((l) => (who === "living" ? l.status === "alive" : who === "dead" ? l.status === "dead" : true));
    if (order === "family") return sortBy(f, (l) => site.famName(l.lineageId), "asc", (a, b) => a.bornAt - b.bornAt);
    if (order === "age") return sortBy(f, (l) => site.ageOf(l), "desc");
    return sortBy(f, (l) => (l.status === "alive" ? (site.agentByLife.get(l.lifeId)?.food ?? null) : null), "asc", (a, b) => b.bornAt - a.bornAt);
  }, [site, who, order]);
  const LIMIT = 12;
  return (
    <Panel title="The people" variant="green" id="people">
      <div className="roster-tools">
        <Seg<Who>
          label="Who"
          value={who}
          onChange={setWho}
          options={[
            { key: "living", label: `Living ${counts.living}` },
            { key: "dead", label: `Dead ${counts.dead}` },
            { key: "all", label: `Everyone ${counts.all}` },
          ]}
        />
        <Seg<Order>
          label="Sort"
          value={order}
          onChange={setOrder}
          options={[
            { key: "family", label: "By family" },
            { key: "age", label: "By age" },
            { key: "hungry", label: "Hungriest" },
          ]}
        />
      </div>
      {rows.length === 0 ? (
        <LivesState site={site} empty={who === "living" ? "Nobody is alive right now." : who === "dead" ? "Nobody has died yet." : "No lives yet."} />
      ) : (
        <div className="roster">
          {rows.slice(0, LIMIT).map((l) => (
            <PersonCard key={l.lifeId} l={l} site={site} />
          ))}
        </div>
      )}
      {rows.length > LIMIT && (
        <p className="more">
          <a href={pageHref("people")}>All {rows.length} →</a>
        </p>
      )}
    </Panel>
  );
}

function Families({ site }: { site: SiteData }) {
  const fams = useMemo(() => sortBy(site.lineages, (l) => (l.extinctAt == null ? 0 : 1), "asc", (a, b) => b.foundedAt - a.foundedAt), [site.lineages]);
  return (
    <Panel title="Families" variant="orange" id="families" bodyClassName="fam-body">
      {!fams.length && <LivesState site={site} empty="No families yet." />}
      {fams.slice(0, 6).map((f) => {
        const living = f.livingLifeIds.map((id) => site.byId[id]).filter((l): l is LifeRecord => !!l && l.status === "alive");
        return (
          <a key={f.lineageId} className="lineage" href={pageHref("families", { family: f.lineageId })}>
            <div className="row1">
              <span className={`fam-name ugc${f.extinctAt != null ? " extinct" : ""}`}>{site.famName(f.lineageId)}</span>
              {f.extinctAt != null ? <Pill tone="dead">extinct</Pill> : <Pill tone="alive">{f.living} alive</Pill>}
            </div>
            <div className="row2">
              {f.totalLives} {f.totalLives === 1 ? "life" : "lives"} · {f.maxGeneration} gen
            </div>
            {living.length > 0 && (
              <div className="members">
                {living.slice(0, 7).map((l) => (
                  <LifePortrait key={l.lifeId} life={l} site={site} size={26} round />
                ))}
              </div>
            )}
          </a>
        );
      })}
      {fams.length > 0 && (
        <p className="more">
          <a href={pageHref("families")}>All families →</a>
        </p>
      )}
    </Panel>
  );
}

function About() {
  return (
    <aside className="panel about">
      <div className="panel-head is-butter">About the study</div>
      <div className="panel-body">
        <p>
          <b>Many Members, One Body.</b> LLM agents are born, raise families and die in a real One Hour One Life world. Each life carries a personality, and children inherit
          their mother's with small mutations. We watch who survives, who leaves descendants, and who takes on which roles.
        </p>
        <p>
          For now the traits are mock: assigned and inherited as designed, but nothing steers the agents yet. The plan is to steer them with persona vectors.
        </p>
        <p>
          <a href={pageHref("study")}>The study →</a> &nbsp; <a href={pageHref("about")}>How it works →</a>
        </p>
      </div>
    </aside>
  );
}

function Home() {
  const site = useSite();
  return (
    <SiteLayout active="live">
      <Hero site={site} />
      <Panel title="🔎 Field notes" sub="every 20 minutes, this run" variant="navy" id="field-notes" className="field-notes">
        <FieldNotes />
      </Panel>
      <div className="as grid home-grid">
        <div className="span-8 stack">
          <WorldStatus site={site} />
          <People site={site} />
          <div className="grid cloud-row">
            <Panel title="Personality cloud" variant="pink" badge={TRAITS_SHOWN ? <MockBadge title={MOCK_TITLE} /> : undefined} id="cloud">
              {TRAITS_SHOWN ? <PersonalityCloud site={site} /> : <p className="note">none</p>}
            </Panel>
            <Families site={site} />
          </div>
          <Panel title="📖 The story so far" variant="berry" id="story">
            <StorySoFar />
          </Panel>
        </div>
        <div className="span-4 stack">
          <About />
          <Panel title="Map" variant="berry" id="map" bodyClassName="map-body">
            <WorldMap site={site} height={340} />
          </Panel>
          <Panel title="Recent deaths" variant="dark" bodyClassName="deaths-body">
            <RecentDeaths site={site} />
            <p className="more">
              <a href={pageHref("families", {}, "deaths")}>All deaths →</a>
            </p>
          </Panel>
          <Panel title="📻 World news" id="news" bodyClassName="news-body">
            <WorldNews pageSize={3} />
          </Panel>
        </div>
      </div>
    </SiteLayout>
  );
}

mount(<Home />);
