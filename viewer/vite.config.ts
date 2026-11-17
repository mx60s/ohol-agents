import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Relative base so the build works from any subpath (e.g. GitHub Pages at /ohol-agents/).
// Multi-page build: every HTML entry below ships in one static dist/.
export default defineConfig({
  base: "./",
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        index: "index.html", // site home
        stream: "stream.html", // 1920x1080 stream overlay
        agent: "agent.html", // one life: ?life=<lifeId>
        people: "people.html", // every life, searchable
        families: "families.html", // lineages, family trees, deaths
        about: "about.html",
        agents: "agents.html", // how agents work: prompt, observation, actions
        study: "study.html",
        replay: "replay.html", // the original dashboard (?replay= / ?api= / ?mock)
        "ohol-demo": "ohol-demo.html", // real-art renderer demo (needs `npm run assets` for public/ohol/)
      },
    },
  },
});
