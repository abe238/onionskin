// The command the closed page tells a person to paste (src/person.js reopenCommand, src/session.js view): the file's absolute path,
// quoted for a POSIX shell only when needed, so it works from any folder. Toy DOCX in a temp dir only.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test, after } from "node:test";
import { tmpdir, docxBytes } from "./helpers/zipbuild.js";

const root = fs.realpathSync(tmpdir());
process.env.ONIONSKIN_STATE_DIR = path.join(root, "st");
process.env.ONIONSKIN_NO_SOFFICE = "1";
process.env.ONIONSKIN_NO_OPEN = "1";
delete process.env.ONIONSKIN_PYTHON;
const { Sessions } = await import("../src/session.js");
const { reopenCommand, shellWord } = await import("../src/person.js");
const { ensureStateDir } = await import("../src/paths.js");
ensureStateDir();
after(() => fs.rmSync(root, { recursive: true, force: true }));

test("shellWord and reopenCommand: bare when safe, single-quoted when not", () => {
  assert.equal(reopenCommand("/Volumes/work/docs/sample.docx"), "onionskin /Volumes/work/docs/sample.docx");
  assert.equal(shellWord("/a/b+c@d%e,f:g=h-i_j.docx"), "/a/b+c@d%e,f:g=h-i_j.docx");
  assert.equal(reopenCommand("/Volumes/work/My docs/a b.docx"), "onionskin '/Volumes/work/My docs/a b.docx'");
  assert.equal(reopenCommand("/Volumes/work/Pat's/a.docx"), `onionskin '/Volumes/work/Pat'\\''s/a.docx'`);
  assert.equal(reopenCommand("/tmp/$HOME/`id`/a.docx"), "onionskin '/tmp/$HOME/`id`/a.docx'", "no expansion inside single quotes");
});

test("view carries the absolute file and the reopen command, outside the agent object", () => {
  const d = path.join(root, "a folder");
  fs.mkdirSync(d);
  const file = path.join(d, "sample.docx");
  fs.writeFileSync(file, docxBytes(["Paragraph 1: a sentence for the reopen test."]));
  const S = new Sessions();
  const s = S.open(file);
  const v = S.view(s);
  assert.equal(v.file, s.file);
  assert.ok(path.isAbsolute(v.file));
  assert.equal(v.reopen, `onionskin '${s.file}'`);
  assert.equal(JSON.stringify(v.agent).includes(d), false, "the agent object never carries a path");
});
