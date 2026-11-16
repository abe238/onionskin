// A small stand-in for the server half of the background agent (the runner and POST /api/agent), so the page can be tested before and apart from it.
// It sits in front of the real Onionskin server: everything passes through, except that every session the page receives (bootstrap, a route's reply,
// the live stream) carries an `agent` field, and POST /api/agent is answered here. The `agent` field has the shape the design fixes:
//   {state: none|starting|ready|working|external|failed|handover, cli, show, activity: [{at, text}], failure: null|{code, resetsAt?}, startsLeft: 0..5}
// (the same fields as src/agent-runner.js viewFor; the session fields themselves, `changedOutside` among them, come from the real server)
// Two ways to drive it: `fake.setAgent(view)` pins any view (for looking at every state), or `fake.useRunner(dir)` makes `start` really spawn the
// fake `claude` in `dir` (fake-claude.mjs) and builds the view from its stream with the page's own parser (src/agent-events.js).
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { parseLine } from "../../src/agent-events.js";
import { sessionKey } from "../../src/paths.js";
import { repo } from "./harness.mjs";

/** A folder with the fake `claude` and an `onionskin` wrapper, the way the runner's own bin folder has one. */
export function fakeClaudeDir(root) {
  const dir = path.join(root, "fakebin");
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(repo, "e2e", "helpers", "fake-claude.mjs"), path.join(dir, "fake-claude.mjs"));
  fs.writeFileSync(path.join(dir, "claude"), `#!/bin/sh\nexec "${process.execPath}" "${path.join(dir, "fake-claude.mjs")}" "$@"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "onionskin"), `#!/bin/sh\nexec "${process.execPath}" "${path.join(repo, "src", "cli.js")}" "$@"\n`, { mode: 0o755 });
  return dir;
}

const isView = (o) => o && typeof o === "object" && typeof o.key === "string" && typeof o.state === "string" && Array.isArray(o.comments);

export async function startFakeSide(world) {
  const sockets = new Set();
  const streams = new Set(); // open event streams: {res, last}
  let realPort = 0;
  const fake = { pinned: null, show: false, actions: [], runner: null, port: 0, sessionPatch: null, refuseStop: null };

  const base = () => ({ state: "none", cli: "claude", show: fake.show, activity: [], failure: null, startsLeft: 5 }); // 5: no counted start used, as the real runner says
  const agentView = () => (fake.pinned ? { ...base(), ...fake.pinned } : fake.runner ? { ...base(), ...fake.runner.view() } : base());
  // `fake.sessionPatch` ({stage: "writing"}, ...) is merged into every session view: states the real server reaches only mid-run, for looking at the page
  const patch = (o) => {
    if (isView(o)) Object.assign(o, fake.sessionPatch || {}, { agent: agentView() });
    else if (o && typeof o === "object") for (const k of ["session"]) if (isView(o[k])) Object.assign(o[k], fake.sessionPatch || {}, { agent: agentView() });
    return o;
  };
  const push = () => {
    for (const s of streams) if (s.last) s.res.write(`event: state\ndata: ${JSON.stringify(patch(structuredClone(s.last)))}\n\n`);
  };
  fake.refresh = push;
  fake.setAgent = (v) => ((fake.pinned = v), push());

  /** Starts the real fake `claude` and follows its stream. `onExit(code)` lets a test see the end. */
  fake.useRunner = (dir, file) => {
    const st = { state: "none", activity: [], failure: null, child: null, pid: null, sawResult: false, failureSeen: null };
    const add = (text) => (st.activity.push({ at: Date.now(), text }), st.activity.length > 50 && st.activity.shift());
    st.view = () => ({ state: st.state, activity: st.activity, failure: st.failure });
    st.start = () => {
      if (st.child) return;
      const mode = (() => { try { return fs.readFileSync(path.join(dir, "mode"), "utf8").trim(); } catch { return ""; } })();
      st.failure = null;
      st.state = "starting";
      st.sawResult = false;
      st.failureSeen = null;
      const c = spawn(path.join(dir, "claude"), ["-p", `You are the background agent for one document: \`${file}\`.`, "--session-id", "11111111-1111-4111-8111-111111111111"], {
        cwd: world.root,
        detached: true,
        stdio: ["ignore", "pipe", "ignore"],
        env: { HOME: process.env.HOME, PATH: `${dir}:${path.dirname(process.execPath)}:/usr/bin:/bin`, ONIONSKIN_STATE_DIR: world.state, ONIONSKIN_HOLDER: `onionskin-bg-${sessionKey(file)}`, ONIONSKIN_AGENT_DIR: world.root, ONIONSKIN_TICK_MS: "150" },
      });
      st.child = c;
      st.pid = c.pid;
      let buf = "";
      c.stdout.on("data", (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          const e = parseLine("claude", line);
          if (e.activity) add(e.activity);
          if (e.failure) st.failureSeen = e.failure;
          if (e.result) st.sawResult = true;
          if (e.activity === "Waiting for you to press Send") st.state = "ready";
          if (e.activity?.startsWith("Got your batch")) st.state = "working";
          if (e.activity?.startsWith("Done.")) st.state = "ready";
          push();
        }
      });
      c.on("exit", (code) => {
        st.child = null;
        if (st.stopping) return void ((st.stopping = false), (st.state = "none"), push()); // stopped on purpose: no failure, no restart
        if (st.failureSeen) (st.state = "failed", (st.failure = { code: st.failureSeen }));
        else if (code === 0 && st.sawResult) st.state = "none";
        else (st.state = "failed", (st.failure = { code: "crashed" }));
        push();
      });
      push();
    };
    st.stop = () => {
      if (!st.child) return;
      st.stopping = true;
      st.state = "none"; // the real runner shows a stopped agent as none at once, while its process is still exiting
      if (st.child) try { process.kill(-st.child.pid, "SIGTERM"); } catch {}
    };
    fake.runner = st;
    return st;
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/api/agent" && req.method === "POST") {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        let j = {};
        try { j = JSON.parse(body); } catch {}
        fake.actions.push(j);
        if (j.action === "show") fake.show = !!j.on;
        if (j.action === "start") fake.runner?.start();
        if (j.action === "stop") {
          // The server half of Stop (docs: POST /api/agent {action:"stop", takeBack:true}): refused as a 4xx from a tab that is not the editor, else the
          // batch is taken back (the real server does that), the agent shows "none" at once (its activity kept) and the answer carries the session, like
          // the real `{ok, session}`. `fake.refuseStop` = a status code to answer instead (the real refusal is 409 not_editor).
          if (fake.refuseStop) {
            res.writeHead(fake.refuseStop, { "content-type": "application/json" });
            return void res.end(JSON.stringify({ error: "This file is open for editing in another tab. Use Edit here instead to take over.", code: "not_editor" }));
          }
          const done = () => {
            if (fake.pinned) fake.pinned = { ...fake.pinned, state: "none" };
            fake.runner?.stop();
            const boot = http.request({ host: "127.0.0.1", port: realPort, path: `/api/bootstrap?${url.searchParams}`, headers: rewrite(req.headers) }, (r) => {
              let t = "";
              r.on("data", (d) => (t += d));
              r.on("end", () => {
                let session = null;
                try { session = JSON.parse(t).session; } catch {}
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: true, session: session ? patch(session) : null }));
                push();
              });
            });
            boot.on("error", () => res.destroy());
            boot.end();
          };
          if (!j.takeBack) return done();
          const tb = http.request({ host: "127.0.0.1", port: realPort, path: `/api/takeback?${url.searchParams}`, method: "POST", headers: { ...rewrite(req.headers), "content-length": 2 } }, (r) => (r.resume(), r.on("end", done)));
          tb.on("error", () => res.destroy());
          return void tb.end("{}");
        }
        const fwd = http.request({ host: "127.0.0.1", port: realPort, path: `/api/bootstrap?${url.searchParams}`, headers: rewrite(req.headers) }, (r) => {
          let t = "";
          r.on("data", (d) => (t += d));
          r.on("end", () => {
            let session = null;
            try { session = JSON.parse(t).session; } catch {}
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true, session: session ? patch(session) : null }));
            push();
          });
        });
        fwd.end();
      });
      return;
    }
    const fwd = http.request({ host: "127.0.0.1", port: realPort, path: req.url, method: req.method, headers: rewrite(req.headers) }, (r) => {
      const type = String(r.headers["content-type"] || "");
      if (type.startsWith("text/event-stream")) {
        res.writeHead(r.statusCode, r.headers);
        const entry = { res, last: null };
        streams.add(entry);
        let buf = "";
        r.on("data", (d) => {
          buf += d;
          let i;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const m = block.match(/^event: (\w+)\ndata: (.*)$/s);
            if (!m) { res.write(block + "\n\n"); continue; }
            const o = JSON.parse(m[2]);
            entry.last = structuredClone(o);
            res.write(`event: ${m[1]}\ndata: ${JSON.stringify(patch(o))}\n\n`);
          }
        });
        res.on("close", () => (streams.delete(entry), r.destroy()));
        return;
      }
      if (type.startsWith("application/json")) {
        let t = "";
        r.on("data", (d) => (t += d));
        r.on("end", () => {
          let out = t;
          try { out = JSON.stringify(patch(JSON.parse(t))); } catch {}
          const h = { ...r.headers };
          delete h["content-length"];
          res.writeHead(r.statusCode, h);
          res.end(out);
        });
        return;
      }
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
    });
    fwd.on("error", () => res.destroy());
    req.pipe(fwd);
  });
  const rewrite = (h) => ({ ...h, host: `127.0.0.1:${realPort}`, ...(h.origin ? { origin: `http://127.0.0.1:${realPort}` } : {}), ...(h.referer ? { referer: String(h.referer).replace(/:\d+\//, `:${realPort}/`) } : {}) });
  server.on("connection", (s) => (sockets.add(s), s.on("close", () => sockets.delete(s))));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  fake.port = server.address().port;
  /** The page URL from `world.open`, pointed at this stand-in. */
  fake.url = (realUrl) => {
    const u = new URL(realUrl);
    realPort = Number(u.port);
    u.port = String(fake.port);
    return u.toString();
  };
  /** Nothing listens on the page's port until `up()`: connections are refused (the real server behind stays up, with the same token). */
  fake.down = async () => {
    for (const s of streams) s.res.end();
    for (const s of sockets) s.destroy();
    await new Promise((r) => server.close(r));
  };
  fake.up = () => new Promise((r) => server.listen(fake.port, "127.0.0.1", r));
  fake.stop = async () => {
    fake.runner?.stop();
    for (const s of streams) s.res.end();
    for (const s of sockets) s.destroy();
    await new Promise((r) => server.close(r));
  };
  return fake;
}
