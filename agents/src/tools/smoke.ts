// Deterministic smoke test: log in, find a gooseberry bush, pick + eat.
import { Connection } from "../protocol/connection.ts";
import { parseMessage } from "../protocol/messages.ts";
import { GameData } from "../game/gameData.ts";
import { World } from "../game/world.ts";
import { Body } from "../game/body.ts";

const gd = new GameData();
const conn = new Connection({ host: process.argv[2] ?? "127.0.0.1", port: 8005, email: `smoke${Date.now()}@test.local` });
const world = new World(gd, { onSelfDied: (r) => console.log("DIED", r) });
conn.on("message", (raw) => { if (raw.type === "PU" && world.selfId != null) for (const l of raw.lines) if (l.startsWith(world.selfId + " ")) console.log("<< PU", l); if (raw.type === "PM") console.log("<< PM", raw.lines.join(" | ")); world.handle(parseMessage(raw)); });
conn.on("sent", (c) => console.log(">>", c));
console.log(await conn.connect());
await new Promise((r) => setTimeout(r, 2000));
const body = new Body(conn, world, gd);
const s = world.self!;
console.log("self", s.id, s.x, s.y, "age", s.age, "female", s.female, "food", world.food, "/", world.foodCapacity, "cells", world.cells.size);
let bush: [number, number] | null = null; let best = 1e9;
for (const [k, c] of world.cells) {
  if (gd.name(c.obj.id).startsWith("Wild Gooseberry Bush") && !gd.name(c.obj.id).includes("Empty")) {
    const [x, y] = k.split(",").map(Number); const d = Math.abs(x - s.x) + Math.abs(y - s.y);
    if (d < best) { best = d; bush = [x, y]; }
  }
}
console.log("bush", bush, best);
console.log("walk:", await body.walkTo([[s.x + 8, s.y + 3]]), body.pos);
for (const [k, c] of world.cells) { const n = gd.name(c.obj.id); const t = gd.transition(0, c.obj.id); if (t && gd.isFood(t.newActor)) { const [x, y] = k.split(",").map(Number); const d = Math.abs(x - body.pos![0]) + Math.abs(y - body.pos![1]); if (d < best) { best = d; bush = [x, y]; } } }
console.log("food source", bush, bush && gd.name(world.objAt(bush[0], bush[1]).id));
if (bush) {
  console.log(await body.use(bush[0], bush[1]));
  console.log("pos", body.pos, "held", body.heldName());
  console.log(await body.self());
  console.log(body.say("hello world"));
}
await new Promise((r) => setTimeout(r, 1000));
conn.close(); process.exit(0);
