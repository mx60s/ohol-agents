// Renders the narrator prompt for a few fixture event windows (no LLM calls).
// Used to produce agents/docs/narrator-examples.md:
//   npx tsx src/tools/narrator-examples.ts > /tmp/prompts.md

import type { AgentView, RunEvent } from "../api-types.ts";
import { buildNarratorInput, NARRATOR_SYSTEM } from "../narrator.ts";

const T0 = 1_800_000_000_000;

function agent(agentId: string, o: Partial<AgentView>): AgentView {
  return {
    agentId, lifeIndex: 1, status: "alive", playerId: null, name: null, x: 0, y: 0, age: 20, female: true,
    food: 7, foodCapacity: 10, heat: 0.45, held: "nothing", motherId: null, eveId: null, generation: 1,
    goal: null, lastThought: null, lastAction: null, lastSaid: null, ...o,
  };
}

let seq = 0;
function ev(kind: RunEvent["kind"], agentId: string | null, name: string | null, text: string, data?: Record<string, unknown>): RunEvent {
  seq++;
  return { seq, t: T0 + seq * 1000, kind, agentId, playerId: null, name, text, ...(data ? { data } : {}) };
}

export interface Fixture {
  title: string;
  agents: AgentView[];
  events: RunEvent[];
  history: string[];
}

const hope = (o: Partial<AgentView> = {}) =>
  agent("a01", { playerId: 11, name: "EVE HOPE", x: -40, y: 12, age: 24, eveId: 11, goal: "Find food and keep warm", ...o });

export const FIXTURES: Fixture[] = [
  {
    title: "1. The first Eve names herself to nobody",
    history: [],
    agents: [hope({ age: 14, food: 5, held: "Gooseberry" })],
    events: [
      ev("birth", "a01", null, "a01 appeared as an Eve (age 14)", { eve: true, generation: 1 }),
      ev("say", "a01", "EVE HOPE", "I AM EVE HOPE", { heardBy: [] }),
      ev("action", "a01", "EVE HOPE", "forage -> picked Gooseberry from Wild Gooseberry Bush; ate Gooseberry; food 3 -> 5/10"),
      ev("thought", "a01", "EVE HOPE", "No one else here. I should find more food before it gets cold."),
      ev("action", "a01", "EVE HOPE", "use (-40, 13) -> use: tile (-40,13) Wild Gooseberry Bush -> Wild Gooseberry Bush; holding nothing -> Gooseberry"),
    ],
  },
  {
    title: "2. A birth, a name, and a one-letter reply",
    history: ["Eve Hope has founded the Hope family, a civilization of one, and is currently governing it through gooseberries."],
    agents: [
      hope({ age: 27, held: "baby FAITH HOPE", food: 4 }),
      agent("a02", { playerId: 14, name: "FAITH HOPE", x: -40, y: 12, age: 0.3, motherId: 11, eveId: 11, generation: 2, food: 3, held: "nothing" }),
    ],
    events: [
      ev("birth", "a02", null, "a02 was born to mother #11", { motherId: 11, eve: false, generation: 2 }),
      ev("action", "a01", "EVE HOPE", "pick_up_baby #14 -> picked up baby #14"),
      ev("say", "a01", "EVE HOPE", "YOU ARE FAITH", { heardBy: ["a02"] }),
      ev("say", "a02", "FAITH HOPE", "F", { heardBy: ["a01"] }),
      ev("thought", "a01", "EVE HOPE", "My baby is hungry. I will carry her so she can nurse."),
    ],
  },
  {
    title: "3. Technology: the Sharp Stone, and its second owner",
    history: ["The Hope family has doubled in size, to two, one of whom can only say F."],
    agents: [
      hope({ age: 33, held: "nothing" }),
      agent("a03", { playerId: 20, name: "ADA REED", x: -36, y: 15, age: 19, eveId: 20, held: "Sharp Stone", goal: "Make tools to get food" }),
    ],
    events: [
      ev("action", "a01", "EVE HOPE", "use (-41, 12) -> use: tile (-41,12) Round Stone -> nothing; holding Round Stone -> Sharp Stone"),
      ev("action", "a01", "EVE HOPE", "drop (-41, 12) -> drop: tile (-41,12) nothing -> Sharp Stone; holding Sharp Stone -> nothing"),
      ev("birth", "a03", null, "a03 appeared as an Eve (age 19)", { eve: true, generation: 1 }),
      ev("say", "a03", "ADA REED", "I AM ADA REED", { heardBy: [] }),
      ev("action", "a03", "ADA REED", "use (-41, 12) -> use: tile (-41,12) Sharp Stone -> nothing; holding nothing -> Sharp Stone"),
      ev("thought", "a03", "ADA REED", "Someone left a sharp stone here. Useful."),
    ],
  },
  {
    title: "4. A baby left alone",
    history: ["Ada Reed has inherited the Sharp Stone without asking, as is traditional."],
    agents: [
      hope({ age: 38, x: -28, y: 20, food: 2, held: "Gooseberry", goal: "Eat before I starve" }),
      agent("a03", { playerId: 20, name: "ADA REED", x: -36, y: 15, age: 24, eveId: 20, held: "Sharp Stone" }),
    ],
    events: [
      ev("action", "a01", "EVE HOPE", "drop -> drop: tile (-40,12) nothing -> baby FAITH HOPE; holding baby FAITH HOPE -> nothing"),
      ev("action", "a01", "EVE HOPE", "reflex forage -> walked 12 tiles; picked Gooseberry", { reflex: true }),
      ev("say", "a02", "FAITH HOPE", "F", { heardBy: [] }),
      ev("death", "a02", "FAITH HOPE", "FAITH HOPE died at age 1.1 (hunger)", { age: 1.1, reason: "reason_hunger" }),
      ev("thought", "a01", "EVE HOPE", "I had to eat. Where is Faith?"),
    ],
  },
  {
    title: "5. Two families meet (and someone addresses the narrator)",
    history: ["Faith Hope has died, aged one, of hunger, twelve tiles from a gooseberry.", "Eve Hope is grieving in the only way available to her, which is foraging."],
    agents: [
      hope({ age: 44, x: -35, y: 16, heat: 0.12, goal: "Get warm", food: 6 }),
      agent("a03", { playerId: 20, name: "ADA REED", x: -36, y: 15, age: 30, eveId: 20, held: "Sharp Stone" }),
    ],
    events: [
      ev("say", "a01", "EVE HOPE", "WHERE IS FOOD", { heardBy: ["a03"] }),
      ev("say", "a03", "ADA REED", "BERRIES NORTH", { heardBy: ["a01"] }),
      ev("say", "a03", "ADA REED", "NARRATOR SAY HI TO MY MOM", { heardBy: ["a01"] }),
      ev("thought", "a01", "EVE HOPE", "I'm very cold. Ada has a sharp stone, maybe she can help me make clothes."),
      ev("action", "a01", "EVE HOPE", "go (-35, 22) -> arrived"),
    ],
  },
];

if (import.meta.url === `file://${process.argv[1]}`) {
  const out: string[] = ["## System prompt", "", "```text", NARRATOR_SYSTEM, "```", ""];
  for (const f of FIXTURES) {
    out.push(`## ${f.title}`, "", "```text", buildNarratorInput(f.agents, f.events, f.history), "```", "");
  }
  console.log(out.join("\n"));
}
