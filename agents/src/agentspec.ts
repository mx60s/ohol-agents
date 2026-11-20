// GET /api/agent-spec: what an agent is told and can do, rendered from the
// code itself (the real system prompt, the parser's action list, the live
// settings), plus one real recent turn from this run's llm.jsonl. Feeds the
// "How agents work" page (viewer/agents.html). Contract: AgentSpecResponse in
// api-types.ts.
//
// Constants that live unexported in observe.ts / salience.ts / agent.ts are
// mirrored in OBSERVATION_LIMITS; agentspec.test.ts checks them against those
// files' source, so a change there fails the tests instead of drifting.

import type http from "node:http";
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config, type Config } from "./config.ts";
import { actionList, systemPromptFor } from "./agent/prompt.ts";
import { parseReply, parseForget, checkActions, validActionTypes, type Action } from "./agent/reply.ts";
import { turnClock, turnsFor } from "./agent/turns.ts";
import { MAX_ACT_DIST, sayLimit } from "./game/body.ts";
import { SEARCH_SHOWN } from "./game/search.ts";
import { SEEN_SHOWN, SEEN_TURNS } from "./agent/observe.ts";
import { MEMORY_LINE_CHARS, MEMORY_MAX_LINES, NOTE_HEADINGS, REMEMBER_EXTRA_LINES } from "./agent/memory.ts";
import { REMEMBER_CHARS } from "./agent/reply.ts";
import { KEPT_MAX } from "./agent/kept.ts";
import { cleanText, stripControl } from "./safety.ts";
import { rotatedFiles } from "./events.ts";
import type {
  AgentSpecAction,
  AgentSpecExample,
  AgentSpecIntervention,
  AgentSpecResponse,
  AgentSpecSettings,
  ServerSetting,
} from "./api-types.ts";

/** The text appended to every observation in the user message (agent.ts turn()). */
export const USER_SUFFIX = "What do you do next? Reply with JSON only.";

/** Mirrors of unexported constants (checked against the source by agentspec.test.ts). */
export const OBSERVATION_LIMITS = {
  /** observe.ts VIEW_RADIUS: things listed */
  viewRadius: 12,
  /** observe.ts VIEW_RADIUS + 4: people listed */
  peopleRadius: 16,
  /** observe.ts RESOURCE_RADIUS: nearest water / heat, food by hand */
  resourceRadius: 20,
  /** observe.ts MAX_KINDS */
  maxThingKinds: 20,
  /** observe.ts MAX_HINTS */
  maxHints: 8,
  /** observe.ts: people listed, nearest first */
  maxPeople: 10,
  /** observe.ts HISTORY_SHOWN */
  historyShown: 30,
  /** observe.ts HEARD_SHOWN_MS: heard lines kept for 90 s (turn clock: the same number of 8 s turns), last 10 */
  heardWindowS: 90,
  heardMax: 10,
  /** observe.ts WHAT YOU SAW NEARBY: events from the last SEEN_TURNS turns, at most SEEN_SHOWN lines */
  seenTurns: SEEN_TURNS,
  seenMax: SEEN_SHOWN,
  /** world.ts SEEN_DID_PER_TURN: lines about one person's doings per turn (more are counted on the last) */
  seenPerPersonPerTurn: 4,
  /** memory.ts: the note-taker's yearly notes ("YOUR NOTES") are at most this many lines (plus headings) of this many chars */
  memoryLines: MEMORY_MAX_LINES,
  memoryLineChars: MEMORY_LINE_CHARS,
  /** reply.ts REMEMBER_CHARS: one "remember" entry */
  rememberChars: REMEMBER_CHARS,
  /** search.ts SEARCH_SHOWN: steps shown in the SEARCH section */
  searchSteps: SEARCH_SHOWN,
  /** body.ts MAX_ACT_DIST: use, drop, swap and take_out refuse a tile farther than this */
  maxActDist: MAX_ACT_DIST,
  /** salience.ts HEAR_RADIUS: speech this close wakes an agent early */
  wakeSpeechRadius: 10,
  /** server.cpp maxSpeechRadius (Euclidean): speech is delivered this far */
  hearingRadius: 16,
  /** agent.ts: reflex forage at food <= this (age 3+), at most every 20 s */
  reflexFood: 2,
} as const;

/** The reply object's fields, as agent.ts reads them (caps from cleanText calls there); keptMax = MEMORY_MAX_ENTRIES. */
export function replyFields(keptMax: number): { name: string; meaning: string }[] {
  return [
    { name: "thought", meaning: "one short sentence; shown back to it next turn as its previous thought (max 400 chars)" },
    { name: "goal", meaning: "optional: what the agent is working on now; kept and shown every turn with its age until it changes (max 200 chars)" },
    { name: "say", meaning: "optional; spoken aloud now, before the action; digits are removed; a baby naming line ('YOU ARE X') waits for a pick_up_baby in the same reply (max 200 chars, cut further by age)" },
    { name: "remember", meaning: `optional: anything the agent wants to remember, for any reason; kept verbatim with when it was made and listed every turn under THINGS YOU CHOSE TO REMEMBER, numbered, oldest first (up to ${keptMax} entries, the oldest dropped when full; an exact duplicate is not added; max ${REMEMBER_CHARS} chars). A name stated for one stranger in view ("the woman with the red rose is LIRA") becomes the agent's own name for them` },
    { name: "forget", meaning: "optional: the number of a memory as listed (or its exact text) to let go; done before a remember in the same reply" },
    { name: "action", meaning: "one action object (see the table)" },
    { name: "actions", meaning: "instead of action: a list of steps run back to back" },
  ];
}
export const REPLY_FIELDS = replyFields(KEPT_MAX);

/** How the harness carries out an action, beyond the prompt's one line (shown next to it on the site). */
export const ACTION_NOTES: Record<string, string> = {
  use: `refused if the tile is more than ${MAX_ACT_DIST} tiles away`,
  drop: `refused if the tile is more than ${MAX_ACT_DIST} tiles away`,
  swap: `refused if the tile is more than ${MAX_ACT_DIST} tiles away`,
  take_out: `refused if the tile is more than ${MAX_ACT_DIST} tiles away`,
  pick_up_baby: `or "x","y": the person on that tile or nearest to it within 1`,
  feed: `or "x","y": the person on that tile or nearest to it within 1`,
  give: `or "x","y": the person on that tile or nearest to it within 1`,
  search: `like the game client's hint search ("/fire"): matches whole words in object names, picks the cheapest recipe and lists it first step first (up to ${SEARCH_SHOWN} steps) in a SEARCH section shown every turn until the next search; takes no game time`,
};

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** A server .ini value: OHOL_SETTING_<name> (what server/run.sh writes) wins over server/settings/<name>.ini. */
export function serverSetting(name: string, env: NodeJS.ProcessEnv = process.env, dir = path.join(REPO_ROOT, "server/settings")): ServerSetting {
  const e = env[`OHOL_SETTING_${name}`];
  if (e != null && e !== "") return { value: e.trim(), source: "env" };
  try {
    const f = path.join(dir, `${name}.ini`);
    if (existsSync(f)) return { value: readFileSync(f, "utf8").trim(), source: "settings file" };
  } catch {
    // unreadable: unknown
  }
  return { value: null, source: "unknown" };
}

const on = (s: ServerSetting): boolean | null => (s.value == null ? null : s.value === "1");

/** Every action in the system prompt, parsed from actionList() (the same text the model reads). */
export function actionCatalogue(cfg: Pick<Config, "craftMacro" | "actionListMax">): AgentSpecAction[] {
  const lines = actionList({ craft: cfg.craftMacro !== false, actionListMax: cfg.actionListMax }).split("\n");
  const out: AgentSpecAction[] = [];
  for (const line of lines) {
    const m = /^- (\{.*?\})\s{2}(.*)$/.exec(line);
    if (!m) continue;
    const template = m[1];
    const type = /"type":"([a-z_]+)"/.exec(template)?.[1];
    if (!type) continue;
    const fields = [...template.matchAll(/"([a-z_]+)":/g)].map((x) => x[1]).filter((f) => f !== "type");
    const note = ACTION_NOTES[type];
    out.push({ type, template, fields, meaning: m[2], ...(note ? { note } : {}), ...(type === "craft" ? { temporary: true } : {}) });
  }
  return out;
}

/** Letters a person can say at a few ages (body.ts sayLimit, ported from the client's getSayLimit). */
export function sayLimits(): { age: number; letters: number }[] {
  return [0, 1, 2, 3, 5, 8, 10, 12, 14, 16, 20, 40, 60].map((age) => ({ age, letters: sayLimit(age) }));
}

export function specSettings(cfg: Config, env: NodeJS.ProcessEnv = process.env): AgentSpecSettings {
  const clock = turnClock(cfg);
  return {
    model: cfg.llmModelName,
    selfHosted: !/openrouter\.ai/.test(cfg.llmBaseUrl),
    overheadModels: {
      narrator: cfg.narratorModel,
      director: cfg.directorEngine === "jev" ? cfg.directorJevModel : cfg.directorEngine === "llm" ? cfg.directorModel : null,
      story: cfg.storyModel,
      fieldNotes: cfg.fieldNotesIntervalMs > 0 ? cfg.fieldNotesModel : null,
    },
    directorMinDwellMs: cfg.directorIntervalMs > 0 ? cfg.directorMinDwellMs : null,
    directorCutawayMs: cfg.directorIntervalMs > 0 && cfg.directorCutawayMs > 0 ? cfg.directorCutawayMs : null,
    fieldNotesIntervalMs: cfg.fieldNotesIntervalMs > 0 ? cfg.fieldNotesIntervalMs : null,
    turnClock: !!clock.lockstep,
    turnDecideTimeoutMs: cfg.turnDecideTimeoutMs,
    babyIdleTurns: cfg.babyIdleTurns,
    decisionCycleMs: clock.cycleMs,
    babyDecisionIntervalMs: cfg.babyDecisionIntervalMs,
    babyIdleMaxMs: cfg.babyIdleMaxMs,
    timeScale: clock.timeScale,
    gameSecondsPerTurn: Math.round((clock.cycleMs / 1000 / clock.timeScale) * 100) / 100,
    turnsPerYear: Math.round(turnsFor(60, clock) * 10) / 10,
    reasoningCap: cfg.llmReasoningCap,
    reasoningMaxTokens: cfg.llmReasoningMaxTokens,
    decisionMaxTokens: cfg.llmDecisionMaxTokens,
    maxTokens: cfg.llmMaxTokens,
    reasoningEffort: cfg.llmReasoningEffort || null,
    actionListMax: cfg.actionListMax,
    promptBaseline: cfg.promptBaseline,
    craftMacro: cfg.craftMacro,
    recipeHints: cfg.recipeHints,
    memoryMode: cfg.memoryMode,
    memorySummary: cfg.memorySummary,
    memorySummaryTurns: cfg.memorySummaryTurns,
    memoryYears: !!cfg.memoryYears && !cfg.memorySummary,
    memoryYearLines: cfg.memoryYearLines ?? 2,
    traitSource: cfg.traitSource,
    foodBonus: serverSetting("mtsNewPlayerFoodBonus", env),
    foodBonusSecondsPerPip: serverSetting("newPlayerFoodDecrementSecondsBonus", env),
    freeNames: serverSetting("mtsFreeNames", env),
    playerSaves: serverSetting("mtsPlayerSaves", env),
    earlyMaxBabies: serverSetting("mtsEarlyMaxBabies", env),
    earlyMaxGenerations: serverSetting("mtsEarlyMaxGenerations", env),
    noCooldownBypass: serverSetting("mtsNoCooldownBypass", env),
    languagesMinPlayers: serverSetting("minActivePlayersForLanguages", env),
    langLearnSeconds: serverSetting("mtsLangFullSeconds", env),
  };
}

/** MEMORY_MAX_ENTRIES: entries in THINGS YOU CHOSE TO REMEMBER */
function keptMaxOf(cfg: Config): number {
  return cfg.memoryMaxEntries ?? KEPT_MAX;
}

/** The declared interventions (README "Interventions"), with on/off from the live config where it has a switch. */
export function interventions(cfg: Config, s: AgentSpecSettings): AgentSpecIntervention[] {
  const L = OBSERVATION_LIMITS;
  const list: AgentSpecIntervention[] = [
    // human-UI equivalent: what the official client gives a human, as text
    { id: "pathing", name: "Click-to-walk pathfinding", category: "human-ui", on: true, detail: "walking and auto-approach before using something; paths keep a jump (4 tiles) from known dangerous animals" },
    { id: "screen-as-text", name: "The screen as text", category: "human-ui", on: true, detail: `own body, wounds and sickness; people within ${L.peopleRadius} tiles; things within ${L.viewRadius}; hunger and heat as numbers` },
    { id: "food-rate", name: "Food drain rate", category: "human-ui", on: true, detail: "how fast food drains and when it runs out, in turns (a human watches the bar)" },
    { id: "home", name: "Home Marker arrow", category: "human-ui", on: true, detail: "position and direction of the family's Home Marker, as the client tracks it" },
    { id: "water-fire", name: "Nearest water and fire", category: "human-ui", on: true, detail: `within ${L.resourceRadius} tiles, with direction` },
    { id: "timers", name: "Timers on short-lived things", category: "human-ui", on: true, detail: "fire, coals, tinder, hot iron, ripe crops and held items that change on their own within 5 minutes: what they become and in how many turns (a human sees the fire shrink)" },
    { id: "danger", name: "Danger line", category: "human-ui", on: true, detail: `dangerous animals within ${L.viewRadius} tiles, with distance and direction; paths keep 4 tiles (a jump) away` },
    { id: "action-lists", name: "Action lists", category: "human-ui", on: cfg.actionListMax > 1, detail: `up to ${cfg.actionListMax} actions back to back, like quick clicks; stops at a failure or an event` },
    { id: "stale-check", name: "Stale-target check", category: "human-ui", on: true, detail: "a target that changed while the model was thinking is not acted on; the model is told" },
    { id: "names", name: "Names only as heard", category: "human-ui", on: true, detail: "an agent knows by name itself, its family, anyone whose naming or introduction it heard (unscrambled), and anyone it gave a name to in a remember note (shown as its own name for them); everyone else is a stranger with no #number and no name, described by sex, age, flower and, for look-alikes, what they hold or where they stand; people without a #number are targeted by x,y. Saved per life across restarts. The site and stream show true names" },
    { id: "graves", name: "Whose grave", category: "human-ui", on: true, detail: "a Fresh Grave says whose body it holds (from the server's grave message, or a death seen next to it; nothing when two deaths fit), by the same name rules, until it decays into a Grave (the client shows the name on hover)" },
    { id: "turns", name: "Durations in turns", category: "human-ui", on: true, detail: "every time is converted from game seconds into decision turns" },
    // like human experience or the wiki
    { id: "playbook", name: "Game facts and playbook in the prompt", category: "wiki", on: cfg.promptBaseline === "playbook", detail: "food values, cold, babies and nursing, camp priorities, naming phrases (PROMPT_BASELINE=playbook; the default new-player prompt has only what a first-time player knows, the controls and our rules)" },
    { id: "recipe-hints", name: "Recipe hints", category: "wiki", on: cfg.recipeHints, detail: `what the held item or bare hands would do to nearby things (up to ${L.maxHints})` },
    // beyond a human player
    { id: "craft", name: "craft <item> macro (temporary)", category: "beyond-human", on: cfg.craftMacro, detail: "plans the recipe chain from what is in view and does the steps itself; may be removed before the main study" },
    { id: "forage", name: "Forage action", category: "beyond-human", on: true, detail: "one action walks to hand-pickable food, picks it and eats it; code picks the food" },
    { id: "reflex", name: "Starvation reflex", category: "beyond-human", on: true, detail: `at food <= ${L.reflexFood} (age 3+), code forages without asking the model` },
    { id: "food-summary", name: "Food summary", category: "beyond-human", on: true, detail: `hand-pickable food left within ${L.resourceRadius} tiles, with the nearest spots` },
    { id: "babies-line", name: "Where my babies are", category: "beyond-human", on: true, detail: "a mother is told where each of her babies under 3 is" },
    { id: "birth-spot", name: "Birth spot as home", category: "beyond-human", on: true, detail: "without a Home Marker, the coordinates of the birth spot" },
    { id: "failed-nearby", name: "Failed actions nearby", category: "beyond-human", on: true, detail: `agents see when someone near them (within ${L.viewRadius} tiles, age 3+) tried something that did nothing: a use, drop, swap, take-out or feeding the game refused; facts only, no reasons, repeats counted on one line under WHAT YOU SAW NEARBY. No client learns of such a try, since nothing in the world changed` },
    { id: "events", name: "Event-driven turns", category: "beyond-human", on: true, detail: "hunger thresholds, births, deaths, being picked up, a hungry baby's \"F\" and nearby speech end a wait early and are listed under JUST HAPPENED" },
    { id: "wasted-turns", name: "Wasted-turn feedback", category: "beyond-human", on: true, detail: "a malformed reply or invalid action is explained next turn" },
    { id: "reasoning-cap", name: "Mild reasoning cap", category: "beyond-human", on: cfg.llmReasoningCap, detail: `about ${cfg.llmReasoningMaxTokens} reasoning tokens within ${cfg.llmDecisionMaxTokens} in total` },
    { id: "kept-memory", name: "Agent-kept memory", category: "beyond-human", on: true, detail: `up to ${keptMaxOf(cfg)} entries the agent chooses, verbatim: each "remember" (max ${L.rememberChars} chars) is listed every turn under THINGS YOU CHOSE TO REMEMBER, numbered, oldest first, with its age in turns; "forget" lets one go by number or text; a new entry on a full list drops the oldest and the agent is told; no rewriting, filtering or summarising. Saved per life across restarts` },
    { id: "memory-summary", name: "Yearly notes", category: "beyond-human", on: cfg.memorySummary, detail: `off by default (MEMORY_SUMMARY=1 turns it on): every ${cfg.memorySummaryTurns} turns a separate note-taker call (the agents' own model) rewrites this life's notes in the background from a transcript of the year (actions and results, what was seen nearby, notices, what people said as claims; not the agent's thoughts): at most ${L.memoryLines} lines of facts under headings, no plans, shown every turn; things the agent asked to remember are included, with up to ${REMEMBER_EXTRA_LINES} more lines; notes cut off by the length limit are discarded` },
    { id: "year-lines", name: "Year lines", category: "beyond-human", on: !!cfg.memoryYears && !cfg.memorySummary, detail: `off by default (MEMORY_SUMMARY=years turns it on): every ${cfg.memorySummaryTurns} turns (a game year) a separate call to the agents' own model writes one line (max ${MEMORY_LINE_CHARS} chars, second person) of facts from that year's transcript alone (actions and results, what was seen nearby, notices, what people said as claims; not the agent's thoughts, not earlier lines): what you did and made, where, with whom, births, deaths, injuries; no advice or plans. YOUR PAST YEARS shows the last ${cfg.memoryYearLines ?? 2} (MEMORY_YEAR_LINES) of this life; saved per life across restarts` },
    { id: "memory", name: "Notes from past lives", category: "beyond-human", on: cfg.memoryMode === "persistent", detail: "MEMORY_MODE=persistent carries what a slot chose to remember (and its yearly notes, if on) into its next life; off = each life starts fresh" },
    // declared changes to the game
    { id: "food-bonus", name: "New-player food bonus", category: "game-setting", on: on(s.foodBonus), detail: `+${s.foodBonusSecondsPerPip.value ?? "?"} s on every food pip, every life (stock OHOL gives it to newcomers)` },
    { id: "turn-clock", name: "Turn clock", category: "game-setting", on: s.turnClock, detail: `the game world is paused while the agents think, then runs ${s.gameSecondsPerTurn} game seconds per turn` },
    { id: "time-scale", name: "Time dilation", category: "game-setting", on: s.timeScale !== 1, detail: `game clock ${s.timeScale}x slower than stock` },
    { id: "early-birth-cap", name: "Early birth cap", category: "game-setting", on: s.earlyMaxBabies.value == null ? null : Number(s.earlyMaxBabies.value) > 0, detail: `at most ${s.earlyMaxBabies.value ?? "?"} babies per woman in generations 1-${s.earlyMaxGenerations.value ?? "?"}, so early camps grow through daughters` },
    { id: "birth-cooldown", name: "Birth cooldowns kept", category: "game-setting", on: on(s.noCooldownBypass), detail: "a mother still resting after a birth never gets another baby (stock skips the rest when every mother is resting); a free seat waits for a mother who will be ready instead of starting as a new Eve" },
    { id: "language-learning", name: "Languages learned by living together", category: "game-setting", on: s.langLearnSeconds.value == null ? null : Number(s.langLearnSeconds.value) > 0, detail: `adults of different families within speech range learn each other's language while at peace (most of it in about ${s.langLearnSeconds.value ?? "?"} game seconds together); in stock OHOL a language is learned only by hearing it spoken` },
    { id: "flowers", name: "Per-person flowers", category: "game-setting", on: true, detail: "everyone wears a flower, unique among living family members" },
    { id: "free-names", name: "Free names", category: "game-setting", on: on(s.freeNames), detail: "names are used as spoken, not snapped to the server's name lists; no family name is ever used twice, and a repeated first name in a family gets a numeral (AURORA II)" },
    { id: "player-saves", name: "Player saves", category: "game-setting", on: on(s.playerSaves), detail: "living characters survive a server restart" },
  ];
  return list;
}

// ------------------------------------------------------------------ example turn

export const EXAMPLE_CAPS = {
  observation: 9000,
  reasoning: 3000,
  replyText: 2000,
  results: 6,
  result: 400,
  /** bytes read from the end of llm.jsonl / events.jsonl */
  tailBytes: 4 * 1024 * 1024,
  /** youngest age that counts as an adult */
  adultAge: 14,
};

/** The last `max` bytes of a file as complete lines (the first, possibly torn, line dropped). */
export function readTailLines(file: string, max: number): string[] {
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch {
    return [];
  }
  try {
    const size = fstatSync(fd).size;
    const n = Math.min(size, max);
    if (n <= 0) return [];
    const buf = Buffer.alloc(n);
    readSync(fd, buf, 0, n, size - n);
    const lines = buf.toString("utf8").split("\n");
    if (n < size) lines.shift();
    return lines.filter(Boolean);
  } finally {
    closeSync(fd);
  }
}

/** Multi-line text, cleaned: no control or invisible chars (newlines kept), capped. */
function cleanBlock(s: unknown, max: number): string {
  if (typeof s !== "string") return "";
  let t = stripControl(s).replace(/\r/g, "").replace(/\t/g, " ").trim();
  if (t.length > max) t = t.slice(0, max - 1).replace(/[\uD800-\uDBFF]$/, "").trimEnd() + "…";
  return t;
}

interface LlmLine {
  t: number;
  agentId: string;
  playerId: number | null;
  lifeIndex?: number;
  observation?: string;
  reply?: string;
  reasoning?: string;
  model?: string;
  finishReason?: string;
  error?: unknown;
}

const parseLine = <T>(l: string): T | null => {
  try {
    return JSON.parse(l) as T;
  } catch {
    return null;
  }
};

function ageOf(observation: string): number | null {
  const m = /\bAge (\d+(?:\.\d+)?) of at most 60\b/.exec(observation);
  return m ? Number(m[1]) : null;
}

/** A reply as the harness used it: only known fields, each cleaned as agent.ts cleans it. */
function cleanReply(v: Record<string, unknown>, steps: Action[]): AgentSpecExample["reply"] {
  const out: AgentSpecExample["reply"] = {};
  const thought = cleanText(v.thought, 400);
  if (thought) out.thought = thought;
  const goal = cleanText(v.goal, 200);
  if (goal) out.goal = goal;
  const say = cleanText(v.say, 200);
  if (say) out.say = say;
  const remember = cleanText(v.remember, REMEMBER_CHARS);
  if (remember) out.remember = remember;
  const forget = parseForget(v);
  if (forget != null) out.forget = String(forget);
  const plain = steps.map((a) => Object.fromEntries(Object.entries(a).filter(([, x]) => x !== undefined)) as Record<string, unknown>);
  if (plain.length === 1 && !Array.isArray(v.actions)) out.action = plain[0];
  else out.actions = plain;
  return out;
}

/**
 * The most recent completed decision by an adult (age >= 14) in this run dir:
 * a reply that parsed, with a valid action, and a later turn by the same
 * character (so its actions have finished). A turn that only waited is used
 * only when no other is found nearby. Results come from events.jsonl. Reads
 * only the files' tails.
 */
export function findExampleTurn(runDir: string, cfg: Pick<Config, "craftMacro" | "actionListMax">, caps = EXAMPLE_CAPS): AgentSpecExample | null {
  let llm = readTailLines(path.join(runDir, "llm.jsonl"), caps.tailBytes);
  let events = readTailLines(path.join(runDir, "events.jsonl"), caps.tailBytes);
  if (llm.length < 2) {
    // just rotated: the previous generation has the history
    const prev = (f: string) => rotatedFiles(runDir, f).slice(-1)[0];
    const llmPrev = prev("llm.jsonl"), evPrev = prev("events.jsonl");
    if (llmPrev) llm = [...readTailLines(path.join(runDir, llmPrev), caps.tailBytes), ...llm];
    if (evPrev) events = [...readTailLines(path.join(runDir, evPrev), caps.tailBytes), ...events];
  }
  const recs = llm.map((l) => parseLine<LlmLine>(l)).filter((r): r is LlmLine => !!r && typeof r.t === "number" && typeof r.agentId === "string");
  const nextOf = new Map<number, number>(); // index -> t of the same character's next decision
  const lastSeen = new Map<string, number>();
  for (let i = recs.length - 1; i >= 0; i--) {
    const k = `${recs[i].agentId}|${recs[i].playerId}`;
    const n = lastSeen.get(k);
    if (n != null) nextOf.set(i, n);
    if (typeof recs[i].observation === "string") lastSeen.set(k, recs[i].t);
  }
  let evs: { t: number; kind: string; agentId: string | null; playerId: number | null; text: string; data?: Record<string, unknown> }[] | null = null;
  let fallback: AgentSpecExample | null = null;
  let waits = 0;
  for (let i = recs.length - 1; i >= 0; i--) {
    const r = recs[i];
    const next = nextOf.get(i);
    if (next == null || typeof r.observation !== "string" || typeof r.reply !== "string" || r.error) continue;
    const age = ageOf(r.observation);
    if (age == null || age < caps.adultAge) continue;
    const parsed = parseReply(r.reply);
    if (!parsed.ok) continue;
    const checked = checkActions(parsed.value, cfg.craftMacro, cfg.actionListMax);
    if ("error" in checked || !checked.steps.length) continue;
    evs ??= events.map((l) => parseLine<NonNullable<typeof evs>[number]>(l)).filter((e): e is NonNullable<typeof evs>[number] => !!e && typeof e.t === "number");
    const mine = evs.filter((e) => e.agentId === r.agentId && e.playerId === r.playerId && e.t >= r.t && e.t <= next);
    const results = mine
      .filter((e) => e.kind === "action" && !e.data?.reflex)
      .slice(0, caps.results)
      .map((e) => {
        const at = e.text.indexOf(" -> ");
        return at < 0 ? { action: "", result: cleanText(e.text, caps.result) } : { action: cleanText(e.text.slice(0, at), 120), result: cleanText(e.text.slice(at + 4), caps.result) };
      });
    // a wait leaves no action event; anything else should have one
    if (!results.length && checked.steps.some((a) => a.type !== "wait")) continue;
    const said = mine.find((e) => e.kind === "say");
    const reasoning = cleanBlock(r.reasoning, caps.reasoning);
    const ex: AgentSpecExample = {
      t: r.t,
      agentId: cleanText(r.agentId, 20),
      playerId: typeof r.playerId === "number" ? r.playerId : null,
      lifeIndex: typeof r.lifeIndex === "number" ? r.lifeIndex : null,
      model: cleanText(r.model, 80) || null,
      age,
      observation: cleanBlock(r.observation, caps.observation),
      reasoning: reasoning || null,
      replyText: cleanBlock(r.reply, caps.replyText),
      reply: cleanReply(parsed.value, checked.steps),
      results,
      said: said ? cleanText(said.text, 200) : null,
    };
    // prefer a turn that did something; a pure wait is the fallback
    if (checked.steps.some((a) => a.type !== "wait")) return ex;
    fallback ??= ex;
    if (++waits > 40) break;
  }
  return fallback;
}

// ------------------------------------------------------------------ the response

/** Turns a heard line stays in HEARD (observe.ts shownMs: the turn clock keeps the same number of 8 s turns). */
export function heardTurns(cfg: Config): number {
  const clock = turnClock(cfg);
  const ms = OBSERVATION_LIMITS.heardWindowS * 1000;
  return clock.lockstep ? Math.round(ms / 8000) : Math.round(ms / clock.cycleMs);
}

export function buildAgentSpec(cfg: Config, runDir: string | null, opts: { env?: NodeJS.ProcessEnv; now?: number; runId?: string | null } = {}): AgentSpecResponse {
  const settings = specSettings(cfg, opts.env);
  let example: AgentSpecExample | null = null;
  if (runDir) {
    try {
      example = findExampleTurn(runDir, cfg);
    } catch (e) {
      console.error("agent-spec example failed", e);
    }
  }
  return {
    now: opts.now ?? Date.now(),
    runId: opts.runId ?? null,
    systemPrompt: systemPromptFor(cfg),
    userSuffix: USER_SUFFIX,
    replyFields: replyFields(keptMaxOf(cfg)),
    noteHeadings: [...NOTE_HEADINGS],
    actions: actionCatalogue(cfg),
    validActionTypes: validActionTypes(cfg.craftMacro),
    settings,
    limits: { ...OBSERVATION_LIMITS, keptMax: keptMaxOf(cfg), heardTurns: heardTurns(cfg) },
    sayLimits: sayLimits(),
    interventions: interventions(cfg, settings),
    example,
  };
}

const CACHE_MS = 60_000;
let cache: { key: string; at: number; body: string } | null = null;

/** Handles GET /api/agent-spec; false for any other path. runDir: the current run's log dir. */
export function handleAgentSpecApi(url: URL, res: http.ServerResponse, run: () => { dir: string | null; runId: string | null }, cfg: Config = config): boolean {
  if (url.pathname !== "/api/agent-spec") return false;
  const { dir, runId } = run();
  const key = `${dir}|${runId}`;
  const now = Date.now();
  if (!cache || cache.key !== key || now - cache.at > CACHE_MS) cache = { key, at: now, body: JSON.stringify(buildAgentSpec(cfg, dir, { now, runId })) };
  res.statusCode = 200;
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "public, max-age=60");
  res.end(cache.body);
  return true;
}

/** tests: forget the cached response */
export function clearAgentSpecCache() {
  cache = null;
}
