// The Try-it page (web/demo): its own small Vite build, separate from the app in web/. Build it ONLY with `node scripts/demo/build.mjs`,
// which scans the recording first and hands this config the exact bytes it scanned. Run directly (`vite build --config ...`) this
// config refuses, so a recording can never reach the page without the scan.
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CSP } from "../src/auth.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const DEMO_ROOT = path.resolve(here, "demo");
export const RECORDING_ID = "virtual:onionskin-demo-recording";
// The app's CSP (src/auth.js) plus object-src 'none', as a meta tag the folder carries wherever it is opened from. The app's CSP has no
// frame-ancestors, which a meta tag cannot carry anyway.
export const DEMO_CSP = `${CSP}; object-src 'none'`;
const CSP_MARK = "__ONIONSKIN_DEMO_CSP__";

/**
 * The page's build config. `recording` (parsed recording.json) and `v0`, `v1` (Buffers) are what build.mjs scanned; they are bundled
 * as data (JSON and base64), so the page fetches nothing at run time.
 */
export function demoConfig({ recording, v0, v1, outDir }) {
  if (!recording || !Buffer.isBuffer(v0) || !Buffer.isBuffer(v1) || !outDir) throw new Error("demoConfig needs the scanned recording, both versions and an output folder");
  const source = `export const recording = ${JSON.stringify(recording)};\nexport const v0 = ${JSON.stringify(v0.toString("base64"))};\nexport const v1 = ${JSON.stringify(v1.toString("base64"))};\n`;
  return {
    configFile: false,
    root: DEMO_ROOT,
    base: "./",
    logLevel: "warn",
    publicDir: false,
    plugins: [
      react(),
      {
        name: "onionskin-demo-recording",
        resolveId: (id) => (id === RECORDING_ID ? `\0${RECORDING_ID}` : null),
        load: (id) => (id === `\0${RECORDING_ID}` ? source : null),
      },
      {
        name: "onionskin-demo-csp",
        transformIndexHtml(html) {
          if (html.split(CSP_MARK).length !== 2) throw new Error("web/demo/index.html must carry the CSP meta tag exactly once");
          return html.replace(CSP_MARK, DEMO_CSP.replace(/"/g, "&quot;"));
        },
      },
    ],
    resolve: { alias: { "@engine": path.resolve(here, "../vendor/engine/index.js") } },
    build: { outDir, emptyOutDir: true, target: "es2022", sourcemap: false, chunkSizeWarningLimit: 4000, modulePreload: { polyfill: false } },
  };
}

export default () => {
  throw new Error("Build the Try-it page with `node scripts/demo/build.mjs`: it scans the recording first.");
};
