import { config } from "./config.ts";
import { GameData } from "./game/gameData.ts";
import { RunController } from "./runs.ts";
import { startApi } from "./api.ts";

if (!config.llmApiKey) {
  console.error("No LLM key: set OPENROUTER_API_KEY (or LLM_API_KEY)");
  process.exit(1);
}

const gd = new GameData();
const runs = new RunController(config, gd);
startApi(config.port, runs, gd, config.controlToken);
if (config.autostart) runs.start();
else console.log("AUTOSTART=0: idle until POST /api/start?token=...");

const shutdown = () => {
  runs.shutdown();
  setTimeout(() => process.exit(0), 300);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
