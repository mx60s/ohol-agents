// Owns the current run. A run = one EventLog + one Population + narrator.
// Starting after a halt creates a fresh run in the same process, with fresh
// login emails (so it doesn't resume the old run's abandoned characters).

import { EventEmitter } from "node:events";
import type { Config } from "./config.ts";
import type { GameData } from "./game/gameData.ts";
import { EventLog } from "./events.ts";
import { Population } from "./population.ts";
import { Narrator } from "./narrator.ts";
import type { RunEvent } from "./api-types.ts";

export class RunController extends EventEmitter {
  pop!: Population;
  log!: EventLog;
  private narrator: Narrator | null = null;
  private runCount = 0;
  private pastRunsCost = 0;

  /** LLM spend across every run in this process */
  get totalCost() {
    return this.pastRunsCost + this.pop.llm.totalCost;
  }

  get openControl() {
    return this.cfg.openControl;
  }

  get maxTotalCostUsd() {
    return this.cfg.maxTotalCostUsd;
  }

  constructor(private cfg: Config, private gd: GameData) {
    super();
    this.create();
  }

  /** New idle run. Run ids look like "pilot1-r3-lq2x9" (base-36 timestamp). */
  private create() {
    this.narrator?.stop();
    if (this.pop) this.pastRunsCost += this.pop.llm.totalCost;
    this.runCount++;
    const runId = `${this.cfg.runId}-r${this.runCount}-${Date.now().toString(36)}`;
    const cfg: Config = { ...this.cfg, runId };
    this.log = new EventLog(cfg.logDir, runId);
    this.log.on("event", (e: RunEvent) => this.emit("event", e));
    this.pop = new Population(cfg, this.gd, this.log);
    this.narrator = cfg.narratorIntervalMs > 0 ? new Narrator(this.pop, this.log, this.pop.llm, cfg.narratorIntervalMs, cfg.narratorModel) : null;
    this.narrator?.start();
    console.log(`run ${runId}: logs -> ${this.log.dir}`);
  }

  /** Start the current run, or a fresh one if the current run already halted. */
  start(): string {
    if (this.pop.started && !this.pop.halted) return "already running";
    if (this.cfg.maxTotalCostUsd > 0 && this.totalCost >= this.cfg.maxTotalCostUsd)
      return `refused: total spend $${this.totalCost.toFixed(2)} reached the $${this.cfg.maxTotalCostUsd} cap (restart the service to reset)`;
    if (this.pop.halted) this.create();
    void this.pop.start();
    return "started";
  }

  halt(reason: string): string {
    if (!this.pop.started || this.pop.halted) return "not running";
    this.pop.halt(reason);
    return "halted";
  }

  shutdown() {
    this.log.emitEvent("system", { text: "process stopping" });
    this.pop.stop();
    this.narrator?.stop();
  }
}
