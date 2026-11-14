import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { sessionKey, sub, writeStateFile } from "./paths.js";

// The holder id of an agent's polls on a file is remembered in <state>/holders/<session key>.json (0600) so `poll --ack` renews the same
// lease. It is NOT a credential: the lease token never lives in a per-file slot that a later poll could overwrite.
const holderFile = (realFile) => path.join(sub("holders"), `${sessionKey(realFile)}.json`);

const newHolder = () => `h_${crypto.randomBytes(6).toString("hex")}`;

export function saveHolder(realFile, holder) {
  writeStateFile(holderFile(realFile), JSON.stringify({ holder: String(holder) }));
}

export function loadHolder(realFile) {
  try {
    const j = JSON.parse(fs.readFileSync(holderFile(realFile), "utf8"));
    return j && typeof j.holder === "string" && j.holder ? j.holder : null;
  } catch {
    return null;
  }
}

/** The holder id a poll uses: ONIONSKIN_HOLDER, else the one this file's last poll used (so `poll --ack` renews the same lease), else a fresh random id. */
export function holderFor(realFile, envHolder) {
  return envHolder || loadHolder(realFile) || newHolder();
}

/**
 * The ticket is what an agent carries: `<batch id>:<token>`, printed inside the `apply`, `commit` and `done` commands of the batch it received
 * (`--lease <ticket>`). Those commands REFUSE to run without it while a batch is delivered, so a late command from an older delivery names the
 * old token and is turned away.
 */
export const ticketOf = (batchId, token) => `${batchId}:${token}`;
export function parseTicket(value) {
  const m = /^(b_[0-9a-f]{12}):([0-9a-f]{16})$/.exec(String(value || ""));
  return m ? { batch_id: m[1], token: m[2] } : null;
}

// ---- the server's copy of a delivery's ticket: <state>/tickets/<batch id>.json, 0600 --------------------------------------------------
// Written when a batch is delivered (and on every renewal), removed when the delivery ends. `status <file> --ticket` reads it for the agent
// whose holder id matches; `apply`/`commit` read it to know a delivery exists for a file even when the server is gone (fail closed).
const ticketsDir = () => sub("tickets");
const ticketFile = (batchId) => path.join(ticketsDir(), `${batchId}.json`);

export function saveTicket(key, { batchId, holder, token }) {
  writeStateFile(ticketFile(batchId), JSON.stringify({ key, batch_id: batchId, holder, token }));
}
export function loadTicketRecord(batchId) {
  try {
    const j = JSON.parse(fs.readFileSync(ticketFile(String(batchId)), "utf8"));
    return j && j.batch_id && j.token ? j : null;
  } catch {
    return null;
  }
}
/** every saved ticket record of a session key */
function ticketsOf(key) {
  const out = [];
  let names = [];
  try {
    names = fs.readdirSync(ticketsDir());
  } catch {}
  for (const n of names) {
    if (!n.endsWith(".json")) continue;
    const rec = loadTicketRecord(n.slice(0, -5));
    if (rec && rec.key === key) out.push(rec);
  }
  return out;
}
export function clearTickets(key) {
  for (const rec of ticketsOf(key)) {
    try {
      fs.unlinkSync(ticketFile(rec.batch_id));
    } catch {}
  }
}
export const hasDelivery = (realFile) => ticketsOf(sessionKey(realFile)).length > 0;
