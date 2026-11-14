import { useEffect, useRef, useState } from "react";
import { store } from "./lib.js";

export function useMedia(query) {
  const [on, setOn] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const m = window.matchMedia(query);
    const f = () => setOn(m.matches);
    f();
    m.addEventListener("change", f);
    return () => m.removeEventListener("change", f);
  }, [query]);
  return on;
}

/** light | dark. The OS setting is the default; a choice made here is remembered for this browser. */
export function useTheme() {
  const [theme, setTheme] = useState(() => store.get("localStorage", "onionskin.theme") || (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  return [theme, (t) => (store.set("localStorage", "onionskin.theme", t), setTheme(t))];
}

export const SIDE_MIN = 320;
export const SIDE_MAX = 520;
const clampW = (w) => Math.min(SIDE_MAX, Math.max(SIDE_MIN, Math.round(w)));

/** Sidebar width and collapsed flag, remembered in sessionStorage. */
export function useSidebar() {
  const [width, setW] = useState(() => clampW(Number(store.get("sessionStorage", "onionskin.sideW")) || 380));
  const [collapsed, setC] = useState(() => store.get("sessionStorage", "onionskin.sideCollapsed") === "1");
  return {
    width,
    collapsed,
    setWidth: (w) => {
      const v = clampW(w);
      store.set("sessionStorage", "onionskin.sideW", v);
      setW(v);
    },
    setCollapsed: (c) => {
      store.set("sessionStorage", "onionskin.sideCollapsed", c ? "1" : "0");
      setC(c);
    },
  };
}

/** Run fn at most once per animation frame; returns a schedule() function. */
export function useFrame(fn) {
  const ref = useRef(fn);
  ref.current = fn;
  const raf = useRef(0);
  const schedule = useRef(() => {
    if (raf.current) return;
    raf.current = requestAnimationFrame(() => {
      raf.current = 0;
      ref.current();
    });
  });
  useEffect(() => () => cancelAnimationFrame(raf.current), []);
  return schedule.current;
}

// Safari does not focus a button when it is clicked (document.activeElement stays <body>), so the opener is also remembered from the press itself.
let lastPress = null;
if (typeof document !== "undefined") document.addEventListener("pointerdown", (e) => (lastPress = e.target?.closest?.("button, a[href], [tabindex]") || null), true);

/** Trap Tab inside a container while it is open (dialogs, drawer); Escape calls onClose; focus returns to the opener. */
export function useFocusTrap(ref, active, onClose) {
  useEffect(() => {
    if (!active || !ref.current) return;
    const el = ref.current;
    const ae = document.activeElement;
    const prev = ae && ae !== document.body && ae !== document.documentElement ? ae : lastPress?.isConnected ? lastPress : ae;
    const focusables = () => [...el.querySelectorAll('a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])')].filter((n) => n.offsetParent !== null);
    if (!el.contains(document.activeElement)) (focusables()[0] || el).focus(); // a field inside that already has the focus (a comment just created) keeps it
    const onKey = (e) => {
      if (e.key === "Escape") return onClose?.();
      if (e.key !== "Tab") return;
      const f = focusables();
      if (!f.length) return e.preventDefault();
      const first = f[0];
      const last = f[f.length - 1];
      if (e.shiftKey && (document.activeElement === first || !el.contains(document.activeElement))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (document.activeElement === last || !el.contains(document.activeElement))) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      prev?.focus?.();
    };
  }, [active]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** Phone: track the visual viewport so the review sheet and its pinned Send area stay above the on-screen keyboard.
 *  Sets --vvh (visible height) and --kb (keyboard height) on <html>, and data-kb while a keyboard is up. */
export function useVisualViewport(active) {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!active || !vv) return;
    const root = document.documentElement;
    const set = () => {
      const kb = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
      root.style.setProperty("--vvh", `${Math.round(vv.height)}px`);
      root.style.setProperty("--kb", `${kb}px`);
      if (kb > 80) root.dataset.kb = "1";
      else delete root.dataset.kb;
    };
    set();
    vv.addEventListener("resize", set);
    vv.addEventListener("scroll", set);
    return () => {
      vv.removeEventListener("resize", set);
      vv.removeEventListener("scroll", set);
      root.style.removeProperty("--vvh");
      root.style.removeProperty("--kb");
      delete root.dataset.kb;
    };
  }, [active]);
}
