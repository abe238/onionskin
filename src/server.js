import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserAuth, CSP } from "./auth.js";
import { PRODUCT, SERVER_PROTOCOL, env } from "./constants.js";
import { sha256 } from "./fsutil.js";
import { ensureStateDir, serverRecordPath, socketPath, stateDir, writeStateFile } from "./paths.js";
import { setupCheckerStatus, startLateSoffice, startSetupChecker } from "./checker.js";
import { analyzeOffThread, warmAnchors } from "./offload.js";
import { REQUEST_MAX, requestSize } from "./retain.js";
import { warm, warmNewest } from "./history.js";
import { stopRewriter } from "./rewriter.js";
import { HttpError, Sessions, tooLarge } from "./session.js";
import { encodeHtmlView } from "./html-envelope.js";
import { CapError } from "./xml.js";
import { quickPreview } from "./quick-plan.js";
import { batchFile, checkBinding, claimOfQuery, cliBatch, cliStatus, leaseOf, localRunner, openWork, sessionFor } from "./local.js"; // leaseOf: the delivery an agent acts on (batch, holder, token), all three required
import { readStamps, writeStamps } from "./stamps.js";
import { setupRewriterStatus, startSetupRewriter, suggest, suggestStatus, useSuggestion, warmSuggest } from "./suggest.js";
import { readStyle, writeStyle } from "./style.js";
import { GUIDE_BODY_MAX, VOICE_BUILD_MAX_BODY, VOICE_POSTS, buildVoiceRequest, learnFromSend, stopVoice, voicePost, voiceState } from "./voice-learn.js";
import { agentRunner } from "./agent-runner.js";
import { docWatcher } from "./watch.js";
import { isBgHolder } from "./agent-detect.js";
import { BG_PRESETS, MAX_IMAGE_BYTES, SettingsError, readCustomImage, readSettings, removeCustomImage, saveCustomImage, writeBackground } from "./settings.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WEB_DIST = env("WEB_DIST", path.join(root, "web", "dist"));
const MAX_BODY = 300 * 1024 * 1024; // base64 of a 200 MB document; ceiling: whole body buffered in memory. Upgrade path: binary upload route.
const META_ROUTES = new Set(["/api/claim", "/api/answer", "/api/review", "/api/suggestion", "/api/takeback", "/api/revert", "/api/show-copy", "/api/dismiss-conflict", "/api/close"]);
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".ico": "image/x-icon", ".map": "application/json" };

function secure(res) {
  res.setHeader("Content-Security-Policy", CSP);
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-DNS-Prefetch-Control", "off"); // PLAN-html R3, R21: no DNS prefetch for anything the page or an HTML view names
}
function sendJson(res, status, body) {
  secure(res);
  const raw = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(raw) });
  res.end(raw);
}
function sendText(res, status, text) {
  secure(res);
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}
// A body past `max` is refused with a JSON answer the page can show (413, code too_large_request), not a cut connection (the page read
// that as a failure to retry forever): the rest of it is read and dropped, up to MAX_BODY more, so the browser gets the answer; past
// that the connection is closed.
function readBody(req, max = MAX_BODY, refusal = null) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    let over = false;
    req.on("data", (c) => {
      n += c.length;
      if (over) {
        if (n > max + MAX_BODY) req.destroy();
        return;
      }
      if (n > max) {
        over = true;
        chunks.length = 0;
        reject(refusal || new HttpError(413, "body too large", { code: "too_large_request" }));
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
async function readJson(req, max = MAX_BODY, refusal = null) {
  const raw = await readBody(req, max, refusal);
  try {
    return raw.length ? JSON.parse(raw.toString("utf8")) : {};
  } catch {
    throw new HttpError(400, "invalid JSON");
  }
}
function fail(res, err) {
  if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message, ...err.extra });
  if (err instanceof SettingsError) return sendJson(res, err.status, { error: err.message });
  // a document past a reader's cap (src/xml.js): plain words a person can act on, whatever route read it
  if (err instanceof CapError) return sendJson(res, 422, { error: `Onionskin cannot read this file: ${err.message}.`, code: "too_large" });
  console.error("internal error:", err.stack || err);
  return sendJson(res, 500, { error: "internal error" });
}

/** index.html, with the launch token in a <meta> when this response is the nonce exchange. The page moves it into memory and sessionStorage and removes the tag. */
function serveIndex(res, launchToken) {
  let html;
  try {
    html = fs.readFileSync(path.join(WEB_DIST, "index.html"), "utf8");
  } catch {
    return sendText(res, 404, "not found");
  }
  if (launchToken) {
    const meta = `<meta name="onionskin-launch" content="${launchToken}">`; // base64url: no characters that need escaping
    html = html.includes("</head>") ? html.replace("</head>", `${meta}</head>`) : meta + html;
  }
  // the saved background choice, as an allowlisted attribute (the CSP forbids inline script): the first paint already has the right ground
  const bg = readSettings().background;
  html = html.replace("<html ", `<html data-bg="${bg.kind === "custom" ? "custom" : bg.name}" `);
  secure(res);
  const raw = Buffer.from(html);
  res.writeHead(200, { "Content-Type": MIME[".html"], "Content-Length": raw.length });
  res.end(raw);
}

function decodeUriPart(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    throw new HttpError(400, "invalid URL encoding");
  }
}

function serveStatic(res, urlPath) {
  const rel = decodeUriPart(urlPath).replace(/^\/+/, "");
  const dist = path.resolve(WEB_DIST);
  const file = path.resolve(dist, rel);
  if (file !== dist && !file.startsWith(dist + path.sep)) return sendText(res, 403, "forbidden");
  let realDist;
  let realFile;
  let st;
  try {
    realDist = fs.realpathSync(dist);
    realFile = fs.realpathSync(file);
  } catch {
    return sendText(res, 404, "not found");
  }
  if (realFile !== realDist && !realFile.startsWith(realDist + path.sep)) return sendText(res, 403, "forbidden");
  try {
    st = fs.statSync(realFile);
  } catch {
    return sendText(res, 404, "not found");
  }
  if (!st.isFile()) return sendText(res, 404, "not found");
  secure(res);
  res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream", "Content-Length": st.size });
  const stream = fs.createReadStream(realFile);
  stream.on("error", () => {
    if (!res.headersSent) sendText(res, 404, "not found");
    else res.destroy();
  });
  res.on("close", () => stream.destroy());
  stream.pipe(res);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Runs `fn` while holding <state>/start.lock (created exclusively, holds our pid). The probe-unlink-listen sequence must not interleave
 * between two starting servers: one could unlink the other's live socket. A lock whose pid is gone is stale and taken over.
 * Ceiling: stale-lock takeover is not atomic (two starts finding the same dead lock can both remove it); that needs two crashes in the same millisecond.
 */
async function withStartLock(fn) {
  const lock = path.join(stateDir(), "start.lock");
  for (let tries = 0; ; tries++) {
    try {
      const fd = fs.openSync(lock, "wx", 0o600);
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      break;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      let stale = false;
      try {
        const pid = Number(fs.readFileSync(lock, "utf8"));
        if (Number.isInteger(pid) && pid > 0) {
          try {
            process.kill(pid, 0);
          } catch (e) {
            stale = e.code !== "EPERM";
          }
        } else {
          stale = Date.now() - fs.statSync(lock).mtimeMs > 2000;
        }
      } catch {
        continue;
      }
      if (stale) {
        try {
          fs.unlinkSync(lock);
        } catch {}
        continue;
      }
      if (tries > 150) throw new Error("another server start has held the start lock for too long");
      await sleep(100);
    }
  }
  try {
    return await fn();
  } finally {
    try {
      fs.unlinkSync(lock);
    } catch {}
  }
}

/**
 * The real path of a CLI route's file, resolved once: the agent binding is checked on it, and the route opens exactly it (`pinned`), so a path
 * changed in between cannot open another file. null when it does not resolve (the binding is then checked on the path as sent, and the
 * open answers "not found" as before). Ceiling: a folder on the path swapped after this is followed (the O_NOFOLLOW limit of readOwned).
 */
function pinFile(file, holder) {
  let real = null;
  try {
    real = fs.realpathSync(path.resolve(file));
  } catch {}
  checkBinding(real ?? file, holder);
  return real;
}

export async function startServer({ port = 0 } = {}) {
  ensureStateDir();
  const sessions = new Sessions();
  const sse = new Map(); // key -> Set<res>
  // key -> when a page of that session last spoke (its event stream opened or ended, any other request): `onionskin update` holds
  // off while a tab is open or was open lately (src/local.js openWork), since edits typed in a tab live only in that tab until Send
  const tabSeen = new Map();
  const tabsOf = (key) => sse.get(key)?.size || 0;
  // LibreOffice checks running after `done` returned (session key -> Set<{cancel}>). Cancelled when the session closes or the server stops.
  const late = new Map();
  function startLate(key, inputs, analysis) {
    let h = null;
    let finished = false; // the callback can run before startLateSoffice returns
    h = startLateSoffice(inputs.pre, inputs.post, inputs.format, (result) => {
      finished = true;
      late.get(key)?.delete(h);
      sessions.recordLateCheck(key, { batchId: analysis.batchId, postSha: analysis.postSha, result });
    });
    if (finished) return;
    if (!late.has(key)) late.set(key, new Set());
    late.get(key).add(h);
  }
  sessions.on("closed", (s) => cancelLate(s.key));
  // learning (stage 1): what a Send can teach is stored on this Mac by src/voice-learn.js; ids and booleans, plus untrusted examples
  sessions.on("voice", (job) => learnFromSend(job));
  function cancelLate(key, why = "the session was closed before the check finished") {
    for (const h of [...(late.get(key) || [])]) h.cancel(why);
    late.delete(key);
  }
  /** The end of a run, for an agent's `done` and for a run on this Mac: the lease check, the checks off the event loop, `done`, the late LibreOffice check. */
  async function finishRun(key, results, claim) {
    const s = sessions.get(key);
    const stageBefore = s.delivered?.stage;
    const delivery = s.delivered;
    const inputs = sessions.analysisInputs(s.key, claim); // checks the lease, reads the bytes, moves the stage to "checking"
    let analysis, done;
    try {
      analysis = inputs ? await analyzeOffThread(inputs) : null; // the server keeps answering while the checks run
      done = await sessions.doneAsync(s.key, results, claim, analysis, { inline: false }); // the checks and the anchors never run on this thread
    } catch (err) {
      if (delivery && s.delivered === delivery && stageBefore) sessions.setStage(s.key, stageBefore); // done did not finish and this delivery is still the current one
      throw err;
    }
    if (analysis && done.checks?.deep?.soffice === "pending") startLate(s.key, inputs, analysis);
    warm(s);
    warmNewest(s);
    return done;
  }
  // a whole Send that Onionskin can do on this Mac is delivered to the local runner instead of an agent (src/local.js)
  const local = localRunner(sessions, { finishRun });
  sessions.local = local;
  sessions.on("local", (s, ticket) => setImmediate(() => local.run(s.key, ticket)));
  // the background agent (src/agent-runner.js): started for a file opened from a person's terminal, or for a Send nobody took
  const agent = agentRunner(sessions, { tabs: tabsOf });
  sessions.agent = agent;
  // a faster outside-edit notice (src/watch.js); the page's /api/stale poll stays the backstop
  const watcher = docWatcher(sessions);
  sessions.watch = watcher;
  let auth;
  let lastActivity = Date.now();

  // ---- browser side (TCP loopback) -------------------------------------------------------------------------
  async function browser(req, res) {
    lastActivity = Date.now();
    try {
      const url = new URL(req.url, "http://x");
      const p = url.pathname;
      if (!auth.hostOk(req)) return sendText(res, 403, "bad host");
      if (p === "/favicon.ico") {
        secure(res);
        res.writeHead(204);
        return res.end();
      }
      if (req.method === "GET" && (p === "/" || p === "/index.html")) {
        const nonce = url.searchParams.get("n");
        let launchToken = "";
        if (nonce) {
          const ex = auth.exchange(nonce, req);
          if (!ex) return sendText(res, 403, `This launch link was already used or has expired. Run \`${PRODUCT.bin} open <file>\` again.`);
          res.setHeader("Set-Cookie", ex.cookie);
          launchToken = ex.token; // handed over once, inside this page; never again by any route
        } else if (!auth.cookieSession(req)) {
          return sendText(res, 403, `Open documents with \`${PRODUCT.bin} open <file>\`.`);
        }
        return serveIndex(res, launchToken);
      }
      if (req.method === "GET" && !p.startsWith("/api/")) {
        // app assets are public to the cookie holder only
        if (!auth.cookieSession(req)) return sendText(res, 403, "no session");
        return serveStatic(res, p);
      }
      if (!p.startsWith("/api/")) return sendText(res, 404, "not found");
      const mutating = req.method !== "GET";
      const isBootstrap = p === "/api/bootstrap";
      const isEvents = p === "/api/events";
      const bad = auth.check(req, { mutating, queryToken: isEvents ? url.searchParams.get("t") || "" : "" });
      if (bad) return sendJson(res, isBootstrap && bad.code === "token_required" ? 401 : bad.status, { error: bad.error, ...(bad.code ? { code: bad.code, reopen: `${PRODUCT.bin} open <file>` } : {}) });
      const key = url.searchParams.get("s") || "";
      // a page that loads (or reloads) while a Send of this file is in flight starts from what it committed (Sessions.settled)
      if (isBootstrap) return sendJson(res, 200, { session: (await sessions.settled(key), sessions.view(sessions.get(key))), product: PRODUCT.name, settings: readSettings(), suggest: suggestStatus() });
      // per-machine settings and the background image: not tied to a session, so any tab (a read-only one too) may use them
      if (p === "/api/settings" || p.startsWith("/api/background")) return await settingsRoute(req, res, p);
      // own stamps are per machine too: a list of {label, words} the person typed, any tab may use it
      if (p === "/api/stamps") return await stampsRoute(req, res);
      // writing preferences: per machine like settings (any tab may use them); a fixed list of ids plus up to 280 typed characters
      if (p === "/api/style") {
        if (req.method === "GET") return sendJson(res, 200, readStyle());
        if (req.method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
        return sendJson(res, 200, writeStyle(await readJson(req, 16 * 1024)));
      }
      // learning and the voice guide: per machine like the preferences. GET is ids, numbers and the person's own guide; a POST takes a
      // trait id and an action, the guide, or a switch, never text for a suggestion. Browser only: the CLI socket has no such route.
      if (p === "/api/voice") return req.method === "GET" ? sendJson(res, 200, voiceState()) : sendJson(res, 405, { error: "method not allowed" });
      if (VOICE_POSTS.includes(p)) {
        if (req.method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
        return sendJson(res, 200, voicePost(p, await readJson(req, p === "/api/voice/guide" ? GUIDE_BODY_MAX : 16 * 1024)));
      }
      // the deeper-check setup is per machine, like settings: any tab may start it (a read-only one too). It takes no parameters.
      if (p === "/api/setup-checker") return await setupCheckerRoute(req, res);
      // the same for quick fixes (src/suggest.js): turning on Apple's built-in model for quick fixes, only when the person pressed the button
      if (p === "/api/setup-rewriter") return await setupCheckerRoute(req, res, { start: startSetupRewriter, status: setupRewriterStatus });
      const tab = String(req.headers["x-onionskin-tab"] || url.searchParams.get("tab") || "").slice(0, 64);
      if (isEvents) return events(req, res, key, tab);
      const s = sessions.get(key);
      tabSeen.set(key, Date.now());
      if (req.method === "GET" && p === "/api/file") {
        const { bytes, diskSha, mdRev } = sessions.loadForPage(key); // records an outside change the user is taking (history)
        warm(s);
        secure(res);
        // a Markdown file: the revision number of these bytes (anchors name it with the sha256)
        res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": bytes.length, "X-Sha256": diskSha, ...(mdRev != null ? { "X-Revision": String(mdRev) } : {}) });
        return res.end(bytes);
      }
      if (req.method === "GET" && p === "/api/html-view") {
        // an HTML file's render copy and what the page needs with it, in one binary body (src/html-envelope.js); never text/html (R12)
        const v = await sessions.htmlView(key, { plain: url.searchParams.get("plain") === "1" });
        warm(s);
        const [prefix, copy] = encodeHtmlView({ version: v.sha, plain: v.plain, reason: v.reason, stats: v.stats, texts: v.texts, editable: v.editable, ident: v.ident, copy: v.bytes });
        secure(res);
        res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": prefix.length + copy.length, "X-Sha256": v.sha });
        res.write(prefix);
        return res.end(copy);
      }
      if (req.method === "GET" && p === "/api/stale") return sendJson(res, 200, sessions.staleCheck(key, url.searchParams.get("sha") || ""));
      if (req.method === "GET" && p === "/api/history") return sendJson(res, 200, await sessions.history(key));
      if (req.method === "GET" && p.startsWith("/api/history/")) return sendJson(res, 200, await sessions.historyUpdate(key, decodeUriPart(p.slice("/api/history/".length)).slice(0, 64)));
      if (req.method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
      // the preview of a quick change (src/quick-plan.js): read only, so no editor claim; it answers for the file as it is on disk now
      if (p === "/api/quick") return sendJson(res, 200, await quickPreview(s, String((await readJson(req, 8 * 1024))?.note ?? "")));
      // "Build my voice guide" (src/voice-learn.js): the editing tab only, with its own body cap (five 20 MB files in base64 plus 1 MB)
      if (p === "/api/voice/build") {
        sessions.requireEditor(key, tab);
        const body = await readJson(req, VOICE_BUILD_MAX_BODY);
        await buildVoiceRequest(sessions, key, body);
        return sendJson(res, 200, { ok: true, session: sessions.view(s) });
      }
      // starts the writing helper of quick fixes if it is cold (src/suggest.js); carries no text, changes nothing
      if (p === "/api/suggest/warm") return sendJson(res, 200, (await readJson(req, 1024), warmSuggest()));
      // the export and the agent's buttons take ids only; a draft carries no document, so it is held to the cap of a request's own data
      const bodyMax =
        p === "/api/export-tracked" || p === "/api/agent" ? 1024 :
        p === "/api/suggest" ? 8 * 1024 :
        META_ROUTES.has(p) ? 16 * 1024 :
        p === "/api/draft" || p === "/api/handover" ? REQUEST_MAX :
        MAX_BODY;
      const body = await readJson(req, bodyMax, p === "/api/draft" || p === "/api/handover" ? tooLarge("This draft") : null);
      // a Send or a quick fix's Use carries the document too: their comments, note, typed edits and view state are held to the same cap
      if ((p === "/api/send" || p === "/api/suggest/use") && requestSize([body.comments, body.note, body.edits, body.viewState, body.htmlEdits, body.mdEdit]) > REQUEST_MAX) throw tooLarge(p === "/api/send" ? "This Send" : "This request");
      if (p === "/api/claim" && !/^[\w-]{6,64}$/.test(tab)) return sendJson(res, 400, { error: "a tab id is required" });
      if (p === "/api/claim") return sendJson(res, 200, { ok: sessions.claimEditor(key, tab, { takeover: body.takeover === true }), session: sessions.view(s) });
      // the tab that just lost editing hands over its unsaved words (Sessions.handOver checks that it is that tab), in the file's turn
      if (p === "/api/handover") return sendJson(res, 200, { ok: true, session: (await sessions.inTurn(key, () => sessions.handOver(key, tab, { comments: body.comments, note: body.note, base: body.base, baseSeq: body.baseSeq, noteRev: body.noteRev })), sessions.view(s)) });
      if (p !== "/api/resolve") sessions.requireEditor(key, tab);
      // the background agent's buttons: a fixed action, and for `use` a CLI name, for `show` a switch. No path or text is accepted.
      if (p === "/api/agent") {
        const AGENT_ACTIONS = ["start", "stop", "use", "show", "terminal"];
        if (!AGENT_ACTIONS.includes(body.action)) return sendJson(res, 400, { error: `action must be one of ${AGENT_ACTIONS.join(", ")}` });
        if (body.action === "use" && body.cli !== "claude") return sendJson(res, 400, { error: "only Claude Code runs as the background agent in this version" });
        if (body.action === "show" && typeof body.on !== "boolean") return sendJson(res, 400, { error: "on must be true or false" });
        if (body.takeBack !== undefined && (body.action !== "stop" || typeof body.takeBack !== "boolean")) return sendJson(res, 400, { error: "takeBack goes with stop only, as true or false" });
        // stop with takeBack: the page's Stop. The batch comes back to drafts first, then the agent that held it is stopped (src/agent-runner.js)
        await agent.action(key, { action: body.action, cli: body.cli, on: body.on, takeBack: body.takeBack === true });
        return sendJson(res, 200, { ok: true, session: sessions.view(s) });
      }
      // a draft save, an answer and Take back run in this file's turn: one that arrives while a Send is in flight waits for it (Sessions.inTurn)
      if (p === "/api/draft") return sendJson(res, 200, { ok: true, session: (await sessions.setDraftAsync(key, { comments: body.comments, note: body.note, rev: body.rev, noteRev: body.noteRev, seen: body.seen, noteSeen: body.noteSeen, tab }), sessions.view(s)) });
      // a tap on a question card: an index (or null for "Something else"), never option text; checked against what the server stored
      if (p === "/api/answer") return sendJson(res, 200, { ok: true, session: (await sessions.inTurn(key, () => sessions.answer(key, { id: String(body.id || ""), choice: body.choice })), sessions.view(s)) });
      // review first (src/review.js): a button's kind, then taps on its cards (ids and an integer, never text)
      if (p === "/api/review") return sendJson(res, 200, { ok: true, session: (await sessions.inTurn(s.key, () => sessions.requestReview(key, body.kind)), sessions.view(s)) });
      if (p === "/api/suggestion") return sendJson(res, 200, { ok: true, session: (await sessions.inTurn(s.key, () => sessions.answerSuggestions(key, { ids: body.ids, choice: body.choice })), sessions.view(s)) });
      // quick fixes (src/suggest.js): asking writes nothing; Use names the stored suggestion by id and writes it on this Mac
      if (p === "/api/suggest") return sendJson(res, 200, await suggest(sessions, key, body));
      if (p === "/api/suggest/use") return sendJson(res, 200, { ok: true, session: (await useSuggestion(sessions, key, { ...body, tab }), sessions.view(s)) });
      if (p === "/api/send") {
        const bytes = typeof body.bytesB64 === "string" ? Buffer.from(body.bytesB64, "base64") : null;
        // an HTML file's text edits (PLAN-html R9) come as {nodeId, versionSha, baseTextHash, newText}, never as bytes
        await sessions.sendAsync(key, { baseSha: String(body.baseSha || ""), bytes, comments: body.comments, note: body.note, edits: body.edits, htmlEdits: body.htmlEdits, mdEdit: body.mdEdit, viewState: body.viewState, quick: body.quick, rev: body.rev, noteRev: body.noteRev, seen: body.seen, noteSeen: body.noteSeen, sends: body.sends, tab });
        warm(s);
        return sendJson(res, 200, { ok: true, session: sessions.view(s) });
      }
      if (p === "/api/merge") {
        const bytes = typeof body.bytesB64 === "string" ? Buffer.from(body.bytesB64, "base64") : null;
        const r = await sessions.mergeUserEdits(key, { baseSha: String(body.baseSha || ""), bytes, edits: body.edits });
        warm(s);
        return sendJson(res, 200, { ok: true, ...r, session: sessions.view(s) });
      }
      if (p === "/api/takeback") return sendJson(res, 200, { ok: true, session: (await sessions.inTurn(key, () => sessions.takeBack(key)), sessions.view(s)) });
      if (p === "/api/revert") return sendJson(res, 200, { ok: true, session: (await sessions.revertAsync(key, String(body.id || "")), warm(s), sessions.view(s)) });
      if (p === "/api/resolve") return sendJson(res, 200, await sessions.resolveAllAsync(key));
      if (p === "/api/export-tracked") return sendJson(res, 200, await sessions.exportTracked(key, String(body.id || "").slice(0, 64)));
      if (p === "/api/show-copy") return sendJson(res, 200, sessions.showCopy(String(body.path || "")));
      if (p === "/api/dismiss-conflict") return sendJson(res, 200, { ok: true, session: (sessions.dismissConflict(key), sessions.view(s)) });
      if (p === "/api/close") return sendJson(res, 200, { ok: true, session: (sessions.close(key), sessions.view(s)) });
      return sendJson(res, 404, { error: "not found" });
    } catch (err) {
      fail(res, err);
    }
  }

  async function settingsRoute(req, res, p) {
    if (p === "/api/settings" && req.method === "GET") return sendJson(res, 200, { ...readSettings(), presets: BG_PRESETS });
    if (p === "/api/background" && req.method === "GET") {
      const img = readCustomImage();
      if (!img) return sendJson(res, 404, { error: "no custom image" });
      secure(res);
      res.writeHead(200, { "Content-Type": img.mime, "Content-Length": img.bytes.length });
      return res.end(img.bytes);
    }
    if (req.method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
    if (p === "/api/settings") {
      const body = await readJson(req, 64 * 1024);
      return sendJson(res, 200, writeBackground(body.background));
    }
    if (p === "/api/background") {
      // JSON {bytesB64}: the browser never names a path. The cap is the 15 MB image in base64 plus the envelope.
      const body = await readJson(req, Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 1024);
      const bytes = typeof body.bytesB64 === "string" ? Buffer.from(body.bytesB64, "base64") : null;
      const saved = saveCustomImage(bytes);
      return sendJson(res, 200, writeBackground({ ...(body.background && typeof body.background === "object" ? body.background : saved.background), kind: "custom" }));
    }
    if (p === "/api/background/remove") return sendJson(res, 200, removeCustomImage());
    return sendJson(res, 404, { error: "not found" });
  }

  /** GET: the list. POST {stamps}: replace the whole list or refuse it (400); nothing is trimmed to fit. */
  async function stampsRoute(req, res) {
    if (req.method === "GET") return sendJson(res, 200, { stamps: readStamps() });
    if (req.method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
    const body = await readJson(req, 16 * 1024);
    if (Object.keys(body).some((k) => k !== "stamps")) return sendJson(res, 400, { error: "only stamps can be sent" });
    return sendJson(res, 200, { stamps: writeStamps(body.stamps) });
  }

  /** GET: where the setup is. POST: start it (or join the one running) and answer at once; the page polls GET. Nothing from the request is used. */
  async function setupCheckerRoute(req, res, { start = startSetupChecker, status = setupCheckerStatus } = {}) {
    if (req.method === "POST") {
      await readJson(req, 1024); // drained and checked as JSON, never read
      start();
    } else if (req.method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
    return sendJson(res, 200, await status());
  }

  function dropSse(key, res) {
    const set = sse.get(key);
    if (!set) return;
    if (set.delete(res)) tabSeen.set(key, Date.now());
    if (!set.size) sse.delete(key);
  }
  function writeSse(key, res, chunk) {
    try {
      res.write(chunk);
      return true;
    } catch {
      dropSse(key, res);
      try { res.destroy(); } catch {}
      return false;
    }
  }
  function events(req, res, key, tab) {
    const s = sessions.get(key);
    const hasTab = /^[\w-]{6,64}$/.test(tab);
    if (hasTab) sessions.claimEditor(key, tab);
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      if (hasTab) sessions.releaseEditor(key, tab);
      dropSse(key, res);
    };
    req.on("close", cleanup);
    res.on("error", cleanup);
    res.on("close", cleanup);
    secure(res);
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
    if (!sse.has(key)) sse.set(key, new Set());
    sse.get(key).add(res);
    tabSeen.set(key, Date.now());
    writeSse(key, res, `event: state\ndata: ${JSON.stringify(sessions.view(s))}\n\n`);
  }
  sessions.on("change", (s, event) => {
    const set = sse.get(s.key);
    if (!set?.size) return;
    const view = JSON.stringify(sessions.view(s));
    for (const res of [...set]) {
      if (event === "reload" && !writeSse(s.key, res, `event: reload\ndata: ${view}\n\n`)) continue;
      writeSse(s.key, res, `event: state\ndata: ${view}\n\n`);
    }
  });

  // ---- CLI side (unix socket) ------------------------------------------------------------------------------
  async function cli(req, res) {
    lastActivity = Date.now();
    try {
      const url = new URL(req.url, "http://x");
      const p = url.pathname;
      if (p === "/health") return sendJson(res, 200, { ok: true, pid: process.pid, protocol: SERVER_PROTOCOL, sessions: sessions.map.size });
      if (req.method === "POST" && p === "/cli/open") {
        const { file, agent: wants, holder: h } = await readJson(req);
        const holder = typeof h === "string" ? h : undefined;
        const real = pinFile(String(file || ""), holder); // a bound agent: not_your_file, on the real file, before anything is read
        const opts = { agent: wants === "background" ? "background" : undefined };
        const s = await sessions.openAsync(real ?? String(file || ""), real ? { ...opts, pinned: true } : opts);
        checkBinding(s.file, holder); // backstop on the session opened: no link for another file
        if (wants === "background") agent.ensure(s.key); // a person opened it from a terminal: the background agent works on it
        const nonce = auth.newNonce();
        return sendJson(res, 200, { key: s.key, url: `${auth.origin}/?s=${s.key}&n=${nonce}`, state: sessions.state(s), name: path.basename(s.file) });
      }
      if (req.method === "GET" && p === "/cli/status") {
        return sendJson(res, 200, cliStatus(sessions, sessionFor(sessions, url.searchParams.get("file") || "", url.searchParams.get("holder"))));
      }
      if (req.method === "GET" && p === "/cli/open-work") {
        // what `onionskin update` would cut off by restarting the server: counts only, no file names
        return sendJson(res, 200, openWork(sessions, { tabs: tabsOf, seen: (key) => tabSeen.get(key) ?? null }));
      }
      if (req.method === "GET" && p === "/cli/batch-file") {
        // which file a delivered batch belongs to (for `reply --lease <ticket>` without a file): only for the whole ticket (batch id and token)
        return sendJson(res, 200, { file: batchFile(sessions, claimOfQuery(url.searchParams)) });
      }
      if (req.method === "GET" && p === "/cli/batch") {
        // the batch delivered to the agent (anchors for `apply`); with a claim, only for the lease holder (src/local.js cliBatch)
        const claim = claimOfQuery(url.searchParams);
        return sendJson(res, 200, cliBatch(sessions, sessionFor(sessions, url.searchParams.get("file") || "", claim.holder), claim));
      }
      if (req.method === "POST" && p === "/cli/agent-write") {
        const body = await readJson(req);
        const s = sessionFor(sessions, String(body.file || ""), body.holder);
        const bytes = typeof body.bytes_b64 === "string" ? Buffer.from(body.bytes_b64, "base64") : null;
        // `ops` is what apply ran to make these bytes: kept for a later merge, which checks it against the bytes before relying on it
        return sendJson(res, 200, await sessions.agentWriteChecked(s.key, { baseSha: String(body.base_sha256 || ""), bytes, route: "apply", ops: Array.isArray(body.ops) ? body.ops : null, partial: body.partial === true, ...leaseOf(body) }));
      }
      if (req.method === "POST" && p === "/cli/commit") {
        // candidate bytes made elsewhere (a copy edited with python-docx and so on): same lease check, compare-and-swap, snapshot and atomic replace as apply.
        // Without base_sha256 the base is the hash this server last wrote or delivered for the batch.
        const body = await readJson(req);
        const s = sessionFor(sessions, String(body.file || ""), body.holder);
        const bytes = typeof body.bytes_b64 === "string" ? Buffer.from(body.bytes_b64, "base64") : null;
        const baseSha = typeof body.base_sha256 === "string" && body.base_sha256 ? body.base_sha256 : null;
        return sendJson(res, 200, await sessions.agentWriteChecked(s.key, { baseSha, bytes, label: "before agent commit", ...leaseOf(body) }));
      }
      if (req.method === "POST" && p === "/cli/apply-report") {
        const body = await readJson(req);
        const s = sessionFor(sessions, String(body.file || ""), body.holder);
        return sendJson(res, 200, sessions.noteApply(s.key, {
          ...leaseOf(body), run: typeof body.run === "string" ? body.run : "",
          problems: Array.isArray(body.problems) ? body.problems : [], applied: Array.isArray(body.applied) ? body.applied.filter((k) => typeof k === "string") : [],
        }));
      }
      if (req.method === "GET" && p === "/cli/poll") {
        const f = url.searchParams.get("file") || "";
        const real = pinFile(f, url.searchParams.get("holder")); // the binding, on the real file, before it is looked up or opened
        let handle;
        res.once("close", () => handle?.cancel());
        let s;
        try {
          s = sessions.byFile(real ?? f);
        } catch {
          s = await sessions.openAsync(real ?? f, real ? { pinned: true } : {}); // a poller may start before (or after a server restart without) `open`
        }
        checkBinding(s.file, url.searchParams.get("holder")); // backstop: the session found is the bound file's
        await sessions.outlineAhead(s.key, url.searchParams.get("holder") || "agent"); // the outline a delivery carries, built off this thread
        if (res.destroyed) return;
        handle = sessions.poll(s.key, { ack: url.searchParams.get("ack") === "1", holder: url.searchParams.get("holder") || "agent", full: url.searchParams.get("full") === "1", compact: url.searchParams.get("compact") === "1" });
        const out = await handle.promise;
        if (res.destroyed) return;
        return sendJson(res, 200, out);
      }
      if (req.method === "POST" && p === "/cli/done") {
        const body = await readJson(req);
        const s = sessionFor(sessions, String(body.file || ""), body.holder);
        return sendJson(res, 200, await finishRun(s.key, body.results, leaseOf(body)));
      }
      if (req.method === "POST" && p === "/cli/stop") {
        sendJson(res, 200, { ok: true });
        // a deliberate stop ends every waiting poll with "closed" first; otherwise the poll would see a lost connection and start the server again
        for (const s of sessions.map.values()) for (const w of s.pollers.splice(0)) w.resolve({ status: "closed", reason: "the server was stopped" });
        setTimeout(() => shutdown(), 100);
        return;
      }
      return sendJson(res, 404, { error: "not found" });
    } catch (err) {
      fail(res, err);
    }
  }

  // ---- listen ----------------------------------------------------------------------------------------------
  const sock = socketPath();
  let tcp, unix, tcpPort;
  await withStartLock(async () => {
    if (fs.existsSync(sock)) {
      const health = () =>
        new Promise((resolve) => {
          const r = http.get({ socketPath: sock, path: "/health", timeout: 1000 }, (x) => {
            let t = "";
            x.on("data", (d) => (t += d));
            x.on("end", () => {
              let protocol = null;
              try {
                protocol = JSON.parse(t).protocol;
              } catch {}
              resolve(x.statusCode === 200 ? { protocol } : null);
            });
          });
          r.on("error", () => resolve(null));
          r.on("timeout", () => (r.destroy(), resolve(null)));
        });
      let other = await health();
      if (other && other.protocol !== SERVER_PROTOCOL) {
        // a server left running by another build (an upgrade): it cannot serve this CLI. Ask it to stop, then take its place; its sessions are in the state dir and load here.
        await new Promise((resolve) => {
          const r = http.request({ socketPath: sock, method: "POST", path: "/cli/stop", headers: { "content-type": "application/json" }, timeout: 2000 }, (x) => (x.resume(), x.on("end", resolve)));
          r.on("error", resolve);
          r.on("timeout", () => (r.destroy(), resolve()));
          r.end("{}");
        });
        for (let i = 0; i < 40 && other; i++) {
          await new Promise((r) => setTimeout(r, 100));
          other = fs.existsSync(sock) ? await health() : null;
        }
        if (other) throw new Error("a server from another Onionskin version is running and did not stop; end it and try again");
      } else if (other) throw Object.assign(new Error("a server is already running"), { code: "EALREADY" });
      if (fs.existsSync(sock)) fs.unlinkSync(sock);
    }
    await agent.reapOrphans(); // this server owns the state dir now: agents a crashed predecessor left behind are stopped
    tcp = http.createServer(browser);
    await new Promise((resolve, reject) => (tcp.once("error", reject), tcp.listen(port, "127.0.0.1", resolve)));
    tcpPort = tcp.address().port;
    auth = new BrowserAuth(tcpPort);
    unix = http.createServer(cli);
    await new Promise((resolve, reject) => (unix.once("error", reject), unix.listen(sock, resolve)));
    fs.chmodSync(sock, 0o600);
    writeStateFile(serverRecordPath(), JSON.stringify({ pid: process.pid, port: tcpPort, protocol: SERVER_PROTOCOL }));
    warmAnchors(); // the anchor worker starts now, so the first Send does not wait for it
  });

  const idleMs = Number(env("IDLE_MS", 2 * 60 * 60 * 1000));
  const timer = setInterval(() => {
    sessions.tick();
    agent.tick();
    for (const [k, set] of [...sse]) for (const r of [...set]) writeSse(k, r, ": ping\n\n");
    // the background agent's own polls do not keep the server up (it stops after 20 minutes without a tab; then the server may stop too)
    const busy = [...sessions.map.values()].some((s) => s.pollers.some((p) => !isBgHolder(p.holder)) || s.delivered);
    if (!busy && ![...sse.values()].some((x) => x.size) && Date.now() - lastActivity > idleMs) shutdown();
  }, Number(env("TICK_MS", 1000)));

  let shuttingDown = false;
  function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(timer);
    watcher.close();
    for (const k of [...late.keys()]) cancelLate(k, "the server stopped"); // no soffice outlives the server
    stopRewriter(); // nor the local rewriter's worker
    stopVoice(); // nor a learning worker
    for (const set of sse.values()) for (const r of set) r.end();
    tcp.close();
    // only what is ours: a newer server may have taken over the socket and the record since. Closing a unix server unlinks its path
    // (libuv), so a server that no longer owns the path must not close it; the process exit below ends its connections.
    let ours = false;
    try {
      ours = JSON.parse(fs.readFileSync(serverRecordPath(), "utf8")).pid === process.pid;
    } catch {}
    if (ours) unix.close();
    tcp.closeAllConnections?.();
    unix.closeAllConnections?.();
    if (ours) {
      try {
        fs.unlinkSync(sock);
      } catch {}
      try {
        fs.unlinkSync(serverRecordPath());
      } catch {}
    }
    // no background agent outlives the server: their groups are stopped first (at most about 5 s)
    Promise.race([agent.stopAll(), sleep(5000)]).finally(() => setTimeout(() => process.exit(0), 50).unref());
  }
  return { port: tcpPort, sessions, local, agent, auth, shutdown, tcp, unix };
}
