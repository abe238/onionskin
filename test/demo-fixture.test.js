import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test, after } from "node:test";
import { fileURLToPath } from "node:url";
import { tmpdir } from "./helpers/zipbuild.js";

// The demo letter and its scenario wiring (scripts/real-run). Temp dirs only; no browser, no agent.
const root = tmpdir();
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rr = path.join(repo, "scripts", "real-run");
const { python, havePython, skipUnless, VENV_HINT } = await import("../scripts/fixtures.mjs");
const opts = { skip: skipUnless(havePython(), "needs .venv with python-docx", VENV_HINT) };
after(() => fs.rmSync(root, { recursive: true, force: true }));

const fx = path.join(root, "fx");
fs.mkdirSync(fx);
if (havePython()) execFileSync(python, [path.join(rr, "make-fixtures.py"), fx], { stdio: "ignore" });
const letter = path.join(fx, "welcome.docx");
const py = (code, ...args) => execFileSync(python, ["-I", "-c", code, ...args], { encoding: "utf8" });

test("the scenario is registered in the harness", () => {
  const lib = fs.readFileSync(path.join(rr, "lib.mjs"), "utf8");
  assert.match(lib, /"demo-docx": \{ fixture: "welcome\.docx" \}/);
  assert.match(fs.readFileSync(path.join(rr, "scenarios.mjs"), "utf8"), /"demo-docx": \{/);
});

test("welcome.docx is synthetic and carries nothing the demo page could not show safely", opts, () => {
  // every XML part, one per block (the stock python-docx template has style names such as "Hyperlink", so body-only markers are checked in document.xml alone)
  const zip = py("import sys,zipfile\nz=zipfile.ZipFile(sys.argv[1])\nfor n in z.namelist():\n  print('PART', n)\n  if n.endswith('.xml') or n.endswith('.rels'): print(z.read(n).decode('utf8'))", letter);
  const doc = zip.slice(zip.indexOf("PART word/document.xml"), zip.indexOf("PART word/_rels/document.xml.rels"));
  assert.doesNotMatch(zip, /TargetMode="External"/);
  assert.doesNotMatch(zip, /<w:instrText|<w:fldSimple|attachedTemplate|altChunk|subDoc|oleObject|r:link/);
  assert.doesNotMatch(doc, /<w:fldChar|<w:drawing|<w:pict|<w:tbl>|<w:hyperlink|<w:object/);
  // no URL outside XML namespace declarations and relationship type names
  const body = zip.replace(/xmlns(:\w+)?="[^"]*"/g, "").replace(/<\?xml[^>]*\?>/g, "").replace(/<Relationship [^>]*>/g, "").replace(/<Default [^>]*>|<Override [^>]*>/g, "");
  assert.deepEqual(body.match(/.{0,30}https?:\/\/.{0,40}/g) || [], []);
  const text = py("import sys\nfrom docx import Document\nprint('\\n'.join(p.text for p in Document(sys.argv[1]).paragraphs))", letter);
  assert.match(text, /^Dear new neighbor,/);
  assert.equal(text.match(/front office/g).length, 2);
  assert.doesNotMatch(text, /\/Users\/|@/);
});

test("check_scenario accepts the expected edits and rejects an untouched copy", opts, () => {
  const edited = path.join(root, "edited.docx");
  py(
    "import sys\nfrom docx import Document\nd=Document(sys.argv[1])\nfor p in d.paragraphs:\n  t=p.text\n  for a,b in ((', and we hope that you will feel at home here very quickly',''),(', so that the crew can reach them',''),('you should contact','please ask at'),('front office','Welcome Desk')):\n    t=t.replace(a,b)\n  if t!=p.text:\n    for r in p.runs[1:]: r.text=''\n    p.runs[0].text=t\nd.save(sys.argv[2])",
    letter,
    edited,
  );
  const ctx = path.join(root, "ctx.json");
  const note = "Done and explained.";
  fs.writeFileSync(ctx, JSON.stringify({ comments: ["Cut the long ending of this sentence.", "Shorten this sentence.", "Make this sound friendlier."].map((text) => ({ text, status: "done", note })), summary: "ok" }));
  const run = (fin) => JSON.parse(spawnSync(python, ["-I", path.join(rr, "check_scenario.py"), "demo-docx", letter, fin, ctx], { encoding: "utf8", env: { ...process.env, ONIONSKIN_NO_SOFFICE: "1" } }).stdout);
  const ok = run(edited);
  assert.deepEqual(ok.checks.filter((c) => !c.ok), []);
  const bad = run(letter);
  assert.ok(bad.checks.some((c) => !c.ok && /Welcome Desk twice/.test(c.name)));
});

test("a run answered by fake-agent.mjs is stamped fake", () => {
  const sim = fs.readFileSync(path.join(rr, "user-sim.mjs"), "utf8");
  const agent = fs.readFileSync(path.join(rr, "fake-agent.mjs"), "utf8");
  const fake = fs.readFileSync(path.join(rr, "run-fake.mjs"), "utf8");
  assert.match(agent, /fake-agent\.marker/);
  assert.match(sim, /evidence\.fake = fs\.existsSync\(path\.join\(info\.workdir, "fake-agent\.marker"\)\)/);
  assert.match(fake, /fake: true/);
});
