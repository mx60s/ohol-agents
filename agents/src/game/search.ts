// The game client's hint search: typing "/fire" in the chat box filters the
// hint panel to "MAKING: FIRE", every step from things found in the wild to
// the goal. Mirrors LivingLifePage.cpp getNumHints ("new logic: show all
// trans leading to this target object") and objectBank.cpp
// findObjectsMatchingWords.

import { cleanName, type GameData, type Transition } from "./gameData.ts";

/** The client searches only when 1-9 objects match (LivingLifePage: hitIDs.size() < 10). */
export const MAX_HITS = 9;
/** names listed when too many things match */
const TOO_MANY_SHOWN = 12;

export type SearchResult =
  | { kind: "steps"; query: string; goals: number[]; steps: string[] }
  /** every match has infinite depth: no chain of transitions from natural things makes it */
  | { kind: "unmakeable"; query: string; names: string[] }
  /** 2-9 objects with different names match */
  | { kind: "several"; query: string; names: string[] }
  | { kind: "tooMany"; query: string; count: number; names: string[] }
  | { kind: "none"; query: string };

/**
 * Objects matching the words, as findObjectsMatchingWords: the words
 * (case-insensitive) as whole words in the description without its
 * "#comment"; of those, only the shallowest (lowest depth); an exact
 * full-name match (again the shallowest) replaces them. Use and variable
 * dummies are not searchable (the client creates them unsearchable).
 */
export function matchObjects(gd: GameData, words: string): number[] {
  const w = words.trim().replace(/\s+/g, " ").toUpperCase();
  if (!w) return [];
  const hits: number[] = [];
  const exact: number[] = [];
  for (const o of gd.objects.values()) {
    if (o.parent) continue;
    const des = o.name.split("#")[0].toUpperCase();
    if (des.trim() === w) exact.push(o.id);
    // the client checks the first occurrence only (strstr)
    const at = des.indexOf(w);
    if (at < 0) continue;
    const front = at === 0 || des[at - 1] === " ";
    const back = at + w.length === des.length || des[at + w.length] === " ";
    if (front && back) hits.push(o.id);
  }
  const shallowest = (ids: number[]) => {
    const d = Math.min(...ids.map((id) => gd.depth(id)));
    return ids.filter((id) => gd.depth(id) === d);
  };
  return exact.length ? shallowest(exact) : hits.length ? shallowest(hits) : [];
}

/**
 * Walk back from the goals: for each object on the frontier, the producing
 * transition with the lowest max(actor depth, target depth) whose
 * ingredients are both shallower than it (time or bare hands count as 0),
 * skipping last-use and dummy variants; its actor and target join the next
 * frontier. Returns the chosen transitions with the object each one makes,
 * in walk order (goal first).
 */
export function walkBack(gd: GameData, goals: number[]): { t: Transition; makes: number }[] {
  const produces = producesMap(gd);
  const chosen: { t: Transition; makes: number }[] = [];
  const used = new Set<Transition>();
  const seen = new Set<number>();
  let frontier = [...goals];
  while (frontier.length) {
    const next: number[] = [];
    for (const o of frontier) {
      const oD = gd.depth(o);
      let best: Transition | null = null;
      let bestD = Infinity;
      for (const t of produces.get(o) ?? []) {
        const aD = t.actor > 0 ? gd.depth(t.actor) : 0;
        const tD = t.target > 0 ? gd.depth(t.target) : 0;
        if (!(t.actor >= -1 && (t.actor <= 0 || aD < oD) && t.target !== 0 && tD < oD) || used.has(t)) continue;
        if (t.lastUseActor || t.lastUseTarget) continue;
        if (isDummy(gd, t.actor) || isDummy(gd, t.target)) continue;
        const d = Math.max(aD, tD);
        if (d < bestD) (bestD = d), (best = t);
      }
      if (!best) continue;
      for (const id of [best.actor, best.target]) if (id > 0 && !seen.has(id)) (seen.add(id), next.push(id));
      used.add(best);
      chosen.push({ t: best, makes: o });
    }
    frontier = next;
  }
  return chosen;
}

/**
 * The walk's steps from raw materials up to the goal: a step comes after
 * every step that makes one of its ingredients; otherwise shallower
 * products first, then the walk order reversed.
 */
export function firstStepFirst<T extends { t: Transition; makes: number }>(gd: GameData, chosen: T[]): T[] {
  const rest = chosen.map((c, i) => ({ c, i })).sort((a, b) => gd.depth(a.c.makes) - gd.depth(b.c.makes) || b.i - a.i);
  const makes = (x: Transition, id: number) => id > 0 && ((x.newActor === id && x.actor !== id) || (x.newTarget === id && x.target !== id));
  const out: T[] = [];
  while (rest.length) {
    const k = rest.findIndex(({ c }) => !rest.some((o) => o.c !== c && (makes(o.c.t, c.t.actor) || makes(o.c.t, c.t.target))));
    out.push(rest.splice(Math.max(k, 0), 1)[0].c);
  }
  return out;
}

/** Run a search: the matches, then the steps when the client would show them. */
export function search(gd: GameData, words: string): SearchResult {
  const query = words.trim().replace(/\s+/g, " ");
  const hits = matchObjects(gd, query);
  const names = [...new Set(hits.map((id) => displayName(gd, id)))];
  if (!hits.length) return { kind: "none", query };
  if (hits.length > MAX_HITS) return { kind: "tooMany", query, count: hits.length, names: names.slice(0, TOO_MANY_SHOWN) };
  const exact = hits.every((id) => cleanName(gd.get(id)!.name).toUpperCase() === query.toUpperCase());
  if (names.length > 1 && !exact) return { kind: "several", query, names };
  if (hits.every((id) => !Number.isFinite(gd.depth(id)))) return { kind: "unmakeable", query, names };
  const chosen = walkBack(gd, hits);
  const steps = [...new Set(firstStepFirst(gd, chosen).map((c) => stepLine(gd, c.t)))];
  return { kind: "steps", query, goals: hits, steps };
}

/** One line: what the history (YOUR LAST ACTIONS) says. */
export function searchSummary(gd: GameData, r: SearchResult): string {
  const q = r.query;
  switch (r.kind) {
    case "none":
      return `nothing is called "${q}"`;
    case "tooMany":
      return `too many things match "${q}" (${r.count}); for example: ${r.names.join(", ")}`;
    case "several":
      return `"${q}" matches: ${r.names.join(", ")}; search one by its full name`;
    case "unmakeable":
      return `${r.names.join(", ")} can't be made: no chain of steps from things found in the wild makes ${r.names.length > 1 ? "them" : "it"}`;
    case "steps": {
      const goals = [...new Set(r.goals.map((id) => displayName(gd, id)))];
      const what = goals.length === 1 && goals[0].toUpperCase() === q.toUpperCase() ? "" : ` (${goals.join(", ")})`;
      if (r.steps.length) return `${searchTitle(r)}${what}: ${r.steps.length} step${r.steps.length === 1 ? "" : "s"} (see SEARCH)`;
      return r.goals.some((id) => gd.depth(id) === 0) ? `${searchTitle(r)}${what}: ${displayName(gd, r.goals[0])} is found in the wild; no steps` : `${searchTitle(r)}${what}: no steps found`;
    }
  }
}

/** "MAKING FIRE" */
export function searchTitle(r: SearchResult): string {
  return `MAKING ${r.query.toUpperCase()}`;
}

/** Most step lines shown in the observation's SEARCH section. */
export const SEARCH_SHOWN = 40;

/** The observation's SEARCH section body (null: nothing to show). */
export function searchSection(r: SearchResult | null | undefined): { title: string; lines: string[] } | null {
  if (!r || r.kind !== "steps" || !r.steps.length) return null;
  const lines = r.steps.slice(0, SEARCH_SHOWN);
  if (r.steps.length > SEARCH_SHOWN) lines.push(`... and ${r.steps.length - SEARCH_SHOWN} more steps`);
  return { title: searchTitle(r), lines };
}

/** "- Sharp Stone on Straight Branch: it becomes Long Straight Shaft" */
export function stepLine(gd: GameData, t: Transition): string {
  const n = (id: number) => displayName(gd, id);
  if (t.actor === -1) {
    return t.newTarget > 0 ? `- ${n(t.target)} turns into ${n(t.newTarget)} by itself` : `- ${n(t.target)} disappears by itself`;
  }
  const who = t.actor === 0 ? "bare hands" : n(t.actor);
  const same = t.actor > 0 && t.target > 0 && n(t.actor) === n(t.target);
  const where = t.target > 0 ? (same ? `another ${n(t.target)}` : n(t.target)) : "the ground";
  const out: string[] = [];
  if (t.newActor > 0 && (t.actor <= 0 || gd.base(t.newActor) !== gd.base(t.actor))) out.push(`you get ${n(t.newActor)}`);
  else if (t.actor > 0 && t.newActor === 0 && !same) out.push(`the ${n(t.actor)} is used up`);
  if (t.newTarget > 0 && (t.target <= 0 || gd.base(t.newTarget) !== gd.base(t.target))) out.push(t.target > 0 ? `it becomes ${n(t.newTarget)}` : `it leaves ${n(t.newTarget)}`);
  else if (t.target > 0 && t.newTarget === 0 && !out.length) out.push(`the ${n(t.target)} is used up`);
  return `- ${who} on ${where}${out.length ? `: ${out.join(", ")}` : ""}`;
}

/** The base object's name: use-count variants ("(4/5 left)") collapse to it; no "#notes". */
function displayName(gd: GameData, id: number): string {
  return gd.name(gd.base(id));
}

function isDummy(gd: GameData, id: number): boolean {
  return id > 0 && !!gd.get(id)?.parent;
}

/** transitionBank producesMap: each transition under its newActor and its newTarget */
const producesCache = new WeakMap<GameData, Map<number, Transition[]>>();
function producesMap(gd: GameData): Map<number, Transition[]> {
  let m = producesCache.get(gd);
  if (m) return m;
  m = new Map();
  const add = (id: number, t: Transition) => {
    const a = m!.get(id);
    if (a) a.push(t);
    else m!.set(id, [t]);
  };
  for (const t of gd.allTransitions()) {
    if (t.newActor !== 0) add(t.newActor, t);
    if (t.newTarget !== 0 && t.newTarget !== t.newActor) add(t.newTarget, t);
  }
  producesCache.set(gd, m);
  return m;
}
