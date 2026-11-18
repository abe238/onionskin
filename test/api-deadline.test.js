// web/src/lib.js api(): every page request has a deadline. A server that takes the request and never answers (headers, or a body that
// never ends) gives an error with no status after it, which the page treats as a lost answer (it asks for the state, App.jsx checkSent).
import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { REQUEST_MS, SEND_MS, api } from "../web/src/lib.js";

test("a request with no answer, or an answer that never ends, fails after its deadline with no status", async () => {
  const held = [];
  const srv = http.createServer((req, res) => {
    held.push(res);
    if (req.url === "/half") res.writeHead(200, { "content-type": "application/json" }).write("{");
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    for (const p of ["/none", "/half"]) {
      const t0 = Date.now();
      const err = await api(`${base}${p}`, { timeout: 300 }).then(() => null, (e) => e);
      assert.ok(err, p);
      assert.equal(err.status, undefined, `${p}: no status, so it is a lost answer`);
      assert.match(err.message, /failed to fetch/i, p);
      assert.ok(Date.now() - t0 < 3000, `${p}: within about its deadline`);
    }
    assert.ok(SEND_MS > REQUEST_MS && REQUEST_MS > 125_000, "longer than a save can wait for a Send of the file (Sessions.settled)");
  } finally {
    for (const r of held) r.destroy();
    srv.close();
  }
});
