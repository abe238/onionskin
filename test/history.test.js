// Change history (src/history.js, src/diff.js, GET /api/history and /api/history/:id): rounds recorded by the session, lazy counts and places.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { after, before, test } from "node:test";
import { tmpdir, docxBytes, buildZip, contentTypes } from "./helpers/zipbuild.js";

const root = tmpdir("da-history-");
process.env.ONIONSKIN_STATE_DIR = path.join(root, "st");
process.env.ONIONSKIN_WEB_DIST = path.join(root, "dist");
process.env.ONIONSKIN_TICK_MS = "100000";
process.env.ONIONSKIN_LEASE_MS = "600000";
process.env.ONIONSKIN_NO_SOFFICE = "1";
process.env.ONIONSKIN_NO_OPEN = "1";
delete process.env.ONIONSKIN_PYTHON;
fs.mkdirSync(process.env.ONIONSKIN_WEB_DIST);
fs.writeFileSync(path.join(process.env.ONIONSKIN_WEB_DIST, "index.html"), "<!doctype html><title>t</title>");
const { startServer } = await import("../src/server.js");
const { socketPath } = await import("../src/paths.js");
const { sha256 } = await import("../src/fsutil.js");
const { compareBytes, matchParagraphs, MAX_PLACES } = await import("../src/history.js");

let srv;
before(async () => {
  srv = await startServer();
});
after(() => {
  srv.shutdown();
  fs.rmSync(root, { recursive: true, force: true });
});

// ---- harness: the real server over its two transports ---------------------------------------------------------------------
const tcp = (opts, body) =>
  new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port: srv.port, ...opts }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString() }));
    });
    r.on("error", reject);
    if (body) r.write(body);
    r.end();
  });
const sock = (method, p, body) =>
  new Promise((resolve, reject) => {
    const r = http.request({ socketPath: socketPath(), method, path: p, headers: body ? { "content-type": "application/json" } : {} }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString() || "{}") }));
    });
    r.on("error", reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });

/** Opens a file through the CLI socket and logs a browser in (nonce exchange): returns helpers for that document. */
async function session(file) {
  const o = await sock("POST", "/cli/open", { file });
  assert.equal(o.status, 200, JSON.stringify(o.json));
  const url = new URL(o.json.url);
  const first = await tcp({ path: url.pathname + url.search, method: "GET" });
  const cookie = first.headers["set-cookie"][0].split(";")[0];
  const token = /<meta name="onionskin-launch" content="([\w-]+)">/.exec(first.text)[1];
  const key = o.json.key;
  const hdr = (post) => ({ cookie, "x-onionskin-token": token, "sec-fetch-site": "same-origin", ...(post ? { origin: `http://127.0.0.1:${srv.port}`, "content-type": "application/json" } : {}) });
  const get = async (p) => {
    const r = await tcp({ path: `${p}${p.includes("?") ? "&" : "?"}s=${key}`, method: "GET", headers: hdr(false) });
    return { status: r.status, json: r.text.startsWith("{") ? JSON.parse(r.text) : null, raw: r.text, headers: r.headers };
  };
  const post = async (p, body) => {
    const r = await tcp({ path: `${p}?s=${key}`, method: "POST", headers: hdr(true) }, JSON.stringify(body));
    return { status: r.status, json: JSON.parse(r.text || "{}") };
  };
  return {
    key, file, cookie, token, get, post,
    bootstrap: async () => (await get("/api/bootstrap")).json.session,
    list: async () => (await get("/api/history")).json,
    detail: async (id) => get(`/api/history/${id}`),
    /** the page loads the file: records an outside change when the disk holds a version the session does not know */
    load: async () => get("/api/file"),
    send: async (bytes, extra = {}) => post("/api/send", { baseSha: (await get("/api/bootstrap")).json.session.baseSha, bytesB64: bytes.toString("base64"), comments: [], note: "", edits: [], ...extra }),
  };
}

const para = (i) => `Paragraph ${i + 1}: some real sentence number ${i * 5 + 3} for the history tests.`;
const paras = (n = 40) => Array.from({ length: n }, (_, i) => para(i));
const docIn = (name, list = paras()) => {
  const f = path.join(root, name);
  fs.writeFileSync(f, docxBytes(list));
  return fs.realpathSync(f);
};
const edited = (list, edits) => {
  const out = [...list];
  for (const [i, t] of Object.entries(edits)) out[i] = t;
  return out;
};

/** An agent round over the socket: poll for the delivery, write `bytes`, finish. */
async function agentRun(S, bytes, summary, comment) {
  const polled = sock("GET", `/cli/poll?file=${encodeURIComponent(S.file)}`);
  const sent = await S.post("/api/send", { baseSha: (await S.bootstrap()).baseSha, comments: [comment], note: "", edits: [] });
  assert.equal(sent.status, 200, JSON.stringify(sent.json));
  const batch = (await polled).json;
  const claim = { holder: batch.lease.holder, batch_id: batch.batch_id, lease_token: batch.lease.token };
  const w = await sock("POST", "/cli/agent-write", { file: S.file, base_sha256: sha256(fs.readFileSync(S.file)), bytes_b64: bytes.toString("base64"), ...claim });
  assert.equal(w.status, 200, JSON.stringify(w.json));
  const d = await sock("POST", "/cli/done", { file: S.file, results: { summary, results: [{ comment_id: comment.id, status: "done", note: "ok" }] }, ...claim });
  assert.equal(d.status, 200, JSON.stringify(d.json));
}

// ---- the sequence: user Send, agent run, revert, outside change --------------------------------------------------------------
test("history: user Send, agent run, revert and a reloaded outside change are four updates, newest first, with counts and exact diffs", async () => {
  const f = docIn("rounds.docx");
  const S = await session(f);
  assert.deepEqual((await S.list()).updates, [], "a fresh session has no history");

  // 1. the user types an edit and sends it
  const typed = edited(paras(), { 2: para(2).replace("real", "typed") });
  assert.equal((await S.send(docxBytes(typed), { comments: [{ id: "c1", kind: "element", text: "check", anchor: { location: { blockPath: [4] }, paraText: para(4) } }] })).status, 200);
  // 2. the agent rewrites a sentence, adds a paragraph and deletes one
  const agentList = edited(typed, { 4: "Paragraph 5: a rewritten sentence number 23 for the history tests." });
  agentList.splice(8, 0, "A brand new paragraph that the agent added to the document.");
  agentList.splice(10, 1); // the old Paragraph 10 is gone (it moved down one place after the insert)
  const polled = sock("GET", `/cli/poll?file=${encodeURIComponent(f)}`);
  const batch = (await polled).json;
  const claim = { holder: batch.lease.holder, batch_id: batch.batch_id, lease_token: batch.lease.token };
  const w = await sock("POST", "/cli/agent-write", { file: f, base_sha256: sha256(fs.readFileSync(f)), bytes_b64: docxBytes(agentList).toString("base64"), ...claim });
  assert.equal(w.status, 200, JSON.stringify(w.json));
  const summary = "Reworded paragraph 5, added a paragraph, removed one.‮​";
  const d = await sock("POST", "/cli/done", { file: f, results: { summary, results: [{ comment_id: "c1", status: "done", note: "ok" }] }, ...claim });
  assert.equal(d.status, 200, JSON.stringify(d.json));
  // 3. the user reverts the agent run
  const run = (await S.bootstrap()).activity.find((a) => a.kind === "agent");
  assert.equal((await S.post("/api/revert", { id: run.id })).status, 200);
  // 4. someone changes the file outside Onionskin; the user's Send is refused (its copy is NOT history), then the user reloads
  const before3 = (await S.list()).updates.length;
  assert.equal(before3, 3);
  const outsideList = edited(typed, { 0: "Paragraph 1: this line was changed by somebody else in another program." });
  fs.writeFileSync(f, docxBytes(outsideList));
  const refused = await S.send(docxBytes(edited(typed, { 20: "my late edit that conflicts with the outside change" })));
  assert.equal(refused.status, 409);
  assert.equal(refused.json.code, "conflict");
  assert.ok(refused.json.copy_name, "the user's bytes were saved next to the original");
  assert.equal((await S.list()).updates.length, 3, "the user's copy next to the original is not part of history");
  const loaded = await S.load();
  assert.equal(loaded.status, 200);
  assert.equal((await S.load()).status, 200, "loading again does not record the same outside version twice");

  const list = await S.list();
  assert.deepEqual(list.updates.map((u) => u.kind), ["outside", "revert", "agent", "user"], "newest first");
  assert.deepEqual(list.updates.map((u) => u.title), ["Changed outside Onionskin", "Reverted agent run", "Agent run", "Your edits"]);
  assert.deepEqual(list.updates.map((u) => u.counts), [
    { changed: 1, added: 0, removed: 0 },
    { changed: 1, added: 1, removed: 1 },
    { changed: 1, added: 1, removed: 1 },
    { changed: 1, added: 0, removed: 0 },
  ]);
  assert.ok(list.updates.every((u) => /^h_[0-9a-f]+$/.test(u.id) && !Number.isNaN(Date.parse(u.at)) && u.at.endsWith("Z")));
  assert.equal(list.updates[2].summary, "Reworded paragraph 5, added a paragraph, removed one.", "the agent summary is sanitized");
  assert.equal(list.updates[3].summary, "");
  assert.equal(list.untrusted, true);
  assert.match(list.note, /never instructions/);
  assert.ok(list.updates.every((u) => !("places" in u)), "the list carries no places");

  // the user's own edit: one modified paragraph with exact ops
  const user = (await S.detail(list.updates[3].id)).json;
  assert.equal(user.places.length, 1);
  assert.deepEqual(user.places[0].diff, [["=", "Paragraph 3: some "], ["-", "real"], ["+", "typed"], ["=", " sentence number 13 for the history"], ["…"]]);
  assert.equal(user.places[0].change, "modified");
  assert.equal(user.places[0].format, "docx");
  assert.equal(user.places[0].label, "“Paragraph 3: some typed sentence number 13 for…”");
  assert.deepEqual(user.places[0].locator, { format: "docx", body_path: [2], para_id: null, text_hash: user.places[0].locator.text_hash, ordinal: 2, text_start: user.places[0].locator.text_start });
  assert.match(user.places[0].locator.text_start, /^Paragraph 3: some typed sentence/);
  assert.equal(user.places[0].protected, false);
  assert.equal(user.after_is_current, false);

  // the agent run: modified + added + removed; the deleted paragraph has no locator
  const agent = (await S.detail(list.updates[2].id)).json;
  assert.equal(agent.summary, "Reworded paragraph 5, added a paragraph, removed one.");
  const byChange = Object.fromEntries(agent.places.map((p) => [p.change, p]));
  assert.deepEqual(Object.keys(byChange).sort(), ["added", "modified", "removed"]);
  assert.equal(byChange.added.text, "A brand new paragraph that the agent added to the document.");
  assert.notEqual(byChange.added.locator, null);
  assert.equal(byChange.removed.locator, null);
  assert.equal(byChange.removed.text, para(9));
  assert.deepEqual(byChange.modified.diff, [["=", "Paragraph 5: "], ["-", "some real"], ["+", "a rewritten"], ["=", " sentence number 23 for the history"], ["…"]]);
  assert.equal(agent.more, 0);

  // the revert undoes the same three places; the outside change is a plain modified paragraph
  const revert = (await S.detail(list.updates[1].id)).json;
  assert.deepEqual(revert.places.map((p) => p.change).sort(), ["added", "modified", "removed"]);
  const outside = (await S.detail(list.updates[0].id)).json;
  assert.equal(outside.places.length, 1);
  assert.equal(outside.places[0].change, "modified");
  assert.equal(outside.after_is_current, true, "the newest update ends at the file on disk");
  assert.deepEqual(outside.places[0].diff.filter((o) => o[0] === "+" || o[0] === "-").map((o) => o[0]), ["-", "+"]);

  assert.equal((await S.detail("h_doesnotexist")).status, 404);
  assert.equal((await S.detail("..%2F..%2Fetc")).status, 404);
  // the page never needs the file to be rewritten: reading history leaves the document alone
  const disk = sha256(fs.readFileSync(f));
  await S.list();
  await S.detail(list.updates[0].id);
  assert.equal(sha256(fs.readFileSync(f)), disk, "history is read-only");
});

test("history: routes need the cookie and the launch token like every other API route", async () => {
  const f = docIn("auth.docx");
  const S = await session(f);
  const none = await tcp({ path: `/api/history?s=${S.key}`, method: "GET", headers: { "sec-fetch-site": "same-origin" } });
  assert.ok([401, 403].includes(none.status), String(none.status));
  const noToken = await tcp({ path: `/api/history?s=${S.key}`, method: "GET", headers: { cookie: S.cookie, "sec-fetch-site": "same-origin" } });
  assert.equal(noToken.status, 403);
  const wrong = await tcp({ path: `/api/history?s=${S.key}`, method: "GET", headers: { cookie: S.cookie, "x-onionskin-token": "wrong", "sec-fetch-site": "same-origin" } });
  assert.equal(wrong.status, 403);
  const detail = await tcp({ path: `/api/history/h_abc?s=${S.key}`, method: "GET", headers: { cookie: S.cookie, "sec-fetch-site": "same-origin" } });
  assert.equal(detail.status, 403);
  const post = await tcp({ path: `/api/history?s=${S.key}`, method: "POST", headers: { ...{ cookie: S.cookie, "x-onionskin-token": S.token, "sec-fetch-site": "same-origin", origin: `http://127.0.0.1:${srv.port}`, "content-type": "application/json" } } }, "{}");
  assert.notEqual(post.status, 200, "history has no write route");
  assert.equal((await S.get("/api/history")).status, 200);
  // not on the CLI socket
  assert.equal((await sock("GET", `/cli/history?s=${S.key}`)).status, 404);
});

// ---- places per format (pure) ------------------------------------------------------------------------------------------------
const lines = (n, f = (i) => `Line ${i + 1} holds a sentence of reasonable length for matching.`) => Array.from({ length: n }, (_, i) => f(i));

test("history docx: a paragraph that only moved is a move, not a delete plus an add", () => {
  const A = lines(12);
  const B = [...A];
  const [m] = B.splice(1, 1); // Line 2 moves down
  B.splice(8, 0, m);
  const r = compareBytes("docx", docxBytes(A), docxBytes(B), { places: true });
  assert.deepEqual(r.counts, { changed: 1, added: 0, removed: 0 });
  assert.equal(r.places.length, 1);
  assert.equal(r.places[0].change, "moved");
  assert.equal(r.places[0].note, "moved");
  assert.notEqual(r.places[0].locator, null);
});

test("history docx: an edited and moved paragraph is matched by similarity; unrelated add and remove stay add and remove", () => {
  const A = lines(10);
  const B = [...A];
  B.splice(1, 1);
  B.splice(7, 0, "Line 2 holds a sentence of reasonable length for matching, now with extra words.");
  const r = compareBytes("docx", docxBytes(A), docxBytes(B), { places: true });
  assert.deepEqual(r.counts, { changed: 1, added: 0, removed: 0 });
  assert.equal(r.places[0].change, "modified");
  const C = [...A];
  C.splice(3, 1);
  C.splice(6, 0, "Completely unrelated closing remark about quarterly budgets and travel.");
  const r2 = compareBytes("docx", docxBytes(A), docxBytes(C), { places: true });
  assert.deepEqual(r2.counts, { changed: 0, added: 1, removed: 1 });
});

test("history docx: paragraph ids pair an edited paragraph even when its words changed completely", () => {
  const mk = (t) => [{ text: "First stable paragraph of the file, long enough.", paraId: "0000000A" }, { text: t, paraId: "0000000B" }, { text: "Last stable paragraph of the file, long enough.", paraId: "0000000C" }];
  const A = docxBytes(mk("Original wording about the schedule."));
  const B = docxBytes(mk("Nothing alike remains here at all, honestly."));
  const r = compareBytes("docx", A, B, { places: true });
  assert.deepEqual(r.counts, { changed: 1, added: 0, removed: 0 });
  assert.equal(r.places[0].locator.para_id, "0000000B");
  const { mapA } = matchParagraphs([{ hash: "a", text: "x", paraId: null }], [{ hash: "a", text: "x", paraId: null }]);
  assert.equal(mapA[0], 0);
});

test("history docx: a spacing-only edit is formatting with no ops, blank paragraphs are ignored, identical files have zero counts", () => {
  const A = ["Alpha  beta gamma delta epsilon.", "Second paragraph that stays."];
  const B = ["Alpha beta gamma delta epsilon.", "Second paragraph that stays.", "", ""];
  const r = compareBytes("docx", docxBytes(A), docxBytes(B), { places: true });
  assert.deepEqual(r.counts, { changed: 1, added: 0, removed: 0 }, "the two blank paragraphs are not changes; the collapsed space is one formatting change");
  assert.equal(r.places[0].change, "formatting");
  assert.equal(r.places[0].diff, null);
  assert.equal(r.places[0].note, "spacing changed");
  assert.deepEqual(compareBytes("docx", docxBytes(A), docxBytes(A), { places: true }), { counts: { changed: 0, added: 0, removed: 0 }, places: [], more: 0 });
});

test("history: places are capped at 200 with a `more` count, and counts stay exact", () => {
  const A = lines(5);
  const B = lines(5).concat(lines(260, (i) => `Added paragraph number ${i} with its own unique words ${i * 7919}.`));
  const full = compareBytes("docx", docxBytes(A), docxBytes(B), { places: true });
  assert.equal(full.places.length, MAX_PLACES);
  assert.equal(full.more, 60);
  assert.equal(full.counts.added, 260);
  const counts = compareBytes("docx", docxBytes(A), docxBytes(B), { places: false });
  assert.deepEqual(counts.counts, full.counts);
  assert.equal(counts.places, null, "counts-only mode builds no places");
});

const xlsxBytes = (rows, { sheet = "Sheet1" } = {}) => {
  const cell = (r, c, v) => {
    const ref = `${"ABCDEFG"[c]}${r + 1}`;
    if (v && typeof v === "object") return `<c r="${ref}"><f>${v.f}</f><v>${v.v}</v></c>`;
    if (typeof v === "number") return `<c r="${ref}"><v>${v}</v></c>`;
    return `<c r="${ref}" t="inlineStr"><is><t>${v}</t></is></c>`;
  };
  const sd = rows.map((row, r) => `<row r="${r + 1}">${row.map((v, c) => (v == null ? "" : cell(r, c, v))).join("")}</row>`).join("");
  return buildZip({
    "[Content_Types].xml": contentTypes("xlsx"),
    "xl/workbook.xml": `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${sheet}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="x/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    "xl/worksheets/sheet1.xml": `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sd}</sheetData></worksheet>`,
  });
};

test("history xlsx: a changed cell shows before and after (and the formula), an inserted row is one added place, shifted rows are not changes", () => {
  const base = [["Item", "Q1", "Q2"], ["Rent", 1000, 1000], ["Travel", 250, 300], ["Total", { f: "SUM(B2:B3)", v: 1250 }, { f: "SUM(C2:C3)", v: 1300 }]];
  const next = [["Item", "Q1", "Q2"], ["Rent", 1000, 1000], ["Software", 80, 90], ["Travel", 250, 450], ["Total", { f: "SUM(B2:B4)", v: 1330 }, { f: "SUM(C2:C4)", v: 1540 }]];
  const r = compareBytes("xlsx", xlsxBytes(base), xlsxBytes(next), { places: true });
  const by = Object.fromEntries(r.places.map((p) => [p.label, p]));
  assert.deepEqual(r.counts, { changed: 3, added: 1, removed: 0 });
  assert.deepEqual(by["Sheet1!A3:C3"].change, "added", "the new row, once");
  assert.equal(by["Sheet1!A3:C3"].text, "Software | 80 | 90");
  assert.deepEqual(by["Sheet1!C4"].before, { value: "300", formula: null });
  assert.deepEqual(by["Sheet1!C4"].after, { value: "450", formula: null });
  assert.equal(by["Sheet1!C4"].change, "modified");
  assert.deepEqual(by["Sheet1!B5"].before, { value: "1250", formula: "SUM(B2:B3)" });
  assert.deepEqual(by["Sheet1!B5"].after, { value: "1330", formula: "SUM(B2:B4)" });
  assert.deepEqual(by["Sheet1!C4"].locator, { format: "xlsx", sheet: "Sheet1", sheet_id: "1", range: "C4", text_hash: by["Sheet1!C4"].locator.text_hash });
  assert.ok(!r.places.some((p) => /!A4|!A5$/.test(p.label)), "Travel and Total only moved down");
  // a removed row and a new sheet name
  const gone = compareBytes("xlsx", xlsxBytes(next), xlsxBytes(base), { places: true });
  assert.deepEqual(gone.counts, { changed: 3, added: 0, removed: 1 });
  assert.equal(gone.places.find((p) => p.change === "removed").locator, null);
  const renamed = compareBytes("xlsx", xlsxBytes(base), xlsxBytes(base, { sheet: "Other" }), { places: true });
  assert.deepEqual(renamed.counts, { changed: 0, added: 0, removed: 0 }, "the same sheet under a new name is matched by its id");
});

const pptxBytes = (slides) => {
  const sp = (id, name, text, ph, rpr = "") => `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr/><p:nvPr>${ph ? `<p:ph type="${ph}"/>` : ""}</p:nvPr></p:nvSpPr><p:txBody><a:p><a:r>${rpr}<a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`;
  const files = {
    "[Content_Types].xml": contentTypes("pptx"),
    "ppt/presentation.xml": `<?xml version="1.0"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst>${slides.map((s, i) => `<p:sldId id="${s.id}" r:id="rId${i + 1}"/>`).join("")}</p:sldIdLst></p:presentation>`,
    "ppt/_rels/presentation.xml.rels": `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${slides.map((s, i) => `<Relationship Id="rId${i + 1}" Type="x/slide" Target="slides/slide${s.id}.xml"/>`).join("")}</Relationships>`,
  };
  for (const s of slides) files[`ppt/slides/slide${s.id}.xml`] = `<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree>${s.shapes.map((x) => sp(x[0], x[1], x[2], x[3], x[4])).join("")}${s.pic ? `<p:pic><p:nvPicPr><p:cNvPr id="${s.pic}" name="Picture"/></p:nvPicPr></p:pic>` : ""}</p:spTree></p:cSld></p:sld>`;
  return buildZip(files);
};

test("history pptx: a shape text change is a word diff, an inserted slide is one added place, an untouched slide is silent", () => {
  const s1 = { id: 256, shapes: [[2, "Title 1", "Quarterly plan", "title"], [3, "Content 2", "We will hire two engineers in the spring."]] };
  const s2 = { id: 257, shapes: [[2, "Title 1", "Risks", "title"], [3, "Content 2", "Supply is tight."]] };
  const s3 = { id: 258, shapes: [[2, "Title 1", "Budget", "title"], [3, "Content 2", "Flat year over year."]] };
  const A = pptxBytes([s1, s2]);
  const s1b = { id: 256, shapes: [[2, "Title 1", "Quarterly plan", "title"], [3, "Content 2", "We will hire three engineers in the spring."]] };
  const B = pptxBytes([s1b, s3, s2]);
  const r = compareBytes("pptx", A, B, { places: true });
  assert.deepEqual(r.counts, { changed: 1, added: 1, removed: 0 });
  const mod = r.places.find((p) => p.change === "modified");
  assert.equal(mod.label, "Slide 1, Content 2");
  assert.deepEqual(mod.diff, [["=", "We will hire "], ["-", "two"], ["+", "three"], ["=", " engineers in the spring."]]);
  assert.deepEqual(mod.locator, { format: "pptx", slide_id: "256", slide_index: 0, shape_id: 3, text_hash: mod.locator.text_hash });
  const add = r.places.find((p) => p.change === "added");
  assert.equal(add.label, 'Slide 2, "Budget"');
  assert.equal(add.text, "Budget / Flat year over year.");
  assert.equal(add.locator.slide_id, "258");
  // reordering slides is a move; a removed slide has no locator; a picture is a note, not text
  const moved = compareBytes("pptx", A, pptxBytes([s2, s1]), { places: true });
  assert.deepEqual(moved.counts, { changed: 1, added: 0, removed: 0 });
  assert.equal(moved.places[0].change, "moved");
  const dropped = compareBytes("pptx", A, pptxBytes([s1]), { places: true });
  assert.equal(dropped.places[0].change, "removed");
  assert.equal(dropped.places[0].locator, null);
  const pic = compareBytes("pptx", A, pptxBytes([{ ...s1, pic: 9 }, s2]), { places: true });
  assert.equal(pic.places[0].note, "an image was added");
});

// ---- hostile text, retention, performance --------------------------------------------------------------------------------------
const STRANGE = /[\u0000-\u001F\u007F-\u009F؜​-‏‪-‮⁠-⁤⁦-⁩﻿]/;
const strings = (v, out = []) => (typeof v === "string" ? out.push(v) : v && typeof v === "object" && Object.values(v).forEach((x) => strings(x, out)), out);

test("history: every document-derived string is stripped of control and bidi characters and capped", () => {
  const evil = "‮evil\u0007 text​ with ⁦bidi⁩ and \u0000 nul";
  const long = `${"long words ".repeat(900)}END`;
  const A = [evil + " before", "Second paragraph that stays the same for matching.", long];
  const B = [evil + " after the edit", "Second paragraph that stays the same for matching.", `${long} and more`, `‮${"x".repeat(5000)}`];
  const r = compareBytes("docx", docxBytes(A.map((t) => t.replace(/[\u0000-\u0008]/g, ""))), docxBytes(B.map((t) => t.replace(/[\u0000-\u0008]/g, ""))), { places: true });
  assert.ok(r.places.length >= 2);
  const all = strings(r.places);
  assert.ok(all.length > 5);
  for (const s of all) assert.ok(!STRANGE.test(s), JSON.stringify(s.slice(0, 40)));
  for (const p of r.places) {
    assert.ok(p.label.length <= 140, "labels are capped");
    if (p.text) assert.ok([...p.text].length <= 300, "added / removed text is capped at 300 characters");
    if (p.diff) assert.ok(JSON.stringify(p.diff).length < 2500, "diff ops are size-capped");
  }
  assert.ok(all.some((s) => s.includes("evil")), "the readable text is kept");
  assert.ok(r.places.some((p) => p.text?.endsWith("…[truncated]")), "a long text is cut with the marker");
  // an XLSX cell and a PPTX shape name carry hostile text too
  const x = compareBytes("xlsx", xlsxBytes([["a", "‮x"]]), xlsxBytes([["a", "‮y​"]]), { places: true });
  for (const s of strings(x.places)) assert.ok(!STRANGE.test(s));
});

test("history: retention follows the snapshots (a pruned version drops its update), and the cache is per snapshot pair, 0600, with warm and cold timings", async () => {
  const f = docIn("perf.docx", paras(300));
  const S = await session(f);
  let current = paras(300);
  const ids = [];
  for (let k = 0; k < 20; k++) {
    current = edited(current, { [(k * 13) % 300]: `${current[(k * 13) % 300]} Revision ${k}.` });
    assert.equal((await S.send(docxBytes(current))).status, 200);
    if (k === 0) ids.push((await S.list()).updates[0].id);
  }
  const first = await S.list(); // cold or warmed by the sends, either way it settles
  assert.equal(first.updates.length, 20, "the newest 20 updates");
  assert.ok(first.updates.every((u) => u.counts?.changed === 1 && u.counts.added === 0));

  const dir = path.join(process.env.ONIONSKIN_STATE_DIR, "history", S.key);
  const cached = fs.readdirSync(dir).filter((x) => x.endsWith(".json"));
  assert.equal(cached.length, 20, "one cache file per snapshot pair");
  for (const c of cached) assert.equal(fs.statSync(path.join(dir, c)).mode & 0o777, 0o600);

  // warm: from the cache on disk
  const t0 = performance.now();
  const warm = await S.get("/api/history");
  const warmMs = performance.now() - t0;
  assert.equal(warm.status, 200);

  // cold: no cache, every pair computed (in a worker thread: the event loop stays free)
  for (const c of cached) fs.rmSync(path.join(dir, c));
  let ticks = 0;
  const beat = setInterval(() => ticks++, 5);
  const t1 = performance.now();
  const cold = await S.get("/api/history");
  const coldMs = performance.now() - t1;
  clearInterval(beat);
  console.log(`# history timings: warm list ${warmMs.toFixed(0)} ms, cold list (20 pairs, 300 paragraphs) ${coldMs.toFixed(0)} ms, event-loop ticks during cold list ${ticks}`);
  assert.equal(cold.status, 200);
  assert.deepEqual(cold.json.updates.map((u) => u.counts), first.updates.map((u) => u.counts));
  assert.ok(coldMs < 4000, `cold list took ${coldMs.toFixed(0)} ms`);
  // timings are relative to the cold list measured here, so a busy machine slows both sides alike
  assert.ok(warmMs < coldMs / 3, `warm list (${warmMs.toFixed(0)} ms) is much faster than the cold list (${coldMs.toFixed(0)} ms)`);
  assert.ok(ticks >= 3, "the event loop kept running while the pairs were compared");

  // detail: cold (counts-only cache entry), then warm
  const id = first.updates[5].id;
  const t2 = performance.now();
  const det = await S.detail(id);
  const detMs = performance.now() - t2;
  console.log(`# history timings: detail ${detMs.toFixed(0)} ms`);
  assert.equal(det.status, 200);
  assert.equal(det.json.places.length, 1);
  assert.ok(detMs < coldMs, `one update's detail (${detMs.toFixed(0)} ms) costs less than comparing all 20 pairs (${coldMs.toFixed(0)} ms)`);
  const t3 = performance.now();
  assert.equal((await S.detail(id)).status, 200);
  const detWarmMs = performance.now() - t3;
  assert.ok(detWarmMs < detMs, `a cached detail (${detWarmMs.toFixed(0)} ms) is faster than the first (${detMs.toFixed(0)} ms)`);

  // two more Sends push the oldest versions out of the snapshot store: their updates disappear from the list
  for (let k = 20; k < 22; k++) {
    current = edited(current, { [(k * 13) % 300]: `${current[(k * 13) % 300]} Revision ${k}.` });
    assert.equal((await S.send(docxBytes(current))).status, 200);
  }
  const after2 = await S.list();
  assert.ok(!after2.updates.some((u) => u.id === ids[0]), "the first update's snapshot was pruned");
  assert.equal((await S.detail(ids[0])).status, 404);
  assert.ok(after2.updates.length < 20 && after2.updates.length >= 18, `${after2.updates.length} updates remain`);
  assert.equal(after2.updates[0].counts.changed, 1);
  // pruning a blob by hand hides the updates that need it, and only those
  const stateDir = process.env.ONIONSKIN_STATE_DIR;
  const hist = JSON.parse(fs.readFileSync(path.join(stateDir, "sessions", `${S.key}.json`), "utf8")).history;
  const victim = hist.find((u) => u.id === after2.updates[3].id);
  fs.rmSync(path.join(stateDir, "snapshots", S.key, `${victim.after}.bin`));
  const hidden = new Set(hist.filter((u) => u.before === victim.after || u.after === victim.after).map((u) => u.id));
  assert.equal(hidden.size, 2);
  const trimmed = await S.list();
  assert.deepEqual(new Set(after2.updates.map((u) => u.id).filter((x) => !trimmed.updates.some((u) => u.id === x))), hidden);
});

test("history: the schema and routes doc describe what the code sends", async () => {
  const { TITLES, REVERT_LOCAL_TITLE } = await import("../src/history.js");
  const schema = JSON.parse(fs.readFileSync(new URL("../docs/contracts/history.schema.json", import.meta.url), "utf8"));
  assert.deepEqual(schema.$defs.head.properties.kind.enum, Object.keys(TITLES));
  assert.deepEqual([...schema.$defs.head.properties.title.enum].sort(), [...Object.values(TITLES), REVERT_LOCAL_TITLE].sort(), "one more title: a revert of a change made on this Mac");
  const r = compareBytes("docx", docxBytes(["Alpha beta gamma."]), docxBytes(["Alpha beta delta."]), { places: true });
  assert.deepEqual(Object.keys(r.places[0]).filter((k) => !["truncated", "too_large", "level"].includes(k)).sort(), [...schema.$defs.place.required].sort());
  assert.deepEqual(Object.keys(schema.$defs.place.properties).filter((k) => !schema.$defs.place.required.includes(k)).sort(), ["level", "too_large", "truncated"]);
  const routes = fs.readFileSync(new URL("../docs/contracts/routes.md", import.meta.url), "utf8");
  assert.ok(routes.includes("GET /api/history?s=") && routes.includes("GET /api/history/:id?s=") && routes.includes("no_such_update"));
});

// ---- formatting-only changes -----------------------------------------------------------------------------------------------
const wp = (text, { style, rpr = "", jc = "", runs } = {}) => `<w:p>${style || jc ? `<w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ""}${jc ? `<w:jc w:val="${jc}"/>` : ""}</w:pPr>` : ""}${(runs || [text]).map((t) => `<w:r>${rpr ? `<w:rPr>${rpr}</w:rPr>` : ""}<w:t>${t}</w:t></w:r>`).join("")}</w:p>`;
const docBody = (inner, extra = {}) => docxBytes(null, extra, inner);
const STYLES = '<?xml version="1.0"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/></w:style></w:styles>';

test("history docx formatting: make every heading bold is one formatting place per heading, with the property named", () => {
  const body = (bold) => [wp("Overview of the quarter", { style: "Heading1", rpr: bold ? "<w:b/>" : "" }), wp("A normal paragraph that stays as it is."), wp("Risks and open items", { style: "Heading1", rpr: bold ? "<w:b/>" : "" })].join("");
  const r = compareBytes("docx", docBody(body(false)), docBody(body(true)), { places: true });
  assert.deepEqual(r.counts, { changed: 2, added: 0, removed: 0 });
  assert.deepEqual(r.places.map((p) => [p.change, p.note, p.diff, p.label]), [["formatting", "bold", null, "“Overview of the quarter”"], ["formatting", "bold", null, "Risks and open items".replace(/^/, "“").replace(/$/, "”")]]);
  assert.equal(r.places[0].locator.text_start, "Overview of the quarter");
  // the same bold, but written as one run in one file and three runs in the other: no change
  const one = docBody(wp("Overview of the quarter", { rpr: "<w:b/>" }));
  const three = docBody(wp("", { rpr: "<w:b/>", runs: ["Over", "view of the ", "quarter"] }));
  assert.deepEqual(compareBytes("docx", one, three, { places: true }).counts, { changed: 0, added: 0, removed: 0 });
  // an explicit off is the same as nothing
  assert.deepEqual(compareBytes("docx", docBody(wp("Plain words here")), docBody(wp("Plain words here", { rpr: '<w:b w:val="0"/><w:i w:val="false"/>' })), { places: true }).counts.changed, 0);
});

test("history docx formatting: style names, alignment, color and size are reported in plain words and capped", () => {
  const A = docBody(wp("Quarterly outlook", { style: "Heading2" }) + wp("Body text for the outlook section."), { "word/styles.xml": STYLES });
  const B = docBody(wp("Quarterly outlook", { style: "Heading1" }) + wp("Body text for the outlook section.", { jc: "center", rpr: '<w:color w:val="C00000"/><w:sz w:val="28"/>' }), { "word/styles.xml": STYLES });
  const r = compareBytes("docx", A, B, { places: true });
  assert.deepEqual(r.places.map((p) => p.note), ["style: Heading 2 → Heading 1", "alignment, color, size"]);
  const many = compareBytes("docx", docBody(wp("Some words to format here")), docBody(wp("Some words to format here", { jc: "right", rpr: '<w:b/><w:i/><w:u w:val="single"/><w:strike/><w:color w:val="FF0000"/><w:sz w:val="40"/>' })), { places: true });
  assert.equal(many.places[0].note, "alignment, bold, italic, underline, and more");
  // a text edit stays a text edit (no second place for the same paragraph)
  const edited = compareBytes("docx", docBody(wp("Alpha beta gamma delta.")), docBody(wp("Alpha beta gamma epsilon.", { rpr: "<w:b/>" })), { places: true });
  assert.deepEqual(edited.places.map((p) => p.change), ["modified"]);
});

test("history pptx formatting: bold, size and color of a text run are formatting places; the text diff wins when the words changed too", () => {
  const deck = (title, rpr, text = "Steady as she goes.") => pptxBytes([{ id: 256, shapes: [[2, "Title 1", title, "title", rpr], [3, "Content 2", text, null, ""]] }]);
  const plain = deck("Quarterly plan", "");
  const bold = deck("Quarterly plan", '<a:rPr b="1" sz="4400"><a:solidFill><a:srgbClr val="c00000"/></a:solidFill></a:rPr>');
  const r = compareBytes("pptx", plain, bold, { places: true });
  assert.deepEqual(r.counts, { changed: 1, added: 0, removed: 0 });
  assert.deepEqual([r.places[0].change, r.places[0].note, r.places[0].label], ["formatting", "bold, color, size", "Slide 1, Title"]);
  assert.deepEqual(compareBytes("pptx", plain, deck("Quarterly plan", '<a:rPr b="0" i="0" sz=""/>'), { places: true }).counts, { changed: 0, added: 0, removed: 0 });
  const both = compareBytes("pptx", plain, deck("Quarterly plans", '<a:rPr b="1"/>'), { places: true });
  assert.deepEqual(both.places.map((p) => p.change), ["modified"]);
});

const stylesXml = (formats) => `<?xml version="1.0"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="$#,##0.00"/></numFmts><cellXfs count="${formats.length}">${formats.map((id) => `<xf numFmtId="${id}"/>`).join("")}</cellXfs></styleSheet>`;
const xlsxStyled = (styleIdxs, formats) =>
  buildZip({
    "[Content_Types].xml": contentTypes("xlsx"),
    "xl/workbook.xml": '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>',
    "xl/_rels/workbook.xml.rels": '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="x/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    "xl/styles.xml": stylesXml(formats),
    "xl/worksheets/sheet1.xml": `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Rent</t></is></c><c r="B1" s="${styleIdxs[0]}"><v>1200</v></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>Travel</t></is></c><c r="B2" s="${styleIdxs[1]}"><v>300</v></c></row></sheetData></worksheet>`,
  });

test("history xlsx formatting: a number format change is reported as old to new; renumbered style indexes with the same formats are not", () => {
  const before = xlsxStyled([0, 0], [0, 164]);
  const after = xlsxStyled([1, 0], [0, 164]); // B1 now uses xf 1 = $#,##0.00
  const r = compareBytes("xlsx", before, after, { places: true });
  assert.deepEqual(r.counts, { changed: 1, added: 0, removed: 0 });
  assert.deepEqual([r.places[0].label, r.places[0].change, r.places[0].note], ["Sheet1!B1", "formatting", "number format: General → $#,##0.00"]);
  // the writer reordered cellXfs: B1 uses xf 0 in one file and xf 1 in the other, but both mean $#,##0.00
  const a = xlsxStyled([0, 1], [164, 0]);
  const b = xlsxStyled([1, 0], [0, 164]);
  assert.deepEqual(compareBytes("xlsx", a, b, { places: true }).counts, { changed: 0, added: 0, removed: 0 });
  // a value change on the same cell stays a value change
  const moved = compareBytes("xlsx", xlsxBytes([["Rent", 1200]]), xlsxBytes([["Rent", 1300]]), { places: true });
  assert.deepEqual(moved.places.map((p) => p.change), ["modified"]);
});

// ---- "What changed": GET /api/history/all, the net change since the oldest stored version -----------------------------------------
test("history all: after a user edit, an agent run and its revert only the user's edit shows; a kept agent run adds its place", async () => {
  const f = docIn("all.docx");
  const S = await session(f);
  const empty = await S.get("/api/history/all");
  assert.equal(empty.status, 200);
  assert.deepEqual([empty.json.since, empty.json.counts, empty.json.places, empty.json.more, empty.json.untrusted], [null, { changed: 0, added: 0, removed: 0 }, [], 0, true], "no updates yet: nothing changed");

  const typed = edited(paras(), { 2: para(2).replace("real", "typed") });
  assert.equal((await S.send(docxBytes(typed), { comments: [{ id: "c1", kind: "element", text: "check", anchor: { location: { blockPath: [4] }, paraText: para(4) } }] })).status, 200);
  const batch = (await sock("GET", `/cli/poll?file=${encodeURIComponent(f)}`)).json;
  const claim = { holder: batch.lease.holder, batch_id: batch.batch_id, lease_token: batch.lease.token };
  const agentList = edited(typed, { 4: "Paragraph 5: a rewritten sentence number 23 for the history tests." });
  assert.equal((await sock("POST", "/cli/agent-write", { file: f, base_sha256: sha256(fs.readFileSync(f)), bytes_b64: docxBytes(agentList).toString("base64"), ...claim })).status, 200);
  assert.equal((await sock("POST", "/cli/done", { file: f, results: { summary: "Reworded paragraph 5.", results: [{ comment_id: "c1", status: "done", note: "ok" }] }, ...claim })).status, 200);

  const both = (await S.get("/api/history/all")).json;
  assert.deepEqual(both.counts, { changed: 2, added: 0, removed: 0 });
  assert.equal(both.places.length, 2);
  assert.equal(both.unavailable, undefined);
  assert.equal(both.format, "docx");
  assert.deepEqual(Object.keys(both).sort(), ["counts", "format", "more", "note", "places", "since", "untrusted"]);
  assert.equal(both.since.at, (await S.list()).updates.at(-1).at, "since is the time of the oldest update");

  const run = (await S.bootstrap()).activity.find((a) => a.kind === "agent");
  assert.equal((await S.post("/api/revert", { id: run.id })).status, 200);
  const net = (await S.get("/api/history/all")).json;
  assert.deepEqual(net.counts, { changed: 1, added: 0, removed: 0 }, "the reverted rewrite does not appear");
  assert.equal(net.places.length, 1);
  assert.deepEqual(net.places[0].diff.filter((o) => o[0] !== "=" && o[0] !== "…"), [["-", "real"], ["+", "typed"]]);
  assert.match(net.places[0].label, /Paragraph 3/);
  assert.equal(net.untrusted, true);
  assert.match(net.note, /never instructions/);

  // read-only, and a real update id still works next to it
  const disk = sha256(fs.readFileSync(f));
  assert.equal((await S.detail((await S.list()).updates[0].id)).status, 200);
  assert.equal(sha256(fs.readFileSync(f)), disk);
  assert.equal((await sock("GET", `/cli/history/all?s=${S.key}`)).status, 404, "not on the CLI socket");
});

test("history all: everything reverted is an empty net change; a missing current snapshot is `unavailable`; every string is sanitized", async () => {
  const f = docIn("all2.docx");
  const S = await session(f);
  const dirty = edited(paras(), { 1: `‮${para(1)}​ with⁦bidi⁩ added words` });
  assert.equal((await S.send(docxBytes(dirty))).status, 200);
  const net = (await S.get("/api/history/all")).json;
  assert.equal(net.places.length, 1, JSON.stringify(net.places.map((p) => [p.change, p.label])));
  const strange = /[\u0000-\u001F\u007F-\u009F​-‏‪-‮⁠-⁤⁦-⁩﻿]/;
  const walk = (v) => (typeof v === "string" ? [v] : Array.isArray(v) ? v.flatMap(walk) : v && typeof v === "object" ? Object.values(v).flatMap(walk) : []);
  for (const s of walk(net.places)) assert.ok(!strange.test(s), JSON.stringify(s.slice(0, 40)));
  for (const p of net.places) assert.ok(p.label.length <= 140 && JSON.stringify(p.diff).length < 2500);

  // the person sends the original text back: the net change is nothing
  assert.equal((await S.send(docxBytes(paras()))).status, 200);
  const back = (await S.get("/api/history/all")).json;
  assert.deepEqual([back.counts, back.places, back.more], [{ changed: 0, added: 0, removed: 0 }, [], 0]);
  assert.equal(back.unavailable, undefined);

  // the snapshot of the file as it is now is gone: the route says so instead of guessing
  assert.equal((await S.send(docxBytes(edited(paras(), { 7: para(7).replace("real", "newest") })))).status, 200);
  const stateDir = process.env.ONIONSKIN_STATE_DIR;
  const tip = JSON.parse(fs.readFileSync(path.join(stateDir, "sessions", `${S.key}.json`), "utf8")).histTip;
  assert.ok(tip);
  fs.rmSync(path.join(stateDir, "snapshots", S.key, `${tip}.bin`));
  const gone = await S.get("/api/history/all");
  assert.equal(gone.status, 200);
  assert.equal(gone.json.unavailable, true);
  assert.deepEqual([gone.json.counts, gone.json.places], [null, []]);
});

test("history: after done the newest agent update's places are cached, and a revert is not warmed", async () => {
  const f = docIn("warmnewest.docx");
  const S = await session(f);
  const dir = path.join(process.env.ONIONSKIN_STATE_DIR, "history", S.key);
  // one file at a time: a cache file that is being written right now (half a JSON) must not hide the others
  const hasPlaces = (x) => {
    try {
      return Array.isArray(JSON.parse(fs.readFileSync(path.join(dir, x), "utf8")).places);
    } catch {
      return false;
    }
  };
  const withPlaces = () => {
    try {
      return fs.readdirSync(dir).filter((x) => x.endsWith(".json") && hasPlaces(x));
    } catch {
      return [];
    }
  };
  const settle = async (n) => {
    for (let i = 0; i < 600 && withPlaces().length < n; i++) await new Promise((r) => setTimeout(r, 50)); // up to 30 s: the worker is slow on a busy machine
    return withPlaces();
  };
  assert.deepEqual(withPlaces(), []);
  const agentList = edited(paras(), { 4: "Paragraph 5: a rewritten sentence number 23 for the history tests." });
  await agentRun(S, docxBytes(agentList), "Reworded paragraph 5.", { id: "c1", kind: "element", text: "reword", anchor: { location: { blockPath: [4] }, paraText: para(4) } });
  const files = await settle(1);
  assert.equal(files.length, 1, "done warmed the places of the agent update");
  const file = path.join(dir, files[0]);
  const cached = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(cached.places.length, 1);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);

  // the page's detail request is served from that file: it is not rewritten
  const mtime = fs.statSync(file).mtimeMs;
  const id = (await S.list()).updates[0].id;
  const d = (await S.detail(id)).json;
  assert.equal(d.places.length, 1);
  assert.equal(d.places[0].change, "modified");
  assert.equal(fs.statSync(file).mtimeMs, mtime, "read from the cache, not recomputed");

  // after a revert the newest update is not an agent run: warmNewest computes nothing new
  const run = (await S.bootstrap()).activity.find((a) => a.kind === "agent");
  assert.equal((await S.post("/api/revert", { id: run.id })).status, 200);
  await new Promise((r) => setTimeout(r, 300));
  const { warmNewest } = await import("../src/history.js");
  assert.equal(await warmNewest({ history: [], snapshots: { has: () => true } }), undefined);
  assert.equal(withPlaces().length, 1, "the revert's places were not warmed");
});
