// One-time cleanup of the older writing helper (IBM Granite on MLX, about 1.3 GB). It removes exactly the paths that version created inside the
// state folder, and only when they look like what it created. Run by `onionskin setup-rewriter` (every kind) and by install.sh
// (`setup-rewriter --clean-old`). It never throws: a failure to remove something leaves it for the next run and is not a reason to stop a setup.
//   <state>/rewriter-venv/      a Python virtual environment (it has a pyvenv.cfg)
//   <state>/models/granite/     the model (it has a config.json); <state>/models/.granite.partial/ is a download that did not finish
//   <state>/rewriter.json       the settings file, when it names the Granite back end (backend "mlx" or model "granite")
// Safety: a path that is a link is skipped (never followed, never deleted through); a folder is removed only when its real path is exactly where it
// should be inside the real state folder; sizes are counted without following links. The settings file goes last, so a run that stops early
// finds its marker again next time. Apple's own settings file (backend "apple") is never touched.
import fs from "node:fs";
import path from "node:path";
import { stateDir } from "./paths.js";

const lstat = (p) => fs.lstatSync(p, { throwIfNoEntry: false });
const realDir = (p) => {
  const st = lstat(p);
  return st?.isDirectory() && !st.isSymbolicLink() ? st : null;
};
const realFile = (p) => {
  const st = lstat(p);
  return st?.isFile() && !st.isSymbolicLink() ? st : null;
};

/** Bytes of the regular files under `p`, links not followed. */
function treeBytes(p) {
  const st = lstat(p);
  if (!st || st.isSymbolicLink()) return 0;
  if (st.isFile()) return st.size;
  if (!st.isDirectory()) return 0;
  let n = 0;
  for (const e of fs.readdirSync(p)) n += treeBytes(path.join(p, e));
  return n;
}

/** "1.3 GB", "42 MB", "under 1 MB". */
export function sizeWords(bytes) {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return "under 1 MB";
}

/**
 * Removes what the older version left in `state` (default: the state folder). Returns {bytes, removed: [names]} (removed is empty when there was
 * nothing to do) and `line`, the one plain sentence for the person, when something was removed.
 */
export function cleanOldHelper(state = stateDir()) {
  const out = { bytes: 0, removed: [] };
  let root;
  try {
    if (!realDir(state)) return out;
    root = fs.realpathSync(state);
  } catch {
    return out;
  }
  const inside = (p, ...names) => {
    try {
      return fs.realpathSync(p) === path.join(root, ...names);
    } catch {
      return false;
    }
  };
  const remove = (p, names, gate) => {
    try {
      if (!realDir(p) || !inside(p, ...names) || !gate()) return;
      const bytes = treeBytes(p);
      fs.rmSync(p, { recursive: true, force: true }); // unlinks a link inside the folder, never follows it
      if (!lstat(p)) {
        out.bytes += bytes;
        out.removed.push(names.join("/"));
      }
    } catch {}
  };

  const config = path.join(state, "rewriter.json");
  let oldConfig = false;
  try {
    if (realFile(config)) {
      const cfg = JSON.parse(fs.readFileSync(config, "utf8"));
      oldConfig = cfg?.backend === "mlx" || cfg?.model === "granite";
    }
  } catch {}

  const venv = path.join(state, "rewriter-venv");
  remove(venv, ["rewriter-venv"], () => !!realFile(path.join(venv, "pyvenv.cfg")));
  const models = path.join(state, "models");
  if (realDir(models) && inside(models, "models")) {
    const granite = path.join(models, "granite");
    remove(granite, ["models", "granite"], () => !!realFile(path.join(granite, "config.json")));
    remove(path.join(models, ".granite.partial"), ["models", ".granite.partial"], () => true);
    try {
      if (!fs.readdirSync(models).length) fs.rmdirSync(models); // only when nothing else is in it
    } catch {}
  }
  if (oldConfig) {
    try {
      fs.rmSync(config, { force: true });
      out.removed.push("rewriter.json");
    } catch {}
  }
  if (out.removed.length) {
    out.freed = `Removed the old writing helper ${out.bytes >= 1e6 ? `download (${sizeWords(out.bytes)})` : "settings"}.`; // the first sentence alone, for install.sh
    out.line = `${out.freed} Quick fixes now use Apple's model already on this Mac.`;
  }
  return out;
}
