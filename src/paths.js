import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PRODUCT, env } from "./constants.js";

export function stateDir() {
  const o = env("STATE_DIR");
  return o ? path.resolve(o) : path.join(os.homedir(), PRODUCT.stateDirName);
}
export const socketPath = () => path.join(stateDir(), "s.sock");
export const serverRecordPath = () => path.join(stateDir(), "server.json");
export const sessionKey = (realpath) => crypto.createHash("sha256").update(realpath).digest("hex").slice(0, 16);

/** Creates the state dir 0700 and verifies it is ours, a real directory (not a symlink) and not group/world accessible. */
export function ensureStateDir() {
  const dir = stateDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`${dir} is not a plain directory`);
  if (st.uid !== process.getuid()) throw new Error(`${dir} is not owned by the current user`);
  if (st.mode & 0o077) {
    fs.chmodSync(dir, 0o700);
    if (fs.lstatSync(dir).mode & 0o077) throw new Error(`${dir} is accessible by others and could not be fixed`);
  }
  return dir;
}

export function sub(...parts) {
  const dir = path.join(stateDir(), ...parts);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/**
 * Writes every byte of `data` to `fd`: fs.writeSync may accept fewer bytes than asked (a short write), so loop until all are written.
 * Zero progress is an error (a full or failing device), never a reason to spin or to carry on with a truncated file.
 * `write` is injectable for tests.
 */
export function writeFully(fd, data, write = fs.writeSync) {
  const buf = typeof data === "string" ? Buffer.from(data) : data;
  let off = 0;
  while (off < buf.length) {
    const n = write(fd, buf, off, buf.length - off);
    if (!(n > 0)) throw Object.assign(new Error(`short write: the device accepted ${off} of ${buf.length} bytes and then no more`), { code: "EIO_SHORT_WRITE" });
    off += n;
  }
}

/** State files: temp file created exclusively with mode 0600, then renamed over the target. */
export function writeStateFile(file, data, write = fs.writeSync) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  const fd = fs.openSync(tmp, "wx", 0o600);
  try {
    writeFully(fd, data, write);
    fs.fsyncSync(fd);
  } catch (err) {
    fs.closeSync(fd);
    fs.rmSync(tmp, { force: true }); // a failed write must not leave a truncated temp file behind
    throw err;
  }
  fs.closeSync(fd);
  fs.renameSync(tmp, file);
}
