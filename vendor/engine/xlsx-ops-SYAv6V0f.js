
// src/core/dict.ts
function e(e) {
	return Object.assign(Object.create(null), e);
}
function t(e, t) {
	return e !== void 0 && t !== void 0 && Object.hasOwn(e, t) ? e[t] : void 0;
}
// src/core/xml.ts
var n = /* @__PURE__ */ new Set(["http://schemas.openxmlformats.org/officeDocument/2006/relationships", "http://purl.oclc.org/ooxml/officeDocument/relationships"]), r = e({
	lt: "<",
	gt: ">",
	amp: "&",
	quot: "\"",
	apos: "'"
});
function i(e) {
	return e.indexOf("&") < 0 ? e : e.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (e, t) => {
		if (t[0] === "#") {
			let n = t[1] === "x" || t[1] === "X" ? parseInt(t.slice(2), 16) : parseInt(t.slice(1), 10);
			return Number.isFinite(n) && n <= 1114111 ? String.fromCodePoint(n) : e;
		}
		return r[t] ?? e;
	});
}
var a = (e) => e === 32 || e === 9 || e === 10 || e === 13, o = 1024, s = () => /* @__PURE__ */ Error(`XML nested deeper than ${o} elements`), c = class {
	h;
	raw;
	buf = "";
	depth = 0;
	skipDepth = -1;
	relPrefixes = /* @__PURE__ */ new Set(["r"]);
	constructor(e, t) {
		this.h = e, this.raw = t;
	}
	write(e) {
		this.buf = this.buf.length ? this.buf + e : e, this.run(!1);
	}
	end() {
		this.run(!0), this.buf = "";
	}
	run(e) {
		let t = this.buf, n = t.length, r = 0;
		for (; r < n;) {
			let i = t.indexOf("<", r);
			if (i < 0) {
				if (e) {
					let e = t.substring(r);
					this.raw?.(e), this.onText(e), r = n;
				}
				break;
			}
			if (i > r) {
				let e = t.substring(r, i);
				this.raw?.(e), this.onText(e);
			}
			if (r = i, i + 1 >= n) break;
			let a = t.charCodeAt(i + 1);
			if (a === 47) {
				let e = t.indexOf(">", i + 2);
				if (e < 0) break;
				this.raw?.(t.substring(i, e + 1)), this.onClose(t.substring(i + 2, e)), r = e + 1;
				continue;
			}
			if (a === 63) {
				let e = t.indexOf("?>", i + 2);
				if (e < 0) break;
				this.raw?.(t.substring(i, e + 2)), r = e + 2;
				continue;
			}
			if (a === 33) {
				if (n - i < 9 && !e) break;
				if (t.startsWith("<!--", i)) {
					let e = t.indexOf("-->", i + 4);
					if (e < 0) break;
					this.raw?.(t.substring(i, e + 3)), r = e + 3;
					continue;
				}
				if (t.startsWith("<![CDATA[", i)) {
					let e = t.indexOf("]]>", i + 9);
					if (e < 0) break;
					this.raw?.(t.substring(i, e + 3)), this.skipDepth < 0 && this.h.text(t.substring(i + 9, e)), r = e + 3;
					continue;
				}
				let a = t.indexOf(">", i + 2);
				if (a < 0) break;
				this.raw?.(t.substring(i, a + 1)), r = a + 1;
				continue;
			}
			let o = -1, s = 0;
			for (let e = i + 1; e < n; e++) {
				let n = t.charCodeAt(e);
				if (s !== 0) n === s && (s = 0);
				else if (n === 34 || n === 39) s = n;
				else if (n === 62) {
					o = e;
					break;
				}
			}
			if (o < 0) break;
			this.raw?.(t.substring(i, o + 1)), this.onOpen(t, i + 1, o), r = o + 1;
		}
		this.buf = r >= n ? "" : t.substring(r);
	}
	onText(e) {
		this.skipDepth >= 0 || this.depth === 0 || this.h.text(e.indexOf("&") >= 0 ? i(e) : e);
	}
	onOpen(e, t, r) {
		let o = r, c = !1;
		if (e.charCodeAt(r - 1) === 47 && (c = !0, o = r - 1), this.skipDepth >= 0) {
			if (!c && ++this.depth > 1024) throw s();
			return;
		}
		let l = t;
		for (; l < o && !a(e.charCodeAt(l));) l++;
		let u = e.substring(t, l), d = u.indexOf(":"), f = d < 0 ? u : u.substring(d + 1), p = {};
		for (; l < o;) {
			if (a(e.charCodeAt(l))) {
				l++;
				continue;
			}
			let t = e.indexOf("=", l);
			if (t < 0 || t >= o) break;
			let r = e.substring(l, t).trim(), s = t + 1;
			for (; s < o && e.charCodeAt(s) !== 34 && e.charCodeAt(s) !== 39;) s++;
			if (s >= o) break;
			let c = e.indexOf(e[s], s + 1);
			if (c < 0) break;
			let u = e.substring(s + 1, c);
			l = c + 1;
			let d = r.indexOf(":");
			if (d >= 0) {
				let e = r.substring(0, d), t = r.substring(d + 1);
				if (e === "xmlns") {
					n.has(u) && this.relPrefixes.add(t);
					continue;
				}
				r = this.relPrefixes.has(e) ? "r:" + t : t;
			} else if (r === "xmlns") continue;
			p[r] = u.indexOf("&") >= 0 ? i(u) : u;
		}
		let m = this.h.open(f, p, c);
		if (c) m || this.h.close(f);
		else {
			if (++this.depth > 1024) throw s();
			m && (this.skipDepth = this.depth);
		}
	}
	onClose(e) {
		if (this.skipDepth >= 0) {
			this.depth === this.skipDepth && (this.skipDepth = -1), this.depth--;
			return;
		}
		this.depth--;
		let t = e.trim(), n = t.indexOf(":");
		this.h.close(n < 0 ? t : t.substring(n + 1));
	}
}, l = class extends Error {
	constructor() {
		super("aborted"), this.name = "AbortError";
	}
};
async function u(e, t, n = {}) {
	let r = e.getReader(), i = new TextDecoder(), a = new c(t, n.raw);
	try {
		for (;;) {
			if (n.signal?.aborted) throw new l();
			let { done: e, value: t } = await r.read();
			if (e) break;
			a.write(i.decode(t, { stream: !0 })), n.onChunk && await n.onChunk(t.length);
		}
		a.write(i.decode()), a.end();
	} catch (e) {
		throw r.cancel().catch(() => {}), e;
	}
}
var d = 0, f = 1, p = class {
	o;
	root = null;
	stack = [];
	parents = [];
	depth = 0;
	alt = [];
	constructor(e = {}) {
		this.o = e;
	}
	open(e, t) {
		if (e === "Fallback" || this.o.skip?.has(e)) return !0;
		if (e === "AlternateContent") {
			this.alt.push(!1), this.stack.push(d);
			return;
		}
		if (e === "Choice" && this.alt.length) {
			let e = this.alt.length - 1;
			if (this.alt[e]) return !0;
			this.alt[e] = !0, this.stack.push(d);
			return;
		}
		let n = this.depth++;
		if (this.o.emitDepth !== void 0 && n < this.o.emitDepth) {
			this.o.onShallowOpen?.(e, t, n), this.stack.push(f);
			return;
		}
		let r = {
			n: e,
			a: t,
			c: [],
			t: ""
		}, i = this.parents[this.parents.length - 1];
		i && i.c.push(r), this.parents.push(r), this.stack.push(r);
	}
	close(e) {
		let t = this.stack.pop();
		t === d ? e === "AlternateContent" && this.alt.pop() : (this.depth--, t !== f && t !== void 0 && (this.parents.pop(), this.parents.length === 0 && (this.o.emitDepth === void 0 ? this.root = t : this.o.onElement?.(t))));
	}
	text(e) {
		let t = this.parents[this.parents.length - 1];
		t && (t.t += e);
	}
};
function m(e, t) {
	let n = new p({ skip: t }), r = new c(n);
	if (r.write(e), r.end(), !n.root) throw Error("Empty XML document");
	return n.root;
}
function h(e, t) {
	if (e) {
		for (let n of e.c) if (n.n === t) return n;
	}
}
function g(e, t) {
	return e ? e.c.filter((e) => e.n === t) : [];
}
function ee(e, ...t) {
	let n = e;
	for (let e of t) if (n = h(n, e), !n) return;
	return n;
}
function _(e, t) {
	if (e) for (let n of e.c) {
		if (n.n === t) return n;
		let e = _(n, t);
		if (e) return e;
	}
}
function te(e, t, n = []) {
	if (!e) return n;
	for (let r of e.c) r.n === t ? n.push(r) : te(r, t, n);
	return n;
}
function v(e, t) {
	if (e === void 0 || e === "") return t;
	let n = Number(e);
	return Number.isFinite(n) ? n : t;
}
function ne(e, t = "val") {
	if (!e) return;
	let n = e.a[t];
	return n === void 0 || n !== "0" && n !== "false" && n !== "off" && n !== "none";
}
function y(e) {
	if (!e) return "";
	if (!e.c.length) return e.t;
	let t = "";
	for (let n of e.c) t += n.n === "t" ? n.t : y(n);
	return t;
}
// src/core/color.ts
var re = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i, ie = /^(?:rgb|hsl)a?\([-+.,%/\s0-9]{1,80}\)$/i, ae = /^[a-z]{3,30}$/i;
function b(e) {
	if (typeof e != "string" || e.length > 100) return;
	let t = e.trim();
	return re.test(t) || ie.test(t) || ae.test(t) ? t : void 0;
}
var x = "-?\\d+(?:\\.\\d+)?(?:e[-+]?\\d+)?", oe = RegExp(`^(?:linear-gradient\\(${x}deg|radial-gradient\\(circle)(?:,\\s*(?:#[0-9a-f]{3,8}|rgba?\\([-.,\\s0-9]{1,60}\\))(?:\\s+${x}%)?){1,400}\\)$`, "i");
function se(e) {
	let t = b(e);
	if (t !== void 0 || typeof e != "string" || e.length > 2e4) return t;
	let n = e.trim();
	return oe.test(n) ? n : void 0;
}
function S(e) {
	if (typeof e == "string") {
		if (/^[0-9a-f]{6}$/i.test(e)) return "#" + e.toLowerCase();
		if (/^[0-9a-f]{8}$/i.test(e)) return "#" + e.slice(2).toLowerCase();
		if (/^[0-9a-f]{3}$/i.test(e)) return "#" + e.toLowerCase().replace(/./g, "$&$&");
	}
}
function C(e) {
	let t = typeof e == "string" ? e.replace(/^#/, "") : "";
	return (t.length === 8 ? void 0 : S(t))?.slice(1).toUpperCase();
}
function w(e) {
	let t = e.replace("#", ""), n = t.length === 8 ? t.slice(2) : t.padStart(6, "0").slice(0, 6);
	return [
		parseInt(n.slice(0, 2), 16) || 0,
		parseInt(n.slice(2, 4), 16) || 0,
		parseInt(n.slice(4, 6), 16) || 0
	];
}
function T([e, t, n]) {
	let r = (e) => Math.max(0, Math.min(255, Math.round(e))).toString(16).padStart(2, "0");
	return "#" + r(e) + r(t) + r(n);
}
function E([e, t, n]) {
	e /= 255, t /= 255, n /= 255;
	let r = Math.max(e, t, n), i = Math.min(e, t, n), a = (r + i) / 2;
	if (r === i) return [
		0,
		0,
		a
	];
	let o = r - i, s = a > .5 ? o / (2 - r - i) : o / (r + i), c = 0;
	return c = r === e ? (t - n) / o + (t < n ? 6 : 0) : r === t ? (n - e) / o + 2 : (e - t) / o + 4, [
		c / 6,
		s,
		a
	];
}
function D([e, t, n]) {
	if (t === 0) return [
		n * 255,
		n * 255,
		n * 255
	];
	let r = n < .5 ? n * (1 + t) : n + t - n * t, i = 2 * n - r, a = (e) => (e < 0 && (e += 1), e > 1 && --e, e < 1 / 6 ? i + (r - i) * 6 * e : e < 1 / 2 ? r : e < 2 / 3 ? i + (r - i) * (2 / 3 - e) * 6 : i);
	return [
		a(e + 1 / 3) * 255,
		a(e) * 255,
		a(e - 1 / 3) * 255
	];
}
var O = (e) => Math.max(0, Math.min(1, e));
function ce(e, t) {
	if (!t) return e;
	let n = E(w(e));
	return n[2] = t < 0 ? n[2] * (1 + t) : n[2] * (1 - t) + t, T(D(n));
}
var le = e({
	black: "#000000",
	white: "#ffffff",
	red: "#ff0000",
	green: "#008000",
	blue: "#0000ff",
	yellow: "#ffff00",
	cyan: "#00ffff",
	magenta: "#ff00ff",
	gray: "#808080",
	grey: "#808080",
	ltGray: "#d3d3d3",
	dkGray: "#a9a9a9",
	orange: "#ffa500",
	purple: "#800080",
	navy: "#000080",
	maroon: "#800000",
	olive: "#808000",
	teal: "#008080",
	silver: "#c0c0c0",
	lime: "#00ff00",
	pink: "#ffc0cb",
	brown: "#a52a2a",
	gold: "#ffd700"
}), ue = e({
	bg1: "lt1",
	tx1: "dk1",
	bg2: "lt2",
	tx2: "dk2"
}), de = /* @__PURE__ */ new Set([
	"srgbClr",
	"schemeClr",
	"sysClr",
	"prstClr",
	"scrgbClr",
	"hslClr"
]);
function fe(e, n) {
	let r;
	switch (e.n) {
		case "srgbClr":
			r = e.a.val === void 0 ? "#000000" : S(e.a.val);
			break;
		case "sysClr":
			r = S(e.a.lastClr) ?? (e.a.val === "window" ? "#ffffff" : "#000000");
			break;
		case "prstClr":
			r = le[e.a.val] ?? "#000000";
			break;
		case "scrgbClr":
			r = T([
				(v(e.a.r) ?? 0) / 1e5 * 255,
				(v(e.a.g) ?? 0) / 1e5 * 255,
				(v(e.a.b) ?? 0) / 1e5 * 255
			]);
			break;
		case "hslClr":
			r = T(D([
				(v(e.a.hue) ?? 0) / 216e5,
				(v(e.a.sat) ?? 0) / 1e5,
				(v(e.a.lum) ?? 0) / 1e5
			]));
			break;
		case "schemeClr": {
			let i = e.a.val;
			if (i === "phClr") r = n.phClr;
			else {
				let e = t(n.clrMap, i) ?? ue[i] ?? i;
				r = t(n.theme?.colors, e) ?? t(n.theme?.colors, i);
			}
			break;
		}
	}
	if (r && b(r) !== void 0) return pe(r, e);
}
function pe(e, t) {
	if (!t.c.length) return e;
	let n = w(e), r = 1;
	for (let e of t.c) {
		let t = (v(e.a.val) ?? 0) / 1e5;
		switch (e.n) {
			case "alpha":
				r = t;
				break;
			case "lumMod": {
				let e = E(n);
				e[2] = O(e[2] * t), n = D(e);
				break;
			}
			case "lumOff": {
				let e = E(n);
				e[2] = O(e[2] + t), n = D(e);
				break;
			}
			case "satMod": {
				let e = E(n);
				e[1] = O(e[1] * t), n = D(e);
				break;
			}
			case "tint":
				n = n.map((e) => e + (255 - e) * (1 - t));
				break;
			case "shade":
				n = n.map((e) => e * t);
				break;
			case "inv":
				n = n.map((e) => 255 - e);
				break;
			case "gray": {
				let e = n[0] * .3 + n[1] * .59 + n[2] * .11;
				n = [
					e,
					e,
					e
				];
				break;
			}
		}
	}
	let i = T(n);
	if (r >= 1) return i;
	let [a, o, s] = w(i);
	return `rgba(${a},${o},${s},${+r.toFixed(3)})`;
}
function me(e, t) {
	if (e) {
		for (let n of e.c) if (de.has(n.n)) return fe(n, t);
	}
}
var k = "000000 FFFFFF FF0000 00FF00 0000FF FFFF00 FF00FF 00FFFF 000000 FFFFFF FF0000 00FF00 0000FF FFFF00 FF00FF 00FFFF 800000 008000 000080 808000 800080 008080 C0C0C0 808080 9999FF 993366 FFFFCC CCFFFF 660066 FF8080 0066CC CCCCFF 000080 FF00FF FFFF00 00FFFF 800080 800000 008080 0000FF 00CCFF CCFFFF CCFFCC FFFF99 99CCFF FF99CC CC99FF FFCC99 3366FF 33CCCC 99CC00 FFCC00 FF9900 FF6600 666699 969696 003366 339966 003300 333300 993300 993366 333399 333333".split(" ").map((e) => "#" + e), he = [
	"lt1",
	"dk1",
	"lt2",
	"dk2",
	"accent1",
	"accent2",
	"accent3",
	"accent4",
	"accent5",
	"accent6",
	"hlink",
	"folHlink"
];
function ge(e, n, r = k) {
	if (!e || e.a.auto === "1" || e.a.auto === "true") return;
	let i;
	if (e.a.rgb) i = S(e.a.rgb);
	else if (e.a.theme !== void 0) i = t(n?.colors, he[Number(e.a.theme)]);
	else if (e.a.indexed !== void 0) {
		let t = Number(e.a.indexed);
		if (t === 64 || t === 65) return;
		i = r[t];
	}
	if (!i || b(i) === void 0) return;
	let a = v(e.a.tint) ?? 0;
	return a ? ce(i, a) : i.toLowerCase();
}
function _e(e) {
	let t = g(h(h(e, "colors"), "indexedColors"), "rgbColor");
	return t.length ? t.map((e, t) => S(e.a.rgb) ?? k[t] ?? "#000000") : k;
}
// src/core/xlsx/formula/types.ts
var ve = [
	"#NULL!",
	"#DIV/0!",
	"#VALUE!",
	"#REF!",
	"#NAME?",
	"#NUM!",
	"#N/A"
], A = class {
	code;
	constructor(e) {
		this.code = e;
	}
	toString() {
		return this.code;
	}
}, ye = 1048575, be = 16383, xe = {
	DIV0: new A("#DIV/0!"),
	VALUE: new A("#VALUE!"),
	REF: new A("#REF!"),
	NAME: new A("#NAME?"),
	NA: new A("#N/A"),
	NUM: new A("#NUM!"),
	NULL: new A("#NULL!")
}, j = (e) => !!e && typeof e == "object" && !Array.isArray(e) && !(e instanceof Uint8Array) && Object.getPrototypeOf(e) === Object.prototype, M = (e, t = 1e3) => typeof e == "string" && e.length <= t, N = (e, t, n) => Number.isInteger(e) && e >= t && e <= n, P = (e, t = -1e9, n = 1e9) => typeof e == "number" && Number.isFinite(e) && e >= t && e <= n, F = (e) => typeof e == "boolean", I = (e, ...t) => typeof e == "string" && t.includes(e), L = (e, t, n) => e[t] === void 0 || n(e[t]), R = (e) => e === null || typeof e == "string" && C(e) !== void 0, z = (e, t = 255) => M(e, t) && !/[\u0000-\u001f<>"&]/.test(e), B = (e, ...t) => Object.keys(e).every((e) => t.includes(e));
function V(e, t = {
	depth: 40,
	nodes: 2e5,
	str: 1e6
}) {
	let n = 0, r = (e, i) => ++n > t.nodes || i > t.depth ? !1 : e == null || typeof e == "boolean" ? !0 : typeof e == "number" ? Number.isFinite(e) : typeof e == "string" ? e.length <= t.str : Array.isArray(e) ? e.every((e) => r(e, i + 1)) : j(e) ? Object.keys(e).every((t) => t !== "__proto__" && r(e[t], i + 1)) : !1;
	return r(e, 0);
}
var Se = (e, t = 10485760) => e instanceof Uint8Array && e.length <= t, Ce = (e) => typeof e == "string" && /^[A-Za-z0-9]{1,5}$/.test(e);
function H(e) {
	if (!M(e.cid, 200) || e.id !== void 0 && !M(e.id, 200)) return !1;
	let t = e.c;
	return t === null || j(t) && M(t.id, 200) && V(t, {
		depth: 8,
		nodes: 2e3,
		str: 1e5
	});
}
var U = (e) => j(e) && ("p" in e && N(e.p, 0, 2 ** 31) || B(e, "tid", "item") && L(e, "tid", (e) => N(e, 0, 2 ** 31)) && L(e, "item", (e) => N(e, 0, 2 ** 31))), W = (e, ...t) => j(e) && I(e.t, ...t);
function we(e) {
	if (!j(e)) return !1;
	switch (e.t) {
		case "text": return N(e.pid, 0, 2 ** 31) && N(e.at, 0, 1e8) && N(e.del, 0, 1e8) && Array.isArray(e.ins) && e.ins.every((e) => W(e, "text", "img", "field", "box", "shape", "ref")) && V(e.ins);
		case "paras": return Array.isArray(e.before) && e.before.length <= 1e5 && e.before.every((e) => N(e, 0, 2 ** 31)) && Array.isArray(e.next) && e.next.length <= 1e5 && e.next.every((e) => W(e, "p")) && V(e.next);
		case "blocks": return Array.isArray(e.before) && e.before.every(U) && (e.prev === null || U(e.prev)) && Array.isArray(e.next) && e.next.every((e) => W(e, "p", "tbl")) && V(e.next);
		case "image":
		case "link":
		case "call": return !0;
		case "comment": return H(e);
	}
	return !1;
}
var G = (e) => j(e) && N(e.r0, 0, 1048575) && N(e.r1, 0, 1048575) && N(e.c0, 0, 16383) && N(e.c1, 0, 16383), K = (e) => M(e, 300) && !/[\u0000-\u001f<>"&]/.test(e);
function Te(e) {
	return !j(e) || !B(e, "border", "borderColor", "b", "i", "u", "strike", "color", "fill", "align", "valign", "rotate", "wrap", "numFmt", "sz", "font", "borderStyle", "clear", "xf") ? !1 : L(e, "border", (e) => I(e, "all", "outer", "inner", "none", "top", "bottom", "left", "right")) && L(e, "borderColor", R) && [
		"b",
		"i",
		"u",
		"strike",
		"wrap",
		"clear"
	].every((t) => L(e, t, F)) && L(e, "color", R) && L(e, "fill", R) && L(e, "align", (e) => e === null || I(e, "left", "center", "right")) && L(e, "valign", (e) => e === null || I(e, "top", "center", "bottom")) && L(e, "rotate", (e) => e === null || P(e, -90, 90) || e === 255) && L(e, "numFmt", (e) => M(e, 255)) && L(e, "sz", (e) => P(e, 1, 409)) && L(e, "font", (e) => z(e, 100)) && L(e, "borderStyle", (e) => I(e, "thin", "medium", "thick", "dashed", "dotted", "double")) && L(e, "xf", (e) => N(e, 0, 65535));
}
function Ee(e) {
	if (!j(e)) return !1;
	switch (e.op) {
		case "insertRows":
		case "deleteRows": return N(e.at, 0, 1048575) && N(e.n, 1, 1048576);
		case "insertCols":
		case "deleteCols": return N(e.at, 0, 16383) && N(e.n, 1, 16384);
		case "merge":
		case "unmerge": return G(e.range) && L(e, "mode", (e) => I(e, "all", "across", "down"));
		case "hideRows": return N(e.a, 0, 1048575) && N(e.b, 0, 1048575) && F(e.hidden);
		case "hideCols": return N(e.a, 0, 16383) && N(e.b, 0, 16383) && F(e.hidden);
		case "gridlines": return F(e.show);
		case "colWidth": return N(e.c0, 0, 16383) && N(e.c1, 0, 16383) && P(e.px, 0, 1e4);
		case "rowHeight": return N(e.r0, 0, 1048575) && N(e.r1, 0, 1048575) && P(e.px, 0, 1e4);
		case "freeze": return N(e.rows, 0, 1048575) && N(e.cols, 0, 16383);
		case "fill": return G(e.range) && I(e.dir, "down", "right");
		case "sort": return G(e.range) && N(e.col, 0, 16383) && L(e, "desc", F);
	}
	return !1;
}
function De(e) {
	if (!j(e)) return !1;
	switch (e.op) {
		case "add": return L(e, "name", (e) => z(e)) && L(e, "after", K);
		case "rename": return K(e.path) && z(e.name);
		case "delete": return K(e.path);
		case "move": return K(e.path) && N(e.to, 0, 1e4);
	}
	return !1;
}
var Oe = (e) => z(e.id, 200) && z(e.target, 200) && I(e.which, "prev", "next");
function ke(e) {
	if (!j(e) || !z(e.id ?? "comment", 200)) return !1;
	switch (e.t) {
		case "set": return K(e.sheet) && Array.isArray(e.cells) && e.cells.length <= 1e6 && e.cells.every((e) => j(e) && N(e.r, 0, 1048575) && N(e.c, 0, 16383) && M(e.input, 32767));
		case "fmt": return K(e.sheet) && G(e.range) && Te(e.patch);
		case "sheet": return K(e.sheet) && Ee(e.op);
		case "replace": return K(e.sheet) && M(e.query, 32767) && M(e.by, 32767) && L(e, "opts", (e) => j(e) && B(e, "matchCase", "whole", "formulas") && Object.values(e).every(F)) && L(e, "at", (e) => j(e) && N(e.r, 0, 1048575) && N(e.c, 0, 16383));
		case "book": return De(e.op);
		case "revert": return Oe(e);
		case "comment": return H(e);
	}
	return !1;
}
var Ae = (e) => j(e) && [
	"x",
	"y",
	"w",
	"h"
].every((t) => P(e[t], -1e7, 1e7)) && L(e, "rot", (e) => P(e, -360, 360)) && L(e, "flipH", F) && L(e, "flipV", F);
function je(e) {
	if (!j(e)) return !1;
	let t = N(e.top, 0, 1e5);
	if (!L(e, "key", (e) => z(e, 200))) return !1;
	switch (e.op) {
		case "xfrm": return t && Ae(e.box);
		case "delete": return t;
		case "fill": return t && R(e.color);
		case "line": return t && L(e, "color", R) && L(e, "w", (e) => P(e, 0, 1e3)) && L(e, "dash", (e) => typeof e == "string" && /^[A-Za-z]{1,20}$/.test(e));
		case "order": return t && I(e.to, "front", "back", "forward", "backward");
		case "duplicate": return t && L(e, "dx", (e) => P(e, -1e7, 1e7)) && L(e, "dy", (e) => P(e, -1e7, 1e7));
		case "anchor": return N(e.sid, 0, 2 ** 31) && I(e.anchor, "t", "ctr", "b");
		case "bg": return R(e.color);
		case "insert": return typeof e.kind == "string" && /^[A-Za-z0-9]{1,32}$/.test(e.kind) && Ae(e.box) && L(e, "text", (e) => M(e, 1e6)) && L(e, "rid", (e) => z(e, 100));
	}
	return !1;
}
function Me(e) {
	return j(e) && B(e, "b", "i", "u", "strike", "sz", "color", "font", "hl", "baseline") && [
		"b",
		"i",
		"u",
		"strike"
	].every((t) => L(e, t, F)) && L(e, "sz", (e) => P(e, 1, 1e3)) && L(e, "color", R) && L(e, "hl", R) && L(e, "font", (e) => z(e, 100)) && L(e, "baseline", (e) => e === null || P(e, -100, 100));
}
function Ne(e) {
	return Array.isArray(e) && e.length <= 1e4 && e.every((e) => j(e) && B(e, "k", "algn", "lvl", "bullet", "lnPct", "runs") && L(e, "k", (e) => N(e, 0, 2 ** 31)) && L(e, "algn", (e) => I(e, "left", "center", "right", "justify")) && L(e, "lvl", (e) => N(e, 0, 8)) && L(e, "bullet", (e) => I(e, "none", "bullet", "number")) && L(e, "lnPct", (e) => P(e, 0, 100)) && Array.isArray(e.runs) && e.runs.length <= 1e4 && e.runs.every((e) => j(e) && B(e, "text", "src", "set", "fld") && M(e.text, 1e6) && L(e, "src", (e) => Array.isArray(e) && e.length === 2 && e.every((e) => N(e, 0, 2 ** 31))) && L(e, "set", Me) && L(e, "fld", F)));
}
function Pe(e) {
	if (!j(e)) return !1;
	switch (e.op) {
		case "add": return (e.after === null || K(e.after)) && L(e, "layout", (e) => I(e, "title", "content", "blank"));
		case "duplicate":
		case "delete": return K(e.path);
		case "move": return K(e.path) && N(e.to, 0, 1e5);
		case "hide": return K(e.path) && F(e.hidden);
	}
	return !1;
}
function Fe(e) {
	if (!j(e) || !z(e.id, 200)) return !1;
	switch (e.t) {
		case "comment": return H(e);
		case "text": return K(e.slide) && N(e.sid, 0, 2 ** 31) && Ne(e.paras);
		case "shapes": return K(e.slide) && Array.isArray(e.ops) && e.ops.length <= 1e4 && e.ops.every(je);
		case "image": return z(e.key, 200) && K(e.slide) && Se(e.bytes) && Ce(e.ext);
		case "slides": return Pe(e.op);
		case "revert": return Oe(e);
	}
	return !1;
}
// src/collab/xlsx-ops.ts
var q = /* @__PURE__ */ new Set([
	"insertRows",
	"deleteRows",
	"insertCols",
	"deleteCols"
]), J = (e) => e.t === "book" || e.t === "sheet" && q.has(e.op.op);
function Y(e, t, n) {
	if (n >= 0) return e >= t ? e + n : e;
	let r = -n;
	return e < t ? e : e < t + r ? null : e - r;
}
function X(e, t, n, r) {
	if (r >= 0) return [e >= n ? e + r : e, t >= n ? t + r : t];
	let i = -r;
	if (t < n) return [e, t];
	if (e >= n + i) return [e - i, t - i];
	let a = e < n ? e : n, o = t < n + i ? n - 1 : t - i;
	return o < a ? null : [a, o];
}
function Z(e, t, n, r) {
	let i = t === "row" ? X(e.r0, e.r1, n, r) : X(e.c0, e.c1, n, r);
	return i ? t === "row" ? {
		...e,
		r0: i[0],
		r1: i[1]
	} : {
		...e,
		c0: i[0],
		c1: i[1]
	} : null;
}
function Ie(e, t, n, r) {
	let i = (e, i, a) => a === t ? X(e, i, n, r) : [e, i];
	switch (e.op) {
		case "insertRows":
		case "insertCols": {
			if (e.op === "insertRows" != (t === "row")) return e;
			let i = r >= 0 ? e.at >= n ? e.at + r : e.at : e.at < n ? e.at : e.at < n - r ? n : e.at + r;
			return i === e.at ? e : {
				...e,
				at: i
			};
		}
		case "deleteRows":
		case "deleteCols": {
			if (e.op === "deleteRows" != (t === "row")) return e;
			let i = X(e.at, e.at + e.n - 1, n, r);
			return i ? {
				...e,
				at: i[0],
				n: i[1] - i[0] + 1
			} : null;
		}
		case "merge":
		case "unmerge":
		case "fill": {
			let i = Z(e.range, t, n, r);
			return i ? {
				...e,
				range: i
			} : null;
		}
		case "sort": {
			let i = Z(e.range, t, n, r);
			if (!i) return null;
			let a = t === "col" ? Y(e.col, n, r) : e.col;
			return a === null ? null : {
				...e,
				range: i,
				col: a
			};
		}
		case "hideRows":
		case "hideCols": {
			let t = i(e.a, e.b, e.op === "hideRows" ? "row" : "col");
			return t ? {
				...e,
				a: t[0],
				b: t[1]
			} : null;
		}
		case "colWidth": {
			let t = i(e.c0, e.c1, "col");
			return t ? {
				...e,
				c0: t[0],
				c1: t[1]
			} : null;
		}
		case "rowHeight": {
			let t = i(e.r0, e.r1, "row");
			return t ? {
				...e,
				r0: t[0],
				r1: t[1]
			} : null;
		}
		default: return e;
	}
}
function Le(e, t) {
	if (e.t === "comment") return Re(e, t);
	if (t.t === "book") return t.op.op === "delete" && "sheet" in e && e.sheet === t.op.path ? null : e;
	if (t.t !== "sheet" || !q.has(t.op.op) || !("sheet" in e) || e.sheet !== t.sheet) return e;
	let n = t.op, r = n.op.endsWith("Rows") ? "row" : "col", i = n.op.startsWith("insert") ? n.n : -n.n;
	switch (e.t) {
		case "set": {
			let t = [];
			for (let a of e.cells) {
				let e = Y(r === "row" ? a.r : a.c, n.at, i);
				e !== null && t.push(r === "row" ? {
					...a,
					r: e
				} : {
					...a,
					c: e
				});
			}
			return t.length ? {
				...e,
				cells: t
			} : null;
		}
		case "fmt": {
			let t = Z(e.range, r, n.at, i);
			return t ? {
				...e,
				range: t
			} : null;
		}
		case "sheet": {
			let t = Ie(e.op, r, n.at, i);
			return t === e.op ? e : t ? {
				...e,
				op: t
			} : null;
		}
		case "replace": {
			if (!e.at) return e;
			let t = Y(r === "row" ? e.at.r : e.at.c, n.at, i);
			return t === null ? null : {
				...e,
				at: r === "row" ? {
					...e.at,
					r: t
				} : {
					...e.at,
					c: t
				}
			};
		}
	}
	return e;
}
function Re(e, t) {
	let n = e.c?.at;
	if (!n || !("sheet" in n)) return e;
	if (t.t === "book") return t.op.op === "delete" && t.op.path === n.sheet ? null : e;
	if (t.t !== "sheet" || !q.has(t.op.op) || t.sheet !== n.sheet) return e;
	let r = t.op, i = r.op.endsWith("Rows"), a = Y(i ? n.r : n.c, r.at, r.op.startsWith("insert") ? r.n : -r.n);
	return a === null ? null : a === (i ? n.r : n.c) ? e : {
		...e,
		c: {
			...e.c,
			at: i ? {
				...n,
				r: a
			} : {
				...n,
				c: a
			}
		}
	};
}
var Q = {
	r0: 0,
	c0: 0,
	r1: 2 ** 53 - 1,
	c1: 2 ** 53 - 1
}, ze = (e) => e.t === "set" && e.cells.some((e) => e.input.includes("\n"));
function $(e) {
	switch (e.t) {
		case "set": {
			let t = Infinity, n = Infinity, r = -1, i = -1;
			for (let a of e.cells) t = Math.min(t, a.r), n = Math.min(n, a.c), r = Math.max(r, a.r), i = Math.max(i, a.c);
			return {
				sheet: e.sheet,
				range: ze(e) ? {
					...Q,
					r0: t,
					r1: r
				} : {
					r0: t,
					c0: n,
					r1: r,
					c1: i
				}
			};
		}
		case "fmt": return {
			sheet: e.sheet,
			range: e.range
		};
		case "replace": return {
			sheet: e.sheet,
			range: e.at ? {
				r0: e.at.r,
				c0: e.at.c,
				r1: e.at.r,
				c1: e.at.c
			} : Q
		};
		case "sheet": {
			let t = e.op;
			return "range" in t ? {
				sheet: e.sheet,
				range: t.range
			} : t.op === "hideRows" ? {
				sheet: e.sheet,
				range: {
					...Q,
					r0: t.a,
					r1: t.b
				}
			} : t.op === "hideCols" ? {
				sheet: e.sheet,
				range: {
					...Q,
					c0: t.a,
					c1: t.b
				}
			} : t.op === "colWidth" ? {
				sheet: e.sheet,
				range: {
					...Q,
					c0: t.c0,
					c1: t.c1
				}
			} : t.op === "rowHeight" ? {
				sheet: e.sheet,
				range: {
					...Q,
					r0: t.r0,
					r1: t.r1
				}
			} : {
				sheet: e.sheet,
				range: Q
			};
		}
		default: return null;
	}
}
var Be = (e, t) => e.r0 <= t.r1 && t.r0 <= e.r1 && e.c0 <= t.c1 && t.c0 <= e.c1;
function Ve(e, t) {
	if (t.some((e) => J(e) || e.t === "revert")) return !0;
	let n = new Set(e.flatMap((e) => e.t === "comment" ? [e.cid] : []));
	if (t.some((e) => e.t === "comment" && n.has(e.cid)) || e.some((e) => e.t === "revert" || J(e))) return !0;
	let r = (e) => e.t === "fmt" && e.patch.xf === void 0 && !e.patch.clear || ze(e);
	if (e.some(r) && t.some(r)) return !0;
	let i = t.map($);
	return e.some((e) => {
		let t = $(e);
		return !!t && i.some((e) => !!e && e.sheet === t.sheet && Be(t.range, e.range));
	});
}
export { v as A, c as C, te as D, _ as E, y as F, s as I, e as L, m as M, u as N, h as O, ee as P, t as R, o as S, i as T, se as _, we as a, C as b, xe as c, be as d, ye as f, b as g, me as h, Le as i, ne as j, g as k, ve as l, ce as m, Ve as n, Fe as o, k as p, J as r, ke as s, q as t, A as u, _e as v, p as w, ge as x, S as y };

//# sourceMappingURL=xlsx-ops-SYAv6V0f.js.map