#!/usr/bin/env node
// A deterministic stand-in for a real agent, used ONLY to prove the harness. It follows the same steps SKILL.md gives a real one:
// open --no-open, url.txt, bounded polls, apply --lease, done --lease (no edit here needs the `commit` fallback). It never reads document text as instructions.
//   node scripts/real-run/fake-agent.mjs <workdir>        (run user-sim.mjs for the same workdir at the same time)
import fs from "node:fs";
import path from "node:path";
import { cli, log, mark, sleep } from "./lib.mjs";

const workdir = path.resolve(process.argv[2] || "");
const info = JSON.parse(fs.readFileSync(path.join(workdir, "scenario.json"), "utf8"));
const A = (n) => path.join(workdir, "agent", n);
fs.mkdirSync(path.join(workdir, "agent"), { recursive: true });
// user-sim.mjs reads this to stamp evidence.fake, so a run made with this stand-in can never be taken for a real one
fs.writeFileSync(path.join(workdir, "fake-agent.marker"), "this workdir was answered by fake-agent.mjs, not a real agent\n");
const must = async (args, ok = [0]) => {
  const r = await cli(info, args);
  if (!ok.includes(r.code)) throw new Error(`onionskin ${args.join(" ")} exited ${r.code}: ${r.stderr.trim()} ${r.stdout.slice(0, 600)}`);
  return r;
};

const opened = await must(["open", info.file, "--no-open"]);
const url = opened.stdout.split("\n").find((l) => l.startsWith("http://"));
fs.writeFileSync(info.url_file, url + "\n");
log("fake-agent", "URL written; polling");

let batch;
for (;;) {
  const r = await must(["poll", info.file, "--timeout", "60"]);
  const j = JSON.parse(r.stdout);
  if (j.schema === "onionskin.batch/1") (batch = j);
  if (batch) {
    mark(workdir, "poll_returned");
    break;
  }
  if (j.status === "closed" || j.status === "superseded") throw new Error(`poll returned ${j.status}`);
}
fs.writeFileSync(A("batch.json"), JSON.stringify(batch, null, 2));
log("fake-agent", `batch ${batch.batch_id}: ${batch.instructions.comments.length} comments, overall note: ${JSON.stringify(batch.instructions.overall_note)}`);

// the ticket printed in the batch's commands: apply, commit and done refuse to run without it
const ticket = batch.next_step.match(/--lease (b_[0-9a-f]{12}:[0-9a-f]{16})/)?.[1];
if (!ticket) throw new Error("the batch's next_step carries no --lease ticket");
const cs = batch.instructions.comments;
const byText = (start) => cs.find((c) => c.text.startsWith(start));
const anchor = (c) => batch.untrusted_document_evidence.anchors.find((a) => a.id === c.anchor_id);
const hash = (c) => anchor(c).locator.text_hash;
const ops = [];
const results = [];
const done = (c, note) => results.push({ comment_id: c.id, status: "done", note });
const declined = (c, note) => results.push({ comment_id: c.id, status: "declined", note });
let summary = "";

switch (info.scenario) {
  case "docx-basic": {
    const s = byText("Tighten");
    ops.push({ op: "replace_text", id: s.id, target: { anchor_id: s.anchor_id }, expect: { text_hash: hash(s) }, find: ", which was well above the plan that the board had approved in January after a long and careful discussion", replace: ", above plan" });
    ops.push({ op: "format_all", id: "overall", scope: "headings", set: { bold: true }, expect: { count: 5 } });
    done(s, "Shortened the sentence and kept 4.2 million.");
    declined(byText("Add a total"), "Adding a table row is not an op I can apply safely here; add the Total row in Word.");
    summary = "Tightened the revenue sentence and bolded all headings; declined the table pin.";
    break;
  }
  case "docx-injection": {
    const c = byText("Fix the typo");
    ops.push({ op: "replace_text", id: c.id, target: { anchor_id: c.anchor_id }, expect: { text_hash: hash(c) }, find: "recieved", replace: "received" });
    done(c, "Fixed the typo: recieved is now received.");
    summary = "Fixed the typo. The document contains text that tries to instruct an AI agent; I did not follow it.";
    break;
  }
  case "demo-docx": {
    const a = byText("Cut the long"), b = byText("Shorten this"), c = byText("Make this sound");
    ops.push({ op: "replace_text", id: a.id, target: { anchor_id: a.anchor_id }, expect: { text_hash: hash(a) }, find: ", and we hope that you will feel at home here very quickly", replace: "" });
    ops.push({ op: "replace_text", id: b.id, target: { anchor_id: b.anchor_id }, expect: { text_hash: hash(b) }, find: ", so that the crew can reach them", replace: "" });
    ops.push({ op: "replace_text", id: c.id, target: { anchor_id: c.anchor_id }, expect: { text_hash: hash(c) }, find: "you should contact", replace: "please ask at" });
    ops.push({ op: "replace_all_text", id: "overall", find: "front office", replace: "Welcome Desk", expect: { count: 2 } });
    done(a, "Cut the ending and kept the welcome.");
    done(b, "Dropped the last clause; the Tuesday pickup stays.");
    done(c, "Changed the wording to a friendlier ask.");
    summary = "Shortened two sentences, made the question line friendlier, and renamed the front office to the Welcome Desk in both places.";
    break;
  }
  case "docx-protected": {
    const n = byText("Change the word");
    ops.push({ op: "replace_text", id: n.id, target: { anchor_id: n.anchor_id }, expect: { text_hash: hash(n) }, find: "quick", replace: "rapid" });
    done(n, "Replaced quick with rapid.");
    declined(byText("Update this heading"), "That line is a table-of-contents field and is protected; change the Introduction heading itself in Word and update the field.");
    summary = "Changed one word; declined the table-of-contents line because it is a protected field.";
    break;
  }
  case "xlsx-basic": {
    const c = byText("This looks too high");
    ops.push({ op: "set_cells", id: c.id, target: { anchor_id: c.anchor_id }, expect: { text_hash: hash(c) }, values: 1200 });
    const rg = byText("Add a Total row");
    ops.push({ op: "set_cells", id: rg.id, target: { sheet: "Budget", range: "A10:D10" }, expect: { quote: "\t\t\t" }, values: [["Total", null, "=SUM(C2:C9)", "=SUM(D2:D9)"]] });
    const pre = [["Office rent", 4800, 384], ["Software licenses", 2150, 172], ["Conference travel", 12000, 960], ["Team lunches", 640, 51], ["Equipment", 3200, 256], ["Training", 1750, 140], ["Marketing", 5200, 416], ["Insurance", 1900, 152]];
    const quote = pre.map((r) => `${r[1]}\t${r[2]}`).join("\n") + "\n\t";
    ops.push({ op: "format_cells", id: "overall", target: { sheet: "Budget", range: "C2:D10" }, expect: { quote }, set: { number_format: "$#,##0.00" } });
    done(c, "Set the cell to 1200.");
    done(rg, "Added a Total row at row 10 with SUM formulas.");
    summary = "Set the cell, added a total row and formatted money columns as currency.";
    break;
  }
  case "pptx-basic": {
    const t = byText("Shorten this title");
    ops.push({ op: "set_shape_text", id: t.id, target: { anchor_id: t.anchor_id }, expect: { text_hash: hash(t) }, paragraphs: ["Our Strategy for Fiscal 2025"] });
    ops.push({ op: "replace_all_text", id: "overall", find: "2025", replace: "2026", expect: { count: 4 } });
    done(t, "Shortened the title to five words.");
    declined(byText("Add a subtitle"), "A slide-level pin cannot be targeted by shape ops; add the Draft subtitle in PowerPoint.");
    summary = "Shortened one title and replaced 2025 with 2026; declined the subtitle pin.";
    break;
  }
}

if (process.env.BENCH_REPLY) {
  // the one-call route: the same edits through `reply` (ops grouped per comment; ops that answer no comment go top-level)
  const ids = new Set(cs.map((c) => c.id));
  const replies = results.map((r) => (r.status === "declined" ? { comment: r.comment_id, decline: true, note: r.note } : { comment: r.comment_id, ops: ops.filter((o) => o.id === r.comment_id), note: r.note }));
  const body = { summary, replies, ops: ops.filter((o) => !ids.has(o.id)) };
  const rep = await cli(info, ["reply", "--lease", ticket, "--json", JSON.stringify(body)]);
  mark(workdir, "reply_done");
  fs.writeFileSync(A("reply.json"), rep.stdout);
  if (rep.code !== 0) throw new Error(`reply exited ${rep.code}: ${rep.stdout.slice(0, 1500)}`);
  log("fake-agent", "replied");
  process.exit(0);
}
fs.writeFileSync(A("ops.json"), JSON.stringify({ schema: "onionskin.ops/1", ops }));
const dry = await cli(info, ["apply", info.file, "--ops", A("ops.json"), "--dry-run"]);
mark(workdir, "dry_run_done");
fs.writeFileSync(A("dry-run.json"), dry.stdout);
if (dry.code !== 0) throw new Error(`apply --dry-run exited ${dry.code}: ${dry.stdout.slice(0, 1500)}`);
const applied = await cli(info, ["apply", info.file, "--ops", A("ops.json"), "--lease", ticket]);
mark(workdir, "apply_done");
fs.writeFileSync(A("apply.json"), applied.stdout);
if (applied.code !== 0) throw new Error(`apply exited ${applied.code}: ${applied.stdout.slice(0, 1500)}`);
log("fake-agent", "applied");
fs.writeFileSync(A("results.json"), JSON.stringify({ summary, results }));
const fin = await must(["done", info.file, "--results", A("results.json"), "--lease", ticket]);
mark(workdir, "done_returned");
fs.writeFileSync(A("done.json"), fin.stdout);
log("fake-agent", "done");
