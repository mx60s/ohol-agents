// How agents work (agents.html): the game's rules for newcomers, then what an agent sees, knows,
// doesn't know and can do.
// Everything specific (prompt, actions, settings, limits, the example turn) comes from
// GET /api/agent-spec, which renders it from the agents service's own code. All model
// and game text renders as React text (escaped), never as HTML.
import type { ReactNode } from "react";
import type { AgentSpecIntervention, AgentSpecResponse, InterventionCategory } from "../api-types.ts";
import { pageHref, useAgentSpec } from "../data/index.ts";
import { formatClock } from "../shared/index.ts";
import { Note } from "../site/ui.tsx";
import "../site/site.css";
import "../site/agents.css";
import { MockBadge, Panel, Pill, SiteLayout, StatTile, StatTiles, prettyModel } from "../theme/index.ts";
import { mount } from "./mount.tsx";

const s1 = (ms: number) => `${Math.round(ms / 100) / 10} s`;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const num = (s: { value: string | null } | undefined) => (s?.value == null || s.value === "" || !Number.isFinite(Number(s.value)) ? null : Number(s.value));

/** Marks a rule we changed from stock One Hour One Life. */
const Ours = () => (
  <Pill tone="warn" title="Changed from stock One Hour One Life">
    our change
  </Pill>
);

/** A reply object, one field per line and one action per line. */
function formatReply(o: Record<string, unknown>): string {
  const lines = Object.entries(o).map(([k, v]) =>
    Array.isArray(v) ? `  ${JSON.stringify(k)}: [\n${v.map((x) => `    ${JSON.stringify(x)}`).join(",\n")}\n  ]` : `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`,
  );
  return `{\n${lines.join(",\n")}\n}`;
}

// ------------------------------------------------------------------ 0. the game

function GamePanel({ spec }: { spec: AgentSpecResponse }) {
  const st = spec.settings;
  const L = spec.limits;
  const cap = num(st.earlyMaxBabies);
  const capGens = num(st.earlyMaxGenerations);
  const langMin = num(st.languagesMinPlayers);
  const langS = num(st.langLearnSeconds);
  const items: [string, ReactNode][] = [
    [
      "Life",
      <>
        Everyone lives at most 60 years, one year per minute of game time.
        {st.turnClock ? (
          <>
            {" "}
            <Ours /> Here the world is paused while the agents think, so a year is {st.turnsPerYear} turns.
          </>
        ) : null}
      </>,
    ],
    [
      "Birth",
      <>
        The first woman of a family, an Eve, appears aged 14. Everyone else is born a baby to a living woman aged 14 to 40; nobody picks their mother.
        {cap ? (
          <>
            {" "}
            <Ours /> At most {cap} babies per woman in generations 1–{capGens ?? "?"}
            {st.noCooldownBypass.value === "1" ? ", and a mother still resting after a birth isn't given another" : null}.
          </>
        ) : null}
      </>,
    ],
    ["Babies", <>Under 3 they can't feed themselves. A woman aged 14 to 40 nurses a baby just by holding it.</>],
    ["Food", <>Food drains all the time, faster in the cold or heat, and an empty stomach kills. Wild food mostly doesn't grow back, so a camp soon needs farming.</>],
    ["Warmth", <>Fire, clothing and buildings.</>],
    ["Making things", <>You hold one thing at a time. Using what you hold on something changes one or both. Technology is long chains of these: a fire takes about 20 steps from things found in the wild.</>],
    ["Speech", <>Young children say about one letter per year of age; full sentences come at 16. Numbers can't be spoken. Speech carries {L.hearingRadius} tiles.</>],
    [
      "Languages",
      <>
        Each family has its own language: other families' words arrive scrambled.
        {(langMin != null && langMin <= 1) || langS ? (
          <>
            {" "}
            <Ours />
            {langMin != null && langMin <= 1 ? " Here from the first player on (stock: once 15 are alive)." : null}
            {langS ? <> Adults learn a family's language by living near its people in peace, most of it in about {plural(Math.round(langS / 60), "year")}.</> : null}
          </>
        ) : null}
      </>,
    ],
    [
      "Families and leaders",
      <>
        A family is an Eve's line. An Eve names herself and her family ("I AM &lt;FIRST&gt; &lt;FAMILY&gt;"), a mother names her baby ("YOU ARE &lt;FIRST&gt;"). "I FOLLOW YOU" makes someone your
        leader, and "ORDER, …" passes an order down to your followers. See the family and leadership trees on <a href={pageHref("families")}>Families</a>.
      </>,
    ],
    ["Death", <>Permanent for that character. The player comes back as someone new: here, a free seat waits to be born to a mother who can have a baby, and starts as a new Eve only when no woman can.</>],
  ];
  return (
    <Panel title="The game: One Hour One Life" variant="dark">
      <p className="hw-p">The agents play One Hour One Life, a multiplayer survival game by Jason Rohrer, on our own server. The rules, for anyone who hasn't played:</p>
      <dl className="hw-know hw-game">
        {items.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </Panel>
  );
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
          {prettyModel(st.model)}
          {st.selfHosted ? " (on our own GPU server)" : null} reads the system prompt and that page{st.reasoningCap ? <>, with up to about {st.reasoningMaxTokens.toLocaleString("en-US")} tokens of reasoning</> : null}.
          {st.turnClock ? " The world is paused meanwhile." : null}
        </>
      ),
    },
    { n: "3", title: "Reply", body: <>One JSON object: a thought, maybe a long-term goal, words to say, something to remember or forget, and an action{st.actionListMax > 1 ? <> or up to {st.actionListMax} in a row</> : null}.</> },
    {
      n: "4",
      title: "Act",
      body: st.turnClock ? (
        <>The world runs for {st.gameSecondsPerTurn} game seconds while code carries the actions out (walking, clicking) and records each result for next turn.</>
      ) : (
        <>Code carries it out in the game (walking, clicking) and records each result for next turn.</>
      ),
    },
    {
      n: "5",
      title: st.turnClock ? "Pause" : "Wait",
      body: st.turnClock ? (
        <>The world stops and everyone thinks again. An agent still walking or waiting sits the turn out.</>
      ) : (
        <>The next turn starts {s1(st.decisionCycleMs)} after this one began, or as soon as something happens.</>
      ),
    },
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
          Every turn is a fresh call: the system prompt plus one observation, no chat history.
          {st.turnClock ? <> A reply that takes longer than {s1(st.turnDecideTimeoutMs)} is dropped, and that agent does nothing that turn.</> : null} Things that
          {st.turnClock ? " end a wait early" : " wake an agent early"} and are listed under JUST HAPPENED: its food falling to half, a quarter or starving; being picked up or put down; giving birth;
          a hungry baby saying "F"; a death nearby; its name; speech within {spec.limits.wakeSpeechRadius} tiles.
        </p>
      </div>
      {st.turnClock ? (
        <StatTiles cols={4}>
          <StatTile value={st.gameSecondsPerTurn} suffix="s" label="Game time per turn" detail="the world is paused while agents think" />
          <StatTile value={st.turnsPerYear} label="Turns per year of life" detail="a year is 60 game seconds" />
          <StatTile value={s1(st.turnDecideTimeoutMs)} label="Time to reply" detail="real time; later replies are dropped" />
          <StatTile value={plural(st.babyIdleTurns, "turn")} label="Babies under 3" detail="decide this often when nothing happens" />
        </StatTiles>
      ) : (
        <StatTiles cols={5}>
          <StatTile value={s1(st.decisionCycleMs)} label="One turn" detail="real time, start to start" />
          <StatTile value={`${st.timeScale}×`} label="Time scale" detail={st.timeScale === 1 ? "stock game speed" : `game clock ${st.timeScale}× slower than stock`} />
          <StatTile value={st.gameSecondsPerTurn} suffix="s" label="Game time per turn" />
          <StatTile value={st.turnsPerYear} label="Turns per year of life" detail="a year is 60 game seconds" />
          <StatTile value={s1(st.babyDecisionIntervalMs)} label="Babies under 2" detail={`with nothing happening, up to ${s1(st.babyIdleMaxMs)}`} />
        </StatTiles>
      )}
    </Panel>
  );
}

// ------------------------------------------------------------------ 2. what they know

function KnowPanel({ spec }: { spec: AgentSpecResponse }) {
  const L = spec.limits;
  const st = spec.settings;
  const rows: [string, ReactNode][] = [
    [
      "You",
      <>
        Name, age, generation, flower, who they follow and who follows them; their long-term goal and how many turns ago they set it; their family's Home Marker (or, without one, where they
        were born); position and biome; food, with how fast it drains in turns; heat; wounds or sickness; what they hold and wear; a craving; the nearest water and fire within{" "}
        {L.resourceRadius} tiles; hand-pickable food nearby; dangerous animals in view.
      </>,
    ],
    [
      "People",
      <>
        Up to {L.maxPeople} within {L.peopleRadius} tiles: sex, age, flower, relation (mother, child, sibling, family), what they hold, if they're carried, walking or hurt. Id and name only for people the
        agent knows by name (see Names below); a stranger is "a woman, 30, with a red rose (you don't know their name)". Mothers: where each baby is. Where their children out of sight were last seen.
      </>,
    ],
    [
      "What you saw nearby",
      <>
        From the last {plural(L.seenTurns, "turn")}, at most {L.seenMax} lines: people coming and going, what others did to things (up to {L.seenPerPersonPerTurn} lines per person a turn), babies picked up
        or put down, who ate, who attacked whom, namings, births, deaths with their cause, dangerous animals. Also, beyond what a human sees: someone within {L.viewRadius} tiles trying
        something that did nothing ("tried a Flint Chip on a Sharp Stone at (3, 4): nothing happened"), repeats counted on one line.
      </>,
    ],
    ["Heard", <>The last {L.heardMax} lines from the past {plural(L.heardTurns, "turn")}, with who said them and whether another family's language differs; game notices; words written on the ground.</>],
    ["Things", <>Up to {L.maxThingKinds} kinds of object within {L.viewRadius} tiles, nearest first, with coordinates and timers on things that change soon.</>],
    ...(st.recipeHints ? ([["You could", <>Up to {L.maxHints} things the held item (or bare hands) would do to what's in view.</>]] as [string, ReactNode][]) : []),
    ["Search", <>The steps of their latest search (up to {L.searchSteps}), until the next one.</>],
    ["Your last actions", <>Their previous thought, the last {L.historyShown} action results, and why a reply was wasted if it was.</>],
    ...(st.memoryMode === "persistent" ? ([["Past lives", <>What this seat chose to remember in its earlier lives.</>]] as [string, ReactNode][]) : []),
    [
      "Things you chose to remember",
      <>Whatever they asked to remember this life, word for word, numbered and oldest first, each with how many turns ago they wrote it. Up to {L.keptMax} entries.</>,
    ],
    ["Just happened", <>The events since the last turn that would have woken them.</>],
  ];
  return (
    <Panel title="What they know" variant="green">
      <p className="hw-p">
        The observation is built only from what the character's own client received (one exception, marked below). Every turn, in this order:
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
        <b>Their memory.</b> They choose what to remember, for any reason: a "remember" in the reply is kept exactly as written (up to {L.rememberChars} characters), and nothing
        rewrites, filters or summarises it. A "forget" lets one go by its number. When all {L.keptMax} are in use, a new one pushes out the oldest, and they are told which. It lasts until they die.
      </p>
      <p className="hw-p">
        {st.promptBaseline === "playbook" ? (
          <>Before it, the same system prompt every turn: game facts a practised player knows, a ranked early-game playbook, our naming and flower rules, and the reply format.</>
        ) : (
          <>
            Before it, the same system prompt every turn: what a first-time player knows (how time, food, warmth and births work; how to pick up, put down and combine things; the phrases that
            name, lead and fight), our naming and flower rules, and the reply format. Facts only: no recipes and no strategy, except one line we added on giving directions with landmarks, since
            numbers can't be spoken.
          </>
        )}
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
      ? ["Their past lives", <>When a seat is reborn, its new character starts blank: no memories, goals or history carry over.</>]
      : ["Their past lives (partly)", <>Memory is set to persistent: what a seat chose to remember in earlier lives is shown, but nothing else carries over.</>],
    ["Earlier turns", <>No conversation history. Only the recent thoughts, the goal, the things they chose to remember, the latest search and the last {L.historyShown} results connect one turn to the next.</>],
    ["Anything out of view", <>Things beyond {L.viewRadius} tiles, people beyond {L.peopleRadius}, speech beyond about {L.hearingRadius}. No map of the world, no idea where other camps are.</>],
    ["Other minds", <>Never another agent's thoughts, goals or memories. Only what people say aloud and what they visibly hold.</>],
    ["Recipes", <>The prompt has none. They find out by trying, from the YOU COULD lines and from search, which work like a human player's hint panel.</>],
    [
      "Their personality",
      <>
        Every life has traits <MockBadge />, but they're only recorded and inherited. No prompt mentions them.
      </>,
    ],
    [
      "The site and the stream",
      <>
        Other models write the news, the story so far and the field notes{st.fieldNotesIntervalMs ? <> (every {Math.round(st.fieldNotesIntervalMs / 60000)} minutes)</> : null}, and a director
        {st.overheadModels.director ? <> ({prettyModel(st.overheadModels.director)})</> : null} picks who the stream follows
        {st.directorMinDwellMs ? <>: shots of at least {s1(st.directorMinDwellMs)}{st.directorCutawayMs ? <>, with a rare {s1(st.directorCutawayMs)} cutaway to something critical elsewhere</> : null}</> : null}.
        None of it reaches the agents.
      </>,
    ],
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
                <td>
                  {a.meaning}
                  {a.note && <span className="hw-note">In practice: {a.note}.</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="hw-p">
        Each result is a plain fact, told next turn: a far target refused, an ingredient marked "(not found in the wild: it is made)", a wound naming who or what caused it, "ORDER," said
        without followers heard as plain speech, numbers left out of speech, food offered to a baby refused because holding it nurses it.
      </p>
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
  const langMin = num(st.languagesMinPlayers);
  const langS = num(st.langLearnSeconds);
  const lang = (
    <>
      {langMin != null && langMin <= 1 ? "Each family speaks its own language" : `Once ${langMin ?? 15} or more people are alive, each family speaks its own language`}: other families' words arrive
      scrambled, and a heard line says when.{langS ? " Adults who live near another family in peace learn its language bit by bit." : null}
    </>
  );
  return (
    <Panel title="Speech and families" variant="mint">
      <div className="hw-speech">
      <ul className="hw-list">
        <li>
          <b>Hearing.</b> The game delivers speech within {L.hearingRadius} tiles. Speech within {L.wakeSpeechRadius} tiles {st.turnClock ? "ends a listener's wait" : "wakes a listener early"}.
        </li>
        <li>
          <b>Languages.</b> {lang}
        </li>
        <li>
          <b>Naming.</b> An Eve names herself and her family once: "I AM &lt;FIRST&gt; &lt;FAMILY&gt;". A mother holding her baby names it: "YOU ARE &lt;FIRST&gt;".
          {st.freeNames.value === "1" ? " Names are kept as spoken." : null}
        </li>
        <li>
          <b>Names.</b> An agent knows by name only itself, its family, anyone whose naming or introduction ("I AM …", "MY NAME IS …") it heard in words it could understand, and anyone it gave
          a name to in a "remember" ("the woman with the red rose is LIRA"; shown as its own name for them until it hears the real one). Everyone else appears without a number or name,
          described by what is visible, and is acted on by where they stand ("x","y"). A Fresh Grave says whose body it holds by the same rules. This page and the stream show everyone's true
          names.
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
      <GamePanel spec={spec} />
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
