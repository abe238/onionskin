/* Onionskin site script: theme toggle, copy buttons, name-fact dialog, floating-bar state, pointer light, WebMCP tools,
   and (second block, Chromium only) the glass lens. No dependencies, no network requests.
   Every feature is optional: the page works without it. */
(function () {
  "use strict";
  var root = document.documentElement;

  function readData() {
    var el = document.getElementById("site-data");
    if (!el) return null;
    try { return JSON.parse(el.textContent); } catch (e) { return null; }
  }
  var data = readData();

  /* ---------- theme toggle ---------- */
  function effectiveTheme() {
    var t = root.getAttribute("data-theme");
    if (t === "light" || t === "dark") return t;
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  function syncThemeMeta() {
    var dark = effectiveTheme() === "dark";
    var btn = document.getElementById("theme-toggle");
    if (btn) btn.setAttribute("aria-label", dark ? "Switch to light theme" : "Switch to dark theme");
  }
  var toggle = document.getElementById("theme-toggle");
  if (toggle) {
    toggle.hidden = false;
    toggle.addEventListener("click", function () {
      var next = effectiveTheme() === "dark" ? "light" : "dark";
      root.setAttribute("data-theme", next);
      try { localStorage.setItem("theme", next); } catch (e) { /* storage blocked: theme still applies for this view */ }
      syncThemeMeta();
    });
    syncThemeMeta();
  }

  /* ---------- copy buttons ---------- */
  var live = document.getElementById("live");
  Array.prototype.forEach.call(document.querySelectorAll("[data-copy]"), function (btn) {
    btn.addEventListener("click", function () {
      var text = btn.getAttribute("data-copy");
      var done = function () {
        btn.textContent = "Copied";
        if (live) live.textContent = "Copied " + text;
        setTimeout(function () { btn.textContent = "Copy"; }, 1600);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, function () { btn.textContent = "Select and copy"; });
      } else {
        btn.textContent = "Select and copy";
      }
    });
  });

  /* ---------- name fact dialog (falls back to the #onionskin-paper section without JS) ---------- */
  var dialog = document.getElementById("fact-dialog");
  var opener = null;
  if (dialog && typeof dialog.showModal === "function") {
    Array.prototype.forEach.call(document.querySelectorAll("[data-fact]"), function (a) {
      a.addEventListener("click", function (ev) {
        ev.preventDefault();
        opener = a;
        dialog.showModal();
      });
    });
    dialog.addEventListener("click", function (ev) {
      if (ev.target !== dialog) return; /* clicks inside the card land on its children */
      var r = dialog.getBoundingClientRect();
      var inside = ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom;
      if (!inside) dialog.close();
    });
    var closeBtn = dialog.querySelector("[data-close]");
    if (closeBtn) closeBtn.addEventListener("click", function () { dialog.close(); });
    dialog.addEventListener("close", function () { if (opener) opener.focus(); });
  }

  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  /* scroll state: floating bars condense once content passes under them */
  var ticking = false;
  /* adaptive glass: a floating bar reads the tone of the content under it
     (nearest [data-tone]) and flips its tint, as Liquid Glass bars do */
  var bars = document.querySelectorAll("[data-adapt]");
  function adapt() {
    Array.prototype.forEach.call(bars, function (bar) {
      var r = bar.getBoundingClientRect();
      var stack = document.elementsFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      var tone = "";
      for (var i = 0; i < stack.length; i++) {
        if (bar.contains(stack[i])) continue;
        var t = stack[i].closest("[data-tone]");
        tone = t ? t.getAttribute("data-tone") : "";
        break;
      }
      if (bar.getAttribute("data-over") !== tone) bar.setAttribute("data-over", tone);
    });
  }
  function onScroll() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(function () {
      root.toggleAttribute("data-scrolled", window.scrollY > 24);
      adapt();
      ticking = false;
    });
  }
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  /* specular light follows the pointer across glass (static under reduced motion) */
  var glass = document.querySelectorAll("[data-spec]");
  if (glass.length && !reduceMotion.matches && window.matchMedia("(pointer: fine)").matches) {
    window.addEventListener("pointermove", function (ev) {
      Array.prototype.forEach.call(glass, function (el) {
        var r = el.getBoundingClientRect();
        var x = Math.max(-0.5, Math.min(1.5, (ev.clientX - r.left) / r.width));
        var y = Math.max(-0.5, Math.min(1.5, (ev.clientY - r.top) / r.height));
        el.style.setProperty("--lx", (x * 100).toFixed(1) + "%");
        el.style.setProperty("--ly", (y * 100).toFixed(1) + "%");
      });
    }, { passive: true });
  }

  /* ---------- WebMCP: expose read-only page facts to in-browser agents ----------
     Spec: https://webmachinelearning.github.io/webmcp/ (document.modelContext.registerTool).
     Older Chrome previews used navigator.modelContext, so both are feature-detected.
     Inert when neither exists. */
  function registerAgentTools() {
    var mc = document.modelContext || navigator.modelContext;
    if (!mc || typeof mc.registerTool !== "function" || !data) return 0;
    var empty = { type: "object", properties: {} };
    var tools = [
      {
        name: "get_project_summary",
        title: "Project summary",
        description: "Returns a short summary of Onionskin from this page: what it does, release status, supported file formats and agents, license, author and website URL.",
        inputSchema: empty,
        annotations: { readOnlyHint: true },
        execute: function () {
          return Promise.resolve({
            name: data.name, url: data.url, description: data.description, status: data.status,
            released: data.launched, formats: data.formats, agents: data.agents, license: data.license,
            author: data.author.name
          });
        }
      },
      {
        name: "get_install_instructions",
        title: "Install instructions",
        description: "Returns the install and invocation steps for Onionskin as listed on this page, with a note on whether they work yet.",
        inputSchema: empty,
        annotations: { readOnlyHint: true },
        execute: function () {
          return Promise.resolve({
            released: data.launched, note: data.install.note, setupCommand: data.install.setup,
            skillCommand: data.install.skill, example: data.install.example, steps: data.install.steps
          });
        }
      },
      {
        name: "get_faq",
        title: "FAQ",
        description: "Returns the questions and answers from the FAQ section of this page.",
        inputSchema: empty,
        annotations: { readOnlyHint: true },
        execute: function () { return Promise.resolve({ faq: data.faq }); }
      },
      {
        name: "get_links",
        title: "Links",
        description: "Returns the project links from this page: the GitHub repository URL and whether it is public yet, and the author's website, GitHub and X profiles.",
        inputSchema: empty,
        annotations: { readOnlyHint: true },
        execute: function () { return Promise.resolve(data.links); }
      },
      {
        name: "open_github_repo",
        title: "Open GitHub repository",
        description: data.openRepoDescription,
        inputSchema: empty,
        annotations: { readOnlyHint: false },
        execute: function () {
          window.location.assign(data.links.repo);
          return Promise.resolve({ opened: data.links.repo });
        }
      }
    ];
    var n = 0;
    tools.forEach(function (tool) {
      try {
        var r = mc.registerTool(tool);
        if (r && typeof r.then === "function") r.then(null, function () { /* duplicate or rejected: leave the page working */ });
        n++;
      } catch (e) { /* unsupported shape in this preview build: skip this tool */ }
    });
    return n;
  }
  root.setAttribute("data-webmcp", String(registerAgentTools()));
})();

/* Edge lensing for glass elements ([data-lens]), Chromium only.
   Builds a convex-bevel displacement map per element (offsets point inward along
   the rounded-rect edge normal, neutral in the middle) and exposes it as
   --lens: url(#id) for `backdrop-filter`. Safari and Firefox do not render SVG
   filters in backdrop-filter, so they keep the plain frosted glass the CSS
   already draws. Off with ?lens=off, under prefers-reduced-transparency, or
   when the browser is not Chromium. Data attribute: data-lens="bevel scale". */
(function () {
  "use strict";
  var root = document.documentElement;
  var off = /[?&]lens=off\b/.test(location.search);
  var brands = navigator.userAgentData && navigator.userAgentData.brands;
  var chromium = !!(brands && brands.some(function (b) { return /Chromium/.test(b.brand); }));
  var lowTransparency = window.matchMedia("(prefers-reduced-transparency: reduce)").matches;
  if (off || !chromium || lowTransparency || !window.ResizeObserver) { root.setAttribute("data-lens", "0"); return; }

  var NS = "http://www.w3.org/2000/svg";
  var svg = document.createElementNS(NS, "svg");
  svg.setAttribute("width", "0"); svg.setAttribute("height", "0"); svg.setAttribute("aria-hidden", "true");
  svg.style.position = "absolute";
  var defs = document.createElementNS(NS, "defs");
  svg.appendChild(defs);
  document.body.appendChild(svg);

  function map(w, h, r, bevel) {
    var c = document.createElement("canvas");
    c.width = w; c.height = h;
    var ctx = c.getContext("2d");
    var img = ctx.createImageData(w, h), d = img.data;
    var hw = w / 2, hh = h / 2;
    r = Math.min(r, hw, hh);
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var px = x + 0.5 - hw, py = y + 0.5 - hh;
        var qx = Math.abs(px) - (hw - r), qy = Math.abs(py) - (hh - r);
        var nx, ny, dist;
        if (qx > 0 && qy > 0) {
          var len = Math.sqrt(qx * qx + qy * qy) || 1;
          dist = r - len; nx = qx / len; ny = qy / len;
        } else if (qx > qy) { dist = r - qx; nx = 1; ny = 0; }
        else { dist = r - qy; nx = 0; ny = 1; }
        /* inward unit vector = minus the outward normal, in the pixel's quadrant */
        var ix = -nx * (px < 0 ? -1 : 1), iy = -ny * (py < 0 ? -1 : 1);
        var t = Math.max(0, Math.min(1, dist / bevel));
        var mag = dist < 0 ? 0 : Math.pow(1 - t, 1.7);
        var i = (y * w + x) * 4;
        d[i] = 128 + ix * mag * 127;
        d[i + 1] = 128 + iy * mag * 127;
        d[i + 2] = 128; d[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return c.toDataURL();
  }

  var n = 0;
  function build(el) {
    var w = Math.round(el.offsetWidth), h = Math.round(el.offsetHeight);
    if (!w || !h) return;
    var key = w + "x" + h + (root.getAttribute("data-theme") || "") + (el.getAttribute("data-over") || "");
    if (el._lensKey === key) return;
    el._lensKey = key;
    var parts = (el.getAttribute("data-lens") || "").split(/\s+/);
    var bevel = parseFloat(parts[0]) || 18, scale = parseFloat(parts[1]) || 48;
    var r = parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0;
    var id = el._lensId || (el._lensId = "lens-" + (++n));
    var f = document.getElementById(id);
    if (!f) {
      f = document.createElementNS(NS, "filter");
      f.id = id;
      f.setAttribute("filterUnits", "userSpaceOnUse");
      f.setAttribute("color-interpolation-filters", "sRGB");
      /* three displacement passes at slightly different strengths bend red, green and blue by different
         amounts, so high-contrast edges seen through the rim show a thin prismatic fringe, as real glass does */
      var chan = function (id, ch, vals) { return '<feDisplacementMap in="b" in2="m" xChannelSelector="R" yChannelSelector="G" result="d' + id + '"/><feColorMatrix in="d' + id + '" type="matrix" values="' + vals + '" result="' + ch + '"/>'; };
      f.innerHTML = '<feGaussianBlur in="SourceGraphic" result="b" edgeMode="duplicate"/><feImage result="m" preserveAspectRatio="none"/>'
        + chan("r", "cr", "1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 0")
        + chan("g", "cg", "0 0 0 0 0 0 1 0 0 0 0 0 0 0 0 0 0 0 1 0")
        + chan("b", "cb", "0 0 0 0 0 0 0 0 0 0 0 0 1 0 0 0 0 0 1 0")
        + '<feBlend in="cr" in2="cg" mode="screen" result="rg"/><feBlend in="rg" in2="cb" mode="screen" result="rgb"/><feColorMatrix in="rgb" type="saturate" result="s"/><feComponentTransfer in="s"><feFuncR type="linear"/><feFuncG type="linear"/><feFuncB type="linear"/></feComponentTransfer>';
      defs.appendChild(f);
    }
    f.setAttribute("x", "0"); f.setAttribute("y", "0"); f.setAttribute("width", w); f.setAttribute("height", h);
    var cs = getComputedStyle(el);
    var blur = parseFloat(cs.getPropertyValue("--g-blur")) || 8;
    var sat = parseFloat(cs.getPropertyValue("--g-sat")) || 1.6;
    var bri = parseFloat(cs.getPropertyValue("--g-bri")) || 1;
    f.querySelector("feGaussianBlur").setAttribute("stdDeviation", blur);
    f.querySelector("feColorMatrix[type=saturate]").setAttribute("values", sat);
    Array.prototype.forEach.call(f.querySelectorAll("feComponentTransfer > *"), function (fn) { fn.setAttribute("slope", bri); });
    var fi = f.querySelector("feImage");
    fi.setAttribute("href", map(w, h, r, bevel));
    fi.setAttribute("x", "0"); fi.setAttribute("y", "0"); fi.setAttribute("width", w); fi.setAttribute("height", h);
    var dm = f.querySelectorAll("feDisplacementMap");
    dm[0].setAttribute("scale", scale * 0.96); dm[1].setAttribute("scale", scale); dm[2].setAttribute("scale", scale * 1.04);
    el.style.setProperty("--lens", "url(#" + id + ")");
  }

  var ro = new ResizeObserver(function (entries) { entries.forEach(function (e) { build(e.target); }); });
  var els = document.querySelectorAll("[data-lens]");
  Array.prototype.forEach.call(els, function (el) { build(el); ro.observe(el); });
  /* theme or tint flips change the frost values: rebuild */
  new MutationObserver(function () { Array.prototype.forEach.call(els, build); }).observe(root, { attributes: true, attributeFilter: ["data-theme"] });
  Array.prototype.forEach.call(els, function (el) { new MutationObserver(function () { build(el); }).observe(el, { attributes: true, attributeFilter: ["data-over"] }); });
  root.classList.add("lens");
  root.setAttribute("data-lens", String(els.length));
})();
