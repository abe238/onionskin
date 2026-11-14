// Shared by user-sim.mjs, fake-agent.mjs and prepare.mjs. Everything is written inside the work directory (or a temp dir).
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const here = path.dirname(fileURLToPath(import.meta.url));
export const repo = path.resolve(here, "..", "..");
export const cliPath = path.join(repo, "src", "cli.js");
export const python = path.join(repo, ".venv", "bin", "python");
export const fixturesDir = path.join(here, ".fixtures");

/** The working file name inside <workdir> and the checks that apply to it. */
export const SCENARIOS = {
  "docx-basic": { fixture: "report.docx" },
  "xlsx-basic": { fixture: "budget.xlsx" },
  "xlsx-merged-note": { fixture: "merged.xlsx" },
  "pptx-basic": { fixture: "deck.pptx" },
  "docx-injection": { fixture: "injection.docx" },
  "docx-protected": { fixture: "protected.docx" },
  "demo-docx": { fixture: "welcome.docx" },
  "docx-note-only": { fixture: "notes.docx" },
  "docx-note-end": { fixture: "notes.docx" },
  "docx-table-row": { fixture: "report.docx" },
  "pptx-duplicate-slide": { fixture: "deck.pptx" },
};

/** Appends one timing mark (wall clock, ms) to <workdir>/timings.jsonl; bench-loop.mjs reads them. */
export const mark = (workdir, name, t = Date.now()) => fs.appendFileSync(path.join(workdir, "timings.jsonl"), JSON.stringify({ name, t }) + "\n");

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const log = (who, msg) => console.log(`[${who} ${new Date().toISOString().slice(11, 19)}] ${msg}`);

/** Creates <workdir> with the fixture copied in as the working file (idempotent). Returns {scenario, file, original, workdir}. */
export function prepare(scenario, workdir) {
  const sc = SCENARIOS[scenario];
  if (!sc) throw new Error(`unknown scenario ${scenario}; one of ${Object.keys(SCENARIOS).join(", ")}`);
  workdir = path.resolve(workdir);
  // the server listens on a unix socket inside <workdir>/state; macOS caps a socket path at 103 bytes
  if (Buffer.byteLength(path.join(workdir, "state", "s.sock")) > 100) throw new Error(`workdir path is too long for a unix socket (${workdir}); use a short one such as /tmp/rr/${scenario}`);
  fs.mkdirSync(workdir, { recursive: true });
  const meta = path.join(workdir, "scenario.json");
  if (fs.existsSync(meta)) return JSON.parse(fs.readFileSync(meta, "utf8"));
  if (!fs.existsSync(path.join(fixturesDir, sc.fixture))) {
    if (!fs.existsSync(python)) throw new Error(`the repo virtualenv is missing (${python}): python3 -m venv .venv && .venv/bin/pip install -r scripts/requirements.txt`);
    execFileSync(python, [path.join(here, "make-fixtures.py"), fixturesDir], { stdio: "inherit" });
  }
  const file = path.join(workdir, sc.fixture);
  const original = path.join(workdir, "original" + path.extname(sc.fixture));
  fs.copyFileSync(path.join(fixturesDir, sc.fixture), file);
  fs.copyFileSync(path.join(fixturesDir, sc.fixture), original);
  const info = { scenario, workdir, file, original, state_dir: path.join(workdir, "state"), url_file: path.join(workdir, "url.txt") };
  fs.writeFileSync(meta, JSON.stringify(info, null, 2));
  return info;
}

/** Env for every onionskin process of a run: an isolated state dir, so ~/.onionskin is never touched. */
// The isolated state dir has no checker virtualenv of its own, so `done` would skip the deeper check. When the real one exists under the default
// state dir (created by `onionskin setup-checker`), the run points ONIONSKIN_PYTHON at it: it is only executed, never written to.
// LibreOffice stays off (ONIONSKIN_NO_SOFFICE=1) unless REALRUN_SOFFICE=1 is set, to keep a run to seconds.
export const realCheckerPython = () => {
  const p = path.join(os.homedir(), ".onionskin", "venv", "bin", "python");
  return fs.existsSync(p) ? p : null;
};
export const runEnv = (info) => {
  const py = process.env.ONIONSKIN_PYTHON || realCheckerPython();
  return { ...process.env, ONIONSKIN_STATE_DIR: info.state_dir, ...(py ? { ONIONSKIN_PYTHON: py } : {}), ...(process.env.REALRUN_SOFFICE ? {} : { ONIONSKIN_NO_SOFFICE: "1" }) };
};

export function cli(info, args, { timeoutMs = 0 } = {}) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [cliPath, ...args], { env: runEnv(info), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    c.stdout.on("data", (d) => (stdout += d));
    c.stderr.on("data", (d) => (stderr += d));
    const t = timeoutMs ? setTimeout(() => c.kill("SIGKILL"), timeoutMs) : null;
    c.on("close", (code) => (clearTimeout(t), resolve({ code, stdout, stderr })));
  });
}

/** The delivered batch (null when none is in progress), read from the server's CLI socket. */
export function deliveredBatch(info) {
  return new Promise((resolve) => {
    const r = http.get({ socketPath: path.join(info.state_dir, "s.sock"), path: `/cli/batch?file=${encodeURIComponent(info.file)}`, timeout: 3000 }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch {
          resolve(null);
        }
      });
    });
    r.on("error", () => resolve(null));
    r.on("timeout", () => (r.destroy(), resolve(null)));
  });
}

export const tmpDir = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
