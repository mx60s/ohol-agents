// Demo/test page for the OHOL art renderer: viewer/ohol-demo.html
import {
  FEMALE_POOL,
  FLOWER_COLORS,
  FLOWER_SHAPES,
  flowerLabel,
  HAIR_COLOR_PARAMS,
  MALE_HAIR_POOL,
  SPAWNABLE_PEOPLE,
  appearanceFor,
  drawGround,
  drawObject,
  drawPerson,
  getOholAssets,
  hairColorForTraits,
  loadOholAssets,
  onOholSpriteLoaded,
  preloadObject,
  preloadPerson,
} from "./ohol/index.ts";
import type { Appearance, PersonSpec } from "./ohol/index.ts";

const DIMS = ["openness", "conscientiousness", "extraversion", "agreeableness", "neuroticism"];
const BG = "#ebe1c8";
const SCALE = 0.75;

function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** mock Big Five: N(0,1) clipped at +-2.5 */
function mockTraits(seed: number): Record<string, number> {
  const r = mulberry(seed);
  const out: Record<string, number> = {};
  for (const d of DIMS) {
    const g = Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
    out[d] = Math.max(-2.5, Math.min(2.5, Math.round(g * 100) / 100));
  }
  return out;
}

interface Figure {
  spec: PersonSpec;
  x: number;
  label?: string;
  sub?: string;
  swatch?: string;
}
interface Item {
  id: number;
  x: number;
  label: string;
}

const sections: { title: string; note?: string; w: number; h: number; figures: Figure[]; items?: Item[]; ground?: number; scale?: number }[] = [];

function section(title: string, note: string, figures: Figure[], opts: { items?: Item[]; ground?: number; h?: number; scale?: number } = {}) {
  const w = Math.max(...figures.map((f) => f.x), ...(opts.items ?? []).map((i) => i.x), 0) + 90;
  sections.push({ title, note, w, h: opts.h ?? 210, figures, items: opts.items, ground: opts.ground, scale: opts.scale });
}

/**
 * ?donors=<recipientId>[,<colour hex>[,<face donor id>]]: every same-sex hairstyle donor, at ages 2..60, drawn as the
 * game draws the donor (left of each pair) and grafted onto the recipient with a tint (right).
 */
function buildDonorGrid(recipient: number, color: string, faceDonor?: number) {
  const m = getOholAssets()!.manifest;
  const female = !m.objects[recipient]?.male;
  const pool = female ? FEMALE_POOL : MALE_HAIR_POOL;
  const ages = [2, 10, 15, 25, 45, 60];
  for (const d of pool) {
    section(
      `${m.objects[d.id].n} hair${faceDonor ? ` + ${m.objects[faceDonor].n} face` : ""} -> ${m.objects[recipient].n}`,
      "",
      ages.flatMap((age, i) => [
        { spec: { displayId: d.id, age }, x: 50 + i * 190, label: `age ${age}` },
        {
          spec: { displayId: recipient, age, appearance: { hairDonorId: d.id, faceDonorId: faceDonor ?? recipient, hairColor: `#${color}`, lookSlot: -1 } },
          x: 120 + i * 190,
        },
      ]),
      { h: 250, scale: 1 },
    );
  }
}

/** Per-person flowers: one family of 6 siblings, age progression, hairstyles, the whole catalogue. */
function buildFlowers() {
  const m = getOholAssets()!.manifest;
  const nameOf = (id: number) => m.objects[id]?.n ?? String(id);
  // one family: 6 living siblings, same lineage (same hairstyle + face), traits inherited with small mutations
  const lin = "demo:11";
  const sibs = ["demo:12", "demo:13", "demo:14", "demo:15", "demo:16", "demo:17"];
  const bodies: [number, boolean][] = [[19, true], [347, false], [19, true], [347, false], [19, true], [347, false]];
  const mother = mockTraits(42);
  const r = mulberry(7);
  const sib = (k: number) => {
    const traits: Record<string, number> = {};
    for (const d of DIMS) traits[d] = Math.round((mother[d] + (r() - 0.5) * 0.4) * 100) / 100;
    const [displayId, female] = bodies[k];
    return appearanceFor({ displayId, female, lineageId: lin, traits, traitDims: DIMS, lifeId: sibs[k], livingFamilyLifeIds: sibs });
  };
  const fam = sibs.map((_, k) => sib(k));
  section(
    "Flowers: one family of 6 living siblings",
    "Same lineage hairstyle + face, near-identical hair colours; each wears a different flower (shape and colour).",
    fam.map((ap, k) => ({
      spec: { displayId: bodies[k][0], age: [24, 22, 19, 17, 13, 9][k], facingLeft: k % 2 === 1, appearance: ap },
      x: 70 + k * 130,
      label: flowerLabel(ap.flower!.shape, ap.flower!.color),
    })),
    { h: 230, scale: 0.9 },
  );
  // age progression, both facings, female and male
  const ages = [0.5, 2, 5, 10, 15, 25, 45, 60];
  for (const [displayId, female, lifeId] of [[19, true, "demo:21"], [347, false, "demo:22"]] as const) {
    const ap = appearanceFor({ displayId, female, lineageId: female ? 102 : 104, traits: mockTraits(female ? 3 : 4), traitDims: DIMS, lifeId });
    section(
      `Flowers by age (${nameOf(displayId)}): ${ages.join(", ")}; facing right / left`,
      "",
      ages.flatMap((age, i) => [
        { spec: { displayId, age, appearance: ap }, x: 50 + i * 150, label: `age ${age}` },
        { spec: { displayId, age, facingLeft: true, appearance: ap }, x: 110 + i * 150 },
      ]),
      { h: 230, scale: 0.9 },
    );
  }
  // every hairstyle (female + male pools), one flower each, plus a hat
  const fem = FEMALE_POOL.map((p, i) => {
    const ap = appearanceFor({ displayId: p.id, female: true, lineageId: 300 + i, traits: mockTraits(60 + i), traitDims: DIMS, lifeId: `demo:${300 + i}` });
    return { spec: { displayId: p.id, age: 30, facingLeft: i % 2 === 1, appearance: { ...ap, hairDonorId: p.id } }, x: 60 + i * 110, label: nameOf(p.id).split(" ")[0] };
  });
  section("Flowers on every female hairstyle (age 30)", "", fem, { h: 230, scale: 0.9 });
  const mal = MALE_HAIR_POOL.map((p, i) => {
    const ap = appearanceFor({ displayId: p.id, female: false, lineageId: 400 + i, traits: mockTraits(80 + i), traitDims: DIMS, lifeId: `demo:${400 + i}` });
    return { spec: { displayId: p.id, age: 30, facingLeft: i % 2 === 0, appearance: { ...ap, hairDonorId: p.id } }, x: 60 + i * 110, label: nameOf(p.id).split(" ")[0] };
  });
  mal.push({
    spec: { displayId: 347, age: 30, facingLeft: false, appearance: appearanceFor({ displayId: 347, female: false, lineageId: 401, traits: mockTraits(9), traitDims: DIMS, lifeId: "demo:499" }), clothing: { hat: 1117 } } as never,
    x: 60 + mal.length * 110,
    label: "straw hat",
  });
  section("Flowers on every male hairstyle (age 30)", "", mal, { h: 230, scale: 0.9 });
  // the catalogue: every shape in every colour, on a woman's head at portrait scale
  FLOWER_SHAPES.forEach((s, si) => {
    section(
      si === 0 ? `Catalogue: ${FLOWER_SHAPES.length} shapes x ${FLOWER_COLORS.length} colours (${FLOWER_COLORS.map((c) => `${c.name} ${c.hex}`).join(", ")})` : "",
      "",
      FLOWER_COLORS.map((c, ci) => ({
        spec: { displayId: 19, age: 30, appearance: { ...appearanceFor({ displayId: 19, female: true, lineageId: 101, traits: mockTraits(1), traitDims: DIMS }), flower: { shape: s.id, color: c.id, label: "" } } },
        x: 60 + ci * 90,
        label: si === 0 || ci === 0 ? `${ci === 0 ? s.name : ""}` : "",
      })),
      { h: 230, scale: 0.9 },
    );
  });
}

function build() {
  const m = getOholAssets()!.manifest;
  const nameOf = (id: number) => m.objects[id]?.n ?? String(id);

  // 1. all 22 spawnable people, adults, both directions
  section(
    "All 22 spawnable people, age 30 (left: facing right, right: facing left)",
    "Unmodified game look (no agent appearance). Genital and pubic-hair sprites 595-600 are never drawn.",
    SPAWNABLE_PEOPLE.flatMap((p, i) => [
      { spec: { displayId: p.id, age: 30 }, x: 50 + i * 130, label: nameOf(p.id) },
      { spec: { displayId: p.id, age: 30, facingLeft: true }, x: 112 + i * 130 },
    ]),
  );

  // 2. ages
  const ages = [0, 2, 5, 10, 15, 25, 45, 60];
  const agentLook = appearanceFor({ displayId: 347, female: false, lineageId: 4, traits: mockTraits(7), traitDims: DIMS });
  section(
    "Ages 0, 2, 5, 10, 15, 25, 45, 60",
    "Top: Female001 as the game draws her. Bottom: Male002 with an agent appearance (lineage 4; hair colour from traits; greys with age).",
    [
      ...ages.map((a, i) => ({ spec: { displayId: 19, age: a, facingLeft: i % 2 === 1 }, x: 60 + i * 120, label: `age ${a}` })),
      ...ages.map((a, i) => ({
        spec: { displayId: 347, age: a, facingLeft: i % 2 === 0, appearance: agentLook },
        x: 60 + (ages.length + i) * 120 + 40,
        label: `age ${a}`,
      })),
    ],
  );

  // 3. lineages x trait vectors
  const lineages = [101, 102, 103, 104, 105, 106];
  const bodies: [number, boolean][] = [
    [19, true],
    [354, false],
    [2404, true],
    [3080, false],
    [1009, true],
    [3078, false],
  ];
  lineages.forEach((lin, li) => {
    const figs: Figure[] = [];
    for (let k = 0; k < 3; k++) {
      const traits = mockTraits(lin * 10 + k);
      for (let s = 0; s < 2; s++) {
        const [displayId, female] = bodies[(li + k * 2 + s) % bodies.length];
        const ap: Appearance = appearanceFor({ displayId, female, lineageId: lin, traits, traitDims: DIMS, livingLineageIds: lineages });
        figs.push({
          spec: { displayId, age: 28, facingLeft: (k + s) % 2 === 1, appearance: ap },
          x: 60 + (k * 2 + s) * 100 + k * 60,
          label: s === 0 ? DIMS.map((d) => `${d[0].toUpperCase()}${traits[d] >= 0 ? "+" : ""}${traits[d].toFixed(1)}`).join(" ") : "",
          sub: s === 0 ? `${ap.hairColor}` : "",
          swatch: s === 0 ? ap.hairColor : undefined,
        });
      }
    }
    const ap0 = appearanceFor({ displayId: 19, female: true, lineageId: lin, traits: {}, traitDims: DIMS, livingLineageIds: lineages });
    const apM = appearanceFor({ displayId: 347, female: false, lineageId: lin, traits: {}, traitDims: DIMS, livingLineageIds: lineages });
    section(
      `Lineage ${lin}: hair donors F=${nameOf(ap0.hairDonorId)} M=${nameOf(apM.hairDonorId)}, face=${nameOf(ap0.faceDonorId)} (slot ${ap0.lookSlot})`,
      li === 0 ? "3 members x (one female + one male, different skins from displayId). Hair colour = personality; hairstyle + eyes/mouth = lineage." : "",
      figs,
      { h: 220 },
    );
  });

  // 4. clothing + held items
  const outfits: { spec: PersonSpec; label: string }[] = [
    { spec: { displayId: 19, age: 30, clothing: { hat: 199, tunic: 202, bottom: 200, frontShoe: 203, backShoe: 203 } }, label: "rabbit fur set" },
    { spec: { displayId: 347, age: 30, facingLeft: true, clothing: { hat: 1117, tunic: 585, bottom: 2881, frontShoe: 586, backShoe: 586, backpack: 198 } }, label: "straw hat, sweater, backpack" },
    { spec: { displayId: 2404, age: 30, clothing: { tunic: 712, bottom: 2916, frontShoe: 766, backShoe: 766 }, heldObjectId: 34 }, label: "sealskin coat, sharp stone" },
    { spec: { displayId: 3080, age: 30, facingLeft: true, clothing: { backpack: 2915, bottom: 128 }, heldObjectId: 64 }, label: "red cloak, reed skirt, branch" },
    { spec: { displayId: 1628, age: 50, clothing: { hat: 199, tunic: 725, bottom: 2927 }, heldObjectId: 31 }, label: "age 50, gooseberry" },
    { spec: { displayId: 1010, age: 8, clothing: { tunic: 201 } }, label: "age 8, shawl" },
    {
      spec: {
        displayId: 2464,
        age: 25,
        facingLeft: true,
        clothing: { hat: 1117, bottom: 2880 },
        appearance: appearanceFor({ displayId: 2464, female: true, lineageId: 103, traits: mockTraits(5), traitDims: DIMS }),
      },
      label: "agent look + clothes",
    },
    { spec: { displayId: 19, age: 30, heldObjectId: 33 }, label: "stone" },
  ];
  section(
    "Clothing and held objects",
    "Bottom/tunic/backpack under the back arm, shoes on the feet, hat on the aged head (drawObjectAnim order).",
    outfits.map((o, i) => ({ spec: o.spec, x: 70 + i * 130, label: o.label })),
  );

  // 5. map objects on ground
  const items = [30, 5025, 5023, 33, 34, 32, 50, 100, 121, 153, 2452, 418, 291, 63, 136, 1092].filter((id) => m.objects[id] || m.dummies[id]);
  section(
    "Map objects on biome ground (incl. use dummies 5025/5023 = bush with 3 / 1 berries left)",
    "",
    [
      { spec: { displayId: 3079, age: 35, appearance: appearanceFor({ displayId: 3079, female: false, lineageId: 105, traits: mockTraits(3), traitDims: DIMS }) }, x: 60 },
      { spec: { displayId: 351, age: 3, facingLeft: true }, x: 150 },
    ],
    { items: items.map((id, i) => ({ id, x: 250 + i * 105, label: (m.objects[id]?.n ?? m.objects[m.dummies[id][0]].n + " (dummy)").split("#")[0] })), ground: 1, h: 230 },
  );
}

function hairLegend(container: HTMLElement) {
  const c = document.createElement("canvas");
  const n = DIMS.length;
  c.width = 120 * n + 260;
  c.height = 150;
  const g = c.getContext("2d")!;
  g.font = "12px sans-serif";
  g.fillStyle = "#333";
  g.fillText(`hairColorForTraits: dim i -> hue ${HAIR_COLOR_PARAMS.hueOffset} + 360*i/${n} (OKLCH), |sum| -> chroma, L=${HAIR_COLOR_PARAMS.lightness}`, 8, 14);
  DIMS.forEach((d, i) => {
    for (let k = 0; k < 5; k++) {
      const v = -2.5 + k * 1.25;
      const col = hairColorForTraits({ [d]: v }, DIMS);
      g.fillStyle = col;
      g.fillRect(8 + i * 120 + k * 22, 30, 20, 40);
    }
    g.fillStyle = "#333";
    g.fillText(d, 8 + i * 120, 86);
    g.fillText("-2.5 ... +2.5", 8 + i * 120, 100);
  });
  // random personalities
  for (let k = 0; k < 24; k++) {
    g.fillStyle = hairColorForTraits(mockTraits(1000 + k), DIMS);
    g.fillRect(8 + k * 22, 112, 20, 30);
  }
  g.fillStyle = "#333";
  g.fillText("24 random N(0,1) personalities", 8 + 24 * 22 + 8, 130);
  container.appendChild(c);
}

async function main() {
  const root = document.getElementById("root")!;
  await loadOholAssets();
  // ?one=<displayId>,<age>,<facingLeft 0|1>[,<scale>]: a single figure, for close inspection
  const one = new URLSearchParams(location.search).get("one");
  if (one) {
    const [id, age, left, sc] = one.split(",").map(Number);
    const q = new URLSearchParams(location.search);
    const spec: PersonSpec = { displayId: id, age, facingLeft: left === 1 };
    if (q.get("hair") || q.get("face"))
      spec.appearance = {
        hairDonorId: Number(q.get("hair") || id),
        faceDonorId: Number(q.get("face") || id),
        hairColor: `#${q.get("color") || "a0522d"}`,
        lookSlot: -1,
      };
    await preloadPerson(spec);
    const c = document.createElement("canvas");
    const scale = sc || 3;
    c.width = 160 * scale;
    c.height = 230 * scale;
    root.appendChild(c);
    const g = c.getContext("2d")!;
    g.fillStyle = BG;
    g.fillRect(0, 0, c.width, c.height);
    drawPerson(g, spec, c.width / 2, c.height - 20 * scale, scale);
    document.body.dataset.ready = "1";
    return;
  }
  const donors = new URLSearchParams(location.search).get("donors");
  if (donors) {
    const [rid, col, face] = donors.split(",");
    buildDonorGrid(Number(rid), col || "3a8fd0", face ? Number(face) : undefined);
  } else if (new URLSearchParams(location.search).has("flowers")) {
    buildFlowers();
  } else {
    buildFlowers();
    build();
    hairLegend(root);
  }
  const canvases: { c: HTMLCanvasElement; s: (typeof sections)[number] }[] = [];
  for (const s of sections) {
    const h = document.createElement("h3");
    h.textContent = s.title;
    root.appendChild(h);
    if (s.note) {
      const p = document.createElement("p");
      p.textContent = s.note;
      root.appendChild(p);
    }
    const c = document.createElement("canvas");
    c.width = s.w;
    c.height = s.h;
    root.appendChild(c);
    canvases.push({ c, s });
  }
  // wait for every sprite so the screenshot is complete
  await Promise.all(
    sections.flatMap((s) => [...s.figures.map((f) => preloadPerson(f.spec)), ...(s.items ?? []).map((i) => preloadObject(i.id))]),
  );
  const draw = () => {
    for (const { c, s } of canvases) {
      const g = c.getContext("2d")!;
      g.globalCompositeOperation = "source-over";
      g.fillStyle = BG;
      g.fillRect(0, 0, c.width, c.height);
      if (s.ground !== undefined) {
        const size = 96;
        for (let cx = 0; cx * size < c.width; cx++) for (let cy = 0; cy * size < c.height; cy++) drawGround(g, s.ground, cx, -cy, cx * size, cy * size, size);
      }
      const base = s.h - 40;
      for (const f of s.figures) drawPerson(g, f.spec, f.x, base, s.scale ?? SCALE);
      for (const it of s.items ?? []) drawObject(g, it.id, it.x, base - 10, SCALE);
      g.globalCompositeOperation = "source-over";
      g.font = "11px sans-serif";
      g.fillStyle = s.ground !== undefined ? "#fff" : "#333";
      for (const f of s.figures) {
        if (f.label) g.fillText(f.label, f.x - 40, s.h - 22);
        if (f.sub) g.fillText(f.sub, f.x - 40 + (f.swatch ? 16 : 0), s.h - 8);
        if (f.swatch) {
          g.fillStyle = f.swatch;
          g.fillRect(f.x - 40, s.h - 18, 12, 12);
          g.fillStyle = "#333";
        }
      }
      for (const it of s.items ?? []) g.fillText(it.label.slice(0, 16), it.x - 40, s.h - 8);
    }
    document.body.dataset.ready = "1";
  };
  draw();
  onOholSpriteLoaded(draw);
}

main().catch((e) => {
  document.body.textContent = String(e);
  document.body.dataset.ready = "error";
});
