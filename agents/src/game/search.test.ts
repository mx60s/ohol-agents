// The client's hint search ("/fire" in chat -> "MAKING: FIRE"), against the real game data.
import { test } from "node:test";
import assert from "node:assert/strict";
import { GameData } from "./gameData.ts";
import { matchObjects, search, searchSection, searchSummary, stepLine, walkBack, SEARCH_SHOWN } from "./search.ts";

const gd = new GameData();
const id = (n: string) => gd.idByName(n)!;

test("fire: steps first step first, each step's ingredients found in the wild or made by an earlier step", () => {
  const r = search(gd, "fire");
  assert.equal(r.kind, "steps");
  if (r.kind !== "steps") return;
  assert.deepEqual(r.goals.map((g) => gd.name(g)), ["Fire"]);
  assert.match(searchSummary(gd, r), /^MAKING FIRE: \d+ steps \(see SEARCH\)$/);
  assert.match(r.steps.at(-1)!, /: .*it becomes Fire$/);
  assert.ok(r.steps.includes("- Sharp Stone on Straight Branch: it becomes Long Straight Shaft"), r.steps.join("\n"));
  assert.ok(r.steps.includes("- bare hands on Milkweed: you get Milkweed Stalk, it becomes Milkweed Debris"));
  assert.ok(r.steps.includes("- Smoldering Tinder turns into Burning Tinder by itself"));
  assert.ok(r.steps.includes("- Milkweed Stalk on another Milkweed Stalk: it becomes Thread"));
  // dependency order: by depth of what each step makes
  const chosen = walkBack(gd, r.goals);
  // a step makes its newActor and its newTarget (one step can serve two frontier objects, as in the client)
  const made = new Map(chosen.flatMap((c) => [[c.t.newActor, c], [c.t.newTarget, c]] as const).filter(([x]) => x > 0));
  const at = (c: { t: Parameters<typeof stepLine>[1] }) => r.steps.indexOf(stepLine(gd, c.t));
  for (const c of chosen)
    for (const ing of [c.t.actor, c.t.target]) {
      const dep = made.get(ing);
      if (dep === c) continue; // a tool it keeps (Stone on Big Hard Rock)
      if (dep) assert.ok(at(dep) < at(c), `${stepLine(gd, dep.t)} before ${stepLine(gd, c.t)}`);
      else if (ing > 0) assert.equal(gd.depth(ing), 0, `${gd.name(ing)} is natural`);
    }
  // no notes, no use counts, no coordinates or "in view"
  for (const s of r.steps) assert.doesNotMatch(s, /#|\d+\/\d+ left|\(-?\d+, ?-?\d+\)|in view/, s);
});

test("the walk mirrors the client: no last-use or dummy transitions, ingredients shallower than the product", () => {
  for (const q of ["fire", "Reed Skirt", "basket", "knife", "berry"]) {
    const goals = matchObjects(gd, q);
    for (const { t, makes } of walkBack(gd, goals)) {
      assert.ok(!t.lastUseActor && !t.lastUseTarget, q);
      for (const x of [t.actor, t.target]) if (x > 0) assert.ok(!gd.get(x)!.parent, `${q}: ${gd.name(x)} is a dummy`);
      assert.ok(t.newActor === makes || t.newTarget === makes);
      if (t.actor > 0) assert.ok(gd.depth(t.actor) < gd.depth(makes));
      if (t.target > 0) assert.ok(gd.depth(t.target) < gd.depth(makes));
    }
  }
});

test("matching: whole words, case-insensitive; the shallowest matches; an exact full name wins", () => {
  // "skirt": of the whole-word matches only the shallowest (findObjectsMatchingWords), here just the Reed Skirt
  const skirt = search(gd, "skirt");
  assert.equal(skirt.kind, "steps");
  assert.equal(searchSummary(gd, skirt), `MAKING SKIRT (Reed Skirt): ${(skirt as { steps: string[] }).steps.length} steps (see SEARCH)`);
  const reed = search(gd, "reed  SKIRT");
  assert.equal(reed.kind, "steps");
  assert.match(searchSummary(gd, reed), /^MAKING REED SKIRT: \d+ steps/);
  assert.match((reed as { steps: string[] }).steps.at(-1)!, /it becomes Reed Skirt$/);
  // a whole word only: "kirt" is no word
  assert.equal(search(gd, "kirt").kind, "none");
  assert.equal(searchSummary(gd, search(gd, "clothes")), 'nothing is called "clothes"');
  // 2-9 different names: listed, no steps
  const hat = search(gd, "hat");
  assert.equal(hat.kind, "several");
  assert.match(searchSummary(gd, hat), /^"hat" matches: .*Straw Hat.*; search one by its full name$/);
  assert.equal(searchSection(hat), null);
  // 10 or more: too many, up to 12 names
  const tree = search(gd, "tree");
  assert.equal(tree.kind, "tooMany");
  assert.match(searchSummary(gd, tree), /^too many things match "tree" \(\d+\); for example: Juniper Tree, /);
  assert.ok((tree as { names: string[] }).names.length <= 12);
  // dummies are not searchable: one Wild Gooseberry Bush, not one per use count
  assert.deepEqual(matchObjects(gd, "Wild Gooseberry Bush"), [id("Wild Gooseberry Bush")]);
});

test("ember: the shallowest match (Ember Shaft), named in the summary", () => {
  const r = search(gd, "ember");
  assert.match(searchSummary(gd, r), /^MAKING EMBER \(Ember Shaft\): \d+ steps \(see SEARCH\)$/);
});

test("natural things and things nothing makes", () => {
  assert.equal(searchSummary(gd, search(gd, "Milkweed")), "MAKING MILKWEED: Milkweed is found in the wild; no steps");
  const never = [...gd.objects.values()].find((o) => !o.parent && !o.person && !o.name.startsWith("@") && !Number.isFinite(gd.depth(o.id)) && matchObjects(gd, o.name.split("#")[0]).length === 1)!;
  const q = never.name.split("#")[0].trim();
  const r = search(gd, q);
  assert.equal(r.kind, "unmakeable", q);
  assert.match(searchSummary(gd, r), /can't be made/);
});

test("the SEARCH section: at most 40 step lines, then how many more", () => {
  const r = search(gd, "knife");
  assert.equal(r.kind, "steps");
  const steps = (r as { steps: string[] }).steps;
  assert.ok(steps.length > SEARCH_SHOWN, `${steps.length}`);
  const s = searchSection(r)!;
  assert.equal(s.title, "MAKING KNIFE");
  assert.equal(s.lines.length, SEARCH_SHOWN + 1);
  assert.equal(s.lines.at(-1), `... and ${steps.length - SEARCH_SHOWN} more steps`);
  assert.deepEqual(s.lines.slice(0, SEARCH_SHOWN), steps.slice(0, SEARCH_SHOWN));
});
