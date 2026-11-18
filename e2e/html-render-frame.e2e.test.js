// The render copy (src/html-render.js) in a real browser, in the frame the page will use: `<iframe sandbox="allow-same-origin" srcdoc>`
// on a page served with the app's CSP (src/auth.js). A second local server stands in for a remote host. A page of ordinary features
// that point at it (an image, a stylesheet link, a CSS url(), a script, a hyperlink, a form, a frame, a meta refresh, a preconnect) must
// reach it zero times, with and without the app's CSP, and nothing navigates when its links are clicked (plain, Cmd and middle click).
// A positive control first: the same page, unsanitized and with no CSP, does reach the stand-in.
// No page code (web/src) is involved: the parent page here is a fixed test page.
import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import "../src/html-parser.js";
import { CSP } from "../src/auth.js";
import * as H from "../src/html.js";
import { renderCopy } from "../src/html-render.js";
import { launch } from "./helpers/harness.mjs";

const listen = (handler) =>
  new Promise((resolve) => {
    const s = http.createServer(handler);
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
const escAttr = (s) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");

test("the render copy in the sandboxed, same-origin frame: zero requests to a remote stand-in, nothing navigates on click", async () => {
  const hits = [];
  const remote = await listen((req, res) => {
    hits.push(req.url);
    res.end("");
  });
  const R = `http://127.0.0.1:${remote.address().port}`;
  const source = `<!doctype html><html><head><title>Page</title>
<meta http-equiv="refresh" content="1;url=${R}/refresh"><link rel="preconnect" href="${R}"><link rel="stylesheet" href="${R}/s.css">
<style>body { background: url(${R}/bg.png) }</style><script src="${R}/a.js"></script></head>
<body><h1>Report</h1><p>Read <a id="l1" href="${R}/more">more</a>, <a id="l2" href="#part">jump</a> or <a id="l3" href="${R}/blank" target="_blank">new tab</a>.</p>
<img src="${R}/photo.png" alt="photo"><p style="background-image: url(${R}/p.png)">styled</p>
<form action="${R}/submit" method="post"><input name="q" value="x"><button id="send">Send</button></form>
<iframe src="${R}/frame"></iframe><h2 id="part">Part</h2></body></html>`;
  const copy = renderCopy(H.readHtml(Buffer.from(source)), { fileDir: null }).bytes.toString("utf8");
  let current = { html: "", csp: true };
  const app = await listen((req, res) => {
    if (current.csp) {
      res.setHeader("Content-Security-Policy", CSP);
      res.setHeader("X-DNS-Prefetch-Control", "off");
    }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(`<!doctype html><html><body><iframe id="f" sandbox="allow-same-origin" style="width:900px;height:600px" srcdoc="${escAttr(current.html)}"></iframe></body></html>`);
  });
  const base = `http://127.0.0.1:${app.address().port}/`;
  const b = await launch();
  try {
    const run = async (html, csp, click = []) => {
      current = { html, csp };
      hits.length = 0;
      const page = await b.page();
      const popups = [];
      let clicks = 0;
      page.context().on("page", (p) => popups.push(p));
      await page.goto(base);
      const frame = page.frameLocator("#f");
      await frame.locator("h1").waitFor();
      {
        for (const sel of click) {
          for (const el of await frame.locator(sel).all()) {
            for (const opts of [{}, { modifiers: ["Meta"] }, { button: "middle" }]) await el.click({ ...opts, force: true, timeout: 2000 }).then(() => clicks++, () => {});
          }
        }
      }
      await page.waitForTimeout(2000); // past the meta refresh's 1 s
      const url = page.frames().find((f) => f !== page.mainFrame())?.url();
      const out = { hits: [...hits], url, popups: popups.length, clicks };
      for (const p of popups) await p.close().catch(() => {});
      await page.close();
      return out;
    };
    // positive control: the unsanitized page, no CSP, reaches the stand-in
    const control = await run(source, false);
    assert.ok(control.hits.length >= 2, `the control reached the stand-in ${control.hits.length} times`);
    // and a click on its links, under the sandbox alone, navigates the frame or reaches the stand-in (spike S1 saw both)
    const links = `<!doctype html><h1>Links</h1><p><a href="${R}/more">more</a> <a href="#part">jump</a></p><h2 id="part">Part</h2>`;
    const clicked = await run(links, false, ["a"]);
    assert.ok(clicked.clicks > 0 && (clicked.hits.length > 0 || clicked.url !== "about:srcdoc" || clicked.popups > 0), `the click control did nothing: ${JSON.stringify(clicked)}`);
    console.log(`# control: ${control.hits.length} requests from the page itself; clicking its links: ${clicked.hits.length} requests, frame at ${clicked.url === "about:srcdoc" ? "about:srcdoc" : "another URL"}, ${clicked.popups} popups`);
    // the copy with no CSP from the app (the copy and its own meta CSP alone), then with the app's CSP
    for (const csp of [false, true]) {
      const r = await run(copy, csp, ["#send", "[data-osk-href]"]);
      assert.deepEqual(r.hits, [], `app CSP ${csp}: requests reached the stand-in`);
      assert.equal(r.url, "about:srcdoc", `app CSP ${csp}: the frame navigated`);
      assert.equal(r.popups, 0, `app CSP ${csp}: a popup opened`);
      assert.equal(r.clicks, 12, `app CSP ${csp}: every click was made (the button and three links, three ways each)`);
    }
  } finally {
    await b.close();
    remote.close();
    app.close();
  }
});
