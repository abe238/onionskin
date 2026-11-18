// web/src/html-view.js in Node: the page's mapping from a selection in the render copy to the page anchor, the pending edits of R9, the
// crash flag of R6 and the shape check of R11. The DOM is a parse5 tree of a REAL render copy (src/html-render.js renderCopy) made from
// the fixtures in test/fixtures/html, read through the same accessor interface the page builds from its own prototypes. The offsets are
// checked against the reading's source text nodes (`read.nodes[id].value`), the text src/html-write.js textEdit splices.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import "../src/html-parser.js";
import * as H from "../src/html.js";
import { renderCopy } from "../src/html-render.js";
import { editHash as serverEditHash } from "../src/edit-hash.js";
import { checkedHtmlWrite } from "../src/html-write.js";
import { anchorFromElement, anchorFromRange, buildIndex, canType, crashFlag, createEdits, editableSet, editHash, identities, locatedOf, noticesFor, plainSentence, rangeOfLocation, replaceHidden, restoreShape, SAY, shapeOf, slotText, typedChange } from "../web/src/html-view.js";

const FX = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "html");

/** The accessor interface over a parse5 tree (what realmDom gives the page over the frame). */
function p5Dom() {
  const kids = (n) => n.childNodes || [];
  const idx = (n) => (n.parentNode ? kids(n.parentNode).indexOf(n) : -1);
  const type = (n) => (n.nodeName === "#text" ? 3 : n.nodeName === "#comment" ? 8 : n.nodeName === "#document" ? 9 : n.nodeName === "#documentType" ? 10 : 1);
  const attr = (el, name) => el.attrs?.find((a) => a.name === name)?.value ?? null;
  return {
    parent: (n) => n.parentNode || null,
    first: (n) => kids(n)[0] || null,
    last: (n) => kids(n)[kids(n).length - 1] || null,
    next: (n) => (n.parentNode ? kids(n.parentNode)[idx(n) + 1] || null : null),
    prev: (n) => (n.parentNode ? kids(n.parentNode)[idx(n) - 1] || null : null),
    type,
    data: (n) => n.value,
    setData: (n, v) => (n.value = v),
    tag: (el) => el.tagName,
    attr,
    oskId: (el) => (attr(el, "data-osk-id") === null ? null : Number(attr(el, "data-osk-id"))),
    replaceChildren: (el, ...list) => {
      for (const c of list) c.parentNode = el;
      el.childNodes = list;
    },
  };
}

/** A fixture (or a source string) read, rendered and the copy parsed again: everything the mapping needs. */
function view(src) {
  const bytes = Buffer.isBuffer(src) ? src : Buffer.from(src);
  const read = H.readHtml(bytes);
  const r = renderCopy(read, { fileDir: null });
  assert.ok(!r.plain, `the copy rendered (${r.reason})`);
  const doc = H.htmlParser().parse(r.bytes.toString("utf8"), { scriptingEnabled: true });
  const D = p5Dom();
  const ix = buildIndex(D, doc);
  return { read, copy: r, doc, D, ix, texts: r.texts, root: doc, ctx: { D, ix, texts: r.texts, root: doc } };
}
const fixture = (name) => view(fs.readFileSync(path.join(FX, name)));
/** The first slot whose text contains `needle`: {n, first, text}. */
function slotWith(v, needle) {
  for (let n = 0; n < v.ix.count; n++) {
    const t = slotText(v.D, v.ix.firsts[n]);
    if (t.includes(needle)) return { n, first: v.ix.firsts[n], text: t };
  }
  throw new Error(`no text holds ${JSON.stringify(needle)}`);
}
const elementById = (v) => {
  const m = new Map();
  const walk = (n) => {
    if (n.attrs) {
      const id = v.D.oskId(n);
      if (id !== null) m.set(id, n);
    }
    for (const c of n.childNodes || []) walk(c);
  };
  walk(v.doc);
  return (id) => m.get(id) || null;
};
const slotOfSource = (v) => new Map(v.texts.map((src, n) => [src, n]).filter(([src]) => src >= 0));

test("the frame's text slots line up with the copy's texts array for every fixture that renders", () => {
  let checked = 0;
  for (const name of fs.readdirSync(FX).filter((f) => /\.html?$/.test(f))) {
    let read;
    try {
      read = H.readHtml(fs.readFileSync(path.join(FX, name)));
    } catch {
      continue; // refused at read (encoding, limits): no copy to map
    }
    const r = renderCopy(read, { fileDir: null });
    if (r.plain) continue;
    const doc = H.htmlParser().parse(r.bytes.toString("utf8"), { scriptingEnabled: true });
    const D = p5Dom();
    const ix = buildIndex(D, doc);
    assert.equal(ix.count, r.texts.length, `${name}: slots in the copy vs texts`);
    // every slot that comes from the source holds exactly that source node's text
    for (let n = 0; n < ix.count; n++) {
      const src = r.texts[n];
      if (src < 0) continue;
      assert.equal(slotText(D, ix.firsts[n]), read.nodes[src].value, `${name}: slot ${n} is source node ${src}`);
    }
    checked++;
  }
  assert.ok(checked >= 30, `fixtures checked: ${checked}`);
});

test("a selection inside one text node: nodeId is the source text node, start and end index its own text", () => {
  const v = view("<!doctype html><html><head><title>t</title></head><body><p>The quick brown fox</p></body></html>");
  const s = slotWith(v, "quick");
  const a = anchorFromRange({ startContainer: s.first, startOffset: 4, endContainer: s.first, endOffset: 9 }, v.ctx);
  assert.deepEqual(a.location, { nodeId: v.texts[s.n], start: 4, end: 9 });
  assert.equal(a.quote, "quick");
  assert.equal(v.read.nodes[a.location.nodeId].value.slice(a.location.start, a.location.end), a.quote);
  assert.equal(a.prefix, "The ");
  assert.equal(a.suffix, " brown fox");
  assert.equal(a.hitKind, undefined);
});

test("entities, astral characters and whitespace: offsets count the source node's decoded text, as textEdit splices it", () => {
  // entities: the frame holds the characters, so does the source node's value
  const e = fixture("edge-entities.html");
  const s = slotWith(e, "\u00a9");
  const at = s.text.indexOf("\u00a9");
  const a = anchorFromRange({ startContainer: s.first, startOffset: at, endContainer: s.first, endOffset: at + 1 }, e.ctx);
  assert.equal(a.quote, "\u00a9");
  assert.equal(e.read.nodes[a.location.nodeId].value.slice(a.location.start, a.location.end), "\u00a9");
  assert.ok(e.read.text.indexOf("&copy") >= 0 && a.location.start !== e.read.text.indexOf("&copy"), "an offset in the decoded text, not in the file's bytes");
  // astral: two UTF-16 code units each
  const x = fixture("edge-astral.html");
  const sx = slotWith(x, "\u{1F600}");
  const i = sx.text.indexOf("\u{1F600}");
  const b = anchorFromRange({ startContainer: sx.first, startOffset: i, endContainer: sx.first, endOffset: i + 2 }, x.ctx);
  assert.equal(b.quote, "\u{1F600}");
  assert.equal(b.location.end - b.location.start, 2);
  assert.equal(x.read.nodes[b.location.nodeId].value.slice(b.location.start, b.location.end), "\u{1F600}");
  // whitespace as written: a run of spaces and a newline count as they are (the browser shows them collapsed)
  const w = view("<!doctype html><html><head></head><body><p>one   two\n\t three</p></body></html>");
  const sw = slotWith(w, "three");
  const j = sw.text.indexOf("three");
  const c = anchorFromRange({ startContainer: sw.first, startOffset: j, endContainer: sw.first, endOffset: j + 5 }, w.ctx);
  assert.equal(c.location.start, "one   two\n\t ".length);
  assert.equal(w.read.nodes[c.location.nodeId].value.slice(c.location.start, c.location.end), "three");
});

test("a selection across inline elements anchors to their nearest located ancestor, offsets in its source text", () => {
  const v = view("<!doctype html><html><head></head><body><p id=x>Hello <b>bold</b> and <img src=gone.png alt=pic> world</p></body></html>");
  const s0 = slotWith(v, "Hello");
  const s1 = slotWith(v, "world");
  const a = anchorFromRange({ startContainer: s0.first, startOffset: 2, endContainer: s1.first, endOffset: 4 }, v.ctx);
  const p = locatedOf(v.D, v.D.parent(s0.first));
  assert.equal(v.D.tag(p), "p");
  assert.equal(a.location.nodeId, v.D.oskId(p));
  // the placeholder's label (text the copy added) is not in the anchor's text
  assert.equal(a.quote, "llo bold and  wor");
  assert.ok(!a.quote.includes("not shown"));
  assert.equal(a.prefix, "He");
  assert.equal(a.suffix, "ld");
  // the location maps back to the same text
  const r = rangeOfLocation(a.location, { ...v.ctx, slotOfSource: slotOfSource(v), elementById: elementById(v) });
  assert.equal(r.startNode, s0.first);
  assert.equal(r.startOffset, 2);
  assert.equal(r.endNode, s1.first);
  assert.equal(r.endOffset, 4);
});

test("a selection across blocks anchors to the element that holds both; boundaries on elements move to the nearest text", () => {
  const v = view("<!doctype html><html><head></head><body><div id=d><p>First para</p><p>Second para</p></div></body></html>");
  const s0 = slotWith(v, "First");
  const s1 = slotWith(v, "Second");
  const a = anchorFromRange({ startContainer: s0.first, startOffset: 6, endContainer: s1.first, endOffset: 6 }, v.ctx);
  const div = locatedOf(v.D, v.D.parent(v.D.parent(s0.first)));
  assert.equal(v.D.tag(div), "div");
  assert.equal(a.location.nodeId, v.D.oskId(div));
  assert.equal(a.quote, "paraSecond");
  // a range whose ends are elements (a triple click selects the paragraph node itself)
  const p0 = v.D.parent(s0.first);
  const b = anchorFromRange({ startContainer: p0, startOffset: 0, endContainer: p0, endOffset: 1 }, v.ctx);
  assert.equal(b.location.nodeId, v.texts[s0.n]);
  assert.deepEqual([b.location.start, b.location.end, b.quote], [0, 10, "First para"]);
  // nothing selected, or only text the copy added: no anchor
  assert.equal(anchorFromRange({ startContainer: s0.first, startOffset: 3, endContainer: s0.first, endOffset: 3 }, v.ctx), null);
});

test("WebKit splits a long text node: the run of Text siblings is one slot, offsets count across it", () => {
  const long = "a".repeat(70_000) + "TARGET" + "b".repeat(100);
  const v = view(`<!doctype html><html><head></head><body><p>${long}</p><p>after</p></body></html>`);
  const s = slotWith(v, "TARGET");
  const countBefore = v.ix.count;
  // split the node as WebKit does (65,536 code units, then the rest)
  const node = s.first;
  const par = node.parentNode;
  const piece = { nodeName: "#text", value: node.value.slice(65_536), parentNode: par };
  node.value = node.value.slice(0, 65_536);
  par.childNodes.splice(par.childNodes.indexOf(node) + 1, 0, piece);
  const ix = buildIndex(v.D, v.doc);
  assert.equal(ix.count, countBefore, "the same number of slots");
  const ctx = { ...v.ctx, ix };
  const a = anchorFromRange({ startContainer: piece, startOffset: 70_000 - 65_536, endContainer: piece, endOffset: 70_006 - 65_536 }, ctx);
  assert.deepEqual(a.location, { nodeId: v.texts[s.n], start: 70_000, end: 70_006 });
  assert.equal(a.quote, "TARGET");
  const r = rangeOfLocation(a.location, { ...ctx, slotOfSource: slotOfSource(v), elementById: elementById(v) });
  assert.equal(r.startNode, piece);
  assert.equal(r.startOffset, 70_000 - 65_536);
});

test("a click with no selection gives the element anchor of the nearest located element", () => {
  const v = view("<!doctype html><html><head></head><body><section><h2>Title <em>here</em></h2></section></body></html>");
  const s = slotWith(v, "here");
  const em = v.D.parent(s.first);
  const a = anchorFromElement(em, v.ctx);
  assert.equal(a.hitKind, "element");
  assert.equal(a.location.nodeId, v.D.oskId(em));
  assert.equal(a.quote, "here");
  assert.equal(v.read.nodes[a.location.nodeId].tagName, "em");
  const h2 = anchorFromElement(v.D.parent(em), v.ctx);
  assert.equal(h2.quote, "Title here");
});

test("which text may be typed in: the server's list, never a link's text, a control's label, a placeholder or head", () => {
  const v = view('<!doctype html><html><head><title>Head</title></head><body><p>Plain <a href="https://example.com/">link text</a></p><button>Press</button><p>   </p></body></html>');
  const all = editableSet(v.texts.filter((s) => s >= 0));
  const ctx = { ...v.ctx, editable: all };
  assert.equal(canType(slotWith(v, "Plain").first, ctx), true);
  assert.equal(canType(slotWith(v, "link text").first, ctx), false, "inside a link");
  assert.equal(canType(slotWith(v, "Press").first, ctx), false, "a control's label");
  assert.equal(canType(slotWith(v, "Head").first, ctx), false, "the title");
  assert.equal(canType(slotWith(v, "Plain").first, { ...ctx, editable: editableSet([]) }), false, "not in the server's list");
});

test("typedChange: a typed no-break space becomes a space in the changed part only; a line break in it is flagged", () => {
  assert.deepEqual(typedChange("Hello world", "Hello big world"), { text: "Hello big world", newline: false, inserted: 4 });
  assert.equal(typedChange("a\u00a0b", "a\u00a0b c\u00a0").text, "a\u00a0b c ", "the old no-break space stays");
  assert.equal(typedChange("Hello", "Hel\nlo").newline, true);
  assert.equal(typedChange("Hello", "HelL1\nL2lo").newline, true);
  assert.equal(typedChange("a\nb", "a\nbc").newline, false, "a line break that was there already");
  assert.equal(typedChange("Hello", "Helo").inserted, 0);
});

test("shapeOf and restoreShape: a new element or a removed one changes the key; the subtree goes back exactly", () => {
  const v = view("<!doctype html><html><head></head><body><p>Hello <b>bold</b> end</p></body></html>");
  const p = v.D.parent(slotWith(v, "Hello").first);
  const snap = shapeOf(v.D, p);
  assert.equal(snap.key, "T<b>TT");
  assert.deepEqual(snap.texts, ["Hello ", "bold", " end"]);
  // the browser replaced the first Text object with another holding new text: same shape
  const t0 = p.childNodes[0];
  p.childNodes[0] = { nodeName: "#text", value: "Hi ", parentNode: p };
  assert.equal(shapeOf(v.D, p).key, snap.key);
  // Enter in WebKit: a <br> appears
  p.childNodes.splice(1, 0, { nodeName: "br", tagName: "br", attrs: [], childNodes: [], parentNode: p });
  assert.notEqual(shapeOf(v.D, p).key, snap.key);
  // deleting across the bold element: it is gone
  const b = p.childNodes.find((c) => c.tagName === "b");
  p.childNodes = p.childNodes.filter((c) => c !== b);
  restoreShape(v.D, snap);
  assert.equal(shapeOf(v.D, p).key, snap.key);
  assert.equal(p.childNodes[0], t0);
  assert.equal(t0.value, "Hello ");
  assert.equal(p.childNodes[1], b);
});

test("pending edits: add, update, typing back removes, undo one and all, has", () => {
  const E = createEdits();
  const seen = [];
  E.subscribe((l) => seen.push(l.length));
  assert.equal(E.has(), false);
  E.set({ nodeId: 7, versionSha: "v1", baseText: "Hello", newText: "Hello!" });
  E.set({ nodeId: 9, versionSha: "v1", baseText: "World", newText: "Earth" });
  E.set({ nodeId: 7, versionSha: "v1", baseText: "Hello!", newText: "Hello!!" }); // later typing: the base stays the version's text
  assert.deepEqual(E.list().map((e) => [e.nodeId, e.newText, e.baseTextHash]), [[7, "Hello!!", editHash("Hello")], [9, "Earth", editHash("World")]]);
  assert.equal(E.has(), true);
  E.set({ nodeId: 9, versionSha: "v1", baseText: "x", newText: "World" }); // typed back to the version's text
  assert.deepEqual(E.list().map((e) => e.nodeId), [7]);
  E.set({ nodeId: 3, versionSha: "v1", baseText: "a", newText: "b" });
  assert.equal(E.undo().nodeId, 3, "the last one edited");
  assert.equal(E.undo(7).nodeId, 7);
  assert.equal(E.undo(7), null);
  E.set({ nodeId: 1, versionSha: "v1", baseText: "a", newText: "b" });
  E.set({ nodeId: 2, versionSha: "v1", baseText: "c", newText: "d" });
  assert.equal(E.undoAll().length, 2);
  assert.equal(E.has(), false);
  assert.ok(seen.length >= 8, "every change is told");
});

/** One version as the page gets it: the server's editable ids and identities (src/html.js), and the text of each node. */
const doc = (src) => `<!doctype html><html><head><title>t</title></head><body>${src}</body></html>`;
function version(src) {
  const bytes = Buffer.from(doc(src));
  const read = H.readHtml(bytes);
  const editable = H.editableTextIds(read);
  const ids = identities(editable, H.editIdentities(read, editable));
  const set = new Set(editable);
  // the n-th text node holding exactly `text` (in source order)
  const node = (text, n = 0) => read.nodes.filter((x) => x.nodeName === "#text" && x.value === text)[n].__id;
  return { bytes, read, ids, node, textOf: (id) => (set.has(id) ? read.nodes[id].value : null) };
}
/** An edit typed on version `v`: the text node holding `text` (its n-th) gets `newText`. */
const typed = (E, v, text, newText, n = 0) => E.set({ nodeId: v.node(text, n), versionSha: "v1", baseText: text, newText, ident: v.ids.of(v.node(text, n)) });
const movedTo = (E, v2) => E.replace("v2", { ids: v2.ids, textOf: v2.textOf });

test("pending edits after a version change: the review's case, an inserted twin paragraph never takes the edit (029e51b, html-view.js:615)", () => {
  // <p id=original>Hello</p><p>Tail</p>, " Alice" typed into the first; an outside save inserts <p id=inserted>Hello</p> before it
  const v1 = version('<p id="original">Hello</p><p>Tail</p>');
  const v2 = version('<p id="inserted">Hello</p><p id="original">Hello</p><p>Tail</p>');
  const E = createEdits();
  typed(E, v1, "Hello", "Hello Alice");
  assert.equal(v1.node("Hello"), v2.node("Hello", 0), "the old numeric id is the INSERTED paragraph's text in the new version");
  const r = movedTo(E, v2);
  assert.deepEqual(r.placed.map((e) => e.nodeId), [v2.node("Hello", 1)], "placed on #original, by its unique id");
  assert.equal(v2.read.nodes[r.placed[0].nodeId].__par.attrs.find((a) => a.name === "id").value, "original");
  assert.deepEqual(r.placed[0].ident, v2.ids.of(v2.node("Hello", 1)), "the edit takes its new place's identity");
  // the same without ids: two "Hello" now, nothing tells which one is the person's: not placed, kept and told
  const w1 = version("<p>Hello</p><p>Tail</p>");
  const w2 = version("<p>Hello</p><p>Hello</p><p>Tail</p>");
  const F = createEdits();
  typed(F, w1, "Hello", "Hello Alice");
  const s = movedTo(F, w2);
  assert.deepEqual([s.placed.length, s.lost.map((e) => e.newText)], [0, ["Hello Alice"]]);
  assert.deepEqual(F.list(), [], "nothing left to send at a guessed place");
  assert.equal(F.lost().length, 1, "kept until cleared");
});

test("pending edits after a version change: twins before and after, moved, deleted, changed outside, an unrelated change", () => {
  // twins around the edited one, an unrelated outside change: content cannot tell which "Hello" the person typed in (a twin moved next
  // to it reads the same), so it is listed, not placed (outside review of 4d2b2fc; before, the middle one was placed by its neighbors)
  const t1 = version("<h1>Title</h1><p>Hello</p><p>Hello</p><p>Hello</p>");
  const t2 = version("<h1>New title</h1><p>Added far away.</p><div><p>x</p></div><p>Hello</p><p>Hello</p><p>Hello</p>");
  let E = createEdits();
  typed(E, t1, "Hello", "Hello!", 1);
  assert.deepEqual(movedTo(E, t2).lost.map((e) => e.why), ["several"]);
  // a twin inserted before or after the run: the count of "Hello" changed, so the neighbors alone do not decide
  for (const after of ["<p>Hello</p><h1>Title</h1><p>Hello</p><p>Hello</p><p>Hello</p>", "<h1>Title</h1><p>Hello</p><p>Hello</p><p>Hello</p><p>Hello</p>"]) {
    E = createEdits();
    typed(E, t1, "Hello", "Hello!", 0);
    const r = movedTo(E, version(after));
    assert.deepEqual([r.placed.length, r.lost.length], [0, 1], after);
  }
  // moved: without an id its neighbors changed (not placed); with a unique id it is found where it went
  const m1 = version("<p>A</p><p>Hello</p><p>B</p><p>C</p>");
  E = createEdits();
  typed(E, m1, "Hello", "Hello!");
  assert.deepEqual(movedTo(E, version("<p>A</p><p>B</p><p>C</p><p>Hello</p>")).lost.map((e) => e.why), ["gone"]);
  const i1 = version('<p>A</p><p id="h">Hello</p><p>B</p><p>C</p>');
  const i2 = version('<p>A</p><p>B</p><p>C</p><p id="h">Hello</p>');
  E = createEdits();
  typed(E, i1, "Hello", "Hello!");
  assert.deepEqual(movedTo(E, i2).placed.map((e) => e.nodeId), [i2.node("Hello")]);
  // deleted
  E = createEdits();
  typed(E, m1, "Hello", "Hello!");
  assert.deepEqual(movedTo(E, version("<p>A</p><p>B</p><p>C</p>")).lost.map((e) => e.why), ["gone"]);
  // its text also changed outside: by id the node decides ("changed"); without one nothing has its text any more
  E = createEdits();
  typed(E, i1, "Hello", "Hello!");
  assert.deepEqual(movedTo(E, version('<p>A</p><p id="h">Howdy</p><p>B</p><p>C</p>')).lost.map((e) => e.why), ["changed"]);
  E = createEdits();
  typed(E, m1, "Hello", "Hello!");
  assert.deepEqual(movedTo(E, version("<p>A</p><p>Howdy</p><p>B</p><p>C</p>")).lost.map((e) => e.why), ["gone"]);
  // the outside save already holds the person's text: still listed, never dropped as "already applied" (a node that reads like the
  // edit's new text may be another node that always read so)
  E = createEdits();
  typed(E, i1, "Hello", "Hello!");
  let gone = movedTo(E, version('<p>A</p><p id="h">Hello!</p><p>B</p><p>C</p>'));
  assert.deepEqual([gone.applied.length, gone.lost.length, E.lost().length, E.list().length], [0, 1, 1, 0]);
  E = createEdits();
  typed(E, m1, "Hello", "Hello!");
  gone = movedTo(E, version("<p>A</p><p>Hello!</p><p>B</p><p>C</p>"));
  assert.deepEqual([gone.applied.length, gone.lost.length, E.lost().length], [0, 1, 1]);
  // an id that is no longer unique decides nothing; its neighbors still can
  E = createEdits();
  typed(E, i1, "Hello", "Hello!");
  const d2 = version('<p>A</p><p id="h">Hello</p><p>B</p><p id="h">C</p>');
  assert.deepEqual(movedTo(E, d2).placed.map((e) => e.nodeId), [d2.node("Hello")]);
  // an edit with no identity (a server that sent none) is never placed by its numeric id
  E = createEdits();
  E.set({ nodeId: m1.node("Hello"), versionSha: "v1", baseText: "Hello", newText: "Hello!" });
  assert.deepEqual(movedTo(E, m1).lost.map((e) => e.why), ["gone"]);
  // several edits: each on its own; the lost ones are kept until dismissed, the placed ones stay pending
  E = createEdits();
  typed(E, i1, "Hello", "Hello!");
  typed(E, i1, "C", "C!");
  const r = movedTo(E, version('<p>A</p><p id="h">Hello</p><p>B</p>'));
  assert.deepEqual([r.placed.length, r.lost.length, E.list().length, E.lost().length], [1, 1, 1, 1]);
  E.clear(); // a Send took the pending one: the lost one stays listed, its text is nowhere else
  assert.deepEqual([E.list().length, E.lost().length], [0, 1]);
  E.dismissLost();
  assert.deepEqual([E.list().length, E.lost().length], [0, 0]);
});

test("the server's identities: six int32 per editable node, keys never 0 0 unless absent, twins counted", () => {
  const v = version('<p id="a">One</p><p>Two</p><p>Two</p><p id="b">Three</p><p id="b">Four</p>');
  const one = v.ids.of(v.node("One"));
  assert.ok(one.nk && one.ik, "neighbors and a unique id");
  assert.equal(one.tw, 1);
  assert.equal(v.ids.of(v.node("Two")).tw, 2);
  assert.equal(v.ids.of(v.node("Two")).ik, null, "no id");
  assert.deepEqual([one.pw, v.ids.of(v.node("Two")).pw], [1, 0], "twins under the id'd parent: one; none without one");
  assert.equal(v.ids.of(v.node("Three")).ik, null, "an id two elements share is no identity");
  assert.notEqual(v.ids.of(v.node("Two", 0)).nk, v.ids.of(v.node("Two", 1)).nk, "twins with other neighbors have other keys");
  assert.equal(identities([1, 2], new Int32Array(3)).of(1), null, "identities that do not fit the list are not used");
});

test("editHash: fixed vectors (the server computes the same), exact text", () => {
  assert.match(editHash("Hello"), /^[0-9a-f]{14}$/);
  assert.notEqual(editHash("a b"), editHash("a  b"), "whitespace counts");
  assert.notEqual(editHash("\u{1F600}"), editHash("\u{1F601}"));
  // pinned: a server-side copy of editHash must give these
  assert.deepEqual(["", "Hello", "The quick brown fox", "\u00a9 \u{1F600}"].map(editHash), ["0bdcb81aee8d83", "114acbf653c732", "0bd8f589630d2a", "09a7745b70469e"]);
  // one function, the server's own (src/edit-hash.js): the page re-exports it, the write check imports it
  assert.equal(editHash, serverEditHash);
  assert.deepEqual(["", "Hello", "The quick brown fox", "\u00a9 \u{1F600}"].map(serverEditHash), ["0bdcb81aee8d83", "114acbf653c732", "0bd8f589630d2a", "09a7745b70469e"]);
});

test("the crash flag: set before the content, cleared after load, kept per version, survives a new page (localStorage)", () => {
  const mem = new Map();
  const storage = { get: (area, k) => (area === "localStorage" ? (mem.get(k) ?? null) : null), set: (area, k, v) => area === "localStorage" && mem.set(k, String(v)) };
  const F = crashFlag(storage);
  assert.equal(F.isSet("sha-a"), false);
  F.set("sha-a");
  assert.equal(crashFlag(storage).isSet("sha-a"), true, "a new page reads it");
  assert.equal(F.isSet("sha-b"), false, "another version is not flagged");
  F.clear("sha-a");
  assert.equal(F.isSet("sha-a"), false);
  for (let i = 0; i < 30; i++) F.set(`v${i}`);
  assert.equal(Object.keys(JSON.parse(mem.get("onionskin.html.crash"))).length, 20, "at most 20 kept");
  mem.set("onionskin.html.crash", "not json");
  assert.equal(F.isSet("x"), false, "a damaged value reads as no flag");
  const broken = crashFlag({ get: () => { throw new Error("blocked"); }, set: () => {} });
  assert.equal(broken.isSet("x"), false, "storage that throws reads as no flag");
});

test("notices come from the copy's stats with the plan's fixed sentences", () => {
  const n = noticesFor({ stats: { scripts: 2, remote: 3, styles: { heavy: "css_has" }, folder: "home_or_root" }, plain: null, locked: true, firstRun: true, hiddenCount: 1 });
  assert.deepEqual(n.map((x) => x.id), ["first-run", "running", "scripts", "remote", "heavy", "folder", "hidden"]);
  assert.equal(n[0].text, "This is a still view of your page: scripts are off and nothing loads from the internet.");
  assert.equal(n[1].text, "The agent is working; comment now and fix text when it is done.");
  assert.equal(n[3].text, "3 things from the internet were not loaded.");
  assert.equal(n[4].text, "This page's styles are too heavy to show; the text is shown plain.");
  assert.equal(SAY.remote(1), "1 thing from the internet was not loaded.");
  assert.deepEqual(noticesFor({ stats: { scripts: 0, remote: 0, styles: { heavy: null }, folder: null }, firstRun: false }), []);
  assert.equal(plainSentence("crash"), "This page made Onionskin's view stop responding last time, so it is shown as plain text.");
  assert.equal(SAY.scriptsOnly, "This page is built by scripts, which Onionskin never runs, so there is nothing to show.");
  assert.ok(!/\u2014/.test(JSON.stringify(SAY)), "no em dashes");
});

test("hidden elements follow a version change by tag and text hash, else they are shown again", () => {
  const hidden = [{ nodeId: 4, tag: "div", hash: "h1" }, { nodeId: 8, tag: "aside", hash: "h2" }, { nodeId: 9, tag: "div", hash: "h3" }];
  const now = new Map([[4, { tag: "div", hash: "h1" }], [30, { tag: "aside", hash: "h2" }], [40, { tag: "div", hash: "h3" }], [41, { tag: "div", hash: "h3" }]]);
  const out = replaceHidden(hidden, { at: (id) => now.get(id) || null, find: (tag, hash) => [...now].filter(([, v]) => v.tag === tag && v.hash === hash).map(([id]) => id) });
  assert.deepEqual(out.map((h) => h.nodeId), [4, 30]);
});

test("one interaction path, by construction: no listener and no handler property is ever put on a frame node (R14)", () => {
  const read = (f) => fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "web", "src", f), "utf8");
  const code = (s) => s.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, ""); // comments name what is not done
  for (const f of ["html-view.js", "html-frame.js"]) {
    const s = code(read(f));
    assert.doesNotMatch(s, /addEventListener|attachEvent/, `${f} adds no listener anywhere`);
    assert.doesNotMatch(s, /\.on[a-z]+\s*=[^=]/, `${f} sets no on* handler property`);
    assert.doesNotMatch(s, /setAttr\([^)]*["']on[a-z]/i, `${f} sets no on* attribute`);
  }
  // the component: two listeners, both the non-passive wheel on the page's own elements (the layer, catchRef, and the box under the frame,
  // boxRef, which takes the wheel while the frame is inert), nothing else
  const v = code(read("HtmlViewer.jsx"));
  const adds = v.match(/addEventListener\(/g) || [];
  assert.equal(adds.length, 2);
  assert.match(v, /const el = catchRef\.current;[\s\S]{0,300}el\.addEventListener\("wheel"/);
  assert.match(v, /const el = boxRef\.current;[\s\S]{0,300}el\.addEventListener\("wheel"/);
});

// ---- the placement rule after the outside review of 4d2b2fc (html-view.js:725) ---------------------------------------------------------
/** What Send writes for the placed edits (the server's own check, src/html-write.js), or the refusal. */
const sendPlaced = (v2, placed) => checkedHtmlWrite(v2.bytes, null, { edits: placed.map((e) => ({ nodeId: e.nodeId, text: e.newText, baseTextHash: e.baseTextHash })) });

test("pending edits after a version change: a twin inserted in the same parent as the edited text never takes the edit (4d2b2fc, html-view.js:725)", () => {
  // the review's case: "Hello Alice" typed into the first text of <p id=original>; an outside save prepends "Hello<br>" inside that paragraph
  const cases = [
    ['<p id="original">Hello<br>Tail</p>', '<p id="original">Hello<br>Hello<br>Tail</p>'],
    // ... and with an inserted inline-formatted segment
    ['<p id="original">Hello<br>Tail</p>', '<p id="original"><b>Hello</b><br>Hello<br>Tail</p>'],
    ['<p id="original">Hello<br>Tail</p>', '<p id="original">Hello<br><i>Hello</i><br>Tail</p>'],
  ];
  for (const [a, b] of cases) {
    const v1 = version(a);
    const v2 = version(b);
    const E = createEdits();
    typed(E, v1, "Hello", "Hello Alice");
    const r = movedTo(E, v2);
    assert.deepEqual([r.placed.length, r.lost.map((e) => [e.newText, e.why])], [0, [["Hello Alice", "several"]]], b);
    assert.deepEqual(E.list(), [], `${b}: nothing left to send at a guessed place`);
    assert.equal(E.lost()[0].newText, "Hello Alice", "kept, with its text, for Copy");
  }
  // without the twin the paragraph's own text is found again by its id, and Send writes it there
  const v1 = version('<p id="original">Hello<br>Tail</p>');
  const v2 = version('<h2>New</h2><p id="original">Tail first<br>Hello<br>Tail</p>');
  const E = createEdits();
  typed(E, v1, "Hello", "Hello Alice");
  const r = movedTo(E, v2);
  assert.deepEqual(r.placed.map((e) => e.nodeId), [v2.node("Hello")]);
  const w = sendPlaced(v2, r.placed);
  assert.equal(w.ok, true, w.reason);
  assert.equal(Buffer.from(w.bytes).toString(), doc('<h2>New</h2><p id="original">Tail first<br>Hello Alice<br>Tail</p>'));
});

test("pending edits after a version change: twins before, after and elsewhere, a move, a change outside, an unrelated change", () => {
  const one = (a, b, text = "Hello", n = 0) => {
    const v1 = version(a);
    const v2 = version(b);
    const E = createEdits();
    typed(E, v1, text, `${text}!`, n);
    return { r: movedTo(E, v2), v2 };
  };
  const listed = (x, why, label) => assert.deepEqual([x.r.placed.length, x.r.lost.map((e) => e.why)], [0, [why]], label);
  const placedOn = (x, nodeId, expect, label) => {
    assert.deepEqual(x.r.placed.map((e) => e.nodeId), [nodeId], label);
    const w = sendPlaced(x.v2, x.r.placed);
    assert.equal(w.ok, true, `${label}: ${w.reason}`);
    assert.equal(Buffer.from(w.bytes).toString(), doc(expect), label);
  };
  // twins inserted before, after, and in another parent: never placed by neighbors alone (with an id, the parent's own text still is)
  listed(one("<p>A</p><p>Hello</p><p>B</p>", "<p>Hello</p><p>A</p><p>Hello</p><p>B</p>"), "several", "a twin before");
  listed(one("<p>A</p><p>Hello</p><p>B</p>", "<p>A</p><p>Hello</p><p>B</p><p>Hello</p>"), "several", "a twin after");
  listed(one("<p>A</p><p>Hello</p><p>B</p>", "<div><p>A</p><p>Hello</p><p>B</p></div><p>A</p><p>Hello</p><p>B</p>"), "several", "a twin with the same neighbors in another parent");
  let x = one('<p>A</p><p id="h">Hello</p><p>B</p>', '<p>A</p><p id="h">Hello</p><p>B</p><div><p>Hello</p></div>');
  placedOn(x, x.v2.node("Hello", 0), '<p>A</p><p id="h">Hello!</p><p>B</p><div><p>Hello</p></div>', "a twin in another parent: the id'd parent holds one Hello");
  // the same text node moved within its parent: by its parent's unique id it is found; without one its neighbors changed
  x = one('<p id="h">Hello<br>Tail<br>More</p>', '<p id="h">Tail<br>More<br>Hello</p>');
  placedOn(x, x.v2.node("Hello"), '<p id="h">Tail<br>More<br>Hello!</p>', "moved within its id'd parent");
  listed(one("<p>Hello<br>Tail<br>More</p>", "<p>Tail<br>More<br>Hello</p>"), "gone", "moved within a parent with no id");
  // its text changed outside: listed
  listed(one('<p>A</p><p id="h">Hello</p><p>B</p>', '<p>A</p><p id="h">Howdy</p><p>B</p>'), "changed", "changed outside, by id");
  listed(one("<p>A</p><p>Hello</p><p>B</p>", "<p>A</p><p>Howdy</p><p>B</p>"), "gone", "changed outside, no id");
  // an unrelated outside change elsewhere: placed, and Send writes it on that node
  x = one("<h1>Title</h1><p>A</p><p>Hello</p><p>B</p><p>End</p>", "<h1>New title</h1><p>Added far away.</p><p>A</p><p>Hello</p><p>B</p><p>Changed end</p>");
  placedOn(x, x.v2.node("Hello"), "<h1>New title</h1><p>Added far away.</p><p>A</p><p>Hello!</p><p>B</p><p>Changed end</p>", "an unrelated change elsewhere");
  // twins that were there before: an id-less one of several is never placed after a version change, even an unrelated one (which of them
  // the person typed in cannot be told from content: a twin moved next to it reads the same), it is listed with its text
  listed(one("<h1>Title</h1><p>Hello</p><p>Hello</p><p>Hello</p>", "<h1>New title</h1><p>Hello</p><p>Hello</p><p>Hello</p>", "Hello", 1), "several", "one of three twins");
  // an id match never overrides a context mismatch: the id'd parent holding a second Hello deep inside is ambiguous too
  listed(one('<p id="d">Hello<br>x</p>', '<p id="d">Hello<br>x<span><b>Hello</b></span></p>'), "several", "a twin deeper under the parent");
});

/** A seeded generator of numbers in [0, 1). */
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A page of many short identical texts (list items "Yes" and "No", some with a unique id, some with a unique text), one item edited, then
// an outside save that inserts and deletes OTHER items (the edited item is kept in every case: which node is the person's is then known by
// construction) and sometimes changes the heading. Placed means placed on that item, and Send writes exactly that; anything else is
// listed. A case whose bytes come out the same as before is no version change (the page keeps its edits on the same nodes), not counted.
function listCase(seed) {
  const r = seeded(seed);
  let uid = 0;
  let uniq = 0;
  const item = () => {
    const x = r();
    return { uid: ++uid, text: x < 0.12 ? `Item ${++uniq}` : x < 0.56 ? "Yes" : "No", id: r() < 0.15 ? `q${uid}` : null };
  };
  const items = Array.from({ length: 3 + Math.floor(r() * 10) }, item);
  const edited = items[Math.floor(r() * items.length)];
  const html = (list, title) => `<h1>${title}</h1><ul>${list.map((i) => `<li${i.id ? ` id="${i.id}"` : ""}>${i.text}</li>`).join("")}</ul><p>End</p>`;
  const before = html(items, "Title");
  let after = items.slice();
  for (let k = 1 + Math.floor(r() * 4); k > 0; k--) {
    if (r() < 0.5 || after.length < 2) after.splice(Math.floor(r() * (after.length + 1)), 0, item());
    else {
      const at = Math.floor(r() * after.length);
      if (after[at] !== edited) after.splice(at, 1);
    }
  }
  const title = r() < 0.3 ? "Other title" : "Title";
  return { before, after: html(after, title), beforeIndex: items.indexOf(edited), afterItems: after, edited, title };
}
/** The text node of the li at position `k` of a version. */
const liText = (v, k) => v.read.nodes.filter((n) => n.tagName === "li")[k].childNodes[0].__id;

test("property: an edit to one of many identical short texts, after random outside insertions and deletions, is placed on that one or listed, never on another", () => {
  const N = Number(process.env.ONIONSKIN_PLACE_N || 3000);
  let placed = 0;
  let listedN = 0;
  let same = 0;
  let looseWrong = 0; // positive control: a placer without the counts (base text and neighbors only) on the same cases
  for (let seed = 1; seed <= N; seed++) {
    const c = listCase(seed);
    if (c.before === c.after) {
      same++;
      continue;
    }
    const v1 = version(c.before);
    const v2 = version(c.after);
    // the edited item's text node in each version, by construction
    const x1 = liText(v1, c.beforeIndex);
    const x2 = liText(v2, c.afterItems.indexOf(c.edited));
    const E = createEdits();
    E.set({ nodeId: x1, versionSha: "v1", baseText: c.edited.text, newText: `${c.edited.text} (edited)`, ident: v1.ids.of(x1) });
    const r = movedTo(E, v2);
    if (r.placed.length) {
      placed++;
      assert.equal(r.placed[0].nodeId, x2, `seed ${seed}: placed on another node\n${c.before}\n${c.after}`);
      const w = sendPlaced(v2, r.placed);
      assert.equal(w.ok, true, `seed ${seed}: ${w.reason}`);
      const want = c.after.split("<li");
      const at = c.afterItems.indexOf(c.edited) + 1;
      want[at] = want[at].replace(`>${c.edited.text}</li>`, `>${c.edited.text} (edited)</li>`);
      assert.equal(Buffer.from(w.bytes).toString(), doc(want.join("<li")), `seed ${seed}: Send wrote another place`);
    } else {
      listedN++;
      assert.equal(E.lost().length, 1, `seed ${seed}: kept and listed`);
    }
    const id = v1.ids.of(x1);
    const loose = v2.ids.byNk(id.nk).filter((n) => v2.textOf(n) !== null && editHash(v2.textOf(n)) === editHash(c.edited.text));
    if (loose.length === 1 && loose[0] !== x2) looseWrong++;
  }
  console.log(`# ${N} cases: ${placed} placed (all on the edited item), ${listedN} listed, ${same} unchanged bytes; a placer without the counts would misplace ${looseWrong}`);
  assert.ok(placed >= N * 0.1, `placements happen (${placed}): the property is not vacuous`);
  assert.ok(looseWrong > 0, "positive control: the generator finds misplacements of a looser rule");
});

test("pending edits after a version change: a sibling that already reads like the fix does not make the edit count as applied (9304853, html-view.js:731)", () => {
  // <p id=p>teh<br>teh<br>the</p>, the first "teh" corrected; an outside save changes only the heading
  const v1 = version('<h1>Title</h1><p id="p">teh<br>teh<br>the</p>');
  const E = createEdits();
  typed(E, v1, "teh", "the", 0);
  const r = movedTo(E, version('<h1>New title</h1><p id="p">teh<br>teh<br>the</p>'));
  assert.deepEqual([r.placed.length, r.applied.length, r.lost.map((e) => e.why)], [0, 0, ["several"]]);
  assert.equal(E.lost().length, 1, "the fix is listed with its text, not dropped");
  assert.equal(E.lost()[0].newText, "the");
  // the second case of the review: the new text already sits in a sibling, and a twin of the base is inserted
  const w1 = version('<p id="original">Hello<br>Hello Alice<br>Tail</p>');
  const F = createEdits();
  typed(F, w1, "Hello", "Hello Alice", 0);
  const q = movedTo(F, version('<p id="original">Hello<br>Hello<br>Hello Alice<br>Tail</p>'));
  assert.deepEqual([q.placed.length, q.applied.length, q.lost.length, F.lost().length], [0, 0, 1, 1]);
});
