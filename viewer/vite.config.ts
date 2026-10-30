import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Relative base so the build works from any subpath (e.g. GitHub Pages at
// /ohol-agents/). Override with VITE_BASE=/ for root-absolute asset URLs.
export default defineConfig({
  base: process.env.VITE_BASE ?? "./",
  plugins: [react()],
});
