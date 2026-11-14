#!/usr/bin/env node
// Serves a built Try-it page on this Mac only, so it can be opened in a browser (module scripts do not run from file://).
//   node scripts/demo/serve.mjs [<folder>] [--port N]        default folder dist-demo/, default port: any free one
// Plain node:http on 127.0.0.1: GET and HEAD only, files inside the folder only (no dotfiles, no folder listing, no links out of it).
// The query string is ignored, so /?anything still serves the page. Stop it with Ctrl+C.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DIR = path.resolve(here, "..", "..", "dist-demo");
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
};

/** Starts the server. Resolves {server, url, close()}. Port 0 picks a free port. */
export function serve(dir = DEFAULT_DIR, { port = 0 } = {}) {
  const root = fs.realpathSync(path.resolve(dir));
  if (!fs.existsSync(path.join(root, "index.html"))) throw new Error(`${root} has no index.html; build the page first with node scripts/demo/build.mjs`);
  const server = http.createServer((req, res) => {
    const send = (code, body = "", type = "text/plain; charset=utf-8") => {
      res.writeHead(code, { "Content-Type": type, "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
      res.end(req.method === "HEAD" ? undefined : body);
    };
    if (req.method !== "GET" && req.method !== "HEAD") return send(405, "Only GET and HEAD.");
    let rel;
    try {
      rel = decodeURIComponent(new URL(req.url, "http://127.0.0.1").pathname);
    } catch {
      return send(400, "Bad address.");
    }
    if (rel === "/") rel = "/index.html";
    const parts = rel.split("/").filter(Boolean);
    if (!parts.length || parts.some((p) => p.startsWith(".") || p.includes("\\") || p.includes("\0"))) return send(404, "Not found.");
    let file;
    try {
      file = fs.realpathSync(path.join(root, ...parts));
    } catch {
      return send(404, "Not found.");
    }
    if (!file.startsWith(root + path.sep) || !fs.statSync(file).isFile()) return send(404, "Not found.");
    const type = TYPES[path.extname(file).toLowerCase()];
    if (!type) return send(404, "Not found.");
    send(200, fs.readFileSync(file), type);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const url = `http://127.0.0.1:${server.address().port}/`;
      resolve({ server, url, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const i = args.indexOf("--port");
  const port = i >= 0 ? Number(args[i + 1]) : 0;
  const dir = args.find((a, k) => !a.startsWith("--") && args[k - 1] !== "--port") || DEFAULT_DIR;
  if (!Number.isInteger(port) || port < 0 || port > 65535) (console.error("usage: serve.mjs [<folder>] [--port N]"), process.exit(2));
  try {
    const { url } = await serve(dir, { port });
    console.log(`The Try-it page is at ${url} (this Mac only). Press Ctrl+C to stop.`);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
