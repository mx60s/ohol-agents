// Builds the text observation an agent sees each turn. Only uses what the
// character's own client received (its World), so no global knowledge.

import type { World, Player } from "../game/world.ts";
import type { GameData } from "../game/gameData.ts";

export const BIOMES: Record<number, string> = {
  0: "grassland", 1: "swamp", 2: "yellow prairie", 3: "badlands", 4: "snowy tundra", 5: "desert", 6: "jungle",
};

const VIEW_RADIUS = 12;

export interface ObservationOptions {
  recipeHints: boolean;
  /** recent action results, newest last */
  history: { t: number; action: string; result: string }[];
  notebook: string[];
  pastLifeNotes: string[];
  goal: string | null;
  foodSources?: { x: number; y: number; d: number; id: number; gives: number }[];
}

export function playerLabel(w: World, gd: GameData, p: Player): string {
  const age = w.currentAge(p);
  const sex = p.female == null ? "person" : age < 3 ? (p.female ? "baby girl" : "baby boy") : p.female ? "woman" : "man";
  const name = p.name ? `${p.name}` : "unnamed";
  return `#${p.id} ${name} (${sex}, age ${age.toFixed(1)})`;
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

export function buildObservation(w: World, gd: GameData, o: ObservationOptions): string {
  const me = w.self;
  if (!me) return "You have no body yet.";
  const now = Date.now();
  const age = w.currentAge(me);
  const L: string[] = [];
  const here = w.cell(me.x, me.y);

  L.push(`== YOU ==`);
  L.push(`${playerLabel(w, gd, me)}. Lineage: ${me.ancestors.length ? `generation ${me.ancestors.length + 1}` : "you are an Eve (first of a family)"}.`);
  L.push(me.name ? `Your name is ${me.name}.` : me.ancestors.length === 0 ? `You have no name yet. As an Eve you can name yourself and found your family's name by saying "I AM <FIRST NAME> <FAMILY NAME>" (once only).` : `You have no name yet; usually your mother names you.`);
  L.push(`Age ${age.toFixed(1)} years. 1 year = 1 real minute. Old age kills you at 60.`);
  if (age < 3) L.push(`You are a baby: you can't feed yourself yet, can barely talk, and must be carried and nursed by a woman.`);
  L.push(`Position (${w.posOf(me)[0]}, ${w.posOf(me)[1]})${w.carrierOf(me) ? `, being carried by #${w.carrierOf(me)!.id}` : ""}. Biome: ${here ? BIOMES[here.biome] ?? `biome ${here.biome}` : "unknown"}.${here && here.floor ? ` Floor: ${gd.name(here.floor)}.` : ""}`);
  const hungerNote = w.food <= 3 ? " STARVING - EAT NOW" : w.food <= w.foodCapacity * 0.4 ? " hungry" : "";
  L.push(`Food: ${w.food}/${w.foodCapacity}${hungerNote}. Body heat: ${w.heat.toFixed(2)} (0.5 is ideal; ${w.heat < 0.35 ? "too cold" : w.heat > 0.65 ? "too hot" : "ok"}).`);
  L.push(`Holding: ${heldText(w, gd, me)}.`);
  const worn = me.clothing.map((c, i) => (c.id ? `${["hat", "tunic", "front shoe", "back shoe", "bottom", "backpack"][i]}: ${gd.describeStack(c)}` : null)).filter(Boolean);
  L.push(`Wearing: ${worn.length ? worn.join(", ") : "nothing"}.`);
  if (w.craving) L.push(`You are craving: ${gd.name(w.craving)} (eating it gives bonus food).`);
  const under = w.objAt(me.x, me.y);
  if (under.id) L.push(`On the ground under you: ${gd.describeStack(under)}.`);
  if (o.goal) L.push(`Your current goal: ${o.goal}`);

  // people
  const people = [...w.players.values()].filter((p) => p.id !== me.id && dist(me, p) <= VIEW_RADIUS + 4);
  people.sort((a, b) => dist(me, a) - dist(me, b));
  L.push(``);
  L.push(`== PEOPLE NEARBY ==`);
  if (!people.length) L.push(`Nobody in sight.`);
  for (const p of people.slice(0, 12)) {
    const rel = relation(w, p);
    const held = p.held.id ? `, holding ${heldText(w, gd, p)}` : "";
    const heldBy = [...w.players.values()].find((q) => q.held.id === -p.id);
    const carried = heldBy ? `, carried by #${heldBy.id}` : "";
    L.push(`- ${playerLabel(w, gd, p)}${rel ? ` [${rel}]` : ""} at (${p.x}, ${p.y}), ${dist(me, p)} away${held}${carried}${p.dying ? ", WOUNDED/DYING" : ""}`);
  }
  const myKids = [...w.players.values()].filter((p) => p.ancestors[0] === me.id && w.currentAge(p) < 3);
  if (myKids.length && me.female) {
    L.push(`You have ${myKids.length} baby/babies. Babies only get food while you carry them (pick_up_baby). A baby left alone starves within a few minutes.`);
  }

  // deaths we witnessed
  const deaths = w.deaths.filter((d) => now - d.t < 300_000);
  if (deaths.length) {
    L.push(``);
    L.push(`== DEATHS YOU SAW (last 5 minutes) ==`);
    for (const d of deaths) {
      const rel = relationTo(w, d.id, d.ancestors, d.eveId);
      L.push(`- ${Math.round((now - d.t) / 1000)}s ago: ${d.name ?? `unnamed #${d.id}`}${rel ? ` [${rel}]` : ""}, age ${d.age.toFixed(0)}, died at (${d.x}, ${d.y})`);
    }
  }

  // speech
  const heard = w.heard.filter((h) => now - h.t < 90_000).slice(-12);
  L.push(``);
  L.push(`== HEARD RECENTLY ==`);
  if (!heard.length) L.push(`Nothing.`);
  for (const h of heard) {
    const who = h.speakerId == null ? `written words at (${h.x}, ${h.y})` : h.speakerId === me.id ? "you" : (() => {
      const p = w.players.get(h.speakerId!);
      return p ? playerLabel(w, gd, p) : `#${h.speakerId}`;
    })();
    L.push(`- ${Math.round((now - h.t) / 1000)}s ago, ${who}: "${h.text}"`);
  }

  // things
  L.push(``);
  L.push(`== THINGS NEARBY (within ${VIEW_RADIUS} tiles, nearest first) ==`);
  const groups = new Map<string, { d: number; pos: [number, number][] }>();
  for (let dy = -VIEW_RADIUS; dy <= VIEW_RADIUS; dy++)
    for (let dx = -VIEW_RADIUS; dx <= VIEW_RADIUS; dx++) {
      const c = w.cell(me.x + dx, me.y + dy);
      if (!c || !c.obj.id) continue;
      const name = gd.describeStack(c.obj);
      const d = Math.max(Math.abs(dx), Math.abs(dy));
      const g = groups.get(name) ?? { d, pos: [] };
      g.d = Math.min(g.d, d);
      g.pos.push([me.x + dx, me.y + dy]);
      groups.set(name, g);
    }
  const sorted = [...groups].sort((a, b) => a[1].d - b[1].d);
  for (const [name, g] of sorted.slice(0, 45)) {
    g.pos.sort((a, b) => Math.max(Math.abs(a[0] - me.x), Math.abs(a[1] - me.y)) - Math.max(Math.abs(b[0] - me.x), Math.abs(b[1] - me.y)));
    const shown = g.pos.slice(0, 3).map((p) => `(${p[0]}, ${p[1]})`).join(" ");
    L.push(`- ${name}${g.pos.length > 1 ? ` x${g.pos.length}` : ""}: ${shown}${g.pos.length > 3 ? " ..." : ""}`);
  }
  if (sorted.length > 45) L.push(`- ...and ${sorted.length - 45} more kinds of things`);

  if (o.recipeHints && o.foodSources?.length) {
    L.push(``);
    L.push(`== FOOD YOU CAN GET BY HAND (for "forage") ==`);
    for (const f of o.foodSources.slice(0, 6)) L.push(`- ${gd.name(f.gives)} from ${gd.name(f.id)} at (${f.x}, ${f.y}), ${f.d} away`);
  }

  if (o.recipeHints) {
    const hints = recipeHints(w, gd, sorted.map(([, g]) => g.pos[0]));
    if (hints.length) {
      L.push(``);
      L.push(`== WHAT YOU KNOW HOW TO DO HERE (common knowledge) ==`);
      L.push(...hints);
    }
  }

  if (o.history.length) {
    L.push(``);
    L.push(`== YOUR RECENT ACTIONS ==`);
    for (const h of o.history.slice(-8)) L.push(`- ${Math.round((now - h.t) / 1000)}s ago: ${h.action} -> ${h.result}`);
  }

  if (o.pastLifeNotes.length) {
    L.push(``);
    L.push(`== NOTES CARRIED OVER FROM YOUR PAST LIVES ==`);
    L.push(...o.pastLifeNotes.slice(-15).map((n) => `- ${n}`));
  }
  L.push(``);
  L.push(`== YOUR NOTEBOOK (this life) ==`);
  L.push(o.notebook.length ? o.notebook.slice(-15).map((n) => `- ${n}`).join("\n") : "(empty)");
  return L.join("\n");
}

function heldText(w: World, gd: GameData, p: Player): string {
  if (p.held.id < 0) {
    const b = w.players.get(-p.held.id);
    return b ? `baby ${playerLabel(w, gd, b)}` : `baby #${-p.held.id}`;
  }
  return gd.describeStack(p.held);
}

function dist(a: { x: number; y: number }, b: { x: number; y: number }) {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

/** Transitions available right now with the held item / bare hands on nearby things. */
function recipeHints(w: World, gd: GameData, positions: [number, number][]): string[] {
  const me = w.self!;
  const held = me.held.id > 0 ? me.held.id : 0;
  const out: string[] = [];
  const seen = new Set<string>();
  if (held && gd.isFood(held)) out.push(`- You can eat the ${gd.name(held)} you're holding (action "eat") if not full.`);
  if (held && gd.get(held)?.clothing && gd.get(held)!.clothing !== "n") out.push(`- You can wear the ${gd.name(held)} (action "eat"/use on self puts clothing on).`);
  for (const pos of positions) {
    const target = w.objAt(pos[0], pos[1]).id;
    if (!target) continue;
    const t = gd.transition(held, target);
    if (!t) continue;
    const key = `${held},${target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const tool = held ? `held ${gd.name(held)}` : "bare hands";
    const results: string[] = [];
    if (t.newActor !== held) results.push(t.newActor ? `you get ${gd.name(t.newActor)}` : held ? `${gd.name(held)} is used up` : "");
    if (t.newTarget !== target) results.push(t.newTarget ? `it becomes ${gd.name(t.newTarget)}` : "it's gone");
    const r = results.filter(Boolean).join(", ") || "something happens";
    out.push(`- use ${tool} on ${gd.name(target)} at (${pos[0]}, ${pos[1]}): ${r}`);
    if (out.length >= 14) break;
  }
  return out;
}
