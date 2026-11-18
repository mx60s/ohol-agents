// How agents work (agents.html): what an agent sees, knows, doesn't know and can do.
// Everything specific (prompt, actions, settings, limits, the example turn) comes from
// GET /api/agent-spec, which renders it from the agents service's own code. All model
// and game text renders as React text (escaped), never as HTML.
import type { ReactNode } from "react";
import type { AgentSpecIntervention, AgentSpecResponse, InterventionCategory } from "../api-types.ts";
import { useAgentSpec } from "../data/index.ts";
import { formatClock } from "../shared/index.ts";
import { Note } from "../site/ui.tsx";
import "../site/site.css";
import "../site/agents.css";
import { MockBadge, Panel, Pill, SiteLayout, StatTile, StatTiles, prettyModel } from "../theme/index.ts";
import { mount } from "./mount.tsx";

const s1 = (ms: number) => `${Math.round(ms / 100) / 10} s`;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** A reply object, one field per line and one action per line. */
function formatReply(o: Record<string, unknown>): string {
  const lines = Object.entries(o).map(([k, v]) =>
    Array.isArray(v) ? `  ${JSON.stringify(k)}: [\n${v.map((x) => `    ${JSON.stringify(x)}`).join(",\n")}\n  ]` : `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`,
  );
  return `{\n${lines.join(",\n")}\n}`;
}

// ------------------------------------------------------------------ 1. a turn

function TurnSteps({ spec }: { spec: AgentSpecResponse }) {
  const st = spec.settings;
  const steps: { n: string; title: string; body: ReactNode }[] = [
    { n: "1", title: "Observe", body: <>Code turns what the character's own game client received into a page of text.</> },
    {
      n: "2",
      title: "Think",
      body: (
        <>
          {prettyModel(st.model)} reads the system prompt and that page{st.reasoningCap ? <>, with about {st.reasoningMaxTokens} tokens of reasoning</> : null}.
        </>
      ),
    },
    { n: "3", title: "Reply", body: <>One JSON object: a thought, maybe words to say, and an action{st.actionListMax > 1 ? <> or up to {st.actionListMax} in a row</> : null}.</> },
    { n: "4", title: "Act", body: <>Code carries it out in the game (walking, clicking) and records each result for next turn.</> },
    { n: "5", title: "Wait", body: <>The next turn starts {s1(st.decisionCycleMs)} after this one began, or as soon as something happens.</> },
  ];
  return (
    <>
      <ol className="hw-steps">
        {steps.map((s) => (
          <li key={s.n}>
            <span className="hw-num">{s.n}</span>
            <b>{s.title}</b>
            <span>{s.body}</span>
          </li>
        ))}
      </ol>
      <div className="hw-loop" aria-hidden>
        <span>↺ next turn</span>
      </div>
    </>
  );
}

function TurnPanel({ spec }: { spec: AgentSpecResponse }) {
  const st = spec.settings;
  return (
    <Panel title="A turn, step by step" variant="navy" bare>
      <div className="panel-body">
        <TurnSteps spec={spec} />
        <p className="hw-p">
          Every turn is a fresh call: the system prompt plus one observation, no chat history. Things that wake an agent early: its food falling to half, a quarter or starving;
          being picked up or put down; giving birth; its baby crying "F"; a death nearby; its name; speech within {spec.limits.wakeSpeechRadius} tiles.
        </p>
      </div>
      <StatTiles cols={5}>
        <StatTile value={s1(st.decisionCycleMs)} label="One turn" detail="real time, start to start" />
        <StatTile value={`${st.timeScale}×`} label="Time scale" detail={st.timeScale === 1 ? "stock game speed" : `game clock ${st.timeScale}× slower than stock`} />
        <StatTile value={st.gameSecondsPerTurn} suffix="s" label="Game time per turn" />
        <StatTile value={st.turnsPerYear} label="Turns per year of life" detail="a year is 60 game seconds" />
        <StatTile value={s1(st.babyDecisionIntervalMs)} label="Babies under 2" detail={`with nothing happening, up to ${s1(st.babyIdleMaxMs)}`} />
      </StatTiles>
    </Panel>
  );
}

// ------------------------------------------------------------------ 2. what they know

function KnowPanel({ spec }: { spec: AgentSpecResponse }) {
  const L = spec.limits;
  const st = spec.settings;
  const rows: [string, ReactNode][] = [
    ["Their body", <>Name, age, generation, flower, position and biome; food with how fast it drains in turns; heat; wounds or sickness; what they hold and wear; a craving.</>],
    ["Home, water, fire", <>Their family's Home Marker (or, without one, where they were born); the nearest water and heat within {L.resourceRadius} tiles; hand-pickable food left nearby.</>],
    ["People", <>Up to {L.maxPeople} within {L.peopleRadius} tiles: id, name, sex, age, flower, relation (mother, child, sibling, family), what they hold, if they're carried, walking or hurt. Mothers: where each baby is.</>],
    ["Speech", <>The last {L.heardMax} lines heard in the past {plural(Math.round(L.heardWindowS / (st.decisionCycleMs / 1000)), "turn")} or so, with who said them; game notices; words written on the ground.</>],
    ["Things", <>Up to {L.maxThingKinds} kinds of object within {L.viewRadius} tiles, nearest first, with coordinates.</>],
    ...(st.recipeHints ? ([["Recipe hints", <>Up to {L.maxHints} things the held item (or bare hands) would do to what's in view.</>]] as [string, ReactNode][]) : []),
    ["Deaths seen", <>Who died in view in the last {Math.round(L.deathsWindowS / 60)} minutes: name, relation, age, place.</>],
    ["Their last turns", <>Their previous thought, their goal, the last {L.historyShown} action results, and why a reply was wasted if it was.</>],
    ["What they remember", <>A summary of this life so far (at most {L.memoryLines} lines of facts), which their own model rewrites in the background about once a year.</>],
    ["Just happened", <>The events that woke them since the last turn.</>],
  ];
  return (
    <Panel title="What they know" variant="green">
      <p className="hw-p">
        The observation is built only from what the character's own client received. Every turn, in this order:
      </p>
      <dl className="hw-know">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      <p className="hw-p">
        Before it, the same system prompt every turn: what a first-time player knows (how time, food and births work, how to pick up, put down and combine things), our naming and flower rules, and the reply format. No recipes and no strategy.
      </p>
      <details className="hw-details">
        <summary>The system prompt, exactly as sent ({spec.systemPrompt.length.toLocaleString("en-US")} characters)</summary>
        <pre className="hw-pre">{spec.systemPrompt}</pre>
        {spec.userSuffix && (
          <p className="hw-p sm">
            After the observation, the user message ends: <span className="mono">{spec.userSuffix}</span>
          </p>
        )}
      </details>
    </Panel>
  );
}

// ------------------------------------------------------------------ 3. what they don't know

function DontKnowPanel({ spec }: { spec: AgentSpecResponse }) {
  const L = spec.limits;
  const st = spec.settings;
  const items: [string, ReactNode][] = [
    st.memoryMode === "per-life"
      ? ["Their past lives", <>When a seat is reborn, its new character starts blank: no notes, goals or history carry over.</>]
      : ["Their past lives (partly)", <>Memory is set to persistent: notes from a seat's earlier lives are shown, but nothing else carries over.</>],
    ["Earlier turns", <>No conversation history. Only the previous thought, the goal, the yearly memory summary and the last {L.historyShown} results connect one turn to the next.</>],
    ["Anything out of view", <>Things beyond {L.viewRadius} tiles, people beyond {L.peopleRadius}, speech beyond about {L.hearingRadius}. No map of the world, no idea where other camps are.</>],
    ["Other minds", <>Never another agent's thoughts, goals or notes. Only what people say aloud and what they visibly hold.</>],
    ["Why people die", <>They see who died, where and how old, never the cause.</>],
    [
      "Their personality",
      <>
        Every life has traits <MockBadge />, but they're only recorded and inherited. No prompt mentions them.
      </>,
    ],
    ["The narrator, story and director", <>Other models write the news, the story so far and pick who the camera follows. None of it reaches the agents.</>],
    ["That they're AI", <>The prompt says they're a person in the game, and everyone else is an independent mind. It doesn't mention models, a study or an audience.</>],
    ["Seconds", <>Every duration is given in turns.</>],
    ["Technical trouble", <>Provider errors and outages are logged, never shown to them.</>],
  ];
  return (
    <Panel title="What they don't know" variant="pink">
      <ul className="hw-list">
        {items.map(([k, v]) => (
          <li key={k}>
            <b>{k}.</b> {v}
          </li>
        ))}
      </ul>
    </Panel>
  );
}

// ------------------------------------------------------------------ 4. what they can do

function DoPanel({ spec }: { spec: AgentSpecResponse }) {
  const st = spec.settings;
  return (
    <Panel title="What they can do" variant="orange">
      <p className="hw-p">
        A reply is one JSON object. {st.actionListMax > 1 ? <>Instead of one action it may list up to {st.actionListMax}, done back to back; the list stops at the first step that fails or when something happens.</> : null}
      </p>
      <div className="table-wrap hw-table">
        <table className="data">
          <thead>
            <tr>
              <th>Reply field</th>
              <th>What it does</th>
            </tr>
          </thead>
          <tbody>
            {spec.replyFields.map((f) => (
              <tr key={f.name}>
                <td className="mono">{f.name}</td>
                <td>{f.meaning}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="table-wrap hw-table">
        <table className="data">
          <thead>
            <tr>
              <th>Action</th>
              <th>As written</th>
              <th>Meaning (from the prompt)</th>
            </tr>
          </thead>
          <tbody>
            {spec.actions.map((a) => (
              <tr key={a.type}>
                <td className="mono hw-type">
                  {a.type}
                  {a.temporary && (
                    <>
                      {" "}
                      <Pill tone="warn" title="Temporary intervention: may be removed before the main study">
                        temporary
                      </Pill>
                    </>
                  )}
                </td>
                <td className="mono hw-tpl">{a.template}</td>
                <td>{a.meaning}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="hw-p sm">
        Not chosen by the model: at food {spec.limits.reflexFood} or less (age 3 and up), code forages for them.
      </p>
    </Panel>
  );
}

// ------------------------------------------------------------------ 5. interventions

const CAT: { key: InterventionCategory; title: string; sub: string }[] = [
  { key: "human-ui", title: "Like the game's own screen", sub: "what a human player sees, given as text" },
  { key: "wiki", title: "Like experience or the wiki", sub: "knowledge a human could look up" },
  { key: "beyond-human", title: "Beyond a human player", sub: "help a human doesn't get" },
  { key: "game-setting", title: "Changes to the game", sub: "the same for every player" },
];

function onLabel(i: AgentSpecIntervention) {
  if (i.on == null) return <Pill title="A game-server setting the agents service can't confirm">?</Pill>;
  return i.on ? <Pill tone="alive">on</Pill> : <Pill tone="dead">off</Pill>;
}

function InterventionsPanel({ spec }: { spec: AgentSpecResponse }) {
  return (
    <Panel title="Interventions vs the original game" variant="yellow">
      <div className="hw-cats">
        {CAT.map((c) => {
          const list = spec.interventions.filter((i) => i.category === c.key);
          if (!list.length) return null;
          return (
            <section key={c.key} className="hw-cat">
              <h3>{c.title}</h3>
              <p className="sm hw-muted">{c.sub}</p>
              <ul>
                {list.map((i) => (
                  <li key={i.id} className={i.on === false ? "is-off" : undefined}>
                    <span className="hw-iname">
                      {onLabel(i)} <b>{i.name}</b>
                    </span>
                    <span className="hw-idetail">{i.detail}</span>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </Panel>
  );
}

// ------------------------------------------------------------------ 6. a real turn

function ExamplePanel({ spec }: { spec: AgentSpecResponse }) {
  const ex = spec.example;
  if (!ex)
    return (
      <Panel title="A real turn" variant="berry">
        <Note>No adult has finished a turn in this run yet.</Note>
      </Panel>
    );
  const { thought, ...rest } = ex.reply;
  return (
    <Panel title="A real turn" variant="berry" sub={<span className="ugc">{[ex.model ? prettyModel(ex.model) : null, formatClock(ex.t)].filter(Boolean).join(" · ")}</span>}>
      <p className="hw-p">
        The latest finished decision by an adult in this run, as logged. Seat <span className="mono">{ex.agentId}</span>, age {ex.age.toFixed(1)}.
      </p>
      <div className="hw-turn">
        <div className="hw-turn-step">
          <h3>1 · What it saw</h3>
          <details className="hw-details" open>
            <summary>The observation ({ex.observation.split("\n").length} lines)</summary>
            <pre className="hw-pre ugc">{ex.observation}</pre>
          </details>
        </div>
        <div className="hw-turn-step">
          <h3>2 · What it thought</h3>
          {ex.reasoning ? (
            <details className="hw-details" open>
              <summary>Reasoning, as the provider returned it</summary>
              <p className="hw-reason ugc">{ex.reasoning}</p>
            </details>
          ) : (
            <p className="hw-p sm hw-muted">The provider didn't return reasoning text for this call.</p>
          )}
        </div>
        <div className="hw-turn-step">
          <h3>3 · What it replied</h3>
          {thought && <p className="hw-thought ugc">“{thought}”</p>}
          <pre className="hw-pre hw-json ugc">{formatReply(rest)}</pre>
        </div>
        <div className="hw-turn-step">
          <h3>4 · What happened</h3>
          {ex.said && (
            <p className="hw-p">
              Said: <span className="hw-said ugc">{ex.said}</span>
            </p>
          )}
          {ex.results.length ? (
            <ol className="hw-results">
              {ex.results.map((r, i) => (
                <li key={i}>
                  <span className="mono">{r.action}</span>
                  <span className="ugc">→ {r.result}</span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="hw-p sm hw-muted">It waited.</p>
          )}
        </div>
      </div>
    </Panel>
  );
}

// ------------------------------------------------------------------ 7. speech and families

function SpeechPanel({ spec }: { spec: AgentSpecResponse }) {
  const L = spec.limits;
  const st = spec.settings;
  const max = Math.max(1, ...spec.sayLimits.map((s) => s.letters));
  return (
    <Panel title="Speech and families" variant="mint">
      <div className="hw-speech">
      <ul className="hw-list">
        <li>
          <b>Hearing.</b> The game delivers speech within {L.hearingRadius} tiles. Speech within {L.wakeSpeechRadius} tiles wakes a listener early.
        </li>
        <li>
          <b>Languages.</b> Once 15 or more people are alive, each family speaks its own language: other families' words arrive scrambled.
        </li>
        <li>
          <b>Naming.</b> An Eve names herself and her family once: "I AM &lt;FIRST&gt; &lt;FAMILY&gt;". A mother holding her baby names it: "YOU ARE &lt;FIRST&gt;".
          {st.freeNames.value === "1" ? " Names are kept as spoken." : null}
        </li>
        <li>
          <b>Flowers.</b> Everyone wears a flower in their hair, unique among the living members of their family, so siblings can be told apart.
        </li>
      </ul>
      <div>
      <h3 className="hw-h3">Letters per sentence, by age</h3>
      <div className="hw-say" role="table" aria-label="Letters per sentence by age">
        {spec.sayLimits.map((s) => (
          <div key={s.age} role="row" className="hw-say-row">
            <span role="cell" className="mono">
              {s.age}
            </span>
            <span role="cell" className="hw-bar">
              <i style={{ width: `${(s.letters / max) * 100}%` }} />
            </span>
            <span role="cell" className="mono">
              {s.letters}
            </span>
          </div>
        ))}
      </div>
      </div>
      </div>
    </Panel>
  );
}

// ------------------------------------------------------------------ page

function Body({ spec }: { spec: AgentSpecResponse }) {
  return (
    <>
      <TurnPanel spec={spec} />
      <div className="grid">
        <div className="span-7 stack">
          <KnowPanel spec={spec} />
        </div>
        <div className="span-5 stack">
          <DontKnowPanel spec={spec} />
        </div>
      </div>
      <DoPanel spec={spec} />
      <InterventionsPanel spec={spec} />
      <ExamplePanel spec={spec} />
      <SpeechPanel spec={spec} />
    </>
  );
}

function AgentsPage() {
  const r = useAgentSpec();
  const spec = r.data;
  return (
    <SiteLayout active="agents">
      <div className="as hw-page">
        <div className="page-title">
          <h1>How agents work</h1>
          {spec && (
            <span className="crumbs">
              Read live from the agents service · {prettyModel(spec.settings.model)}
              {spec.runId ? <> · run <span className="mono">{spec.runId}</span></> : null}
            </span>
          )}
        </div>
        {spec ? (
          <div className="stack">
            <Body spec={spec} />
          </div>
        ) : r.loading ? (
          <Note>Loading…</Note>
        ) : r.error ? (
          <Note tone="error">Can't reach the agents service right now. This page will fill in when it's back.</Note>
        ) : (
          <Note>This world's agents service doesn't publish how its agents work yet.</Note>
        )}
      </div>
    </SiteLayout>
  );
}

mount(<AgentsPage />);
