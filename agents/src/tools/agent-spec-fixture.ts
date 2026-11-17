// Write a GET /api/agent-spec response for a viewer fixture, from the code and
// config in this process plus a run dir's logs (no server, no LLM calls).
// Set the env to the settings the run used so the prompt matches its turn:
//
//   TIME_SCALE=2 DECISION_CYCLE_MS=4700 LLM_MODEL=moonshotai/kimi-k3.1-pro \
//     npx tsx src/tools/agent-spec-fixture.ts <runDir> ../viewer/fixtures/live1/agent-spec.json

import { writeFileSync } from "node:fs";
import path from "node:path";
import { config } from "../config.ts";
import { buildAgentSpec } from "../agentspec.ts";

const [runDir, out] = process.argv.slice(2);
if (!runDir || !out) {
  console.error("usage: agent-spec-fixture.ts <runDir> <out.json>");
  process.exit(2);
}
const runId = path.basename(runDir).replace(/-\d{4}-\d{2}-\d{2}T.*$/, "");
const spec = buildAgentSpec(config, runDir, { runId });
writeFileSync(out, JSON.stringify(spec) + "\n");
console.log(`${out}: ${JSON.stringify(spec).length} bytes; example ${spec.example ? `${spec.example.agentId} age ${spec.example.age}, ${spec.example.results.length} results, reasoning ${spec.example.reasoning ? "yes" : "no"}` : "none"}`);
