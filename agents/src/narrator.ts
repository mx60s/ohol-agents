// Omniscient narrator for the broadcast. Every ~30s it reads what happened
// since its last line plus a snapshot of who is where, and writes 1-3
// sentences of plot-level narration. Agents never see this.

import type { Llm } from "./agent/llm.ts";
import type { EventLog } from "./events.ts";
import type { Population } from "./population.ts";
import type { RunEvent } from "./api-types.ts";

const SYSTEM = `You are the narrator of a live broadcast following a small civilization of AI-controlled people in the survival game One Hour One Life. Each person lives at most one hour (1 year per minute), babies must be carried and nursed by their mothers, and families survive only through children.

Every ~30 seconds you get what happened since your last line and a snapshot of everyone alive. Write 1-3 sentences (under 70 words total) of plot-level narration for viewers: the arc, not a list of events. Good topics: how each family is doing, where groups are heading, who is sticking together or drifting apart, struggles with hunger or cold, births, deaths, what people are trying to build, how conversations are going (or failing: babies who can only say one letter, people talking with no one in earshot).

Rules: only state things supported by the input. Use people's names (or "an unnamed baby"). Families are known by surname (the part after the first name; an Eve's surname is her family's name). Vary your phrasing, keep continuity with your previous lines, and if little changed, say so briefly. Plain text only, no lists, no markdown.`;

const DIRS = ["east", "northeast", "north", "northwest", "west", "southwest", "south", "southeast"];

export class Narrator {
  private lastSeq = 0;
  private history: string[] = [];
  private lastPos = new Map<string, [number, number]>();
  private timer: NodeJS.Timeout | null = null;
  private busy = false;

  constructor(private pop: Population, private log: EventLog, private llm: Llm, private intervalMs: number, private model?: string) {}

  start() {
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick() {
    if (this.busy) return;
    if (this.pop.halted) return this.stop();
    if (this.llm.overBudget) return;
    const events = this.log.since(this.lastSeq, 2000);
    const interesting = events.filter((e) => e.kind !== "narration" && e.kind !== "system");
    if (!interesting.length) return;
    this.busy = true;
    try {
      const input = this.buildInput(events);
      this.lastSeq = events[events.length - 1].seq;
      const res = await this.llm.chat(
        [
          { role: "system", content: SYSTEM },
          { role: "user", content: input },
        ],
        { json: false, maxTokens: 1500, model: this.model },
      );
      const text = res.text.trim().replace(/^["']|["']$/g, "");
      if (!text || res.finishReason === "length") {
        this.log.write("narration.jsonl", { t: Date.now(), dropped: true, finishReason: res.finishReason, text });
        return;
      }
      this.history.push(text);
      if (this.history.length > 6) this.history.shift();
      this.log.emitEvent("narration", { text });
      this.log.write("narration.jsonl", { t: Date.now(), input, text, costUsd: res.costUsd, latencyMs: res.latencyMs });
    } catch (e) {
      console.error("narrator failed", e);
    } finally {
      this.busy = false;
    }
  }

  private buildInput(events: RunEvent[]): string {
    const st = this.pop.state();
    const L: string[] = [];
    if (this.history.length) {
      L.push("Your previous lines (oldest first):");
      for (const h of this.history.slice(-3)) L.push(`- ${h}`);
      L.push("");
    }

    L.push("Everyone alive now:");
    const alive = st.agents.filter((a) => a.status === "alive" && a.x != null);
    for (const a of alive) {
      const prev = this.lastPos.get(`${a.agentId}:${a.playerId}`);
      let moved = "";
      if (prev) {
        const dx = a.x! - prev[0], dy = a.y! - prev[1];
        const d = Math.round(Math.hypot(dx, dy));
        moved = d >= 3 ? `, moved ${d} tiles ${DIRS[Math.round(((Math.atan2(dy, dx) * 180) / Math.PI + 360) / 45) % 8]}` : ", stayed put";
      }
      this.lastPos.set(`${a.agentId}:${a.playerId}`, [a.x!, a.y!]);
      const near = alive
        .filter((b) => b !== a && Math.max(Math.abs(b.x! - a.x!), Math.abs(b.y! - a.y!)) <= 10)
        .map((b) => b.name ?? `unnamed #${b.playerId}`);
      L.push(
        `- ${a.name ?? `unnamed #${a.playerId}`}: ${a.female ? "female" : "male"}, age ${a.age}, generation ${a.generation}, food ${a.food}/${a.foodCapacity}, heat ${a.heat}` +
          `, holding ${a.held}, at (${a.x}, ${a.y})${moved}; near: ${near.length ? near.join(", ") : "no one"}; goal: ${a.goal ?? "none"}`,
      );
    }
    const gone = st.agents.filter((a) => a.status !== "alive").length;
    if (gone) L.push(`(${gone} slot(s) between lives)`);

    L.push("");
    L.push("What happened since your last line (oldest first):");
    const nameOf = (agentId: string | null) => st.agents.find((a) => a.agentId === agentId)?.name ?? agentId ?? "?";
    const lines: string[] = [];
    for (const e of events) {
      const who = e.name ?? nameOf(e.agentId);
      if (e.kind === "say") {
        const heard = Array.isArray(e.data?.heardBy) ? (e.data!.heardBy as string[]).map(nameOf) : null;
        lines.push(`${who} said "${e.text}"${heard ? (heard.length ? ` (heard by ${heard.join(", ")})` : " (no one in earshot)") : ""}`);
      } else if (e.kind === "birth" || e.kind === "death" || e.kind === "craft") lines.push(`${e.kind.toUpperCase()}: ${e.text}`);
      else if (e.kind === "action") lines.push(`${who}: ${e.text.slice(0, 140)}`);
      else if (e.kind === "thought") lines.push(`${who} thinks: ${e.text.slice(0, 160)}`);
    }
    // keep the prompt bounded: births/deaths/speech always, then the latest of the rest
    const key = lines.filter((l) => /^(BIRTH|DEATH|CRAFT)|said "/.test(l));
    const rest = lines.filter((l) => !key.includes(l)).slice(-40);
    const keep = new Set([...key, ...rest]);
    L.push(...lines.filter((l) => keep.has(l)));
    L.push("");
    L.push("Write the next 1-3 sentences of narration.");
    return L.join("\n");
  }
}
