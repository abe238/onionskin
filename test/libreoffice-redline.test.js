import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { AUTHORS, buildTracked } from "../src/redline.js";
import { openZip } from "../src/zip.js";
import { tmpdir } from "./helpers/zipbuild.js";

// The tracked-changes copy in LibreOffice: converted to ODT in a private, throwaway profile (the same invocation check.py uses), every
// change must arrive as a tracked change by "Onionskin agent", with the deleted words kept inside it. Skipped when LibreOffice is missing.
const SOFFICE = process.env.ONIONSKIN_SOFFICE || "/Applications/LibreOffice.app/Contents/MacOS/soffice";
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = tmpdir("da-lo-redline-");
after(() => fs.rmSync(root, { recursive: true, force: true }));

test("a tracked-changes copy opens in LibreOffice with every change tracked, by Onionskin agent", { skip: !fs.existsSync(SOFFICE) && `LibreOffice not found at ${SOFFICE} (set ONIONSKIN_SOFFICE)` }, () => {
  const gen = path.join(root, "gen");
  assert.equal(spawnSync(process.execPath, [path.join(repo, "scripts/tracked-spike/make-fixtures.mjs"), gen]).status, 0);
  const before = fs.readFileSync(path.join(gen, "base.docx"));
  for (const c of ["replace-word", "delete-mid", "insert-mid"]) {
    const r = buildTracked({ before, after: fs.readFileSync(path.join(gen, `after-${c}.docx`)), author: AUTHORS.agent, date: "2026-11-11T01:05:00Z" });
    assert.ok(r.bytes, `${c}: ${r.refused}`);
    const file = path.join(root, `${c}.docx`);
    fs.writeFileSync(file, r.bytes);
    const out = path.join(root, `odt-${c}`);
    const p = spawnSync(SOFFICE, [`-env:UserInstallation=file://${root}/profile`, "--headless", "--norestore", "--convert-to", "odt", "--outdir", out, file], { timeout: 120000 });
    assert.equal(p.status, 0, String(p.stderr));
    const content = openZip(fs.readFileSync(path.join(out, `${c}.odt`))).readText("content.xml");
    assert.match(content, /<text:tracked-changes/, c);
    const creators = [...content.matchAll(/<dc:creator>([^<]*)<\/dc:creator>/g)].map((m) => m[1]);
    assert.ok(creators.length >= 1 && creators.every((x) => x === "Onionskin agent"), `${c}: ${creators}`);
    if (c === "replace-word") assert.match(content, /<text:deletion>[\s\S]*Monday[\s\S]*<\/text:deletion>/);
    if (c === "delete-mid") assert.match(content, /<text:deletion>[\s\S]*Budget figures are due next week\.[\s\S]*<\/text:deletion>/);
  }
});
