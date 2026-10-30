// One agent slot. Each "life" = one TCP connection = one character from
// birth to death. The slot then logs in again and is born as someone new.

import { Connection } from "../protocol/connection.ts";
import { parseMessage } from "../protocol/messages.ts";
import { World } from "../game/world.ts";
import { Body } from "../game/body.ts";
import type { GameData } from "../game/gameData.ts";
import type { Config } from "../config.ts";
import type { EventLog } from "../events.ts";
import type { AgentView } from "../api-types.ts";
import { Llm, parseJsonReply, type ChatMessage } from "./llm.ts";
import { buildObservation } from "./observe.ts";
import { SYSTEM_PROMPT } from "./prompt.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Collects who heard each spoken line (see Population). */
export interface SpeechSink {
  spoke(speaker: Agent, text: string, x: number, y: number): void;
  heard(hearer: Agent, speakerPlayerId: number, text: string): void;
}

export interface Action {
  type: string;
  x?: number;
  y?: number;
  person?: number;
  text?: string;
  slot?: number;
  seconds?: number;
}

export class Agent {
  status: AgentView["status"] = "waiting";
  lifeIndex = 0;
  world: World | null = null;
  conn: Connection | null = null;
  body: Body | null = null;
  goal: string | null = null;
  lastThought: string | null = null;
  lastAction: string | null = null;
  lastSaid: string | null = null;
  notebook: string[] = [];
  pastLifeNotes: string[] = [];
  history: { t: number; action: string; result: string }[] = [];
  private wake: (() => void) | null = null;
  private lastReflexAt = 0;
  private stopped = false;

  constructor(
    readonly id: string,
    private cfg: Config,
    private gd: GameData,
    private llm: Llm,
    private log: EventLog,
    private speech?: SpeechSink,
  ) {}

  get email() {
    return `${this.cfg.runId}-${this.id}@mts.local`;
  }

  stop() {
    this.stopped = true;
    this.status = "waiting";
    this.conn?.close();
  }

  /** Runs lives forever. */
  async run() {
    while (!this.stopped) {
      try {
        await this.live();
      } catch (e) {
        this.log.emitEvent("system", { agentId: this.id, text: `life crashed: ${(e as Error).message}` });
        console.error(this.id, e);
      }
      this.status = "waiting";
      await sleep(5000);
    }
  }

  private nameOf(): string | null {
    return this.world?.self?.name ?? null;
  }

  /** emit an event attributed to this agent's current character */
  emit(kind: Parameters<EventLog["emitEvent"]>[0], text: string, data?: Record<string, unknown>) {
    this.ev(kind, text, data);
  }

  private ev(kind: Parameters<EventLog["emitEvent"]>[0], text: string, data?: Record<string, unknown>) {
    this.log.emitEvent(kind, { agentId: this.id, playerId: this.world?.selfId ?? null, name: this.nameOf(), text, data });
  }

  private async live() {
    this.status = "connecting";
    const gd = this.gd;
    const world = new World(gd, {
      onSelfDied: (reason, age) => {
        this.ev("death", `${this.nameOf() ?? this.id} died at age ${age.toFixed(1)} (${reason.replace("reason_", "")})`, { playerId: world.selfId, age, reason });
        this.poke();
      },
      onHeard: (h) => {
        if (h.speakerId === world.selfId) {
          // server echo of our own speech = what was actually said (age-truncated)
          this.lastSaid = h.text;
          this.speech?.spoke(this, h.text, h.x, h.y);
        } else {
          if (h.speakerId != null) this.speech?.heard(this, h.speakerId, h.text);
          this.poke();
        }
      },
      onPlayerAppeared: (p) => {
        // a newborn near us whose mother is us
        if (p.ancestors[0] === world.selfId) this.poke();
      },
    });
    const conn = new Connection({ host: this.cfg.oholHost, port: this.cfg.oholPort, email: this.email });
    conn.on("message", (raw) => {
      try {
        world.handle(parseMessage(raw));
      } catch (e) {
        console.error(this.id, "handle error", raw.type, e);
      }
    });
    conn.on("close", () => this.poke());
    conn.on("error", () => {});
    const res = await conn.connect();
    if (res !== "ACCEPTED") {
      conn.close();
      throw new Error(`login ${res}`);
    }
    this.world = world;
    this.conn = conn;
    this.body = new Body(conn, world, gd);

    // wait for our first PU
    for (let i = 0; i < 50 && !world.self; i++) await sleep(100);
    const me = world.self;
    if (!me) throw new Error("no self PU after login");
    await sleep(500); // let lineage/name messages land

    this.lifeIndex++;
    this.status = "alive";
    if (this.cfg.memoryMode === "persistent" && this.notebook.length) {
      this.pastLifeNotes.push(...this.notebook);
      this.pastLifeNotes = this.pastLifeNotes.slice(-30);
    }
    this.notebook = [];
    this.history = [];
    this.goal = null;
    this.lastThought = this.lastAction = this.lastSaid = null;
    const isEve = me.ancestors.length === 0;
    const age = world.currentAge(me);
    this.ev("birth", isEve ? `${this.id} appeared as an Eve (age ${age.toFixed(0)})` : `${this.id} was born to mother #${me.ancestors[0]}`, {
      playerId: me.id, motherId: me.ancestors[0] ?? null, eve: isEve, generation: me.ancestors.length + 1, lifeIndex: this.lifeIndex, x: me.x, y: me.y,
    });
    this.log.write("lives.jsonl", { t: Date.now(), agentId: this.id, lifeIndex: this.lifeIndex, playerId: me.id, eve: isEve, motherId: me.ancestors[0] ?? null, eveId: me.eveId, x: me.x, y: me.y });

    while (!this.stopped && !world.dead && !conn.closed) {
      const t0 = Date.now();
      await this.turn();
      const self = world.self;
      const interval = self && world.currentAge(self) < 2 ? this.cfg.babyDecisionIntervalMs : this.cfg.decisionIntervalMs;
      const wait = Math.max(0, interval - (Date.now() - t0));
      if (wait > 0) await this.sleepInterruptible(wait);
    }
    if (!world.dead && !this.stopped) this.ev("system", `${this.id} lost connection`);
    conn.close();
    this.status = "dead";
    await sleep(3000);
  }

  private poke() {
    this.wake?.();
  }

  private sleepInterruptible(ms: number) {
    return new Promise<void>((resolve) => {
      const t = setTimeout(done, ms);
      function done() {
        clearTimeout(t);
        resolve();
      }
      this.wake = () => {
        this.wake = null;
        done();
      };
    });
  }

  /** One observe -> decide -> act cycle. */
  private async turn() {
    const world = this.world!;
    const body = this.body!;
    body.syncForce();

    // reflex: starving and holding food -> eat, no LLM needed
    const me = world.self!;
    // reflex: about to starve -> grab the nearest hand-pickable food and eat
    // (puts a carried baby down and picks it back up). Logged as a reflex so
    // analysis can separate it from LLM decisions.
    // If there's no food in reach, fall through to the LLM so it can decide
    // to travel; and don't retry the reflex more than every 20s.
    if (world.food <= 2 && world.currentAge(me) >= 3 && world.food < world.foodCapacity && Date.now() - this.lastReflexAt > 20000) {
      this.lastReflexAt = Date.now();
      const r = await body.forage();
      this.record("forage (reflex: starving)", r);
      this.ev("action", `reflex forage -> ${r}`, { reflex: true });
      if (!r.startsWith("no food")) return;
    }

    if (this.llm.overBudget) {
      await this.sleepInterruptible(10000);
      return;
    }

    const obs = buildObservation(world, this.gd, {
      recipeHints: this.cfg.recipeHints,
      history: this.history,
      notebook: this.notebook,
      pastLifeNotes: this.pastLifeNotes,
      goal: this.goal,
      foodSources: body.foodSources(),
    });
    const messages: ChatMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: obs + "\n\nWhat do you do next? Reply with JSON only." },
    ];
    let reply: any;
    let llmRes;
    try {
      llmRes = await this.llm.chat(messages);
      reply = parseJsonReply(llmRes.text);
    } catch (e) {
      this.log.write("llm.jsonl", { t: Date.now(), agentId: this.id, playerId: world.selfId, error: String(e), raw: llmRes?.text });
      this.record("think", `confused (${String(e).slice(0, 80)})`);
      await this.sleepInterruptible(3000);
      return;
    }
    this.log.write("llm.jsonl", {
      t: Date.now(), agentId: this.id, playerId: world.selfId, lifeIndex: this.lifeIndex,
      observation: obs, reply: llmRes.text, latencyMs: llmRes.latencyMs, promptTokens: llmRes.promptTokens,
      completionTokens: llmRes.completionTokens, costUsd: llmRes.costUsd, model: llmRes.model,
    });

    if (typeof reply.thought === "string") {
      const thought: string = reply.thought.slice(0, 400);
      this.lastThought = thought;
      this.ev("thought", thought);
    }
    if (typeof reply.goal === "string" && reply.goal.trim() && reply.goal !== this.goal) {
      this.goal = reply.goal.slice(0, 200);
    }
    if (typeof reply.note === "string" && reply.note.trim()) {
      this.notebook.push(reply.note.slice(0, 200));
      if (this.notebook.length > 30) this.notebook.shift();
    }
    if (typeof reply.say === "string" && reply.say.trim()) {
      const r = body.say(reply.say);
      this.record(`say "${reply.say}"`, r);
    }
    const action: Action | undefined = reply.action;
    if (action && typeof action.type === "string") {
      const desc = describeAction(action);
      this.lastAction = desc;
      const result = await this.execute(action);
      this.record(desc, result);
      if (action.type !== "wait") this.ev("action", `${desc} -> ${result}`, { action });
    }
  }

  private record(action: string, result: string) {
    this.history.push({ t: Date.now(), action, result });
    if (this.history.length > 20) this.history.shift();
  }

  private async execute(a: Action): Promise<string> {
    const b = this.body!;
    const hasXY = Number.isFinite(a.x) && Number.isFinite(a.y);
    const x = Math.round(a.x as number), y = Math.round(a.y as number);
    try {
      switch (a.type) {
        case "go":
          if (!hasXY) return "need x,y";
          return await b.walkTo([[x, y]]);
        case "use":
        case "pick_up":
          if (!hasXY) return "need x,y";
          return await b.use(x, y);
        case "drop":
          return await b.drop(hasXY ? x : undefined, hasXY ? y : undefined);
        case "swap":
          if (!hasXY) return "need x,y";
          return await b.swap(x, y);
        case "take_out":
          if (!hasXY) return "need x,y";
          return await b.takeOut(x, y);
        case "eat":
        case "wear":
        case "use_on_self": {
          const w = this.world!;
          if (a.type === "eat" && w.food >= w.foodCapacity) return "you're full, can't eat now";
          return await b.self();
        }
        case "forage":
          return hasXY ? await b.forage(x, y) : await b.forage();
        case "undress":
          return await b.undress(Number(a.slot ?? 1));
        case "pick_up_baby":
          if (!a.person) return "need person id";
          return await b.pickUpBaby(Number(a.person));
        case "feed":
        case "use_on_person":
          if (!a.person) return "need person id";
          return await b.useOnPerson(Number(a.person));
        case "jump":
          return b.jump();
        case "wait": {
          const s = Math.min(Math.max(Number(a.seconds ?? 5), 1), 30);
          await this.sleepInterruptible(s * 1000);
          return `waited`;
        }
        default:
          return `unknown action type "${a.type}"`;
      }
    } catch (e) {
      return `error: ${(e as Error).message}`;
    }
  }

  view(): AgentView {
    const w = this.world;
    const me = w?.self;
    const alive = this.status === "alive" && !!me;
    return {
      agentId: this.id,
      lifeIndex: this.lifeIndex,
      status: this.status,
      playerId: alive ? me!.id : null,
      name: alive ? me!.name : null,
      x: alive ? w!.posOf(me!)[0] : null,
      y: alive ? w!.posOf(me!)[1] : null,
      age: alive ? Math.round(w!.currentAge(me!) * 10) / 10 : null,
      female: alive ? me!.female : null,
      food: alive ? w!.food : null,
      foodCapacity: alive ? w!.foodCapacity : null,
      heat: alive ? Math.round(w!.heat * 100) / 100 : null,
      held: alive ? this.body!.heldName() : null,
      motherId: alive ? me!.ancestors[0] ?? null : null,
      eveId: alive ? me!.eveId : null,
      generation: alive ? me!.ancestors.length + 1 : null,
      goal: this.goal,
      lastThought: this.lastThought,
      lastAction: this.lastAction,
      lastSaid: this.lastSaid,
    };
  }
}

function describeAction(a: Action): string {
  const pos = Number.isFinite(a.x) ? ` (${a.x}, ${a.y})` : "";
  const who = a.person ? ` #${a.person}` : "";
  if (a.type === "wait") return `wait ${a.seconds ?? 5}s`;
  return `${a.type}${pos}${who}`;
}
