// Where the tests find their inputs. Everything is repo-relative; environment variables override.
//   ONIONSKIN_TEST_SAMPLES  directory with sample.docx / sample.xlsx / sample.pptx (default: test/fixtures/engine, committed)
//   ONIONSKIN_TEST_CORPUS   directory with the pinned Apache POI files (default: test/fixtures/cache, fetched by scripts/fetch-fixtures.mjs)
// A missing fixture is a skip with one clear line locally, and a failure when CI is set.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const ENGINE_SAMPLES = process.env.ONIONSKIN_TEST_SAMPLES || path.join(repoRoot, "test", "fixtures", "engine");
export const CORPUS = process.env.ONIONSKIN_TEST_CORPUS || path.join(repoRoot, "test", "fixtures", "cache");
export const python = path.join(repoRoot, ".venv", "bin", "python");
export const FETCH_HINT = "node scripts/fetch-fixtures.mjs";

/** `have` true: no skip. Otherwise a skip reason for node:test (printed once, with the command that fixes it), or a thrown error when CI is set. */
export function skipUnless(have, what, fix = FETCH_HINT) {
  if (have) return false;
  const msg = `${what} (fix: ${fix})`;
  if (process.env.CI) throw new Error(`missing fixture in CI: ${msg}`);
  return msg;
}

export const haveSamples = () => fs.existsSync(path.join(ENGINE_SAMPLES, "sample.docx"));
export const haveCorpus = () => fs.existsSync(path.join(CORPUS, "60316.docx"));
export const havePython = () => fs.existsSync(python);
export const VENV_HINT = "python3 -m venv .venv && .venv/bin/pip install -r scripts/requirements.txt";
