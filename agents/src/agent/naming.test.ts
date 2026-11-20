// Naming rules (no game): phrase matching as the server does it, name cleaning, numerals.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BABY_NAMING_PHRASES, FAMILY_NAMING_PHRASES, babyNameFrom, namingSayAfterStep, eveNameFrom, firstNameKey, freeFirstName, isNumeral, mergeSurnames, namingMissNote, namingRest, reviewSpeech, surnameOf,
} from "./naming.ts";

test("naming phrases match like server.cpp isNamingSay: at the start, a space after, first listed phrase wins", () => {
  assert.equal(namingRest("I AM EVE DAWN", FAMILY_NAMING_PHRASES), "DAWN");
  assert.equal(namingRest("I AM MIRA SOL", FAMILY_NAMING_PHRASES), "MIRA SOL");
  assert.equal(namingRest("I AM EVERHARD", FAMILY_NAMING_PHRASES), "EVERHARD", "'I AM EVE' needs a space after it");
  assert.equal(namingRest("MY NAME IS EVE  HOPE", FAMILY_NAMING_PHRASES), "HOPE");
  assert.equal(namingRest("HELLO, I AM MIRA", FAMILY_NAMING_PHRASES), null, "only at the start");
  assert.equal(namingRest(":I AM MIRA", FAMILY_NAMING_PHRASES), null, "reading written words aloud");
  assert.equal(namingRest("YOU ARE AURORA", BABY_NAMING_PHRASES), "AURORA");
  assert.equal(namingRest("YOUR NAME IS AURORA II", BABY_NAMING_PHRASES), "AURORA II");
  assert.equal(namingRest("YOU ARENT HUNGRY", BABY_NAMING_PHRASES), null);
});

test("names are cleaned like mtsCleanName: letters only, upper case; Eve with one word is EVE <FAMILY>", () => {
  assert.deepEqual(eveNameFrom("MIRA SOL, MOTHER OF ALL"), { first: "MIRA", family: "SOL" });
  assert.deepEqual(eveNameFrom("HOPE!"), { first: "EVE", family: "HOPE" });
  assert.deepEqual(eveNameFrom("MIRA II SOL"), { first: "MIRA", family: "SOL" }, "an Eve takes no numeral");
  assert.equal(eveNameFrom("!!"), null);
  assert.deepEqual(babyNameFrom("AURORA"), { first: "AURORA", numeral: null });
  assert.deepEqual(babyNameFrom("AURORA III, MY LOVE"), { first: "AURORA", numeral: "III" });
  assert.deepEqual(babyNameFrom("AURORA DAWN"), { first: "AURORA", numeral: null }, "the family name is not part of a first name");
});

test("surname = last word, ignoring a numeral; the first-name key keeps the numeral", () => {
  assert.equal(surnameOf("AURORA II DAWN"), "DAWN");
  assert.equal(surnameOf("MIRA SOL"), "SOL");
  assert.equal(surnameOf("AURORA"), null);
  assert.equal(surnameOf("AURORA II"), null, "named before the family had a name");
  assert.equal(surnameOf(null), null);
  assert.equal(firstNameKey("AURORA II DAWN"), "AURORA II");
  assert.equal(firstNameKey("AURORA DAWN"), "AURORA");
  assert.equal(firstNameKey("EVE DAWN"), "EVE");
  assert.ok(isNumeral("II") && isNumeral("x") && isNumeral("IX"));
  assert.ok(!isNumeral("I") && !isNumeral("XI") && !isNumeral("IVY") && !isNumeral("DAWN"));
});

test("next free numeral: II..X, null when all are used", () => {
  assert.equal(freeFirstName("AURORA", null, new Set()), "AURORA");
  assert.equal(freeFirstName("AURORA", null, new Set(["AURORA"])), "AURORA II");
  assert.equal(freeFirstName("AURORA", null, new Set(["AURORA", "AURORA II", "AURORA III"])), "AURORA IV");
  assert.equal(freeFirstName("AURORA", "II", new Set(["AURORA"])), "AURORA II", "an unused numeral the model chose is kept");
  const all = new Set(["AURORA", ...["II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"].map((n) => `AURORA ${n}`)]);
  assert.equal(freeFirstName("AURORA", null, all), null);
});

test("reviewSpeech: only an unnamed Eve's family naming and a mother naming her unnamed baby are touched", () => {
  const ctx = { unnamedEve: true, unnamedBaby: null, takenSurnames: ["DAWN"], familyFirstNames: new Set<string>() };
  assert.equal(reviewSpeech("I AM AURORA DAWN", ctx).ok, false);
  assert.equal(reviewSpeech("i'm eve dawn", ctx).ok, false);
  assert.deepEqual(reviewSpeech("I AM AURORA DUSK", ctx), { ok: true, say: "I AM AURORA DUSK" });
  assert.deepEqual(reviewSpeech("WE ARE THE DAWN", ctx), { ok: true, say: "WE ARE THE DAWN" });
  assert.equal(reviewSpeech("I AM AURORA DAWN", { ...ctx, unnamedEve: false }).ok, true, "already named: the server ignores it");
  const mom = { unnamedEve: false, unnamedBaby: { female: false }, takenSurnames: [], familyFirstNames: new Set(["ODIN"]) };
  assert.deepEqual(reviewSpeech("YOU ARE ODIN", mom), { ok: true, say: "YOU ARE ODIN II", note: "named him ODIN II; ODIN was taken in your family" });
  assert.deepEqual(reviewSpeech("YOU ARE ODIN", { ...mom, unnamedBaby: null }), { ok: true, say: "YOU ARE ODIN" }, "no baby in her arms");
});

test("mergeSurnames: order kept, upper case, no duplicates or blanks", () => {
  assert.deepEqual(mergeSurnames(["DAWN", "sol"], [null, "SOL", "HOPE", undefined]), ["DAWN", "SOL", "HOPE"]);
});

test("namingSayAfterStep: a baby naming line waits for the reply's first pick_up_baby", () => {
  const steps = [{ type: "drop" }, { type: "pick_up_baby" }, { type: "go" }];
  assert.equal(namingSayAfterStep("you are aurora", steps, false), 1);
  assert.equal(namingSayAfterStep("YOU ARE AURORA", steps, true), -1, "already holding someone");
  assert.equal(namingSayAfterStep("I AM LUNA VALLEY", steps, false), -1, "not a baby naming line");
  assert.equal(namingSayAfterStep("YOU ARE AURORA", [{ type: "go" }], false), -1, "no pickup in the reply");
});

test("namingMissNote: a baby-naming line that can reach nobody says so; holding a baby, a reachable nameless person or other speech says nothing", () => {
  const far = [{ pos: [80, 0] as [number, number], age: 0.1, named: false }];
  assert.match(namingMissNote("YOU ARE DAISY", false, [0, 0], far) ?? "", /^nobody was named/);
  assert.equal(namingMissNote("YOU ARE DAISY", true, [0, 0], far), null, "holding the baby: the server names it");
  assert.equal(namingMissNote("YOU ARE DAISY", false, [0, 0], [{ pos: [2, 0], age: 0.1, named: false }]), null, "baby within 3");
  assert.equal(namingMissNote("YOU ARE DAISY", false, [0, 0], [{ pos: [15, 0], age: 9, named: false }]), null, "nameless child within 20");
  assert.match(namingMissNote("YOU ARE DAISY", false, [0, 0], [{ pos: [2, 0], age: 0.1, named: true }]) ?? "", /^nobody/, "already named");
  assert.equal(namingMissNote("BRING THE STONE", false, [0, 0], far), null);
});
