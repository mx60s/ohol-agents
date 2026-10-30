// In-browser fake backend for developing the viewer without the agents
// service. Activated with VITE_API_URL=mock or a ?mock query param.
import type {
  MapCellTuple,
  MapResponse,
  PlayerView,
  RunEvent,
  RunEventKind,
  StateResponse,
} from "./api-types";

// ---------------------------------------------------------------------------
// Map generation (deterministic patch noise)

function hash2(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const OBJECT_NAMES: Record<number, string> = {
  301: "Gooseberry Bush#wild",
  302: "Maple Tree",
  303: "Juniper Tree",
  304: "Sharp Stone",
  305: "Big Hard Rock",
  306: "Flint",
  307: "Cactus",
  308: "Canada Goose Pond",
  309: "Wild Carrot",
  310: "Burdock",
  311: "Iron Ore",
  312: "Wild Rose",
};

function objectFor(biome: number, r: number): number {
  switch (biome) {
    case 0: // grassland
      if (r < 0.04) return 301;
      if (r < 0.07) return 302;
      if (r < 0.09) return 304;
      if (r < 0.1) return 305;
      if (r < 0.11) return 309;
      if (r < 0.12) return 310;
      return 0;
    case 1: // swamp
      if (r < 0.05) return 308;
      if (r < 0.07) return 305;
      return 0;
    case 2: // prairie
      if (r < 0.03) return 309;
      if (r < 0.06) return 310;
      return 0;
    case 3: // badlands
      if (r < 0.04) return 311;
      if (r < 0.07) return 306;
      if (r < 0.09) return 305;
      return 0;
    case 4: // tundra
      if (r < 0.02) return 303;
      if (r < 0.03) return 305;
      return 0;
    case 5: // desert
      if (r < 0.04) return 307;
      if (r < 0.06) return 306;
      return 0;
    case 6: // jungle
      if (r < 0.04) return 302;
      if (r < 0.06) return 312;
      return 0;
    default:
      return 0;
  }
}

function generateMap(): MapCellTuple[] {
  const cells: MapCellTuple[] = [];
  const R = 48;
  for (let y = -R; y <= R; y++) {
    for (let x = -R; x <= R; x++) {
      // patchy biome bands, sampled on a coarse grid
      const n = hash2(Math.floor(x / 9) + 500, Math.floor(y / 9) - 500);
      const biome = Math.min(6, Math.floor(n * 7));
      const objectId = objectFor(biome, hash2(x, y));
      // a little wooden-floor camp near the origin
      const floorId =
        Math.hypot(x, y) <= 6 && hash2(x + 1000, y - 1000) < 0.4 ? 7 : 0;
      cells.push([x, y, biome, floorId, objectId]);
    }
  }
  return cells;
}

// ---------------------------------------------------------------------------
// Fake civilization

const FIRST_NAMES = [
  "Ash", "Briar", "Clover", "Dune", "Elm", "Fern", "Gale", "Hazel", "Iris",
  "Jasper", "Kite", "Lark", "Maple", "Nettle", "Onyx", "Piper", "Quill",
  "Rowan", "Sage", "Thistle",
];

const SAYINGS = [
  "hello family", "i found berries", "follow me", "need food here",
  "so hungry", "making fire soon", "watch the baby", "i will get water",
  "bring a basket", "too cold here", "nice work", "stay close",
  "where is everyone", "planting carrots", "found iron", "careful, a bear",
  "i love you all", "carry me please",
];

const GOALS = [
  "gather food", "start a farm", "make a fire", "care for the babies",
  "explore to the north", "collect iron ore", "bake berry pies",
  "fetch water", "build a home",
];

const THOUGHTS = [
  "food is running low, i should find a berry bush",
  "the camp needs a fire before nightfall",
  "i can help mother with the harvest",
  "too far from home, heading back",
  "a basket would make this much faster",
  "we need more soil for the farm",
  "the new baby still needs a name",
  "i remember where the iron vein is",
];

const NARRATIONS = [
  "The settlement holds on. {a} works tirelessly while {b} dreams of an easier life, and generation {gen} is on the rise.",
  "Seasons turn over the little camp. {a} has become someone the others rely on, and the children watch and learn.",
  "Hunger is never far away. {a} ranges further each day in search of berries while {b} keeps the home fires burning.",
  "A quiet day. {n} souls now call this place home, and generation {gen} is growing up among the berry bushes.",
  "{a} spoke of the future today. The family endures, one small life at a time.",
  "Death has visited before and will visit again, but for now {a} and {b} carry the lineage forward.",
  "The babies of generation {gen} do not know how close the camp came to fading away. {a} remembers, and says nothing.",
];

const HOLDABLES: (string | null)[] = [
  "Sharp Stone", "Basket", "Gooseberry", "Carrot", "Fire Bow Drill",
  "Stone Hatchet", "Clay Bowl", "Rope", null,
];

const FOODS = ["Gooseberry", "Carrot", "Cooked Rabbit", "Berry Pie Slice"];

const CRAFTS: [string, string, string][] = [
  ["Sharp Stone", "Stone", "Big Hard Rock"],
  ["Fire Bow Drill", "Sharpened Stick", "Curved Branch"],
  ["Basket", "Reed Bundle", "Rope"],
  ["Stone Hatchet", "Sharp Stone", "Short Shaft"],
  ["Clay Bowl", "Wet Clay", "Kiln"],
];

function rand<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

interface MockAgent {
  slot: string;
  lifeIndex: number;
  status: "connecting" | "alive" | "dead" | "waiting";
  playerId: number | null;
  name: string | null;
  x: number;
  y: number;
  age: number;
  female: boolean;
  food: number;
  foodCapacity: number;
  heat: number;
  held: string | null;
  motherId: number | null;
  eveId: number | null;
  generation: number;
  goal: string | null;
  lastThought: string | null;
  lastAction: string | null;
  lastSaid: string | null;
  heading: number;
  respawnAt: number | null;
  moving: boolean;
}

class MockWorld {
  private startedAt = Date.now();
  private cells: MapCellTuple[] = generateMap();
  private agents: MockAgent[] = [];
  private nextPlayerId = 100;
  private seq = 0;
  private log: RunEvent[] = [];
  private listeners = new Set<(ev: RunEvent) => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private human = { id: 9001, x: 14, y: 9, heading: 0.5, moving: false };
  private totals = { births: 0, deaths: 0, llmCalls: 0, llmCostUsd: 0 };
  private lastNarrationAt = Date.now() - 26000; // first narration lands ~4s in
  /** mother slot -> baby slot, for babies currently carried */
  private carrying = new Map<string, string>();

  constructor() {
    // a01: founding Eve
    const eve = this.makeAgent("a01", null, 32);
    eve.x = 2;
    eve.y = -3;
    this.agents.push(eve);
    // her kids
    this.agents.push(this.makeAgent("a02", eve, 14));
    this.agents.push(this.makeAgent("a03", eve, 9));
    this.agents.push(this.makeAgent("a04", eve, 2));
    // a second family nearby
    const eve2 = this.makeAgent("a05", null, 40);
    eve2.x = 18;
    eve2.y = 12;
    this.agents.push(eve2);
    // a06: dead slot waiting to respawn
    const dead = this.makeAgent("a06", eve, 0);
    dead.status = "waiting";
    dead.playerId = null;
    dead.lifeIndex = 3;
    dead.respawnAt = Date.now() + 4000;
    this.agents.push(dead);

    // eve carries her youngest (a04) so the UI always shows a held baby
    const baby = this.agents.find((a) => a.slot === "a04");
    if (baby) {
      baby.x = eve.x;
      baby.y = eve.y;
      eve.held = `baby: ${baby.name}`;
      this.carrying.set(eve.slot, baby.slot);
    }

    this.totals.births = 6;
    this.totals.deaths = 2;
  }

  start(): void {
    if (this.timer) return;
    this.emit("system", null, null, null, "mock run started");
    for (const a of this.agents) {
      if (a.status === "alive") {
        this.emit(
          "birth",
          a.slot,
          a.playerId,
          a.name,
          a.motherId == null
            ? `${a.name} spawned as an Eve`
            : `${a.name} was born`,
          { playerId: a.playerId, motherId: a.motherId, eve: a.motherId == null },
        );
      }
    }
    this.timer = setInterval(() => this.tick(), 1000);
  }

  // ---- world interface used by MockSource ----

  state(): StateResponse {
    const now = Date.now();
    const alive = this.agents.filter((a) => a.status === "alive");
    const players: PlayerView[] = alive
      .filter((a) => a.playerId != null)
      .map((a) => ({
        id: a.playerId as number,
        x: a.x,
        y: a.y,
        age: a.age,
        female: a.female,
        name: a.name,
        held: a.held,
        agentId: a.slot,
        dying: a.age > 55 || a.food <= 1.5,
        moving: a.moving,
        displayId: 2000 + (a.playerId as number) * 3 + (a.female ? 0 : 100),
      }));
    players.push({
      id: this.human.id,
      x: this.human.x,
      y: this.human.y,
      age: 34,
      female: false,
      name: "Stranger",
      held: null,
      agentId: null,
      dying: false,
      moving: this.human.moving,
      displayId: 2401,
    });
    const families = new Set(alive.map((a) => a.eveId ?? a.playerId)).size;
    return {
      run: {
        id: "mock-run",
        startedAt: this.startedAt,
        model: "mock-llm-7b",
        memoryMode: "persistent",
        recipeHints: true,
        targetPopulation: 8,
        status: "running",
        haltReason: null,
        limits: { maxGeneration: 3, maxLives: 40, maxRuntimeMin: 90, maxCostUsd: 10 },
      },
      now,
      agents: this.agents.map((a) => ({
        agentId: a.slot,
        lifeIndex: a.lifeIndex,
        status: a.status,
        playerId: a.playerId,
        name: a.name,
        x: a.status === "alive" ? a.x : null,
        y: a.status === "alive" ? a.y : null,
        age: a.status === "alive" ? a.age : null,
        female: a.female,
        food: a.status === "alive" ? a.food : null,
        foodCapacity: a.foodCapacity,
        heat: a.status === "alive" ? a.heat : null,
        held: a.status === "alive" ? a.held : null,
        motherId: a.motherId,
        eveId: a.eveId,
        generation: a.generation,
        goal: a.goal,
        lastThought: a.lastThought,
        lastAction: a.lastAction,
        lastSaid: a.lastSaid,
      })),
      players,
      stats: {
        alive: alive.length,
        totalBirths: this.totals.births,
        totalDeaths: this.totals.deaths,
        maxGeneration: Math.max(1, ...this.agents.map((a) => a.generation)),
        families,
        llmCalls: this.totals.llmCalls,
        llmCostUsd: this.totals.llmCostUsd,
      },
    };
  }

  map(): MapResponse {
    return { cells: this.cells, names: OBJECT_NAMES };
  }

  eventsSince(since: number): RunEvent[] {
    return this.log.filter((e) => e.seq > since);
  }

  subscribe(cb: (ev: RunEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  // ---- internals ----

  private makeAgent(
    slot: string,
    mother: MockAgent | null,
    age: number,
  ): MockAgent {
    const playerId = this.nextPlayerId++;
    return {
      slot,
      lifeIndex: 1,
      status: "alive",
      playerId,
      name: rand(FIRST_NAMES),
      x: mother ? mother.x : Math.round((Math.random() - 0.5) * 16),
      y: mother ? mother.y : Math.round((Math.random() - 0.5) * 16),
      age,
      female: Math.random() < 0.5,
      food: 10,
      foodCapacity: 12,
      heat: 0.45 + Math.random() * 0.1,
      held: null,
      motherId: mother?.playerId ?? null,
      eveId: mother ? mother.eveId ?? mother.playerId : playerId,
      generation: mother ? mother.generation + 1 : 1,
      goal: rand(GOALS),
      lastThought: rand(THOUGHTS),
      lastAction: null,
      lastSaid: null,
      heading: Math.random() * Math.PI * 2,
      respawnAt: null,
      moving: false,
    };
  }

  private emit(
    kind: RunEventKind,
    agentId: string | null,
    playerId: number | null,
    name: string | null,
    text: string,
    data?: Record<string, unknown>,
  ): void {
    const ev: RunEvent = {
      seq: ++this.seq,
      t: Date.now(),
      kind,
      agentId,
      playerId,
      name,
      text,
      data,
    };
    this.log.push(ev);
    if (this.log.length > 500) this.log.splice(0, this.log.length - 500);
    for (const cb of this.listeners) cb(ev);
  }

  private kill(a: MockAgent, reason: string): void {
    const age = Math.floor(a.age);
    // a carried baby survives, left where its carrier fell
    if (this.carrying.delete(a.slot)) a.held = null;
    a.status = "dead";
    a.respawnAt = Date.now() + 4000 + Math.random() * 5000;
    this.totals.deaths += 1;
    this.emit(
      "death",
      a.slot,
      a.playerId,
      a.name,
      `${a.name ?? a.slot} died at ${age} (${reason})`,
      { playerId: a.playerId, age, reason },
    );
    a.playerId = null;
  }

  private respawn(a: MockAgent): void {
    const mothers = this.agents.filter(
      (m) =>
        m !== a && m.status === "alive" && m.female && m.age >= 14 && m.age <= 45,
    );
    const mother = mothers.length > 0 ? rand(mothers) : null;
    const playerId = this.nextPlayerId++;
    a.lifeIndex += 1;
    a.status = "alive";
    a.playerId = playerId;
    a.name = rand(FIRST_NAMES);
    a.female = Math.random() < 0.5;
    a.age = 0;
    a.food = 4;
    a.foodCapacity = 12;
    a.heat = 0.5;
    a.held = null;
    a.motherId = mother?.playerId ?? null;
    a.eveId = mother ? mother.eveId ?? mother.playerId : playerId;
    a.generation = mother ? mother.generation + 1 : 1;
    if (mother) {
      a.x = mother.x;
      a.y = mother.y;
    } else {
      a.x = Math.round((Math.random() - 0.5) * 20);
      a.y = Math.round((Math.random() - 0.5) * 20);
    }
    a.goal = null;
    a.lastThought = null;
    a.lastSaid = null;
    a.lastAction = null;
    a.respawnAt = null;
    a.moving = false;
    if (mother) {
      // the mother picks up her newborn and carries it around
      mother.held = `baby: ${a.name}`;
      this.carrying.set(mother.slot, a.slot);
    }
    this.totals.births += 1;
    this.emit(
      "birth",
      a.slot,
      playerId,
      a.name,
      mother
        ? `${a.name} born to ${mother.name ?? "unnamed"}`
        : `${a.name} spawned as an Eve`,
      { playerId, motherId: a.motherId, eve: mother == null },
    );
  }

  private tick(): void {
    const now = Date.now();
    for (const a of this.agents) {
      if (a.status === "alive") {
        a.age += 0.2;
        a.heat = clamp(a.heat + (Math.random() - 0.5) * 0.06, 0.2, 0.8);
        if (a.age >= 3) a.food = Math.max(0, a.food - 0.25);
        a.moving = false;

        // wander
        if (a.age >= 3 && Math.random() < 0.75) {
          a.heading += (Math.random() - 0.5) * 1.4;
          const nx = a.x + Math.round(Math.cos(a.heading));
          const ny = a.y + Math.round(Math.sin(a.heading));
          if (Math.hypot(nx, ny) > 44) {
            a.heading = Math.atan2(-a.y, -a.x) + (Math.random() - 0.5);
          } else {
            a.x = nx;
            a.y = ny;
            a.moving = true;
          }
        }

        const holdingBaby =
          a.held != null && a.held.toLowerCase().startsWith("baby");

        // eat when hungry
        if (a.age >= 3 && a.food > 0 && a.food < a.foodCapacity * 0.35) {
          a.food = a.foodCapacity;
          const food = rand(FOODS);
          a.lastAction = `eat ${food}`;
          this.emit("action", a.slot, a.playerId, a.name, `eats ${food}`, {
            command: "EAT",
          });
        }

        // ambient chatter (only nearby agents actually hear it)
        if (Math.random() < 0.1) {
          a.lastSaid = rand(SAYINGS);
          const heardBy = this.agents
            .filter(
              (o) =>
                o !== a &&
                o.status === "alive" &&
                Math.hypot(o.x - a.x, o.y - a.y) <= 10,
            )
            .map((o) => o.slot);
          this.emit("say", a.slot, a.playerId, a.name, a.lastSaid, {
            playerId: a.playerId,
            x: a.x,
            y: a.y,
            heardBy,
          });
        }

        // thinking costs money
        if (Math.random() < 0.08) {
          a.lastThought = rand(THOUGHTS);
          if (Math.random() < 0.4) a.goal = rand(GOALS);
          this.totals.llmCalls += 1;
          this.totals.llmCostUsd += 0.002;
          this.emit("thought", a.slot, a.playerId, a.name, a.lastThought);
        } else if (Math.random() < 0.25) {
          const calls = 1 + Math.floor(Math.random() * 3);
          this.totals.llmCalls += calls;
          this.totals.llmCostUsd += calls * 0.002;
        }

        // craft occasionally (not while carrying a baby)
        if (!holdingBaby && a.age >= 3 && Math.random() < 0.05) {
          const [made, from1, from2] = rand(CRAFTS);
          a.held = made;
          a.lastAction = `use ${from1} on ${from2}`;
          this.emit(
            "craft",
            a.slot,
            a.playerId,
            a.name,
            `made ${made} from ${from1} + ${from2}`,
            { actor: from1, target: from2, newActor: made, newTarget: 0 },
          );
        } else if (!holdingBaby && a.age >= 3 && Math.random() < 0.15) {
          const item = rand(HOLDABLES);
          a.held = item;
          const text = item ? `picks up ${item}` : "sets down items";
          a.lastAction = item ? `pick_up ${item}` : "drop items";
          this.emit("action", a.slot, a.playerId, a.name, text, {
            command: item ? "USE" : "DROP",
          });
        }

        // die of old age (or, theoretically, starvation)
        if (a.age >= 60 || a.food <= 0) {
          this.kill(a, a.age >= 60 ? "old age" : "starved");
        }
      } else if (a.respawnAt != null && now >= a.respawnAt) {
        this.respawn(a);
      }
    }

    // carried babies ride along with their carrier until they can walk
    for (const [motherSlot, babySlot] of [...this.carrying]) {
      const mother = this.agents.find((x) => x.slot === motherSlot);
      const baby = this.agents.find((x) => x.slot === babySlot);
      if (!mother || !baby || mother.status !== "alive" || baby.status !== "alive") {
        this.carrying.delete(motherSlot);
        continue;
      }
      if (baby.age >= 3) {
        mother.held = null;
        mother.lastAction = "drop baby";
        this.carrying.delete(motherSlot);
        this.emit(
          "action",
          mother.slot,
          mother.playerId,
          mother.name,
          `sets down ${baby.name ?? "the baby"}`,
          { command: "DROP" },
        );
        continue;
      }
      baby.x = mother.x;
      baby.y = mother.y;
      baby.moving = mother.moving;
      baby.food = Math.min(baby.foodCapacity, baby.food + 0.3); // nursing
    }

    // the omniscient narrator sums up the plot every ~30s
    if (now - this.lastNarrationAt >= 30000) {
      this.lastNarrationAt = now;
      this.emit("narration", null, null, null, this.narrate());
    }

    // the wandering human, just for color
    this.human.moving = false;
    if (Math.random() < 0.5) {
      this.human.heading += Math.random() - 0.5;
      const nx = this.human.x + Math.round(Math.cos(this.human.heading));
      const ny = this.human.y + Math.round(Math.sin(this.human.heading));
      if (Math.hypot(nx, ny) <= 44) {
        this.human.x = nx;
        this.human.y = ny;
        this.human.moving = true;
      }
    }
  }

  private narrate(): string {
    const alive = this.agents.filter((a) => a.status === "alive");
    const names = alive.map((a) => a.name ?? "an unnamed soul");
    const a = names.length > 0 ? rand(names) : "the camp";
    const others = names.filter((n) => n !== a);
    const b = others.length > 0 ? rand(others) : a;
    const gen = Math.max(1, ...this.agents.map((x) => x.generation));
    return rand(NARRATIONS)
      .split("{a}").join(a)
      .split("{b}").join(b)
      .split("{gen}").join(String(gen))
      .split("{n}").join(String(alive.length));
  }
}

/** Mock implementation of the viewer DataSource (structurally typed). */
export class MockSource {
  private world = new MockWorld();

  constructor() {
    this.world.start();
  }

  fetchState(): Promise<StateResponse> {
    return Promise.resolve(this.world.state());
  }

  fetchMap(): Promise<MapResponse> {
    return Promise.resolve(this.world.map());
  }

  fetchEvents(since: number): Promise<{ events: RunEvent[] }> {
    return Promise.resolve({ events: this.world.eventsSince(since) });
  }

  subscribe(onEvent: (ev: RunEvent) => void): () => void {
    return this.world.subscribe(onEvent);
  }
}
