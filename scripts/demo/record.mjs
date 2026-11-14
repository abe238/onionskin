#!/usr/bin/env node
// Turns one finished demo-docx run (scripts/real-run, a real agent) into the recording the Try-it page replays.
//   node scripts/demo/record.mjs <WORKDIR> --agent "<label>" [--out <folder>] [--test]
// Writes <out>/{v0.docx, v1.docx, recording.json} (default web/demo/recording) and nothing else, and only when every check and the scan
// (scan.mjs) pass. recording.json is built field by field from an allow-list; nothing from the session is copied wholesale, so ids,
// paths, keys, lease holders and tokens cannot reach it. v0.docx and v1.docx are repacked canonically (canonical.mjs): the parts'
// content and order are the run's, every ZIP header field that is not content is a fixed constant, and the hashes in recording.json are
// those of the repacked files, which are the files the page carries. A run answered by fake-agent.mjs is refused unless --test, which writes
// `real: false` and may not write to the default folder. Reads the run's own state folder directly: ~/.onionskin is never opened.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { untrusted } from "../../src/sanitize.js";
import { ZipError } from "../../src/zip.js";
import { canonicalZip } from "./canonical.mjs";
import { DEMO } from "./demo-scenario.mjs";
import { CAPS, FILES, SCHEMA, localIdentity, placesFor, scanRecording, stringProblem } from "./scan.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_OUT = path.resolve(here, "..", "..", "web", "demo", "recording");
const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");

export class RecordError extends Error {
  constructor(problems) {
    super(problems.join("\n"));
    this.problems = problems;
  }
}
const refuse = (...problems) => {
  throw new RecordError(problems);
};

const readJson = (f, what) => {
  try {
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch {
    return refuse(`${what} is missing or not valid JSON`);
  }
};
/** The local calendar day of a time stamp: the day the run happened, nothing finer. */
const day = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/**
 * Reads the run and returns {recording, v0, v1} in memory, scanned. Throws RecordError with plain reasons when anything is off.
 * `identity` (names that must not appear) is injectable for tests.
 */
export function buildRecording(workdir, { agent, test = false, identity = localIdentity() } = {}) {
  workdir = path.resolve(workdir);
  const info = readJson(path.join(workdir, "scenario.json"), "scenario.json");
  if (info.scenario !== DEMO.scenario) refuse(`this run is not the ${DEMO.scenario} scenario`);
  const ev = readJson(path.join(workdir, "evidence.json"), "evidence.json");

  // fail closed on the stand-in agent: only an explicit `fake: false` and no marker count as a real run
  const fake = ev.fake !== false || fs.existsSync(path.join(workdir, "fake-agent.marker"));
  if (fake && !test) refuse("this run was answered by the stand-in agent (or does not say it was not); a recording of it can never be shown as real");
  const agentProblem = stringProblem(agent, identity, CAPS.agent);
  if (!agent || agentProblem) refuse(`--agent must name the agent in plain words${agent ? ` (it ${agentProblem})` : ""}`);

  // the session of the run's working file, from the run's own state folder
  const state = path.join(workdir, "state");
  const sessDir = path.join(state, "sessions");
  let real;
  try {
    real = fs.realpathSync(info.file);
  } catch {
    refuse("the run's working file is missing");
  }
  const sessions = (fs.existsSync(sessDir) ? fs.readdirSync(sessDir) : [])
    .filter((f) => /^[0-9a-f]{16}\.json$/.test(f))
    .map((f) => readJson(path.join(sessDir, f), "a session file"))
    .filter((s) => s.file === real);
  if (sessions.length !== 1) refuse("the run's session was not found");
  const s = sessions[0];
  if (!/^[0-9a-f]{16}$/.test(s.key || "") || s.format !== "docx") refuse("the run's session is not a Word session");
  const snapshot = (sha) => {
    if (!/^[0-9a-f]{64}$/.test(sha || "")) refuse("a version is not named by its hash");
    const f = path.join(state, "snapshots", s.key, `${sha}.bin`);
    if (!fs.existsSync(f)) refuse("a stored version of the letter is missing");
    const b = fs.readFileSync(f);
    if (sha256(b) !== sha) refuse("a stored version of the letter does not match its hash");
    return b;
  };

  // exactly one agent run, reverted, and one Revert that put back the bytes from before it
  const act = Array.isArray(s.activity) ? s.activity : [];
  const runs = act.filter((a) => a.kind === "agent");
  const reverts = act.filter((a) => a.kind === "revert");
  if (act.length !== 2 || runs.length !== 1 || reverts.length !== 1) refuse("the run must hold exactly one agent run and one Revert, and nothing else");
  const [run, rev] = [runs[0], reverts[0]];
  if (act[0] !== rev) refuse("the Revert must come after the agent run");
  if (run.reverted !== true) refuse("the agent run was not reverted");
  if (rev.postSha !== run.preSha) refuse("the Revert did not put back the version from before the agent run");
  if ((run.flags || []).some((f) => f.severity === "error") || run.revertRecommended) refuse("the checks found a problem with the agent's run");
  const src0 = snapshot(run.preSha);
  const src1 = snapshot(run.postSha);
  if (run.preSha === run.postSha) refuse("the agent did not change the letter");
  // the run's own copy of the letter must be there: a missing copy is refused, never skipped
  if (typeof info.original !== "string" || !fs.existsSync(info.original)) refuse("the letter the run started from is missing");
  if (sha256(fs.readFileSync(info.original)) !== run.preSha) refuse("the version before the agent run is not the letter the run started from");
  // the provenance checks above are on the run's own bytes; from here on only the canonical repack is used, scanned and written
  let v0, v1;
  try {
    [v0, v1] = [canonicalZip(src0), canonicalZip(src1)];
  } catch (err) {
    if (!(err instanceof ZipError)) throw err;
    refuse(`a version of the letter could not be repacked (${err.message})`);
  }

  // the person's side: the scenario's comments in order, and the overall note the batch carried
  const comments = Array.isArray(s.comments) ? s.comments : [];
  if (comments.length !== DEMO.comments.length || comments.some((c, i) => c.kind !== "text" || c.text !== DEMO.comments[i].text)) refuse("the comments are not the scenario's comments");
  if (ev.overall_note !== DEMO.overall || ev.batch?.instructions?.overall_note !== DEMO.overall) refuse("the overall note is not the scenario's note");
  const results = Array.isArray(run.results) ? run.results : [];
  const notes = comments.map((c, i) => {
    const mine = results.filter((x) => x.comment_id === c.id);
    if (mine.length !== 1 || !["done", "declined"].includes(mine[0].status)) refuse(`comment ${i + 1} was not answered exactly once`);
    return { n: i + 1, status: mine[0].status, note: untrusted(mine[0].note, CAPS.note) };
  });

  const t = ev.timing || {};
  let places;
  try {
    places = placesFor(v0, v1);
  } catch (err) {
    refuse(err.message);
  }
  if (!Number.isFinite(run.at)) refuse("the agent run has no time");

  // the allow-list: every field named here, every string cleaned; nothing else exists in the output
  const recording = {
    schema: SCHEMA,
    real: !test && !fake,
    agent: untrusted(agent, CAPS.agent),
    date: day(run.at),
    format: "docx",
    v0_sha256: sha256(v0),
    v1_sha256: sha256(v1),
    comments: comments.map((c, i) => ({
      n: i + 1,
      text: untrusted(c.text, CAPS.comment),
      quote: untrusted(c.anchor?.quote, CAPS.quote),
      prefix: untrusted(c.anchor?.prefix, CAPS.quote),
      suffix: untrusted(c.anchor?.suffix, CAPS.quote),
    })),
    overall_note: untrusted(DEMO.overall, CAPS.comment),
    result: { summary: untrusted(run.summary, CAPS.summary), notes },
    places,
    timing: { working_ms: t.working_ms, result_ms: t.result_ms },
  };
  const problems = scanRecording({ recording, v0, v1 }, { identity, test });
  if (problems.length) refuse(...problems);
  return { recording, v0, v1 };
}

/** Writes the three files into `out` (made if missing). Refuses to replace an earlier recording. Nothing is left behind on failure. */
export function writeRecording(out, { recording, v0, v1 }) {
  const there = FILES.filter((f) => fs.existsSync(path.join(out, f)));
  if (there.length) refuse(`${out} already holds a recording; move it away first`);
  fs.mkdirSync(out, { recursive: true });
  const written = [];
  try {
    for (const [f, data] of [["v0.docx", v0], ["v1.docx", v1], ["recording.json", JSON.stringify(recording, null, 2) + "\n"]]) {
      fs.writeFileSync(path.join(out, f), data, { flag: "wx" });
      written.push(f);
    }
  } catch (err) {
    for (const f of written) fs.rmSync(path.join(out, f), { force: true });
    throw err;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (k) => {
    const i = args.indexOf(k);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const test = args.includes("--test");
  const workdir = args.find((a, i) => !a.startsWith("--") && !["--agent", "--out"].includes(args[i - 1]));
  if (!workdir) (console.error('usage: record.mjs <WORKDIR> --agent "<label>" [--out <folder>] [--test]'), process.exit(2));
  const out = path.resolve(opt("--out") || DEFAULT_OUT);
  try {
    if (test && out === DEFAULT_OUT) refuse("--test recordings may not be written to web/demo/recording; pass --out with another folder");
    const rec = buildRecording(workdir, { agent: opt("--agent"), test });
    writeRecording(out, rec);
    console.log(`Recording written to ${out}${rec.recording.real ? "" : " (test agent, real: false: it can never be built for showing)"}`);
  } catch (err) {
    if (!(err instanceof RecordError)) throw err;
    console.error(`Nothing was written. ${err.problems.length} problem(s):`);
    for (const p of err.problems) console.error(`  - ${p}`);
    process.exit(1);
  }
}
