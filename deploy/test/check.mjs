// Assertions for deploy/test/supervisor-restart.sh, against a running agents service.
//
//   node check.mjs snapshot <apiBase> <file>        save run id, living agents, lives, max event seq
//   node check.mjs alive <apiBase> <n>              exit 0 once >= n agents are alive (prints them)
//   node check.mjs same <apiBase> <file> [--version V]
//       exit 0 if the run id is unchanged and every character alive in <file> is alive
//       again with the same player id (reconnected, older or same age), its life record
//       is still open (not lost, not dead, valid), no new life was recorded for its
//       slot, and the event seq continued; prints why not otherwise (exit 1)
import { readFileSync, writeFileSync } from "node:fs";

const [cmd, base, arg, ...rest] = process.argv.slice(2);
const get = async (p) => {
  const r = await fetch(base + p, { signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error(`${p}: HTTP ${r.status}`);
  return r.json();
};

async function snapshot() {
  const state = await get("/api/state");
  const lives = (await get("/api/lives?since=0&limit=1000")).lives;
  const events = (await get("/api/events?since=0")).events;
  const alive = state.agents.filter((a) => a.status === "alive" && a.playerId != null).map((a) => ({ agentId: a.agentId, playerId: a.playerId, age: a.age, lifeId: a.lifeId }));
  return { runId: state.run.id, startedAt: state.run.startedAt, alive, lives, maxSeq: Math.max(0, ...events.map((e) => e.seq)), events };
}

try {
  if (cmd === "snapshot") {
    const s = await snapshot();
    writeFileSync(arg, JSON.stringify(s));
    console.log(`run ${s.runId}; alive ${s.alive.map((a) => `${a.agentId}=#${a.playerId}@${a.age}`).join(" ")}; lives ${s.lives.length}; seq ${s.maxSeq}`);
  } else if (cmd === "alive") {
    const s = await snapshot();
    console.log(`alive: ${s.alive.map((a) => `${a.agentId}=#${a.playerId}@${a.age}`).join(" ") || "none"}`);
    process.exit(s.alive.length >= Number(arg) ? 0 : 1);
  } else if (cmd === "same") {
    const before = JSON.parse(readFileSync(arg, "utf8"));
    const vi = rest.indexOf("--version");
    if (vi >= 0) {
      const h = await get("/health");
      if (h.appVersion !== rest[vi + 1]) throw new Error(`appVersion ${h.appVersion}, want ${rest[vi + 1]}`);
    }
    const now = await snapshot();
    const why = [];
    if (now.runId !== before.runId) why.push(`run id ${before.runId} -> ${now.runId}`);
    if (now.startedAt !== before.startedAt) why.push(`run.startedAt changed`);
    for (const a of before.alive) {
      const b = now.alive.find((x) => x.agentId === a.agentId);
      if (!b) why.push(`${a.agentId} not alive`);
      else if (b.playerId !== a.playerId) why.push(`${a.agentId} is #${b.playerId}, was #${a.playerId} (a new body)`);
      else if (b.age + 0.05 < a.age) why.push(`${a.agentId} age went back ${a.age} -> ${b.age}`);
      const life = now.lives.find((l) => l.lifeId === a.lifeId);
      if (!life) why.push(`life ${a.lifeId} missing`);
      else if (life.status !== "alive" || life.lostAt != null || life.diedAt != null || life.validForStudy !== true)
        why.push(`life ${a.lifeId}: status ${life.status}, lostAt ${life.lostAt}, diedAt ${life.diedAt}, valid ${life.validForStudy}`);
      const slotLives = now.lives.filter((l) => l.runId === now.runId && l.agentId === a.agentId).length;
      const slotBefore = before.lives.filter((l) => l.runId === before.runId && l.agentId === a.agentId).length;
      if (slotLives !== slotBefore) why.push(`${a.agentId}: ${slotLives - slotBefore} new life record(s)`);
      if (b && !now.events.some((e) => e.kind === "system" && e.agentId === a.agentId && e.data?.reconnect === true && e.seq > before.maxSeq))
        why.push(`${a.agentId}: no reconnect event after seq ${before.maxSeq}`);
      if (now.events.some((e) => e.kind === "birth" && e.agentId === a.agentId && e.seq > before.maxSeq)) why.push(`${a.agentId}: a birth event after the restart`);
    }
    const minSeq = Math.min(...now.events.filter((e) => e.seq > 0).map((e) => e.seq));
    if (!(now.maxSeq > before.maxSeq)) why.push(`event seq did not continue (${before.maxSeq} -> max ${now.maxSeq}, min ${minSeq})`);
    if (why.length) {
      console.log(`not yet: ${why.join("; ")}`);
      process.exit(1);
    }
    console.log(`same run ${now.runId}; reconnected ${before.alive.map((a) => `${a.agentId}=#${a.playerId} ${a.age}->${now.alive.find((x) => x.agentId === a.agentId).age}`).join(", ")}; seq ${before.maxSeq} -> ${now.maxSeq}`);
  } else {
    console.error("usage: check.mjs snapshot|alive|same ...");
    process.exit(2);
  }
} catch (e) {
  console.log(`not yet: ${e.message}`);
  process.exit(1);
}
