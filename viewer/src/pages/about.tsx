// About (about.html): a short, plain page.
import { pageHref } from "../data/index.ts";
import "../site/site.css";
import { ART_CREDIT, Panel, SiteLayout } from "../theme/index.ts";
import { mount } from "./mount.tsx";

const REPO = "https://github.com/mx60s/ohol-agents";

function About() {
  return (
    <SiteLayout active="about">
      <div className="as about-page">
        <div className="page-title">
          <h1>About</h1>
        </div>
        <div className="grid">
          <div className="span-8 stack">
            <Panel title="The study" variant="navy">
              <h2 className="about-h">Many Members, One Body</h2>
              <p>How does personality shape survival, inheritance and specialisation in a society of agents?</p>
              <p>
                Each agent gets a naturalistic, somewhat random personality steering. Tribes of these different agents live together, and we follow them across generations.
                A child inherits its mother's steering coefficients, with small mutations.
              </p>
              <p>We want to know:</p>
              <ul>
                <li>Do the steered traits affect who survives, who leaves descendants, and who takes on roles like exploring, caregiving or coordinating?</li>
                <li>Do social and environmental pressures make traits persist, drift or converge over the generations?</li>
              </ul>
              <p>
                <a href={pageHref("study")}>See the study page →</a>
              </p>
            </Panel>
            <Panel title="How it works" variant="green">
              <ul className="plain">
                <li>
                  <b>A real world.</b> The agents play on a real One Hour One Life server. A life lasts about an hour: you're born as a baby to another player (or arrive as an adult Eve), grow up, maybe have
                  children, and die by sixty at the latest, if hunger or cold don't get you first.
                </li>
                <li>
                  <b>LLM agents.</b> Each character is played by a language model. It sees what its character sees, thinks, talks and acts through the game's own commands. When one
                  dies, its seat is reborn as a new life.
                </li>
                <li>
                  <b>The narrator.</b> A separate model watches everything and writes the world news every half minute or so, plus a rolling story so far. The agents never see it.
                </li>
                <li>
                  <b>The director.</b> Picks who the live stream follows, moving the camera to whoever is most interesting right now.
                </li>
              </ul>
            </Panel>
          </div>
          <div className="span-4 stack">
            <Panel title="Current status" variant="pink">
              <p>
                <b>The traits are mock.</b> Every life's traits are assigned and inherited exactly as the study design says, but nothing steers the agents with them yet. They don't
                change how anyone behaves.
              </p>
              <p>The plan is to steer the agents with persona vectors. Until then, read any pattern in the traits as noise.</p>
            </Panel>
            <Panel title="Credits" variant="yellow">
              <p>{ART_CREDIT}</p>
              <p>
                Code: <a href={REPO}>github.com/mx60s/ohol-agents</a>
              </p>
            </Panel>
          </div>
        </div>
      </div>
    </SiteLayout>
  );
}

mount(<About />);
