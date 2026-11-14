import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: here,
  base: "/",
  plugins: [react()],
  resolve: { alias: { "@engine": path.resolve(here, "../vendor/engine/index.js") } },
  build: { outDir: path.resolve(here, "dist"), emptyOutDir: true, target: "es2022", sourcemap: false, chunkSizeWarningLimit: 4000 },
});
