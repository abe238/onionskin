/* Onionskin "Quiet": mounts scrollcraft for two pinned moments and adds small feedback.
   Runs after site.js (theme, copy, dialog stay there). Nothing here is required to read the page:
   without html.motion (no JS, or prefers-reduced-motion) only the Copy confirmation color is added. */
(function () {
  "use strict";
  var root = document.documentElement;
  var motion = root.classList.contains("motion");

  /* ---------- Copy confirmation: once site.js reports success ("Copied"), the button turns green and the row flashes ---------- */
  Array.prototype.forEach.call(document.querySelectorAll("[data-copy]"), function (b) {
    var row = b.closest(".cmd");
    new MutationObserver(function () {
      var ok = b.textContent === "Copied";
      if (ok) { b.classList.remove("copied"); if (row) row.classList.remove("flash"); void b.offsetWidth; }
      b.classList.toggle("copied", ok); if (row) row.classList.toggle("flash", ok);
    }).observe(b, { childList: true, characterData: true, subtree: true });
  });

  if (!motion) return;

  /* ---------- theme switch through a view transition (site.js still does the switching) ---------- */
  var toggle = document.getElementById("theme-toggle");
  var replaying = false;
  if (toggle && typeof document.startViewTransition === "function") {
    toggle.addEventListener("click", function (e) {
      if (replaying) return;
      e.stopImmediatePropagation();
      document.startViewTransition(function () { replaying = true; toggle.click(); replaying = false; });
    }, true);
  }

  /* ---------- the two pinned acts ---------- */
  var see = document.getElementById("see");
  var loopAct = document.querySelector("[data-loop-act]");
  if (window.ScrollCraft && see) {
    /* phones keep the frames in a plain column, each shown whole (the marked-up step is the phone layout) */
    if (innerWidth > 760) {
      see.setAttribute("data-sc-act", "pin");
      /* the pin is decided once, at load; drop the portrait phone capture so a later rotation to a narrow screen
         keeps three same-shaped frames in the stack instead of cropping a portrait one */
      Array.prototype.forEach.call(see.querySelectorAll("picture source"), function (s) { s.remove(); });
    }
    /* the diagram and five steps only fit beside each other on a wide, tall enough screen; elsewhere they stay a normal list */
    if (loopAct && innerWidth >= 981 && innerHeight >= 620) loopAct.setAttribute("data-sc-act", "pin");
    var sc = window.ScrollCraft.mount(document);
    /* pin the loop only if its pinned layout fits in one screen; otherwise remount without it (normal list) */
    var ls = loopAct && loopAct.querySelector("[data-sc-stage]");
    if (ls && loopAct.hasAttribute("data-sc-act") && ls.scrollHeight > ls.clientHeight + 1) {
      sc.destroy();
      loopAct.removeAttribute("data-sc-act");
      loopAct.classList.remove("sc-act--pinned"); ls.classList.remove("sc-stage"); loopAct.style.height = "";
      sc = window.ScrollCraft.mount(document);
    }
    var act = null;
    if (loopAct && loopAct.hasAttribute("data-sc-act")) {
      sc.acts.forEach(function (a) { if (a.el === loopAct) act = a; });
    }
    if (act) {
      var last = 0, queued = false;
      var upd = function () {
        queued = false;
        var s = Math.min(5, Math.floor(act.p * 5) + 1);
        if (s !== last) { last = s; loopAct.setAttribute("data-step", String(s)); }
      };
      addEventListener("scroll", function () { if (!queued) { queued = true; requestAnimationFrame(upd); } }, { passive: true });
      requestAnimationFrame(upd);
    }
  }

  /* ---------- headlines assemble line by line, once ---------- */
  function split(h) {
    var text = h.textContent;
    var words = text.split(/\s+/).filter(Boolean);
    h.textContent = "";
    var probes = words.map(function (w, i) {
      var s = document.createElement("span");
      s.textContent = w;
      h.appendChild(s);
      if (i < words.length - 1) h.appendChild(document.createTextNode(" "));
      return s;
    });
    var lines = [], cur = null, top = null;
    probes.forEach(function (s) {
      if (top === null || Math.abs(s.offsetTop - top) > 2) { cur = []; lines.push(cur); top = s.offsetTop; }
      cur.push(s.textContent);
    });
    h.textContent = "";
    lines.forEach(function (ws, i) {
      var m = document.createElement("span"); m.className = "kl";
      var n = document.createElement("span"); n.textContent = ws.join(" "); n.style.setProperty("--i", i);
      m.appendChild(n); h.appendChild(m);
      if (i < lines.length - 1) h.appendChild(document.createTextNode(" "));
    });
    return { text: text, n: lines.length };
  }
  var heads = Array.prototype.filter.call(document.querySelectorAll("main h2"), function (h) {
    return !h.children.length && !h.closest(".fact-fallback");
  });
  function assemble(h) {
    var r = split(h);
    h.classList.add("kin-prep");
    void h.offsetWidth;
    requestAnimationFrame(function () { h.classList.add("kin"); });
    /* hand back the plain heading so it reflows normally on resize and copies cleanly */
    setTimeout(function () { h.textContent = r.text; h.classList.remove("kh", "kin-prep", "kin"); }, 950 + r.n * 80);
  }
  if ("IntersectionObserver" in window && heads.length) {
    var ready = document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve();
    ready.then(function () {
      var hio = new IntersectionObserver(function (es) {
        es.forEach(function (e) { if (e.isIntersecting) { hio.unobserve(e.target); assemble(e.target); } });
      }, { rootMargin: "0px 0px -12% 0px" });
      heads.forEach(function (h) { h.classList.add("kh"); hio.observe(h); });
    });
  }

  /* ---------- lists that arrive with a short stagger ---------- */
  var lists = document.querySelectorAll(".steps, .formats");
  if ("IntersectionObserver" in window && lists.length) {
    var lio = new IntersectionObserver(function (es) {
      es.forEach(function (e) { if (e.isIntersecting) { lio.unobserve(e.target); e.target.classList.add("in"); } });
    }, { rootMargin: "0px 0px -10% 0px" });
    Array.prototype.forEach.call(lists, function (l) {
      Array.prototype.forEach.call(l.children, function (li, i) { li.style.setProperty("--i", i); });
      l.classList.add("rv"); lio.observe(l);
    });
  }

})();
