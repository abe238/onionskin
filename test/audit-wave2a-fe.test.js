import assert from "node:assert/strict";
import { test } from "node:test";

function makeFakeEnv() {
  const def = (getters = [], methods = []) => {
    function Ctor() {}
    for (const g of getters) {
      Object.defineProperty(Ctor.prototype, g, {
        get() { return this[`_${g}`]; },
        set(v) { this[`_${g}`] = v; },
        configurable: true,
      });
    }
    for (const m of methods) {
      Ctor.prototype[m] = function (...a) { return this[`_${m}`]?.(...a); };
    }
    return Ctor;
  };

  const fakeDocEl = { _nodeType: 1, _localName: "html", _style: { _setProperty() {} }, _firstChild: null, _nextSibling: null, _parentNode: null };
  const fakeBody = { _nodeType: 1, _localName: "body", _style: { _setProperty() {} }, _scrollTop: 0, _scrollLeft: 0, _scrollHeight: 100, _firstChild: null, _nextSibling: null, _parentNode: fakeDocEl };
  fakeDocEl._firstChild = fakeBody;
  const emptyList = { _length: 0, _item: () => null };
  const fakeFrameDoc = {
    _URL: "about:srcdoc",
    _documentElement: fakeDocEl,
    _body: fakeBody,
    _scrollingElement: fakeBody,
    _firstChild: fakeDocEl,
    _querySelectorAll: () => emptyList,
    _getSelection: () => null,
    _createTreeWalker: () => ({ nextNode: () => null }),
  };

  const win = {
    Node: def(["parentNode", "firstChild", "lastChild", "nextSibling", "previousSibling", "nodeType"], ["removeChild", "contains"]),
    Element: def(["localName", "scrollTop", "scrollLeft", "scrollHeight", "clientHeight", "clientWidth"], ["getAttribute", "setAttribute", "removeAttribute", "hasAttribute", "replaceChildren", "getBoundingClientRect", "getClientRects"]),
    HTMLElement: def(["isContentEditable", "style"], ["focus"]),
    Document: def(["documentElement", "body", "scrollingElement", "URL"], ["createTextNode", "querySelectorAll", "getSelection", "createRange", "elementFromPoint"]),
    Selection: def(["rangeCount"], ["getRangeAt", "collapse", "removeAllRanges", "addRange", "setBaseAndExtent"]),
    Range: def(["startContainer", "startOffset", "endContainer", "endOffset"], ["setStart", "setEnd", "getClientRects"]),
    CSSStyleDeclaration: def([], ["setProperty", "removeProperty"]),
    NodeList: def(["length"], ["item"]),
    CharacterData: def(["data"], []),
    HTMLIFrameElement: def(["contentDocument"], []),
    DOMRectReadOnly: def(["left", "top", "width", "height"], []),
    DOMRectList: def(["length"], ["item"]),
  };

  const fakeFrame = {
    _contentDocument: fakeFrameDoc,
    inert: false,
    srcdoc: "",
    clientWidth: 800,
    clientHeight: 600,
    clientLeft: 0,
    clientTop: 0,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
  };

  return { win, fakeFrame };
}

test("FE-04 & R5: html-frame.js clears loaded() timers on destroy() and keeps polling while document.hidden", async () => {
  const prevWin = globalThis.window;
  const prevDoc = globalThis.document;
  const prevRaf = globalThis.requestAnimationFrame;
  const prevCancelRaf = globalThis.cancelAnimationFrame;

  const { win, fakeFrame } = makeFakeEnv();
  const uiCalls = [];
  const hostCalls = [];
  let hidden = false;
  let rafId = 0;
  const rafQueue = new Map();

  globalThis.window = win;
  globalThis.document = {
    get hidden() { return hidden; },
    activeElement: null,
  };
  globalThis.requestAnimationFrame = (fn) => {
    const id = ++rafId;
    rafQueue.set(id, fn);
    return id;
  };
  globalThis.cancelAnimationFrame = (id) => rafQueue.delete(id);

  try {
    const { createFrameView } = await import("../web/src/html-frame.js");
    const cleared = [];
    const flag = {
      isSet: () => false,
      set: () => {},
      clear: (v) => cleared.push(v),
    };
    const view = createFrameView({ ui: (p) => uiCalls.push(p), flag });

    view.attach(fakeFrame, {});
    view.load({ copy: "<p>hello</p>", texts: [], editable: [], ident: [], plain: null, version: "v1", onHost: (h) => hostCalls.push(h), onPlain: () => {} });
    view.loaded();
    // Destroy immediately before setTimeout(..., 0) / setTimeout(..., 1000) fire
    view.destroy();
    await new Promise((r) => setTimeout(r, 30));

    assert.equal(uiCalls.some((u) => u.phase === "ready"), false, "afterLoad must not run after destroy()");
    assert.deepEqual(hostCalls, [null], "onHost only received null from destroy(), never a post-destroy handle");

    // R5: tick() and frameLoop() must continue running even when document.hidden is true
    // so text edits typed just before switching tabs are counted and crash flag never sticks.
    hidden = true;
    const uiCalls2 = [];
    const view2 = createFrameView({ ui: (p) => uiCalls2.push(p), flag });
    view2.attach(fakeFrame, {});
    view2.load({ copy: "<p>hello</p>", texts: [], editable: [], ident: [], plain: null, version: "v2", onHost: () => {}, onPlain: () => {} });
    view2.loaded();
    await new Promise((r) => setTimeout(r, 80));
    const readyIdx = uiCalls2.findIndex((u) => u.phase === "ready");
    assert.ok(readyIdx >= 0, "view2 became ready");
    // Flush queued rAF callbacks while document.hidden is true
    for (const [, fn] of [...rafQueue]) fn();
    assert.ok(view2.handle.stats().ticks > 0, "tick() continues running while document.hidden is true");
    assert.equal(uiCalls2.slice(readyIdx + 1).some((u) => "paint" in u), true, "frameLoop() continues painting while document.hidden is true");
    view2.destroy();
  } finally {
    globalThis.window = prevWin;
    globalThis.document = prevDoc;
    globalThis.requestAnimationFrame = prevRaf;
    globalThis.cancelAnimationFrame = prevCancelRaf;
  }
});
