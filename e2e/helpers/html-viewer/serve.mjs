// Builds the HtmlViewer test page (main.jsx) with Vite into a temp folder and serves it on 127.0.0.1 with the app's own headers (the CSP
// of src/auth.js and X-DNS-Prefetch-Control: off), so the component runs as it will in the app. Pages are rendered by the real render
// worker (src/offload.js renderOffThread); `editable` is the server's own list (src/html.js editableTextIds). Test-only.
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "../../../src/html-parser.js";
import { CSP } from "../../../src/auth.js";
import * as H from "../../../src/html.js";
import { plainCopy } from "../../../src/html-render.js";
import { renderOffThread } from "../../../src/offload.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..", "..");

/** Text nodes the person may type in: the server's own list (src/html.js editableTextIds), as the view route sends it. */
export const editableIds = H.editableTextIds;

async function buildPage(outDir) {
  const { build } = await import("vite");
  const react = (await import("@vitejs/plugin-react")).default;
  await build({
    configFile: false,
    root: here,
    base: "/",
    logLevel: "warn",
    publicDir: false,
    cacheDir: path.join(outDir, "..", "vite-cache"), // never inside node_modules (a link to the main checkout's)
    plugins: [react()],
    resolve: { alias: { "@engine": path.join(repo, "vendor", "engine", "index.js") } },
    build: { outDir, emptyOutDir: true, target: "es2022", sourcemap: false, chunkSizeWarningLimit: 8000, modulePreload: { polyfill: false } },
  });
}

const TYPES = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html; charset=utf-8", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".png": "image/png" };

/** Starts the page. `pages`: name -> {bytes, fileDir?, transform?}; more can be added with add(). Returns {url(name, query), add, close, root}. */
export async function startViewerPage(pages = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "da-hv-"));
  const out = path.join(root, "page");
  await buildPage(out);
  const views = new Map();
  const sources = new Map(Object.entries(pages));
  async function viewOf(name, plain) {
    const key = `${name}|${plain ? 1 : 0}`;
    if (views.has(key)) return views.get(key);
    const src = sources.get(name);
    if (!src) return null;
    const bytes = Buffer.isBuffer(src.bytes) ? src.bytes : Buffer.from(src.bytes);
    const version = crypto.createHash("sha256").update(bytes).digest("hex");
    const read = H.readHtml(bytes);
    const editable = editableIds(read);
    const ident = Array.from(H.editIdentities(read, editable));
    let v;
    if (plain) {
      const p = plainCopy(read);
      v = { bytes: p.bytes, meta: { texts: p.texts, stats: p.stats, plain: "plain", version, editable, ident } };
    } else {
      const r = await renderOffThread({ bytes, fileDir: src.fileDir ?? null });
      if (!r.ok) throw new Error(`render failed: ${JSON.stringify({ code: r.code, failed: r.failed, error: r.error })}`);
      // `transform` (tests only): the copy changed after the render, e.g. to put back what the render strips, for a positive control
      const bytesOut = src.transform ? Buffer.from(src.transform(r.bytes.toString("utf8"))) : r.bytes;
      v = { bytes: bytesOut, meta: { texts: r.texts, stats: r.stats, plain: r.plain ? r.reason : null, version, editable, ident } };
    }
    views.set(key, v);
    return v;
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader("Content-Security-Policy", CSP);
    res.setHeader("X-DNS-Prefetch-Control", "off");
    res.setHeader("Cache-Control", "no-store");
    const u = new URL(req.url, "http://x");
    try {
      if (u.pathname === "/meta" || u.pathname === "/copy") {
        const v = await viewOf(u.searchParams.get("f"), u.searchParams.get("plain") === "1");
        if (!v) return (res.statusCode = 404), res.end("no such page");
        if (u.pathname === "/meta") {
          res.setHeader("Content-Type", "application/json");
          return res.end(JSON.stringify(v.meta));
        }
        res.setHeader("Content-Type", "application/octet-stream"); // never text/html (R12)
        return res.end(v.bytes);
      }
      const file = u.pathname === "/" ? path.join(out, "index.html") : path.join(out, path.normalize(u.pathname).replace(/^(\.\.[/\\])+/, ""));
      if (!file.startsWith(out) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return (res.statusCode = 404), res.end("not found");
      res.setHeader("Content-Type", TYPES[path.extname(file)] || "application/octet-stream");
      res.end(fs.readFileSync(file));
    } catch (err) {
      res.statusCode = 500;
      res.end(String(err.message));
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    root,
    base,
    url: (name, query = "") => `${base}/?f=${encodeURIComponent(name)}${query ? `&${query}` : ""}`,
    add(name, src) {
      sources.set(name, src);
      for (const k of [...views.keys()]) if (k.startsWith(`${name}|`)) views.delete(k);
    },
    close() {
      server.close();
      server.closeAllConnections?.();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
