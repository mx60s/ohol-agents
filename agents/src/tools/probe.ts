// Connects one client, logs in, prints every message summary for N seconds.
// Usage: npm run probe -- [host] [port] [seconds]
import { Connection } from "../protocol/connection.ts";

const [host = "127.0.0.1", port = "8005", secs = "20"] = process.argv.slice(2);
const conn = new Connection({ host, port: Number(port), email: `probe${Date.now()}@test.local` });
conn.on("message", (m) => {
  if (m.type === "FM") return;
  const extra = m.binary ? ` [binary ${m.binary.length}b: ${m.binary.subarray(0, 120).toString("latin1")}]` : "";
  console.log(`<< ${m.type} (${m.lines.length} lines) ${m.lines.slice(0, 3).join(" | ").slice(0, 300)}${extra}`);
});
conn.on("sent", (c) => console.log(`>> ${c}`));
const res = await conn.connect();
console.log("login:", res);
setTimeout(() => { conn.close(); process.exit(0); }, Number(secs) * 1000);
