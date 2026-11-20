// Who an agent knows by name, and how it sees everyone else.
//
// Per agent and per life, a character knows by name: itself; its own family
// (same Eve); anyone whose naming it heard ("YOU ARE X" or an Eve's "I AM X Y",
// marked "[this named #N]" by World.markNaming); anyone it heard introduce
// themself ("I AM X", "MY NAME IS X"); and anyone it recorded a name for in a
// "remember" note (its own name for them, not checked, replaced by the real
// one if it later hears it). A line heard in another family's language only
// teaches a name that came through unscrambled. Once known, a name stays known
// for the life.
//
// Everyone else is a stranger, shown with no #id and no name: by what is
// visible (sex and age, the flower they wear), plus what they hold or where they
// stand when two would read alike. The stream and the site still show
// everyone's true names (viewers see everything).

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { withArticle, type GameData } from "../game/gameData.ts";
import type { World, Player, Heard, DeadPerson } from "../game/world.ts";

/**
 * An age as shown: one decimal under 3 (else whole years), rounded down so a label never passes a
 * threshold early ("baby girl, 2.9", not "baby girl, 3.0"; "girl, 13", not "girl, 14").
 */
export function ageText(age: number, decimals = age < 3 ? 1 : 0): string {
  const f = 10 ** decimals;
  return (Math.floor(age * f + 1e-9) / f).toFixed(decimals);
}

/** "woman", "girl", "baby boy", "person" (sex unknown) */
export function sexWord(female: boolean | null, age: number): string {
  if (female == null) return "person";
  if (age < 3) return female ? "baby girl" : "baby boy";
  if (age < 14) return female ? "girl" : "boy";
  return female ? "woman" : "man";
}

/** "#7 AURORA BREEZE (woman, 30, red rose)", "#8 (no name, baby boy, 0.4)": someone known (or everyone, without name rules) */
export function playerLabel(w: World, _gd: GameData, p: Player, flower?: string | null): string {
  const age = w.currentAge(p);
  const sex = sexWord(p.female, age);
  // no name: say so inside the parentheses; a bare "unnamed" in name position got copied as a name ("I AM UNNAMED THORN")
  const name = p.name ? `${p.name} ` : "";
  return `#${p.id} ${name}(${p.name ? "" : "no name, "}${sex}, ${ageText(age)}${flower ? `, ${flower}` : ""})`;
}

/** a name the character knows; own = its own name for them (from a "remember" note), not the real one */
export interface KnownName {
  name: string;
  own?: boolean;
}

/** what is saved per agent (one file, the current life) */
export interface KnownNamesFile {
  playerId: number;
  names: [number, KnownName][];
}

/**
 * "I AM LIRA", "HELLO, I AM LIRA", "MY NAME IS LIRA": an introduction anywhere in a line. It teaches the
 * speaker's full name only when the word after it is their real first name ("I AM HUNGRY" teaches nothing).
 */
const INTRO = /(?:^|[^A-Z'])(?:I AM|I'M|IM|MY NAME IS|CALL ME|THIS IS|IT'S|ITS)\s+([A-Z][A-Z'-]*)/gi;

function hasWord(text: string, word: string): boolean {
  const w = word.replace(/[^A-Z0-9'-]/gi, "");
  return !!w && new RegExp(`(^|[^A-Z0-9'])${w}([^A-Z0-9']|$)`, "i").test(text);
}

const realName = (w: World, id: number): string | null => w.players.get(id)?.name ?? w.names.get(id) ?? null;

/** Who one character knows by name (see the top of this file). Saved to `file` on every change when given. */
export class Acquaintances {
  /** the life (player id) these names belong to */
  playerId: number | null = null;
  readonly names = new Map<number, KnownName>();
  /** heard lines already read: true once read with their naming mark (a mark can arrive after the line) */
  private read = new WeakMap<Heard, boolean>();

  constructor(readonly file: string | null = null) {}

  /** a new life: nobody known yet */
  reset(playerId: number | null) {
    this.playerId = playerId;
    this.names.clear();
    this.read = new WeakMap();
  }

  /** the same life after a restart: the names saved for it (false if none were saved for this player) */
  restore(playerId: number): boolean {
    this.reset(playerId);
    if (!this.file) return false;
    try {
      const d = JSON.parse(readFileSync(this.file, "utf8")) as KnownNamesFile;
      if (d?.playerId !== playerId || !Array.isArray(d.names)) return false;
      for (const [id, k] of d.names) if (Number.isFinite(id) && typeof k?.name === "string" && k.name) this.names.set(id, k.own ? { name: k.name, own: true } : { name: k.name });
      return true;
    } catch {
      return false;
    }
  }

  toJSON(): KnownNamesFile {
    return { playerId: this.playerId ?? 0, names: [...this.names] };
  }

  private save() {
    if (!this.file || this.playerId == null) return;
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.toJSON()) + "\n");
      renameSync(tmp, this.file);
    } catch (e) {
      console.error("known names save failed", e);
    }
  }

  /** Learn a name. A real name replaces the character's own name for someone; its own never replaces a real one. */
  learn(id: number, name: string, own = false): boolean {
    const cur = this.names.get(id);
    if (own && cur && !cur.own) return false;
    if (cur && cur.name === name && !!cur.own === own) return false;
    this.names.set(id, own ? { name, own: true } : { name });
    this.save();
    return true;
  }

  /** same family: mother, child, grandmother, grandchild, sibling, or the same Eve */
  isFamily(w: World, id: number, known?: { ancestors: number[]; eveId: number | null }): boolean {
    const me = w.self;
    if (!me) return false;
    if (id === me.id) return true;
    if (me.ancestors.includes(id)) return true;
    const p = w.players.get(id);
    const lin = p ?? w.lineage.get(id) ?? known;
    if (!lin) return false;
    if (lin.ancestors.includes(me.id)) return true;
    if (me.ancestors[0] && lin.ancestors[0] === me.ancestors[0]) return true;
    const myEve = me.eveId ?? (me.ancestors.length === 0 ? me.id : null);
    return myEve != null && (lin.eveId === myEve || id === myEve);
  }

  /** knows this person's real name (or that they have none yet): self, family, heard */
  knowsTruly(w: World, id: number, lineage?: { ancestors: number[]; eveId: number | null }): boolean {
    if (id === w.selfId) return true;
    const k = this.names.get(id);
    return (!!k && !k.own) || this.isFamily(w, id, lineage);
  }

  /** shown with a #id: known truly, or by its own name for them */
  knows(w: World, id: number): boolean {
    return this.names.has(id) || this.knowsTruly(w, id);
  }

  /** Learn from heard lines (naming marks, introductions). Cheap: call after every server message. */
  sync(w: World) {
    for (const h of w.heard) {
      const r = this.read.get(h);
      if (r === true || (r === false && h.named == null)) continue;
      this.read.set(h, h.named != null);
      this.hear(w, h);
    }
  }

  private hear(w: World, h: Heard) {
    if (h.notice || h.speakerId == null) return;
    // the words as they reached us (another family's language scrambles them): a name counts only if it came through
    const words = h.spoken ?? h.text;
    if (h.named != null) {
      const n = realName(w, h.named);
      if (n && hasWord(words, n.split(" ")[0])) this.learn(h.named, n);
    }
    if (h.speakerId !== w.selfId) {
      const n = realName(w, h.speakerId);
      const first = n?.split(" ")[0].toUpperCase();
      // offering a first name teaches the full name (the family name is visible to anyone who knows the first)
      if (n && [...words.matchAll(INTRO)].some((m) => m[1].toUpperCase() === first)) this.learn(h.speakerId, n);
    }
  }
}

const pronoun = (female: boolean | null) => (female == null ? "them" : female ? "her" : "him");

/**
 * How one character sees people this moment: labels by what it knows (see
 * Acquaintances). Built per observation (stranger descriptions are made
 * unique among the people in view). Without Acquaintances everyone is shown
 * as known (#id and name), as before the name rules.
 */
export class PeopleView {
  /** what tells two strangers apart who would read alike: ", holding a Stone" / ", at (3, 4)" */
  private extra = new Map<number, string>();
  /** strangers told apart by where they stand (their extra is ", at (x, y)") */
  private byPos = new Set<number>();

  constructor(readonly w: World, readonly gd: GameData, readonly acq: Acquaintances | null = null, readonly flowerOf?: (id: number) => string | null) {
    if (!acq) return;
    const groups = new Map<string, Player[]>();
    for (const p of w.players.values()) {
      if (p.id === w.selfId || this.known(p.id)) continue;
      const k = this.base(p);
      const g = groups.get(k);
      if (g) g.push(p);
      else groups.set(k, [p]);
    }
    for (const g of groups.values()) {
      if (g.length < 2) continue;
      const holds = g.map((p) => this.holding(p));
      g.forEach((p, i) => {
        if (holds.filter((h) => h === holds[i]).length === 1) this.extra.set(p.id, `, ${holds[i]}`);
        else {
          const [x, y] = w.posOf(p);
          this.extra.set(p.id, `, at (${x}, ${y})`);
          this.byPos.add(p.id);
        }
      });
    }
  }

  /** shown with #id (and name if they have one) */
  known(id: number): boolean {
    return !this.acq || this.acq.knows(this.w, id);
  }

  private flower(id: number): string | null {
    return this.flowerOf?.(id) ?? this.w.graveBook.flowerOfDead(id);
  }

  private nameOf(p: { id: number; name?: string | null }): string | null {
    return p.name ?? this.w.names.get(p.id) ?? null;
  }

  /** "a woman, 30, with a red rose" */
  private base(p: Player): string {
    const age = this.w.currentAge(p);
    const f = this.flower(p.id);
    return `${withArticle(sexWord(p.female, age))}, ${ageText(age)}${f ? `, with ${withArticle(f)}` : ""}`;
  }

  private holding(p: Player): string {
    if (p.held.id < 0) return "carrying a baby";
    if (p.held.id > 0 && !this.gd.condition(p.held.id)) return `holding ${withArticle(this.gd.name(p.held.id))}`;
    return "empty-handed";
  }

  /**
   * a stranger as seen: "a woman, 30, with a red rose" (+ what tells them apart from a look-alike in view);
   * posShown: the line prints their position right after, so ", at (x, y)" is not added again
   */
  describe(p: Player, posShown = false): string {
    return `${this.base(p)}${posShown && this.byPos.has(p.id) ? "" : this.extra.get(p.id) ?? ""}`;
  }

  /** how this character calls someone it named itself: "the woman with the red rose" */
  shortDescribe(p: Player): string {
    const f = this.flower(p.id);
    const [x, y] = this.w.posOf(p);
    return `the ${sexWord(p.female, this.w.currentAge(p))}${f ? ` with the ${f}` : ` at (${x}, ${y})`}`;
  }

  /**
   * A person in a list or line: known, "#7 AURORA BREEZE (woman, 30, red rose)" (flower when asked);
   * named by this character itself, "#7 LIRA (as you know her), woman, 30, with a red rose";
   * a stranger, "a woman, 30, with a red rose (you don't know their name yet)" or "(no name)" if they have none.
   * posShown: the caller prints their position right after (PEOPLE), so a look-alike's ", at (x, y)" is left out.
   */
  label(p: Player, withFlower = false, posShown = false): string {
    const name = this.nameOf(p);
    const q = name !== p.name ? { ...p, name } : p;
    if (!this.acq || this.acq.knowsTruly(this.w, p.id)) return playerLabel(this.w, this.gd, q, withFlower ? this.flower(p.id) : null);
    const own = this.acq.names.get(p.id);
    if (own) {
      const age = this.w.currentAge(p);
      const f = this.flower(p.id);
      return `#${p.id} ${own.name} (as you know ${pronoun(p.female)}), ${sexWord(p.female, age)}, ${ageText(age)}${f ? `, with ${withArticle(f)}` : ""}`;
    }
    return `${this.describe(p, posShown)} (${name ? "you don't know their name yet" : "no name"})`;
  }

  /**
   * A short mention by id ("carried by ...", "You follow ..."): "#7 AURORA BREEZE" if known, its own
   * name for them, else a stranger's description if in view, else `fallback`.
   */
  ref(id: number, fallback = "someone"): string {
    const p = this.w.players.get(id);
    if (!this.acq || this.acq.knowsTruly(this.w, id)) {
      const n = this.nameOf(p ?? { id });
      return `#${id}${n ? ` ${n}` : ""}`;
    }
    const own = this.acq.names.get(id);
    if (own) return `#${id} ${own.name} (as you know ${pronoun(p?.female ?? null)})`;
    return p ? this.describe(p) : fallback;
  }

  /**
   * Whose body a fresh grave is: "your mother LIRA TIDEWICK", "AURORA WILLOWHOLLOW [same family]",
   * "LIRA (as you knew her)", or a stranger, "a woman, 60, with a yellow tulip [other family]".
   * `rel` as the observation words relations ("your mother", "other family"), or null.
   */
  deadLabel(d: DeadPerson, rel: string | null): string {
    const before = rel?.startsWith("your ") ? `${rel} ` : "";
    const after = rel && !before ? ` [${rel}]` : "";
    const sex = sexWord(d.female, Math.max(0, d.age));
    const age = d.age >= 0 ? `, ${ageText(d.age)}` : "";
    if (!this.acq || this.acq.knowsTruly(this.w, d.id, d)) {
      const name = d.name ?? this.w.names.get(d.id) ?? null;
      return `${before}${name ?? `someone with no name (${sex}${age})`}${after}`;
    }
    const own = this.acq.names.get(d.id);
    if (own) return `${before}${own.name} (as you knew ${pronoun(d.female)})${after}`;
    const f = d.flower ?? this.flower(d.id);
    return `${withArticle(sex)}${age}${f ? `, with ${withArticle(f)}` : ""}${after}`;
  }

  /** "[this named #7]" in a heard line: the id only for someone this character knows */
  tags(text: string): string {
    return text.replace(/\[this named #(\d+)\]/g, (m, n: string) => (this.known(Number(n)) ? m : `[this named ${this.ref(Number(n))}]`));
  }

  /** visible people this character doesn't know truly (strangers, and those it named itself) */
  strangers(): Player[] {
    if (!this.acq) return [];
    return [...this.w.players.values()].filter((p) => p.id !== this.w.selfId && !this.acq!.knowsTruly(this.w, p.id));
  }
}

/** words that read as a name in "... is X" but are not names (kept conservative: no match = nothing recorded) */
const NOT_NAMES = new Set(
  (
    "I ME MY MINE YOU YOUR YOURS HE HIM HIS SHE HER HERS IT ITS WE US OUR THEY THEM THEIR THE A AN AND OR BUT NOT NO YES OK OKAY " +
    "HERE THERE NEAR FAR AWAY GONE BACK HOME LOST ALONE SAFE DANGER DANGEROUS HOSTILE FRIENDLY KIND NICE MEAN BAD GOOD GREAT " +
    "HUNGRY STARVING FED FULL DEAD DYING SICK WOUNDED HURT COLD HOT WARM TIRED ASLEEP OLD YOUNG PREGNANT NAKED BUSY HELPFUL ANGRY " +
    "MOTHER MOM MOMMY MAMA FATHER DAD SISTER BROTHER DAUGHTER SON BABY CHILD KID FAMILY FRIEND ENEMY LEADER EVE STRANGER " +
    "WOMAN MAN GIRL BOY LADY LORD KING QUEEN PERSON SOMEONE NOBODY UNKNOWN UNNAMED NAMELESS NAMED CALLED " +
    "CARRYING HOLDING WORKING COMING LEAVING WAITING FOLLOWING FOLLOWER TRUSTED NEW OTHER SAME ONE TWO THREE " +
    "RED BLUE YELLOW WHITE PINK PURPLE ORANGE GREEN BLACK VIOLET ROSE DAISY LILY TULIP FLOWER " +
    "IN ON AT OF FROM WITH WITHOUT TO FOR BY SO TOO ALSO STILL NOW THEN"
  ).split(" "),
);

/** one name word: ALLCAPS or Capitalised letters, 2-12 long */
const NAME_WORD = /^(?:[A-Z][A-Z'-]{1,11}|[A-Z][a-z'-]{1,11})$/;

/** the name after "is", "is called", "name is"...: one or two name words, then the end or punctuation */
function nameIn(text: string): string | null {
  const trig = /\b(?:name is|is called|is named|called|named|is)\s+/gi;
  let found: string | null = null;
  for (let m = trig.exec(text); m; m = trig.exec(text)) {
    const rest = text.slice(m.index + m[0].length);
    const n = /^([A-Za-z'-]+)(?:\s+([A-Za-z'-]+))?\s*(?=$|[.,;!?)"])/.exec(rest) ?? /^([A-Za-z'-]+)\s*(?=$|[.,;!?)"])/.exec(rest);
    if (!n) continue;
    const words = [n[1], n[2]].filter((x): x is string => !!x);
    if (!words.every((x) => NAME_WORD.test(x) && !NOT_NAMES.has(x.toUpperCase()))) continue;
    found = words.join(" ").toUpperCase();
  }
  return found;
}

/**
 * A name the character states for a visible stranger in its "remember" text
 * ("the woman with the red rose is LIRA", "the man at (-182, 44) is called
 * ASH", "red rose woman's name is LIRA TIDEWICK"): a name (one or two
 * capitalised or all-caps words after "is" / "is called" / "name is"...) and a
 * reference that fits exactly one visible stranger: their flower or their
 * position (within 1 tile), optionally narrowed by sex or age words. Anything
 * else: null (nothing is recorded).
 */
export function rememberedName(text: string, view: PeopleView): { id: number; name: string; who: string } | null {
  const name = nameIn(text);
  if (!name) return null;
  const lower = text.toLowerCase();
  let cands = view.strangers();
  if (!cands.length) return null;
  const w = view.w;
  // reference: a flower someone in view wears, and/or coordinates
  const byFlower = cands.filter((p) => {
    const f = view.flowerOf?.(p.id);
    return !!f && lower.includes(f.toLowerCase());
  });
  const coords = [...text.matchAll(/(-?\d{1,6})\s*,\s*(-?\d{1,6})/g)].map((m) => [Number(m[1]), Number(m[2])] as [number, number]);
  if (!byFlower.length && !coords.length) return null;
  if (byFlower.length) cands = byFlower;
  if (coords.length) {
    cands = cands.filter((p) => {
      const [x, y] = w.posOf(p);
      return coords.some(([cx, cy]) => Math.max(Math.abs(cx - x), Math.abs(cy - y)) <= 1);
    });
  }
  // sex and age words narrow it
  const female = /\b(woman|lady|girl|female|she|her)\b/i.test(text);
  const male = /\b(man|boy|male|he|him|his)\b/i.test(text);
  if (female !== male) cands = cands.filter((p) => p.female === female);
  const stage = /\bbab(y|ies)\b/i.test(text) ? "baby" : /\b(girl|boy|child|kid)\b/i.test(text) ? "child" : /\b(woman|man|lady)\b/i.test(text) ? "adult" : null;
  if (stage) {
    cands = cands.filter((p) => {
      const a = w.currentAge(p);
      return stage === "baby" ? a < 3 : stage === "child" ? a >= 3 && a < 14 : a >= 14;
    });
  }
  if (cands.length !== 1) return null;
  const p = cands[0];
  // the name is a word of the reference itself ("the Rose woman is ROSE")? not a name statement we can trust
  const f = view.flowerOf?.(p.id)?.toUpperCase() ?? "";
  if (name.split(" ").some((x) => f.split(" ").includes(x))) return null;
  return { id: p.id, name, who: view.shortDescribe(p) };
}

/** where an agent's known names are saved: LOG_DIR/research/known-names/<run>/<agent>.json */
export function knownNamesPath(logDir: string, runId: string, agentId: string): string {
  const safe = (s: string) => s.replace(/[^A-Za-z0-9_.-]/g, "_");
  return path.join(logDir, "research", "known-names", safe(runId), `${safe(agentId)}.json`);
}
