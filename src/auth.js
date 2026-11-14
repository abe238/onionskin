import crypto from "node:crypto";

const NONCE_TTL_MS = 60_000;

export function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  const len = Math.max(x.length, y.length, 1);
  const px = Buffer.alloc(len);
  const py = Buffer.alloc(len);
  x.copy(px);
  y.copy(py);
  return crypto.timingSafeEqual(px, py) && x.length === y.length;
}

const MAX_TOKENS_PER_BROWSER = 50;

/**
 * Browser auth: single-use launch nonce -> cookie + launch token.
 * Cookies are NOT port-scoped: another HTTP server on another 127.0.0.1 port is sent this one's cookie (the name carries the port, but the
 * browser still attaches it), and can replay it with plain HTTP. So the cookie is only the first factor. The second is a launch token that is
 * handed to the page exactly once, in the response to the nonce exchange, and that the page keeps in memory and in its own origin's
 * sessionStorage (the origin includes the port: a page on another port cannot read it). Every API request, bootstrap included, must present
 * the cookie AND a token minted for that cookie. A new tab, or a page that lost its storage, gets a token only through a new launch link
 * (`onionskin open` again prints one); the cookie is shared by all tabs of one browser, each launch adds its own token to it.
 */
export class BrowserAuth {
  constructor(port, { now = Date.now } = {}) {
    this.port = port;
    this.now = now;
    this.nonces = new Map(); // nonce -> expiry
    this.sessions = new Map(); // cookie value -> { tokens: Set }
    this.cookieName = `onionskin_sid_${port}`;
    this.origin = `http://127.0.0.1:${port}`;
    this.host = `127.0.0.1:${port}`;
  }
  newNonce() {
    const n = crypto.randomBytes(24).toString("base64url");
    this.nonces.set(n, this.now() + NONCE_TTL_MS);
    return n;
  }
  #cookieAttrs() {
    // HttpOnly + SameSite=Strict + Path=/, no Domain (host-only). The `__Host-` prefix would also demand `Secure`, which Safari refuses on http, so it is not used:
    // the port-specific name and the second factor (the launch token) carry that job on loopback.
    return "HttpOnly; SameSite=Strict; Path=/";
  }
  /**
   * Consumes the nonce. Returns {cookie, token} (a Set-Cookie header value and a fresh launch token for the page) or null.
   * A browser that already holds a live cookie keeps it and gets an additional token, so a second tab or a second `open` never invalidates
   * a tab that is already open.
   */
  exchange(nonce, req = null) {
    const exp = this.nonces.get(nonce || "");
    this.nonces.delete(nonce || "");
    for (const [k, v] of this.nonces) if (v < this.now()) this.nonces.delete(k);
    if (!exp || exp < this.now()) return null;
    let sid = req && this.cookieSid(req);
    if (!sid) {
      sid = crypto.randomBytes(32).toString("base64url");
      this.sessions.set(sid, { tokens: new Set() });
    }
    const rec = this.sessions.get(sid);
    const token = crypto.randomBytes(32).toString("base64url");
    rec.tokens.add(token);
    if (rec.tokens.size > MAX_TOKENS_PER_BROWSER) rec.tokens.delete(rec.tokens.values().next().value); // oldest first
    return { cookie: `${this.cookieName}=${sid}; ${this.#cookieAttrs()}`, token };
  }
  /** the cookie value of a live session, or null */
  cookieSid(req) {
    const raw = req.headers.cookie || "";
    for (const part of raw.split(";")) {
      const [k, ...v] = part.trim().split("=");
      if (k === this.cookieName) {
        const sid = v.join("=");
        for (const s of this.sessions.keys()) if (safeEqual(s, sid)) return s;
      }
    }
    return null;
  }
  cookieSession(req) {
    const sid = this.cookieSid(req);
    return sid ? this.sessions.get(sid) : null;
  }
  hostOk(req) {
    return req.headers.host === this.host;
  }
  tokenOk(sess, token) {
    if (!token) return false;
    let ok = false;
    for (const t of sess.tokens) if (safeEqual(t, token)) ok = true; // no early exit: constant work per token
    return ok;
  }
  /**
   * Returns null if the request may proceed, else {status, error, code?}.
   * Always: exact Host, a live cookie, and a launch token minted for that cookie (header `x-onionskin-token`, or `queryToken` for the event stream,
   * which EventSource cannot add a header to). A request without a token is `token_required` (the page tells the user to reopen from the terminal).
   * mutating: POST etc. also require exact Origin, Sec-Fetch-Site same-origin and a JSON content type.
   */
  check(req, { mutating = false, queryToken = "" } = {}) {
    if (!this.hostOk(req)) return { status: 403, error: "bad host" };
    const sess = this.cookieSession(req);
    if (!sess) return { status: 401, error: "no session" };
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== this.origin) return { status: 403, error: "bad origin" };
    const sfs = req.headers["sec-fetch-site"];
    if (sfs !== undefined && sfs !== "same-origin") return { status: 403, error: "cross-site request" };
    if (mutating) {
      if (origin !== this.origin) return { status: 403, error: "origin required" };
      if (sfs !== "same-origin") return { status: 403, error: "sec-fetch-site must be same-origin" };
      if (!/^application\/json(\s*;|$)/i.test(req.headers["content-type"] || "")) return { status: 415, error: "content-type must be application/json" };
    }
    const token = req.headers["x-onionskin-token"] || queryToken || "";
    if (!token) return { status: 403, error: "launch token required", code: "token_required" };
    if (!this.tokenOk(sess, token)) return { status: 403, error: "bad token", code: "token_required" };
    return null;
  }
}

export const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "font-src 'self' data:",
  "connect-src 'self' blob:",
  "worker-src 'self' blob:",
  "frame-src 'self' blob:",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");
