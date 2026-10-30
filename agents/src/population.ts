// Keeps N agent slots running, and assembles the run-wide view for the API.

import { Agent, type SpeechSink } from "./agent/agent.ts";
import { Llm } from "./agent/llm.ts";
import type { GameData } from "./game/gameData.ts";
import type { Config } from "./config.ts";
import type { EventLog } from "./events.ts";
import type { MapCellTuple, MapResponse, PlayerView, StateResponse } from "./api-types.ts";

interface PendingSay {
  speaker: Agent | null;
  text: string;
  x: number;
  y: number;
  hearers: Set<string>;
  timer: NodeJS.Timeout;
}

export class Population implements SpeechSink {
  readonly agents: Agent[] = [];
  readonly llm: Llm;
  startedAt = Date.now();
  started = false;
  private merged = new Map<string, { biome: number; floor: number; obj: number; t: number }>();
  private births = 0;
  private deaths = 0;
  private pendingSays = new Map<string, PendingSay>();
  halted = false;
  haltReason: string | null = null;
  private limitTimer: NodeJS.Timeout | null = null;

  constructor(private cfg: Config, private gd: GameData, private log: EventLog) {
    this.llm = new Llm(cfg);
    log.on("event", (e) => {
      if (e.kind === "birth") {
        this.births++;
        const gen = Number(e.data?.generation ?? 0);
        if (gen > cfg.maxGeneration) this.halt(`generation ${gen} was born (limit ${cfg.maxGeneration})`);
        else if (this.births >= cfg.maxLives) this.halt(`${this.births} lives (limit ${cfg.maxLives})`);
      }
      if (e.kind === "death") this.deaths++;
    });
  }

  async start() {
    if (this.started || this.halted) return;
    this.started = true;
    this.startedAt = Date.now();
    this.log.emitEvent("system", {
      text: `run started: ${this.cfg.agentCount} agents, model ${this.cfg.llmModel}, memory ${this.cfg.memoryMode}, recipe hints ${this.cfg.recipeHints ? "on" : "off"}`,
    });
    this.limitTimer = setInterval(() => {
      const mins = (Date.now() - this.startedAt) / 60000;
      if (mins >= this.cfg.maxRuntimeMin) this.halt(`ran ${Math.round(mins)} min (limit ${this.cfg.maxRuntimeMin})`);
      else if (this.llm.overBudget) this.halt(`spent $${this.llm.totalCost.toFixed(2)} (limit $${this.cfg.maxCostUsd})`);
    }, 5000);
    for (let i = 0; i < this.cfg.agentCount && !this.halted; i++) {
      const a = new Agent(`a${String(i + 1).padStart(2, "0")}`, this.cfg, this.gd, this.llm, this.log, this);
      this.agents.push(a);
      a.run();
      // stagger logins: first is Eve, later ones get born to living women
      await new Promise((r) => setTimeout(r, this.cfg.loginStaggerMs));
    }
  }

  stop() {
    for (const a of this.agents) a.stop();
  }

  // Speech: the speaker's own echo and other agents' PS messages arrive within
  // a frame or two of each other. Collect hearers for 1.5s, then emit one
  // "say" event with heardBy.
  spoke(speaker: Agent, text: string, x: number, y: number) {
    const id = speaker.world?.selfId;
    if (id == null) return;
    const e = this.pending(id, text);
    e.speaker = speaker;
    e.x = x;
    e.y = y;
  }

  heard(hearer: Agent, speakerPlayerId: number, text: string) {
    this.pending(speakerPlayerId, text).hearers.add(hearer.id);
  }

  private pending(speakerPlayerId: number, text: string): PendingSay {
    const key = `${speakerPlayerId}|${text}`;
    let e = this.pendingSays.get(key);
    if (!e) {
      e = {
        speaker: null, text, x: 0, y: 0, hearers: new Set(),
        timer: setTimeout(() => {
          this.pendingSays.delete(key);
          // only lines spoken by our agents become events (no humans on this server)
          if (e!.speaker) e!.speaker.emit("say", text, { playerId: speakerPlayerId, x: e!.x, y: e!.y, heardBy: [...e!.hearers] });
        }, 1500),
      };
      this.pendingSays.set(key, e);
    }
    return e;
  }

  /** Ends the run: disconnects every agent and stops all LLM calls. */
  halt(reason: string) {
    if (this.halted) return;
    this.halted = true;
    this.haltReason = reason;
    if (this.limitTimer) clearInterval(this.limitTimer);
    this.stop();
    this.log.emitEvent("system", { text: `run halted: ${reason}` });
    console.log(`run halted: ${reason}`);
  }

  private mergeMaps() {
    for (const a of this.agents) {
      const w = a.world;
      if (!w) continue;
      for (const [k, c] of w.cells) {
        const m = this.merged.get(k);
        if (!m || m.t < c.t) this.merged.set(k, { biome: c.biome >= 0 ? c.biome : m?.biome ?? -1, floor: c.floor, obj: c.obj.id, t: c.t });
      }
    }
  }

  map(radius = 60): MapResponse {
    this.mergeMaps();
    const centers = this.agents.filter((a) => a.status === "alive").map((a) => a.world?.self).filter((s): s is NonNullable<typeof s> => !!s);
    const cells: MapCellTuple[] = [];
    const names: Record<number, string> = {};
    for (const [k, c] of this.merged) {
      const [x, y] = k.split(",").map(Number);
      if (centers.length && !centers.some((s) => Math.abs(s.x - x) <= radius && Math.abs(s.y - y) <= radius)) continue;
      cells.push([x, y, c.biome, c.floor, c.obj]);
      if (c.obj && !names[c.obj]) names[c.obj] = this.gd.name(c.obj);
      if (c.floor && !names[c.floor]) names[c.floor] = this.gd.name(c.floor);
    }
    return { cells, names };
  }

  state(): StateResponse {
    const agentsByPlayer = new Map<number, string>();
    for (const a of this.agents) if (a.status === "alive" && a.world?.selfId != null) agentsByPlayer.set(a.world.selfId, a.id);

    const players = new Map<number, PlayerView & { seen: number }>();
    for (const a of this.agents) {
      const w = a.world;
      if (!w || a.status !== "alive") continue;
      for (const p of w.players.values()) {
        const prev = players.get(p.id);
        if (prev && prev.seen >= p.lastSeen) continue;
        let held: string | null = null;
        if (p.held.id < 0) held = `baby #${-p.held.id}`;
        else if (p.held.id > 0) held = this.gd.describeStack(p.held);
        players.set(p.id, {
          id: p.id, x: w.posOf(p)[0], y: w.posOf(p)[1], age: Math.round(w.currentAge(p) * 10) / 10, female: p.female,
          name: p.name ?? w.names.get(p.id) ?? null, held, agentId: agentsByPlayer.get(p.id) ?? null, dying: p.dying, seen: p.lastSeen,
          moving: p.moving && Date.now() < p.moveEndsAt, displayId: p.displayId,
        });
      }
    }
    const views = this.agents.map((a) => a.view());
    const alive = views.filter((v) => v.status === "alive");
    return {
      run: {
        id: this.cfg.runId, startedAt: this.startedAt, model: this.cfg.llmModel, memoryMode: this.cfg.memoryMode,
        recipeHints: this.cfg.recipeHints, targetPopulation: this.cfg.agentCount,
        status: this.halted ? "halted" : this.started ? "running" : "idle", haltReason: this.haltReason,
        limits: { maxGeneration: this.cfg.maxGeneration, maxLives: this.cfg.maxLives, maxRuntimeMin: this.cfg.maxRuntimeMin, maxCostUsd: this.cfg.maxCostUsd },
      },
      now: Date.now(),
      agents: views,
      players: [...players.values()].map(({ seen, ...p }) => p),
      stats: {
        alive: alive.length,
        totalBirths: this.births,
        totalDeaths: this.deaths,
        maxGeneration: Math.max(0, ...alive.map((v) => v.generation ?? 0)),
        families: new Set(alive.map((v) => v.eveId).filter((x) => x != null)).size,
        llmCalls: this.llm.calls,
        llmCostUsd: Math.round(this.llm.totalCost * 10000) / 10000,
      },
    };
  }
}
