// Action lists: a reply may carry a few steps ("actions":[...]) that run back
// to back, like a human clicking quickly while thinking. The list stops at the
// first step that didn't do what it was meant to, or as soon as something
// salient happens, and every step's result is reported.

import type { World } from "../game/world.ts";
import type { GameData } from "../game/gameData.ts";
import type { Action } from "./reply.ts";

/**
 * True if a step's result text (from Body / Agent.execute) means it didn't
 * achieve its purpose, so the following steps (which assume it did) must not
 * run. Successful results: "arrived", "use: tile ... -> ...", "ate ...",
 * "picked up ...", "said ...", "waited ...".
 */
export function stepFailed(result: string): boolean {
  return FAIL.some((re) => re.test(result));
}

const FAIL: RegExp[] = [
  /nothing happened/i,
  /couldn'?t/i,
  /\bcan'?t\b/i,
  /no path found/i,
  /movement interrupted/i,
  /stopped walking/i,
  /still on the way/i,
  /not holding anything/i,
  /hands are full/i,
  /^need /i,
  /^unknown action/i,
  /^error/i,
  /isn't nearby|person #\d+ left/i,
  /you're full|you're a baby/i,
  /^no food|nothing at \(/i,
  /no empty spot/i,
  /\bnot found\b/i,
  /changed since you looked|is gone since you looked/i,
  /didn't wait/i,
  /did nothing/i,
  /: not done:/i,
  /wounded you/i,
  /tried to (get|pick)/i,
];

// --- staleness: the world can change while the model thinks (several seconds)

/** What the model saw: objects on tiles near it and where people were. */
export interface Seen {
  t: number;
  tiles: Map<string, number>;
  people: Map<number, [number, number]>;
  /** what we held */
  held: number;
}

const SEEN_RADIUS = 20;

export function seenSnapshot(w: World, now = Date.now()): Seen {
  const tiles = new Map<string, number>();
  const people = new Map<number, [number, number]>();
  const me = w.self;
  if (me) {
    const [px, py] = w.posOf(me);
    for (let dy = -SEEN_RADIUS; dy <= SEEN_RADIUS; dy++)
      for (let dx = -SEEN_RADIUS; dx <= SEEN_RADIUS; dx++) {
        const c = w.cell(px + dx, py + dy);
        if (c) tiles.set(`${px + dx},${py + dy}`, c.obj.id);
      }
    for (const p of w.players.values()) people.set(p.id, w.posOf(p));
  }
  return { t: now, tiles, people, held: me?.held.id ?? 0 };
}

const TILE_ACTIONS = new Set(["use", "swap", "take_out", "forage"]);

/** true if `from` turns into `to` on its own (a chain of up to 4 timed transitions) */
function decaysInto(gd: GameData, from: number, to: number): boolean {
  let cur = from;
  for (let i = 0; i < 4 && cur > 0; i++) {
    const t = gd.transition(-1, cur);
    if (!t) return false;
    cur = t.newTarget;
    if (gd.base(cur) === gd.base(to)) return true;
  }
  return false;
}

/**
 * Compare an action's target with what the model saw. A target tile whose
 * object is now a different thing or gone, changed by someone else, means
 * the model decided on outdated information: the step is not run (skip) and
 * it is told what changed. A thing that merely turned into its own next
 * stage (Smoldering Tinder -> Burning Tinder) is acted on, with a note: a
 * model that knows the timing may be counting on it. Changes our own
 * earlier steps made don't count. A person who moved is only noted.
 */
export function staleness(w: World, gd: GameData, seen: Seen, a: Action, firstStep = true): { skip: boolean; text: string } | null {
  const heldNote = firstStep ? heldChange(w, gd, seen) : "";
  const r = targetStaleness(w, gd, seen, a);
  if (!heldNote) return r;
  return r ? { skip: r.skip, text: heldNote + r.text } : { skip: false, text: heldNote };
}

/** "(your Ember Leaf had become a Leaf) ": what we hold decayed while the model was thinking */
function heldChange(w: World, gd: GameData, seen: Seen): string {
  const now = w.self?.held.id ?? 0;
  if (seen.held <= 0 || now <= 0 || gd.base(now) === gd.base(seen.held) || !decaysInto(gd, seen.held, now)) return "";
  return `(your ${gd.name(seen.held)} had become ${gd.name(now)}) `;
}

function targetStaleness(w: World, gd: GameData, seen: Seen, a: Action): { skip: boolean; text: string } | null {
  if (TILE_ACTIONS.has(a.type) && Number.isFinite(a.x) && Number.isFinite(a.y)) {
    const x = Math.round(a.x!), y = Math.round(a.y!);
    const was = seen.tiles.get(`${x},${y}`);
    if (was === undefined) return null;
    const cell = w.cell(x, y);
    const now = cell?.obj.id ?? 0;
    if (gd.base(was) === gd.base(now) || (cell?.by != null && cell.by === w.selfId)) return null;
    if (!was) return null; // was empty: nothing the model could have meant there changed
    if (now && decaysInto(gd, was, now)) return { skip: false, text: `(the ${gd.name(was)} at (${x},${y}) had become ${gd.name(now)}) ` };
    const text = now
      ? `the ${gd.name(was)} at (${x},${y}) changed since you looked: it is now ${gd.name(now)}; you did nothing`
      : `the ${gd.name(was)} at (${x},${y}) is gone since you looked; you did nothing`;
    return { skip: true, text };
  }
  if ((a.type === "pick_up_baby" || a.type === "feed") && a.person) {
    const was = seen.people.get(a.person);
    const p = w.players.get(a.person);
    if (!was || !p) return null;
    const now = w.posOf(p);
    if (Math.max(Math.abs(now[0] - was[0]), Math.abs(now[1] - was[1])) >= 2) return { skip: false, text: `(#${a.person} had moved from (${was[0]},${was[1]}) to (${now[0]},${now[1]}) since you looked) ` };
  }
  return null;
}

/** "use (3, 4) [step 2/3]" */
export function stepLabel(desc: string, i: number, n: number): string {
  return n > 1 ? `${desc} [step ${i + 1}/${n}]` : desc;
}
