import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import { parseLauncherTarget } from "../src/doctor.js";
import { durableFromEngine, parseDocxParagraphs, resolveDurable } from "../src/docx.js";
import "../src/html-parser.js";
import { readHtml } from "../src/html.js";
import { renderCopy } from "../src/html-render.js";
import { docxUnits, slideUnits } from "../src/merge-package.js";
import { parseDeck, pptxDurable, resolvePptx } from "../src/pptx.js";
import { cleanQuestion } from "../src/question.js";
import { Sessions } from "../src/session.js";
import { runGetShDefault } from "../src/update.js";
import { SECTIONS, cleanVoiceDraft } from "../src/voice-guide.js";
import { cellAt, parseWorkbook } from "../src/xlsx.js";
import { openZip } from "../src/zip.js";

function localCrc32(buf) {
  if (typeof zlib.crc32 === "function") return zlib.crc32(buf) >>> 0;
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function buildZip(files) {
  const locals = [];
  const centrals = [];
  let off = 0;
  for (const { name, data } of files) {
    const nb = Buffer.from(name, "utf8");
    const db = Buffer.from(data);
    const crc = localCrc32(db);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(db.length, 18);
    lh.writeUInt32LE(db.length, 22);
    lh.writeUInt16LE(nb.length, 26);
    locals.push(lh, nb, db);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(db.length, 20);
    ch.writeUInt32LE(db.length, 24);
    ch.writeUInt16LE(nb.length, 28);
    ch.writeUInt32LE(off, 42);
    centrals.push(ch, nb);
    off += 30 + nb.length + db.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "os-reg-")));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// ---- R1: README & SKILL.md install one-liner works in zsh -----------------------------------------------------------

test("R1: documented install one-liners run cleanly in zsh without expanding =https", () => {
  const readme = fs.readFileSync(path.join(repo, "README.md"), "utf8");
  const skill = fs.readFileSync(path.join(repo, "skills", "onionskin", "SKILL.md"), "utf8");

  const readmeMatches = [...readme.matchAll(/RELEASE=https:\/\/[^\n]+\n\s*curl[^\n]+/g)].map((m) => m[0].trim());
  assert.equal(readmeMatches.length, 2, "expected 2 install one-liners in README.md");
  const skillMatch = skill.match(/RELEASE=https:\/\/[^`]+/);
  assert.ok(skillMatch, "expected install one-liner in SKILL.md");

  const stubDir = path.join(tmp, "r1-bin");
  fs.mkdirSync(stubDir, { recursive: true });
  const argsFile = path.join(tmp, "r1-curl-args.txt");
  fs.writeFileSync(
    path.join(stubDir, "curl"),
    `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(argsFile)}\nprintf 'echo OK_INSTALL\\n'\n`,
    { mode: 0o755 },
  );

  for (const cmd of [...readmeMatches, skillMatch[0]]) {
    fs.rmSync(argsFile, { force: true });
    const r = spawnSync("zsh", ["-fc", cmd], {
      encoding: "utf8",
      env: { PATH: `${stubDir}:/usr/bin:/bin`, HOME: tmp },
    });
    assert.equal(r.status, 0, `zsh failed for:\n${cmd}\nstderr: ${r.stderr}`);
    assert.equal(r.stdout.trim(), "OK_INSTALL");
    const argv = fs.readFileSync(argsFile, "utf8").trim().split("\n");
    assert.ok(argv.includes("--proto") && argv.includes("=https"), `missing --proto =https in ${JSON.stringify(argv)}`);
    assert.ok(argv.includes("--proto-redir"), `missing --proto-redir in ${JSON.stringify(argv)}`);
  }
});

// ---- R2: link/domain check allows ordinary filenames & terms, blocks hostile links ----------------------------------

test("R2/T1: cleanQuestion and cleanVoiceDraft allow ordinary sentences/filenames and block ://, www., emails (and domain/path in drafts)", () => {
  const makeDraft = (words) =>
    SECTIONS.map((s) => `## ${s.title}\n${s.id === "words" ? words : "I write in short, plain lines."}`).join("\n\n") + "\n";

  const allowed = [
    "That is done.It works now?",
    "Is the crash at main.py:42 the one you mean?",
    "Finished.No changes needed.",
    "Step 1.Click Save.",
    "Fixed.Run the tests.",
    "Use Socket.IO, ADO.NET, and ML.NET.",
    "Check app.js:120, file.txt:12, Main.java:17, index.html:30.",
    "Should I rename report.docx?",
    "Check budget.xlsx before noon.",
    "Update index.html and styles.css.",
    "Built with Node.js and ASP.NET.",
    "Done.Next sentence starts here.",
    "Release v0.0.5 is ready, e.g. for the U.S. team.",
    "Save README.md, setup.sh, data.json, and section 3.b.",
    "Bare domain evil.com is an accepted gap.",
  ];
  for (const text of allowed) {
    assert.ok(cleanQuestion({ ask: text, options: ["Yes", "No"] }).question, `question should allow: ${text}`);
    assert.equal(cleanVoiceDraft(makeDraft(text)).code, undefined, `voice draft should allow: ${text}`);
  }

  const blockedBoth = [
    "Visit https://x.example now.",
    "Visit https://x\u3002example now.",
    "Open www.x.example today.",
    "Open www\u3002x.example today.",
    "Open www\uFF61x.example today.",
    "Open www\u2024x.example today.",
    "Try \uFF57\uFF57\uFF57\uFF0Ex.example now.",
    "Email a@b.example now.",
    "Email a@b\u3002example now.",
    "Use mailto:a@b.example here.",
  ];
  for (const text of blockedBoth) {
    assert.equal(cleanQuestion({ ask: text, options: ["Yes", "No"] }).code, "bad_question", `question should block: ${text}`);
    assert.equal(cleanVoiceDraft(makeDraft(text)).code, "link_or_markup", `voice draft should block: ${text}`);
  }

  for (const text of ["Go to evil.example/login now.", "Go to evil\u3002example/login now.", "Go to evil\uFF61example/login now."]) {
    assert.equal(cleanVoiceDraft(makeDraft(text)).code, "link_or_markup", `voice draft should block domain/path: ${text}`);
  }
});

// ---- R3: AgentRunner frees slot even if a descendant inherits stdout ------------------------------------------------

test("R3: agentRunner frees slot after child exit even when a descendant holds stdout open", async () => {
  const { agentRunner } = await import("../src/agent-runner.js");
  const st = path.join(tmp, "r3-state");
  fs.mkdirSync(st, { recursive: true });
  process.env.ONIONSKIN_STATE_DIR = st;

  const pidFile = path.join(tmp, "r3-sleep.pid");
  const fakeBin = path.join(tmp, "r3-bin");
  fs.mkdirSync(fakeBin, { recursive: true });
  const fakeCli = path.join(fakeBin, "claude");
  fs.writeFileSync(
    fakeCli,
    `#!/bin/sh\nsleep 30 &\necho $! > ${JSON.stringify(pidFile)}\necho '{"type":"system","session_id":"s1"}'\nexit 0\n`,
    { mode: 0o755 },
  );

  const S = new Sessions();
  const doc = path.join(tmp, "r3.html");
  fs.writeFileSync(doc, "<p>hello</p>");
  const s = S.open(doc, { format: "html", agent: "background" });

  const runner = agentRunner(S, {
    env: { HOME: tmp, USER: "u", PATH: `${fakeBin}:/usr/bin:/bin`, ONIONSKIN_AGENT_PATH: fakeBin, ONIONSKIN_STATE_DIR: st },
    execFile: (bin, args, opts, cb) => {
      if (args[0] === "--version") return queueMicrotask(() => cb(null, "2.1.323 (Claude Code)\n", ""));
      if (args[0] === "auth") return queueMicrotask(() => cb(null, JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }), ""));
      return queueMicrotask(() => cb(null, "Mon Jan 1 00:00:00 2026\n", ""));
    },
  });

  try {
    runner.ensure(s.key, { now: true });
    const deadline = Date.now() + 4000;
    while ((!runner.entries.get(s.key)?.spawned || runner.entries.get(s.key)?.child) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(runner.entries.get(s.key)?.spawned, true, `expected agent to spawn, got view=${JSON.stringify(runner.viewFor(s.key))}`);
    assert.ok(fs.existsSync(pidFile), "expected fake agent to spawn sleep descendant");
    assert.equal(runner.entries.get(s.key)?.child, null, "child reference must be cleared");
    assert.equal(runner.alive(s.key), false, "agent slot must be freed after child exits");
  } finally {
    try {
      const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
      if (pid > 0) process.kill(pid, "SIGKILL");
    } catch {}
    await runner.stopAll?.();
  }
});

// ---- R6: ZIP with trailing bytes & crc32Pure fallback ---------------------------------------------------------------

test("R6: openZip handles trailing bytes and crc32Pure matches zlib.crc32", async () => {
  const base = buildZip([{ name: "hello.txt", data: Buffer.from("hello world") }]);
  const withTrailing = Buffer.concat([base, Buffer.from("TRAILING_JUNK_BYTES_12345")]);
  const z = openZip(withTrailing);
  assert.equal(z.readText("hello.txt"), "hello world");

  const { crc32Pure } = await import("../src/zip.js");
  assert.equal(typeof crc32Pure, "function", "src/zip.js must export crc32Pure");
  for (const s of ["", "hello world", "The quick brown fox jumps over the lazy dog", "\u0000\u00ff\u0080".repeat(100)]) {
    const b = Buffer.from(s, "utf8");
    assert.equal(crc32Pure(b), zlib.crc32(b) >>> 0);
  }
});

// ---- R7 & ENG-06: w:ins inside w:moveFrom + repeated text occurrence selection --------------------------------------

test("R7: w:ins inside w:moveFrom is visible in both parseDocxParagraphs and docxUnits", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p>
      <w:r><w:t>Start </w:t></w:r>
      <w:moveFrom w:id="1">
        <w:r><w:t>moved </w:t></w:r>
        <w:ins w:id="2"><w:r><w:t>inserted</w:t></w:r></w:ins>
      </w:moveFrom>
      <w:r><w:t> end.</w:t></w:r>
    </w:p>
  </w:body>
</w:document>`;
  const paras = parseDocxParagraphs(xml);
  assert.equal(paras[0].text, "Start inserted end.");
  const intern = { m: new Map(), id(s) { if (!this.m.has(s)) this.m.set(s, this.m.size + 1); return this.m.get(s); } };
  const units = docxUnits(xml, intern);
  assert.equal(units.paras[0].text, "Start inserted end.");
});

test("ENG-06: repeated text in DOCX and PPTX resolves to the right occurrence using context / nth", () => {
  const docxXml = `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>First  foo  bar and second  foo  bar here.</w:t></w:r></w:p>
  </w:body>
</w:document>`;
  const paras = parseDocxParagraphs(docxXml);
  const d = durableFromEngine(
    paras,
    { blockPath: [0], start: 28, end: 36 },
    { quote: "foo bar", prefix: "and second", suffix: "here.", paraText: paras[0].text },
  );
  assert.equal(d.nth, 1);
  assert.ok(d.start > 20, `expected second occurrence, got start=${d.start}`);
  const r = resolveDurable(paras, d);
  assert.equal(r.start, d.start);
  assert.equal(r.nth, 1);

  // PPTX exact & normalized repeated text
  const pres = `<?xml version="1.0"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>`;
  const rels = `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>`;
  const slide = `<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="2" name="Box"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:txBody><a:p><a:r><a:t>Alpha  foo  bar then Beta  foo  bar end</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
  const deck = parseDeck(buildZip([
    { name: "ppt/presentation.xml", data: Buffer.from(pres) },
    { name: "ppt/_rels/presentation.xml.rels", data: Buffer.from(rels) },
    { name: "ppt/slides/slide1.xml", data: Buffer.from(slide) },
  ]));
  const a1 = pptxDurable(deck, { slideId: 256, shapeId: 2 }, { quote: "foo bar", prefix: "then Beta", suffix: "end" });
  assert.equal(a1.nth, 1);
  assert.ok(a1.start > 20, `expected second PPTX occurrence, got start=${a1.start}`);
  const rp = resolvePptx(deck, a1);
  assert.equal(rp.start, a1.start);
  assert.equal(rp.nth, 1);
});

// ---- R8: parseLauncherTarget supports single- and double-quoted launchers -------------------------------------------

test("R8: parseLauncherTarget recognizes both single-quoted (with escaped apostrophes) and double-quoted launchers", () => {
  assert.equal(parseLauncherTarget('#!/bin/sh\nexec node "/a/b/src/cli.js" "$@"\n'), "/a/b/src/cli.js");
  assert.equal(parseLauncherTarget("#!/bin/sh\nexec node '/a/b/src/cli.js' \"$@\"\n"), "/a/b/src/cli.js");
  assert.equal(parseLauncherTarget("#!/bin/sh\nexec node '/Volumes/o'\\''connor/.onionskin/app/0.0.5/src/cli.js' \"$@\"\n"), "/Volumes/o'connor/.onionskin/app/0.0.5/src/cli.js");
});

// ---- R9: SKILL.md fallback does not assume $WORK persists across commands -------------------------------------------

test("R9: SKILL.md fallback route does not rely on $WORK persisting across shell invocations", () => {
  const skill = fs.readFileSync(path.join(repo, "skills", "onionskin", "SKILL.md"), "utf8");
  assert.doesNotMatch(skill, /--from "\$WORK"/);
});

// ---- R11: XLSX boolean <v></v>, PPTX slideUnits mc:Fallback, CSS Unicode spaces, checking lease backstop ------------

test("R11: XLSX <c t='b'><v></v></c> returns FALSE while <c t='b'/> is empty", () => {
  const wb = `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="S1" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  const rels = `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`;
  const sheet = `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="b"/><c r="A2" t="b"><v></v></c><c r="A3" t="b"><v>1</v></c></row></sheetData></worksheet>`;
  const book = parseWorkbook(buildZip([
    { name: "xl/workbook.xml", data: Buffer.from(wb) },
    { name: "xl/_rels/workbook.xml.rels", data: Buffer.from(rels) },
    { name: "xl/worksheets/sheet1.xml", data: Buffer.from(sheet) },
  ]));
  const sd = book.sheetCells(book.sheets[0]);
  assert.equal(cellAt(sd, 0, 0), undefined, "<c t='b'/> without <v> is empty");
  assert.equal(cellAt(sd, 1, 0)?.text, "FALSE", "<c t='b'><v></v></c> is FALSE");
  assert.equal(cellAt(sd, 2, 0)?.text, "TRUE", "<c t='b'><v>1</v></c> is TRUE");
});

test("R11: slideUnits skips mc:Fallback matching src/pptx.js", () => {
  const xml = `<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><p:cSld><p:spTree><mc:AlternateContent><mc:Choice Requires="p14"><p:sp><p:nvSpPr><p:cNvPr id="5" name="Choice"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:txBody><a:p><a:r><a:t>Real</a:t></a:r></a:p></p:txBody></p:sp></mc:Choice><mc:Fallback><p:sp><p:nvSpPr><p:cNvPr id="6" name="Fallback"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:txBody><a:p><a:r><a:t>Ghost</a:t></a:r></a:p></p:txBody></p:sp></mc:Fallback></mc:AlternateContent></p:spTree></p:cSld></p:sld>`;
  const intern = { m: new Map(), id(s) { if (!this.m.has(s)) this.m.set(s, this.m.size + 1); return this.m.get(s); } };
  const u = slideUnits(xml, intern);
  assert.equal(u.shapes.length, 1);
  assert.equal(u.shapes[0].id, 5);
  assert.equal(u.shapes[0].text, "Real");
});

test("R11: HTML CSS preserves 64+ Unicode spaces inside quoted strings", () => {
  const nbspRun = "\u00A0".repeat(70);
  const html = `<!doctype html><html><head><style>.x::before { content: "${nbspRun}"; }</style></head><body><p class="x">Hi</p></body></html>`;
  const rendered = renderCopy(readHtml(Buffer.from(html, "utf8")), { fileDir: tmp });
  assert.ok(rendered.bytes.toString("utf8").includes(nbspRun), "64+ Unicode spaces inside CSS quoted string must not be collapsed");
});

test("R11: checking stage holds lease briefly then expires at hard backstop", () => {
  const st = path.join(tmp, "r11-sess");
  fs.mkdirSync(st, { recursive: true });
  process.env.ONIONSKIN_STATE_DIR = st;
  let now = 1_000_000;
  const S = new Sessions({ now: () => now });
  const doc = path.join(tmp, "r11.html");
  fs.writeFileSync(doc, "<p>hello</p>");
  const s = S.open(doc, { format: "html" });
  s.delivered = {
    batch: { batch_id: "b1" },
    lease: { holder: "h1", token: "t1", expiresAt: now + 1000 },
    stage: "writing",
    edits: [],
    preSha: s.sha,
  };
  S.setStage(s.key, "checking");
  // Past lease.expiresAt, still within checking backstop: stays delivered
  now += 2000;
  S.tick();
  assert.ok(s.delivered, "checking stage should not expire immediately at lease.expiresAt");
  // Past hard backstop (> max(LEASE_MS, 5m)): expires
  now += 25 * 60_000;
  S.tick();
  assert.equal(s.delivered, null, "checking stage must expire at hard backstop");
});

test("R11/S8: runGetShDefault enforces timeout and kills foreground children on /bin/sh execution", async () => {
  const stubDir = path.join(tmp, "r11-upd-bin");
  fs.mkdirSync(stubDir, { recursive: true });
  const childPidFile = path.join(stubDir, "fg.pid");
  // curl stub writes a get.sh-shaped script (TERM trap + foreground child)
  fs.writeFileSync(
    path.join(stubDir, "curl"),
    `#!/bin/sh
out=""
while [ $# -gt 0 ]; do if [ "$1" = "-o" ]; then out="$2"; shift 2; else shift; fi; done
cat > "$out" <<'SH'
#!/bin/sh
trap ':' TERM
sh -c 'echo $$ > ${childPidFile}; exec sleep 20'
SH
`,
    { mode: 0o755 },
  );
  const t0 = Date.now();
  const rc = await runGetShDefault("https://example.invalid", { PATH: `${stubDir}:/usr/bin:/bin`, TMPDIR: tmp }, { timeout: 600, graceMs: 250 });
  const elapsed = Date.now() - t0;
  assert.notEqual(rc, 0, "timed-out runGetShDefault must return non-zero");
  assert.ok(elapsed < 3000, `expected timeout in ~600ms, took ${elapsed}ms`);
  assert.equal(fs.existsSync(childPidFile), true, "foreground child must have written pidFile before timeout");
  await new Promise((r) => setTimeout(r, 100));
  const pid = Number(fs.readFileSync(childPidFile, "utf8").trim());
  assert.ok(pid > 0);
  assert.throws(() => process.kill(pid, 0), /ESRCH/, `foreground child ${pid} must be killed`);
});

test("S10/T7: onionskin stop fails non-zero on wedged server.json+s.sock, and cleans stale server.json pointing to an unrelated live process", async () => {
  const { spawn } = await import("node:child_process");

  // (a) Wedged server accepting connections on s.sock with server.json -> exits non-zero
  const st = path.join(tmp, "s10-wedged");
  fs.mkdirSync(st, { recursive: true });
  const sock = path.join(st, "s.sock");
  const recPath = path.join(st, "server.json");
  const wedgedScript = path.join(st, "wedged.mjs");
  fs.writeFileSync(
    wedgedScript,
    `import fs from "node:fs";
import net from "node:net";
fs.writeFileSync(${JSON.stringify(recPath)}, JSON.stringify({ pid: process.pid, port: 0 }));
const srv = net.createServer((c) => { c.resume(); });
srv.listen(${JSON.stringify(sock)}, () => console.log("READY"));
setInterval(() => {}, 1000);
`,
  );
  const wedged = spawn(process.execPath, [wedgedScript], { stdio: ["ignore", "pipe", "ignore"] });
  try {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("wedged server did not start")), 3000);
      wedged.stdout.once("data", () => {
        clearTimeout(t);
        resolve();
      });
    });
    const r = spawnSync(process.execPath, [path.join(repo, "src", "cli.js"), "stop"], {
      encoding: "utf8",
      env: { ...process.env, ONIONSKIN_STATE_DIR: st },
      timeout: 15_000,
    });
    assert.notEqual(r.status, 0, `expected non-zero exit on wedged server, got status=${r.status} stdout=${r.stdout} stderr=${r.stderr}`);
    assert.doesNotMatch(r.stdout, /\bstopped\b/, "must not falsely print stopped");
    assert.match(r.stderr, /did not stop/, "must report that the server did not stop");
  } finally {
    try {
      wedged.kill("SIGKILL");
    } catch {}
  }

  // (b) Stale server.json whose pid belongs to a live unrelated process -> exits 0 and removes stale record
  const st2 = path.join(tmp, "s10-stale");
  fs.mkdirSync(st2, { recursive: true });
  const unrelated = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
  try {
    const staleRec = path.join(st2, "server.json");
    fs.writeFileSync(staleRec, JSON.stringify({ pid: unrelated.pid, port: 0 }));
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [path.join(repo, "src", "cli.js"), "stop"], {
      encoding: "utf8",
      env: { ...process.env, ONIONSKIN_STATE_DIR: st2 },
      timeout: 10_000,
    });
    assert.equal(r.status, 0, `expected exit 0 for stale server.json, got status=${r.status} stdout=${r.stdout} stderr=${r.stderr}`);
    assert.ok(Date.now() - t0 < 3000, "must not wait 5s for an unrelated process");
    assert.match(r.stdout, /no running server \(stale record removed\)/);
    assert.equal(fs.existsSync(staleRec), false, "stale server.json must be removed");
    assert.doesNotThrow(() => process.kill(unrelated.pid, 0), "unrelated live process must not be killed");
  } finally {
    try {
      unrelated.kill("SIGKILL");
    } catch {}
  }
});

test("R11/S14: install.sh checks macOS 13.1, restores .old.$$ in cleanup, and emits SKILL_SETUP_FAILED on setup failure after swap", () => {
  const sh = fs.readFileSync(path.join(repo, "install.sh"), "utf8");
  assert.match(sh, /older than 13\.1/);
  assert.match(sh, /renameSync\(process\.argv\[1\], process\.argv\[2\]\)' "\$APP\.old\.\$\$" "\$APP"/);
  assert.match(sh, /^\s*put_back_old \|\| true$/m, "the exit cleanup puts it back");
  assert.match(sh, /SKILL_SETUP_FAILED: warning: skill setup exited/);
});
