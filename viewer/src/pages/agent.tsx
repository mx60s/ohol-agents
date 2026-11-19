// One life (agent.html?life=<lifeId>): profile, raw traits, life in numbers, death, family, timeline.
import { TRAITS_SHOWN } from "../shared/personality.ts";
import { useMemo, useState } from "react";
import type { LifeRecord, RunEvent } from "../api-types.ts";
import { pageHref, queryParam, useLife, useLifeLog, useNow, useWorldState, type LifeLogState } from "../data/index.ts";
import { cueLabel, cueOfSay, deathReasonText, displayName, firstNameOf, formatAge, formatClock, formatCount, formatDuration, formatTrait, personalityText } from "../shared/index.ts";
import { DEATH_ICON } from "../site/Deaths.tsx";
import { FamilyTree, TreeScroll } from "../site/FamilyTree.tsx";
import {
  activityShares,
  clampTrait,
  deriveRole,
  familyOf,
  lifetimeMs,
  median,
  percentileLabel,
  percentileRank,
  prevNext,
  traitLabel,
  traitValues,
  TRAIT_LIMIT,
  type ActivityGroup,
  type TreeNode,
} from "../site/logic.ts";
import { LifeFigure, Note, Seg } from "../site/ui.tsx";
import { useSite, type SiteData } from "../site/useSite.ts";
import "../site/site.css";
import { MockBadge, Panel, Pill, SiteLayout, StatTile, StatTiles } from "../theme/index.ts";
import { mount } from "./mount.tsx";

const MOCK_TITLE = "Mock: traits are assigned and inherited as designed, but nothing steers the agents yet";

function firstName(n: string | null) {
  const d = displayName(n);
  return firstNameOf(d) || d;
}

// ------------------------------------------------------------------ profile

function Profile({ life, site, now }: { life: LifeRecord; site: SiteData; now: number }) {
  const fam = familyOf(life, site.lives);
  const role = deriveRole(life.activity);
  const age = site.ageOf(life);
  const lived = lifetimeMs(life, now);
  const famName = site.famName(life.lineageId);
  return (
    <section className="panel profile">
      <div className="panel-head is-clay">
        <span className="ttl">Profile</span>
        <span className="sub ugc">
          {famName} · gen {life.generation}
        </span>
      </div>
      <div className="top">
        <div className={`photo tilt-l${life.status === "dead" ? " dead" : ""}`}>
          <div className="well">
            <LifeFigure life={life} site={site} size={150} eager />
          </div>
        </div>
        <div className="kv-wrap">
          <div className="status">
            {life.status === "dead" ? (
              <Pill tone="dead">† died at {formatAge(life.ageAtDeath, { unit: false })}</Pill>
            ) : life.status === "lost" ? (
              <Pill tone="warn">lost track</Pill>
            ) : (
              <Pill tone="alive">● alive, {formatAge(age)}</Pill>
            )}
          </div>
          <dl className="kv">
            <dt>Born</dt>
            <dd>
              {formatClock(life.bornAt)}
              {fam.mother ? (
                <>
                  {" "}
                  · to{" "}
                  <a className="ugc" href={pageHref("agent", { life: fam.mother.lifeId })}>
                    {displayName(fam.mother.name)}
                  </a>
                </>
              ) : life.generation <= 1 ? (
                " · an Eve"
              ) : null}
            </dd>
            {life.status === "dead" && (
              <>
                <dt>Died</dt>
                <dd>
                  {formatClock(life.diedAt)} · {deathReasonText(life.deathReason)}
                </dd>
              </>
            )}
            <dt>{life.status === "alive" ? "Alive for" : "Lived"}</dt>
            <dd>{formatDuration(lived)}</dd>
            <dt>Sex</dt>
            <dd>{life.female == null ? "?" : life.female ? "female" : "male"}</dd>
            <dt>Flower</dt>
            <dd>{site.flowerOf(life.lifeId)?.label ?? "none"}</dd>
            <dt>Kids</dt>
            <dd>{fam.children.length || life.childLifeIds.length || "none"}</dd>
            <dt>Role</dt>
            <dd>{role ?? "too early to say"}</dd>
          </dl>
        </div>
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ now / death

function Meter({ label, v, max, tone, text }: { label: string; v: number | null; max: number; tone: "food" | "heat"; text: string }) {
  const pct = v == null ? 0 : Math.max(0, Math.min(1, v / max)) * 100;
  return (
    <div className="meter-row">
      <span>{label}</span>
      <div className="bar-track">
        <div className={`bar-fill is-${tone}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="mono">{text}</span>
    </div>
  );
}

function RightNow({ life }: { life: LifeRecord }) {
  const w = useWorldState();
  const a = w.state?.agents.find((x) => x.lifeId === life.lifeId);
  if (!a) return null;
  return (
    <Panel title="Right now" variant="green" bodyClassName="now-body">
      <Meter label="Food" v={a.food} max={a.foodCapacity ?? 20} tone="food" text={a.food == null ? "?" : `${a.food}/${a.foodCapacity ?? "?"}`} />
      <Meter label="Warmth" v={a.heat} max={1} tone="heat" text={a.heat == null ? "?" : a.heat.toFixed(2)} />
      {a.held && !/^nothing$/i.test(a.held.trim()) && (
        <p className="ugc">
          <b>Holding</b> {a.held}
        </p>
      )}

      {a.lastThought && <div className="thought ugc">{a.lastThought}</div>}
      {a.lastSaid && !cueOfSay(a.lastSaid) && (
        <p>
          <span className="speech ugc">{a.lastSaid}</span>
        </p>
      )}
    </Panel>
  );
}

function CauseOfDeath({ life, events }: { life: LifeRecord; events: RunEvent[] }) {
  const why = deathReasonText(life.deathReason);
  const last = events.find((e) => e.kind === "say" && e.text.trim() && !cueOfSay(e.text));
  return (
    <section className="panel death">
      <div className="panel-head is-ink">
        <span className="ttl">Cause of death</span>
      </div>
      <div className="panel-body">
        <div className="cause">
          <div className="ico" aria-hidden>
            {DEATH_ICON[why] ?? "†"}
          </div>
          <div>
            <div className="big">{why.charAt(0).toUpperCase() + why.slice(1)}</div>
            <div className="muted sm">
              age {formatAge(life.ageAtDeath, { decimals: 1 })} · {formatClock(life.diedAt)}
            </div>
          </div>
        </div>
        {last && (
          <div className="last-words">
            <span className="caps muted">Last words</span>
            <span className="speech ugc">{last.text}</span>
          </div>
        )}
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ family snippet

function FamilySnippet({ life, site }: { life: LifeRecord; site: SiteData }) {
  const fam = familyOf(life, site.lives);
  const me: TreeNode<LifeRecord> = { life, depth: 1, children: fam.children.map((c) => ({ life: c, depth: 2, children: [] })) };
  const roots: TreeNode<LifeRecord>[] = fam.mother
    ? [{ life: fam.mother, depth: 0, children: fam.siblings.map((s) => (s.lifeId === life.lifeId ? me : { life: s, depth: 1, children: [] })) }]
    : [me];
  const gens = (fam.mother ? 1 : 0) + 1 + (fam.children.length ? 1 : 0);
  // many siblings or kids: smaller nodes so the row fits the narrow column
  const dense = Math.max(fam.children.length, fam.siblings.length) > 4;
  return (
    <Panel title="Family" variant="green" sub={gens > 1 ? `${gens} generations` : undefined}>
      <TreeScroll resetKey={life.lifeId} className={dense ? "dense" : undefined}>
        <FamilyTree roots={roots} site={site} me={life.lifeId} portrait={dense ? 32 : 44} />
      </TreeScroll>
      <p className="more center">
        <a href={pageHref("families", { family: life.lineageId })} className="ugc">
          The whole {site.famName(life.lineageId)} family →
        </a>
      </p>
    </Panel>
  );
}

// ------------------------------------------------------------------ personality

function Personality({ life, site }: { life: LifeRecord; site: SiteData }) {
  const dims = site.dims;
  const famLives = useMemo(() => site.lives.filter((l) => l.lineageId === life.lineageId), [site.lives, life.lineageId]);
  const rows = useMemo(
    () =>
      dims.map((d) => {
        const all = traitValues(site.lives, d);
        const raw = life.traits?.[d];
        const v = clampTrait(raw);
        const famVals = traitValues(famLives, d);
        return {
          d,
          raw,
          v,
          med: median(all),
          famMean: famVals.length ? famVals.reduce((a, b) => a + b, 0) / famVals.length : null,
          pct: v == null ? null : percentileLabel(percentileRank(v, all), all.length),
        };
      }),
    [dims, site.lives, life.traits, famLives],
  );
  const pos = (v: number) => ((v + TRAIT_LIMIT) / (2 * TRAIT_LIMIT)) * 100;
  const p = personalityText(life, dims);
  const famName = site.famName(life.lineageId);
  return (
    <Panel title="Personality" variant="pink" badge={TRAITS_SHOWN ? <MockBadge title={MOCK_TITLE} /> : undefined}>
      {!TRAITS_SHOWN ? (
        <Note>none</Note>
      ) : !life.traits ? (
        <Note>No traits recorded for this life.</Note>
      ) : (
        <>
          <div className="trait-key">
            <span>
              <i className="k-med" /> everyone's median
            </span>
            <span className="ugc">
              <i className="k-fam" /> {famName} mean
            </span>
            <span className="mono">scale −2.5 … +2.5</span>
          </div>
          <div className="trows">
            {rows.map((r) => (
              <div className="trow" key={r.d}>
                <span className="nm">{traitLabel(r.d)}</span>
                <div className="ttrack" role="img" aria-label={`${traitLabel(r.d)} ${formatTrait(r.raw)}`}>
                  <span className="zero" />
                  {r.v != null && <span className={`fill${r.v < 0 ? " neg" : ""}`} style={{ left: `${pos(Math.min(0, r.v))}%`, width: `${Math.abs(pos(r.v) - 50)}%` }} />}
                  {r.med != null && <span className="pop" style={{ left: `${pos(r.med)}%` }} title={`median ${formatTrait(r.med)}`} />}
                  {r.famMean != null && <span className="lin-mean" style={{ left: `${pos(r.famMean)}%` }} title={`${famName} mean ${formatTrait(r.famMean)}`} />}
                </div>
                <span className="val">{formatTrait(r.raw)}</span>
                <span className="pct">{r.pct}</span>
              </div>
            ))}
          </div>
        </>
      )}
      <div className="label summary-label">Summary</div>
      <p className="summary ugc">{p.text}</p>
    </Panel>
  );
}

// ------------------------------------------------------------------ numbers

const GROUP_LABEL: Record<ActivityGroup, string> = { exploring: "explore", foraging: "forage", crafting: "make", caregiving: "care", socialising: "talk" };

function LifeInNumbers({ life, now }: { life: LifeRecord; now: number }) {
  const a = life.activity;
  const shares = activityShares(a);
  const n = shares.reduce((s, x) => s + x.count, 0);
  return (
    <Panel title="Life in numbers" bare>
      <StatTiles cols={4}>
        <StatTile value={formatDuration(lifetimeMs(life, now))} label="Lifetime" />
        <StatTile value={formatCount(a?.tilesWalked ?? 0)} suffix="tiles" label="Walked" />
        <StatTile value={formatCount(a?.eat ?? 0)} label="Things eaten" />
        <StatTile value={formatCount(a?.craft ?? 0)} label="Things made" />
        <StatTile value={formatCount(a?.says ?? 0)} label="Lines said" />
        <StatTile value={formatCount(a?.feeds ?? 0)} label="Babies fed" />
        <StatTile value={formatCount(a?.thoughts ?? 0)} label="Decisions" />
        <StatTile value={formatCount(a?.maxDistFromBirth ?? 0)} suffix="tiles" label="Furthest from birth" />
      </StatTiles>
      <div className="panel-body time-share">
        <div className="label">How {life.female === false ? "he" : life.female ? "she" : "they"} spent the time</div>
        {n === 0 ? (
          <Note>Nothing counted yet.</Note>
        ) : (
          <>
            <div className="roles" role="img" aria-label={shares.map((s) => `${GROUP_LABEL[s.group]} ${Math.round(s.share * 100)}%`).join(", ")}>
              {shares
                .filter((s) => s.count > 0)
                .map((s) => (
                  <div key={s.group} className={`g-${s.group}`} style={{ flex: s.count }} title={`${GROUP_LABEL[s.group]} ${Math.round(s.share * 100)}% (${s.count})`}>
                    {s.share >= 0.09 ? `${GROUP_LABEL[s.group]} ${Math.round(s.share * 100)}%` : ""}
                  </div>
                ))}
            </div>
            <div className="roles-foot">
              {shares
                .filter((s) => s.count > 0 && s.share < 0.09)
                .map((s) => `${GROUP_LABEL[s.group]} ${Math.round(s.share * 100)}%`)
                .join(" · ")}
              <span className="mono"> n = {n}</span>
            </div>
          </>
        )}
      </div>
    </Panel>
  );
}

// ------------------------------------------------------------------ timeline

type TlKind = "all" | "thought" | "say" | "action" | "event";
const kindOf = (e: RunEvent): Exclude<TlKind, "all"> => (e.kind === "thought" ? "thought" : e.kind === "say" ? "say" : e.kind === "action" || e.kind === "craft" ? "action" : "event");
const TL_PAGE = 25;
const ICON: Record<Exclude<TlKind, "all">, string> = { thought: "…", say: "“", action: "→", event: "★" };

function Timeline({ life, site, log }: { life: LifeRecord; site: SiteData; log: LifeLogState }) {
  const w = useWorldState();
  const [kind, setKind] = useState<TlKind>("all");
  const [limit, setLimit] = useState(TL_PAGE);
  const counts = useMemo(() => {
    const c: Record<TlKind, number> = { all: log.events.length, thought: 0, say: 0, action: 0, event: 0 };
    for (const e of log.events) c[kindOf(e)]++;
    return c;
  }, [log.events]);
  const matching = kind === "all" ? log.events : log.events.filter((e) => kindOf(e) === kind);
  const shown = matching.slice(0, limit);
  const canMore = matching.length > limit || log.hasMore;
  const more = () => {
    setLimit(limit + TL_PAGE);
    if (matching.length <= limit + TL_PAGE && log.hasMore) log.loadMore();
  };
  const nameOfAgent = (id: string) => {
    const a = w.state?.agents.find((x) => x.agentId === id);
    return a?.lifeId && site.byId[a.lifeId] ? firstName(site.byId[a.lifeId].name) : a?.name ? firstName(a.name) : null;
  };
  const since = (t: number) => {
    const s = Math.max(0, Math.floor((t - life.bornAt) / 1000));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = String(s % 60).padStart(2, "0");
    // "+" so it can't be read as a clock time (BORN shows one just above)
    return h ? `+${h}:${String(m).padStart(2, "0")}:${ss}` : `+${m}:${ss}`;
  };
  return (
    <Panel title="Timeline" variant="yellow" id="timeline">
      <div className="tl-tools">
        <Seg<TlKind>
          label="Show"
          value={kind}
          onChange={(k) => (setKind(k), setLimit(TL_PAGE))}
          options={[
            { key: "all", label: `All ${counts.all}` },
            { key: "thought", label: `… Thoughts ${counts.thought}` },
            { key: "say", label: `“ Speech ${counts.say}` },
            { key: "action", label: `→ Actions ${counts.action}` },
            { key: "event", label: `★ Events ${counts.event}` },
          ]}
        />
        <span className="muted sm">newest first · time since birth</span>
      </div>
      {log.loading && !log.events.length && <Note>Loading…</Note>}
      {log.error && !log.events.length && <Note tone="error">Can't load this life's log right now.</Note>}
      {!log.loading && !log.error && !log.events.length && <Note>Nothing recorded yet.</Note>}
      <ol className="tl">
        {shown.map((e) => {
          const k = kindOf(e);
          const heard = Array.isArray(e.data?.heardBy) ? (e.data.heardBy as unknown[]).filter((x): x is string => typeof x === "string") : [];
          const heardNames = heard.map(nameOfAgent).filter(Boolean) as string[];
          const cmd = typeof e.data?.command === "string" ? e.data.command : null;
          return (
            <li key={e.seq} className={`k-${k}${e.kind === "death" ? " is-death" : ""}`}>
              <time className="mono" title={new Date(e.t).toLocaleString()}>
                {since(e.t)}
              </time>
              <span className={`k ${e.kind === "death" ? "dd" : k}`} aria-label={e.kind}>
                {e.kind === "death" ? "†" : ICON[k]}
              </span>
              <div className="body">
                {k === "thought" && <div className="thought ugc">{e.text}</div>}
                {k === "say" && cueOfSay(e.text) && <span className="muted emote-label">({cueLabel(cueOfSay(e.text)!)})</span>}
                {k === "say" && !cueOfSay(e.text) && (
                  <>
                    <span className="speech ugc">{e.text}</span>
                    <span className="who ugc">{heard.length ? `heard by ${heardNames.length ? heardNames.join(", ") : heard.length}` : "heard by no one"}</span>
                  </>
                )}
                {k === "action" && (
                  <span className="act">
                    <span className="ugc">{e.text}</span>
                    {cmd && cmd !== e.text && <code className="ugc">{cmd}</code>}
                  </span>
                )}
                {k === "event" && <span className="evt ugc">{e.kind === "birth" ? `Born${e.text ? ` · ${e.text}` : ""}` : e.text || e.kind}</span>}
              </div>
            </li>
          );
        })}
      </ol>
      {canMore && (
        <div className="center">
          <button type="button" className="btn is-ghost" onClick={more} disabled={log.loadingMore}>
            {log.loadingMore ? "Loading…" : "Older"}
          </button>
        </div>
      )}
      {kind !== "all" && shown.length === 0 && log.events.length > 0 && <Note>None in the part of the log loaded so far.</Note>}
    </Panel>
  );
}

// ------------------------------------------------------------------ page

function AgentPage() {
  const site = useSite();
  const now = useNow(1000);
  const lifeId = queryParam("life");
  const { life: fetched, notFound, loading, error } = useLife(lifeId);
  // the polled list is fresher than nothing; the single-life fetch wins when present
  const life = fetched ?? (lifeId ? site.byId[lifeId] : undefined) ?? null;
  const log = useLifeLog(lifeId, { pageSize: 60, pollMs: life && life.status !== "alive" ? 0 : 4000 });
  const nav = life ? prevNext(life, site.lives) : { prev: null, next: null };

  if (!lifeId) {
    return (
      <SiteLayout active="people">
        <div className="as">
          <Note>
            No life picked. <a href={pageHref("people")}>Browse everyone →</a>
          </Note>
        </div>
      </SiteLayout>
    );
  }
  if (!life) {
    return (
      <SiteLayout active="people">
        <div className="as">
          {notFound && !site.byId[lifeId] ? (
            <Note>
              Nobody here by that id. <a href={pageHref("people")}>Browse everyone →</a>
            </Note>
          ) : error && !loading ? (
            <Note tone="error">Can't reach the world right now.</Note>
          ) : (
            <Note>Loading…</Note>
          )}
        </div>
      </SiteLayout>
    );
  }
  if (typeof document !== "undefined") document.title = `${displayName(life.name)} · Artificial Selection`;
  const name = displayName(life.name);
  return (
    <SiteLayout active="people">
      <div className="as">
        <div className="page-title agent-title">
          <h1 className="ugc">{name}</h1>
          <span className="crumbs">
            <a href={pageHref("people")}>People</a> › <a href={pageHref("families", { family: life.lineageId })} className="ugc">{site.famName(life.lineageId)} family</a> ›{" "}
            <span className="ugc">{firstName(life.name)}</span>
          </span>
          <span className="sib-nav">
            {nav.prev && (
              <a className="btn is-ghost ugc" href={pageHref("agent", { life: nav.prev.lifeId })} title="Older sibling">
                ← {displayName(nav.prev.name)}
              </a>
            )}
            {nav.next && (
              <a className="btn is-ghost ugc" href={pageHref("agent", { life: nav.next.lifeId })} title="Younger sibling">
                {displayName(nav.next.name)} →
              </a>
            )}
          </span>
        </div>
        <div className="grid">
          <div className="span-4 stack">
            <Profile life={life} site={site} now={now} />
            {life.status === "alive" && <RightNow life={life} />}
            {life.status === "dead" && <CauseOfDeath life={life} events={log.events} />}
            <FamilySnippet life={life} site={site} />
          </div>
          <div className="span-8 stack">
            <Personality life={life} site={site} />
            <LifeInNumbers life={life} now={now} />
            <Timeline life={life} site={site} log={log} />
          </div>
        </div>
      </div>
    </SiteLayout>
  );
}

mount(<AgentPage />);
