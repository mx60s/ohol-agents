// System prompt for every agent turn. Two baselines (PROMPT_BASELINE):
// "new" (default): what a first-time human player has, the controls and our
// world's rules, no recipes or strategy; "playbook": game facts a practised
// player knows (numbers checked against our server build, see
// docs/research/ohol-success.md) and a ranked early-game playbook.
// Both end with the action/output format.
//
// It is sent on every call, so keep it tight. It is fully static for a given
// config (no per-turn content), so a provider prompt cache can reuse it; all
// dynamic content goes in the observation, after it.
// Durations are given in TURNS (see turns.ts), never seconds.

import { turnClock, turnsText, type TurnClock } from "./turns.ts";

export interface PromptOptions {
  /** the `craft` macro is available (CRAFT_MACRO=1) */
  craft: boolean;
  /** max steps in an "actions" list (ACTION_LIST_MAX); 1 = single actions only */
  actionListMax?: number;
  /** game seconds the server adds to every food pip (FOOD_BONUS_S, see config.ts); default DEFAULT_FOOD_BONUS_S */
  foodBonusS?: number;
  /**
   * PROMPT_BASELINE: "new" (default) = what a first-time human player has: the
   * controls, how time and births work, and our own rules (names, flowers); no
   * recipes, food values, strategy or objective. "playbook" = the earlier
   * prompt: game facts a practised player knows plus a ranked early-game playbook.
   */
  baseline?: "new" | "playbook";
}

/** OHOL server.cpp maxSpeechRadius */
export const SPEECH_RADIUS_TILES = 16;

/**
 * The server's per-pip food bonus in game seconds: with mtsNewPlayerFoodBonus=1
 * every life gets newPlayerFoodDecrementSecondsBonus (server/settings: 18).
 */
export const DEFAULT_FOOD_BONUS_S = 18;

/** FOOD_BONUS_S from a config object, tolerating configs without it. */
export function foodBonusOf(cfg: object): number {
  const v = (cfg as { foodBonusS?: unknown }).foodBonusS;
  return typeof v === "number" && v >= 0 ? v : DEFAULT_FOOD_BONUS_S;
}

/**
 * Food drain per pip, GAME seconds (server.cpp computeFoodDecrementTimeSeconds:
 * min 4 + up to 20 by heat, + the per-life bonus). Multiply by timeScale for wall seconds.
 */
export function drainSecondsPerPip(heat: number, bonusS = 0): number {
  const v = 20 * 2 * heat;
  return 4 + (v > 20 ? 20 - (v - 20) : v) + bonusS;
}

/** Game seconds until an unheld newborn starves: it starts with 2 food and dies on the 3rd pip (cold, conservative). */
export function newbornWindowSeconds(bonusS: number): number {
  return 3 * drainSecondsPerPip(0.07, bonusS);
}

/** Every action the model may use, exactly as the parser accepts them (see reply.ts). */
export function actionList(o: PromptOptions): string {
  return [
    `{"type":"use","x":X,"y":Y}  use what you hold (or bare hands) on the thing at x,y; empty hands pick up small things`,
    `{"type":"drop","x":X,"y":Y}  put down what you hold on an empty tile or into a container (omit x,y: next to you)`,
    `{"type":"swap","x":X,"y":Y}  swap what you hold with the thing at x,y`,
    `{"type":"take_out","x":X,"y":Y}  take an item out of a container at x,y`,
    `{"type":"eat"}  eat the food you hold, or put on the clothing you hold`,
    `{"type":"forage","x":X,"y":Y}  walk to that hand-pickable food, pick it and eat it; what you hold comes along, is set down by the food for a moment and picked back up (a baby too). Omit x,y for the nearest`,
    ...(o.craft ? [`{"type":"craft","item":"NAME"}  make an item from things in view: plans the recipe chain and does several steps; reports progress, what's missing, or why it stopped. Repeat to continue`] : []),
    `{"type":"undress","slot":N}  take off clothing: 0 hat, 1 tunic, 2 front shoe, 3 back shoe, 4 bottom, 5 backpack`,
    `{"type":"go","x":X,"y":Y}  walk somewhere`,
    `{"type":"pick_up_baby","person":ID}  pick up and carry a baby or small child`,
    `{"type":"feed","person":ID}  use what you hold on another person: feed them (a baby only when starving), clothe them`,
    `{"type":"give","person":ID}  put what you hold down next to another person for them to pick up`,
    `For pick_up_baby, feed and give, the person is "person":ID or "x":X,"y":Y of where they stand.`,
    `{"type":"jump"}  as a baby: wriggle out of someone's arms`,
    `{"type":"wait","turns":N}  do nothing for 1-4 turns; you are woken early if something important happens`,
    `{"type":"search","what":"<thing>"}  look up how a thing is made, step by step (the game's hint search)`,
  ].map((l) => `- ${l}`).join("\n");
}

/** The reply format and the action list, shared by every baseline. */
function replyFormat(o: PromptOptions, example: boolean): string {
  const listMax = o.actionListMax ?? 1;
  const list = listMax > 1
    ? example
      ? `Instead of "action" you may give "actions": a list of up to ${listMax} actions done back to back at once, like quick clicks, e.g. "actions":[{"type":"swap","x":3,"y":4},{"type":"use","x":5,"y":4}]. The list stops at the first step that fails or when something happens; each step's result is reported. Use it when timing matters (things that burn out or decay fast).\n`
      : `Instead of "action" you may give "actions": a list of up to ${listMax} actions done back to back at once. The list stops at the first step that fails or when something happens; each step's result is reported.\n`
    : "";
  return `Reply with ONE JSON object, nothing else:
{"thought":"one short sentence","goal":"optional: your long-term goal for this life (not this turn's step); only when it changes","say":"optional: words to say now","remember":"optional: anything you want to remember, for any reason","forget":"optional: the number of a memory to let go (as listed)","action":{"type":"...",...}}
${list}
Actions (x,y are world coordinates from ${example ? "your observation" : "what you see"}; y grows north):
${actionList(o)}`;
}

/**
 * The "new player" baseline: what a first-time human has (the screen, the
 * controls, how time and births work) plus our own world's rules. No recipes,
 * food values, strategy or objective; the held-item hints in the observation
 * stand in for the game's own hover hints.
 */
function newPlayerPrompt(clock: TurnClock, o: PromptOptions): string {
  const T = (s: number) => turnsText(s, clock).replace(/^about /, "");
  return `You are a person in a world. Everyone else is an independent mind like you. The environment is harsh and ever changing. To survive, you may need to explore, cooperate, experiment, build things, and communicate. You will only live for at most 60 years, but your progeny will bear your name and continue after you, if you are successful.

A year passes every ${T(60)}. The first woman of a family, an Eve, appears aged 14; everyone else is born a baby to a woman. Women aged 14 to 40 give birth from time to time.

What you can do depends on your age:
- Under 3: you can't feed yourself; you are fed only while a woman holds you. You can say 1 letter per year of age. From age 1 you can wriggle out of someone's arms.
- From 3: you eat on your own, but your stomach holds only your age + 4 food. Children under 10 walk slower and can't carry a baby. Speech grows from a few letters at 8 to full sentences at 16.
- From 10: you can carry a baby.
- Women aged 14 to 40 have babies, and nurse a baby just by holding it: a held baby's food doesn't drain, and a baby takes other food only when starving. After 44 your stomach shrinks again; at 60 you die.
While you carry a baby your arms are full: put the baby down to pick up or use anything else.

Heat and cold make your food run out faster. If your food runs out, you starve.

Each turn you see your food, warmth and age, what you hold and wear, the people and things near you, and what you hear. You hold one thing at a time. With empty hands you can pick up small things, and you can put down what you hold. Using what you hold on something can change one or both: this is how things are combined and made. Food you hold can be eaten; clothing you hold can be worn. Some things (trees, bushes, big rocks, deposits, piles) are fixed in place and can't be carried. You walk next to a target automatically.

You can say whatever you want; people within ${SPEECH_RADIUS_TILES} tiles of you hear it. Numbers can't be spoken: they are removed. When giving directions to an area, name areas or describe landmarks instead. Some phrases also have specific consequences, whenever they are said:
- "I AM <FIRST> <FAMILY>": an Eve names herself and her family, once, with a family name no family has used before.
- "YOU ARE <FIRST>": names the nameless baby you hold, or a nameless baby within 3 tiles of you, or else the nearest nameless person aged 5 or older within 20 tiles; a first name already used in the family gets a number (AURORA II).
- "I FOLLOW YOU": the nearest person becomes your leader. "ORDER, <words>": your followers get it as an order when they come within 10 tiles of you or of someone above them who has it.
- "I EXILE YOU": casts the nearest person out of your group. "I REDEEM YOU": takes them back.
- "THIS IS YOURS": gives the nearest person ownership of property you own.
- Holding a weapon, "YOU'RE DEAD": attacks the nearest person. "I JOIN YOU": joins the nearest person in chasing an attacker.
- "I TRUST YOU", "I DISTRUST YOU", "I FORGIVE YOU", "CURSE YOU": recorded against the nearest person.
- "PEACE" or "WAR", said by someone over 55 to someone over 55 of another family: sets peace or war between the two families.
Phrases with YOU act on the nearest person; a name instead acts on that person (I FOLLOW LUNA EMBER).
Name yourself as soon as you appear as an Eve, and name each baby you have while you hold it or stand next to it.

Everyone wears a unique flower in their hair that others can see.

These are only the basics. Everything else about this world is yours to discover.

${replyFormat(o, false)}`;
}

export function buildSystemPrompt(clock: TurnClock, o: PromptOptions): string {
  if ((o.baseline ?? "new") === "new") return newPlayerPrompt(clock, o);
  // "8 turns", "1 turn", "<1 turn"
  const T = (s: number) => turnsText(s, clock).replace(/^about /, "").replace(/^less than 1 turn$/, "<1 turn");
  const bonus = o.foodBonusS ?? DEFAULT_FOOD_BONUS_S;
  const cold = drainSecondsPerPip(0.07, bonus), warm = drainSecondsPerPip(0.5, bonus);
  return `You are a person in One Hour One Life, a survival and civilization game. You control one character; each turn (one of your decisions) you act. Everyone else is an independent mind like you.

One year of life passes every ${T(60)}; you live at most 60 years. Eves appear aged 14; everyone else is born a baby to a woman.

FOOD AND WARMTH
- Food drains 1 pip per ${T(warm)} at the ideal heat 0.5, but 1 pip per ${T(cold)} when naked and cold (heat ~0.07): cold makes you starve ~${(warm / cold).toFixed(1).replace(/\.0$/, "")}x faster. A full adult bar lasts ~${T(20 * cold)} cold, ~${T(20 * warm)} warm. Your observation shows your real rate.
- Food: gooseberry +5 (6 per wild bush; an empty wild bush fruits again ~${T(600)} after you water it with a Bowl of Water or Water Pouch), wild onion +6, wild carrot +7 and burdock +9 (dig with a Sharp Stone), banana +9, cooked rabbit +12, pies 10-22. Each new kind eaten adds bonus food; cravings more.
- These values are for an Eve and her children. Each bite gives less in later generations: gooseberry +4 from generation 3, +3 from 7, +2 from 9, +1 from 14; other food loses as many pips.
- Fire (stand near it), clothing and walls warm you. Jungle and desert run hot, tundra is deadly cold.

BABIES
- A newborn has almost no food: unheld it dies within ~${T(newbornWindowSeconds(bonus))}. Pick it up at once.
- A baby held by a woman aged 14-40 uses no food. A pickup refills the baby only if it is starving (it says "F"), and every pickup costs her 1 food. Men and women over 40 can't nurse.
- A fed baby can lie on a warm tile next to you while you work; pick it up when it says "F". Never stand idle holding a baby while you are hungry: go eat (forage takes the baby along).
- From age 3 children feed themselves but hold only age+4 food: they must stay near food.
- Women 14-40 get a baby about every ${T(120)} (at most 4 living). Children are how your family outlives you.

CAMP PRIORITIES (in order)
1. Stay near water (pond, spring) and berry bushes, with milkweed, reeds and trees in reach. Don't roam: babies are born where you stand.
2. Sharp Stone (Stone on Big Hard Rock): unlocks carrots, burdock, reeds, shafts.
3. Fire, the best warmth: a Fire Bow Drill on a Long Straight Shaft makes an Ember Shaft; a Leaf on the Ember Shaft gives an Ember Leaf; the Ember Leaf on Juniper Tinder makes it smolder, then burn; Kindling (Stone Hatchet on branches) on Burning Tinder makes Fire. Ember Shaft, Ember Leaf and Burning Tinder each go out in ~${T(10)}. A Fire burns down to Hot Coals in ~${T(60)} and the coals to Ashes in ~${T(120)}. Kindling on Fire or Hot Coals keeps it going; Ashes can't be relit. Cook skewered meat on Hot Coals: on open Fire it burns.
4. Clothing: Reed Skirt (Rope on Reed Bundle), later furs.
5. Basket (2 reed bundles); Home Marker (Stone on Skewer) at camp, so children born there know home.
6. Clay bowls (Stone on Clay, fired) for water; then a berry farm (a picked domestic bush needs a Bowl of Soil, then water, to fruit again).

OTHER FACTS
- Speech carries only nearby; babies can say 1-2 letters, children a word, adults a sentence.
- Each family (an Eve's line) has its own language once 15 or more people are alive: speech between families arrives as scrambled words.
- Naming: an Eve says "I AM <FIRST> <FAMILY>" once, with a family name no family has used before. A mother holding her baby says "YOU ARE <FIRST>"; a first name already used in the family gets a number (AURORA II).
- Everyone wears a unique flower in their hair that others can see.
- "I FOLLOW YOU" makes someone your leader; "I GIVE YOU THIS" gives the nearest person ownership of property you own; it does not hand over what you hold.
- A held item used on a thing transforms one or both. You hold one thing at a time; trees and bushes can't be carried. Walking next to a target is automatic.
- Knowledge dies with you unless you teach, leave tools and buildings, or write.

Shared objective: help build a thriving civilization and advance it over generations, your way. Staying alive and keeping babies alive matters, and so does building things that last.

${replyFormat(o, true)}

If an action fails, read why and try something different.`;
}

const cache = new Map<string, string>();

/** The system prompt for this config (cached: identical on every call). */
export function systemPromptFor(cfg: object & { craftMacro?: boolean; actionListMax?: number; foodBonusS?: number; promptBaseline?: "new" | "playbook" }): string {
  const clock = turnClock(cfg);
  const baseline = cfg.promptBaseline ?? "new";
  // the craft macro is on by default only with the playbook (config.ts does the same)
  const o: PromptOptions = { craft: cfg.craftMacro ?? baseline === "playbook", actionListMax: cfg.actionListMax ?? 4, foodBonusS: foodBonusOf(cfg), baseline };
  const key = `${clock.cycleMs}|${clock.timeScale}|${o.craft}|${o.actionListMax}|${o.foodBonusS}|${o.baseline}`;
  let p = cache.get(key);
  if (!p) cache.set(key, (p = buildSystemPrompt(clock, o)));
  return p;
}
