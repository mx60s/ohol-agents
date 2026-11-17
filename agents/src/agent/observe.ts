// Builds the text observation an agent sees each turn. Only uses what the
// character's own client received (its World), so no global knowledge.
//
// Order: what changes rarely first (identity, home), what changes every turn
// last, so consecutive prompts share a long prefix. Durations are in turns.

import type { World, Player, Since } from "../game/world.ts";
import type { GameData } from "../game/gameData.ts";
import { DEFAULT_FOOD_BONUS_S, drainSecondsPerPip, newbornWindowSeconds } from "./prompt.ts";
import { sayLimit } from "../game/body.ts";
import { takenList } from "./naming.ts";
import { turnsAgo, turnsForWall, turnsText, turnsTextWall, type TurnClock } from "./turns.ts";

export const BIOMES: Record<number, string> = {
  0: "grassland", 1: "swamp", 2: "yellow prairie", 3: "badlands", 4: "snowy tundra", 5: "desert", 6: "jungle",
};

const VIEW_RADIUS = 12;
const RESOURCE_RADIUS = 20;
const MAX_KINDS = 20;
const MAX_HINTS = 8;
/** lines from the held object's hint list (the client's hint pane) */
const HELD_HINTS = 4;
/** lines on what goes on the thing our last use just made */
const MADE_HINTS = 3;
/** recent action results shown (an actions list adds one line per step) */
const HISTORY_SHOWN = 8;
const FERTILE_MIN = 14, FERTILE_MAX = 40;
/** timers are shown for things that change on their own within this many game seconds */
const TIMER_MAX_S = 300;

export interface FoodSource {
  x: number;
  y: number;
  d: number;
  id: number;
  gives: number;
}

export interface ObservationOptions {
  recipeHints: boolean;
  /** recent action results, newest last */
  history: { t: number; action: string; result: string }[];
  notebook: string[];
  pastLifeNotes: string[];
  goal: string | null;
  /** the thought from the previous reply (plan continuity) */
  lastThought?: string | null;
  foodSources?: FoodSource[];
  /** converts durations to turns; default 8 s per turn, no time dilation */
  clock?: TurnClock;
  now?: number;
  /** family surnames used before, most recent first; shown to an unnamed Eve (naming.ts) */
  takenSurnames?: string[];
  /** game seconds the server adds to every food pip (FOOD_BONUS_S); default DEFAULT_FOOD_BONUS_S */
  foodBonusS?: number;
  /**
   * Was this heard line scrambled by the server's family languages? true/false
   * when known (Population compares it with what the speaker said), null when
   * unknown. See speechLooksScrambled.
   */
  speechScrambled?: (speakerId: number, text: string) => boolean | null;
  /** label of the flower a player wears in their hair ("blue daisy"), if known (per-person flowers, see README) */
  flowerOf?: (playerId: number) => string | null;
}

const DEFAULT_CLOCK: TurnClock = { cycleMs: 8000, timeScale: 1 };
/**
 * How long deaths and heard lines stay in the observation: 300 s / 90 s of
 * wall time, or with the turn clock (where wall time includes everyone's
 * thinking) the same number of 8 s turns: 37 and 12 turns.
 */
const DEATHS_SHOWN_MS = 300_000;
const HEARD_SHOWN_MS = 90_000;
const shownMs = (wallMs: number, clock: TurnClock) => (clock.lockstep ? Math.round(wallMs / DEFAULT_CLOCK.cycleMs) * clock.cycleMs : wallMs);

export function playerLabel(w: World, gd: GameData, p: Player, flower?: string | null): string {
  const age = w.currentAge(p);
  const sex = p.female == null ? "person" : age < 3 ? (p.female ? "baby girl" : "baby boy") : p.female ? "woman" : "man";
  // no name: say so inside the parentheses; a bare "unnamed" in name position got copied as a name ("I AM UNNAMED THORN")
  const name = p.name ? `${p.name} ` : "";
  return `#${p.id} ${name}(${p.name ? "" : "no name, "}${sex}, ${age.toFixed(age < 3 ? 1 : 0)}${flower ? `, ${flower}` : ""})`;
}

/** "a red rose", "an orange tulip" */
export function withArticle(s: string): string {
  return `${/^[aeiou]/i.test(s) ? "an" : "a"} ${s}`;
}

function relation(w: World, p: Player): string | null {
  return relationTo(w, p.id, p.ancestors, p.eveId);
}

function relationTo(w: World, id: number, ancestors: number[], eveId: number | null): string | null {
  const p = { id, ancestors, eveId };
  const me = w.self;
  if (!me) return null;
  if (me.ancestors[0] === p.id) return "your mother";
  if (p.ancestors[0] === me.id) return "your child";
  if (me.ancestors[1] && me.ancestors[1] === p.id) return "your grandmother";
  if (p.ancestors[1] === me.id) return "your grandchild";
  if (me.ancestors[0] && p.ancestors[0] === me.ancestors[0]) return "your sibling";
  if (me.eveId && p.eveId === me.eveId) return "same family";
  if (p.eveId && me.eveId && p.eveId !== me.eveId) return "other family";
  return null;
}

/** "12 tiles NE", "here" */
export function direction(from: [number, number], to: [number, number]): string {
  const dx = to[0] - from[0], dy = to[1] - from[1];
  const d = Math.max(Math.abs(dx), Math.abs(dy));
  if (d === 0) return "here";
  const ns = Math.abs(dy) * 2 >= Math.abs(dx) ? (dy > 0 ? "N" : dy < 0 ? "S" : "") : "";
  const ew = Math.abs(dx) * 2 >= Math.abs(dy) ? (dx > 0 ? "E" : dx < 0 ? "W" : "") : "";
  return `${d} tile${d === 1 ? "" : "s"} ${ns}${ew}`;
}

/**
 * Wall seconds per pip at the ideal heat 0.5, derived from the server's own
 * drain time: the server's figure includes the per-life bonus (and any indoor
 * bonus), and only the heat term changes with heat, so swap that term.
 */
export function idealDrainWallSeconds(w: World, clock: TurnClock): number {
  return w.foodTime + (drainSecondsPerPip(0.5) - drainSecondsPerPip(w.heat)) * clock.timeScale;
}

/** Server minActivePlayersForLanguages: below this many players nobody's speech is scrambled. */
export const LANGUAGES_MIN_PLAYERS = 15;

/**
 * Should a line from another family carry the "their language differs" tag?
 * The server maps speech between families into made-up words only while
 * LANGUAGES_MIN_PLAYERS or more players are on (server.cpp, before
 * mapLanguagePhrase). Trust `known` (did the words differ from what the
 * speaker said) when it has an answer; else only tag at that population, as
 * far as this client can see.
 */
export function speechLooksScrambled(w: World, speakerId: number, text: string, known?: (speakerId: number, text: string) => boolean | null): boolean {
  const k = known?.(speakerId, text);
  if (k != null) return k;
  return w.players.size >= LANGUAGES_MIN_PLAYERS;
}

/** True if a fertile woman is carrying p (then p's food doesn't drain). */
function nursedBy(w: World, p: Player): Player | null {
  const c = w.carrierOf(p);
  if (!c || !c.female) return null;
  const a = w.currentAge(c);
  return a >= FERTILE_MIN && a <= FERTILE_MAX ? c : null;
}

/** The food line: "Food: 9/20, hungry. 1 pip per ~1 turn (cold); lasts about 9 turns." */
export function foodLine(w: World, clock: TurnClock): string {
  const me = w.self!;
  const baby = w.currentAge(me) < 3;
  const label = w.food <= (baby ? 2 : 3) ? (baby ? ", STARVING - say F so a woman picks you up" : ", STARVING - EAT NOW") : w.food <= w.foodCapacity * 0.4 ? ", hungry" : "";
  const nurse = nursedBy(w, me);
  if (nurse && w.currentAge(me) < 3) return `Food: ${w.food}/${w.foodCapacity}${label}. You are being nursed by #${nurse.id}: your food doesn't drain while she holds you.`;
  // right after birth the server hasn't sent our drain time yet; don't guess optimistically
  if (!(w.foodTime > 0)) return `Food: ${w.food}/${w.foodCapacity}${label}. Drain rate not known yet.`;
  // all wall seconds: the server already applied TIME_SCALE (don't scale again)
  const per = w.foodTime;
  const perTurns = turnsForWall(per, clock);
  const rate = perTurns >= 1.5 ? `1 pip every ${turnsTextWall(per, clock).replace("about ", "~")}` : `${Math.max(1, Math.round(1 / perTurns))} pip${Math.round(1 / perTurns) > 1 ? "s" : ""} per turn`;
  const ideal = turnsTextWall(idealDrainWallSeconds(w, clock), clock).replace("about ", "~");
  const why = w.heat < 0.35 ? ` because you are cold (warm it would be 1 per ${ideal})` : w.heat > 0.65 ? ` because you are too hot (1 per ${ideal} at heat 0.5)` : "";
  return `Food: ${w.food}/${w.foodCapacity}${label}. Drains ${rate}${why}; it runs out in ${turnsTextWall(per * w.food, clock)}.`;
}

export function buildObservation(w: World, gd: GameData, o: ObservationOptions): string {
  const me = w.self;
  if (!me) return "You have no body yet.";
  const clock = o.clock ?? DEFAULT_CLOCK;
  const now = o.now ?? Date.now();
  const age = w.currentAge(me);
  const L: string[] = [];
  const pos = w.posOf(me);
  const here = w.cell(pos[0], pos[1]);
  const isEve = me.ancestors.length === 0;

  // --- identity and home: stable for a whole life
  L.push(`== YOU ==`);
  L.push(`${playerLabel(w, gd, me)}, ${isEve ? "an Eve (first of a family)" : `generation ${me.ancestors.length + 1}`}.`);
  const myFlower = o.flowerOf?.(me.id);
  if (myFlower) L.push(`You wear ${withArticle(myFlower)} in your hair.`);
  if (me.name) L.push(`Your name is ${me.name}.`);
  if (!me.name) L.push(isEve ? `No name yet: found your family by saying "I AM <FIRST NAME> <FAMILY NAME>" (once only).${o.takenSurnames?.length ? ` Family names already taken (pick a new one): ${takenList(o.takenSurnames)}.` : ""}` : `No name yet; usually your mother names you.`);
  if (o.goal) L.push(`Your goal: ${o.goal}`);
  L.push(homeLine(w, pos, isEve));

  // --- body state
  if (age < 3) L.push(`You are a baby: you can't feed yourself or walk far, and can barely talk. A woman must carry you.`);
  const carrier = w.carrierOf(me);
  L.push(`Age ${age.toFixed(1)} of at most 60. At (${pos[0]}, ${pos[1]})${carrier ? `, carried by #${carrier.id}` : ""}, ${here ? BIOMES[here.biome] ?? `biome ${here.biome}` : "unknown biome"}${here && here.floor ? `, on ${gd.name(here.floor)}` : ""}.`);
  L.push(foodLine(w, clock));
  L.push(`Heat ${w.heat.toFixed(2)} (0.5 ideal; ${w.heat < 0.35 ? "too cold" : w.heat > 0.65 ? "too hot" : "ok"}).`);
  const worn = me.clothing.map((c, i) => (c.id ? `${["hat", "tunic", "front shoe", "back shoe", "bottom", "backpack"][i]}: ${gd.describeStack(c)}` : null)).filter(Boolean);
  const cond = conditionLine(w, gd, me, clock);
  if (cond) L.push(cond);
  const heldTimer = me.held.id > 0 && w.heldSince && !gd.condition(me.held.id) ? decayTimer(gd, me.held.id, w.heldSince, now, clock) : null;
  L.push(`Holding: ${heldText(w, gd, me)}${heldTimer ? ` (${heldTimer})` : ""}. Wearing: ${worn.length ? worn.join(", ") : "nothing"}.`);
  // your own baby in your arms without a name: ask for it (the user's rule: mothers name their babies)
  const heldBaby = me.held.id < 0 ? w.players.get(-me.held.id) : undefined;
  if (heldBaby && !heldBaby.name && !w.names.get(heldBaby.id) && heldBaby.ancestors[0] === me.id)
    L.push(`Your baby #${heldBaby.id} has no name yet: name her or him now by saying "YOU ARE <FIRST NAME>".`);
  // the official client's speech box stops accepting letters at this length (getSayLimit)
  if (age < 20) L.push(`Speech: at your age you can say at most ${sayLimit(age)} letters.`);
  if (w.craving) L.push(`Craving: ${gd.name(w.craving)} (bonus food if eaten).`);
  const under = w.objAt(pos[0], pos[1]);
  if (under.id) L.push(`Under you: ${gd.describeStack(under)}.`);

  // --- resources: water, warmth, food
  L.push(...resourceLines(w, gd, pos, o.foodSources ?? [], now, clock));
  const danger = dangerLine(w, gd, pos);
  if (danger) L.push(danger);

  // --- people
  const people = [...w.players.values()].filter((p) => p.id !== me.id && dist(pos, w.posOf(p, now)) <= VIEW_RADIUS + 4);
  people.sort((a, b) => dist(pos, w.posOf(a, now)) - dist(pos, w.posOf(b, now)));
  L.push(``);
  L.push(`== PEOPLE ==`);
  if (!people.length) L.push(`Nobody in sight.`);
  for (const p of people.slice(0, 10)) {
    const rel = relation(w, p);
    const held = p.held.id && !gd.condition(p.held.id) ? `, holding ${heldText(w, gd, p)}` : "";
    const by = w.carrierOf(p);
    const pp = w.posOf(p, now);
    L.push(`- ${playerLabel(w, gd, p, o.flowerOf?.(p.id))}${rel ? ` [${rel}]` : ""} at (${pp[0]}, ${pp[1]}), ${dist(pos, pp)} away${held}${by ? `, carried by #${by.id}` : w.isWalking(p, now) ? `, walking to (${p.x}, ${p.y})` : ""}${othersCondition(gd, p)}`);
  }
  if (people.length > 10) L.push(`- ...and ${people.length - 10} more`);
  const myBabies = [...w.players.values()].filter((p) => p.ancestors[0] === me.id && w.currentAge(p) < 3);
  if (myBabies.length && me.female) {
    const parts = myBabies.map((b) => {
      const c = w.carrierOf(b);
      return `#${b.id} ${c ? (c.id === me.id ? "in your arms" : `held by #${c.id}`) : `on the ground at (${w.posOf(b)[0]}, ${w.posOf(b)[1]})`}`;
    });
    L.push(`Your babies: ${parts.join("; ")}. Unheld, a newborn dies within ~${turnsText(newbornWindowSeconds(o.foodBonusS ?? DEFAULT_FOOD_BONUS_S), clock).replace("about ", "")}; a fed baby lasts a bit longer.`);
  }

  // --- deaths we witnessed
  const deaths = w.deaths.filter((d) => now - d.t < shownMs(DEATHS_SHOWN_MS, clock));
  if (deaths.length) {
    L.push(``);
    L.push(`== DEATHS YOU SAW ==`);
    for (const d of deaths.slice(-5)) {
      const rel = relationTo(w, d.id, d.ancestors, d.eveId);
      L.push(`- ${turnsAgo(d.t, now, clock)}: ${d.name ?? `#${d.id} (no name)`}${rel ? ` [${rel}]` : ""}, age ${d.age.toFixed(d.age < 3 ? 1 : 0)}, at (${d.x}, ${d.y})`);
    }
  }

  // --- speech
  const heard = w.heard.filter((h) => now - h.t < shownMs(HEARD_SHOWN_MS, clock)).slice(-10);
  L.push(``);
  L.push(`== HEARD ==`);
  if (!heard.length) L.push(`Nothing.`);
  for (const h of heard) {
    if (h.notice) {
      L.push(`- ${turnsAgo(h.t, now, clock)}, notice from the game: "${h.text}"`);
      continue;
    }
    const who = h.speakerId == null ? `written words at (${h.x}, ${h.y})` : h.speakerId === me.id ? "you" : (() => {
      const p = w.players.get(h.speakerId!);
      const other = p && relation(w, p) === "other family" && speechLooksScrambled(w, h.speakerId!, h.text, o.speechScrambled) ? " [other family: their language differs from yours]" : "";
      return p ? `${playerLabel(w, gd, p)}${other}` : `#${h.speakerId}`;
    })();
    L.push(`- ${turnsAgo(h.t, now, clock)}, ${who}: "${h.text}"`);
  }

  // --- things
  L.push(``);
  L.push(`== THINGS (within ${VIEW_RADIUS}, nearest first) ==`);
  const groups = new Map<string, { d: number; pos: [number, number][] }>();
  for (let dy = -VIEW_RADIUS; dy <= VIEW_RADIUS; dy++)
    for (let dx = -VIEW_RADIUS; dx <= VIEW_RADIUS; dx++) {
      const c = w.cell(pos[0] + dx, pos[1] + dy);
      if (!c || !c.obj.id) continue;
      const name = gd.describeStack(c.obj);
      const d = Math.max(Math.abs(dx), Math.abs(dy));
      const g = groups.get(name) ?? { d, pos: [] };
      g.d = Math.min(g.d, d);
      g.pos.push([pos[0] + dx, pos[1] + dy]);
      groups.set(name, g);
    }
  const sorted = [...groups].sort((a, b) => a[1].d - b[1].d);
  for (const [name, g] of sorted.slice(0, MAX_KINDS)) {
    g.pos.sort((a, b) => dist(pos, a) - dist(pos, b));
    const shown = g.pos.slice(0, 2).map((p) => `(${p[0]}, ${p[1]})`).join(" ");
    const timer = cellTimer(w, gd, g.pos[0], now, clock);
    L.push(`- ${name}${g.pos.length > 1 ? ` x${g.pos.length}` : ""}: ${shown}${timer ? ` (${g.pos.length > 1 ? "nearest " : ""}${timer})` : ""}`);
  }
  if (sorted.length > MAX_KINDS) L.push(`- ...and ${sorted.length - MAX_KINDS} more kinds`);

  if (o.recipeHints) {
    const hints = recipeHints(w, gd, sorted.map(([, g]) => g.pos[0]), now, clock);
    if (hints.length) {
      L.push(``);
      L.push(`== YOU COULD (with what you hold) ==`);
      L.push(...hints);
    }
  }

  if (o.history.length || o.lastThought) {
    L.push(``);
    L.push(`== YOUR LAST ACTIONS ==`);
    if (o.lastThought) L.push(`Your previous thought: "${o.lastThought.slice(0, 200)}"`);
    for (const h of o.history.slice(-HISTORY_SHOWN)) L.push(`- ${turnsAgo(h.t, now, clock)}: ${h.action} -> ${h.result}`);
  }

  if (o.pastLifeNotes.length) {
    L.push(``);
    L.push(`== NOTES FROM YOUR PAST LIVES ==`);
    L.push(...o.pastLifeNotes.slice(-15).map((n) => `- ${n}`));
  }
  if (o.notebook.length) {
    L.push(``);
    L.push(`== YOUR NOTEBOOK (this life) ==`);
    L.push(...o.notebook.slice(-12).map((n) => `- ${n}`));
  }
  return L.join("\n");
}

/**
 * Home as the real client shows it (Home Marker arrow + distance); without a
 * marker, the birth spot (marginally beyond the client UI, see README).
 */
function homeLine(w: World, pos: [number, number], isEve: boolean): string {
  if (w.home) return `Home (your family's Home Marker): (${w.home.x}, ${w.home.y}), ${direction(pos, [w.home.x, w.home.y])}.`;
  if (w.birthPos) return `No Home Marker known. You ${isEve ? "appeared" : "were born"} at (${w.birthPos[0]}, ${w.birthPos[1]}), ${direction(pos, w.birthPos)}.`;
  return `No Home Marker known.`;
}

/** Nearest water and heat, and how much hand-pickable food is left nearby. */
function resourceLines(w: World, gd: GameData, pos: [number, number], food: FoodSource[], now: number, clock: TurnClock): string[] {
  let water: { id: number; p: [number, number]; d: number } | null = null;
  let heat: { id: number; p: [number, number]; d: number } | null = null;
  for (let dy = -RESOURCE_RADIUS; dy <= RESOURCE_RADIUS; dy++)
    for (let dx = -RESOURCE_RADIUS; dx <= RESOURCE_RADIUS; dx++) {
      const id = w.objAt(pos[0] + dx, pos[1] + dy).id;
      if (!id) continue;
      const d = Math.max(Math.abs(dx), Math.abs(dy));
      const p: [number, number] = [pos[0] + dx, pos[1] + dy];
      if ((!water || d < water.d) && gd.isWaterSource(id)) water = { id, p, d };
      if ((!heat || d < heat.d) && gd.heatOf(id) > 0 && !gd.isPerson(id)) heat = { id, p, d };
    }
  const out: string[] = [];
  const at = (r: { id: number; p: [number, number] }) => `${gd.name(r.id)} at (${r.p[0]}, ${r.p[1]}), ${direction(pos, r.p)}`;
  const heatTimer = heat ? cellTimer(w, gd, heat.p, now, clock) : null;
  out.push(`Water: ${water ? at(water) : `none within ${RESOURCE_RADIUS} tiles`}. Fire/heat: ${heat ? `${at(heat)}${heatTimer ? ` (${heatTimer})` : ""}` : `none within ${RESOURCE_RADIUS} tiles`}.`);
  if (!food.length) out.push(`Food by hand: none within ${RESOURCE_RADIUS} tiles.`);
  else {
    const totals = new Map<number, { n: number; src: number }>();
    for (const f of food) {
      const t = totals.get(f.gives) ?? { n: 0, src: 0 };
      t.n += f.id === f.gives ? 1 : gd.usesLeft(f.id);
      t.src++;
      totals.set(f.gives, t);
    }
    const sum = [...totals].sort((a, b) => b[1].n - a[1].n).slice(0, 4).map(([id, t]) => `${t.n} ${gd.name(id)}${t.src > 1 ? ` (${t.src} spots)` : ""}`);
    const near = food.slice(0, 3).map((f) => `${gd.name(f.id)} (${f.x}, ${f.y}) ${f.d} away`);
    out.push(`Food by hand within ${RESOURCE_RADIUS}: ${sum.join(", ")}. Nearest: ${near.join("; ")}.`);
  }
  return out;
}

/**
 * "becomes Hot Coals in about 7 turns" / "gone within 15 turns" for something
 * that changes on its own within TIMER_MAX_S game seconds (fire, coals,
 * tinder, a firing kiln, hot iron, a ripe carrot row, a leaf). A human sees
 * the fire shrink; this is the same information as text. Decay times are game
 * seconds from the game data; `since` is when this client saw the object
 * appear (wall ms), so the elapsed game time is its age / timeScale. "within"
 * when the object was already there when first seen (its true age unknown).
 * Moving animals and things that only cycle into themselves get no timer.
 */
export function decayTimer(gd: GameData, id: number, since: Since, now: number, clock: TurnClock): string | null {
  const t = id > 0 ? gd.transition(-1, id) : undefined;
  if (!t || !(t.autoDecaySeconds > 0 && t.autoDecaySeconds <= TIMER_MAX_S) || t.move !== 0) return null;
  if (t.newTarget > 0 && gd.name(t.newTarget) === gd.name(id)) return null;
  const left = Math.max(0, t.autoDecaySeconds - Math.max(0, now - since.t) / 1000 / clock.timeScale);
  const when = since.exact ? `in ${turnsText(left, clock)}` : `within ${turnsText(t.autoDecaySeconds, clock).replace("about ", "")}`;
  return t.newTarget > 0 ? `becomes ${gd.name(t.newTarget)} ${when}` : `gone ${when}`;
}

function cellTimer(w: World, gd: GameData, p: [number, number], now: number, clock: TurnClock): string | null {
  const since = w.sinceAt(p[0], p[1]);
  return since ? decayTimer(gd, w.objAt(p[0], p[1]).id, since, now, clock) : null;
}

/**
 * Dangerous animals in view (wolf, boar, bear, snake: GameData.dangerRadius),
 * nearest first. A human sees them on screen.
 */
export function dangerLine(w: World, gd: GameData, pos: [number, number]): string | null {
  const found: { id: number; p: [number, number]; d: number }[] = [];
  for (let dy = -VIEW_RADIUS; dy <= VIEW_RADIUS; dy++)
    for (let dx = -VIEW_RADIUS; dx <= VIEW_RADIUS; dx++) {
      const id = w.objAt(pos[0] + dx, pos[1] + dy).id;
      if (id > 0 && gd.dangerRadius(id) > 0) found.push({ id, p: [pos[0] + dx, pos[1] + dy], d: Math.max(Math.abs(dx), Math.abs(dy)) });
    }
  if (!found.length) return null;
  found.sort((a, b) => a.d - b.d);
  const list = found.slice(0, 4).map((f) => `${gd.name(f.id)} at (${f.p[0]}, ${f.p[1]}), ${direction(pos, f.p)}`);
  return `DANGER: ${list.join("; ")}${found.length > 4 ? ` (and ${found.length - 4} more)` : ""} (they move up to 4 tiles at a jump; a bite wounds).`;
}

function heldText(w: World, gd: GameData, p: Player): string {
  if (p.held.id < 0) {
    const b = w.players.get(-p.held.id);
    return b ? `baby ${playerLabel(w, gd, b)}` : `baby #${-p.held.id}`;
  }
  const c = gd.condition(p.held.id);
  if (c) return `nothing (hands taken by ${c.kind === "mark" ? "the" : "a"} ${c.kind === "mark" ? "" : `${c.kind}: `}${gd.name(p.held.id)})`;
  return gd.describeStack(p.held);
}

/** Server: deathStaggerTime (20 game s) from a wound to death unless healed. */
const WOUND_DEATH_SECONDS = 20;

/**
 * Your own wound, sickness or dying state, as the client shows it on your
 * body (the wound sprite in your hands, blood, the sick face).
 */
export function conditionLine(w: World, gd: GameData, me: Player, clock: TurnClock): string | null {
  const c = gd.condition(me.held.id);
  const name = gd.name(me.held.id);
  const from = c?.from.length ? ` from a ${c.from[0]}` : "";
  if (c?.kind === "sickness") return `You are SICK: ${name}. It passes with time if you survive; until then it fills your hands (it can't be dropped).`;
  if (c?.kind === "wound") {
    const h = gd.healers(me.held.id);
    const heal = h.length ? ` heals you (only ${h.slice(0, 3).map((n) => `a ${n}`).join(" or ")} used on you treats a ${name})` : " heals you";
    const dying = me.dying ? ` You are bleeding: you die within ~${turnsText(WOUND_DEATH_SECONDS, clock).replace("about ", "")} unless someone${heal}.` : "";
    return `You are WOUNDED: ${name}${from}. A wound fills your hands; it can't be dropped or eaten.${dying}`;
  }
  if (me.dying) return `You are DYING unless someone heals you (within ~${turnsText(WOUND_DEATH_SECONDS, clock).replace("about ", "")}).`;
  return null;
}

/** "WOUNDED (Hog Cut)", "SICK (Yellow Fever)", "DYING" for someone else, or "" */
function othersCondition(gd: GameData, p: Player): string {
  const c = gd.condition(p.held.id);
  if (c?.kind === "wound") {
    const h = gd.healers(p.held.id);
    return `, WOUNDED (${gd.name(p.held.id)}${h.length ? `; treated only by ${h.slice(0, 3).map((n) => `a ${n}`).join(" or ")}` : ""})${p.dying ? ", bleeding" : ""}`;
  }
  if (c?.kind === "sickness") return `, SICK (${gd.name(p.held.id)})`;
  return p.dying ? ", DYING" : "";
}

function dist(a: [number, number], b: [number, number]) {
  return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));
}

/** what a use does, from the hand's point of view: "get Ember Leaf, it becomes Long Straight Shaft" */
function useResult(gd: GameData, t: { newActor: number; newTarget: number }, held: number, target: number): string {
  const results: string[] = [];
  if (t.newActor !== held) results.push(t.newActor ? `get ${gd.name(t.newActor)}` : held ? `uses up ${gd.name(held)}` : "");
  // "it becomes Maple Tree" (same name, branch gone) says nothing; skip it
  if (t.newTarget !== target && gd.name(t.newTarget) !== gd.name(target)) results.push(t.newTarget ? `it becomes ${gd.name(t.newTarget)}` : "it's gone");
  return results.filter(Boolean).join(", ") || "something happens";
}

/**
 * Transitions available right now with the held item / bare hands on nearby
 * things, then what the client's hint pane shows a human (gd.hints): the
 * held object's other uses, whatever is in view, and the uses of a thing
 * our own last use just turned into something else (the client switches its
 * hint to that thing: after the drill makes an Ember Shaft it shows what
 * goes on the Ember Shaft).
 */
function recipeHints(w: World, gd: GameData, positions: [number, number][], now: number, clock: TurnClock): string[] {
  const me = w.self!;
  if (gd.condition(me.held.id)) return []; // a wound or sickness fills the hands: nothing to use
  const held = me.held.id > 0 ? me.held.id : 0;
  const out: string[] = [];
  const seen = new Set<string>();
  const inView = new Set<number>();
  if (held && gd.isFood(held)) out.push(`- eat the ${gd.name(held)} ("eat")`);
  if (held && gd.get(held)?.clothing && gd.get(held)!.clothing !== "n") out.push(`- wear the ${gd.name(held)} ("eat")`);
  for (const pos of positions) {
    const target = w.objAt(pos[0], pos[1]).id;
    if (!target) continue;
    inView.add(target);
    if (out.length >= MAX_HINTS) continue;
    const t = gd.transition(held, target);
    if (!t) continue;
    const key = `${held},${target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(`- ${held ? "use on" : "bare hands on"} ${gd.name(target)} (${pos[0]}, ${pos[1]}): ${useResult(gd, t, held, target)}`);
  }

  // the thing our last use just made, next to us (the client's hint follows it)
  const pos = w.posOf(me, now);
  let made: { x: number; y: number; id: number; prev: number; t: number } | null = null;
  for (let dy = -2; dy <= 2; dy++)
    for (let dx = -2; dx <= 2; dx++) {
      const c = w.cell(pos[0] + dx, pos[1] + dy);
      if (!c || c.by !== me.id || !c.sinceExact || c.since == null || !(c.prev && c.prev > 0) || c.prev === c.obj.id || !(c.obj.id > 0)) continue;
      if (now - c.since > clock.cycleMs * 1.5 || (made && made.t >= c.since)) continue;
      made = { x: pos[0] + dx, y: pos[1] + dy, id: c.obj.id, prev: c.prev, t: c.since };
    }
  // as in the client, a use that also changed what we hold points the hint at the new held thing
  // instead: show this only if what we hold now made it and stayed (or the hand is empty)
  const sameHand = (m: { prev: number; id: number }) => {
    const t = held ? gd.transition(held, m.prev) : null;
    return !held || (!!t && t.newActor === held && t.newTarget === m.id);
  };
  if (made && made.id !== held && sameHand(made)) {
    const uses = gd.hints(made.id).filter((t) => t.target === made!.id && !(t.actor === held && seen.has(`${held},${made!.id}`)));
    for (const t of uses.slice(0, MADE_HINTS))
      out.push(`- on the ${gd.name(made.id)} you just made (${made.x}, ${made.y}): ${t.actor ? `a ${gd.name(t.actor)}` : "bare hands"} -> ${useResult(gd, t, t.actor, made.id)}`);
  }

  // the held object's hint list, minus what is shown above
  if (held) {
    let n = 0;
    for (const t of gd.hints(held)) {
      if (n >= HELD_HINTS) break;
      if (t.actor === held) {
        if (t.target > 0 && inView.has(t.target)) continue; // in view: shown above with its place, or not usable from here
        const where = t.target === -1 ? "on empty ground" : `on a ${gd.name(t.target)} (none in view)`;
        out.push(`- use it ${where}: ${useResult(gd, t, held, t.target)}`);
      } else {
        out.push(`- ${t.actor ? `a ${gd.name(t.actor)} used` : "bare hands"} on it, once it is on the ground: ${useResult(gd, t, t.actor, held)}`);
      }
      n++;
    }
  }
  return out;
}
