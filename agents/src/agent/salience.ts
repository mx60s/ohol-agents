// What counts as "something happened" for an agent: these events wake it
// before its next scheduled decision (never before the minimum interval),
// interrupt a `wait`, and, if urgent, cut a long walk or craft short.
// Everything else waits for the agent's normal turn.

import type { World, Player, Heard } from "../game/world.ts";

export interface Salient {
  reason: string;
  /** urgent = worth abandoning a walk/craft for */
  urgent: boolean;
  t: number;
}

export interface BodySnapshot {
  food: number;
  cap: number;
  carrierId: number | null;
}

const BABY_AGE = 3;
const HEAR_RADIUS = 10;

export function snapshot(w: World): BodySnapshot | null {
  const me = w.self;
  if (!me) return null;
  return { food: w.food, cap: w.foodCapacity, carrierId: w.carrierOf(me)?.id ?? null };
}

/** Thresholds a falling food bar can cross: half, quarter, starving (<=3; <=2 for babies). */
function bands(cap: number, baby: boolean): { at: number; label: string; urgent: boolean }[] {
  return [
    { at: Math.floor(cap * 0.5), label: "your food fell to half", urgent: false },
    { at: Math.floor(cap * 0.25), label: "your food fell to a quarter", urgent: true },
    { at: baby ? 2 : 3, label: "you are STARVING", urgent: true },
  ];
}

/** Body changes since the last snapshot: food thresholds crossed, being picked up or put down. */
export function bodyEvents(prev: BodySnapshot | null, cur: BodySnapshot | null, w: World, now = Date.now()): Salient[] {
  if (!prev || !cur) return [];
  const out: Salient[] = [];
  const me = w.self;
  const baby = !!me && w.currentAge(me) < BABY_AGE;
  if (cur.food < prev.food && cur.cap > 0) {
    // report only the deepest band crossed
    let hit: { label: string; urgent: boolean } | null = null;
    for (const b of bands(cur.cap, baby)) if (prev.food > b.at && cur.food <= b.at) hit = b;
    if (hit) out.push({ reason: `${hit.label} (${cur.food}/${cur.cap})`, urgent: hit.urgent, t: now });
  }
  if (prev.carrierId !== cur.carrierId) {
    if (cur.carrierId != null) out.push({ reason: `#${cur.carrierId} picked you up`, urgent: baby, t: now });
    else out.push({ reason: `#${prev.carrierId} put you down`, urgent: baby, t: now });
  }
  return out;
}

function isHungryBabyCry(text: string): boolean {
  return /^F+\b/i.test(text.trim()) && text.trim().length <= 3;
}

/** Speech worth waking for; null = not salient. */
export function speechEvent(w: World, h: Heard, now = Date.now()): Salient | null {
  const me = w.self;
  if (!me || h.speakerId == null || h.speakerId === me.id) return null;
  const sp = w.players.get(h.speakerId);
  const myPos = w.posOf(me);
  const spPos = sp ? w.posOf(sp) : [h.x, h.y];
  const d = Math.max(Math.abs(spPos[0] - myPos[0]), Math.abs(spPos[1] - myPos[1]));
  const iAmBaby = w.currentAge(me) < BABY_AGE;
  const spBaby = sp ? w.currentAge(sp) < BABY_AGE : false;
  const mine = !!sp && sp.ancestors[0] === me.id;
  if (spBaby && isHungryBabyCry(h.text)) {
    if (mine) return { reason: `your baby #${sp!.id} says "${h.text}" (hungry; holding it nurses it)`, urgent: true, t: now };
    if (!iAmBaby && d <= HEAR_RADIUS) return { reason: `baby #${h.speakerId} says "${h.text}" (hungry) ${d} tiles away`, urgent: false, t: now };
    return null;
  }
  const first = me.name?.split(" ")[0];
  const named = !!first && new RegExp(`\\b${first.replace(/[^A-Za-z]/g, "")}\\b`, "i").test(h.text);
  if (iAmBaby) {
    // a baby only cares about its mother (or carrier) and its own name
    const carrier = w.carrierOf(me);
    if (named || me.ancestors[0] === h.speakerId || carrier?.id === h.speakerId) return { reason: `#${h.speakerId} spoke to you`, urgent: false, t: now };
    return null;
  }
  if (named) return { reason: `#${h.speakerId} said your name`, urgent: false, t: now };
  if (d <= HEAR_RADIUS && !spBaby) return { reason: `#${h.speakerId} spoke nearby`, urgent: false, t: now };
  return null;
}

export function birthEvent(w: World, p: Player, now = Date.now()): Salient | null {
  if (w.selfId != null && p.ancestors[0] === w.selfId) return { reason: `you gave birth to #${p.id}: pick the baby up now, and name her or him while you hold the baby by saying "YOU ARE <FIRST NAME>"`, urgent: true, t: now };
  return null;
}

export function deathEvent(w: World, p: Player, now = Date.now()): Salient | null {
  const me = w.self;
  if (!me) return null;
  const d = Math.max(Math.abs(p.x - me.x), Math.abs(p.y - me.y));
  if (d > HEAR_RADIUS + 6) return null;
  const close = p.ancestors[0] === me.id || me.ancestors[0] === p.id;
  return { reason: `#${p.id}${p.name ? ` ${p.name}` : ""} died ${d} tiles away`, urgent: close, t: now };
}
