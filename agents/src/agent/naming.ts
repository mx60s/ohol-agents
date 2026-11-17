// Naming rules, checked on an agent's speech before it is sent.
//
// 1. No repeated family surnames, ever: an unnamed Eve's "I AM <FIRST> <FAMILY>"
//    is not sent when FAMILY was used by any family before (living or extinct,
//    from the persistent lineage records and what this character has seen).
//    The server patch (free-names.patch) refuses the same naming as a safety net.
// 2. Numbered repeat first names within a family: a mother's "YOU ARE AURORA"
//    becomes "YOU ARE AURORA II" (III, IV, ... X) when AURORA was already used
//    by anyone in her family. The server keeps the numeral as part of the first
//    name: the baby is AURORA II DAWN, family DAWN.
//
// The phrase lists mirror the server's settings (familyNamingPhrases.ini,
// babyNamingPhrases.ini) and how server.cpp isNamingSay() matches them: the
// phrase must open the line and be followed by a space; the first listed
// phrase that matches wins. Names are cleaned like mtsCleanName(): runs of
// letters, upper case, at most 16 letters per word.

export const FAMILY_NAMING_PHRASES = [
  "CALL ME EVE", "CALL ME", "I AM EVE", "I'M EVE", "IM EVE", "I AM CALLED EVE", "I AM NAMED EVE",
  "I AM CALLED", "I AM NAMED", "I AM", "I'M", "IM", "MY NAME IS EVE", "MY NAME IS",
];
export const BABY_NAMING_PHRASES = ["YOU ARE CALLED", "YOU ARE NAMED", "YOU ARE", "YOU'RE", "YOURE", "YOUR NAME IS", "I NAME YOU", "I CALL YOU"];

/** taken surnames listed in a refusal or an observation */
export const TAKEN_SHOWN = 15;

const ROMAN = ["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"];
/** the numerals a repeated first name can carry (server patch: II..X) */
export const MAX_NUMERAL = 10;

/** II..X (the numerals used for repeated first names). */
export function isNumeral(word: string): boolean {
  const i = ROMAN.indexOf(word.toUpperCase());
  return i >= 2 && i <= MAX_NUMERAL;
}

export function roman(n: number): string {
  return ROMAN[n] ?? String(n);
}

/** Speech as the server receives it from Body.say: upper case, single spaces. */
export function normalizeSpeech(text: string): string {
  return text.toUpperCase().replace(/[^\x20-\x22\x24-\x7E]/g, " ").replace(/\s+/g, " ").trim();
}

/** The words after a naming phrase that opens `said`, or null (server isNamingSay). */
export function namingRest(said: string, phrases: readonly string[]): string | null {
  if (said.startsWith(":")) return null; // reading written words aloud
  for (const p of phrases) {
    if (!said.startsWith(p)) continue;
    const rest = said.slice(p.length);
    if (!rest.startsWith(" ")) continue; // "I AM EVERHARD" is not "I AM EVE ..."
    return rest.trimStart();
  }
  return null;
}

/**
 * The step after which a baby-naming line must be spoken, or -1 to speak it
 * first as usual. The server names a baby only while the speaker holds it
 * (server.cpp: with empty arms "YOU ARE X" names the nearest nameless person
 * aged 5 or older), and the reply's say goes out before its actions, so
 * "YOU ARE AURORA" with pick_up_baby in the same reply would reach the server
 * before the pickup and name no one. Such a line waits for the first
 * pick_up_baby step. `holdingBaby`: already carrying someone.
 */
export function namingSayAfterStep(say: string, steps: readonly { type: string }[], holdingBaby: boolean): number {
  if (holdingBaby || namingRest(normalizeSpeech(say), BABY_NAMING_PHRASES) == null) return -1;
  return steps.findIndex((s) => s.type === "pick_up_baby");
}

/** Letter runs, upper case, each cut to 16 letters (mtsCleanName). */
export function letterWords(s: string): string[] {
  return (s.toUpperCase().match(/[A-Z]+/g) ?? []).map((w) => w.slice(0, 16));
}

/**
 * The name an unnamed Eve gets from the words after "I AM": "MARIA HOPE" ->
 * MARIA HOPE, "HOPE" -> EVE HOPE. Numerals are skipped (an Eve has no
 * namesakes to count). Null when there are no letters.
 */
export function eveNameFrom(rest: string): { first: string; family: string } | null {
  const w = letterWords(rest).filter((x) => !isNumeral(x)).slice(0, 2);
  if (!w.length) return null;
  return w.length === 2 ? { first: w[0], family: w[1] } : { first: "EVE", family: w[0] };
}

/** A baby's first name from the words after "YOU ARE": the first word, plus a numeral if one follows it. */
export function babyNameFrom(rest: string): { first: string; numeral: string | null } | null {
  const w = letterWords(rest);
  if (!w.length) return null;
  return { first: w[0], numeral: w[1] && isNumeral(w[1]) ? w[1] : null };
}

/**
 * Family surname of a full name: the last word, ignoring a numeral.
 * "AURORA II DAWN" -> DAWN, "MIRA SOL" -> SOL; a lone first name ("AURORA",
 * "AURORA II": named before the family had a name) has none.
 */
export function surnameOf(name: string | null | undefined): string | null {
  const w = letterWords(name ?? "");
  if (w.length < 2) return null;
  const last = w[w.length - 1];
  return isNumeral(last) ? null : last;
}

/** First name with its numeral: "AURORA II DAWN" -> "AURORA II", "AURORA DAWN" -> "AURORA". */
export function firstNameKey(name: string | null | undefined): string | null {
  const w = letterWords(name ?? "");
  if (!w.length) return null;
  return w[1] && isNumeral(w[1]) ? `${w[0]} ${w[1]}` : w[0];
}

/** The name to give: `wanted` if unused in the family, else FIRST II, III, ... X (null when even X is used). */
export function freeFirstName(first: string, numeral: string | null, used: ReadonlySet<string>): string | null {
  const wanted = numeral ? `${first} ${numeral}` : first;
  if (!used.has(wanted)) return wanted;
  for (let n = 2; n <= MAX_NUMERAL; n++) {
    const k = `${first} ${roman(n)}`;
    if (!used.has(k)) return k;
  }
  return null;
}

export interface NamingContext {
  /** this character is an Eve with no name yet (her "I AM ..." founds her family) */
  unnamedEve: boolean;
  /** the unnamed baby in this character's arms ("YOU ARE ..." names it), else null */
  unnamedBaby: { female: boolean | null } | null;
  /** family surnames used before, most recent first (upper case) */
  takenSurnames: readonly string[];
  /** first names (with numerals, "AURORA II") used by anyone in this character's family */
  familyFirstNames: ReadonlySet<string>;
}

export type SpeechReview =
  /** send `say`; `note` explains a change for the action result */
  | { ok: true; say: string; note?: string }
  /** don't send; `reason` is the action result */
  | { ok: false; reason: string };

/** "DAWN, HOPE, SOL" (at most TAKEN_SHOWN) */
export function takenList(taken: readonly string[]): string {
  const shown = taken.slice(0, TAKEN_SHOWN).join(", ");
  return taken.length > TAKEN_SHOWN ? `${shown}, ...` : shown;
}

/** Apply the naming rules to one line of speech. */
export function reviewSpeech(text: string, ctx: NamingContext): SpeechReview {
  const said = normalizeSpeech(text);
  if (ctx.unnamedEve) {
    const rest = namingRest(said, FAMILY_NAMING_PHRASES);
    const name = rest != null ? eveNameFrom(rest) : null;
    if (name && ctx.takenSurnames.includes(name.family)) {
      return { ok: false, reason: `family name ${name.family} is already taken by an earlier family; choose a new one (taken: ${takenList(ctx.takenSurnames)})` };
    }
  }
  if (ctx.unnamedBaby) {
    const rest = namingRest(said, BABY_NAMING_PHRASES);
    const name = rest != null ? babyNameFrom(rest) : null;
    if (name) {
      const wanted = name.numeral ? `${name.first} ${name.numeral}` : name.first;
      const free = freeFirstName(name.first, name.numeral, ctx.familyFirstNames);
      if (free && free !== wanted) {
        const her = ctx.unnamedBaby.female === true ? "her" : ctx.unnamedBaby.female === false ? "him" : "the baby";
        return { ok: true, say: `YOU ARE ${free}`, note: `named ${her} ${free}; ${wanted} was taken in your family` };
      }
    }
  }
  return { ok: true, say: text };
}

/** Taken surnames from several sources, most recent first, deduplicated. */
export function mergeSurnames(...lists: Iterable<string | null | undefined>[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const l of lists)
    for (const s of l) {
      const u = s?.toUpperCase();
      if (!u || seen.has(u)) continue;
      seen.add(u);
      out.push(u);
    }
  return out;
}
