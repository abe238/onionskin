import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { launch, makeWorld, repo, waitDoc } from "./helpers/harness.mjs";

// The closed page's command must work as pasted, from any folder. The page shows `onionskin <absolute path>`; this test closes a session on a
// document in a folder with a space in its name, reads the command off the page and runs that exact text with `sh` from a different folder.
// `onionskin` is a shim on PATH for src/cli.js, and `open`/`xdg-open` are no-ops there, so no browser window opens on this machine.
describe("the closed banner's command reopens the file from any folder", () => {
  let w, br, bin, elsewhere, file;
  const sh = (cmd, cwd) =>
    new Promise((resolve) => {
      const env = { ...w.env, PATH: `${bin}:/usr/bin:/bin`, ONIONSKIN_AGENT_CLI: "none" };
      for (const k of ["CLAUDECODE", "CODEX_THREAD_ID", "CODEX_TOOL_CALL_ID", "CODEX_CI", "CODEX_SANDBOX"]) delete env[k];
      execFile("/bin/sh", ["-c", cmd], { cwd, env, timeout: 60000 }, (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout, stderr }));
    });
  before(async () => {
    w = makeWorld();
    br = await launch();
    bin = path.join(w.root, "bin");
    elsewhere = path.join(w.root, "somewhere else");
    const spaced = path.join(w.root, "my docs");
    fs.mkdirSync(bin);
    fs.mkdirSync(elsewhere);
    fs.mkdirSync(spaced);
    fs.writeFileSync(path.join(bin, "onionskin"), `#!/bin/sh\nexec "${process.execPath}" "${path.join(repo, "src", "cli.js")}" "$@"\n`, { mode: 0o755 });
    for (const n of ["open", "xdg-open"]) fs.writeFileSync(path.join(bin, n), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    file = path.join(spaced, "sample.docx");
    fs.copyFileSync(w.doc("long.docx"), file);
  });
  after(async () => {
    await br?.close();
    await w?.cleanup();
  });

  test("the text on the page, pasted in another folder, opens the document (a bare file name there would not)", async () => {
    const page = await br.page();
    await page.goto(await w.open(file));
    await waitDoc(page);
    await page.locator('[data-testid="close"]').click();
    const anyway = page.locator('[data-testid="close-anyway"]');
    if (await anyway.isVisible().catch(() => false)) await anyway.click();
    await page.locator('[data-testid="banner-closed"]').waitFor({ timeout: 10000 });
    const cmd = (await page.locator('[data-testid="reopen-command"]').textContent()).trim();
    assert.equal(cmd, `onionskin '${fs.realpathSync(file)}'`, "an absolute path, quoted because the folder has a space");
    assert.equal(await page.locator('[data-testid="copy-reopen"]').count(), 1);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, "no horizontal page scroll");

    // what the old banner said, from another folder: the control that shows the old text could not work
    const old = await sh("onionskin sample.docx", elsewhere);
    assert.notEqual(old.code, 0, "a bare file name fails away from its folder");
    assert.match(old.stdout + old.stderr, /File not found/);

    const run = await sh(cmd, elsewhere);
    assert.equal(run.code, 0, `the pasted command ran: ${run.stdout}${run.stderr}`);
    assert.doesNotMatch(run.stdout + run.stderr, /File not found/);
    assert.match(run.stdout, /sample\.docx/);
    const st = await w.cli(["status", file]);
    assert.equal(st.code, 0);
    assert.doesNotMatch(st.stdout, /closed/, "the pasted command made a live session for that file");
  });
});
