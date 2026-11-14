
import { A as e, B as t, C as n, D as r, E as i, G as a, H as o, J as s, K as c, L as l, O as u, R as d, S as f, T as p, U as m, V as h, W as g, _, a as v, b as y, g as b, h as x, i as S, k as C, l as w, m as T, o as ee, p as E, t as D, v as O, w as te, x as ne, y as re, z as ie } from "./default-worker-DogNT09A.js";
import { A as ae, C as k, D as oe, E as se, M as ce, O as le, S as ue, T as de, _ as fe, b as pe, d as me, f as he, g as ge, h as _e, j as A, k as j, m as ve, p as M, t as N, v as P, w as F, x as ye, y as I } from "./collab-BVynXMqc.js";
import { L as be, _ as xe, d as Se, f as Ce, g as L } from "./xlsx-ops-SYAv6V0f.js";
import { Children as we, Fragment as Te, createContext as Ee, isValidElement as De, memo as R, useCallback as Oe, useContext as z, useEffect as B, useId as ke, useInsertionEffect as Ae, useLayoutEffect as je, useMemo as Me, useReducer as Ne, useRef as V, useState as H, useSyncExternalStore as Pe } from "react";
import { createPortal as Fe } from "react-dom";
import { Fragment as U, jsx as W, jsxs as G } from "react/jsx-runtime";
import { createRoot as Ie } from "react-dom/client";
// src/core/xlsx/formula/assist.ts
function Le(e) {
	try {
		return {
			toks: T(e),
			tail: e.length,
			openString: !1
		};
	} catch (t) {
		if (!(t instanceof E)) return {
			toks: [],
			tail: 0,
			openString: !1
		};
		let n = Math.max(0, Math.min(t.pos, e.length)), r = n > 0 ? Le(e.slice(0, n)) : {
			toks: [],
			tail: 0,
			openString: !1
		};
		return r.tail < n ? r : {
			toks: r.toks,
			tail: n,
			openString: t.message === "unterminated string"
		};
	}
}
var Re = (e) => e.startsWith("=") && e.length > 0, ze = /* @__PURE__ */ new Set([
	"(",
	",",
	";",
	"{"
]), Be = /* @__PURE__ */ new Set([
	")",
	",",
	";",
	"}"
]);
function Ve(e, t) {
	let n = {
		pointable: !1,
		refs: []
	};
	if (!Re(e)) return n;
	let r = e.slice(1), i = t - 1, { toks: a, tail: o } = Le(r);
	for (let e of a) e.t === "ref" && n.refs.push({
		s: e.s + 1,
		e: e.e + 1,
		text: r.slice(e.s, e.e),
		ref: e.ref
	});
	if (i < 0) return n;
	let s = i > o, c = [], l, u, d;
	for (let e = 0; e < a.length; e++) {
		let t = a[e];
		t.e <= i ? (t.t === "punc" && (t.v === "(" ? c.push({
			name: a[e - 1]?.t === "func" && a[e - 1].e === t.s ? a[e - 1].v : "",
			arg: 0
		}) : t.v === "{" ? c.push({
			name: "",
			arg: 0
		}) : t.v === ")" || t.v === "}" ? c.pop() : (t.v === "," || t.v === ";") && c.length && c[c.length - 1].arg++), t.t !== "ws" && (l = t)) : t.s < i ? u = t : !d && t.t !== "ws" && (d = t);
	}
	for (let e = c.length - 1; e >= 0; e--) if (c[e].name) {
		n.call = c[e];
		break;
	}
	if (s) return n;
	let f = u ?? (l && l.e === i ? l : void 0);
	if (f && (f.t === "name" || f.t === "func" || f.t === "ref" || f.t === "bool")) {
		let e = r.slice(f.s, i);
		if (!(f.t === "ref" && f.ref.sheet !== void 0 || f.t === "name" && f.sheet !== void 0) && /^[A-Za-z_][A-Za-z0-9_.]*$/.test(e)) {
			let t = f.t === "func" || r[f.e] === "(";
			n.word = {
				s: f.s + 1,
				e: f.e + 1,
				text: e,
				call: t
			};
		}
	}
	if (!u) {
		let e = !l || l.t === "punc" && ze.has(l.v) || l.t === "op" && l.v !== "%", t = !d || d.t === "punc" && Be.has(d.v) || d.t === "op" && d.v !== ":";
		n.pointable = e && t;
	}
	return n;
}
function K(e, t, n, r, i) {
	let a = i === void 0 ? "" : b(i) + "!";
	if (e > n && ([e, n] = [n, e]), t > r && ([t, r] = [r, t]), e === 0 && n >= 1048575) return `${a}${x(t)}:${x(r)}`;
	if (t === 0 && r >= 16383) return `${a}${e + 1}:${n + 1}`;
	let o = `${x(t)}${e + 1}`;
	return e === n && t === r ? a + o : `${a}${o}:${x(r)}${n + 1}`;
}
function He(e) {
	if (!Re(e)) return e;
	let t = e.slice(1), { toks: n, tail: r, openString: i } = Le(t);
	if (r < t.length && !i) return e;
	let a = 0, o = "", s = 0;
	for (let e of n) {
		if (e.t === "func" || e.t === "bool" || e.t === "ref" && e.ref.sheet === void 0) o += t.slice(s, e.s) + t.slice(e.s, e.e).toUpperCase(), s = e.e;
		else if (e.t === "ref") {
			let n = t.lastIndexOf("!", e.e);
			o += t.slice(s, n + 1) + t.slice(n + 1, e.e).toUpperCase(), s = e.e;
		}
		e.t === "punc" && (e.v === "(" ? a++ : e.v === ")" && (a = Math.max(0, a - 1)));
	}
	return o += t.slice(s), "=" + o + (i ? "\"" : "") + ")".repeat(a);
}
// src/core/xlsx/formula/catalog.ts
var Ue = {
	ABS: "number|Absolute value of a number.",
	AND: "logical1, [logical2], ...|TRUE if all arguments are TRUE.",
	AVERAGE: "number1, [number2], ...|Arithmetic mean of the arguments.",
	AVERAGEIF: "range, criteria, [average_range]|Average of cells that meet a condition.",
	AVERAGEIFS: "average_range, criteria_range1, criteria1, ...|Average of cells that meet multiple conditions.",
	CEILING: "number, significance|Rounds a number up to the nearest multiple of significance.",
	"CEILING.MATH": "number, [significance], [mode]|Rounds a number up to the nearest integer or multiple.",
	CHAR: "number|Character for a character code.",
	CHOOSE: "index_num, value1, [value2], ...|Picks a value from the list by position.",
	CODE: "text|Numeric code of the first character.",
	COLUMN: "[reference]|Column number of a reference.",
	COLUMNS: "array|Number of columns in a reference.",
	CONCAT: "text1, [text2], ...|Joins several text items into one.",
	CONCATENATE: "text1, [text2], ...|Joins several text items into one.",
	COUNT: "value1, [value2], ...|Counts cells that contain numbers.",
	COUNTA: "value1, [value2], ...|Counts cells that are not empty.",
	COUNTBLANK: "range|Counts empty cells in a range.",
	COUNTIF: "range, criteria|Counts cells that meet a condition.",
	COUNTIFS: "criteria_range1, criteria1, ...|Counts cells that meet multiple conditions.",
	DATE: "year, month, day|Date serial number from year, month and day.",
	DATEDIF: "start_date, end_date, unit|Difference between two dates in days, months or years.",
	DAY: "serial_number|Day of the month (1-31).",
	DAYS: "end_date, start_date|Number of days between two dates.",
	EDATE: "start_date, months|Date that is a number of months before or after a date.",
	EOMONTH: "start_date, months|Last day of the month, months before or after a date.",
	"ERROR.TYPE": "error_val|Number that corresponds to an error type.",
	EVEN: "number|Rounds up to the nearest even integer.",
	EXACT: "text1, text2|TRUE if two texts are exactly the same.",
	EXP: "number|e raised to the power of a number.",
	FACT: "number|Factorial of a number.",
	FALSE: "|The logical value FALSE.",
	FIND: "find_text, within_text, [start_num]|Position of a text inside another (case-sensitive).",
	FLOOR: "number, significance|Rounds a number down to the nearest multiple of significance.",
	"FLOOR.MATH": "number, [significance], [mode]|Rounds a number down to the nearest integer or multiple.",
	GCD: "number1, [number2], ...|Greatest common divisor.",
	HLOOKUP: "lookup_value, table_array, row_index_num, [range_lookup]|Looks up a value in the top row and returns a value from the same column.",
	HOUR: "serial_number|Hour of a time value (0-23).",
	HYPERLINK: "link_location, [friendly_name]|A link: the cell shows the friendly name, or else the address.",
	IF: "logical_test, [value_if_true], [value_if_false]|Returns one value if a condition is TRUE and another if FALSE.",
	IFERROR: "value, value_if_error|Returns value_if_error if the expression is an error.",
	IFNA: "value, value_if_na|Returns value_if_na if the expression is #N/A.",
	IFS: "logical_test1, value_if_true1, ...|Returns the value of the first TRUE condition.",
	INDEX: "array, row_num, [column_num]|Value at a given row and column of a range.",
	INDIRECT: "ref_text, [a1]|Reference given by a text string.",
	INT: "number|Rounds down to the nearest integer.",
	ISBLANK: "value|TRUE if the value is empty.",
	ISERR: "value|TRUE if the value is an error other than #N/A.",
	ISERROR: "value|TRUE if the value is any error.",
	ISEVEN: "number|TRUE if the number is even.",
	ISLOGICAL: "value|TRUE if the value is a logical value.",
	ISNA: "value|TRUE if the value is #N/A.",
	ISNONTEXT: "value|TRUE if the value is not text.",
	ISNUMBER: "value|TRUE if the value is a number.",
	ISODD: "number|TRUE if the number is odd.",
	ISTEXT: "value|TRUE if the value is text.",
	LARGE: "array, k|k-th largest value in a data set.",
	LCM: "number1, [number2], ...|Least common multiple.",
	LEFT: "text, [num_chars]|First characters of a text.",
	LEN: "text|Number of characters in a text.",
	LN: "number|Natural logarithm.",
	LOG: "number, [base]|Logarithm to a given base (default 10).",
	LOG10: "number|Base-10 logarithm.",
	LOOKUP: "lookup_value, lookup_vector, [result_vector]|Looks up a value in a one-row or one-column range.",
	LOWER: "text|Converts text to lowercase.",
	MATCH: "lookup_value, lookup_array, [match_type]|Relative position of a value in a range.",
	MAX: "number1, [number2], ...|Largest value.",
	MAXIFS: "max_range, criteria_range1, criteria1, ...|Largest value among cells that meet conditions.",
	MEDIAN: "number1, [number2], ...|Median of the numbers.",
	MID: "text, start_num, num_chars|Characters from the middle of a text.",
	MIN: "number1, [number2], ...|Smallest value.",
	MINIFS: "min_range, criteria_range1, criteria1, ...|Smallest value among cells that meet conditions.",
	MINUTE: "serial_number|Minute of a time value (0-59).",
	MOD: "number, divisor|Remainder after division.",
	MODE: "number1, [number2], ...|Most frequent value.",
	"MODE.SNGL": "number1, [number2], ...|Most frequent value.",
	MONTH: "serial_number|Month of a date (1-12).",
	N: "value|Value converted to a number.",
	NA: "|The error value #N/A.",
	NETWORKDAYS: "start_date, end_date, [holidays]|Number of working days between two dates.",
	NOT: "logical|Reverses a logical value.",
	NOW: "|Current date and time.",
	ODD: "number|Rounds up to the nearest odd integer.",
	OFFSET: "reference, rows, cols, [height], [width]|Reference offset from a starting reference.",
	OR: "logical1, [logical2], ...|TRUE if any argument is TRUE.",
	PI: "|The value of pi.",
	POWER: "number, power|A number raised to a power.",
	PRODUCT: "number1, [number2], ...|Multiplies all the arguments.",
	PROPER: "text|Capitalizes the first letter of each word.",
	RAND: "|Random number between 0 and 1.",
	RANDBETWEEN: "bottom, top|Random integer between two numbers.",
	RANK: "number, ref, [order]|Rank of a number in a list.",
	"RANK.EQ": "number, ref, [order]|Rank of a number in a list.",
	REPLACE: "old_text, start_num, num_chars, new_text|Replaces part of a text by position.",
	REPT: "text, number_times|Repeats a text a number of times.",
	RIGHT: "text, [num_chars]|Last characters of a text.",
	ROUND: "number, num_digits|Rounds a number to a number of digits.",
	ROUNDDOWN: "number, num_digits|Rounds a number down, toward zero.",
	ROUNDUP: "number, num_digits|Rounds a number up, away from zero.",
	ROW: "[reference]|Row number of a reference.",
	ROWS: "array|Number of rows in a reference.",
	SEARCH: "find_text, within_text, [start_num]|Position of a text inside another (not case-sensitive).",
	SECOND: "serial_number|Second of a time value (0-59).",
	SIGN: "number|Sign of a number: 1, 0 or -1.",
	SMALL: "array, k|k-th smallest value in a data set.",
	SQRT: "number|Square root.",
	STDEV: "number1, [number2], ...|Standard deviation of a sample.",
	"STDEV.P": "number1, [number2], ...|Standard deviation of a population.",
	"STDEV.S": "number1, [number2], ...|Standard deviation of a sample.",
	STDEVP: "number1, [number2], ...|Standard deviation of a population.",
	SUBSTITUTE: "text, old_text, new_text, [instance_num]|Replaces existing text with new text.",
	SUM: "number1, [number2], ...|Adds all the numbers.",
	SUMIF: "range, criteria, [sum_range]|Adds the cells that meet a condition.",
	SUMIFS: "sum_range, criteria_range1, criteria1, ...|Adds the cells that meet multiple conditions.",
	SUMPRODUCT: "array1, [array2], ...|Sum of the products of corresponding items.",
	SWITCH: "expression, value1, result1, [default_or_value2], ...|Matches an expression against a list of values.",
	T: "value|Text of a value, or empty text.",
	TEXT: "value, format_text|Formats a number as text.",
	TEXTJOIN: "delimiter, ignore_empty, text1, ...|Joins texts with a delimiter.",
	TIME: "hour, minute, second|Time value from hour, minute and second.",
	TODAY: "|Current date.",
	TRIM: "text|Removes extra spaces from text.",
	TRUE: "|The logical value TRUE.",
	TRUNC: "number, [num_digits]|Truncates a number to an integer or number of digits.",
	UPPER: "text|Converts text to uppercase.",
	VALUE: "text|Converts text to a number.",
	VAR: "number1, [number2], ...|Variance of a sample.",
	"VAR.P": "number1, [number2], ...|Variance of a population.",
	"VAR.S": "number1, [number2], ...|Variance of a sample.",
	VARP: "number1, [number2], ...|Variance of a population.",
	VLOOKUP: "lookup_value, table_array, col_index_num, [range_lookup]|Looks up a value in the first column and returns a value from the same row.",
	WEEKDAY: "serial_number, [return_type]|Day of the week of a date.",
	XLOOKUP: "lookup_value, lookup_array, return_array, [if_not_found], [match_mode], [search_mode]|Searches a range and returns the matching item from another range.",
	XOR: "logical1, [logical2], ...|TRUE if an odd number of arguments are TRUE.",
	YEAR: "serial_number|Year of a date."
}, We = null;
function Ge() {
	return We ||= Object.keys(Ue).sort().map((e) => {
		let [t, n] = Ue[e].split("|"), r = t ? t.split(", ") : [], i = r[r.length - 1] === "...";
		return {
			name: e,
			args: i ? r.slice(0, -1) : r,
			variadic: i,
			desc: n
		};
	}), We;
}
function Ke(e) {
	let t = e.toUpperCase();
	return Ge().find((e) => e.name === t);
}
function qe(e, t = 10) {
	let n = e.toUpperCase();
	return n ? Ge().filter((e) => e.name.startsWith(n)).slice(0, t) : [];
}
function Je(e, t) {
	if (t < e.args.length) return t;
	if (!e.variadic) return -1;
	let n = e.args.length, r = /1$/.test(e.args[n - 1] ?? "") && /1$/.test(e.args[n - 2] ?? "") ? 2 : 1, i = n - r;
	return i + (t - i) % r;
}
// src/react/common/hooks.ts
var Ye = typeof window > "u" ? B : je, Xe = "(prefers-color-scheme: dark)", Ze = () => typeof matchMedia == "function" && matchMedia(Xe).matches;
function q(e = "light") {
	let [t, n] = H(() => e === "auto" && Ze());
	return B(() => {
		if (e !== "auto" || typeof matchMedia != "function") return;
		let t = matchMedia(Xe), r = () => n(t.matches);
		return r(), t.addEventListener("change", r), () => t.removeEventListener("change", r);
	}, [e]), e === "dark" || e === "auto" && t;
}
function Qe() {
	let [e, t] = Ne((e) => e + 1, 0);
	return [e, t];
}
function $e() {
	let e = V(null), [t, n] = H({
		w: 0,
		h: 0
	});
	return Ye(() => {
		let t = e.current;
		if (!t) return;
		let r = () => {
			let e = t.clientWidth, r = t.clientHeight;
			n((t) => t.w === e && t.h === r ? t : {
				w: e,
				h: r
			});
		};
		r();
		let i = new ResizeObserver(r);
		return i.observe(t), () => i.disconnect();
	}, []), [e, t];
}
function et(e) {
	let [t, n] = H({
		x: 0,
		y: 0
	}), [r, i] = H(null);
	return Ye(() => {
		e.current !== r && i(e.current);
	}), B(() => {
		if (!r) return;
		let e = 0, t = () => n((e) => e.x === r.scrollLeft && e.y === r.scrollTop ? e : {
			x: r.scrollLeft,
			y: r.scrollTop
		}), i = () => {
			e ||= requestAnimationFrame(() => {
				e = 0, t();
			});
		};
		return t(), r.addEventListener("scroll", i, { passive: !0 }), () => {
			r.removeEventListener("scroll", i), cancelAnimationFrame(e);
		};
	}, [r]), t;
}
function tt(e, t, n = !0) {
	let [r, i] = H(null);
	return B(() => {
		if (!t || !n) return;
		if (!s(t)) {
			i("unsupported");
			return;
		}
		let r = !0;
		return e.mediaUrl(t).then((e) => r && i(e), () => r && i("unsupported")), () => {
			r = !1;
		};
	}, [
		e,
		t,
		n
	]), r;
}
function nt(e, t) {
	let n = 0, r = e.length - 1, i = 0;
	for (; n <= r;) {
		let a = n + r >> 1;
		e[a] <= t ? (i = a, n = a + 1) : r = a - 1;
	}
	return i;
}
function rt(e) {
	let t = e;
	if (!t || t.nodeType !== 1) return !1;
	let n = t.tagName;
	return n === "TEXTAREA" || n === "SELECT" ? !0 : n === "INPUT" ? !/^(button|checkbox|radio|submit|reset|range|color|file|image)$/i.test(t.type) : !!t.isContentEditable;
}
function it(e) {
	if (!e) return !1;
	let t = e.ownerDocument, n = t.activeElement, r = e.getRootNode(), i = typeof ShadowRoot < "u" && r instanceof ShadowRoot ? r.host : null, a = e.closest(".de-root") ?? e;
	return n && n !== t.body && n !== i && !a.contains(n) ? !1 : (e.focus({ preventScroll: !0 }), !0);
}
// src/react/edit/Toolbar.tsx
var at = /* @__PURE__ */ W("path", {
	d: "M4 4h16v16H4zM12 4v16M4 12h16",
	strokeDasharray: "1.2 2.6",
	opacity: .5,
	strokeWidth: 1.4
}), ot = {
	undo: /* @__PURE__ */ W("path", { d: "M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11" }),
	redo: /* @__PURE__ */ W("path", { d: "m15 14 5-5-5-5M20 9H9.5a5.5 5.5 0 0 0 0 11H13" }),
	bold: /* @__PURE__ */ W("path", {
		d: "M7 5h6a3.5 3.5 0 0 1 0 7H7zM7 12h7a3.5 3.5 0 0 1 0 7H7z",
		strokeWidth: 2.4
	}),
	italic: /* @__PURE__ */ W("path", {
		d: "M14 5h-4m4 14h-4m3-14-2 14",
		strokeWidth: 2.2
	}),
	underline: /* @__PURE__ */ W("path", { d: "M7 4v7a5 5 0 0 0 10 0V4M5 20h14" }),
	strike: /* @__PURE__ */ W("path", { d: "M16 6.5C15.3 5 13.8 4 12 4c-2.5 0-4 1.3-4 3 0 4 8 2.5 8 7 0 2-1.8 3.5-4.2 3.5-2 0-3.6-1-4.3-2.5M4 12h16" }),
	color: /* @__PURE__ */ W("path", { d: "m6 16 6-12 6 12M8.3 11.5h7.4" }),
	highlight: /* @__PURE__ */ W("path", { d: "m9 11-5 5v3h3l5-5M14.5 5.5l4 4L12 16l-4-4zM15 4l5 5" }),
	fill: /* @__PURE__ */ W("path", { d: "m19 11-8-8-8.5 8.5a2 2 0 0 0 0 2.8l5.7 5.7a2 2 0 0 0 2.8 0zM5 2l5 5M21 15s2 2.5 2 4a2 2 0 0 1-4 0c0-1.5 2-4 2-4" }),
	alignLeft: /* @__PURE__ */ W("path", { d: "M4 6h16M4 10h10M4 14h16M4 18h10" }),
	alignCenter: /* @__PURE__ */ W("path", { d: "M4 6h16M7 10h10M4 14h16M7 18h10" }),
	alignRight: /* @__PURE__ */ W("path", { d: "M4 6h16M10 10h10M4 14h16M10 18h10" }),
	justify: /* @__PURE__ */ W("path", { d: "M4 6h16M4 10h16M4 14h16M4 18h16" }),
	bullets: /* @__PURE__ */ W("path", {
		d: "M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01",
		strokeWidth: 2.2
	}),
	numbers: /* @__PURE__ */ W("path", { d: "M10 6h10M10 12h10M10 18h10M4 4.5h1.5v4M4 8.5h3M4 14.5c0-1 2.5-1.2 2.5.3 0 1.2-2.5 1.8-2.5 3.2h2.8" }),
	indent: /* @__PURE__ */ W("path", { d: "M4 5h16M11 10h9M11 14h9M4 19h16M4 9l3 3-3 3" }),
	outdent: /* @__PURE__ */ W("path", { d: "M4 5h16M11 10h9M11 14h9M4 19h16M7 9l-3 3 3 3" }),
	clear: /* @__PURE__ */ W("path", { d: "M5 5h10M10 5l-3 14M14 14l5 5m0-5-5 5" }),
	search: /* @__PURE__ */ W("path", { d: "m20 20-4.2-4.2M17 11a6 6 0 1 1-12 0 6 6 0 0 1 12 0" }),
	save: /* @__PURE__ */ W("path", { d: "M12 4v11m-4.5-4.5L12 15l4.5-4.5M5 19h14" }),
	wrap: /* @__PURE__ */ W("path", { d: "M4 6h16M4 12h13a3 3 0 0 1 0 6h-4m2-2-2 2 2 2M4 18h5" }),
	edit: /* @__PURE__ */ W("path", { d: "m4 20 1-4L16 5l3 3L8 19zM14 7l3 3" }),
	view: /* @__PURE__ */ W("path", { d: "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12m10 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6" }),
	close: /* @__PURE__ */ W("path", { d: "M6 6l12 12M18 6 6 18" }),
	image: /* @__PURE__ */ W("path", { d: "M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4M15.5 9.5h.01" }),
	table: /* @__PURE__ */ W("path", { d: "M4 5h16v14H4zM4 10h16M4 15h16M10 5v14M15 5v14" }),
	link: /* @__PURE__ */ W("path", { d: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" }),
	headerFooter: /* @__PURE__ */ W("path", {
		d: "M6 3h12v18H6zM8 6h8M8 18h8M12 16.5v3",
		strokeDasharray: "0"
	}),
	track: /* @__PURE__ */ W("path", { d: "M4 20h4L19 9l-4-4L4 16zM13 7l4 4M14 20h6" }),
	review: /* @__PURE__ */ W("path", { d: "M4 5h16v11H9l-5 4zM8 10l2 2 4-4" }),
	pageSetup: /* @__PURE__ */ W("path", { d: "M6 3h12v18H6zM6 7h12M10 3v18M13 11h3M13 14h3M13 17h2" }),
	pagebreak: /* @__PURE__ */ W("path", { d: "M5 4v5h14V4M5 20v-5h14v5M3 12h2m3 0h2m3 0h2m3 0h3" }),
	sup: /* @__PURE__ */ W("path", { d: "m4 8 8 10m0-10L4 18M16 4h4l-4 5h4" }),
	sub: /* @__PURE__ */ W("path", { d: "m4 6 8 10m0-10L4 16M16 15h4l-4 5h4" }),
	lineSpacing: /* @__PURE__ */ W("path", { d: "M10 6h10M10 12h10M10 18h10M5 4v16M3 6l2-2 2 2M3 18l2 2 2-2" }),
	plus: /* @__PURE__ */ W("path", { d: "M12 5v14M5 12h14" }),
	minus: /* @__PURE__ */ W("path", { d: "M5 12h14" }),
	fit: /* @__PURE__ */ W("path", { d: "M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" }),
	shape: /* @__PURE__ */ W("path", { d: "M4 4h9v9H4zM17 11a4 4 0 1 1 0 8 4 4 0 0 1 0-8" }),
	textbox: /* @__PURE__ */ W("path", { d: "M4 5h16v14H4zM8 9h8M12 9v7" }),
	slideAdd: /* @__PURE__ */ W("path", { d: "M3 6h14v12H3zM20 8v6M17 11h6" }),
	copy: /* @__PURE__ */ W("path", { d: "M8 8h12v12H8zM4 16V4h12" }),
	trash: /* @__PURE__ */ W("path", { d: "M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" }),
	play: /* @__PURE__ */ W("path", { d: "M7 4l13 8-13 8z" }),
	front: /* @__PURE__ */ W("path", { d: "M8 8h12v12H8zM4 4h10v3M4 4v10h3" }),
	back: /* @__PURE__ */ W("path", { d: "M4 4h12v12H4zM20 8v12H8v-3" }),
	merge: /* @__PURE__ */ W("path", { d: "M4 5h16v14H4zM9 12H4m16 0h-5m-6-3 3 3-3 3m6-6-3 3 3 3" }),
	borders: /* @__PURE__ */ W("path", {
		d: "M4 4h16v16H4zM12 4v16M4 12h16",
		strokeDasharray: "2 2"
	}),
	freeze: /* @__PURE__ */ W("path", { d: "M4 4h16v16H4zM4 9h16M9 4v16" }),
	sum: /* @__PURE__ */ W("path", { d: "M17 5H7l6 7-6 7h10" }),
	rowAdd: /* @__PURE__ */ W("path", { d: "M4 4h16v6H4zM12 14v6M9 17h6" }),
	colAdd: /* @__PURE__ */ W("path", { d: "M4 4h6v16H4zM14 12h6M17 9v6" }),
	sort: /* @__PURE__ */ W("path", { d: "M7 4v16M4 17l3 3 3-3M14 6h6M14 12h4M14 18h2" }),
	up: /* @__PURE__ */ W("path", { d: "m6 15 6-6 6 6" }),
	down: /* @__PURE__ */ W("path", { d: "m6 9 6 6 6-6" }),
	chevron: /* @__PURE__ */ W("path", { d: "m7 10 5 5 5-5" }),
	lineWeight: /* @__PURE__ */ G(U, { children: [
		/* @__PURE__ */ W("path", {
			d: "M4 6h16",
			strokeWidth: 1
		}),
		/* @__PURE__ */ W("path", {
			d: "M4 11h16",
			strokeWidth: 2.2
		}),
		/* @__PURE__ */ W("path", {
			d: "M4 17.5h16",
			strokeWidth: 3.6
		})
	] }),
	rotate: /* @__PURE__ */ W("path", { d: "M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7" }),
	rotateCcw: /* @__PURE__ */ W("path", { d: "M4 11a8 8 0 1 1 2.3 5.7M4 4v7h7" }),
	flipH: /* @__PURE__ */ W("path", { d: "M12 3v18M9 7 4 17h5zM15 7l5 10h-5z" }),
	flipV: /* @__PURE__ */ W("path", { d: "M3 12h18M7 9 17 4v5zM7 15l10 5v-5z" }),
	alignObj: /* @__PURE__ */ W("path", { d: "M4 3v18M8 7h12v4H8zM8 14h7v4H8z" }),
	currency: /* @__PURE__ */ W("path", { d: "M12 3v18M16.5 7.5C16 5.9 14.3 5 12 5c-2.6 0-4.5 1.3-4.5 3.3 0 4.7 9 2.6 9 7.4 0 2-1.9 3.3-4.5 3.3-2.4 0-4.2-1-4.7-2.8" }),
	vTop: /* @__PURE__ */ W("path", { d: "M5 4h14M12 20V8M8.5 11.5 12 8l3.5 3.5" }),
	vMiddle: /* @__PURE__ */ W("path", { d: "M5 12h14M12 3v6M9.5 6.5 12 9l2.5-2.5M12 21v-6M9.5 17.5 12 15l2.5 2.5" }),
	vBottom: /* @__PURE__ */ W("path", { d: "M5 20h14M12 4v12M8.5 12.5 12 16l3.5-3.5" }),
	rotNone: /* @__PURE__ */ W("path", { d: "M5 17h14M7 14l3-8 3 8M8 11.5h4" }),
	rotUp: /* @__PURE__ */ W("path", { d: "M5 19h14M6 15l9.5-9.5M9 6.5l4.5 7.5M8 10l4-.5" }),
	rotDown: /* @__PURE__ */ W("path", { d: "M5 5h14M6 9l9.5 9.5M9 17.5l4.5-7.5M8 14l4 .5" }),
	rotStack: /* @__PURE__ */ W("path", {
		d: "M9 4l2 5 2-5M9.6 6.5h2.8M9 11h4M11 11v4M9 15h4M9 17h3a1.5 1.5 0 0 1 0 3H9z",
		strokeWidth: 1.5
	}),
	rotUp90: /* @__PURE__ */ W("path", { d: "M19 5v14M15 18l-8-3 8-3M12.5 13v4M7 7l2-2 2 2M9 5v6" }),
	rotDown90: /* @__PURE__ */ W("path", { d: "M19 5v14M7 6l8 3-8 3M9.5 11V7M13 17l-2 2-2-2M11 19v-6" }),
	sortAZ: /* @__PURE__ */ W("path", { d: "M7 4v16M4 17l3 3 3-3M13 11l2.5-7 2.5 7M13.7 9h3.6M13 14h5l-5 6h5" }),
	sortZA: /* @__PURE__ */ W("path", { d: "M7 4v16M4 17l3 3 3-3M13 4h5l-5 6h5M13 20l2.5-7 2.5 7M13.7 18h3.6" }),
	gridlines: /* @__PURE__ */ W("path", { d: "M4 4h16v16H4zM4 9.3h16M4 14.6h16M9.3 4v16M14.6 4v16" }),
	lineStyle: /* @__PURE__ */ W("path", {
		d: "M4 6h16M4 12h16M4 18h3M10 18h4M17 18h3",
		strokeWidth: 2
	}),
	paint: /* @__PURE__ */ W("path", { d: "M5 4h11v5H5zM16 6.5h3v5l-7 1.5v3M11 16h2v5h-2z" }),
	styleMatch: /* @__PURE__ */ W("path", { d: "m3 18 4.5-12L12 18M4.7 14h5.6M21 9.5a4 4 0 0 0-7-1.8M14 5v3h3M14 14.5a4 4 0 0 0 7 1.8M21 19v-3h-3" }),
	omega: /* @__PURE__ */ W("path", { d: "M5 19h4v-2.5A6.5 6.5 0 1 1 15 16.5V19h4" }),
	outline: /* @__PURE__ */ W("path", {
		d: "M4 6h.01M4 12h.01M4 18h.01M8 6h12M11 12h9M11 18h9",
		strokeWidth: 2
	}),
	imgOrig: /* @__PURE__ */ W("path", { d: "M4 5h16v14H4zM8 15V9l-1.5 1.5M12 10h.01M12 14h.01M16.5 15V9L15 10.5" }),
	imgReplace: /* @__PURE__ */ W("path", { d: "M4 5h10v8H4zM4 11l3-3 3 3 2-2 2 2M14 19h6v-6M20 19l-5-5M7 16v3h4" }),
	alt: /* @__PURE__ */ W("path", { d: "M4 5h16v14H4zM7.5 15l2.5-6 2.5 6M8.3 13h3.4M15 9v6h2.5" }),
	cut: /* @__PURE__ */ W("path", { d: "M6 6a2.5 2.5 0 1 0 0 .01M6 18a2.5 2.5 0 1 0 0 .01M8 7.5 19 18M8 16.5 19 6" }),
	paste: /* @__PURE__ */ W("path", { d: "M9 4h6v3H9zM15 5h3v15H6V5h3" }),
	pastePlain: /* @__PURE__ */ W("path", { d: "M9 4h6v3H9zM15 5h3v15H6V5h3M9 11h6M12 11v6" }),
	external: /* @__PURE__ */ W("path", { d: "M14 4h6v6M20 4l-9 9M18 14v6H4V6h6" }),
	unlink: /* @__PURE__ */ W("path", { d: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1M3 3l18 18" }),
	selectAll: /* @__PURE__ */ W("path", { d: "M4 4h3M10 4h4M17 4h3v3M20 10v4M20 17v3h-3M14 20h-4M7 20H4v-3M4 14v-4M4 7V4M8 8h8v8H8z" }),
	hideShow: /* @__PURE__ */ W("path", { d: "M3 3l18 18M10.6 6.1A10 10 0 0 1 12 6c6.5 0 10 6 10 6a17 17 0 0 1-3.1 3.8M6.6 7.6C3.8 9.3 2 12 2 12s3.5 6 10 6c1.6 0 3-.4 4.3-1" }),
	percent: /* @__PURE__ */ W("path", { d: "M19 5 5 19M7.5 9.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4M16.5 18.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4" }),
	decLess: /* @__PURE__ */ W("path", {
		d: "M3.5 16h.01M8 9.5a2.5 3.5 0 1 1 0 7 2.5 3.5 0 0 1 0-7M21 19h-7m0 0 2-2m-2 2 2 2",
		strokeWidth: 1.7
	}),
	decMore: /* @__PURE__ */ W("path", {
		d: "M3.5 16h.01M8 9.5a2.5 3.5 0 1 1 0 7 2.5 3.5 0 0 1 0-7M14.5 9.5a2 3 0 1 1 0 6 2 3 0 0 1 0-6M13 19h8m0 0-2-2m2 2-2 2",
		strokeWidth: 1.7
	}),
	check: /* @__PURE__ */ W("path", {
		d: "m5 12.5 4.5 4.5L19 7.5",
		strokeWidth: 2.2
	}),
	more: /* @__PURE__ */ W("path", {
		d: "M12 5.5h.01M12 12h.01M12 18.5h.01",
		strokeWidth: 3.2
	}),
	bAll: /* @__PURE__ */ W("path", { d: "M4 4h16v16H4zM12 4v16M4 12h16" }),
	bOuter: /* @__PURE__ */ G(U, { children: [at, /* @__PURE__ */ W("path", { d: "M4 4h16v16H4z" })] }),
	bInner: /* @__PURE__ */ G(U, { children: [at, /* @__PURE__ */ W("path", { d: "M12 4v16M4 12h16" })] }),
	bTop: /* @__PURE__ */ G(U, { children: [at, /* @__PURE__ */ W("path", {
		d: "M4 4h16",
		strokeWidth: 2.2
	})] }),
	bBottom: /* @__PURE__ */ G(U, { children: [at, /* @__PURE__ */ W("path", {
		d: "M4 20h16",
		strokeWidth: 2.2
	})] }),
	bLeft: /* @__PURE__ */ G(U, { children: [at, /* @__PURE__ */ W("path", {
		d: "M4 4v16",
		strokeWidth: 2.2
	})] }),
	bRight: /* @__PURE__ */ G(U, { children: [at, /* @__PURE__ */ W("path", {
		d: "M20 4v16",
		strokeWidth: 2.2
	})] }),
	bNone: at,
	rect: /* @__PURE__ */ W("path", { d: "M4 6h16v12H4z" }),
	roundRect: /* @__PURE__ */ W("path", { d: "M8 6h8a4 4 0 0 1 4 4v4a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4v-4a4 4 0 0 1 4-4" }),
	ellipse: /* @__PURE__ */ W("path", { d: "M12 6c4.4 0 8 2.7 8 6s-3.6 6-8 6-8-2.7-8-6 3.6-6 8-6" }),
	triangle: /* @__PURE__ */ W("path", { d: "M12 5l8 14H4z" }),
	arrow: /* @__PURE__ */ W("path", { d: "M4 10h9V6l7 6-7 6v-4H4z" }),
	star: /* @__PURE__ */ W("path", { d: "m12 4 2.4 5 5.6.7-4.1 3.8 1.1 5.5-5-2.8-5 2.8 1.1-5.5L4 9.7 9.6 9z" }),
	line: /* @__PURE__ */ W("path", { d: "M5 19 19 5" }),
	rowAbove: /* @__PURE__ */ W("path", { d: "M4 12h16v8H4zM12 3v6M9 6h6" }),
	rowBelow: /* @__PURE__ */ W("path", { d: "M4 4h16v8H4zM12 15v6M9 18h6" }),
	colLeft: /* @__PURE__ */ W("path", { d: "M12 4h8v16h-8zM3 12h6M6 9v6" }),
	colRight: /* @__PURE__ */ W("path", { d: "M4 4h8v16H4zM15 12h6M18 9v6" }),
	delRow: /* @__PURE__ */ W("path", { d: "M4 8h16v8H4zM9 10.5l6 3m0-3-6 3" }),
	delCol: /* @__PURE__ */ W("path", { d: "M8 4h8v16H8zM10.5 9l3 6m0-6-3 6" }),
	hide: /* @__PURE__ */ W("path", { d: "M3 3l18 18M10.6 6.1A10 10 0 0 1 12 6c6.5 0 10 6 10 6a17 17 0 0 1-3.1 3.8M6.6 7.6C3.8 9.3 2 12 2 12s3.5 6 10 6c1.6 0 3-.4 4.3-1M9.9 9.9a3 3 0 0 0 4.2 4.2" }),
	file: /* @__PURE__ */ W("path", { d: "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5" }),
	open: /* @__PURE__ */ W("path", { d: "M4 19V6a1 1 0 0 1 1-1h4l2 2h7a1 1 0 0 1 1 1v2M4 19l2.6-7.2a1 1 0 0 1 .9-.8H20a1 1 0 0 1 1 1.3L18.6 19z" }),
	print: /* @__PURE__ */ W("path", { d: "M7 9V4h10v5M7 17H5a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-2M7 14h10v6H7z" }),
	pdf: /* @__PURE__ */ W("path", {
		d: "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M8.5 16.5v-4h1.2a1.2 1.2 0 0 1 0 2.4H8.5M13 12.5v4h.8a1.6 1.6 0 0 0 1.6-1.6v-.8a1.6 1.6 0 0 0-1.6-1.6z",
		strokeWidth: 1.5
	}),
	html: /* @__PURE__ */ W("path", { d: "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M10 12l-2 2.5 2 2.5M14 12l2 2.5-2 2.5" }),
	code: /* @__PURE__ */ W("path", { d: "m8 7-5 5 5 5M16 7l5 5-5 5M14 4l-4 16" }),
	doc: /* @__PURE__ */ W("path", { d: "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M9 13h6M9 17h4" }),
	slides: /* @__PURE__ */ W("path", { d: "M4 5h16v11H4zM12 16v4M8 20h8" }),
	info: /* @__PURE__ */ W("path", { d: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v5M12 8h.01" }),
	comment: /* @__PURE__ */ W("path", { d: "M5 5h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-8l-4 3.5V16H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z" }),
	commentAdd: /* @__PURE__ */ W("path", { d: "M5 5h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-8l-4 3.5V16H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM12 8v5M9.5 10.5h5" })
};
function J({ name: e, size: t = 18 }) {
	return /* @__PURE__ */ W("svg", {
		width: t,
		height: t,
		viewBox: "0 0 24 24",
		fill: "none",
		stroke: "currentColor",
		strokeWidth: 1.8,
		strokeLinecap: "round",
		strokeLinejoin: "round",
		"aria-hidden": !0,
		children: ot[e]
	});
}
var st = (e) => e.preventDefault();
function ct(e) {
	let t = V(null), [n, r] = H(0);
	return je(() => {
		let e = t.current;
		if (!e) return;
		let n = e.getBoundingClientRect(), i = document.documentElement.clientWidth;
		n.right > i - 8 ? r(-Math.min(n.left - 8, n.right - i + 8)) : n.left < 8 && r(8 - n.left);
	}, []), /* @__PURE__ */ W("div", {
		ref: t,
		className: e.className ?? "de-tb-pop",
		style: n ? { transform: `translateX(${n}px)` } : void 0,
		onMouseDown: e.onMouseDown,
		children: e.children
	});
}
function lt(e, t, n) {
	let r = V(n);
	r.current = n, B(() => {
		if (!t) return;
		let n = (t) => {
			let n = e.current;
			n && !t.composedPath().includes(n) && r.current();
		};
		return window.addEventListener("mousedown", n, !0), () => window.removeEventListener("mousedown", n, !0);
	}, [t, e]);
}
function Y(e) {
	return /* @__PURE__ */ W("button", {
		type: "button",
		className: e.active ? "de-tb de-tb-on" : "de-tb",
		title: e.title,
		"aria-label": e.title,
		"aria-pressed": e.active,
		disabled: e.disabled,
		onMouseDown: st,
		onClick: e.onClick,
		style: e.wide ? {
			width: "auto",
			padding: "0 8px"
		} : void 0,
		children: e.icon ? /* @__PURE__ */ W(J, { name: e.icon }) : e.label
	});
}
var X = () => /* @__PURE__ */ W("span", { className: "de-tb-sep" });
function Z(e) {
	let { options: t } = e, [n, r] = H(!1), [i, a] = H(-1), [o, s] = H(0), c = V(null), l = V(null), u = V({
		text: "",
		at: 0
	}), d = e.value !== void 0, f = d ? t.findIndex((t) => t.value === e.value) : -1, p = f >= 0 ? t[f] : void 0;
	lt(c, n, () => r(!1));
	let m = (t) => {
		t && !t.disabled && (r(!1), e.onChange(t.value));
	}, h = () => {
		a(f >= 0 ? f : t.findIndex((e) => !e.disabled)), s(0), r(!0);
	};
	B(() => {
		if (!n) return;
		let e = (e) => {
			let n = t.length, o = (e, r) => {
				let i = e;
				for (let e = 0; e < n; e++) if (i = (i + r + n) % n, !t[i].disabled) return i;
				return e;
			};
			if (e.key === "ArrowDown") a((e) => o(e, 1));
			else if (e.key === "ArrowUp") a((e) => o(e < 0 ? 0 : e, -1));
			else if (e.key === "Home") a(o(-1, 1));
			else if (e.key === "End") a(o(0, -1));
			else if (e.key === "Enter" || e.key === " " && !u.current.text) m(t[i]);
			else if (e.key === "Escape") r(!1);
			else if (e.key === "Tab") return r(!1);
			else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
				let n = u.current;
				n.text = (Date.now() - n.at < 700 ? n.text : "") + e.key.toLowerCase(), n.at = Date.now();
				let r = t.findIndex((e) => !e.disabled && e.label.toLowerCase().startsWith(n.text));
				r >= 0 && a(r);
			} else return;
			e.preventDefault(), e.stopPropagation();
		};
		return window.addEventListener("keydown", e, !0), () => window.removeEventListener("keydown", e, !0);
	}, [
		n,
		i,
		t
	]), je(() => {
		let e = l.current;
		if (!n || !e) return;
		let t = e.getBoundingClientRect(), r = document.documentElement.clientWidth;
		t.right > r - 8 ? s((e) => e - (t.right - r + 8)) : t.left < 8 && s((e) => e + (8 - t.left));
		let i = e.closest(".de-root"), a = Math.min(document.documentElement.clientHeight, i ? i.getBoundingClientRect().bottom : Infinity), o = parseFloat(getComputedStyle(e).maxHeight), c = a - t.top - 8;
		c > 0 && (e.style.maxHeight = `${Math.max(120, Math.min(Number.isFinite(o) ? o : c, c))}px`);
	}, [n]), je(() => {
		n && l.current?.querySelector(`[data-i="${i}"]`)?.scrollIntoView({ block: "nearest" });
	}, [n, i]);
	let g = e.label === void 0 ? p?.label ?? e.placeholder ?? "" : e.label;
	return /* @__PURE__ */ G("span", {
		ref: c,
		className: "de-dd-wrap",
		children: [/* @__PURE__ */ G("button", {
			type: "button",
			className: (n ? "de-dd de-dd-open" : "de-dd") + (e.className ? " " + e.className : ""),
			style: { width: e.width },
			title: e.title,
			"aria-label": e.title,
			"aria-haspopup": "listbox",
			"aria-expanded": n,
			disabled: e.disabled,
			onMouseDown: st,
			onClick: () => n ? r(!1) : h(),
			onKeyDown: (e) => {
				n || e.key !== "ArrowDown" && e.key !== "Enter" && e.key !== " " || (e.preventDefault(), h());
			},
			children: [
				e.icon && /* @__PURE__ */ W(J, { name: e.icon }),
				g !== null && /* @__PURE__ */ W("span", {
					className: p || e.label !== void 0 ? "de-dd-label" : "de-dd-label de-dd-ph",
					children: g
				}),
				/* @__PURE__ */ W(J, {
					name: "chevron",
					size: 14
				})
			]
		}), n && /* @__PURE__ */ W("div", {
			ref: l,
			className: "de-dd-pop",
			role: "listbox",
			"aria-label": e.title,
			style: {
				minWidth: e.menuWidth,
				...e.alignRight ? { right: -o } : { left: o }
			},
			onMouseDown: st,
			children: t.map((e, t) => /* @__PURE__ */ G(Te, { children: [
				e.sep && t > 0 && /* @__PURE__ */ W("div", {
					className: "de-dd-sep",
					role: "separator"
				}),
				e.head && /* @__PURE__ */ W("div", {
					className: "de-dd-head",
					role: "presentation",
					children: e.head
				}),
				/* @__PURE__ */ G("div", {
					"data-i": t,
					role: "option",
					"aria-selected": t === f,
					"aria-disabled": e.disabled || void 0,
					className: "de-dd-opt" + (t === i ? " de-dd-hi" : "") + (e.disabled ? " de-dd-dis" : ""),
					onMouseMove: () => t !== i && !e.disabled && a(t),
					onClick: () => m(e),
					children: [
						d && /* @__PURE__ */ W("span", {
							className: "de-dd-check",
							children: t === f && /* @__PURE__ */ W(J, {
								name: "check",
								size: 16
							})
						}),
						e.icon && /* @__PURE__ */ W(J, { name: e.icon }),
						/* @__PURE__ */ W("span", {
							className: "de-dd-text",
							style: e.style,
							children: e.label
						}),
						e.hint && /* @__PURE__ */ W("span", {
							className: "de-dd-hint",
							children: e.hint
						})
					]
				})
			] }, String(e.value)))
		})]
	});
}
function ut(e) {
	return /* @__PURE__ */ W(Z, { ...e });
}
function dt(e) {
	let t = e.sizes ?? Et, [n, r] = H(null), [i, a] = H(!1), o = V(null), s = V(null);
	lt(o, i, () => a(!1));
	let c = e.value ?? e.placeholder ?? 11, l = (t) => {
		r(null), a(!1), Number.isFinite(t) && t >= 1 && t <= 400 && e.onChange(Math.round(t * 2) / 2);
	}, u = () => {
		n !== null && l(parseFloat(n)), s.current?.blur();
	}, d = e.title ?? "Font size";
	return /* @__PURE__ */ G("span", {
		ref: o,
		className: "de-size",
		children: [
			/* @__PURE__ */ W("button", {
				type: "button",
				className: "de-tb de-size-step",
				title: "Decrease font size",
				"aria-label": "Decrease font size",
				disabled: e.disabled,
				onMouseDown: st,
				onClick: () => l(Math.max(1, Math.ceil(c) - 1)),
				children: /* @__PURE__ */ W(J, {
					name: "minus",
					size: 16
				})
			}),
			/* @__PURE__ */ W("input", {
				ref: s,
				className: "de-size-input",
				title: d,
				"aria-label": d,
				inputMode: "decimal",
				disabled: e.disabled,
				value: n ?? (e.value === void 0 ? "" : String(e.value)),
				placeholder: e.placeholder === void 0 ? "" : String(e.placeholder),
				onFocus: (e) => {
					e.currentTarget.select(), a(!0);
				},
				onChange: (e) => r(e.target.value.replace(/[^\d.]/g, "")),
				onKeyDown: (e) => {
					if (e.key === "Enter") e.preventDefault(), u();
					else if (e.key === "Escape") e.preventDefault(), r(null), a(!1), s.current?.blur();
					else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
						e.preventDefault();
						let i = parseFloat(n ?? String(c)), a = e.key === "ArrowUp" ? t.find((e) => e > i) : [...t].reverse().find((e) => e < i);
						a !== void 0 && r(String(a));
					}
				},
				onBlur: () => {
					n !== null && l(parseFloat(n)), a(!1);
				}
			}),
			/* @__PURE__ */ W("button", {
				type: "button",
				className: "de-tb de-size-step",
				title: "Increase font size",
				"aria-label": "Increase font size",
				disabled: e.disabled,
				onMouseDown: st,
				onClick: () => l(Math.floor(c) + 1),
				children: /* @__PURE__ */ W(J, {
					name: "plus",
					size: 16
				})
			}),
			i && /* @__PURE__ */ W("div", {
				className: "de-dd-pop de-size-pop",
				role: "listbox",
				"aria-label": d,
				onMouseDown: st,
				children: t.map((t) => /* @__PURE__ */ W("div", {
					role: "option",
					"aria-selected": t === e.value,
					className: "de-dd-opt" + (String(t) === (n ?? String(e.value)) ? " de-dd-hi" : ""),
					onClick: () => l(t),
					children: t
				}, t))
			})
		]
	});
}
function ft(e) {
	let t = [];
	return we.forEach(e, (e) => {
		De(e) && (e.type === Te ? t.push(...ft(e.props.children)) : t.push(e));
	}), t;
}
var pt = (e) => {
	let t = e.props;
	return `${typeof e.type == "string" ? e.type : e.type.name}:${t.title ?? t.icon ?? (typeof t.label == "string" ? t.label : "")}`;
};
function mt({ children: e }) {
	let t = ft(e), n = t.map(pt).join("|"), r = V(null), i = V([]), [a, o] = H({
		sig: "",
		cut: t.length,
		w: 0
	}), [s, c] = H(!1), l = V(null);
	lt(l, s, () => c(!1));
	let u = a.sig === n, d = u ? a.cut : t.length, f = (e) => {
		let r = i.current, a = r.reduce((e, t) => e + t + 2, 0), s = t.length;
		if (a > e) {
			let n = e - 34, i = 0;
			for (s = 0; s < t.length && i + r[s] + 2 <= n;) i += r[s++] + 2;
		}
		o((t) => t.sig === n && t.cut === s && t.w === e ? t : {
			sig: n,
			cut: s,
			w: e
		});
	}, p = () => {
		let e = r.current;
		if (!e) return 0;
		let t = getComputedStyle(e);
		return e.clientWidth - parseFloat(t.paddingLeft) - parseFloat(t.paddingRight);
	};
	je(() => {
		let e = r.current;
		e && !u && (i.current = [...e.querySelectorAll(":scope > [data-i]")].map((e) => e.getBoundingClientRect().width), f(p()));
	});
	let m = V(() => {});
	m.current = () => {
		i.current.length === t.length && f(p());
	}, B(() => {
		let e = r.current;
		if (!e) return;
		let t = new ResizeObserver(() => m.current());
		return t.observe(e), () => t.disconnect();
	}, []);
	let h = (e) => !!e && e.type === X, g = d;
	for (; g > 0 && h(t[g - 1]) && g < t.length;) g--;
	let _ = t.slice(d).filter((e, t, n) => !h(e) || t !== 0 && t !== n.length - 1);
	return /* @__PURE__ */ G("div", {
		ref: r,
		className: "de-ebar",
		role: "toolbar",
		children: [t.slice(0, g).map((e, t) => /* @__PURE__ */ W("span", {
			"data-i": t,
			className: "de-ebar-it",
			children: e
		}, t)), _.length > 0 && /* @__PURE__ */ G("span", {
			ref: l,
			className: "de-tb-color de-ebar-morewrap",
			children: [/* @__PURE__ */ W("button", {
				type: "button",
				className: s ? "de-tb de-tb-on" : "de-tb",
				title: "More",
				"aria-label": "More tools",
				"aria-expanded": s,
				onMouseDown: st,
				onClick: () => c((e) => !e),
				children: /* @__PURE__ */ W(J, { name: "more" })
			}), s && /* @__PURE__ */ W(ct, {
				className: "de-tb-pop de-ebar-more",
				children: _.map((e, t) => /* @__PURE__ */ W("span", {
					className: "de-ebar-it",
					children: e
				}, t))
			})]
		})]
	});
}
var ht = /* @__PURE__ */ "#000000.#434343.#666666.#999999.#b7b7b7.#cccccc.#d9d9d9.#ffffff.#980000.#ff0000.#ff9900.#ffff00.#00ff00.#00ffff.#4a86e8.#0000ff.#9900ff.#ff00ff.#e6b8af.#f4cccc.#fce5cd.#fff2cc.#d9ead3.#d0e0e3.#c9daf8.#cfe2f3.#d9d2e9.#ead1dc.#cc4125.#e06666.#f6b26b.#ffd966.#93c47d.#76a5af.#6d9eeb.#6fa8dc.#8e7cc3.#c27ba0.#1155cc.#38761d".split("."), gt = "office-engine:custom-colors", _t = 7, vt = /^#[0-9a-f]{6}$/, yt = null, bt = /* @__PURE__ */ new Set();
function xt() {
	if (yt) return yt;
	yt = [];
	try {
		let e = JSON.parse(localStorage.getItem(gt) ?? "[]");
		Array.isArray(e) && (yt = e.filter((e) => typeof e == "string" && vt.test(e)).slice(0, _t));
	} catch {}
	return yt;
}
function St(e) {
	yt = [e, ...xt().filter((t) => t !== e)].slice(0, _t);
	try {
		localStorage.setItem(gt, JSON.stringify(yt));
	} catch {}
	bt.forEach((e) => e());
}
var Ct = (e) => (bt.add(e), () => {
	bt.delete(e);
});
function wt(e) {
	let [t, n] = H(!1), r = V(null), i = V(null), a = Pe(Ct, xt, xt);
	lt(r, t, () => n(!1));
	let o = V(e.onPick);
	o.current = e.onPick;
	let s = e.value?.toLowerCase();
	B(() => {
		let e = i.current;
		if (!e) return;
		let t = () => {
			let t = e.value.toLowerCase();
			vt.test(t) && (St(t), o.current(t));
		};
		return e.addEventListener("change", t), () => e.removeEventListener("change", t);
	}, []);
	let c = () => {
		let e = i.current;
		if (e) {
			e.value = s && vt.test(s) ? s : a[0] ?? "#000000", n(!1);
			try {
				e.showPicker();
			} catch {
				e.click();
			}
		}
	}, l = (t) => /* @__PURE__ */ W("button", {
		type: "button",
		title: t,
		className: s === t ? "on" : void 0,
		style: { background: t },
		onClick: () => (e.onPick(t), n(!1))
	}, t);
	return /* @__PURE__ */ G("span", {
		ref: r,
		className: "de-tb-color",
		children: [
			/* @__PURE__ */ G("button", {
				type: "button",
				className: t ? "de-tb de-tb-on" : "de-tb",
				title: e.title,
				"aria-label": e.title,
				"aria-expanded": t,
				onMouseDown: st,
				onClick: () => n((e) => !e),
				children: [/* @__PURE__ */ W(J, { name: e.icon }), /* @__PURE__ */ W("span", {
					className: "de-tb-swatch",
					style: { background: L(e.value) ?? "transparent" }
				})]
			}),
			/* @__PURE__ */ W("input", {
				ref: i,
				type: "color",
				className: "de-tb-native",
				tabIndex: -1,
				"aria-hidden": !0
			}),
			t && /* @__PURE__ */ G(ct, {
				onMouseDown: st,
				children: [
					/* @__PURE__ */ W("button", {
						type: "button",
						className: "de-tb-none",
						onClick: () => (e.onPick(null), n(!1)),
						children: e.noneLabel ?? "None"
					}),
					/* @__PURE__ */ W("div", {
						className: "de-tb-grid",
						children: (e.palette ?? ht).map(l)
					}),
					/* @__PURE__ */ W("div", {
						className: "de-tb-custom",
						children: "Custom"
					}),
					/* @__PURE__ */ G("div", {
						className: "de-tb-grid",
						children: [a.map(l), /* @__PURE__ */ W("button", {
							type: "button",
							className: "de-tb-add",
							title: "Custom color…",
							"aria-label": "Custom color",
							onClick: c,
							children: /* @__PURE__ */ W(J, {
								name: "plus",
								size: 14
							})
						})]
					})
				]
			})
		]
	});
}
var Tt = [
	"Arial",
	"Calibri",
	"Cambria",
	"Courier New",
	"Georgia",
	"Helvetica",
	"Segoe UI",
	"Tahoma",
	"Times New Roman",
	"Verdana"
], Et = [
	8,
	9,
	10,
	10.5,
	11,
	12,
	14,
	16,
	18,
	20,
	24,
	28,
	32,
	36,
	40,
	48,
	60,
	72
];
function Dt(e) {
	let t = e && !Tt.includes(e) ? [e, ...Tt] : Tt;
	return t.map((e, n) => ({
		value: e,
		label: e,
		style: { fontFamily: `"${e}", system-ui, sans-serif` },
		sep: n === 1 && t !== Tt
	}));
}
function Ot(e) {
	if (!e) return "";
	let t = /^\s*"?([^",]+)"?/.exec(e);
	return t ? t[1] : "";
}
function kt(e, t) {
	let n = URL.createObjectURL(e), r = document.createElement("a");
	r.href = n, r.download = t, document.body.appendChild(r), r.click(), r.remove(), setTimeout(() => URL.revokeObjectURL(n), 3e4);
}
function At(e) {
	return /* @__PURE__ */ W(Z, {
		title: e.title,
		label: e.label.replace(/\s*▾$/, ""),
		icon: e.icon,
		options: e.items,
		onChange: e.onPick
	});
}
function jt(e) {
	let [t, n] = H(!1), r = V(null);
	return lt(r, t, () => n(!1)), /* @__PURE__ */ G("span", {
		ref: r,
		className: "de-tb-color",
		children: [/* @__PURE__ */ G("button", {
			type: "button",
			className: (e.active || t ? "de-tb de-tb-on" : "de-tb") + (e.chevron ? " de-tb-chev" : ""),
			title: e.title,
			"aria-label": e.title,
			"aria-expanded": t,
			disabled: e.disabled,
			onMouseDown: st,
			onClick: () => n((e) => !e),
			children: [/* @__PURE__ */ W(J, { name: e.icon }), e.chevron && /* @__PURE__ */ W(J, {
				name: "chevron",
				size: 14
			})]
		}), t && /* @__PURE__ */ W(ct, {
			onMouseDown: (e) => e.target.closest("input, textarea") || e.preventDefault(),
			children: e.children(() => n(!1))
		})]
	});
}
function Mt({ onPick: e }) {
	let [t, n] = H([0, 0]);
	return /* @__PURE__ */ G("div", { children: [/* @__PURE__ */ W("div", {
		className: "de-gridpick",
		onMouseLeave: () => n([0, 0]),
		children: Array.from({ length: 64 }, (r, i) => {
			let a = Math.floor(i / 8) + 1, o = i % 8 + 1;
			return /* @__PURE__ */ W("button", {
				type: "button",
				className: a <= t[0] && o <= t[1] ? "on" : "",
				onMouseEnter: () => n([a, o]),
				onMouseDown: st,
				onClick: () => e(a, o)
			}, i);
		})
	}), /* @__PURE__ */ W("div", {
		className: "de-gridpick-label",
		children: t[0] ? `${t[0]} × ${t[1]}` : "Table size"
	})] });
}
function Nt(e = "image/*", t = !0) {
	return new Promise((n) => {
		let r = document.createElement("input");
		r.type = "file", r.accept = e, r.multiple = t, r.onchange = () => n(Array.from(r.files ?? [])), r.click();
	});
}
// src/react/common/Slots.tsx
var Pt = Ee({
	bar: null,
	editable: !1,
	setDirty: () => {},
	save: async () => {},
	canDownload: !0,
	client: null,
	fileOps: { current: null },
	selectAll: { current: null }
}), Ft = () => z(Pt);
function It(e) {
	let t = Ft().fileOps;
	B(() => {
		t.current = e;
	}), B(() => () => {
		t.current = null;
	}, [t]);
}
function Lt(e) {
	let t = Ft().selectAll;
	B(() => {
		t.current = e;
	}), B(() => () => {
		t.current = null;
	}, [t]);
}
function Rt({ children: e }) {
	let { bar: t } = Ft();
	return t ? Fe(/* @__PURE__ */ W(mt, { children: e }), t) : null;
}
// src/react/common/Status.tsx
var zt = Ee(null);
function Bt({ text: e, onStatus: t }) {
	let n = z(zt);
	return B(() => {
		t?.(e);
	}, [e, t]), n ? Fe(e, n) : null;
}
// src/react/common/ZoomControl.tsx
var Vt = [
	.25,
	.33,
	.5,
	.67,
	.75,
	.9,
	1,
	1.1,
	1.25,
	1.5,
	1.75,
	2,
	2.5,
	3
];
function Ht({ zoom: e, effective: t, onChange: n }) {
	let r = (e) => {
		let r = t, i = e > 0 ? Vt.find((e) => e > r + .001) : [...Vt].reverse().find((e) => e < r - .001);
		i && n(i);
	};
	return /* @__PURE__ */ G("div", {
		className: "de-zoom",
		role: "group",
		"aria-label": "Zoom",
		children: [
			/* @__PURE__ */ W("button", {
				type: "button",
				"aria-label": "Zoom out",
				onClick: () => r(-1),
				children: "−"
			}),
			/* @__PURE__ */ W("span", {
				title: e === "fit" ? "Fit width (click for 100%)" : "Click to fit width",
				onClick: () => n(e === "fit" ? 1 : "fit"),
				children: e === "fit" ? "Fit" : `${Math.round(t * 100)}%`
			}),
			/* @__PURE__ */ W("button", {
				type: "button",
				"aria-label": "Zoom in",
				onClick: () => r(1),
				children: "+"
			})
		]
	});
}
// src/react/common/ContextMenu.tsx
function Ut(e, t, n) {
	let r = e.length, i = t;
	for (let t = 0; t < r; t++) if (i = (i + n + r) % r, !e[i].disabled) return i;
	return t;
}
function Wt(e) {
	let { items: t, hi: n, open: r } = e;
	return /* @__PURE__ */ W(U, { children: t.map((t, i) => /* @__PURE__ */ G("div", {
		className: "de-ctx-row",
		children: [
			t.sep && i > 0 && /* @__PURE__ */ W("div", {
				className: "de-ctx-sep",
				role: "separator"
			}),
			t.head && /* @__PURE__ */ W("div", {
				className: "de-ctx-head",
				children: t.head
			}),
			/* @__PURE__ */ G("button", {
				ref: e.rowRef && ((t) => e.rowRef(i, t)),
				type: "button",
				role: "menuitem",
				"aria-haspopup": t.items ? "menu" : void 0,
				"aria-expanded": t.items ? r === i : void 0,
				className: i === n || i === r ? "de-ctx-hi" : void 0,
				disabled: t.disabled,
				onMouseEnter: () => e.onHover(i),
				onClick: () => e.onPick(i),
				children: [
					/* @__PURE__ */ W("span", {
						className: "de-ctx-icon",
						children: t.icon && /* @__PURE__ */ W(J, {
							name: t.icon,
							size: 16
						})
					}),
					/* @__PURE__ */ W("span", {
						className: "de-ctx-label",
						children: t.label
					}),
					t.hint && /* @__PURE__ */ W("span", {
						className: "de-ctx-hint",
						children: t.hint
					}),
					t.items && /* @__PURE__ */ W("span", {
						className: "de-ctx-more",
						children: /* @__PURE__ */ W(J, {
							name: "chevron",
							size: 14
						})
					})
				]
			})
		]
	}, i)) });
}
function Gt(e) {
	let t = V(null), [n, r] = H(null);
	return je(() => {
		let n = t.current;
		if (!n) return;
		let i = e.anchor.getBoundingClientRect(), a = n.getBoundingClientRect(), o = document.documentElement.clientWidth, s = document.documentElement.clientHeight;
		r({
			left: i.right + a.width > o - 4 ? Math.max(4, i.left - a.width) : i.right,
			top: Math.max(4, Math.min(i.top - 6, s - a.height - 4))
		});
	}, [e.anchor, e.items.length]), /* @__PURE__ */ W("div", {
		ref: t,
		className: "de-ctx de-ctx-sub",
		style: n ?? {
			left: 0,
			top: 0,
			visibility: "hidden"
		},
		role: "menu",
		onMouseEnter: e.onEnter,
		children: /* @__PURE__ */ W(Wt, {
			items: e.items,
			hi: e.hi,
			onHover: e.onHover,
			onPick: e.onPick
		})
	});
}
function Kt({ x: e, y: t, items: n, onClose: r }) {
	let i = V(null), a = V([]), [o, s] = H({
		left: e,
		top: t
	}), [c, l] = H(-1), [u, d] = H(null), f = V(r);
	f.current = r;
	let p = V(void 0), m = () => clearTimeout(p.current);
	B(() => m, []), je(() => {
		let n = i.current;
		if (!n) return;
		let r = n.getBoundingClientRect(), a = document.documentElement.clientWidth, o = document.documentElement.clientHeight;
		s({
			left: e + r.width > a - 4 ? Math.max(4, e - r.width) : e,
			top: t + r.height > o - 4 ? Math.max(4, Math.min(t - r.height, o - r.height - 4)) : t
		});
	}, [e, t]);
	let h = u ? n[u.at]?.items : void 0, g = (e, t = -1) => {
		m(), d((n) => n?.at === e && t < 0 ? n : {
			at: e,
			hi: t
		});
	}, _ = (e, t, n) => {
		let r = e[t];
		if (r && !r.disabled) {
			if (r.items && n === void 0) return g(t);
			f.current(), r.run?.();
		}
	};
	B(() => {
		let e = (e) => {
			i.current && !e.composedPath().includes(i.current) && f.current();
		}, t = (e) => {
			if (e.key === "Escape") h ? d(null) : f.current();
			else if (h && u) {
				if (e.key === "ArrowDown") d({
					at: u.at,
					hi: Ut(h, u.hi, 1)
				});
				else if (e.key === "ArrowUp") d({
					at: u.at,
					hi: Ut(h, u.hi < 0 ? 0 : u.hi, -1)
				});
				else if (e.key === "ArrowLeft") d(null);
				else if (e.key === "Enter") _(h, u.hi, u.at);
				else return;
			} else if (e.key === "ArrowDown") l((e) => Ut(n, e, 1));
			else if (e.key === "ArrowUp") l((e) => Ut(n, e < 0 ? 0 : e, -1));
			else if ((e.key === "ArrowRight" || e.key === "Enter") && n[c]?.items && !n[c].disabled) g(c, Ut(n[c].items, -1, 1));
			else if (e.key === "Enter") _(n, c);
			else return;
			e.preventDefault(), e.stopPropagation();
		}, r = () => f.current();
		return window.addEventListener("mousedown", e, !0), window.addEventListener("keydown", t, !0), window.addEventListener("blur", r), window.addEventListener("resize", r), () => {
			window.removeEventListener("mousedown", e, !0), window.removeEventListener("keydown", t, !0), window.removeEventListener("blur", r), window.removeEventListener("resize", r);
		};
	});
	let v = u ? a.current[u.at] : null;
	return /* @__PURE__ */ G("div", {
		ref: i,
		className: "de-ctx",
		style: o,
		role: "menu",
		onMouseDown: (e) => e.preventDefault(),
		onContextMenu: (e) => e.preventDefault(),
		children: [/* @__PURE__ */ W(Wt, {
			items: n,
			hi: c,
			open: u?.at,
			rowRef: (e, t) => a.current[e] = t,
			onHover: (e) => {
				l(e);
				let t = n[e];
				t.items && !t.disabled ? g(e) : u && (m(), p.current = setTimeout(() => d(null), 250));
			},
			onPick: (e) => _(n, e)
		}), u && h && v && /* @__PURE__ */ W(Gt, {
			anchor: v,
			items: h,
			hi: u.hi,
			onEnter: m,
			onHover: (e) => d({
				at: u.at,
				hi: e
			}),
			onPick: (e) => _(h, e, u.at)
		})]
	});
}
var Q = typeof navigator < "u" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl+";
// src/react/common/Dialog.tsx
function qt({ spec: e, onClose: t }) {
	let [n, r] = H(e.initial ?? ""), i = V(null);
	B(() => {
		let e = i.current;
		e?.focus(), e?.select();
	}, []);
	let a = () => {
		t(), e.onOk(n);
	};
	return /* @__PURE__ */ W("div", {
		className: "de-dialog-back",
		onMouseDown: (e) => e.target === e.currentTarget && t(),
		onKeyDown: (e) => {
			e.key === "Escape" && (e.stopPropagation(), t());
		},
		children: /* @__PURE__ */ G("form", {
			className: "de-dialog",
			role: "dialog",
			"aria-label": e.title,
			onSubmit: (e) => {
				e.preventDefault(), a();
			},
			children: [
				/* @__PURE__ */ W("div", {
					className: "de-dialog-title",
					children: e.title
				}),
				e.label && /* @__PURE__ */ W("label", {
					className: "de-dialog-label",
					children: e.label
				}),
				e.area ? /* @__PURE__ */ W("textarea", {
					ref: i,
					rows: 3,
					value: n,
					placeholder: e.placeholder,
					onChange: (e) => r(e.target.value)
				}) : /* @__PURE__ */ W("input", {
					ref: i,
					value: n,
					placeholder: e.placeholder,
					onChange: (e) => r(e.target.value)
				}),
				e.note && /* @__PURE__ */ W("div", {
					className: "de-dialog-note",
					children: e.note
				}),
				/* @__PURE__ */ G("div", {
					className: "de-dialog-btns",
					children: [
						e.extra && /* @__PURE__ */ W("button", {
							type: "button",
							className: "de-btn de-dialog-extra",
							onClick: () => {
								t(), e.extra.run();
							},
							children: e.extra.label
						}),
						/* @__PURE__ */ W("button", {
							type: "button",
							className: "de-btn",
							onClick: t,
							children: "Cancel"
						}),
						/* @__PURE__ */ W("button", {
							type: "submit",
							className: "de-btn de-btn-primary",
							children: e.ok ?? "OK"
						})
					]
				})
			]
		})
	});
}
function Jt(e) {
	let t = V(null);
	return B(() => t.current?.focus(), []), /* @__PURE__ */ W("div", {
		className: "de-dialog-back",
		onMouseDown: (t) => t.target === t.currentTarget && e.onClose(),
		onKeyDown: (t) => {
			t.key === "Escape" && (t.stopPropagation(), e.onClose());
		},
		children: /* @__PURE__ */ G("div", {
			className: "de-dialog",
			role: "alertdialog",
			"aria-label": e.title,
			children: [
				/* @__PURE__ */ W("div", {
					className: "de-dialog-title",
					children: e.title
				}),
				/* @__PURE__ */ W("div", {
					className: "de-dialog-note",
					children: e.message
				}),
				/* @__PURE__ */ G("div", {
					className: "de-dialog-btns",
					children: [/* @__PURE__ */ W("button", {
						type: "button",
						className: "de-btn",
						onClick: e.onClose,
						children: "Cancel"
					}), /* @__PURE__ */ W("button", {
						ref: t,
						type: "button",
						className: "de-btn de-btn-primary",
						onClick: () => {
							e.onClose(), e.onOk();
						},
						children: e.ok
					})]
				})
			]
		})
	});
}
function Yt({ text: e, onDone: t }) {
	return B(() => {
		let e = setTimeout(t, 3500);
		return () => clearTimeout(e);
	}, [e, t]), /* @__PURE__ */ W("div", {
		className: "de-toast",
		role: "status",
		children: e
	});
}
// src/react/docx/tables.ts
function Xt(e) {
	let t = [], n = [];
	return e.rows.forEach((e, r) => {
		let i = 0;
		e.cells.forEach((e, a) => {
			for (; t[r]?.[i];) i++;
			for (let n = r; n < r + Math.max(1, e.rowSpan); n++) for (let r = i; r < i + Math.max(1, e.colSpan); r++) (t[n] ??= [])[r] = !0;
			n.push({
				ri: r,
				ci: a,
				g: i,
				cell: e
			}), i += Math.max(1, e.colSpan);
		});
	}), {
		cells: n,
		nCols: Math.max(e.cols.length, ...n.map((e) => e.g + e.cell.colSpan)),
		at: (e, t) => n.find((n) => e >= n.ri && e < n.ri + n.cell.rowSpan && t >= n.g && t < n.g + n.cell.colSpan)
	};
}
function Zt(e, t, n = 1) {
	return {
		...e,
		blocks: [t(e)],
		colSpan: n,
		rowSpan: 1
	};
}
function Qt(e, t) {
	let n = e.reduce((e, t) => e + t, 0) || 1;
	return e.map((e) => +(e * t / n).toFixed(2));
}
function $t(e, t, n, r) {
	let { cells: i, nCols: a, at: o } = Xt(e), s = n ? t + 1 : t, c = e.rows.map((e) => ({
		...e,
		cells: [...e.cells]
	})), l = [];
	for (let e = 0; e < a;) {
		let n = o(t, e);
		if (!n) e++;
		else {
			if (n.ri < s && n.ri + n.cell.rowSpan > s) {
				let e = c[n.ri];
				e.cells[n.ci] = {
					...e.cells[n.ci],
					rowSpan: e.cells[n.ci].rowSpan + 1
				};
			} else l.push(Zt(n.cell, r, n.cell.colSpan));
			e += n.cell.colSpan;
		}
	}
	let u = {
		...e.rows[t],
		cells: l
	};
	return c.splice(s, 0, u), {
		...e,
		rows: c
	};
}
function en(e, t) {
	if (e.rows.length <= 1) return null;
	let { cells: n } = Xt(e), r = e.rows.map((e) => ({
		...e,
		cells: [...e.cells]
	}));
	for (let e of n) e.ri < t && e.ri + e.cell.rowSpan > t && (r[e.ri].cells[e.ci] = {
		...r[e.ri].cells[e.ci],
		rowSpan: e.cell.rowSpan - 1
	});
	return r.splice(t, 1), {
		...e,
		rows: r
	};
}
function tn(e, t, n, r) {
	let { cells: i, nCols: a } = Xt(e), o = n ? t + 1 : t, s = e.rows.map((e) => ({
		...e,
		cells: [...e.cells]
	})), c = e.cols.reduce((e, t) => e + t, 0);
	e.rows.forEach((e, t) => {
		let n = i.filter((e) => e.ri === t), a = i.find((e) => e.ri <= t && t < e.ri + e.cell.rowSpan && e.g < o && e.g + e.cell.colSpan > o);
		if (a) {
			a.ri === t && (s[t].cells[a.ci] = {
				...s[t].cells[a.ci],
				colSpan: a.cell.colSpan + 1
			});
			return;
		}
		if (i.find((e) => e.ri < t && t < e.ri + e.cell.rowSpan && e.g + e.cell.colSpan === o) && !n.length) return;
		let c = n.filter((e) => e.g < o).length, l = n[Math.max(0, c - 1)]?.cell ?? n[0]?.cell;
		l && s[t].cells.splice(c, 0, Zt(l, r));
	});
	let l = [...e.cols.length ? e.cols : Array(a).fill(c / Math.max(1, a))];
	return l.splice(o, 0, l[Math.min(t, l.length - 1)] ?? 72), {
		...e,
		rows: s,
		cols: c ? Qt(l, c) : l
	};
}
function nn(e, t) {
	let { cells: n, nCols: r } = Xt(e);
	if (r <= 1) return null;
	let i = e.rows.map((e) => ({
		...e,
		cells: [...e.cells]
	})), a = /* @__PURE__ */ new Set();
	for (let e of n) t < e.g || t >= e.g + e.cell.colSpan || (e.cell.colSpan > 1 ? i[e.ri].cells[e.ci] = {
		...i[e.ri].cells[e.ci],
		colSpan: e.cell.colSpan - 1
	} : a.add(`${e.ri}:${e.ci}`));
	i.forEach((e, t) => e.cells = e.cells.filter((e, n) => !a.has(`${t}:${n}`)));
	let o = e.cols.reduce((e, t) => e + t, 0), s = [...e.cols];
	return s.splice(t, 1), {
		...e,
		rows: i.filter((e) => e.cells.length),
		cols: o && s.length ? Qt(s, o) : s
	};
}
function rn(e, t, n, r) {
	let i = "0.5pt solid #000000", a = +(n / t).toFixed(2);
	return {
		t: "tbl",
		cols: Array(t).fill(a),
		rows: Array.from({ length: e }, () => ({ cells: Array.from({ length: t }, () => ({
			blocks: [r()],
			colSpan: 1,
			rowSpan: 1,
			borders: {
				t: i,
				r: i,
				b: i,
				l: i
			},
			pad: [
				0,
				5.4,
				0,
				5.4
			]
		})) }))
	};
}
function an(e, t, n) {
	let { cells: r } = Xt(e), i = r.find((e) => e.ri === t[0] && e.ci === t[1]), a = r.find((e) => e.ri === n[0] && e.ci === n[1]);
	if (!i || !a) return null;
	let o = {
		r0: Math.min(i.ri, a.ri),
		g0: Math.min(i.g, a.g),
		r1: Math.max(i.ri + i.cell.rowSpan, a.ri + a.cell.rowSpan) - 1,
		g1: Math.max(i.g + i.cell.colSpan, a.g + a.cell.colSpan) - 1
	};
	for (let e = !0; e;) {
		e = !1;
		for (let t of r) {
			let n = t.ri + t.cell.rowSpan - 1, r = t.g + t.cell.colSpan - 1;
			t.ri > o.r1 || n < o.r0 || t.g > o.g1 || r < o.g0 || (t.ri < o.r0 || n > o.r1 || t.g < o.g0 || r > o.g1) && (o.r0 = Math.min(o.r0, t.ri), o.r1 = Math.max(o.r1, n), o.g0 = Math.min(o.g0, t.g), o.g1 = Math.max(o.g1, r), e = !0);
		}
	}
	return o;
}
function on(e, t) {
	return Xt(e).cells.filter((e) => e.ri >= t.r0 && e.ri <= t.r1 && e.g >= t.g0 && e.g <= t.g1);
}
var sn = (e) => e.t === "p" && !e.runs.some((e) => e.t !== "text" || e.text.length > 0);
function cn(e, t) {
	let n = on(e, t);
	if (n.length < 2) return null;
	let r = n[0];
	if (r.ri !== t.r0 || r.g !== t.g0) return null;
	let i = n.filter((e) => !e.cell.blocks.every(sn)), a = i.length ? i.flatMap((e) => e.cell.blocks) : r.cell.blocks, o = new Set(n.slice(1).map((e) => `${e.ri}:${e.ci}`)), s = e.rows.map((e, i) => ({
		...e,
		cells: e.cells.flatMap((e, s) => {
			if (o.has(`${i}:${s}`)) return [];
			if (i === r.ri && s === r.ci) {
				let r = n.find((e) => e.ri === t.r0 && e.g + e.cell.colSpan - 1 === t.g1)?.cell ?? e, i = n.find((e) => e.ri + e.cell.rowSpan - 1 === t.r1)?.cell ?? e;
				return [{
					...e,
					blocks: a,
					colSpan: t.g1 - t.g0 + 1,
					rowSpan: t.r1 - t.r0 + 1,
					borders: {
						...e.borders,
						r: r.borders.r,
						b: i.borders.b
					}
				}];
			}
			return [e];
		})
	}));
	return {
		...e,
		rows: s
	};
}
function ln(e, t, n, r) {
	let { cells: i } = Xt(e), a = i.find((e) => e.ri === t && e.ci === n);
	if (!a || a.cell.colSpan <= 1 && a.cell.rowSpan <= 1) return null;
	let { colSpan: o, rowSpan: s } = a.cell, c = e.rows.map((e) => ({
		...e,
		cells: [...e.cells]
	})), l = () => ({
		...a.cell,
		blocks: [r(a.cell)],
		colSpan: 1,
		rowSpan: 1
	});
	c[t].cells.splice(n, 1, {
		...a.cell,
		colSpan: 1,
		rowSpan: 1
	}, ...Array.from({ length: o - 1 }, l));
	for (let e = t + 1; e < t + s && e < c.length; e++) {
		let t = i.filter((t) => t.ri === e && t.g < a.g).length;
		c[e].cells.splice(t, 0, ...Array.from({ length: o }, l));
	}
	return {
		...e,
		rows: c
	};
}
var un = [
	"t",
	"r",
	"b",
	"l"
], dn = {
	t: "b",
	b: "t",
	l: "r",
	r: "l"
};
function fn(e, t, n, r) {
	let { cells: i } = Xt(e), a = e.rows.map((e) => ({
		...e,
		cells: [...e.cells]
	})), o = (e, t, n) => {
		let r = a[e.ri].cells[e.ci];
		a[e.ri].cells[e.ci] = {
			...r,
			borders: {
				...r.borders,
				[t]: n
			},
			set: {
				...r.set,
				borders: !0
			}
		};
	};
	for (let a of on(e, t)) {
		let e = {
			t: a.ri === t.r0,
			b: a.ri + a.cell.rowSpan - 1 === t.r1,
			l: a.g === t.g0,
			r: a.g + a.cell.colSpan - 1 === t.g1
		};
		for (let t of un) {
			let s;
			if (s = n === "all" ? r : n === "none" ? "none" : n === "outer" ? e[t] ? r : void 0 : n === "inner" ? e[t] ? void 0 : r : t === n[0] && e[t] ? r : void 0, s !== void 0 && (o(a, t, s), e[t])) for (let e of i) {
				let n = e.ri + e.cell.rowSpan - 1, r = e.g + e.cell.colSpan - 1, i = e.ri <= a.ri + a.cell.rowSpan - 1 && n >= a.ri, c = e.g <= a.g + a.cell.colSpan - 1 && r >= a.g;
				(t === "t" && n === a.ri - 1 && c || t === "b" && e.ri === a.ri + a.cell.rowSpan && c || t === "l" && r === a.g - 1 && i || t === "r" && e.g === a.g + a.cell.colSpan && i) && o(e, dn[t], s);
			}
		}
	}
	return {
		...e,
		rows: a
	};
}
function pn(e, t, n) {
	let r = new Set(on(e, t).map((e) => `${e.ri}:${e.ci}`));
	return {
		...e,
		rows: e.rows.map((e, t) => ({
			...e,
			cells: e.cells.map((e, i) => r.has(`${t}:${i}`) ? n(e) : e)
		}))
	};
}
function mn(e, t) {
	let { nCols: n } = Xt(e), r = e.cols.length === n ? [...e.cols] : Array(n).fill(e.cols.reduce((e, t) => e + t, 0) / Math.max(1, n)), i = t && t.g1 > t.g0 ? t.g0 : 0, a = t && t.g1 > t.g0 ? t.g1 : n - 1, o = r.slice(i, a + 1).reduce((e, t) => e + t, 0);
	for (let e = i; e <= a; e++) r[e] = +(o / (a - i + 1)).toFixed(2);
	return {
		...e,
		cols: r
	};
}
// src/react/docx/track.ts
var hn = (e) => !e.b;
function gn(e) {
	let t = [];
	return e.forEach((e, n) => {
		n > 0 && t.push({ b: !0 });
		for (let n of e.runs) if (n.t === "text") for (let e of n.text.split("")) t.push({
			ch: e,
			run: n,
			tc: n.tc
		});
		else t.push({
			ch: "￼",
			run: n,
			obj: !0,
			tc: n.tc
		});
	}), t;
}
var _n = (e, t) => e.b || t.b ? !!e.b && !!t.b : e.ch === t.ch && (!e.obj || e.run === t.run), vn = (e) => !!e && hn(e) && /[\uD800-\uDBFF]/.test(e.ch);
function yn(e, t, n, r) {
	let i = 0;
	for (let a = 0; a < e.length; a++) {
		if (oe(t, a) === n) return i + r;
		i += k(e[a].runs) + 1;
	}
}
function bn(e, t, n) {
	for (let r = 0; r < e.length; r++) {
		if (n <= e[r] || r === e.length - 1) return {
			pa: oe(t, r),
			o: Math.min(n, e[r])
		};
		n -= e[r] + 1;
	}
	return {
		pa: t,
		o: 0
	};
}
function xn(e) {
	let t = [], n = null, r = () => {
		if (!n) return;
		let { tc: e, ...r } = n.run;
		t.push({
			...r,
			text: n.text,
			...n.tc ? { tc: n.tc } : {}
		}), n = null;
	};
	for (let i of e) i.obj ? (r(), t.push(i.tc === i.run.tc ? i.run : {
		...i.run,
		tc: i.tc
	})) : n && n.run === i.run && n.tc === i.tc ? n.text += i.ch : (r(), n = {
		run: i.run,
		tc: i.tc,
		text: i.ch
	});
	return r(), ue(t);
}
function Sn(e, t, n, r, i, a) {
	let o = gn(e), s = gn(t), c = i ? yn(e, n, i.a.pa, i.a.o) : void 0, l = i ? yn(e, n, i.f.pa, i.f.o) : void 0, u = c !== void 0 && l !== void 0 ? Math.min(c, l) : o.length, d = c !== void 0 && l !== void 0 ? o.length - Math.max(c, l) : o.length, f = 0;
	for (; f < u && f < o.length && f < s.length && _n(o[f], s[f]);) f++;
	vn(o[f - 1]) && f--;
	let p = 0;
	for (; p < d && p < o.length - f && p < s.length - f && _n(o[o.length - 1 - p], s[s.length - 1 - p]);) p++;
	p > 0 && /[\uDC00-\uDFFF]/.test(o[o.length - p].ch ?? "") && p--;
	let m = o.slice(f, o.length - p), h = s.slice(f, s.length - p);
	if (!m.some(hn) && !h.some(hn)) return {
		next: t,
		sel: r
	};
	let g = [];
	for (let e of m) if (hn(e)) {
		if (e.tc?.k === "del") g.push(e);
		else if (e.obj) continue;
		else if (e.tc?.k === "ins" && e.tc.author === a.author) continue;
		else g.push({
			...e,
			tc: {
				...a,
				k: "del"
			}
		});
	}
	let _ = {
		...a,
		k: "ins"
	}, v = [[]];
	s.forEach((e, t) => {
		t === f && v[v.length - 1].push(...g), hn(e) ? v[v.length - 1].push(t >= f && t < s.length - p && !e.obj ? {
			...e,
			tc: _
		} : e) : v.push([]);
	}), f >= s.length && v[v.length - 1].push(...g);
	let y = t.map((e, t) => ({
		...e,
		runs: xn(v[t] ?? []),
		edited: !0
	})), b = !!i && i.a.pa === i.f.pa && i.a.o === i.f.o && yn(e, n, i.a.pa, i.a.o) === f, x = y.map((e) => k(e.runs)), S = (e) => {
		let r = yn(t, n, e.pa, e.o);
		return r === void 0 ? e : bn(x, n, r > f || r === f && b ? r + g.length : r);
	};
	return {
		next: y,
		sel: {
			a: S(r.a),
			f: S(r.f)
		}
	};
}
function Cn(e, t, n, r) {
	let [i, a] = le(e, t), [o, s] = le(a, n - t), c = o.flatMap((e) => {
		if (!e.tc) return [e];
		if (r ? e.tc.k === "del" : e.tc.k === "ins") return [];
		let { tc: t, ...n } = e;
		return [n];
	});
	return ue([
		...i,
		...c,
		...s
	]);
}
var wn = (e) => e.runs.some((e) => !!e.tc);
function Tn(e) {
	let t = [], n = 0;
	for (let r of e.runs) {
		let e = r.t === "text" ? r.text.length : 1;
		if (r.tc) {
			let i = t[t.length - 1];
			i && i.b === n && i.tc.k === r.tc.k && i.tc.author === r.tc.author ? i.b = n + e : t.push({
				a: n,
				b: n + e,
				tc: r.tc
			});
		}
		n += e;
	}
	return t;
}
// src/react/docx/DocxEditor.ts
var En = 200, Dn = /[\p{L}\p{N}_'’-]/u, On = (e) => {
	let t = /* @__PURE__ */ new Set();
	for (let n of e) for (let e of n.runs) if (e.t === "text" || e.t === "img") for (let n of e.cm ?? []) t.add(n);
	return t;
}, kn = (e) => e.split(".").map(Number), An = /* @__PURE__ */ new Set([
	"undo",
	"redo",
	"collab",
	"accept",
	"reject",
	"restore"
]), jn = (e, t, n) => le(le(e.runs, n)[0], t)[1], Mn = [
	"b",
	"i",
	"u",
	"strike",
	"color",
	"sz",
	"font"
], Nn = [
	"align",
	"line",
	"before",
	"after"
], Pn = (e) => ({
	b: !!e?.b,
	i: !!e?.i,
	u: e?.u && e.u !== "none" ? e.u : "none",
	strike: !!e?.strike,
	color: e?.color ?? "auto",
	sz: e?.sz,
	font: e?.font
}), Fn = (e) => ({
	align: e.align ?? "left",
	line: !e.lineRule || e.lineRule === "auto" ? e.line ?? 1 : void 0,
	before: e.before ?? 0,
	after: e.after ?? 0
}), In = (e) => e.runs.flatMap((e) => e.t === "text" ? Array(e.text.length).fill(JSON.stringify(Pn(e.s))) : [""]), Ln = (e) => e ? /^\s*"?([^",]+)/.exec(e)?.[1] ?? e : void 0;
function Rn(e, t) {
	if (se(e.runs) !== se(t.runs)) return null;
	let n = [], r = 0, i = 0, a = () => {
		for (let e = t.runs[r]; e && e.t === "text" && i >= e.text.length; e = t.runs[r]) r++, i = 0;
		return t.runs[r];
	};
	for (let t of e.runs) if (t.t !== "text") {
		let e = a();
		if (!e || e.t !== t.t) return null;
		n.push(t.t === "box" && e.t === "box" ? {
			...t,
			blocks: e.blocks
		} : (t.t === "field" || t.t === "ref") && "s" in e ? {
			...t,
			s: e.s
		} : t), r++, i = 0;
	} else for (let e = t.text; e;) {
		let r = a();
		if (!r || r.t !== "text") return null;
		let o = Math.min(e.length, r.text.length - i);
		n.push({
			...t,
			text: e.slice(0, o),
			s: r.s
		}), e = e.slice(o), i += o;
	}
	let o = e.marker && t.marker ? {
		...e.marker,
		s: t.marker.s
	} : e.marker;
	return {
		...e,
		ps: t.ps,
		runs: ue(n),
		markSz: t.markSz,
		markFont: t.markFont,
		marker: o
	};
}
function zn(e, t, n) {
	if (t === n) return e;
	let r = (e) => e.replace(/\.?\d+$/, ""), i = Number(n.split(".").pop()) - Number(t.split(".").pop()), a = (e) => r(e.pa) === r(t) ? {
		...e,
		pa: r(n) ? `${r(n)}.${Number(e.pa.split(".").pop()) + i}` : String(Number(e.pa.split(".").pop()) + i)
	} : e;
	return {
		a: a(e.a),
		f: a(e.f)
	};
}
var Bn = class {
	client;
	st;
	changed;
	input;
	pendingSel = null;
	styles = [];
	history = [];
	future = [];
	pend = null;
	nextPid = 1e9;
	inflight = 0;
	stale = /* @__PURE__ */ new Set();
	onState;
	onImage;
	onStyles;
	onHeaders;
	shortcut;
	onDirty;
	painter = null;
	onPainter;
	onCommit;
	editSink;
	constructor(e, t, n) {
		this.client = e, this.st = t, this.changed = n, this.input = new he(this);
	}
	container(e) {
		let t = kn(e);
		if (t.length === 1) return {
			list: this.st.blocks,
			at: t[0]
		};
		let n = this.st.blocks[t[0]];
		if (n?.t !== "tbl") return;
		let r = n.rows[t[1]]?.cells[t[2]];
		return r ? {
			list: r.blocks,
			at: t[3],
			cell: [
				t[0],
				t[1],
				t[2]
			]
		} : void 0;
	}
	para(e) {
		let t = this.container(e), n = t?.list[t.at];
		return n && n.t === "p" && n.pid !== void 0 && !n.ro ? n : void 0;
	}
	span(e, t) {
		let n = kn(e), r = kn(t);
		if (n.length !== r.length || n.slice(0, -1).join(".") !== r.slice(0, -1).join(".")) return null;
		let i = [];
		for (let t = n[n.length - 1]; t <= r[r.length - 1]; t++) {
			let r = oe(e, t - n[n.length - 1]);
			if (!this.para(r)) return null;
			i.push(r);
		}
		return i;
	}
	prev(e) {
		let t = kn(e).pop(), n = oe(e, -1);
		return t > 0 && this.para(n) ? n : void 0;
	}
	next(e) {
		let t = oe(e, 1);
		return this.para(t) ? t : void 0;
	}
	cmp(e, t) {
		let n = kn(e), r = kn(t);
		for (let e = 0; e < Math.min(n.length, r.length); e++) if (n[e] !== r[e]) return n[e] - r[e];
		return n.length - r.length;
	}
	all() {
		let e = -1, t = -1;
		return this.st.blocks.forEach((n, r) => {
			this.para(String(r)) && (e < 0 && (e = r), t = r);
		}), e < 0 ? null : {
			a: {
				pa: String(e),
				o: 0
			},
			f: {
				pa: String(t),
				o: k(this.para(String(t)).runs)
			}
		};
	}
	selectAll() {
		this.input.selectAll();
	}
	deleteAcross(e, t) {
		let n = kn(e.pa), r = kn(t.pa);
		if (n.length !== 1 || r.length !== 1 || n[0] >= r[0]) return null;
		let i = this.para(e.pa), a = this.para(t.pa);
		if (!i || !a) return null;
		let o = (e, t) => this.st.blocks[e]?.t === "p" && this.st.blocks[e].pid === t.pid;
		if (o(n[0] - 1, i) || o(r[0] + 1, a)) return null;
		let s = ue([...le(i.runs, e.o)[0], ...le(a.runs, t.o)[1]]), c = this.st.blocks.slice(n[0] + 1, r[0]).filter((e) => e.t === "sect");
		return this.replaceBlocks(n[0], r[0] - n[0] + 1, [this.join(i, a, s), ...c], {
			a: e,
			f: e
		}), e;
	}
	withRuns(e, t) {
		return {
			...e,
			runs: t,
			edited: !0
		};
	}
	origOf(e) {
		return e.orig ?? (e.pid === (e.from ?? e.pid) ? [e.pid] : []);
	}
	defaultRun(e) {
		if (e.caret) return {
			...e.caret,
			text: ""
		};
		let t = [...e.runs].reverse().find((e) => e.t === "text");
		return t ? {
			...t,
			text: ""
		} : {
			t: "text",
			s: {
				sz: e.markSz,
				font: e.markFont
			}
		};
	}
	split(e, t, n, r) {
		let i = e.keepSect ?? e.pid === (e.from ?? e.pid), a = {
			...e,
			runs: t,
			edited: !0,
			keepSect: !1
		}, o = {
			...e,
			runs: n,
			pid: this.nextPid++,
			paraId: void 0,
			from: e.from ?? e.pid,
			orig: [],
			edited: !0,
			keepSect: i,
			pb: !1,
			ver: 0,
			caret: n.length ? void 0 : de(t, k(t)) ?? e.caret
		};
		if (r) {
			let t = this.styles.find((t) => t.id === e.sid)?.next;
			t && t !== e.sid && (o.pd = {
				...o.pd ?? {},
				style: t
			}, o.sid = t);
		}
		return [a, o];
	}
	join(e, t, n) {
		return {
			...e,
			runs: n,
			edited: !0,
			orig: [...this.origOf(e), ...this.origOf(t)],
			keepSect: (e.keepSect ?? e.pid === (e.from ?? e.pid)) || (t.keepSect ?? t.pid === (t.from ?? t.pid))
		};
	}
	splice(e, t, n) {
		let r = this.container(e);
		if (!r.cell) return this.st.blocks.splice(r.at, t, ...n), this.st.blocks;
		let [i, a, o] = r.cell, s = this.st.blocks[i], c = [...r.list];
		c.splice(r.at, t, ...n);
		let l = {
			...s,
			rows: s.rows.map((e, t) => t === a ? {
				...e,
				cells: e.cells.map((e, t) => t === o ? {
					...e,
					blocks: c
				} : e)
			} : e)
		};
		return this.st.heights.set(l, this.st.heights.get(s) ?? 0), this.st.dirty.add(l), this.st.blocks[i] = l, c;
	}
	replace(e, t, n, r = {}) {
		let i = e.map((e) => this.para(e));
		if (i.some((e) => !e)) return;
		if (this.tracking && r.history !== !1 && !An.has(r.label ?? "")) {
			let a = Sn(i, t, e[0], n, this.input.lastSel, {
				k: "ins",
				author: this.author(),
				date: (/* @__PURE__ */ new Date()).toISOString().replace(/\.\d+Z$/, "Z")
			});
			t = a.next, n = a.sel, t.length === 1 && i.length === 1 && r.label === "type" && (r = {
				...r,
				remount: !0
			});
		}
		r.remount && (t = t.map((e) => ({
			...e,
			ver: (e.ver ?? 0) + 1
		})));
		let a = this.container(e[0]), o = a.at, s = this.splice(e[0], e.length, t), c = i[i.length - 1], l = t[t.length - 1];
		if (l && c.pid !== l.pid) for (let e = o + t.length; e < s.length; e++) {
			let t = s[e];
			if (t.t !== "p" || t.pid !== c.pid || !t.pb) break;
			s[e] = {
				...t,
				pid: l.pid,
				from: l.from ?? l.pid,
				edited: !0
			};
		}
		if (!a.cell) {
			t.forEach((e, t) => {
				this.st.heights.set(e, this.st.heights.get(i[t] ?? i[0]) ?? 0), this.st.dirty.add(e);
			});
			for (let e of [o - 1, o + t.length]) s[e] && this.st.dirty.add(s[e]);
			o < this.st.frontier && (this.st.frontier = Math.max(0, this.st.frontier + t.length - e.length));
		}
		if (r.history !== !1) {
			let a = Date.now(), o = this.history[this.history.length - 1], s = r.label ?? "edit", c = this.input.lastSel ?? n;
			s === "type" && o?.label === "type" && e.length === 1 && t.length === 1 && o.after.length === 1 && o.pas[0] === e[0] && o.after[0].pid === i[0].pid && a - o.t < 1500 ? (o.after = t, o.selAfter = n, o.t = a) : (this.history.push({
				pas: e,
				before: i,
				after: t,
				selBefore: c,
				selAfter: n,
				label: s,
				t: a
			}), this.history.length > 500 && this.history.shift()), this.future = [];
		}
		this.commit(e[0], i, t, r.want), this.onCommit?.({
			kind: "paras",
			before: i,
			next: t
		}), r.label !== "collab" && this.editSink?.({
			kind: "paras",
			before: i,
			next: t
		}, e, r.label), r.label === "collab" && this.catchUp(), this.pendingSel = n, this.onDirty?.(), this.changed(), this.emitState(n);
	}
	restore(e, t) {
		let n = this.container(e);
		if (!n || t.pid === void 0 || n.at > n.list.length) return;
		let r = this.splice(e, 0, [t]);
		if (!n.cell) {
			this.st.heights.has(t) || this.st.heights.set(t, 0), this.st.dirty.add(t);
			for (let e of [n.at - 1, n.at + 1]) r[e] && this.st.dirty.add(r[e]);
			n.at < this.st.frontier && this.st.frontier++;
		}
		n.cell && this.st.blocks[n.cell[0]].tid !== void 0 ? this.commitTable(n.cell[0]) : this.send("docx.edit", {
			anchor: t.pid,
			list: [o(this.partsOf(r, t.pid, n.at))]
		}), this.onDirty?.(), this.changed();
	}
	partsOf(e, t, n) {
		let r = n;
		for (; r > 0 && e[r - 1].pid === t && e[r - 1].t === "p";) r--;
		let i = [];
		for (; r < e.length && e[r].t === "p" && e[r].pid === t; r++) i.push(e[r]);
		return i;
	}
	commit(e, t, n, r) {
		let i = this.container(e);
		if (i.cell && this.st.blocks[i.cell[0]].tid !== void 0) {
			this.commitTable(i.cell[0]);
			return;
		}
		let a = i.list, s = [];
		n.forEach((e) => e.pid !== void 0 && !s.includes(e.pid) && s.push(e.pid));
		let c = s.map((e) => {
			let t = i.at + n.findIndex((t) => t.pid === e);
			return o(this.partsOf(a, e, t));
		}), l = [];
		for (let e of t) {
			if (e.pid === void 0 || s.includes(e.pid) || l.includes(e.pid)) continue;
			let t = a.findIndex((t) => t.t === "p" && t.pid === e.pid);
			t >= 0 ? c.push(o(this.partsOf(a, e.pid, t))) : l.push(e.pid);
		}
		let u = t[0].pid, d = On(t);
		if (d.size) {
			let e = On(n), r = [...d].filter((t) => !e.has(t));
			r.length && this.remark(new Set(r), /* @__PURE__ */ new Set([
				...s,
				...l,
				...t.map((e) => e.pid)
			]));
		}
		let f = r || n.some((e) => e.pd !== t.find((t) => t.pid === e.pid)?.pd) || c.some((e) => this.stale.has(e.pid));
		if (f) for (let e of c) this.stale.add(e.pid);
		let p = new Set(n), m = {
			anchor: u,
			list: c,
			remove: l,
			want: f
		};
		this.inflight++, this.client.call("docx.edit", m).then((e) => this.applyResult(e, p)).catch((e) => console.error("[office-engine] edit failed", e)).finally(() => {
			this.inflight--, this.settled();
		});
	}
	get busy() {
		return this.inflight > 0;
	}
	idleFns = [];
	whenIdle() {
		return this.inflight === 0 ? Promise.resolve() : new Promise((e) => this.idleFns.push(e));
	}
	settled() {
		if (!(this.inflight > 0)) for (let e of this.idleFns.splice(0)) e();
	}
	remark(e, t) {
		let n = /* @__PURE__ */ new Set(), r = (i, a) => {
			i.forEach((s, c) => {
				if (s.t === "tbl") return s.rows.forEach((e) => e.cells.forEach((e) => r(e.blocks, c)));
				if (s.t !== "p" || s.pid === void 0 || s.edited || s.ro || t.has(s.pid) || !s.runs.some((t) => (t.t === "text" || t.t === "img") && t.cm?.some((t) => e.has(t)))) return;
				t.add(s.pid);
				let l = this.partsOf(i, s.pid, c);
				for (let e of l) e.edited = !0;
				a !== void 0 && this.st.blocks[a].tid !== void 0 ? n.add(a) : this.send("docx.edit", {
					anchor: s.pid,
					list: [o(l)]
				});
			});
		};
		r(this.st.blocks, void 0);
		for (let e of n) this.commitTable(e);
	}
	paraPos(e) {
		let t = this.para(e.pa);
		if (!t || t.pid === void 0) return null;
		let n = this.locate(t.pid).findIndex((t) => t.pa === e.pa);
		return n < 0 ? null : {
			pid: t.pid,
			k: n,
			o: e.o
		};
	}
	posOf(e) {
		let t = this.locate(e.pid), n = t[Math.min(e.k, t.length - 1)], r = n && this.para(n.pa);
		return r ? {
			pa: n.pa,
			o: Math.min(e.o, k(r.runs))
		} : null;
	}
	commentRange(e = this.input.sel() ?? this.input.lastSel) {
		if (!e) return null;
		let t = this.selectedParas(e);
		if (!t) return null;
		let { s: n, e: r } = t;
		if (I(e)) {
			let e = se(this.para(n.pa).runs), t = n.o, i = n.o;
			for (; t > 0 && Dn.test(e[t - 1]);) t--;
			for (; i < e.length && Dn.test(e[i]);) i++;
			if (t === i) return null;
			n = {
				pa: n.pa,
				o: t
			}, r = {
				pa: n.pa,
				o: i
			};
		}
		let i = "";
		t.pas.forEach((e, t) => {
			let a = se(this.para(e).runs);
			i += (t ? " " : "") + a.slice(e === n.pa ? n.o : 0, e === r.pa ? r.o : a.length);
		}), i = i.replace(/\uFFFC/g, "").replace(/\s+/g, " ").trim();
		let a = this.paraPos(n), o = this.paraPos(r);
		return !a || !o || !i ? null : {
			a,
			f: o,
			quote: i.length > En ? i.slice(0, 199) + "…" : i
		};
	}
	markComment(e, t) {
		let n = this.posOf(t.a), r = this.posOf(t.f);
		if (!n || !r) return !1;
		let i = {
			a: n,
			f: r
		}, a = this.selectedParas(i);
		if (!a) return !1;
		let o = !1, s = a.pas.map((t) => {
			let n = this.para(t), r = t === a.s.pa ? a.s.o : 0, i = t === a.e.pa ? a.e.o : k(n.runs);
			return i > r && (o = !0), this.withRuns(n, ye(n.runs, r, i, e, !0));
		});
		return o ? (this.replace(a.pas, s, {
			a: a.e,
			f: a.e
		}, { label: "comment" }), !0) : !1;
	}
	commentPlaces() {
		let e = /* @__PURE__ */ new Map(), t = /* @__PURE__ */ new Map(), n = (e, n) => {
			let r = t.get(e);
			r !== void 0 && r.length >= En || t.set(e, r === void 0 ? n : r + n);
		}, r = (i, a) => {
			let o = 0, s = /* @__PURE__ */ new Set();
			for (let c of i.runs) {
				if (c.t === "box") for (let e of c.blocks) e.t === "p" && r(e, a);
				if ((c.t === "text" || c.t === "img") && c.cm) for (let r of c.cm) e.has(r) || e.set(r, {
					pa: a,
					o,
					quote: ""
				}), !s.has(r) && t.has(r) && n(r, " "), s.add(r), c.t === "text" && n(r, c.text);
				o += c.t === "text" ? c.text.length : 1;
			}
		};
		this.st.blocks.forEach((e, t) => {
			e.t === "p" ? r(e, String(t)) : e.t === "tbl" && e.rows.forEach((e, n) => e.cells.forEach((e, i) => e.blocks.forEach((e, a) => e.t === "p" && r(e, `${t}.${n}.${i}.${a}`))));
		});
		for (let [n, r] of e) {
			let e = (t.get(n) ?? "").replace(/\s+/g, " ").trim();
			r.quote = e.length > En ? e.slice(0, 199) + "…" : e;
		}
		return e;
	}
	locate(e) {
		let t = [];
		return this.st.blocks.forEach((n, r) => {
			n.t === "p" && n.pid === e ? t.push({
				list: this.st.blocks,
				index: r,
				pa: String(r)
			}) : n.t === "tbl" && n.rows.forEach((n, i) => n.cells.forEach((n, a) => n.blocks.forEach((o, s) => {
				o.t === "p" && o.pid === e && t.push({
					list: n.blocks,
					index: s,
					pa: `${r}.${i}.${a}.${s}`
				});
			})));
		}), t;
	}
	put(e, t) {
		let n = this.container(e);
		if (!n) return;
		let r = n.list[n.at];
		this.splice(e, 1, [t]), n.cell || (this.st.heights.set(t, this.st.heights.get(r) ?? 0), this.st.dirty.add(t));
	}
	applyResult(e, t) {
		if (this.input.isComposing) return;
		let n = !1, r = this.input.readSel(), i = /* @__PURE__ */ new Set();
		for (let [r, a] of Object.entries(e.blocks)) {
			let e = Number(r), o = this.locate(e), s = o.map((e) => e.list[e.index]), c = a.filter((e) => e.t === "p"), l = !1;
			for (let n of t) l ||= n.pid === e && s.length > 0 && !s.includes(n);
			l || (this.stale.delete(e), o.length && c.length === o.length && s.every((e) => t.has(e)) && (o.forEach((e, t) => {
				let n = s[t], r = {
					...c[t],
					paraId: n.paraId,
					from: n.from,
					orig: n.orig,
					pd: n.pd,
					edited: n.edited,
					keepSect: n.keepSect,
					ver: n.ver,
					pb: n.pb
				};
				this.put(e.pa, r), this.lookAt.set(r, this.styleGen), this.heir.set(n, r), i.add(e.pa);
			}), n = !0));
		}
		for (let [t, r] of Object.entries(e.markers)) for (let e of this.locate(Number(t))) {
			let t = e.list[e.index];
			e.list[e.index - 1]?.pid !== t.pid && (this.put(e.pa, {
				...t,
				marker: r ? {
					text: r.text,
					s: r.s,
					tab: r.tab
				} : void 0,
				lst: r?.lst
			}), n = !0);
		}
		n && (r && !this.pendingSel && (i.has(r.a.pa) || i.has(r.f.pa)) && (this.pendingSel = r), this.changed());
	}
	whereNow(e, t) {
		let n = e[0];
		if (!n) return t;
		if (n.t === "p") return n.pid === void 0 ? void 0 : this.locate(n.pid)[0]?.pa;
		if (n.t === "tbl") {
			let e = this.st.blocks.findIndex((e) => e.t === "tbl" && (n.tid !== void 0 && e.tid === n.tid || n.item !== void 0 && e.item === n.item));
			return e >= 0 ? String(e) : void 0;
		}
		return t;
	}
	keepCurrent(e, t, n) {
		let r = new Map(this.st.blocks.slice(t, t + n).flatMap((e) => e.t === "p" && e.pid !== void 0 ? [[e.pid, e]] : []));
		return e.map((e) => e.t === "p" && e.pid !== void 0 && r.has(e.pid) ? r.get(e.pid) : e);
	}
	undo() {
		let e = this.history.pop();
		if (!e) return;
		if (e.group) {
			for (let t of [...e.group].reverse()) {
				this.history.push(t);
				let e = this.future.length;
				this.undo(), this.future.length > e && this.future.pop();
			}
			this.future.push(e);
			return;
		}
		if (e.style && this.restyle(e.style.id, e.style.undo), e.page && this.repage(e.page.undo), e.hf && this.rehf(e.hf.undo), e.blocks) {
			let t = this.whereNow(e.blocks.after, String(e.blocks.bi));
			if (t === void 0) return;
			this.replaceBlocks(Number(t), e.blocks.after.length, this.keepCurrent(e.blocks.before, Number(t), e.blocks.after.length), e.selBefore, !1), this.future.push(e);
			return;
		}
		if (!e.pas.length) return this.styleOnly(e, this.future, e.selBefore);
		let t = this.whereNow(e.after, e.pas[0]);
		if (t === void 0) return;
		let n = e.after.map((e, n) => oe(t, n));
		n.some((t, n) => this.para(t)?.pid !== e.after[n].pid) || (this.replace(n.length ? n : [t], e.before, zn(e.selBefore, e.pas[0], t), {
			history: !1,
			label: "undo",
			want: !0
		}), this.future.push(e));
	}
	redo() {
		let e = this.future.pop();
		if (!e) return;
		if (e.group) {
			for (let t of e.group) {
				this.future.push(t);
				let e = this.history.length;
				this.redo(), this.history.length > e && this.history.pop();
			}
			this.history.push(e);
			return;
		}
		if (e.style && this.restyle(e.style.id, e.style.redo), e.page && this.repage(e.page.redo), e.hf && this.rehf(e.hf.redo), e.blocks) {
			let t = this.whereNow(e.blocks.before, String(e.blocks.bi));
			if (t === void 0) return;
			this.replaceBlocks(Number(t), e.blocks.before.length, this.keepCurrent(e.blocks.after, Number(t), e.blocks.before.length), e.selAfter, !1), this.history.push(e);
			return;
		}
		if (!e.pas.length) return this.styleOnly(e, this.history, e.selAfter);
		let t = this.whereNow(e.before, e.pas[0]);
		if (t === void 0) return;
		let n = e.before.map((e, n) => oe(t, n));
		n.some((t, n) => this.para(t)?.pid !== e.before[n].pid) || (this.replace(n, e.after, zn(e.selAfter, e.pas[0], t), {
			history: !1,
			label: "redo",
			want: !0
		}), this.history.push(e));
	}
	styleOnly(e, t, n) {
		t.push(e), this.emitState(this.input.sel() ?? n);
	}
	get canUndo() {
		return this.history.length > 0;
	}
	get canRedo() {
		return this.future.length > 0;
	}
	pendingStyle() {
		return this.pend ? {
			s: this.pend.s,
			d: this.pend.d
		} : void 0;
	}
	clearPending() {
		this.pend = null;
	}
	selectedParas(e) {
		let [t, n] = fe(this, e), r = t.pa === n.pa ? this.para(t.pa) ? [t.pa] : null : this.span(t.pa, n.pa);
		return r ? {
			pas: r,
			s: t,
			e: n
		} : null;
	}
	format(e, t, n = {}) {
		let r = this.input.sel();
		if (!r) return;
		if (I(r)) {
			this.pend = {
				s: {
					...this.pend?.s ?? {},
					...e
				},
				d: {
					...this.pend?.d ?? {},
					...t
				},
				at: r.a
			}, this.input.restore(r), this.emitState(r);
			return;
		}
		let i = this.selectedParas(r);
		if (!i) return;
		let a = i.pas.map((n, r) => {
			let a = this.para(n), o = r === 0 ? i.s.o : 0, s = r === i.pas.length - 1 ? i.e.o : k(a.runs);
			return this.withRuns(a, pe(a.runs, o, s, e, t));
		});
		this.replace(i.pas, a, r, {
			label: "format",
			want: n.want
		});
	}
	toggle(e) {
		let t = this.state(), n = !(t && t[e]);
		e === "u" ? this.format({ u: n ? "single" : "none" }, { u: n ? "single" : "none" }) : this.format({ [e]: n }, { [e]: n });
	}
	setFont(e) {
		this.format({ font: c(e) }, { font: e });
	}
	setSize(e) {
		this.format({ sz: e }, { sz: e });
	}
	setColor(e) {
		this.format({ color: e ?? void 0 }, { color: e });
	}
	setHighlight(e) {
		this.format({
			hl: e ?? void 0,
			shd: void 0
		}, { hl: e });
	}
	clearFormat() {
		this.format({
			b: !1,
			i: !1,
			u: "none",
			strike: !1,
			hl: void 0
		}, {
			b: !1,
			i: !1,
			u: "none",
			strike: !1,
			color: null,
			hl: null,
			va: null
		}, { want: !0 });
	}
	setPara(e, t = {}, n = this.input.sel()) {
		if (!n) return;
		let r = this.selectedParas(n);
		if (!r) return;
		let i = r.pas.map((n) => {
			let r = this.para(n), i = {
				...r.pd ?? {},
				...e
			};
			return {
				...r,
				pd: i,
				ps: {
					...r.ps,
					...t
				},
				edited: !0,
				sid: e.style ?? r.sid
			};
		});
		this.replace(r.pas, i, n, {
			label: "para",
			want: !0
		});
	}
	toggleList(e) {
		let t = this.input.sel();
		if (!t) return;
		let n = this.selectedParas(t);
		if (!n) return;
		let r = n.pas.every((t) => this.para(t)?.lst === e);
		this.setPara({
			list: r ? "none" : e,
			ilvl: r ? void 0 : 0
		}, {}, t);
	}
	indent(e, t = this.input.sel()) {
		if (!t) return;
		let n = this.selectedParas(t);
		if (!n) return;
		let r = n.pas.map((t) => {
			let n = this.para(t), r = { ...n.pd ?? {} };
			return n.lst ? r.ilvl = Math.max(0, Math.min(8, (n.ilvl ?? 0) + e)) : r.indL = Math.max(0, (n.ps.indL ?? 0) + e * 36), {
				...n,
				pd: r,
				ps: n.lst ? n.ps : {
					...n.ps,
					indL: r.indL
				},
				edited: !0
			};
		});
		this.replace(n.pas, r, t, {
			label: "para",
			want: !0
		});
	}
	tab(e, t) {
		if (e.f.pa.includes(".")) {
			let [n, r, i] = e.f.pa.split(".").map(Number), a = this.st.blocks[n].rows.flatMap((e, t) => e.cells.map((e, n) => [t, n])), o = a.findIndex(([e, t]) => e === r && t === i) + (t ? -1 : 1);
			if (o >= a.length && !t) return this.tableOp("rowBelow"), !0;
			let [s, c] = a[Math.max(0, o)], l = `${n}.${s}.${c}.0`, u = this.para(l);
			return this.input.restore({
				a: {
					pa: l,
					o: 0
				},
				f: {
					pa: l,
					o: u ? k(u.runs) : 0
				}
			}), !0;
		}
		return this.para(e.a.pa)?.lst ? (this.indent(t ? -1 : 1, e), !0) : !1;
	}
	backspaceAtStart(e, t) {
		return t.lst ? (this.setPara({ list: "none" }, {}, {
			a: {
				pa: e,
				o: 0
			},
			f: {
				pa: e,
				o: 0
			}
		}), !0) : !1;
	}
	contentW = 468;
	defaultFont;
	defaultSz;
	prevParaPid(e) {
		for (let t = e - 1; t >= 0; t--) {
			let e = this.st.blocks[t];
			if (e.t === "p" && e.pid !== void 0) return e.pid;
		}
	}
	commitTable(e) {
		let t = this.st.blocks[e];
		t?.t === "tbl" && t.tid !== void 0 && this.send("docx.table", {
			tid: t.tid,
			item: t.item,
			anchor: t.item === void 0 ? this.prevParaPid(e) : void 0,
			spec: m(t)
		});
	}
	send(e, t) {
		this.inflight++, this.client.call(e, t).then((t) => e === "docx.edit" && this.applyResult(t, /* @__PURE__ */ new Set())).catch((e) => console.error("[office-engine] edit failed", e)).finally(() => {
			this.inflight--, this.settled();
		});
	}
	replaceBlocks(e, t, n, r, i = !0) {
		let a = this.st.blocks.slice(e, e + t);
		this.st.blocks.splice(e, t, ...n), n.forEach((e, t) => {
			this.st.heights.set(e, this.st.heights.get(a[t] ?? a[0]) ?? 0), this.st.dirty.add(e);
		}), e < this.st.frontier && (this.st.frontier = Math.max(0, this.st.frontier + n.length - t));
		let s = (e) => e.t === "tbl" ? `t${e.tid ?? "i" + e.item}` : e.t === "p" ? `p${e.pid}` : "", c = new Set(n.map(s)), l = new Set(a.map(s)), u = [...a, ...n].find((e) => e.t === "p" && e.pid !== void 0 && l.has(s(e)) && c.has(s(e))), d = n.filter((e) => e.t === "p" && e.pid !== void 0 && !l.has(s(e))), f = a.filter((e) => e.t === "p" && e.pid !== void 0 && !c.has(s(e))), p = new Map(a.map((e) => [s(e), e])), m = n.some((e) => e.t === "p" && e.pid !== void 0 && p.has(s(e)) && p.get(s(e)) !== e);
		if (u && (d.length || f.length || m)) {
			let e = n.filter((e) => e.t === "p" && e.pid !== void 0);
			this.send("docx.edit", {
				anchor: u.pid,
				list: e.map((e) => o([e])),
				remove: f.map((e) => e.pid)
			});
		}
		for (let e of a) e.t !== "tbl" || c.has(s(e)) || e.tid === void 0 && e.item === void 0 || this.send("docx.table", {
			tid: e.tid ?? -1,
			item: e.item,
			spec: null
		});
		if (n.forEach((t, n) => {
			t.t === "tbl" && (t.tid === void 0 && !l.has(s(t)) && (this.st.blocks[e + n] = {
				...t,
				tid: this.nextPid++
			}), this.commitTable(e + n));
		}), this.onCommit?.({
			kind: "blocks",
			bi: e,
			before: a,
			next: n
		}), (i || r) && this.editSink?.({
			kind: "blocks",
			bi: e,
			before: a,
			next: n
		}, void 0, i ? void 0 : "undo"), i || this.catchUp(), i) {
			let t = r ?? this.input.lastSel ?? {
				a: {
					pa: String(e),
					o: 0
				},
				f: {
					pa: String(e),
					o: 0
				}
			};
			this.history.push({
				pas: [],
				before: [],
				after: [],
				blocks: {
					bi: e,
					before: a,
					after: n
				},
				selBefore: this.input.lastSel ?? t,
				selAfter: t,
				label: "table",
				t: Date.now()
			}), this.future = [];
		}
		r && (this.pendingSel = r), this.onDirty?.(), this.changed();
	}
	emptyPara(e) {
		return {
			t: "p",
			ps: {
				...e.ps,
				indFirst: void 0,
				indL: void 0
			},
			runs: [],
			markSz: e.markSz,
			markFont: e.markFont,
			pid: this.nextPid++,
			from: e.from ?? e.pid,
			orig: [],
			edited: !0,
			keepSect: !1,
			pd: {
				style: "",
				list: "none"
			},
			sid: void 0
		};
	}
	insertTable(e, t) {
		let n = this.input.sel(), r = n ? Number(n.f.pa.split(".")[0]) : -1, i = this.st.blocks[r];
		if (!n || n.f.pa.includes(".") || i?.t !== "p" || i.pid === void 0) return;
		let a = [i, {
			...rn(e, t, this.contentW, () => this.emptyPara(i)),
			tid: this.nextPid++
		}], o = this.st.blocks[r + 1];
		o && o.t === "p" || a.push(this.emptyPara(i)), this.replaceBlocks(r, 1, a, {
			a: {
				pa: `${r + 1}.0.0.0`,
				o: 0
			},
			f: {
				pa: `${r + 1}.0.0.0`,
				o: 0
			}
		});
	}
	tableOp(e) {
		let t = this.input.sel();
		if (!t || !t.f.pa.includes(".")) return;
		let [n, r, i] = t.f.pa.split(".").map(Number), a = this.st.blocks[n];
		if (a?.t !== "tbl") return;
		let o = Xt(a).cells.find((e) => e.ri === r && e.ci === i)?.g ?? 0, s = (e) => {
			let t = e.blocks.find((e) => e.t === "p") ?? this.st.blocks.find((e) => e.t === "p" && e.pid !== void 0);
			return {
				...this.emptyPara(t),
				pd: {},
				ps: t.ps,
				sid: t.sid
			};
		}, c = a, l = `${n}.${r}.${i}.0`;
		switch (e) {
			case "rowAbove":
				c = $t(a, r, !1, s), l = `${n}.${r}.0.0`;
				break;
			case "rowBelow":
				c = $t(a, r, !0, s), l = `${n}.${r + 1}.0.0`;
				break;
			case "colLeft":
				c = tn(a, o, !1, s);
				break;
			case "colRight":
				c = tn(a, o, !0, s), l = `${n}.${r}.${i + 1}.0`;
				break;
			case "delRow":
				c = en(a, r), l = `${n}.${Math.max(0, Math.min(r, (c?.rows.length ?? 1) - 1))}.0.0`;
				break;
			case "delCol":
				c = nn(a, o), l = `${n}.${r}.${Math.max(0, i - 1)}.0`;
				break;
			case "delTable": c = null;
		}
		if (c) c = {
			...c,
			tid: a.tid ?? this.nextPid++
		}, this.replaceBlocks(n, 1, [c], {
			a: {
				pa: l,
				o: 0
			},
			f: {
				pa: l,
				o: 0
			}
		});
		else {
			let e = this.st.blocks[n + 1];
			this.replaceBlocks(n, 1, [], e?.t === "p" ? {
				a: {
					pa: String(n),
					o: 0
				},
				f: {
					pa: String(n),
					o: 0
				}
			} : null);
		}
	}
	cellRange(e = this.input.sel()) {
		if (!e) return null;
		let t = kn(e.a.pa), n = kn(e.f.pa);
		if (t.length < 4 || n.length < 4 || t[0] !== n[0]) return null;
		let r = this.st.blocks[t[0]];
		if (r?.t !== "tbl") return null;
		let i = an(r, [t[1], t[2]], [n[1], n[2]]);
		return i ? {
			bi: t[0],
			t: r,
			rect: i,
			cells: on(r, i).length
		} : null;
	}
	putTable(e, t, n, r, i) {
		let a = Xt(n).at(r, i), o = `${e}.${a?.ri ?? r}.${a?.ci ?? 0}.0`;
		this.replaceBlocks(e, 1, [{
			...n,
			tid: t.tid ?? this.nextPid++
		}], {
			a: {
				pa: o,
				o: 0
			},
			f: {
				pa: o,
				o: 0
			}
		});
	}
	mergeCells() {
		let e = this.cellRange();
		if (!e) return !1;
		let t = cn(e.t, e.rect);
		return t ? (this.putTable(e.bi, e.t, t, e.rect.r0, e.rect.g0), !0) : !1;
	}
	unmergeCell() {
		let e = this.input.sel();
		if (!e || !e.f.pa.includes(".")) return !1;
		let [t, n, r] = kn(e.f.pa), i = this.st.blocks[t];
		if (i?.t !== "tbl") return !1;
		let a = Xt(i).cells.find((e) => e.ri === n && e.ci === r)?.g ?? 0, o = ln(i, n, r, (e) => {
			let t = e.blocks.find((e) => e.t === "p") ?? this.st.blocks.find((e) => e.t === "p" && e.pid !== void 0);
			return {
				...this.emptyPara(t),
				pd: {},
				ps: t.ps,
				sid: t.sid
			};
		});
		return o ? (this.putTable(t, i, o, n, a), !0) : !1;
	}
	setCellBorders(e, t = "0.5pt solid #000000") {
		let n = this.cellRange();
		n && this.putTable(n.bi, n.t, fn(n.t, n.rect, e, t), n.rect.r0, n.rect.g0);
	}
	setCellShade(e) {
		let t = this.cellRange();
		t && this.putTable(t.bi, t.t, pn(t.t, t.rect, (t) => ({
			...t,
			shd: e ?? void 0,
			set: {
				...t.set,
				shd: !0
			}
		})), t.rect.r0, t.rect.g0);
	}
	setCellVAlign(e) {
		let t = this.cellRange();
		t && this.putTable(t.bi, t.t, pn(t.t, t.rect, (t) => ({
			...t,
			vAlign: e === "top" ? void 0 : e,
			set: {
				...t.set,
				vAlign: !0
			}
		})), t.rect.r0, t.rect.g0);
	}
	distributeColumns() {
		let e = this.cellRange();
		e && this.putTable(e.bi, e.t, mn(e.t, e.cells > 1 ? e.rect : void 0), e.rect.r0, e.rect.g0);
	}
	setColumnWidths(e, t) {
		let n = this.st.blocks[e];
		n?.t !== "tbl" || t.length !== n.cols.length || t.some((e) => !(e > 0)) || this.replaceBlocks(e, 1, [{
			...n,
			cols: t.map((e) => +e.toFixed(2)),
			tid: n.tid ?? this.nextPid++
		}], this.input.lastSel);
	}
	async insertImages(e, t) {
		let n = t ?? this.input.sel();
		if (!n) return;
		let r = [];
		for (let t of e) {
			let e = (t.type.split("/")[1] ?? "png").replace("svg+xml", "svg").replace("jpeg", "jpg"), { rid: n, path: i } = await this.client.call("docx.image", await t.arrayBuffer(), e), a = await Vn(t), o = Math.min(1, this.contentW / Math.max(1, a.w * .75));
			r.push({
				t: "img",
				target: i,
				w: +(a.w * .75 * o).toFixed(1),
				h: +(a.h * .75 * o).toFixed(1),
				rid: n
			});
		}
		ge(this, n, [r], { label: "image" });
	}
	async setLink(e) {
		let t = this.input.sel();
		if (!t) return;
		if (!e) {
			this.patchRuns(t, (e) => ({
				...e,
				href: void 0,
				lk: void 0
			}));
			return;
		}
		let n = /^[a-z][\w+.-]*:/i.test(e) || e.startsWith("#") ? e : "https://" + e, r = await this.client.call("docx.link", n), i = {
			color: "#0563c1",
			u: "single"
		};
		I(t) ? ge(this, t, [[{
			t: "text",
			text: e,
			href: n,
			lk: r,
			s: {
				...de(this.para(t.a.pa)?.runs ?? [], t.a.o)?.s ?? {},
				...i
			},
			d: i
		}]], { label: "link" }) : this.patchRuns(t, (e) => ({
			...e,
			href: n,
			lk: r,
			s: {
				...e.s ?? {},
				...i
			},
			d: {
				...e.d ?? {},
				...i
			}
		}));
	}
	patchRuns(e, t) {
		let n = this.selectedParas(e);
		if (!n) return;
		let r = n.pas.map((e, r) => {
			let i = this.para(e), a = r === 0 ? n.s.o : 0, o = r === n.pas.length - 1 ? n.e.o : k(i.runs), [s, c] = le(i.runs, a), [l, u] = le(c, o - a);
			return this.withRuns(i, [
				...s,
				...l.map((e) => e.t === "text" ? t(e) : e),
				...u
			]);
		});
		this.replace(n.pas, r, e, { label: "format" });
	}
	insertPageBreak() {
		let e = this.input.sel();
		if (!e) return;
		let t = this.para(e.f.pa);
		if (!t || e.f.pa.includes(".")) return;
		let [n, r] = le(t.runs, e.f.o), [i, a] = this.split(t, n, r, !1), o = {
			...a,
			pb: !0,
			pd: {
				...a.pd ?? {},
				pageBreak: !0
			}
		};
		this.replace([e.f.pa], [i, o], {
			a: {
				pa: oe(e.f.pa, 1),
				o: 0
			},
			f: {
				pa: oe(e.f.pa, 1),
				o: 0
			}
		}, {
			label: "pagebreak",
			want: !0
		});
	}
	resizeImage(e) {
		let t = this.input.sel();
		if (!t) return;
		let [n] = fe(this, t);
		this.patchObjects(t, (t) => {
			if (t.t !== "img") return t;
			let n = e === "fit" ? this.contentW / t.w : e;
			return {
				...t,
				w: +(t.w * n).toFixed(1),
				h: +(t.h * n).toFixed(1),
				resized: !0
			};
		}), this.pendingSel = {
			a: n,
			f: {
				...n,
				o: n.o + 1
			}
		};
	}
	patchObjects(e, t) {
		let [n, r] = fe(this, e), i = this.para(n.pa);
		if (!i || n.pa !== r.pa) return;
		let [a, o] = le(i.runs, n.o), [s, c] = le(o, r.o - n.o);
		this.replace([n.pa], [this.withRuns(i, [
			...a,
			...s.map(t),
			...c
		])], e, { label: "image" });
	}
	pasteRich(e, t) {
		let n = Array.from(t.files ?? []).filter((e) => e.type.startsWith("image/"));
		if (n.length) return this.insertImages(n, e), !0;
		let r = t.getData("text/html");
		if (!r) return !1;
		let i = te(r);
		return i.length ? ((async () => {
			let t = /* @__PURE__ */ new Map();
			for (let e of i) for (let n of e.runs) n.t === "text" && n.href && !t.has(n.href) && t.set(n.href, await this.client.call("docx.link", n.href));
			let n = i.map((e) => e.runs.map((e) => e.t === "text" && e.href ? {
				...e,
				lk: t.get(e.href)
			} : e)), r = (e) => this.styles.find((t) => t.name.toLowerCase() === `heading ${e}`)?.id, a = i.map((e) => {
				if (e.heading || e.list) return (t) => {
					let n = { ...t.pd ?? {} }, i = e.heading ? r(e.heading) : void 0;
					return i && (n.style = i), e.list && (n.list = e.list), {
						...t,
						pd: n,
						sid: i ?? t.sid,
						edited: !0
					};
				};
			});
			ge(this, e, n, { label: "paste" }, a);
		})(), !0) : !1;
	}
	async applyCanon(e) {
		let t = this.input.sel();
		if (!t) return;
		let n = this.styles.find((t) => t.canon === e)?.id, r = null;
		n || (n = await this.canonId(e), r = this.input.readSel()), n && (this.setPara({ style: n }, {}, t), r && (this.pendingSel = r));
	}
	async canonId(e) {
		let t = this.styles.find((t) => t.canon === e)?.id;
		if (t) return t;
		let n = await this.client.call("docx.style", e);
		if (n) return this.styled(n), n.id || void 0;
	}
	taken = /* @__PURE__ */ new WeakSet();
	styleGen = 0;
	changedAt = /* @__PURE__ */ new Map();
	lookAt = /* @__PURE__ */ new WeakMap();
	passing = !1;
	heir = /* @__PURE__ */ new WeakMap();
	latest(e) {
		for (let t = this.heir.get(e); t; t = this.heir.get(e)) e = t;
		return e;
	}
	styled(e) {
		if (!this.taken.has(e) && (this.taken.add(e), this.styles = e.styles, this.onStyles?.(e.styles), e.changed?.length)) {
			e.headers && this.onHeaders?.(e.headers), this.styleGen++;
			for (let t of e.changed) this.changedAt.set(t, this.styleGen);
			this.onDirty?.(), this.catchUp();
		}
	}
	onPage;
	pageNow;
	paged(e) {
		this.taken.has(e) || (this.taken.add(e), this.pageNow = e.page, this.onPage?.(e.page), this.onDirty?.());
	}
	async setPage(e) {
		if (!Object.keys(e).length) return;
		let t = await this.client.call("docx.page", e);
		if (!t) return;
		this.paged(t);
		let n = this.input.lastSel ?? {
			a: {
				pa: "0",
				o: 0
			},
			f: {
				pa: "0",
				o: 0
			}
		};
		return this.history.push({
			pas: [],
			before: [],
			after: [],
			selBefore: n,
			selAfter: n,
			label: "page",
			t: Date.now(),
			page: {
				undo: t.undo,
				redo: e
			}
		}), this.future = [], this.emitState(this.input.sel() ?? n), t;
	}
	tracking = !1;
	author = () => "Me";
	onTracking;
	setTracking(e) {
		this.tracking = e, this.onTracking?.(e), this.emitState(this.input.sel());
	}
	allParas() {
		let e = [];
		return this.st.blocks.forEach((t, n) => {
			t.t === "p" ? t.pid !== void 0 && !t.ro && e.push({
				pa: String(n),
				p: t
			}) : t.t === "tbl" && t.rows.forEach((t, r) => t.cells.forEach((t, i) => t.blocks.forEach((t, a) => t.t === "p" && t.pid !== void 0 && !t.ro && e.push({
				pa: `${n}.${r}.${i}.${a}`,
				p: t
			}))));
		}), e;
	}
	changeCount() {
		return this.allParas().reduce((e, t) => e + Tn(t.p).length, 0);
	}
	review(e, t = !1) {
		let n = e ? "accept" : "reject", r = 0;
		if (t) {
			let t = this.allParas().filter((e) => wn(e.p)), i = [];
			for (let e of t) {
				let t = i[i.length - 1], n = t?.[t.length - 1];
				n && !n.pa.includes(".") && !e.pa.includes(".") && Number(e.pa) === Number(n.pa) + 1 ? t.push(e) : i.push([e]);
			}
			let a = this.history.length;
			for (let t of i) {
				let i = t.map(({ p: t }) => ({
					...t,
					runs: Cn(t.runs, 0, k(t.runs), e),
					edited: !0
				}));
				r += t.reduce((e, t) => e + Tn(t.p).length, 0), this.replace(t.map((e) => e.pa), i, {
					a: {
						pa: t[0].pa,
						o: 0
					},
					f: {
						pa: t[0].pa,
						o: 0
					}
				}, {
					label: n,
					want: !0,
					remount: !0
				});
			}
			let o = this.history.splice(Math.min(a, this.history.length));
			return o.length && this.history.push(o.length > 1 ? {
				...o[o.length - 1],
				group: o
			} : o[0]), r;
		}
		let i = this.input.sel();
		if (!i) return 0;
		let [a, o] = fe(this, i), s = this.span(a.pa, o.pa);
		if (!s) return 0;
		let c = s.map((t, n) => {
			let i = this.para(t), c = n === 0 ? a.o : 0, l = n === s.length - 1 ? o.o : k(i.runs);
			if (s.length === 1 && c === l) {
				let e = Tn(i).find((e) => e.a <= c && c <= e.b && (e.a < c || c < e.b || e.b > e.a));
				if (!e) return i;
				c = e.a, l = e.b;
			}
			return r += Tn({
				...i,
				runs: jn(i, c, l)
			}).length, {
				...i,
				runs: Cn(i.runs, c, l, e),
				edited: !0
			};
		});
		return r ? (this.replace(s, c, {
			a,
			f: a
		}, {
			label: n,
			want: !0,
			remount: !0
		}), r) : 0;
	}
	gotoChange(e) {
		let t = this.allParas(), n = this.input.sel(), [r, i] = n ? fe(this, n) : [null, null], a = (e > 0 ? i : r) ?? {
			pa: e > 0 ? "0" : String(this.st.blocks.length),
			o: 0
		}, o = t.flatMap((e) => Tn(e.p).map((t) => ({
			pa: e.pa,
			...t
		}))), s = (t) => {
			let n = this.cmp(t.pa, a.pa);
			return e > 0 ? n > 0 || n === 0 && t.a >= a.o && !(r && t.pa === r.pa && t.a === r.o && i && t.b === i.o) : n < 0 || n === 0 && t.b <= a.o && !(r && t.pa === r.pa && t.a === r.o);
		}, c = e > 0 ? o.find(s) : [...o].reverse().find(s);
		if (!c) return !1;
		let l = {
			a: {
				pa: c.pa,
				o: c.a
			},
			f: {
				pa: c.pa,
				o: c.b
			}
		};
		return this.pendingSel = l, this.input.lastSel = l, this.changed(), this.emitState(l), !0;
	}
	onHF;
	hfNow;
	hfed(e) {
		this.taken.has(e) || (this.taken.add(e), this.hfNow = {
			headers: e.headers,
			titlePg: e.titlePg
		}, this.onHF?.(this.hfNow), this.onDirty?.());
	}
	async setHeaderFooter(e) {
		if (!e.parts && !e.raw && e.titlePg === void 0) return;
		let t = await this.client.call("docx.hf", e);
		if (!t) return;
		this.hfed(t);
		let n = this.input.lastSel ?? {
			a: {
				pa: "0",
				o: 0
			},
			f: {
				pa: "0",
				o: 0
			}
		};
		return this.history.push({
			pas: [],
			before: [],
			after: [],
			selBefore: n,
			selAfter: n,
			label: "header",
			t: Date.now(),
			hf: {
				undo: t.undo,
				redo: e
			}
		}), this.future = [], this.emitState(this.input.sel() ?? n), t;
	}
	rehf(e) {
		this.client.call("docx.hf", e).then((e) => e && this.hfed(e)).catch((e) => console.error("[office-engine] header / footer change failed", e));
	}
	repage(e) {
		this.client.call("docx.page", e).then((e) => e && this.paged(e)).catch((e) => console.error("[office-engine] page setup failed", e));
	}
	async setStyle(e, t) {
		let n = await this.client.call("docx.styleSet", e, t);
		return n && this.styled(n), n;
	}
	restyle(e, t) {
		this.setStyle(e, t).catch((e) => console.error("[office-engine] style change failed", e));
	}
	async updateStyle(e) {
		let t = this.input.sel(), n = t && this.selectedParas(t), r = n && this.container(n.s.pa), i = n && this.para(n.s.pa);
		if (!t || !n || !r || !i) return;
		let a = n.pas.map((e) => this.para(e)), s = e.startsWith("@") ? await this.canonId(e.slice(1)) : e;
		if (!s) return;
		let c = this.partsOf(r.list, i.pid, r.at), l = ((await this.client.call("docx.convert", [o(c)], !0))?.[0] ?? []).filter((e) => e.t === "p")[c.indexOf(i)];
		if (!l || k(l.runs) !== k(i.runs)) return;
		let u = I(t) ? n.s.o : n.s.o + +(k(i.runs) > n.s.o), d = de(l.runs, u), f = {
			...Fn(l.ps),
			...d ? {
				...Pn(d.s),
				font: Ln(d.s.font)
			} : {
				sz: l.markSz,
				font: Ln(l.markFont)
			}
		}, p = await this.setStyle(s, f);
		if (!p || p.missing) return;
		let m = p.changed.length ? {
			id: s,
			undo: p.undo,
			redo: f
		} : void 0, h = () => {
			let e = this.latest(i), t = this.locate(i.pid).find((t) => t.list[t.index] === e)?.pa, n = t === void 0 ? [] : a.map((e, n) => oe(t, n));
			return n.length > 0 && n.every((e, t) => this.para(e) === this.latest(a[t])) ? n : null;
		}, g = () => m ? (this.history.push({
			pas: [],
			before: [],
			after: [],
			selBefore: t,
			selAfter: t,
			label: "style",
			t: Date.now(),
			style: m
		}), this.future = [], this.emitState(this.input.sel()), !0) : !1;
		if (!h()) return g();
		if (!m && a.every((e) => e.sid === s)) return !1;
		let _ = a.map((e) => this.latest(e)), v = Pn(de(i.runs, u)?.s), y = Fn(i.ps), b = _.map((e) => ({
			...e,
			pd: {
				...e.pd ?? {},
				style: s
			},
			sid: s,
			edited: !0
		})), x = b.map((e) => {
			let t = { ...e.pd }, n = Fn(e.ps);
			for (let e of Nn) f[e] !== void 0 && n[e] === y[e] && (t[e] = null);
			let r = e.runs.map((e) => {
				if (e.t !== "text" || !d) return e;
				let t = Pn(e.s), n = { ...e.d ?? {} };
				for (let e of Mn) t[e] === v[e] && (n[e] = null);
				return {
					...e,
					d: n
				};
			});
			return {
				...e,
				pd: t,
				runs: r
			};
		}), S = await this.client.call("docx.convert", [...b, ...x].map((e) => o([e]))), C = h();
		if (!C) return g();
		let w = (e) => (S?.[e] ?? []).find((e) => e.t === "p"), T = b.map((e, t) => {
			let n = w(t), r = w(t + b.length);
			if (!n || !r) return e;
			let i = In(n), a = In(r), o = 0, s = e.runs.map((e, n) => {
				let r = o;
				o += F(e);
				for (let t = r; t < o; t++) if (i[t] !== a[t]) return e;
				return x[t].runs[n];
			}), c = JSON.stringify(Fn(n.ps)) === JSON.stringify(Fn(r.ps)) ? x[t].pd : e.pd;
			return {
				...e,
				pd: c,
				runs: ue(s)
			};
		});
		return this.replace(C, T, this.input.sel() ?? t, {
			label: "style",
			want: !0
		}), m && (this.history[this.history.length - 1].style = m), !!m;
	}
	behind(e, t) {
		let n = this.changedAt.get(e.sid || t);
		return n !== void 0 && (this.lookAt.get(e) ?? 0) < n;
	}
	groups() {
		let e = [], t = (t, n) => {
			let r;
			t.forEach((t, i) => {
				if (t.t !== "p" || t.pid === void 0) return void (r = void 0);
				r && r.pid === t.pid ? e[e.length - 1].parts.push(t) : e.push({
					pa: n(i),
					parts: [t]
				}), r = t;
			});
		};
		return t(this.st.blocks, String), this.st.blocks.forEach((e, n) => {
			e.t === "tbl" && e.rows.forEach((e, r) => e.cells.forEach((e, i) => t(e.blocks, (e) => `${n}.${r}.${i}.${e}`)));
		}), e;
	}
	catchUp() {
		this.changedAt.size && !this.passing && (this.passing = !0, this.pass().catch((e) => console.error("[office-engine] restyle failed", e)));
	}
	async pass() {
		try {
			let e = /* @__PURE__ */ new Map(), t = performance.now();
			for (;;) {
				performance.now() - t > 40 && (await new Promise((e) => setTimeout(e, 0)), t = performance.now());
				let n = this.styleGen, r = this.styles.find((e) => e.canon === "normal")?.id ?? "", i = this.groups().filter((t) => t.parts.some((e) => this.behind(e, r)) && (e.get(t.parts[0].pid) ?? 0) < 3).slice(0, 200);
				if (!i.length) return;
				let a = await this.client.call("docx.convert", i.map((e) => o(e.parts)));
				for (; this.input.isComposing;) await new Promise((e) => setTimeout(e, 50));
				if (n !== this.styleGen) {
					e.clear();
					continue;
				}
				let s = new Map(this.groups().map((e) => [e.parts[0], e])), c = this.input.readSel(), l = !1, u = !1;
				for (let [t, r] of i.entries()) {
					let i = r.parts[0].pid, o = s.get(r.parts[0]);
					if (!o || o.parts.length !== r.parts.length || o.parts.some((e, t) => e !== r.parts[t])) {
						let t = (e.get(i) ?? 0) + 1;
						e.set(i, t), t >= 3 && this.stale.add(i);
						continue;
					}
					let d = (a?.[t] ?? []).filter((e) => e.t === "p"), f = d.length === r.parts.length ? r.parts.map((e, t) => Rn(e, d[t])) : [];
					if (!f.length || f.some((e) => !e)) {
						for (let e of r.parts) this.lookAt.set(e, n);
						this.stale.add(i);
					} else f.forEach((e, t) => {
						let i = oe(o.pa, t);
						this.put(i, e), this.lookAt.set(e, n), this.heir.set(r.parts[t], e), u ||= c?.a.pa === i || c?.f.pa === i;
					}), r.parts.some((e) => e.caret) && this.stale.add(i), l = !0;
				}
				l && (u && c && !this.pendingSel && (this.pendingSel = c), this.changed(), this.emitState(this.input.sel()));
			}
		} finally {
			this.passing = !1;
		}
	}
	selectObject(e, t) {
		let n = {
			a: {
				pa: e,
				o: t
			},
			f: {
				pa: e,
				o: t + 1
			}
		};
		this.input.restore(n), this.onSelection(n);
	}
	imageSel() {
		let e = this.input.sel(), t = e && this.state(e)?.img;
		return t ? {
			a: {
				pa: t.pa,
				o: t.o
			},
			f: {
				pa: t.pa,
				o: t.o + 1
			}
		} : null;
	}
	patchImage(e) {
		let t = this.imageSel();
		t && (this.patchObjects(t, (t) => t.t === "img" ? e(t) : t), this.pendingSel = t);
	}
	setImageSize(e, t) {
		this.patchImage((n) => ({
			...n,
			w: +Math.max(4, e).toFixed(1),
			h: +Math.max(4, t).toFixed(1),
			resized: !0
		}));
	}
	imageOriginal(e, t) {
		let n = Math.min(1, this.contentW / Math.max(1, e * .75));
		this.setImageSize(e * .75 * n, t * .75 * n);
	}
	setAltText(e) {
		this.patchImage((t) => ({
			...t,
			alt: e || void 0,
			altSet: !0
		}));
	}
	async replaceImage(e) {
		let t = this.imageSel();
		if (!t) return;
		let n = (e.type.split("/")[1] ?? "png").replace("svg+xml", "svg").replace("jpeg", "jpg"), { rid: r, path: i } = await this.client.call("docx.image", await e.arrayBuffer(), n), a = await Vn(e);
		this.input.restore(t), this.patchImage((e) => {
			let t = +(e.w * (a.h / Math.max(1, a.w))).toFixed(1);
			return {
				...e,
				target: i,
				rid: r,
				repl: !!e.src,
				h: t,
				resized: !0
			};
		});
	}
	deleteSelection() {
		let e = this.input.sel();
		e && !I(e) && _e(this, e, "");
	}
	insertText(e) {
		let t = this.input.sel();
		t && _e(this, t, e);
	}
	copyFormat() {
		if (this.painter) {
			this.painter = null, this.onPainter?.(!1);
			return;
		}
		let e = this.state();
		e && (this.painter = {
			b: e.b,
			i: e.i,
			u: e.u ? "single" : "none",
			strike: e.strike,
			color: e.color ?? null,
			hl: e.hl ?? null,
			va: e.va ?? null,
			sz: e.sz,
			font: e.font ? /^\s*"?([^",]+)/.exec(e.font)?.[1] ?? e.font : void 0
		}, this.onPainter?.(!0));
	}
	applyPainter() {
		let e = this.painter, t = this.input.readSel();
		if (!e || !t || I(t)) return !1;
		this.painter = null, this.onPainter?.(!1);
		let n = {};
		for (let [t, r] of Object.entries(e)) t === "font" ? n.font = r ? c(r) : void 0 : t === "u" ? n.u = r : n[t] = r === null ? void 0 : r;
		return this.format(n, e), !0;
	}
	state(e = this.input.sel()) {
		if (!e) return null;
		let [t] = fe(this, e), n = this.para(t.pa);
		if (!n) return null;
		let r = de(n.runs, I(e) ? t.o : t.o + +(k(n.runs) > t.o)), i = {
			...r?.s ?? {},
			...I(e) ? this.pend?.s ?? {} : {}
		}, [, a] = fe(this, e), o;
		if (t.pa === a.pa && a.o === t.o + 1) {
			let [, e] = le(n.runs, t.o), r = e[0];
			r?.t === "img" && (o = {
				w: r.w,
				h: r.h,
				alt: r.alt,
				target: r.target,
				pa: t.pa,
				o: t.o
			});
		}
		return {
			line: n.pd?.line ?? (n.ps.lineRule === "auto" || !n.ps.lineRule ? n.ps.line : void 0),
			va: i.va,
			link: r?.href,
			inTable: t.pa.includes("."),
			cells: this.cellState(e),
			tracking: this.tracking,
			inChange: (() => {
				let [, r] = fe(this, e);
				return Tn(n).some((e) => t.pa !== r.pa || e.a <= r.o && t.o <= e.b);
			})(),
			img: o,
			b: !!i.b,
			i: !!i.i,
			u: !!i.u && i.u !== "none",
			strike: !!i.strike,
			color: i.color,
			hl: i.hl,
			sz: i.sz ?? n.markSz ?? this.defaultSz,
			font: i.font ?? n.markFont ?? this.defaultFont,
			align: n.ps.align ?? "left",
			style: n.sid,
			lst: n.lst,
			canUndo: this.canUndo,
			canRedo: this.canRedo
		};
	}
	cellState(e) {
		let t = this.cellRange(e);
		if (!t) return;
		let [n, r, i] = kn(e.f.pa), a = this.st.blocks[n].rows[r]?.cells[i];
		return {
			n: t.cells,
			merged: !!a && (a.colSpan > 1 || a.rowSpan > 1),
			shd: a?.shd,
			vAlign: a?.vAlign ?? "top"
		};
	}
	emitState(e) {
		let t = e ? this.state(e) : null;
		this.onState?.(t), this.onImage?.(t?.img ?? null);
	}
	onSelection(e) {
		e && this.pend && (e.a.pa !== this.pend.at.pa || e.a.o !== this.pend.at.o) && (this.pend = null), this.markCells(e), this.emitState(e);
	}
	markCells(e) {
		let t = this.input.root;
		if (!t) return;
		t.querySelectorAll(".de-cell-sel").forEach((e) => e.classList.remove("de-cell-sel"));
		let n = e ? this.cellRange(e) : null;
		if (!(!n || n.cells < 2)) for (let e of on(n.t, n.rect)) t.querySelector(`[data-pa^="${n.bi}.${e.ri}.${e.ci}."]`)?.closest("td")?.classList.add("de-cell-sel");
	}
};
function Vn(e) {
	return new Promise((t) => {
		let n = URL.createObjectURL(e), r = new Image();
		r.onload = () => {
			t({
				w: r.naturalWidth || 300,
				h: r.naturalHeight || 200
			}), URL.revokeObjectURL(n);
		}, r.onerror = () => {
			t({
				w: 300,
				h: 200
			}), URL.revokeObjectURL(n);
		}, r.src = n;
	});
}
// src/react/comments/Comments.ts
var Hn = class {
	client;
	list = /* @__PURE__ */ new Map();
	state = {
		rev: 0,
		open: !1,
		active: null,
		draft: null,
		showResolved: !1,
		notice: null
	};
	host = null;
	opts = {};
	me = { name: "Me" };
	canComment = !1;
	loaded = !1;
	subs = /* @__PURE__ */ new Set();
	offs = [];
	touchTimer;
	placedCache = null;
	constructor(e) {
		this.client = e, this.offs.push(e.on("comment", ({ id: e, c: t }) => {
			t ? this.list.set(e, t) : this.list.delete(e), !t && this.state.active === e ? this.set({ active: null }) : this.set({});
		})), e.call("comments.list").then((e) => {
			for (let t of e) this.list.has(t.id) || this.list.set(t.id, t);
			this.loaded = !0, this.set({});
		}).catch((e) => console.warn("[office-engine] comments not loaded:", e.message));
	}
	dispose() {
		this.offs.forEach((e) => e()), clearTimeout(this.touchTimer), this.subs.clear();
	}
	subscribe = (e) => (this.subs.add(e), () => {
		this.subs.delete(e);
	});
	snapshot = () => this.state;
	set(e) {
		this.state = {
			...this.state,
			...e,
			rev: this.state.rev + 1
		};
		for (let e of this.subs) e();
	}
	touch() {
		this.touchTimer ||= setTimeout(() => {
			this.touchTimer = void 0, this.set({});
		}, 250);
	}
	setHost(e) {
		this.host = e, this.set({});
	}
	threads() {
		let e = this.placedCache;
		if (e && e.rev === this.state.rev && e.host === this.host) return e.out;
		let t = this.host ? this.host.placed(h(this.list.values())) : [];
		return this.placedCache = {
			rev: this.state.rev,
			host: this.host,
			out: t
		}, t;
	}
	visible() {
		return this.threads().filter((e) => !e.root.done);
	}
	isMine(e) {
		return this.me.id ? e.author.id === this.me.id : !e.author.id && e.author.name === this.me.name;
	}
	toggle(e = !this.state.open) {
		this.set(e ? { open: e } : {
			open: e,
			draft: null,
			notice: null
		});
	}
	select(e, t = !0) {
		e && !this.state.open ? this.set({
			open: !0,
			active: e,
			notice: null
		}) : e !== this.state.active && this.set({
			active: e,
			notice: null
		}), e && t && this.host?.reveal(e);
	}
	start(e) {
		if (!this.canComment || !this.host) return !1;
		let t = e ?? this.host.pending();
		return t ? t.existing ? (this.select(t.existing), !0) : (this.set({
			open: !0,
			draft: t,
			active: null,
			notice: null
		}), !0) : (this.set({
			open: !0,
			draft: null,
			notice: this.host.hint
		}), !1);
	}
	cancelDraft() {
		this.state.draft && this.set({ draft: null });
	}
	dismiss() {
		this.state.notice && this.set({ notice: null });
	}
	setShowResolved(e) {
		this.set({ showResolved: e });
	}
	author() {
		let e = this.me;
		return {
			name: e.name,
			...e.id ? { id: e.id } : {},
			initials: e.initials ?? d(e.name)
		};
	}
	async write(e, t) {
		try {
			return await this.client.call("comments.set", e, t), !0;
		} catch (e) {
			return this.set({ notice: `Couldn't save the comment: ${e.message}` }), !1;
		}
	}
	quoteOf(e) {
		return this.threads().find((t) => t.root.id === e)?.quote ?? "";
	}
	participants(e, t) {
		let n = /* @__PURE__ */ new Map();
		for (let r of this.list.values()) {
			if (r.id === t || r.id !== e && r.parent !== e || this.isMine(r)) continue;
			let i = r.author.id ?? r.author.name;
			n.has(i) || n.set(i, r.author);
		}
		return [...n.values()];
	}
	emit(e, t, n = []) {
		let r = t.parent ? this.list.get(t.parent) ?? t : t;
		try {
			this.opts.onEvent?.({
				type: e,
				comment: t,
				thread: r,
				mentioned: n,
				participants: this.participants(r.id, t.id),
				quote: this.quoteOf(r.id)
			});
		} catch (e) {
			console.error("[office-engine] comment event handler failed", e);
		}
	}
	async post(e, n) {
		let r = this.state.draft, i = this.host;
		if (!r || !i || !e.trim()) return !1;
		let a = ie(i.kind), o = {
			id: a,
			author: this.author(),
			time: t(),
			text: e.trim(),
			...n.length ? { mentions: n } : {},
			...r.at ? { at: r.at } : {}
		};
		return await this.write(a, o) ? i.attach && !await i.attach(a, r) ? (await this.write(a, null), this.set({
			...this.state.draft === r ? { draft: null } : {},
			notice: "The commented text is no longer there"
		}), !1) : (this.set(this.state.draft === r ? {
			draft: null,
			active: a
		} : {}), this.emit("add", o, n), !0) : !1;
	}
	async reply(e, n, r) {
		let i = this.list.get(e);
		if (!i || !n.trim()) return !1;
		let a = ie(this.host?.kind ?? "docx"), o = {
			id: a,
			parent: e,
			author: this.author(),
			time: t(),
			text: n.trim(),
			...r.length ? { mentions: r } : {}
		};
		return i.done && !await this.write(e, {
			...i,
			done: void 0
		}) || !await this.write(a, o) ? !1 : (this.emit("reply", o, r), !0);
	}
	async edit(e, t, n) {
		let r = this.list.get(e);
		if (!r || !t.trim()) return !1;
		let i = {
			...r,
			text: t.trim()
		};
		if (n.length ? i.mentions = n : delete i.mentions, !await this.write(e, i)) return !1;
		let a = new Set((r.mentions ?? []).map((e) => e.id ?? e.name));
		return this.emit("edit", i, n.filter((e) => !a.has(e.id ?? e.name))), !0;
	}
	async remove(e) {
		let t = this.list.get(e);
		if (!t) return !1;
		let n = this.quoteOf(t.parent ?? e);
		if (!await this.write(e, null)) return !1;
		try {
			this.opts.onEvent?.({
				type: "delete",
				comment: t,
				thread: t.parent ? this.list.get(t.parent) ?? t : t,
				mentioned: [],
				participants: this.participants(t.parent ?? e, e),
				quote: n
			});
		} catch (e) {
			console.error("[office-engine] comment event handler failed", e);
		}
		return !0;
	}
	async resolve(e, t) {
		let n = this.list.get(e);
		if (!n || n.parent || !!n.done === t) return !1;
		let r = { ...n };
		return t ? r.done = !0 : delete r.done, await this.write(e, r) ? (t && this.state.active === e && !this.state.showResolved && this.set({ active: null }), this.emit(t ? "resolve" : "reopen", r), !0) : !1;
	}
	async people(e) {
		let t = this.opts.mentions;
		if (!t) return [];
		let n = e.trim().toLowerCase();
		return (typeof t == "function" ? await t(e) : t.filter((e) => !n || e.name.toLowerCase().includes(n) || (e.id ?? "").toLowerCase().includes(n))).slice(0, 8);
	}
}, Un = Ee(null), Wn = () => z(Un), Gn = {
	rev: 0,
	open: !1,
	active: null,
	draft: null,
	showResolved: !1,
	notice: null
}, Kn = () => () => {};
function qn(e) {
	return Pe(e?.subscribe ?? Kn, e ? e.snapshot : () => Gn, e ? e.snapshot : () => Gn);
}
function Jn(e, t, n) {
	let r = (t) => `${e} [data-cm~="${t.replace(/[^\w-]/g, (e) => `\\${e.codePointAt(0).toString(16)} `)}"]`, i = "";
	return t.length && (i += `${t.map(r).join(",")}{background-image:linear-gradient(var(--de-cm-bg),var(--de-cm-bg))!important;cursor:pointer}`), n && t.includes(n) && (i += `${r(n)}{background-image:linear-gradient(var(--de-cm-on),var(--de-cm-on))!important;box-shadow:0 2px 0 var(--de-cm-line)}`), i;
}
var Yn = `${Q}${Q === "⌘" ? "⌥" : "Alt+"}M`;
function Xn(e) {
	let t = e.id ?? e.name, n = 0;
	for (let e = 0; e < t.length; e++) n = n * 31 + t.charCodeAt(e) >>> 0;
	return me[n % me.length];
}
function Zn(e, t) {
	let n = Date.parse(e);
	if (!Number.isFinite(n)) return "";
	let r = Math.max(0, (t - n) / 1e3);
	if (r < 45) return "just now";
	if (r < 3600) return `${Math.round(r / 60)} min ago`;
	if (r < 86400) return `${Math.round(r / 3600)} h ago`;
	if (r < 604800) return `${Math.round(r / 86400)} d ago`;
	let i = new Date(n);
	return i.toLocaleDateString(void 0, {
		month: "short",
		day: "numeric",
		...i.getFullYear() === new Date(t).getFullYear() ? {} : { year: "numeric" }
	});
}
function Qn({ c: e }) {
	let t = (e.mentions ?? []).map((e) => "@" + e.name).sort((e, t) => t.length - e.length);
	if (!t.length) return /* @__PURE__ */ W("div", {
		className: "de-cm-text",
		children: e.text
	});
	let n = [], r = e.text;
	for (let e = 0; r; e++) {
		let i = -1, a = "";
		for (let e of t) {
			let t = r.indexOf(e);
			t >= 0 && (i < 0 || t < i) && (i = t, a = e);
		}
		if (i < 0) {
			n.push(r);
			break;
		}
		i > 0 && n.push(r.slice(0, i)), n.push(/* @__PURE__ */ W("span", {
			className: "de-cm-at",
			children: a
		}, e)), r = r.slice(i + a.length);
	}
	return /* @__PURE__ */ W("div", {
		className: "de-cm-text",
		children: n
	});
}
function $n({ u: e }) {
	return /* @__PURE__ */ W("span", {
		className: "de-cm-ava",
		style: { background: Xn(e) },
		"aria-hidden": !0,
		children: (e.initials || d(e.name)).slice(0, 2)
	});
}
function er(e) {
	let { ctl: t } = e, [n, r] = H(e.initial ?? ""), [i, a] = H(e.mentions ?? []), [o, s] = H(null), [c, l] = H(!1), u = V(null), d = V(0), f = V(null), p = !!t.opts.mentions;
	je(() => {
		let e = u.current;
		e && (e.style.height = "auto", e.style.height = `${Math.min(e.scrollHeight, 200)}px`, f.current !== null && (e.focus(), e.setSelectionRange(f.current, f.current), f.current = null));
	}, [n]), B(() => {
		if (!e.autoFocus) return;
		let t = u.current;
		t?.focus({ preventScroll: !0 }), t?.setSelectionRange(t.value.length, t.value.length);
	}, [e.autoFocus]);
	let m = (e, n) => {
		if (!p) return;
		let r = /(^|[\s(])@([^\s@]{0,30}(?: [^\s@]{0,30})?)$/.exec(e.slice(0, n));
		if (!r) return s(null);
		let i = n - r[2].length - 1, a = ++d.current;
		t.people(r[2]).then((e) => {
			if (a === d.current) {
				if (!e.length && r[2].includes(" ")) return s(null);
				s({
					at: i,
					end: n,
					list: e,
					hi: 0
				});
			}
		});
	}, h = (e) => {
		if (!o) return;
		let t = `@${e.name} `, i = n.slice(0, o.at) + t + n.slice(o.end);
		r(i), a((t) => t.some((t) => (t.id ?? t.name) === (e.id ?? e.name)) ? t : [...t, e]), s(null), d.current++, f.current = o.at + t.length;
	}, g = async () => {
		if (c || !n.trim()) return;
		l(!0);
		let t = i.filter((e) => n.includes("@" + e.name)), o = await e.onSubmit(n, t);
		l(!1), o && (r(""), a([]));
	};
	return /* @__PURE__ */ G("div", {
		className: "de-cm-compose",
		onClick: (e) => e.stopPropagation(),
		children: [
			/* @__PURE__ */ W("textarea", {
				ref: u,
				rows: 1,
				value: n,
				placeholder: e.placeholder,
				"aria-label": e.placeholder,
				disabled: c,
				onChange: (e) => {
					r(e.target.value), m(e.target.value, e.target.selectionStart);
				},
				onKeyDown: (t) => {
					if (t.stopPropagation(), !t.nativeEvent.isComposing) {
						if (o?.list.length) {
							if (t.key === "ArrowDown" || t.key === "ArrowUp") {
								t.preventDefault();
								let e = t.key === "ArrowDown" ? 1 : -1;
								s({
									...o,
									hi: (o.hi + e + o.list.length) % o.list.length
								});
								return;
							}
							if (t.key === "Enter" || t.key === "Tab") {
								t.preventDefault(), h(o.list[o.hi]);
								return;
							}
						}
						t.key === "Escape" ? (t.preventDefault(), o ? s(null) : e.onCancel?.()) : t.key === "Enter" && !t.shiftKey && (t.preventDefault(), g());
					}
				},
				onBlur: () => setTimeout(() => s(null), 150)
			}),
			o && o.list.length > 0 && /* @__PURE__ */ W("div", {
				className: "de-cm-pop",
				role: "listbox",
				children: o.list.map((e, t) => /* @__PURE__ */ G("button", {
					type: "button",
					role: "option",
					"aria-selected": t === o.hi,
					className: t === o.hi ? "on" : void 0,
					onMouseDown: (t) => {
						t.preventDefault(), h(e);
					},
					children: [/* @__PURE__ */ W($n, { u: e }), /* @__PURE__ */ W("span", { children: e.name })]
				}, e.id ?? e.name))
			}),
			/* @__PURE__ */ G("div", {
				className: "de-cm-actions",
				children: [
					p && /* @__PURE__ */ W("span", {
						className: "de-cm-tip",
						children: "@ to mention"
					}),
					e.onCancel && /* @__PURE__ */ W("button", {
						type: "button",
						className: "de-btn",
						onClick: e.onCancel,
						children: "Cancel"
					}),
					/* @__PURE__ */ W("button", {
						type: "button",
						className: "de-btn de-btn-primary",
						disabled: c || !n.trim(),
						onClick: () => void g(),
						children: e.submit
					})
				]
			})
		]
	});
}
function tr({ ctl: e, c: t, root: n, now: r, onMenu: i }) {
	let [a, o] = H(!1), s = e.isMine(t), c = e.canComment;
	return /* @__PURE__ */ G("div", {
		className: "de-cm-item",
		"data-comment": t.id,
		children: [
			/* @__PURE__ */ G("div", {
				className: "de-cm-head",
				children: [
					/* @__PURE__ */ W($n, { u: t.author }),
					/* @__PURE__ */ G("div", {
						className: "de-cm-who",
						children: [/* @__PURE__ */ W("span", {
							className: "de-cm-name",
							children: t.author.name
						}), /* @__PURE__ */ W("time", {
							className: "de-cm-time",
							dateTime: t.time,
							title: t.time ? new Date(t.time).toLocaleString() : void 0,
							children: Zn(t.time, r)
						})]
					}),
					n && c && /* @__PURE__ */ W("button", {
						type: "button",
						className: "de-tb de-cm-icon",
						title: t.done ? "Reopen" : "Resolve",
						"aria-label": t.done ? "Reopen thread" : "Resolve thread",
						onClick: (n) => {
							n.stopPropagation(), e.resolve(t.id, !t.done);
						},
						children: /* @__PURE__ */ W(J, {
							name: t.done ? "rotateCcw" : "check",
							size: 16
						})
					}),
					c && s && /* @__PURE__ */ W("button", {
						type: "button",
						className: "de-tb de-cm-icon",
						title: "More",
						"aria-label": "More actions",
						"aria-haspopup": "menu",
						onClick: (e) => {
							e.stopPropagation(), i(t, e.currentTarget);
						},
						children: /* @__PURE__ */ W(J, {
							name: "more",
							size: 16
						})
					})
				]
			}),
			a ? /* @__PURE__ */ W(er, {
				ctl: e,
				placeholder: "Edit comment",
				submit: "Save",
				initial: t.text,
				mentions: t.mentions,
				autoFocus: !0,
				onSubmit: async (n, r) => {
					let i = await e.edit(t.id, n, r);
					return i && o(!1), i;
				},
				onCancel: () => o(!1)
			}) : /* @__PURE__ */ W(Qn, { c: t }),
			/* @__PURE__ */ W(rr, {
				id: t.id,
				start: () => o(!0)
			})
		]
	});
}
var nr = /* @__PURE__ */ new Map();
function rr({ id: e, start: t }) {
	return B(() => (nr.set(e, t), () => {
		nr.get(e) === t && nr.delete(e);
	}), [e, t]), null;
}
function ir({ ctl: e, t, active: n, now: r, onMenu: i }) {
	let { root: a, replies: o } = t, s = o.length > 2 ? o.length - 1 : 0;
	return /* @__PURE__ */ G("div", {
		className: "de-cm-card" + (n ? " on" : "") + (a.done ? " done" : ""),
		"data-thread": a.id,
		role: "button",
		tabIndex: 0,
		"aria-pressed": n,
		onClick: () => e.select(a.id),
		onKeyDown: (t) => {
			t.target === t.currentTarget && (t.key === "Enter" || t.key === " ") && (t.preventDefault(), e.select(a.id));
		},
		children: [
			t.quote && /* @__PURE__ */ W("div", {
				className: "de-cm-quote",
				children: t.quote
			}),
			a.done && /* @__PURE__ */ W("div", {
				className: "de-cm-resolved",
				children: "Resolved"
			}),
			/* @__PURE__ */ W(tr, {
				ctl: e,
				c: a,
				root: !0,
				now: r,
				onMenu: i
			}),
			!n && s > 0 && /* @__PURE__ */ W("div", {
				className: "de-cm-count",
				children: s === 1 ? "1 more reply" : `${s} more replies`
			}),
			o.slice(n ? 0 : s).map((t) => /* @__PURE__ */ W(tr, {
				ctl: e,
				c: t,
				now: r,
				onMenu: i
			}, t.id)),
			n && e.canComment && /* @__PURE__ */ W(er, {
				ctl: e,
				placeholder: a.done ? "Reply and reopen…" : "Reply…",
				submit: "Reply",
				onSubmit: (t, n) => e.reply(a.id, t, n)
			})
		]
	});
}
function ar({ ctl: e }) {
	let t = qn(e), [n, r] = H(null), [i, a] = H(null), [o, s] = H(() => Date.now()), c = V(null);
	B(() => {
		let e = setInterval(() => s(Date.now()), 6e4);
		return () => clearInterval(e);
	}, []);
	let l = e.threads(), u = t.showResolved ? l : l.filter((e) => !e.root.done), d = l.filter((e) => !e.root.done).length, f = l.length - d;
	B(() => {
		t.active && c.current?.querySelector(`[data-thread="${CSS.escape(t.active)}"]`)?.scrollIntoView({ block: "nearest" });
	}, [t.active]);
	let p = (e, t) => {
		let n = t.getBoundingClientRect();
		r({
			c: e,
			x: n.left,
			y: n.bottom + 4
		});
	};
	return /* @__PURE__ */ G("aside", {
		className: "de-cm-panel",
		"aria-label": "Comments",
		onKeyDown: (n) => n.key === "Escape" && t.draft && e.cancelDraft(),
		children: [
			/* @__PURE__ */ G("div", {
				className: "de-cm-bar",
				children: [
					/* @__PURE__ */ G("span", {
						className: "de-cm-title",
						children: ["Comments", d > 0 && /* @__PURE__ */ W("span", {
							className: "de-cm-badge",
							children: d
						})]
					}),
					f > 0 && /* @__PURE__ */ W("button", {
						type: "button",
						className: "de-btn de-cm-filter" + (t.showResolved ? " on" : ""),
						"aria-pressed": t.showResolved,
						onClick: () => e.setShowResolved(!t.showResolved),
						children: t.showResolved ? "Hide resolved" : `Resolved (${f})`
					}),
					/* @__PURE__ */ W("button", {
						type: "button",
						className: "de-tb",
						title: "Close comments",
						"aria-label": "Close comments",
						onClick: () => e.toggle(!1),
						children: /* @__PURE__ */ W(J, {
							name: "close",
							size: 16
						})
					})
				]
			}),
			/* @__PURE__ */ G("div", {
				className: "de-cm-list",
				ref: c,
				children: [
					e.canComment && !t.draft && /* @__PURE__ */ G("button", {
						type: "button",
						className: "de-cm-new",
						onClick: () => e.start(),
						title: `Comment on the selection (${Yn})`,
						children: [
							/* @__PURE__ */ W(J, {
								name: "commentAdd",
								size: 16
							}),
							"New comment",
							/* @__PURE__ */ W("span", {
								className: "de-cm-keys",
								children: Yn
							})
						]
					}),
					t.notice && /* @__PURE__ */ G("div", {
						className: "de-cm-notice",
						role: "status",
						children: [/* @__PURE__ */ W("span", { children: t.notice }), /* @__PURE__ */ W("button", {
							type: "button",
							className: "de-tb",
							"aria-label": "Dismiss",
							onClick: () => e.dismiss(),
							children: /* @__PURE__ */ W(J, {
								name: "close",
								size: 14
							})
						})]
					}),
					t.draft && /* @__PURE__ */ G("div", {
						className: "de-cm-card on de-cm-draft",
						children: [
							t.draft.quote && /* @__PURE__ */ W("div", {
								className: "de-cm-quote",
								children: t.draft.quote
							}),
							/* @__PURE__ */ G("div", {
								className: "de-cm-head",
								children: [/* @__PURE__ */ W($n, { u: e.me }), /* @__PURE__ */ W("div", {
									className: "de-cm-who",
									children: /* @__PURE__ */ W("span", {
										className: "de-cm-name",
										children: e.me.name
									})
								})]
							}),
							/* @__PURE__ */ W(er, {
								ctl: e,
								placeholder: "Comment or add others with @",
								submit: "Comment",
								autoFocus: !0,
								onSubmit: (t, n) => e.post(t, n),
								onCancel: () => e.cancelDraft()
							})
						]
					}),
					u.map((n) => /* @__PURE__ */ W(ir, {
						ctl: e,
						t: n,
						active: t.active === n.root.id,
						now: o,
						onMenu: p
					}, n.root.id)),
					!u.length && !t.draft && /* @__PURE__ */ W("div", {
						className: "de-cm-empty",
						children: l.length ? "Every comment is resolved." : e.canComment ? `No comments yet. ${e.host?.hint ?? ""}` : "No comments."
					})
				]
			}),
			n && /* @__PURE__ */ W(Kt, {
				x: n.x,
				y: n.y,
				items: ((e) => [{
					label: "Edit",
					icon: "edit",
					run: () => nr.get(e.id)?.()
				}, {
					label: e.parent ? "Delete" : "Delete thread",
					icon: "trash",
					run: () => a(e)
				}])(n.c),
				onClose: () => r(null)
			}),
			i && /* @__PURE__ */ W(Jt, {
				title: i.parent ? "Delete this comment?" : "Delete this thread?",
				message: i.parent ? "The reply is removed for everyone." : "The comment and its replies are removed for everyone.",
				ok: "Delete",
				onOk: () => void e.remove(i.id),
				onClose: () => a(null)
			})
		]
	});
}
// src/react/docx/DocxToolbar.tsx
var or = [
	"#ffff00",
	"#00ff00",
	"#00ffff",
	"#ff00ff",
	"#0000ff",
	"#ff0000",
	"#000080",
	"#008080",
	"#008000",
	"#800080",
	"#800000",
	"#808000",
	"#808080",
	"#c0c0c0",
	"#000000"
], sr = [
	{
		k: "all",
		icon: "bAll",
		title: "All borders"
	},
	{
		k: "inner",
		icon: "bInner",
		title: "Inner borders"
	},
	{
		k: "outer",
		icon: "bOuter",
		title: "Outer borders"
	},
	{
		k: "none",
		icon: "bNone",
		title: "No borders"
	},
	{
		k: "top",
		icon: "bTop",
		title: "Top border"
	},
	{
		k: "bottom",
		icon: "bBottom",
		title: "Bottom border"
	},
	{
		k: "left",
		icon: "bLeft",
		title: "Left border"
	},
	{
		k: "right",
		icon: "bRight",
		title: "Right border"
	}
], cr = [
	{
		value: "0.5pt solid",
		label: "Thin",
		hint: "───"
	},
	{
		value: "1.5pt solid",
		label: "Medium",
		hint: "━━━"
	},
	{
		value: "3pt solid",
		label: "Thick",
		hint: "▬▬▬"
	},
	{
		value: "0.5pt dashed",
		label: "Dashed",
		hint: "- - -"
	},
	{
		value: "0.5pt dotted",
		label: "Dotted",
		hint: "·····"
	},
	{
		value: "2.25pt double",
		label: "Double",
		hint: "═══"
	}
], lr = [
	{
		value: "top",
		label: "Top",
		icon: "vTop"
	},
	{
		value: "middle",
		label: "Middle",
		icon: "vMiddle"
	},
	{
		value: "bottom",
		label: "Bottom",
		icon: "vBottom"
	}
], ur = [
	{
		value: 1,
		label: "Single"
	},
	{
		value: 1.15,
		label: "1.15"
	},
	{
		value: 1.5,
		label: "1.5"
	},
	{
		value: 2,
		label: "Double"
	},
	{
		value: 2.5,
		label: "2.5"
	},
	{
		value: 3,
		label: "Triple"
	}
], dr = [
	{
		k: "normal",
		label: "Normal text",
		look: {}
	},
	{
		k: "title",
		label: "Title",
		look: { fontSize: 22 }
	},
	{
		k: "subtitle",
		label: "Subtitle",
		look: {
			fontSize: 15,
			color: "#5a5a5a"
		}
	},
	{
		k: "h1",
		label: "Heading 1",
		look: {
			fontSize: 18,
			color: "#2f5496"
		}
	},
	{
		k: "h2",
		label: "Heading 2",
		look: {
			fontSize: 16,
			color: "#2f5496"
		}
	},
	{
		k: "h3",
		label: "Heading 3",
		look: {
			fontSize: 14,
			color: "#1f3763"
		}
	},
	{
		k: "h4",
		label: "Heading 4",
		look: {
			fontSize: 13,
			color: "#2f5496",
			fontStyle: "italic"
		}
	},
	{
		k: "h5",
		label: "Heading 5",
		look: {
			fontSize: 13,
			color: "#2f5496"
		}
	},
	{
		k: "h6",
		label: "Heading 6",
		look: {
			fontSize: 13,
			color: "#1f3763",
			fontStyle: "italic"
		}
	}
], fr = /* @__PURE__ */ "©.®.™.§.¶.†.‡.•.….–.—.‰.€.£.¥.¢.₫.$.°.±.×.÷.≈.≠.≤.≥.∞.√.∑.∏.∫.π.µ.Ω.α.β.←.→.↑.↓.↔.⇒.✓.✗.★.☆.♥.♦.«.».“.”.‘.’.¼.½.¾.¹.².³".split(".");
function pr(e) {
	let t = dr.map(({ k: t, label: n, look: r }, i) => {
		let a = e.find((e) => e.canon === t);
		return {
			value: a?.id ?? `@${t}`,
			label: n,
			k: t,
			s: a,
			look: r,
			sep: i === 1
		};
	});
	return e.filter((e) => !e.canon).forEach((e, n) => t.push({
		value: e.id,
		label: e.name,
		s: e,
		sep: n === 0
	})), t;
}
function mr(e) {
	let t = e?.preview;
	if (t) return {
		fontSize: t.sz ? Math.max(12, Math.min(22, t.sz)) : void 0,
		fontWeight: t.b ? 700 : void 0,
		fontStyle: t.i ? "italic" : void 0,
		color: t.color && !/^#?f{6}$/i.test(t.color.replace("#", "")) ? t.color : void 0,
		fontFamily: t.font,
		lineHeight: 1.25
	};
}
function hr(e) {
	let { editor: t, styles: n, image: r } = e, [i, a] = H(null), [o, s] = H("#000000"), [c, l] = H("0.5pt solid");
	B(() => (t.onState = a, () => {
		t.onState = void 0;
	}), [t]);
	let u = Ot(i?.font), d = !i, f = i?.sz ? Math.round(i.sz * 2) / 2 : void 0, p = i?.line ? Math.round(i.line * 100) / 100 : "", m = /Mac|iPhone|iPad/.test(typeof navigator < "u" ? navigator.platform : "") ? "⌥" : "Alt+", h = pr(n).map(({ value: e, label: t, k: n, s: r, look: i, sep: a }) => ({
		value: e,
		label: t,
		hint: n === "normal" ? `${Q}${m}0` : n?.startsWith("h") ? `${Q}${m}${n.slice(1)}` : void 0,
		style: n ? {
			lineHeight: 1.25,
			...n === "normal" ? {} : mr(r) ?? i
		} : mr(r),
		sep: a
	})), g = i?.style && h.some((e) => e.value === i.style) ? i.style : i && !i.style ? n.find((e) => e.canon === "normal")?.id ?? "" : "";
	return /* @__PURE__ */ G(Rt, { children: [
		/* @__PURE__ */ W(Y, {
			icon: "undo",
			title: `Undo (${Q}Z)`,
			disabled: !t.canUndo,
			onClick: () => t.undo()
		}),
		/* @__PURE__ */ W(Y, {
			icon: "redo",
			title: `Redo (${Q}Y)`,
			disabled: !t.canRedo,
			onClick: () => t.redo()
		}),
		/* @__PURE__ */ W(Y, {
			icon: "paint",
			title: "Paint format (click, then select text)",
			active: e.painter,
			disabled: d,
			onClick: () => t.copyFormat()
		}),
		i?.inTable && /* @__PURE__ */ G(U, { children: [
			/* @__PURE__ */ W(X, {}),
			/* @__PURE__ */ W(At, {
				title: "Table",
				label: "Table",
				icon: "table",
				items: [
					{
						value: "rowAbove",
						label: "Insert row above",
						icon: "rowAbove"
					},
					{
						value: "rowBelow",
						label: "Insert row below",
						icon: "rowBelow"
					},
					{
						value: "colLeft",
						label: "Insert column left",
						icon: "colLeft"
					},
					{
						value: "colRight",
						label: "Insert column right",
						icon: "colRight"
					},
					{
						value: "delRow",
						label: "Delete row",
						icon: "delRow",
						sep: !0
					},
					{
						value: "delCol",
						label: "Delete column",
						icon: "delCol"
					},
					{
						value: "delTable",
						label: "Delete table",
						icon: "trash"
					},
					{
						value: "distribute",
						label: "Distribute columns evenly",
						icon: "colAdd",
						sep: !0
					}
				],
				onPick: (e) => e === "distribute" ? t.distributeColumns() : t.tableOp(e)
			}),
			/* @__PURE__ */ W(Y, {
				icon: "merge",
				title: i.cells?.merged && (i.cells?.n ?? 0) < 2 ? "Unmerge cells" : "Merge cells",
				active: i.cells?.merged && (i.cells?.n ?? 0) < 2,
				disabled: !i.cells || i.cells.n < 2 && !i.cells.merged,
				onClick: () => (i.cells?.n ?? 0) > 1 ? t.mergeCells() : t.unmergeCell()
			}),
			/* @__PURE__ */ W(wt, {
				icon: "fill",
				title: "Cell color",
				value: i.cells?.shd,
				onPick: (e) => t.setCellShade(e),
				noneLabel: "No fill"
			}),
			/* @__PURE__ */ W(jt, {
				icon: "borders",
				title: "Cell borders",
				chevron: !0,
				children: (e) => /* @__PURE__ */ G("div", {
					className: "de-borders-pop",
					children: [/* @__PURE__ */ W("div", {
						className: "de-borders",
						role: "group",
						"aria-label": "Cell borders",
						children: sr.map((n) => /* @__PURE__ */ W("button", {
							type: "button",
							className: "de-tb",
							title: n.title,
							"aria-label": n.title,
							onClick: () => (e(), t.setCellBorders(n.k, `${c} ${o}`)),
							children: /* @__PURE__ */ W(J, { name: n.icon })
						}, n.k))
					}), /* @__PURE__ */ G("div", {
						className: "de-borders-side",
						children: [/* @__PURE__ */ W(wt, {
							icon: "color",
							title: "Border color",
							value: o,
							onPick: (e) => s(e ?? "#000000"),
							noneLabel: "Black"
						}), /* @__PURE__ */ W(Z, {
							title: "Border style",
							icon: "lineStyle",
							label: null,
							menuWidth: 150,
							value: c,
							options: cr,
							onChange: (e) => l(e)
						})]
					})]
				})
			}),
			/* @__PURE__ */ W(Z, {
				title: "Vertical align",
				icon: lr.find((e) => e.value === i.cells?.vAlign)?.icon ?? "vTop",
				label: null,
				menuWidth: 130,
				value: i.cells?.vAlign ?? "top",
				options: lr,
				onChange: (e) => t.setCellVAlign(e)
			})
		] }),
		i?.img && /* @__PURE__ */ G(U, { children: [
			/* @__PURE__ */ W(X, {}),
			/* @__PURE__ */ W(Y, {
				icon: "minus",
				title: "Smaller",
				onClick: () => t.resizeImage(.8)
			}),
			/* @__PURE__ */ G("span", {
				className: "de-tb-hint",
				style: { margin: 0 },
				children: [
					Math.round(i.img.w),
					"×",
					Math.round(i.img.h),
					"pt"
				]
			}),
			/* @__PURE__ */ W(Y, {
				icon: "plus",
				title: "Larger",
				onClick: () => t.resizeImage(1.25)
			}),
			/* @__PURE__ */ W(Y, {
				icon: "fit",
				title: "Fit page width",
				onClick: () => t.resizeImage("fit")
			}),
			/* @__PURE__ */ W(Y, {
				icon: "imgOrig",
				title: "Original size",
				onClick: r.original
			}),
			/* @__PURE__ */ W(Y, {
				icon: "imgReplace",
				title: "Replace image",
				onClick: r.replace
			}),
			/* @__PURE__ */ W(Y, {
				icon: "alt",
				title: "Alt text",
				active: !!i.img.alt,
				onClick: r.alt
			}),
			r.download && /* @__PURE__ */ W(Y, {
				icon: "save",
				title: "Download image",
				onClick: r.download
			}),
			/* @__PURE__ */ W(Y, {
				icon: "trash",
				title: "Delete image",
				onClick: () => t.deleteSelection()
			})
		] }),
		/* @__PURE__ */ W(X, {}),
		/* @__PURE__ */ W(ut, {
			title: "Paragraph style",
			width: 118,
			menuWidth: 250,
			disabled: d,
			value: g,
			placeholder: "Style",
			options: h,
			onChange: (e) => e.startsWith("@") ? void t.applyCanon(e.slice(1)) : t.setPara({ style: e })
		}),
		/* @__PURE__ */ W(X, {}),
		/* @__PURE__ */ W(ut, {
			title: "Font",
			width: 118,
			menuWidth: 200,
			disabled: d,
			value: u,
			placeholder: "Font",
			options: Dt(u),
			onChange: (e) => t.setFont(e)
		}),
		/* @__PURE__ */ W(X, {}),
		/* @__PURE__ */ W(dt, {
			value: f,
			disabled: d,
			onChange: (e) => t.setSize(e)
		}),
		/* @__PURE__ */ W(X, {}),
		/* @__PURE__ */ W(Y, {
			icon: "bold",
			title: `Bold (${Q}B)`,
			active: i?.b,
			disabled: d,
			onClick: () => t.toggle("b")
		}),
		/* @__PURE__ */ W(Y, {
			icon: "italic",
			title: `Italic (${Q}I)`,
			active: i?.i,
			disabled: d,
			onClick: () => t.toggle("i")
		}),
		/* @__PURE__ */ W(Y, {
			icon: "underline",
			title: `Underline (${Q}U)`,
			active: i?.u,
			disabled: d,
			onClick: () => t.toggle("u")
		}),
		/* @__PURE__ */ W(Y, {
			icon: "strike",
			title: "Strikethrough",
			active: i?.strike,
			disabled: d,
			onClick: () => t.toggle("strike")
		}),
		/* @__PURE__ */ W(wt, {
			icon: "color",
			title: "Text color",
			value: i?.color,
			onPick: (e) => t.setColor(e),
			noneLabel: "Automatic"
		}),
		/* @__PURE__ */ W(wt, {
			icon: "highlight",
			title: "Highlight color",
			value: i?.hl,
			palette: or,
			onPick: (e) => t.setHighlight(e)
		}),
		/* @__PURE__ */ W(X, {}),
		/* @__PURE__ */ W(Y, {
			icon: "link",
			title: `Insert link (${Q}K)`,
			active: !!i?.link,
			disabled: d,
			onClick: e.onLink
		}),
		/* @__PURE__ */ W(Y, {
			icon: "image",
			title: "Insert image",
			disabled: d,
			onClick: () => void Nt().then((e) => void (e.length && t.insertImages(e)))
		}),
		/* @__PURE__ */ W(jt, {
			icon: "table",
			title: "Insert table",
			disabled: d || i?.inTable,
			children: (e) => /* @__PURE__ */ W(Mt, { onPick: (n, r) => (e(), t.insertTable(n, r)) })
		}),
		/* @__PURE__ */ W(Y, {
			icon: "pageSetup",
			title: "Page setup (size, orientation, margins, columns)",
			disabled: !e.onPageSetup,
			onClick: () => e.onPageSetup?.()
		}),
		/* @__PURE__ */ W(Y, {
			icon: "track",
			title: "Track changes (suggest edits)",
			active: !!i?.tracking,
			disabled: d,
			onClick: () => t.setTracking(!t.tracking)
		}),
		/* @__PURE__ */ W(At, {
			title: "Review changes",
			label: "Review",
			icon: "review",
			items: [
				{
					value: "next",
					label: "Next change",
					icon: "down"
				},
				{
					value: "prev",
					label: "Previous change",
					icon: "up"
				},
				{
					value: "accept",
					label: "Accept change",
					icon: "check",
					sep: !0,
					disabled: !i?.inChange
				},
				{
					value: "reject",
					label: "Reject change",
					icon: "close",
					disabled: !i?.inChange
				},
				{
					value: "acceptAll",
					label: "Accept all changes",
					icon: "check",
					sep: !0
				},
				{
					value: "rejectAll",
					label: "Reject all changes",
					icon: "close"
				}
			],
			onPick: (n) => {
				if (n === "next" || n === "prev") {
					t.gotoChange(n === "next" ? 1 : -1) || e.onNotice?.(n === "next" ? "No more changes after this point" : "No changes before this point");
					return;
				}
				let r = t.review(n.startsWith("accept"), n.endsWith("All"));
				e.onNotice?.(r ? `${r} change${r > 1 ? "s" : ""} ${n.startsWith("accept") ? "accepted" : "rejected"}` : "No tracked changes here");
			}
		}),
		/* @__PURE__ */ W(Y, {
			icon: "headerFooter",
			title: "Header & footer, page numbers",
			disabled: !e.onHeaderFooter,
			onClick: () => e.onHeaderFooter?.()
		}),
		/* @__PURE__ */ W(jt, {
			icon: "omega",
			title: "Special characters",
			disabled: d,
			children: (e) => /* @__PURE__ */ W("div", {
				className: "de-symbols",
				children: fr.map((n) => /* @__PURE__ */ W("button", {
					type: "button",
					title: `U+${n.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}`,
					onClick: () => (e(), t.insertText(n)),
					children: n
				}, n))
			})
		}),
		/* @__PURE__ */ W(X, {}),
		/* @__PURE__ */ W(Y, {
			icon: "alignLeft",
			title: "Align left",
			active: i?.align === "left",
			disabled: d,
			onClick: () => t.setPara({ align: "left" }, { align: "left" })
		}),
		/* @__PURE__ */ W(Y, {
			icon: "alignCenter",
			title: "Center",
			active: i?.align === "center",
			disabled: d,
			onClick: () => t.setPara({ align: "center" }, { align: "center" })
		}),
		/* @__PURE__ */ W(Y, {
			icon: "alignRight",
			title: "Align right",
			active: i?.align === "right",
			disabled: d,
			onClick: () => t.setPara({ align: "right" }, { align: "right" })
		}),
		/* @__PURE__ */ W(Y, {
			icon: "justify",
			title: "Justify",
			active: i?.align === "justify",
			disabled: d,
			onClick: () => t.setPara({ align: "justify" }, { align: "justify" })
		}),
		/* @__PURE__ */ W(Z, {
			title: "Line & paragraph spacing",
			icon: "lineSpacing",
			label: null,
			menuWidth: 150,
			disabled: d,
			value: p,
			options: ur,
			onChange: (e) => t.setPara({ line: e }, {
				line: e,
				lineRule: "auto"
			})
		}),
		/* @__PURE__ */ W(X, {}),
		/* @__PURE__ */ W(Y, {
			icon: "bullets",
			title: "Bulleted list",
			active: i?.lst === "bullet",
			disabled: d,
			onClick: () => t.toggleList("bullet")
		}),
		/* @__PURE__ */ W(Y, {
			icon: "numbers",
			title: "Numbered list",
			active: i?.lst === "number",
			disabled: d,
			onClick: () => t.toggleList("number")
		}),
		/* @__PURE__ */ W(Y, {
			icon: "outdent",
			title: "Decrease indent (Shift+Tab)",
			disabled: d,
			onClick: () => t.indent(-1)
		}),
		/* @__PURE__ */ W(Y, {
			icon: "indent",
			title: "Increase indent (Tab)",
			disabled: d,
			onClick: () => t.indent(1)
		}),
		/* @__PURE__ */ W(X, {}),
		/* @__PURE__ */ W(Y, {
			icon: "sup",
			title: "Superscript",
			active: i?.va === "sup",
			disabled: d,
			onClick: () => t.format({ va: i?.va === "sup" ? void 0 : "sup" }, { va: i?.va === "sup" ? null : "sup" })
		}),
		/* @__PURE__ */ W(Y, {
			icon: "sub",
			title: "Subscript",
			active: i?.va === "sub",
			disabled: d,
			onClick: () => t.format({ va: i?.va === "sub" ? void 0 : "sub" }, { va: i?.va === "sub" ? null : "sub" })
		}),
		/* @__PURE__ */ W(Y, {
			icon: "pagebreak",
			title: `Page break (${Q}Enter)`,
			disabled: d || i?.inTable,
			onClick: () => t.insertPageBreak()
		}),
		/* @__PURE__ */ W(Y, {
			icon: "clear",
			title: `Clear formatting (${Q}\\)`,
			disabled: d,
			onClick: () => t.clearFormat()
		}),
		/* @__PURE__ */ W(X, {}),
		/* @__PURE__ */ W(Y, {
			icon: "outline",
			title: "Document outline",
			active: e.outline,
			onClick: e.onOutline
		}),
		/* @__PURE__ */ W(Y, {
			icon: "search",
			title: `Find & replace (${Q}F)`,
			onClick: e.onFind
		})
	] });
}
// src/react/docx/FindBar.tsx
function gr(e) {
	let t = V(null), [n, r] = H(""), [i, a] = H(!!e.replace);
	return B(() => {
		t.current?.focus(), t.current?.select();
	}, []), /* @__PURE__ */ G("div", {
		className: "de-find",
		role: "search",
		onKeyDown: (t) => t.key === "Escape" && e.onClose(),
		children: [
			/* @__PURE__ */ G("div", {
				className: "de-find-row",
				children: [
					/* @__PURE__ */ W("input", {
						ref: t,
						value: e.query,
						placeholder: e.placeholder ?? "Find in document",
						"aria-label": "Find",
						onChange: (t) => e.onQuery(t.target.value),
						onKeyDown: (t) => {
							t.key === "Enter" && (t.preventDefault(), e.onNav(t.shiftKey ? -1 : 1));
						}
					}),
					/* @__PURE__ */ W("span", {
						className: "de-find-count",
						children: e.query ? e.count ? `${Math.min(e.index + 1, e.count)} / ${e.count}` : "0 / 0" : ""
					}),
					/* @__PURE__ */ W(Y, {
						icon: "up",
						title: "Previous (Shift+Enter)",
						onClick: () => e.onNav(-1),
						disabled: !e.count
					}),
					/* @__PURE__ */ W(Y, {
						icon: "down",
						title: "Next (Enter)",
						onClick: () => e.onNav(1),
						disabled: !e.count
					}),
					e.editable && /* @__PURE__ */ W(Y, {
						label: "⇄",
						title: "Replace",
						active: i,
						onClick: () => a((e) => !e)
					}),
					/* @__PURE__ */ W(Y, {
						icon: "close",
						title: "Close (Esc)",
						onClick: e.onClose
					})
				]
			}),
			e.options && /* @__PURE__ */ W("div", {
				className: "de-find-row de-find-opts",
				children: e.options
			}),
			e.editable && i && /* @__PURE__ */ G("div", {
				className: "de-find-row",
				children: [
					/* @__PURE__ */ W("input", {
						value: n,
						placeholder: "Replace with",
						"aria-label": "Replace with",
						onChange: (e) => r(e.target.value)
					}),
					/* @__PURE__ */ W("button", {
						type: "button",
						className: "de-btn",
						disabled: !e.count,
						onClick: () => e.onReplace(n, !1),
						children: "Replace"
					}),
					/* @__PURE__ */ W("button", {
						type: "button",
						className: "de-btn",
						disabled: !e.count,
						onClick: () => e.onReplace(n, !0),
						children: "All"
					})
				]
			})
		]
	});
}
// src/react/docx/HeaderFooterDialog.tsx
var _r = [
	{
		k: "header",
		label: "Header"
	},
	{
		k: "footer",
		label: "Footer"
	},
	{
		k: "firstHeader",
		label: "First page header"
	},
	{
		k: "firstFooter",
		label: "First page footer"
	}
], vr = [
	{
		label: "Bottom center: 1",
		k: "footer",
		line: {
			text: "{PAGE}",
			align: "center"
		}
	},
	{
		label: "Bottom right: 1",
		k: "footer",
		line: {
			text: "{PAGE}",
			align: "right"
		}
	},
	{
		label: "Bottom center: Page 1 of 5",
		k: "footer",
		line: {
			text: "Page {PAGE} of {NUMPAGES}",
			align: "center"
		}
	},
	{
		label: "Bottom center: Trang 1/5 (Vietnamese)",
		k: "footer",
		line: {
			text: "Trang {PAGE}/{NUMPAGES}",
			align: "center"
		}
	},
	{
		label: "Top right: 1",
		k: "header",
		line: {
			text: "{PAGE}",
			align: "right"
		}
	}
];
function yr(e) {
	let t = (e ?? []).filter((e) => e.t === "p"), n = (e ?? []).some((e) => e.t !== "p" || e.runs.some((e) => e.t !== "text" && e.t !== "field")), r = t.map((e) => e.t === "p" ? e.runs.map((e) => e.t === "text" ? e.text.replace(/\n/g, " ") : e.t === "field" ? `{${e.kind}}` : "").join("") : ""), i = t.find((e) => e.t === "p" && e.runs.length) ?? t[0], a = i?.t === "p" ? i.runs.filter((e) => e.t === "text" || e.t === "field") : [], o = i?.t === "p" && (i.ps.align === "center" || i.ps.align === "right") ? i.ps.align : "left", s = a[0];
	for (; r.length && !r[r.length - 1].trim();) r.pop();
	return {
		text: r.join("\n"),
		align: o,
		b: a.length > 0 && a.every((e) => e.s?.b),
		sz: s?.s?.sz ? String(s.s.sz) : "",
		rich: n
	};
}
var br = (e) => e.text.split("\n").length === 1 && !e.text.trim() ? [] : e.text.split("\n").map((t) => ({
	text: t,
	align: e.align,
	...e.b ? { b: !0 } : {},
	...Number(e.sz) >= 4 ? { sz: Number(e.sz) } : {}
}));
function xr({ meta: e, focus: t, onOk: n, onClose: r }) {
	let i = V(Object.fromEntries(_r.map(({ k: t }) => [t, yr(e[t])]))), [a, o] = H(i.current), [s, c] = H(!!e.titlePg), [l, u] = H(t && (s || !t.startsWith("first")) ? t : "header"), d = V(null);
	B(() => d.current?.focus(), [l]);
	let f = a[l], p = (e, t = l) => o((n) => ({
		...n,
		[t]: {
			...n[t],
			...e
		}
	})), m = (e) => {
		let t = d.current, n = t ? t.selectionStart : f.text.length, r = t ? t.selectionEnd : n;
		p({ text: f.text.slice(0, n) + e + f.text.slice(r) }), requestAnimationFrame(() => {
			t?.focus(), t?.setSelectionRange(n + e.length, n + e.length);
		});
	}, h = () => {
		let t = {};
		for (let { k: e } of _r) {
			let n = a[e], r = i.current[e];
			(n.text !== r.text || n.align !== r.align || n.b !== r.b || n.sz !== r.sz) && ((t.parts ??= {})[e] = br(n));
		}
		s !== !!e.titlePg && (t.titlePg = s), r(), (t.parts || t.titlePg !== void 0) && n(t);
	}, g = _r.filter(({ k: e }) => s || !e.startsWith("first"));
	return /* @__PURE__ */ W("div", {
		className: "de-dialog-back",
		onMouseDown: (e) => e.target === e.currentTarget && r(),
		onKeyDown: (e) => {
			e.key === "Escape" && (e.stopPropagation(), r());
		},
		children: /* @__PURE__ */ G("form", {
			className: "de-dialog de-hfd",
			role: "dialog",
			"aria-label": "Header and footer",
			noValidate: !0,
			onSubmit: (e) => {
				e.preventDefault(), h();
			},
			children: [
				/* @__PURE__ */ W("div", {
					className: "de-dialog-title",
					children: "Header & footer"
				}),
				/* @__PURE__ */ W("div", {
					className: "de-hfd-tabs",
					role: "tablist",
					children: g.map(({ k: e, label: t }) => /* @__PURE__ */ W("button", {
						type: "button",
						role: "tab",
						"aria-selected": l === e,
						className: l === e ? "on" : void 0,
						onClick: () => u(e),
						children: t
					}, e))
				}),
				/* @__PURE__ */ W("textarea", {
					ref: d,
					rows: 3,
					"aria-label": `${_r.find((e) => e.k === l).label} text`,
					placeholder: "Type the text; one line per paragraph",
					value: f.text,
					style: {
						textAlign: f.align,
						fontWeight: f.b ? 700 : void 0
					},
					onChange: (e) => p({ text: e.target.value })
				}),
				f.rich && /* @__PURE__ */ W("div", {
					className: "de-dialog-note de-ps-bad",
					children: "This part also holds pictures, tables or shapes: changing it here removes them."
				}),
				/* @__PURE__ */ G("div", {
					className: "de-ps-row",
					children: [
						[
							"left",
							"center",
							"right"
						].map((e) => /* @__PURE__ */ G("label", {
							className: "de-ps-radio",
							children: [
								/* @__PURE__ */ W("input", {
									type: "radio",
									name: "de-hfd-align",
									checked: f.align === e,
									onChange: () => p({ align: e })
								}),
								" ",
								e[0].toUpperCase() + e.slice(1)
							]
						}, e)),
						/* @__PURE__ */ G("label", {
							className: "de-ps-radio",
							children: [/* @__PURE__ */ W("input", {
								type: "checkbox",
								checked: f.b,
								onChange: (e) => p({ b: e.target.checked })
							}), " Bold"]
						}),
						/* @__PURE__ */ G("label", {
							className: "de-ps-field",
							children: [/* @__PURE__ */ W("span", { children: "Size" }), /* @__PURE__ */ W("input", {
								type: "number",
								step: "any",
								min: "4",
								"aria-label": "Font size (pt)",
								placeholder: "auto",
								value: f.sz,
								onChange: (e) => p({ sz: e.target.value })
							})]
						})
					]
				}),
				/* @__PURE__ */ G("div", {
					className: "de-ps-row",
					children: [
						/* @__PURE__ */ W("button", {
							type: "button",
							className: "de-btn",
							onClick: () => m("{PAGE}"),
							children: "+ Page number"
						}),
						/* @__PURE__ */ W("button", {
							type: "button",
							className: "de-btn",
							onClick: () => m("{NUMPAGES}"),
							children: "+ Page count"
						}),
						/* @__PURE__ */ G("select", {
							className: "de-ps-preset",
							"aria-label": "Page number preset",
							value: "",
							onChange: (e) => {
								let t = vr[Number(e.target.value)];
								t && (p({
									text: t.line.text,
									align: t.line.align ?? "left"
								}, t.k), u(t.k));
							},
							children: [/* @__PURE__ */ W("option", {
								value: "",
								children: "Page numbers…"
							}), vr.map((e, t) => /* @__PURE__ */ W("option", {
								value: t,
								children: e.label
							}, e.label))]
						})
					]
				}),
				/* @__PURE__ */ G("label", {
					className: "de-ps-radio",
					children: [
						/* @__PURE__ */ W("input", {
							type: "checkbox",
							checked: s,
							onChange: (e) => {
								c(e.target.checked), !e.target.checked && l.startsWith("first") && u(l === "firstFooter" ? "footer" : "header");
							}
						}),
						" ",
						"Different first page"
					]
				}),
				/* @__PURE__ */ G("div", {
					className: "de-dialog-btns",
					children: [/* @__PURE__ */ W("button", {
						type: "button",
						className: "de-btn",
						onClick: r,
						children: "Cancel"
					}), /* @__PURE__ */ W("button", {
						type: "submit",
						className: "de-btn de-btn-primary",
						children: "Apply"
					})]
				})
			]
		})
	});
}
// src/react/docx/PageSetupDialog.tsx
var Sr = [
	{
		k: "a4",
		label: "A4 (21 × 29.7 cm)",
		w: 595.3,
		h: 841.9
	},
	{
		k: "letter",
		label: "Letter (8.5 × 11 in)",
		w: 612,
		h: 792
	},
	{
		k: "legal",
		label: "Legal (8.5 × 14 in)",
		w: 612,
		h: 1008
	},
	{
		k: "a3",
		label: "A3 (29.7 × 42 cm)",
		w: 841.9,
		h: 1190.6
	},
	{
		k: "a5",
		label: "A5 (14.8 × 21 cm)",
		w: 419.5,
		h: 595.3
	},
	{
		k: "b5",
		label: "B5 (17.6 × 25 cm)",
		w: 498.9,
		h: 708.7
	}
], Cr = 72 / 2.54, wr = (e) => +(e / Cr).toFixed(2), Tr = (e) => +(e * Cr).toFixed(2), Er = (e, t) => Math.abs(e - t) < 2;
function Dr(e) {
	let t = Math.min(e.w, e.h), n = Math.max(e.w, e.h);
	return Sr.find((e) => Er(e.w, t) && Er(e.h, n))?.k ?? "custom";
}
var Or = [
	{
		label: "Normal",
		cm: [
			2.54,
			2.54,
			2.54,
			2.54
		]
	},
	{
		label: "Narrow",
		cm: [
			1.27,
			1.27,
			1.27,
			1.27
		]
	},
	{
		label: "Moderate",
		cm: [
			2.54,
			1.91,
			2.54,
			1.91
		]
	},
	{
		label: "Wide",
		cm: [
			2.54,
			5.08,
			2.54,
			5.08
		]
	},
	{
		label: "Vietnam (TT 01/2011)",
		cm: [
			2,
			1.5,
			2,
			3
		]
	}
];
function kr({ page: e, onOk: t, onClose: n }) {
	let [r, i] = H(Dr(e)), [a, o] = H(e.w > e.h), [s, c] = H([
		e.mt,
		e.mr,
		e.mb,
		e.ml
	].map((e) => String(wr(e)))), [l, u] = H(e.cols ?? 1), [d, f] = H(String(wr(e.colGap ?? 36))), p = V(null);
	B(() => p.current?.focus(), []);
	let m = s.map(Number), h = Number(d), g = (() => {
		let t = Sr.find((e) => e.k === r), n = t ? t.w : Math.min(e.w, e.h), i = t ? t.h : Math.max(e.w, e.h);
		return a ? {
			w: i,
			h: n
		} : {
			w: n,
			h: i
		};
	})(), _ = m.some((e) => !Number.isFinite(e) || e < 0 || e > 15) || Tr(m[1] + m[3]) > g.w - 72 || Tr(m[0] + m[2]) > g.h - 72 || !Number.isFinite(h) || h < 0 || h > 10, v = () => {
		if (_) return;
		let r = {};
		Er(g.w, e.w) && Er(g.h, e.h) || Object.assign(r, {
			w: g.w,
			h: g.h
		}), [
			"mt",
			"mr",
			"mb",
			"ml"
		].forEach((t, n) => {
			let i = Tr(m[n]);
			Math.abs(i - e[t]) > .3 && (r[t] = i);
		}), l !== (e.cols ?? 1) && (r.cols = l), l > 1 && Math.abs(Tr(h) - (e.colGap ?? 36)) > .3 && (r.colGap = Tr(h)), n(), Object.keys(r).length && t(r);
	}, y = (e, t) => /* @__PURE__ */ G("label", {
		className: "de-ps-field",
		children: [
			/* @__PURE__ */ W("span", { children: t }),
			/* @__PURE__ */ W("input", {
				type: "number",
				step: "any",
				min: "0",
				"aria-label": `${t} margin (cm)`,
				value: s[e],
				onChange: (t) => c((n) => n.map((n, r) => r === e ? t.target.value : n))
			}),
			/* @__PURE__ */ W("em", { children: "cm" })
		]
	});
	return /* @__PURE__ */ W("div", {
		className: "de-dialog-back",
		onMouseDown: (e) => e.target === e.currentTarget && n(),
		onKeyDown: (e) => {
			e.key === "Escape" && (e.stopPropagation(), n());
		},
		children: /* @__PURE__ */ G("form", {
			className: "de-dialog de-ps",
			role: "dialog",
			noValidate: !0,
			"aria-label": "Page setup",
			onSubmit: (e) => {
				e.preventDefault(), v();
			},
			children: [
				/* @__PURE__ */ W("div", {
					className: "de-dialog-title",
					children: "Page setup"
				}),
				/* @__PURE__ */ W("div", {
					className: "de-ps-note",
					children: "Applies to the whole document."
				}),
				/* @__PURE__ */ W("div", {
					className: "de-ps-row",
					children: /* @__PURE__ */ G("label", {
						className: "de-ps-field de-ps-wide",
						children: [/* @__PURE__ */ W("span", { children: "Paper size" }), /* @__PURE__ */ G("select", {
							ref: p,
							"aria-label": "Paper size",
							value: r,
							onChange: (e) => i(e.target.value),
							children: [Sr.map((e) => /* @__PURE__ */ W("option", {
								value: e.k,
								children: e.label
							}, e.k)), r === "custom" && /* @__PURE__ */ G("option", {
								value: "custom",
								children: [
									"Custom (",
									wr(e.w),
									" × ",
									wr(e.h),
									" cm)"
								]
							})]
						})]
					})
				}),
				/* @__PURE__ */ G("div", {
					className: "de-ps-row",
					role: "radiogroup",
					"aria-label": "Orientation",
					children: [
						/* @__PURE__ */ W("span", {
							className: "de-ps-head",
							children: "Orientation"
						}),
						/* @__PURE__ */ G("label", {
							className: "de-ps-radio",
							children: [/* @__PURE__ */ W("input", {
								type: "radio",
								name: "de-ps-orient",
								checked: !a,
								onChange: () => o(!1)
							}), " Portrait"]
						}),
						/* @__PURE__ */ G("label", {
							className: "de-ps-radio",
							children: [/* @__PURE__ */ W("input", {
								type: "radio",
								name: "de-ps-orient",
								checked: a,
								onChange: () => o(!0)
							}), " Landscape"]
						})
					]
				}),
				/* @__PURE__ */ G("div", {
					className: "de-ps-head",
					children: ["Margins", /* @__PURE__ */ G("select", {
						className: "de-ps-preset",
						"aria-label": "Margin preset",
						value: "",
						onChange: (e) => {
							let t = Or[Number(e.target.value)];
							t && c(t.cm.map(String));
						},
						children: [/* @__PURE__ */ W("option", {
							value: "",
							children: "Presets…"
						}), Or.map((e, t) => /* @__PURE__ */ W("option", {
							value: t,
							children: e.label
						}, e.label))]
					})]
				}),
				/* @__PURE__ */ G("div", {
					className: "de-ps-grid",
					children: [
						y(0, "Top"),
						y(2, "Bottom"),
						y(3, "Left"),
						y(1, "Right")
					]
				}),
				/* @__PURE__ */ G("div", {
					className: "de-ps-row",
					children: [
						/* @__PURE__ */ W("span", {
							className: "de-ps-head",
							children: "Columns"
						}),
						[
							1,
							2,
							3
						].map((e) => /* @__PURE__ */ G("label", {
							className: "de-ps-radio",
							children: [
								/* @__PURE__ */ W("input", {
									type: "radio",
									name: "de-ps-cols",
									checked: l === e,
									onChange: () => u(e)
								}),
								" ",
								e
							]
						}, e)),
						l > 1 && /* @__PURE__ */ G("label", {
							className: "de-ps-field",
							children: [
								/* @__PURE__ */ W("span", { children: "Spacing" }),
								/* @__PURE__ */ W("input", {
									type: "number",
									step: "any",
									min: "0",
									"aria-label": "Column spacing (cm)",
									value: d,
									onChange: (e) => f(e.target.value)
								}),
								/* @__PURE__ */ W("em", { children: "cm" })
							]
						})
					]
				}),
				_ && /* @__PURE__ */ W("div", {
					className: "de-dialog-note de-ps-bad",
					children: "The margins leave no room for text."
				}),
				/* @__PURE__ */ G("div", {
					className: "de-dialog-btns",
					children: [/* @__PURE__ */ W("button", {
						type: "button",
						className: "de-btn",
						onClick: n,
						children: "Cancel"
					}), /* @__PURE__ */ W("button", {
						type: "submit",
						className: "de-btn de-btn-primary",
						disabled: _,
						children: "Apply"
					})]
				})
			]
		})
	});
}
// src/react/file/text.ts
var Ar = (e) => e.map((e) => e.t === "text" || e.t === "ref" ? e.s.vanish || e.tc?.k === "del" ? "" : e.text : "").join(""), jr = (e) => e.filter((e) => e.t === "p").map((e) => Ar(e.runs)).join(" ").replace(/\s+/g, " ").trim();
function Mr(e) {
	let t = [];
	for (let n of e) if (n.t === "p") t.push((n.marker ? n.marker.text + (n.marker.tab ? "	" : " ") : "") + Ar(n.runs));
	else if (n.t === "tbl") for (let e of n.rows) t.push(e.cells.map((e) => jr(e.blocks)).join("	"));
	return t.join("\n") + "\n";
}
var Nr = (e) => e.replace(/([\\`*_[\]<>])/g, "\\$1"), Pr = /courier|mono|consolas|menlo|fira code|source code/i;
function Fr(t, n = !1, r) {
	let i = "", a = 0;
	for (; a < t.length;) {
		let o = t[a];
		if (o.t === "img" && o.tc?.k !== "del" && r?.has(o.target)) {
			a++, i += `![${Nr(o.alt ?? "")}](${r.get(o.target)})`;
			continue;
		}
		if (o.t !== "text" && o.t !== "ref" || o.tc?.k === "del") {
			a++;
			continue;
		}
		if (o.t === "text" && e(o.href)) {
			let e = "", n = o.href;
			for (; a < t.length && t[a].t === "text" && t[a].href === n;) {
				let n = t[a++];
				n.tc?.k !== "del" && (e += n.text);
			}
			i += `[${Nr(e)}](${n.replace(/[()\s]/g, encodeURIComponent)})`;
			continue;
		}
		if (a++, o.s.vanish) continue;
		let s = o.text.replace(/\t/g, " ").replace(/\n/g, "  \n"), c = s.trim();
		if (!c) {
			i += s;
			continue;
		}
		let l = (o.s.b && !n ? "**" : "") + (o.s.i && !n ? "*" : ""), u = o.s.strike ? "~~" : "", d = s.slice(0, s.indexOf(c[0])), f = s.slice(s.lastIndexOf(c[c.length - 1]) + 1), p = o.s.font && Pr.test(o.s.font) ? `\`${c.replace(/`/g, "``")}\`` : Nr(c);
		i += `${d}${u}${l}${p}${[...l].reverse().join("")}${u}${f}`;
	}
	return i.replace(/\*\*\*\*/g, "");
}
function Ir(e) {
	let t = e.rows.map((e) => e.cells.map((e) => jr(e.blocks).replace(/\|/g, "\\|") || " "));
	if (!t.length) return "";
	let n = Math.max(...t.map((e) => e.length)), r = (e) => `| ${Array.from({ length: n }, (t, n) => e[n] ?? " ").join(" | ")} |`;
	return [
		r(t[0]),
		`|${" --- |".repeat(n)}`,
		...t.slice(1).map(r)
	].join("\n");
}
function Lr(e, t) {
	let n = [], r = !1;
	for (let i of e) {
		if (i.t === "tbl") {
			n.push(Ir(i), ""), r = !1;
			continue;
		}
		if (i.t !== "p") continue;
		let e = i.ps.outline, a = e !== void 0 && e < 6, o = Fr(i.runs, a, t).trim();
		if (i.marker) {
			let e = /^[\da-zA-Z]{1,4}[.)]$/.test(i.marker.text.trim()), t = Math.max(0, Math.round(((i.ps.indL ?? 36) - 36) / 36));
			!r && n.length && n[n.length - 1] !== "" && n.push(""), n.push(`${"   ".repeat(t)}${e ? "1." : "-"} ${o}`), r = !0;
		} else r && n.push(""), r = !1, o && n.push(a ? `${"#".repeat(e + 1)} ${o}` : o, "");
	}
	return n.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}
var Rr = (e) => e.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
function zr(e, t, n, r = !1) {
	let i = Rr(e).replace(/\n/g, "<br>");
	if (!i.trim()) return i;
	t.font && Pr.test(t.font) && (i = `<code>${i}</code>`), t.b && !n && (i = `<strong>${i}</strong>`), t.i && (i = `<em>${i}</em>`), t.u && t.u !== "none" && !r && (i = `<u>${i}</u>`), (t.strike || t.dstrike) && (i = `<s>${i}</s>`), t.va === "sup" ? i = `<sup>${i}</sup>` : t.va === "sub" && (i = `<sub>${i}</sub>`);
	let a = L(t.color), o = L(t.hl), s = [a && a !== "auto" && !n && !r ? `color:${a}` : "", o && o !== "none" ? `background:${o}` : ""].filter(Boolean).join(";");
	return s ? `<span style="${s}">${i}</span>` : i;
}
function Br(e) {
	let t = [];
	for (let n of e) {
		let e = t[t.length - 1];
		n.t === "text" && e?.t === "text" && e.href === n.href && e.tc?.k === n.tc?.k && JSON.stringify(e.s) === JSON.stringify(n.s) ? t[t.length - 1] = {
			...e,
			text: e.text + n.text
		} : t.push(n);
	}
	return t;
}
function Vr(t, n = !1, r) {
	let i = "", a = 0;
	for (t = Br(t); a < t.length;) {
		let o = t[a++];
		if (o.tc?.k !== "del") {
			if (o.t === "img") {
				let t = r?.get(o.target);
				if (!t) continue;
				let n = `<img src="${t}" alt="${Rr(o.alt ?? "")}" width="${Math.round(o.w * 96 / 72)}" height="${Math.round(o.h * 96 / 72)}">`;
				i += e(o.href) ? `<a href="${Rr(o.href)}">${n}</a>` : n;
			} else if ((o.t === "text" || o.t === "ref") && !o.s.vanish) {
				if (o.t === "text" && e(o.href)) {
					let e = o.href, r = zr(o.text, o.s, n, !0);
					for (; a < t.length && t[a].t === "text" && t[a].href === e;) {
						let e = t[a++];
						e.tc?.k !== "del" && !e.s.vanish && (r += zr(e.text, e.s, n, !0));
					}
					i += `<a href="${Rr(e)}">${r}</a>`;
				} else i += zr(o.text, o.s, n);
			}
		}
	}
	return i;
}
var Hr = (e, t) => e.filter((e) => e.t === "p").map((e) => Vr(e.runs, !1, t).trim()).filter(Boolean).join("<br>"), Ur = "body{max-width:48em;margin:2em auto;padding:0 1em;font:16px/1.5 system-ui,-apple-system,\"Segoe UI\",Roboto,sans-serif;color:#222}table{border-collapse:collapse}td{border:1px solid #ccc;padding:4px 8px;vertical-align:top}img{max-width:100%;height:auto}code{font-family:ui-monospace,Menlo,Consolas,monospace;background:#f3f3f3;padding:0 .2em}";
function Wr(e, t = {}) {
	let { images: n } = t, r = [], i = [], a = (e) => {
		for (; i.length > e;) r[r.length - 1] += `</li></${i.pop()}>`;
	};
	for (let t of e) {
		if (t.t === "tbl") {
			a(0), r.push(`<table>\n${t.rows.map((e) => `<tr>${e.cells.map((e) => `<td>${Hr(e.blocks, n)}</td>`).join("")}</tr>`).join("\n")}\n</table>`);
			continue;
		}
		if (t.t !== "p") continue;
		let e = t.ps.outline, o = e !== void 0 && e < 6, s = Vr(t.runs, o, n).trim();
		if (t.marker) {
			let e = /^[\da-zA-Z]{1,4}[.)]$/.test(t.marker.text.trim()) ? "ol" : "ul", n = Math.max(0, Math.round(((t.ps.indL ?? 36) - 36) / 36)) + 1;
			if (a(i[n - 1] === e ? n : n - 1), n > i.length) for (; i.length < n;) i.push(e), r.push(`<${e}>`);
			else r[r.length - 1] += "</li>";
			r.push(`<li>${s}`);
			continue;
		}
		if (a(0), !s) continue;
		let c = t.ps.align === "center" || t.ps.align === "right" ? ` style="text-align:${t.ps.align}"` : "";
		r.push(o ? `<h${e + 1}${c}>${s}</h${e + 1}>` : `<p${c}>${s}</p>`);
	}
	return a(0), `<!doctype html>\n<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${Rr(t.title ?? "")}</title>\n<style>${Ur}</style></head>\n<body>\n${r.join("\n")}\n</body></html>\n`;
}
async function Gr(e, t) {
	let n = /* @__PURE__ */ new Set(), r = (e) => {
		for (let t of e) {
			if (t.t === "p") for (let e of t.runs) e.t === "img" && n.add(e.target);
			if (t.t === "tbl") for (let e of t.rows) for (let t of e.cells) r(t.blocks);
		}
	};
	r(e);
	let i = /* @__PURE__ */ new Map();
	for (let e of n) try {
		let n = await t(e), r = new Uint8Array(await n.arrayBuffer()), a = "";
		for (let e = 0; e < r.length; e += 32768) a += String.fromCharCode(...r.subarray(e, e + 32768));
		i.set(e, `data:${n.type || "application/octet-stream"};base64,${btoa(a)}`);
	} catch {}
	return i;
}
var Kr = (e) => e ? e.paras.map((e) => (e.bullet ? e.bullet.text + " " : "") + e.runs.map((e) => e.br ? "\n" : e.text).join("")).filter((e) => e.trim()).join("\n") : "";
function qr(e) {
	let t = [];
	for (let n of e) {
		t.push(`Slide ${n.index + 1}`, "");
		for (let e of n.els) if (e.t === "shape") {
			let n = Kr(e.text);
			n && t.push(n, "");
		} else if (e.t === "table") {
			for (let n of e.rows) t.push(n.cells.filter((e) => !e.hidden).map((e) => Kr(e.text).replace(/\s+/g, " ")).join("	"));
			t.push("");
		}
		n.notes?.trim() && t.push("Notes:", n.notes.trim(), ""), t.push("");
	}
	return t.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}
// src/react/docx/render.tsx
var Jr = (e) => e ? `${+e.toFixed(2)}pt` : void 0, Yr = be({
	double: "double",
	dotted: "dotted",
	dottedHeavy: "dotted",
	dash: "dashed",
	dashedHeavy: "dashed",
	dashLong: "dashed",
	wave: "wavy",
	wavyHeavy: "wavy",
	wavyDouble: "wavy"
}), Xr = [
	"#c0392b",
	"#1a73e8",
	"#188038",
	"#a142f4",
	"#e37400",
	"#00838f",
	"#d01884",
	"#5f6368"
], Zr = /* @__PURE__ */ new Map();
function Qr(e) {
	let t = e ?? "", n = Zr.get(t);
	return n === void 0 && Zr.set(t, n = Zr.size), Xr[n % Xr.length];
}
function $r(e) {
	let t = Qr(e.author);
	return e.k === "ins" ? {
		color: t,
		textDecoration: "underline",
		textDecorationColor: t
	} : {
		color: t,
		textDecoration: "line-through",
		textDecorationColor: t
	};
}
function ei(e) {
	let t = {};
	if (!e) return t;
	e.b ? t.fontWeight = 700 : e.b === !1 && (t.fontWeight = 400), e.i ? t.fontStyle = "italic" : e.i === !1 && (t.fontStyle = "normal");
	let n = e.u && e.u !== "none", r = [n ? "underline" : "", e.strike || e.dstrike ? "line-through" : ""].filter(Boolean).join(" ");
	return r ? t.textDecoration = r : (e.u === "none" || e.strike === !1) && (t.textDecoration = "none"), n && Yr[e.u] && (t.textDecorationStyle = Yr[e.u]), e.dstrike && (t.textDecorationStyle = "double"), e.color && (t.color = L(e.color)), e.sz && (t.fontSize = `${e.va ? e.sz * .65 : e.sz}pt`), e.font && (t.fontFamily = e.font), (e.hl || e.shd) && (t.background = L(e.hl ?? e.shd)), e.va && (t.verticalAlign = e.va === "sup" ? "super" : "sub"), e.caps && (t.textTransform = "uppercase"), e.smallCaps && (t.fontVariant = "small-caps"), e.spacing && (t.letterSpacing = `${e.spacing}pt`), t;
}
function ti(e) {
	return e.line ? e.lineRule === "exact" ? `${e.line}pt` : e.lineRule === "atLeast" ? `max(${e.line}pt, 1.17em)` : +(e.line * 1.17).toFixed(3) : 1.17;
}
function ni(e, t, n) {
	return !e || e.t !== "p" || !e.ps.contextual ? "" : (t?.t === "p" && t.sid === e.sid ? "b" : "") + (n?.t === "p" && n.sid === e.sid ? "a" : "");
}
function ri(e, t) {
	let n = {
		paddingTop: t.includes("b") ? void 0 : Jr(e.before),
		paddingBottom: t.includes("a") ? void 0 : Jr(e.after),
		paddingLeft: Jr(e.indL),
		paddingRight: Jr(e.indR),
		textIndent: Jr(e.indFirst),
		textAlign: e.align,
		lineHeight: ti(e)
	};
	e.shd && (n.background = L(e.shd));
	let r = (e) => e ? `${e.w}pt ${e.style} ${L(e.color) ?? "currentColor"}` : void 0;
	return e.bTop && (n.borderTop = r(e.bTop)), e.bBottom && (n.borderBottom = r(e.bBottom)), e.bLeft && (n.borderLeft = r(e.bLeft)), e.bRight && (n.borderRight = r(e.bRight)), n;
}
function ii({ ctx: e, target: t, w: n, h: r, alt: i }) {
	let a = tt(e.client, t, !e.measuring), o = {
		width: `${n}pt`,
		height: `${r}pt`
	};
	return e.measuring || !a ? /* @__PURE__ */ W("span", {
		className: "de-img-missing",
		style: {
			...o,
			borderStyle: "none"
		}
	}) : a === "unsupported" ? /* @__PURE__ */ G("span", {
		className: "de-img-missing",
		style: o,
		title: t,
		children: [t.split(".").pop()?.toUpperCase(), " image"]
	}) : /* @__PURE__ */ W("img", {
		src: a,
		alt: i ?? "",
		style: {
			...o,
			verticalAlign: "bottom",
			display: "inline-block"
		},
		draggable: !1
	});
}
function ai({ x: t, ctx: n, o: r }) {
	let i = t.t === "text" ? void 0 : t.tc, a = {
		"data-o": r,
		"data-obj": "",
		contentEditable: !n.editable && void 0,
		...i ? {
			"data-tc": i.k,
			title: `${i.k === "ins" ? "Inserted" : "Deleted"}${i.author ? ` by ${i.author}` : ""}`
		} : {}
	};
	switch (t.t) {
		case "text": {
			let i = t.tc, a = /* @__PURE__ */ W("span", {
				"data-o": r,
				style: i ? {
					...ei(t.s),
					...$r(i)
				} : ei(t.s),
				"data-cm": t.cm?.join(" "),
				"data-tc": i?.k,
				title: i ? `${i.k === "ins" ? "Inserted" : "Deleted"}${i.author ? ` by ${i.author}` : ""}${i.date ? ` · ${new Date(i.date).toLocaleString()}` : ""}` : void 0,
				children: t.text
			}), o = n.measuring || n.editable ? void 0 : e(t.href);
			return o ? /* @__PURE__ */ W("a", {
				href: o,
				target: o.startsWith("#") ? void 0 : "_blank",
				rel: "noreferrer noopener",
				children: a
			}) : a;
		}
		case "field": {
			let e = t.kind === "PAGE" ? n.page >= 0 ? n.page + 1 : 1 : n.pages || 1;
			return /* @__PURE__ */ W("span", {
				...a,
				style: ei(t.s),
				children: e
			});
		}
		case "ref": return /* @__PURE__ */ W("span", {
			...a,
			style: ei(t.s),
			children: t.text
		});
		case "img": {
			let r = /* @__PURE__ */ W(ii, {
				ctx: n,
				target: t.target,
				w: t.w,
				h: t.h,
				alt: t.alt
			}), i = n.measuring || n.editable ? void 0 : e(t.href);
			return /* @__PURE__ */ W("span", {
				...a,
				"data-cm": t.cm?.join(" "),
				children: i ? /* @__PURE__ */ W("a", {
					href: i,
					target: "_blank",
					rel: "noreferrer noopener",
					children: r
				}) : r
			});
		}
		case "box": return /* @__PURE__ */ W("span", {
			...a,
			className: "de-tbox",
			style: {
				width: t.w ? `${t.w}pt` : void 0,
				minHeight: t.h ? `${t.h}pt` : void 0,
				background: L(t.fill),
				border: t.border
			},
			children: t.blocks.map((e, t) => /* @__PURE__ */ W(ci, {
				block: e,
				ctx: n
			}, t))
		});
		case "shape": return t.label ? /* @__PURE__ */ W("span", {
			...a,
			className: "de-ph",
			style: {
				width: `${t.w}pt`,
				height: `${t.h}pt`
			},
			children: t.label
		}) : /* @__PURE__ */ W("span", { ...a });
	}
}
function oi({ p: e, ctx: t, pa: n, sp: r, bi: i }) {
	let a = e.ps.indFirst && e.ps.indFirst < 0 ? -e.ps.indFirst : 0, o = e.runs.length > 0, s = ri(e.ps, r);
	o || (s.fontSize = Jr(e.markSz), e.markFont && (s.fontFamily = e.markFont));
	let c = t.editable && n !== void 0, l = 0, u = e.runs.map((e, n) => {
		let r = /* @__PURE__ */ W(ai, {
			x: e,
			ctx: t,
			o: l
		}, n);
		return l += e.t === "text" ? e.text.length : 1, r;
	});
	return /* @__PURE__ */ G("div", {
		className: e.prot && t.editable ? "de-p de-prot" : "de-p",
		style: s,
		"data-pa": n,
		"data-bi": i,
		"data-prot": e.prot,
		title: e.prot && t.editable ? g(e.prot) : void 0,
		contentEditable: t.editable && !c ? !1 : void 0,
		children: [
			e.marker && /* @__PURE__ */ G("span", {
				className: "de-marker",
				contentEditable: !t.editable && void 0,
				style: {
					...ei(e.marker.s),
					minWidth: e.marker.tab && a ? `${a}pt` : void 0
				},
				children: [e.marker.text, e.marker.tab && !a ? "	" : ""]
			}),
			u,
			!o && (c ? /* @__PURE__ */ W("span", {
				"data-o": 0,
				"data-empty": "",
				children: "​"
			}) : "​")
		]
	});
}
function si({ t: e, ctx: t, pa: n, bi: r, rowFrom: i = 0, rowTo: a = e.rows.length, repeat: o = 0 }) {
	let s = e.cols.reduce((e, t) => e + t, 0), c = { width: s ? `${s}pt` : "100%" };
	e.align === "center" ? c.margin = "0 auto" : e.align === "right" ? c.marginLeft = "auto" : e.indL && (c.marginLeft = `${e.indL}pt`);
	let l = t.colResize && n !== void 0 && !n.includes(".") && s > 0 ? t.colResize : void 0, u = (t) => (r) => {
		let i = r.currentTarget.parentElement.querySelector("table");
		if (!i || !l) return;
		r.preventDefault(), r.stopPropagation();
		let a = s / i.getBoundingClientRect().width, o = r.clientX, c = r.currentTarget;
		c.setPointerCapture(r.pointerId);
		let u = (n) => {
			let r = [...e.cols], i = n * a;
			if (t < r.length - 1) {
				let e = Math.max(-(r[t] - 12), Math.min(i, r[t + 1] - 12));
				r[t] += e, r[t + 1] -= e;
			} else r[t] = Math.max(12, r[t] + i);
			return r;
		}, d = (e) => {
			let t = u(e.clientX - o);
			i.querySelectorAll("col").forEach((e, n) => e.style.width = `${t[n]}pt`), i.style.width = `${t.reduce((e, t) => e + t, 0)}pt`;
		}, f = (e) => {
			c.removeEventListener("pointermove", d), c.removeEventListener("pointerup", f), Math.abs(e.clientX - o) > 1 && l(Number(n), u(e.clientX - o));
		};
		c.addEventListener("pointermove", d), c.addEventListener("pointerup", f);
	}, d = 0, f = l ? e.cols.map((e, t) => (d += e, /* @__PURE__ */ W("div", {
		className: "de-col-resize",
		contentEditable: !1,
		style: { left: `calc(${d}pt - 3px)` },
		onPointerDown: u(t)
	}, t))) : null, p = (r, i) => {
		let a = e.rows[r], o = i ? {
			...t,
			editable: !1
		} : t;
		return /* @__PURE__ */ W("tr", {
			style: { height: a.h ? `${a.h}pt` : void 0 },
			"data-ri": i ? void 0 : r,
			"data-repeat": i ? "" : void 0,
			className: i ? "de-tbl-repeat" : void 0,
			"aria-hidden": i ? !0 : void 0,
			contentEditable: !i && void 0,
			children: a.cells.map((e, t) => /* @__PURE__ */ W("td", {
				colSpan: e.colSpan > 1 ? e.colSpan : void 0,
				rowSpan: e.rowSpan > 1 ? e.rowSpan : void 0,
				style: {
					borderTop: e.borders.t,
					borderRight: e.borders.r,
					borderBottom: e.borders.b,
					borderLeft: e.borders.l,
					background: L(e.shd),
					verticalAlign: e.vAlign,
					padding: `${e.pad[0]}pt ${e.pad[1]}pt ${e.pad[2]}pt ${e.pad[3]}pt`
				},
				children: e.blocks.map((a, s) => /* @__PURE__ */ W(ci, {
					block: a,
					ctx: o,
					pa: !i && n !== void 0 && a.t === "p" && a.pid !== void 0 && !a.ro ? `${n}.${r}.${t}.${s}` : void 0,
					sp: ni(a, e.blocks[s - 1], e.blocks[s + 1]),
					nested: !0
				}, a.t === "p" ? `${s}:${a.ver ?? 0}` : s))
			}, t))
		}, i ? `h${r}` : r);
	}, m = /* @__PURE__ */ G("table", {
		className: "de-tbl",
		style: c,
		"data-bi": r,
		children: [s > 0 && /* @__PURE__ */ W("colgroup", { children: e.cols.map((e, t) => /* @__PURE__ */ W("col", { style: { width: `${e}pt` } }, t)) }), /* @__PURE__ */ G("tbody", { children: [Array.from({ length: o }, (e, t) => p(t, !0)), Array.from({ length: a - i }, (e, t) => p(i + t, !1))] })]
	});
	if (!f) return m;
	let h = c.marginLeft && c.marginLeft !== "auto" ? c.marginLeft : void 0;
	return /* @__PURE__ */ G("div", {
		className: "de-tbl-wrap",
		style: {
			marginLeft: h,
			width: c.width,
			marginRight: e.align === "center" ? "auto" : void 0,
			...e.align === "center" || e.align === "right" ? { marginLeft: "auto" } : {}
		},
		children: [m, f]
	});
}
var ci = R(function({ block: e, ctx: t, pa: n, sp: r = "", nested: i, bi: a, rowFrom: o, rowTo: s, repeat: c }) {
	switch (e.t) {
		case "p": return /* @__PURE__ */ W(oi, {
			p: e,
			ctx: t,
			pa: n,
			sp: r,
			bi: a
		});
		case "tbl": return /* @__PURE__ */ W("div", {
			style: { overflow: "visible" },
			contentEditable: t.editable && (i || n === void 0) ? !1 : void 0,
			children: /* @__PURE__ */ W(si, {
				t: e,
				ctx: t,
				pa: i ? void 0 : n,
				bi: a,
				rowFrom: o,
				rowTo: s,
				repeat: c
			})
		});
		default: return /* @__PURE__ */ W("div", {});
	}
}), li = 4 / 3, ui = (e) => (e.h - e.mt - e.mb) * li;
function di(e, t) {
	let n = Array(e.length), r = t;
	for (let t = e.length - 1; t >= 0; t--) {
		let i = e[t];
		i.t === "sect" && (r = i.page), n[t] = r;
	}
	return n;
}
function fi(e, t, n) {
	for (let r = 0; r < e.length; r++) {
		let i = e[r];
		if (t < i.start || t >= i.end) continue;
		let a = i.cuts?.[t];
		if (!a || n === void 0 || n >= a.from && n < a.to) return r;
	}
	return -1;
}
function pi(e) {
	let t = 0;
	for (; t < e.rows.length && e.rows[t].header;) t++;
	return t >= e.rows.length ? 0 : t;
}
var mi = /* @__PURE__ */ new WeakMap();
function hi(e) {
	let t = mi.get(e);
	if (t) return t;
	let n = Array(e.rows.length + 1).fill(!1);
	return e.rows.forEach((e, t) => {
		for (let r of e.cells) for (let e = t + 1; e < t + r.rowSpan && e < n.length; e++) n[e] = !0;
	}), mi.set(e, n), n;
}
function gi(e, t, n, r, i = "nextPage") {
	let { heights: a, rows: o } = t, s = e.length, c = /* @__PURE__ */ new Map(), l = i;
	for (let t = s - 1; t >= 0; t--) {
		let n = e[t];
		n.t === "sect" && (c.set(t, l), l = n.kind);
	}
	let u = di(e, r), d = [], f = {
		start: 0,
		end: 0,
		used: 0
	}, p = r, m = 0, h = 1, g = 0, _ = 0, v = (e) => {
		p = e < s ? u[e] : r, f = {
			start: e,
			end: e,
			used: 0,
			page: p
		}, m = ui(p), h = p.cols && p.cols > 1 ? p.cols : 1, g = 0, _ = 0;
	}, y = (e) => {
		d.push(f), v(e);
	};
	v(0);
	let b = (e) => {
		let t = a.get(e) ?? 0;
		if (e.t !== "tbl") return t;
		let n = o?.get(e);
		if (!n || n.length !== e.rows.length) return t;
		let r = pi(e), i = 0;
		for (let e = 0; e <= r && e < n.length; e++) i += n[e];
		return i;
	}, x = (e, t, n) => {
		let r = n.length, i = pi(t), a = hi(t), o = (e, t) => {
			let r = 0;
			for (let i = e; i < t; i++) r += n[i];
			return r;
		}, s = o(0, i), c = (e) => e >= r || e > i && !a[e], l = 0;
		for (; l < r;) {
			let t = l > 0 ? i : 0, a = l, u = t ? s : 0;
			for (; a < r && _ + u + n[a] <= m;) u += n[a++];
			for (; a > l && !c(a);) u -= n[--a];
			if (a === l) {
				if (_ > 0) {
					y(e);
					continue;
				}
				for (a = l + 1; a < r && !c(a);) a++;
				u = (t ? s : 0) + o(l, a), f.clip = !0;
			}
			(l > 0 || a < r) && ((f.cuts ??= {})[e] = {
				from: l,
				to: a,
				repeat: t
			}), f.end = e + 1, _ += u, f.used = Math.max(f.used, Math.min(_, m)), l = a, l < r && y(e);
		}
	};
	for (let t = 0; t < n; t++) {
		let i = e[t], l = a.get(i) ?? 0;
		if (i.t === "sect") {
			f.end = t + 1;
			let e = c.get(t), n = t + 1 < s ? u[t + 1] : r;
			if (e === "continuous" && n.w === p.w && n.h === p.h) continue;
			y(t + 1), (e === "evenPage" ? d.length % 2 == 0 : e === "oddPage" && d.length % 2 == 1) && y(t + 1);
		} else {
			if (i.t === "p" && i.pb && f.end > f.start) y(t);
			else if (h === 1) {
				if (i.t === "p" && i.ps.keepNext && _ > 0) {
					let r = 0;
					for (let i = t; i < n && r <= m; i++) {
						let n = e[i];
						if (n.t === "sect" || i > t && n.t === "p" && n.pb) break;
						let o = n.t === "p" && n.ps.keepNext;
						if (r += o ? a.get(n) ?? 0 : b(n), !o) break;
					}
					r <= m && _ + r > m && y(t);
				}
				let r = i.t === "tbl" ? o?.get(i) : void 0;
				if (i.t === "tbl" && r && r.length === i.rows.length && r.length > 1 && _ + l > m) {
					x(t, i, r);
					continue;
				}
				_ > 0 && _ + l > m && y(t);
			} else _ > 0 && _ + l > m && (g + 1 < h ? (g++, _ = 0) : y(t));
			f.end = t + 1, _ += l, f.used = Math.max(f.used, h > 1 ? Math.min(_, m) : _);
		}
	}
	return (f.end > f.start || !d.length) && d.push(f), d;
}
var _i = 40, vi = (e, t = 500) => e.length > t ? e.slice(0, t) : e;
function yi(e) {
	let t = e.replace(/\s+/g, " ").trim(), n = 2166136261;
	for (let e = 0; e < t.length; e++) n ^= t.charCodeAt(e), n = Math.imul(n, 16777619);
	return (n >>> 0).toString(16).padStart(8, "0");
}
function bi(e, t, n) {
	let r = Math.max(0, Math.min(t, n)), i = Math.min(e.length, Math.max(t, n));
	return {
		quote: vi(e.slice(r, i)),
		prefix: e.slice(Math.max(0, r - _i), r),
		suffix: e.slice(i, i + _i)
	};
}
var xi = (e) => se(e.runs.filter((e) => e.t !== "text" || e.tc?.k !== "del"));
function Si(e) {
	let t = [];
	return e.forEach((e) => {
		if (e.t === "p") t.push(xi(e));
		else if (e.t === "tbl") for (let n of e.rows) t.push(n.cells.map((e) => e.blocks.map((e) => e.t === "p" ? xi(e) : "").join(" ")).join("	"));
	}), t.join("\n");
}
var Ci = (e) => e.split(".").map(Number);
function wi(e, t) {
	let n = e[t[0]];
	if (t.length === 1) return n?.t === "p" ? n : void 0;
	if (n?.t !== "tbl") return;
	let r = n.rows[t[1]]?.cells[t[2]]?.blocks[t[3]];
	return r?.t === "p" ? r : void 0;
}
var Ti = (e) => e.join(".");
function Ei(e, t, n) {
	let r = wi(e, t), i = { blockPath: t };
	return r?.paraId && (i.paraId = r.paraId), r?.prot && (i.protected = r.prot), n?.start !== void 0 && (i.start = n.start), n?.end !== void 0 && (i.end = n.end), i;
}
function Di(e, t, n) {
	return n === "undo" || n === "redo" ? n : t.length > e.length ? "paragraph.insert" : t.length < e.length ? "paragraph.delete" : e.every((e, n) => xi(e) === xi(t[n])) ? "format" : "text";
}
function Oi(e, t) {
	let n = e.filter((e) => e.t === "tbl").length, r = t.filter((e) => e.t === "tbl").length;
	return r > n ? "table.insert" : r < n ? "table.delete" : n || r ? "table" : t.length > e.length ? "paragraph.insert" : t.length < e.length ? "paragraph.delete" : "text";
}
var ki = (e, t) => `${w(t)}${e + 1}`;
function Ai(e) {
	let t = ki(e.r0, e.c0);
	return e.r0 === e.r1 && e.c0 === e.c1 ? t : `${t}:${ki(e.r1, e.c1)}`;
}
var ji = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/;
function Mi(e) {
	let t = 0;
	for (let n of e.toUpperCase()) t = t * 26 + n.charCodeAt(0) - 64;
	return t - 1;
}
function Ni(e) {
	let [t, n = t] = e.trim().split(":"), r = ji.exec(t ?? ""), i = ji.exec(n ?? "");
	if (!r || !i) return null;
	let a = Number(r[2]) - 1, o = Mi(r[1]), s = Number(i[2]) - 1, c = Mi(i[1]);
	return {
		r0: Math.min(a, s),
		c0: Math.min(o, c),
		r1: Math.max(a, s),
		c1: Math.max(o, c)
	};
}
// src/host/docx-events.ts
function Pi(e, t, n) {
	if (e.kind === "paras") {
		let r = (e.next[0] ?? e.before[0])?.paraId;
		return {
			format: "docx",
			kind: Di(e.before, e.next, n),
			before: e.before.map(xi).join("\n"),
			after: e.next.map(xi).join("\n"),
			location: {
				blockPath: Ci(t?.[0] ?? "0"),
				...r ? { paraId: r } : {}
			}
		};
	}
	let r = [...e.next, ...e.before].find((e) => e.t === "p"), i = r?.t === "p" ? r.paraId : void 0;
	return {
		format: "docx",
		kind: n === "undo" ? "undo" : Oi(e.before, e.next),
		before: Si(e.before),
		after: Si(e.next),
		location: {
			blockPath: [e.bi],
			...i ? { paraId: i } : {}
		}
	};
}
// src/host/registry.ts
var Fi = class {
	editFns = /* @__PURE__ */ new Set();
	selFns = /* @__PURE__ */ new Set();
	refusalFns = /* @__PURE__ */ new Set();
	providers = [];
	onRefusal(e) {
		return this.refusalFns.add(e), () => void this.refusalFns.delete(e);
	}
	emitRefusal(e) {
		for (let t of [...this.refusalFns]) try {
			t(e);
		} catch (e) {
			console.error("[office-engine] onRefusal listener failed", e);
		}
	}
	onEdit(e) {
		return this.editFns.add(e), () => void this.editFns.delete(e);
	}
	onSelection(e) {
		return this.selFns.add(e), () => void this.selFns.delete(e);
	}
	get listening() {
		return this.editFns.size > 0;
	}
	emitEdit(e) {
		for (let t of [...this.editFns]) try {
			t(e);
		} catch (e) {
			console.error("[office-engine] onEdit listener failed", e);
		}
	}
	lastSel = "";
	emitSelection() {
		if (!this.selFns.size) return;
		let e = this.ask("selection") ?? null, t = JSON.stringify(e, (e, t) => e === "rect" ? void 0 : t);
		if (t !== this.lastSel) {
			this.lastSel = t;
			for (let t of [...this.selFns]) try {
				t(e);
			} catch (e) {
				console.error("[office-engine] onSelectionChange listener failed", e);
			}
		}
	}
	provide(e) {
		return this.providers.push(e), () => {
			let t = this.providers.indexOf(e);
			t >= 0 && this.providers.splice(t, 1);
		};
	}
	ask(e, ...t) {
		for (let n = this.providers.length - 1; n >= 0; n--) {
			let r = this.providers[n][e];
			if (r) return r(...t);
		}
	}
}, Ii = /* @__PURE__ */ new WeakMap();
function Li(e) {
	let t = Ii.get(e);
	return t || Ii.set(e, t = new Fi()), t;
}
// src/host/react.ts
function Ri(e, t) {
	let n = V(t);
	n.current = t, B(() => {
		let t = {};
		for (let e of Object.keys(n.current)) t[e] = (...t) => n.current[e](...t);
		return Li(e).provide(t);
	}, [e]);
}
function zi(e) {
	let t = V(e);
	return t.current = e, Me(() => new Proxy({}, { get: (e, n) => {
		let r = t.current[n];
		return typeof r == "function" ? r.bind(t.current) : r;
	} }), []);
}
// src/host/dom.ts
var Bi = () => new Promise((e) => requestAnimationFrame(() => e()));
async function Vi(e) {
	for (let t = 0; t < e; t++) await Bi();
}
async function Hi(e, t) {
	let n = performance.now() + t;
	for (; !e();) {
		if (performance.now() > n) return !1;
		await Bi();
	}
	return !0;
}
var Ui = (e) => Array.from(e), Wi = (e) => e.getRootNode();
function Gi(e) {
	return Wi(e).activeElement;
}
var Ki = /[\p{L}\p{N}_'’-]/u;
function qi(e, t) {
	let n = Math.min(t, e.length), r = n;
	for (; n > 0 && Ki.test(e[n - 1]);) n--;
	for (; r < e.length && Ki.test(e[r]);) r++;
	return [n, r];
}
function Ji(e, t, n) {
	let r = "ownerDocument" in e && e.ownerDocument ? e.ownerDocument : e, i = r.caretPositionFromPoint?.(t, n);
	if (i) return {
		node: i.offsetNode,
		offset: i.offset
	};
	let a = r.caretRangeFromPoint?.(t, n);
	return a ? {
		node: a.startContainer,
		offset: a.startOffset
	} : null;
}
function Yi(e, t, n) {
	if (e.nodeType !== 3) return !1;
	let r = document.createRange();
	r.selectNodeContents(e);
	for (let e of Array.from(r.getClientRects())) if (t >= e.left - 1 && t <= e.right + 1 && n >= e.top - 1 && n <= e.bottom + 1) return !0;
	return !1;
}
// src/react/docx/host.ts
var Xi = 8e3, Zi = (e) => e.dataset.ri === void 0 ? Array.from(e.parentElement.children).indexOf(e) : Number(e.dataset.ri), Qi = (e) => "blockPath" in e;
function $i(e) {
	let t = (t) => {
		let n = e.pages();
		if (!n) return null;
		let r = Ti(t);
		return n.querySelector(`[data-pa="${r}"]`) ?? (t.length === 1 ? n.querySelector(`[data-bi="${t[0]}"]`) : null);
	}, n = (e) => {
		if (e.dataset.pa) return Ci(e.dataset.pa);
		if (e.dataset.bi !== void 0) return [Number(e.dataset.bi)];
		if (e.closest("[data-repeat]")) return null;
		let t = e.closest("td"), n = t?.closest("table[data-bi]");
		if (!t || !n) return null;
		let r = t.parentElement, i = Array.from(t.children).findIndex((t) => t === e || t.contains(e));
		return [
			Number(n.dataset.bi),
			Zi(r),
			Array.from(r.children).indexOf(t),
			Math.max(0, i)
		];
	}, r = async (n, r, i = Xi) => {
		let a = performance.now() + i;
		for (; performance.now() < a;) {
			let i = e.scroll(), a = n[0];
			if (i && e.laidOut(a)) {
				let o = e.pageScrollTop(a, n[1]);
				if (o >= 0) {
					i.scrollTop = o, await Vi(2);
					let a = t(n);
					if (a) {
						let o = i.getBoundingClientRect().top - r * e.z();
						i.scrollTop += a.getBoundingClientRect().top - o, await Vi(2);
						let s = t(n);
						if (s && Math.abs(s.getBoundingClientRect().top - o) < 3 || s && i.scrollTop >= i.scrollHeight - i.clientHeight - 1) return !0;
					}
				}
			}
			await Bi();
		}
		return !1;
	}, i = (t) => {
		let n = e.blocks(), r = wi(n, t.blockPath);
		if (r && yi(xi(r)) === t.textHash) return t.blockPath;
		if (!e.loaded() && !r) return "wait";
		let i = n.map((e, t) => t).sort((e, n) => Math.abs(e - t.blockPath[0]) - Math.abs(n - t.blockPath[0]));
		for (let e of i) {
			let r = n[e];
			if (r.t === "p" && r.pid !== void 0 && yi(xi(r)) === t.textHash && t.textHash !== yi("")) return [e];
		}
		let a = t.quote.trim();
		if (a.length >= 8) for (let e of i) {
			let t = n[e];
			if (t.t === "p" && xi(t).trim().startsWith(a)) return [e];
		}
		return null;
	}, a = (t, n) => {
		let r = e.pages(), i = r ? P(r, t, n) : null;
		return i ? {
			path: Ci(i.pa),
			o: i.o,
			pa: i.pa
		} : null;
	};
	return {
		async flush() {
			let t = e.pages();
			t && e.editor.input.isComposing && (Gi(t)?.blur?.(), await Hi(() => !e.editor.input.isComposing, 500)), await e.editor.whenIdle();
		},
		getViewState() {
			let t = e.scroll(), r = e.pages();
			if (!t || !r) return null;
			let i = t.getBoundingClientRect();
			for (let a of r.querySelectorAll(".de-page .de-p[data-bi], .de-page .de-p[data-pa], .de-page table[data-bi]")) {
				let r = a.getBoundingClientRect();
				if (r.bottom <= i.top + 1) continue;
				let o = n(a);
				if (!o) continue;
				let s = wi(e.blocks(), o), c = s ? xi(s) : a.textContent ?? "";
				return {
					format: "docx",
					blockPath: o,
					textHash: yi(c),
					quote: c.trim().slice(0, 80),
					offsetPx: +((i.top - r.top) / e.z()).toFixed(1),
					zoom: e.zoom(),
					fraction: +(t.scrollTop / Math.max(1, t.scrollHeight - t.clientHeight)).toFixed(4)
				};
			}
			return null;
		},
		async setViewState(t) {
			if (t.format !== "docx") return !1;
			t.zoom !== e.zoom() && (e.setZoom(t.zoom), await Vi(3));
			let n = performance.now() + Xi, a = i(t);
			for (; a === "wait" && performance.now() < n;) await Bi(), a = i(t);
			if (a && a !== "wait" && await r(a, t.offsetPx, Math.max(100, n - performance.now()))) return !0;
			let o = e.scroll();
			return o && t.fraction !== void 0 && (o.scrollTop = t.fraction * Math.max(0, o.scrollHeight - o.clientHeight)), !1;
		},
		hitTest(t, r) {
			let i = e.pages(), o = e.scroll();
			if (!i || !o) return null;
			let s = o.getBoundingClientRect();
			if (t < s.left || t > s.right || r < s.top || r > s.bottom) return null;
			let c = e.blocks(), l = Wi(i).elementsFromPoint(t, r).filter((e) => i.contains(e) && !e.closest("[data-repeat]")), u = (e, t, n, r, i) => ({
				format: "docx",
				kind: e,
				location: Ei(c, t, i),
				...r === void 0 ? {} : { quote: vi(r) },
				rect: n
			}), d = l.find((e) => e.tagName === "IMG" && e.closest("[data-obj]")), f = l.find((e) => e.matches(".de-p") && !e.closest(".de-hf") && (e.dataset.pa !== void 0 || e.dataset.bi !== void 0 || e.closest("td")));
			if (d && f) {
				let e = n(f), t = Number(d.closest("[data-obj]")?.dataset.o);
				if (e) return u("image", e, d.getBoundingClientRect(), void 0, Number.isFinite(t) ? {
					start: t,
					end: t + 1
				} : void 0);
			}
			if (f) {
				let e = n(f);
				if (e) {
					let n = wi(c, e), o = n ? xi(n) : f.textContent ?? "", s = Ji(Wi(i), t, r);
					if (s && f.contains(s.node) && Yi(s.node, t, r)) {
						let t = f.dataset.pa ? a(s.node, s.offset) : null;
						if (t) {
							let [n, r] = qi(o, t.o);
							if (r > n) return u("text", e, f.getBoundingClientRect(), o.slice(n, r), {
								start: n,
								end: r
							});
						}
						return u("text", e, f.getBoundingClientRect(), o);
					}
					return u("paragraph", e, f.getBoundingClientRect(), o);
				}
			}
			let p = l.find((e) => e.tagName === "TD"), m = l.find((e) => e.tagName === "TABLE" && e.dataset.bi !== void 0);
			if (p && m) {
				let e = p.parentElement;
				return u("cell", [
					Number(m.dataset.bi),
					Zi(e),
					Array.from(e.children).indexOf(p),
					0
				], p.getBoundingClientRect(), p.textContent ?? "");
			}
			if (m) return u("table", [Number(m.dataset.bi)], m.getBoundingClientRect());
			let h = Array.from(i.querySelectorAll(".de-page")), g = (e) => r < e.top ? e.top - r : r > e.bottom ? r - e.bottom : 0, _ = l.find((e) => e.matches(".de-page")) ?? h.sort((e, t) => g(e.getBoundingClientRect()) - g(t.getBoundingClientRect()))[0], v;
			for (let e of Array.from(_?.querySelectorAll(".de-p[data-bi], table[data-bi]") ?? [])) (!v || g(e.getBoundingClientRect()) < g(v.getBoundingClientRect())) && (v = e);
			return v ? u("region", [Number(v.dataset.bi)], _.getBoundingClientRect()) : u("region", [0], (_ ?? o).getBoundingClientRect());
		},
		rectsFor(n) {
			if (!Qi(n)) return [];
			let r = e.pages(), i = t(n.blockPath);
			if (!r || !i) return [];
			if (n.start !== void 0 && n.end !== void 0 && n.end > n.start && i.dataset.pa) {
				let e = M(r, {
					pa: i.dataset.pa,
					o: n.start
				}), t = M(r, {
					pa: i.dataset.pa,
					o: n.end
				});
				if (e && t) {
					let n = document.createRange();
					n.setStart(e[0], e[1]), n.setEnd(t[0], t[1]);
					let r = Ui(n.getClientRects()).filter((e) => e.width > 0 || e.height > 0);
					if (r.length) return r;
				}
			}
			return [i.getBoundingClientRect()];
		},
		async scrollTo(e) {
			return Qi(e) ? await r(e.blockPath, -24) && !!t(e.blockPath) : !1;
		},
		selection() {
			let t = e.pages();
			if (!t) return null;
			let n = ve(t);
			if (!n || !n.rangeCount || !n.anchorNode || !n.focusNode || !t.contains(n.anchorNode) || !t.contains(n.focusNode)) return null;
			let r = a(n.anchorNode, n.anchorOffset), i = a(n.focusNode, n.focusOffset);
			if (!r || !i) return null;
			let [o, s] = e.editor.cmp(r.pa, i.pa) < 0 || r.pa === i.pa && r.o <= i.o ? [r, i] : [i, r], c = e.blocks(), l = wi(c, o.path), u = wi(c, s.path);
			if (!l || !u) return null;
			let d = xi(l), f = xi(u), p = o.pa === s.pa, m = p ? d.slice(o.o, s.o) : d.slice(o.o);
			if (!p) {
				try {
					for (let t of e.editor.span(o.pa, s.pa) ?? []) {
						if (t === o.pa || t === s.pa) continue;
						let n = e.editor.para(t);
						n && (m += `\n${xi(n)}`);
					}
				} catch {}
				m += `\n${f.slice(0, s.o)}`;
			}
			let h = bi(d, o.o, p ? s.o : d.length);
			return {
				format: "docx",
				kind: "text",
				location: Ei(c, o.path, {
					start: o.o,
					end: p ? s.o : d.length
				}),
				quote: vi(m),
				prefix: h.prefix,
				suffix: p ? h.suffix : "",
				...p ? {} : { endLocation: Ei(c, s.path, {
					start: 0,
					end: s.o
				}) },
				collapsed: p && o.o === s.o
			};
		}
	};
}
// src/react/docx/DocxView.tsx
var ea = 4 / 3, ta = (e) => {
	let t = e.split(".")[1];
	return t === void 0 ? void 0 : Number(t);
}, na = 16, ra = 24, ia = /* @__PURE__ */ new WeakSet();
function aa(e, t, n) {
	for (let r of e.querySelectorAll(`[data-pa="${t}"]`)) for (let e of r.querySelectorAll(`[data-obj][data-o="${n}"]`)) if (e.closest("[data-pa]") === r) return e.querySelector("img") ?? e;
	return null;
}
var oa = [
	"nw",
	"n",
	"ne",
	"e",
	"se",
	"s",
	"sw",
	"w"
], sa = (e) => se(e.runs.filter((e) => e.t !== "text" || e.tc?.k !== "del"));
function ca(e, t) {
	let n = [];
	return e.forEach((e, r) => {
		if (e.t !== "p" || e.pid === void 0) return;
		let i = !!t && e.sid === t, a = i ? 0 : e.ps.outline;
		if (a === void 0 || a > 5) return;
		let o = sa(e).trim();
		o && n.push({
			bi: r,
			lvl: i ? 0 : a + +!!t,
			text: o
		});
	}), n;
}
var la = (e) => !!e && e.t === "p" && e.pid !== void 0 && !e.ro;
function ua({ client: t, onStatus: n, initialZoom: r = "fit" }) {
	let i = Ft(), o = V({
		blocks: [],
		heights: /* @__PURE__ */ new WeakMap(),
		rows: /* @__PURE__ */ new WeakMap(),
		widths: /* @__PURE__ */ new WeakMap(),
		dirty: /* @__PURE__ */ new Set(),
		frontier: 0
	}).current, [s, c] = Qe(), [u, d] = H(null), [f, p] = H(!1), [m, h] = H(null), g = Oe((e) => h(e), []), [_, v] = H(null), [y, b] = H(r), [x, S] = $e(), C = et(x), w = V(null), T = Me(() => new Bn(t, o, c), [
		t,
		o,
		c
	]), ee = Oe((e, t) => T.setColumnWidths(e, t), [T]), E = i.editable && !!_ && !_.error, [D, O] = H({
		open: !1,
		q: "",
		idx: 0
	}), [te, ne] = H(null), [re, ie] = H(null), [ae, k] = H(null), [oe, ce] = H(!1), [le, ue] = H(!1), [de, fe] = H(null), [pe, me] = H(null), he = V(!1), ge = V(null);
	B(() => (T.onImage = (e) => fe((t) => t?.pa === e?.pa && t?.o === e?.o && t?.w === e?.w && t?.h === e?.h && t?.target === e?.target && t?.alt === e?.alt ? t : e), T.onStyles = (e) => d((t) => t && {
		...t,
		styles: e
	}), T.onHeaders = (e) => d((t) => t && {
		...t,
		...e
	}), T.onPage = (e) => d((t) => t && {
		...t,
		page: e
	}), T.onHF = (e) => d((t) => t && {
		...t,
		header: void 0,
		footer: void 0,
		firstHeader: void 0,
		firstFooter: void 0,
		...e.headers,
		titlePg: e.titlePg
	}), T.onPainter = ue, () => {
		T.onImage = T.onStyles = T.onHeaders = T.onPainter = T.onPage = T.onHF = void 0;
	}), [T]), B(() => {
		let e = Li(t);
		return T.editSink = (t, n, r) => {
			e.listening && e.emitEdit(Pi(t, n, r));
		}, () => {
			T.editSink = void 0;
		};
	}, [t, T]), B(() => _ && !_.error ? A(t, "docx", {
		editor: T,
		st: o
	}) : void 0, [
		t,
		T,
		o,
		_
	]), B(() => {
		let e = [
			t.on("docx:blocks", (e) => {
				for (let t of e) o.blocks.push(t);
				c();
			}),
			t.on("docx:meta", (e) => {
				let t = T.pageNow ? {
					...e,
					page: T.pageNow
				} : e;
				T.hfNow && (t = {
					...t,
					header: void 0,
					footer: void 0,
					firstHeader: void 0,
					firstFooter: void 0,
					...T.hfNow.headers,
					titlePg: T.hfNow.titlePg
				}), d(t), e.styles && (T.styles = e.styles);
			}),
			t.on("docx:done", v)
		];
		return ia.has(t) || (ia.add(t), t.call("docx.start").catch(() => {})), () => e.forEach((e) => e());
	}, [
		t,
		c,
		o,
		T
	]);
	let j = u?.page ?? l, N = (e) => {
		let t = e.cols && e.cols > 1 ? e.cols : 1;
		return (e.w - e.ml - e.mr - (t > 1 ? e.colGap ?? 36 : 0) * (t - 1)) / t;
	}, F = N(j), [ye, I] = H(40), be = V(null), xe = `${F}|${u?.font}|${u?.sz}`, Se = V(xe);
	Se.current !== xe && (Se.current = xe, o.heights = /* @__PURE__ */ new WeakMap(), o.rows = /* @__PURE__ */ new WeakMap(), o.widths = /* @__PURE__ */ new WeakMap(), o.dirty.clear(), o.frontier = 0);
	let Ce = o.blocks.length, L = Me(() => di(o.blocks, j), [
		s,
		Ce,
		j
	]);
	Me(() => {
		let e = o.widths;
		if (e) for (let t = 0; t < Math.min(o.frontier, Ce); t++) {
			let n = e.get(o.blocks[t]);
			n !== void 0 && Math.abs(n - N(L[t])) > .01 && o.dirty.add(o.blocks[t]);
		}
	}, [L]);
	let we = [];
	for (let e of o.dirty) {
		if (we.length >= 50) break;
		let t = o.blocks.indexOf(e);
		t < 0 ? o.dirty.delete(e) : we.push({
			b: e,
			i: t
		});
	}
	let Te = Math.min(Ce, o.frontier + ye);
	for (let e = o.frontier; e < Te; e++) we.push({
		b: o.blocks[e],
		i: e
	});
	let Ee = performance.now(), De = Me(() => ({
		client: t,
		page: -1,
		pages: 0,
		measuring: !0,
		editable: !1
	}), [t]);
	Ye(() => {
		let e = be.current;
		if (!e || !we.length || !u) return;
		let t = Array.from(e.children), n = t.map((e) => e.getBoundingClientRect().height), r = t.map((e, t) => {
			if (we[t].b.t !== "tbl") return;
			let n = e.querySelector("table.de-tbl > tbody");
			return n ? Array.from(n.children, (e) => e.getBoundingClientRect().height) : void 0;
		}), i = performance.now() - Ee, a = setTimeout(() => {
			we.forEach((e, t) => {
				o.heights.set(e.b, n[t] ?? 0), o.widths?.set(e.b, N(L[e.i] ?? j));
				let i = r[t];
				i && e.b.t === "tbl" && i.length === e.b.rows.length ? o.rows?.set(e.b, i) : o.rows?.delete(e.b), o.dirty.delete(e.b);
			}), Te > o.frontier && (o.frontier = Te), I((e) => i < 10 ? Math.min(e * 2, 1500) : i > 30 ? Math.max(10, e >> 1) : e), c();
		}, 0);
		return () => clearTimeout(a);
	});
	let R = Me(() => gi(o.blocks, {
		heights: o.heights,
		rows: o.rows
	}, Math.min(o.frontier, Ce), j, u?.final && u.sectKind || "nextPage"), [
		s,
		j,
		Ce,
		u?.final,
		u?.sectKind
	]), z = R.map((e) => e.page ?? j), ke = Math.max(j.w, ...z.map((e) => e.w)) * ea, Ae = Math.max(j.h, ...z.map((e) => e.h)) * ea, je = S.w ? Math.max(.2, Math.min(2, (S.w - 48) / ke)) : 1, Ne = y === "fit" ? Math.min(je, 1.25) : y, Pe = !!_ && o.frontier >= Ce, Fe = R.map((e, t) => Math.max(z[t].h * ea, (z[t].mt + z[t].mb) * ea + e.used) * Ne), U = [], Ie = ra;
	for (let e of Fe) U.push(Ie), Ie += e + na;
	let Le = +!Pe, Re = Ie + Le * (Ae * Ne + na) + ra - na, ze = Math.max(S.w, ke * Ne + 48), Be = (e) => Math.max(ra, (ze - z[e].w * ea * Ne) / 2), Ve = Math.max(ra, (ze - j.w * ea * Ne) / 2), K = U.length ? nt(U, C.y - Ae * Ne) : 0, He = U.length ? nt(U, C.y + S.h + 200) : -1, Ue = Pe ? R.length : 0, We = E && T.input.lastSel ? Number(T.input.lastSel.f.pa.split(".")[0]) : -1, Ge = We >= 0 ? fi(R, We, ta(T.input.lastSel.f.pa)) : -1;
	T.contentW = F, T.defaultFont = u?.font, T.defaultSz = u?.sz;
	let Ke = U.length ? nt(U, C.y + S.h / 3) + 1 : 0, [qe, Je] = H(0);
	B(() => {
		if (!_) return;
		let e = setTimeout(() => {
			let e = a(o.blocks) + (u?.noteWords ?? 0);
			Je(e);
		}, 600);
		return () => clearTimeout(e);
	}, [
		s,
		_,
		o,
		u?.noteWords
	]);
	let Xe = _?.error ? `Error: ${_.error}` : Pe ? `Page ${Ke} of ${R.length} · ${qe.toLocaleString()} words` : `Page ${Ke} of ${R.length}+ · loading…`;
	B(() => {
		let e = w.current;
		if (E && e) return T.input.attach(e), T.onDirty = () => i.setDirty(!0), () => T.input.detach();
	}, [
		E,
		T,
		i
	]), Lt(() => {
		E ? T.selectAll() : w.current && ve(w.current)?.selectAllChildren(w.current);
	});
	let Ze = R.some((e) => e.end > e.start);
	B(() => {
		if (!E) {
			it(x.current);
			return;
		}
		if (!Ze || !it(w.current) || T.input.readSel()) return;
		let e = T.all();
		e && !T.input.restore({
			a: e.a,
			f: e.a
		}) && (T.pendingSel = {
			a: e.a,
			f: e.a
		});
	}, [E, Ze]), B(() => {
		T.shortcut = (e) => {
			let t = e.metaKey || e.ctrlKey;
			if (t && e.key.toLowerCase() === "s") return i.save(), !0;
			if (t && e.key.toLowerCase() === "f") return O((e) => ({
				...e,
				open: !0
			})), !0;
			if (t && e.key === "Enter") return T.insertPageBreak(), !0;
			if (t && e.key.toLowerCase() === "k") return ot(), !0;
			if (t && e.altKey && /^Digit[0-6]$/.test(e.code)) {
				let t = Number(e.code.slice(5));
				return T.applyCanon(t ? `h${t}` : "normal"), !0;
			}
			return t && e.key === "\\" ? (T.clearFormat(), !0) : e.key === "Escape" && T.painter ? (T.copyFormat(), !0) : !1;
		};
	}, [T, i]), Ye(() => {
		let e = T.pendingSel;
		if (!e || !w.current) return;
		if (!T.input.restore(e)) {
			let t = Number(e.f.pa.split(".")[0]), n = fi(R, t, ta(e.f.pa));
			n >= 0 && x.current && (x.current.scrollTop = Math.max(0, U[n] - 16)), (n < 0 || n >= K && n <= He) && (T.pendingSel = null);
			return;
		}
		T.pendingSel = null;
		let t = ve(w.current), n = t?.rangeCount ? t.getRangeAt(0) : null, r = x.current;
		if (n && r) {
			let e = n.getBoundingClientRect(), t = r.getBoundingClientRect();
			e.height && e.bottom > t.bottom - 24 ? r.scrollTop += e.bottom - t.bottom + 48 : e.height && e.top < t.top + 8 && (r.scrollTop -= t.top - e.top + 48);
		}
	});
	let q = Me(() => {
		let e = D.q.toLowerCase();
		if (!D.open || !e) return [];
		let t = [], n = (n, r, i) => {
			let a = se(n.runs).toLowerCase();
			for (let n = a.indexOf(e); n >= 0 && t.length < 5e3; n = a.indexOf(e, n + e.length)) t.push({
				pa: r,
				a: n,
				b: n + e.length,
				bi: i
			});
		};
		return o.blocks.forEach((e, t) => {
			la(e) ? n(e, String(t), t) : e.t === "tbl" && e.rows.forEach((e, r) => e.cells.forEach((e, i) => e.blocks.forEach((e, a) => la(e) && n(e, `${t}.${r}.${i}.${a}`, t))));
		}), t;
	}, [
		D.q,
		D.open,
		s
	]), tt = (e) => {
		let t = q[e], n = x.current;
		if (!t || !n) return;
		let r = fi(R, t.bi, ta(t.pa));
		r >= 0 && (n.scrollTop = Math.max(0, U[r] - 16)), O((t) => ({
			...t,
			idx: e
		})), requestAnimationFrame(() => requestAnimationFrame(() => {
			let e = w.current;
			if (!e) return;
			let r = M(e, {
				pa: t.pa,
				o: t.a
			}), i = M(e, {
				pa: t.pa,
				o: t.b
			});
			if (!r || !i) return;
			let a = document.createRange();
			a.setStart(r[0], r[1]), a.setEnd(i[0], i[1]);
			let o = a.getBoundingClientRect(), s = n.getBoundingClientRect();
			n.scrollTop += o.top - s.top - s.height / 3, E && T.input.restore({
				a: {
					pa: t.pa,
					o: t.a
				},
				f: {
					pa: t.pa,
					o: t.b
				}
			}, !1);
		}));
	};
	Ye(() => {
		let e = globalThis.Highlight, t = CSS.highlights;
		if (!e || !t) return;
		let n = w.current;
		if (!n || !q.length) {
			t.delete("de-find"), t.delete("de-find-cur");
			return;
		}
		let r = [], i;
		q.forEach((e, t) => {
			if (e.bi < (R[K]?.start ?? 0) || e.bi >= (R[He]?.end ?? 0)) return;
			let a = M(n, {
				pa: e.pa,
				o: e.a
			}), o = M(n, {
				pa: e.pa,
				o: e.b
			});
			if (!a || !o) return;
			let s = document.createRange();
			s.setStart(a[0], a[1]), s.setEnd(o[0], o[1]), t === D.idx ? i = s : r.push(s);
		}), t.set("de-find", new e(...r)), i ? t.set("de-find-cur", new e(i)) : t.delete("de-find-cur");
	});
	let rt = (e, t) => _e(T, {
		a: {
			pa: e.pa,
			o: e.a
		},
		f: {
			pa: e.pa,
			o: e.b
		}
	}, t), at = {
		fontFamily: u?.font,
		fontSize: u ? `${u.sz}pt` : void 0
	};
	It({
		printable: async () => {
			if (!Pe) throw Error("The document is still loading — try again in a moment");
			return {
				size: `${j.w}pt ${j.h}pt`,
				margin: "0",
				node: R.map((e, n) => /* @__PURE__ */ W("div", {
					className: "de-print-page",
					style: {
						width: `${z[n].w}pt`,
						height: `${z[n].h}pt`
					},
					children: /* @__PURE__ */ W(da, {
						index: n,
						count: R.length,
						slice: e,
						blocks: o.blocks,
						meta: u,
						page: z[n],
						top: 0,
						left: 0,
						height: z[n].h * ea,
						zoom: 1,
						client: t,
						docStyle: at,
						editing: !1
					})
				}, n))
			};
		},
		text: async (e) => {
			if (!_) throw Error("The document is still loading — try again in a moment");
			if (e === "txt") return Mr(o.blocks);
			let n = await Gr(o.blocks, (e) => t.call("part", e));
			return e === "html" ? Wr(o.blocks, {
				title: (t.name ?? "").replace(/\.[^.]+$/, ""),
				images: n
			}) : Lr(o.blocks, n);
		},
		stats: () => {
			let e = 0, t = 0, n = (r) => {
				if (r.t === "p") {
					let n = se(r.runs);
					e += n.length, n.trim() && t++;
				} else if (r.t === "tbl") for (let e of r.rows) for (let t of e.cells) t.blocks.forEach(n);
			};
			o.blocks.forEach(n);
			let r = Pe ? "" : "+";
			return [
				["Pages", R.length.toLocaleString() + r],
				["Words", qe.toLocaleString() + r],
				["Characters", e.toLocaleString() + r],
				["Paragraphs", t.toLocaleString() + r],
				["Page size", `${+(j.w / 72).toFixed(2)} × ${+(j.h / 72).toFixed(2)} in`]
			];
		}
	});
	let ot = () => {
		let e = T.state()?.link;
		ie({
			title: e ? "Edit link" : "Insert link",
			placeholder: "https://…",
			initial: e,
			ok: "Apply",
			onOk: (e) => void T.setLink(e.trim() || null),
			extra: e ? {
				label: "Remove",
				run: () => void T.setLink(null)
			} : void 0
		});
	}, J = () => {
		let e = T.state()?.img;
		e && ie({
			title: "Alt text",
			label: "Describe the picture for screen readers",
			initial: e.alt ?? "",
			area: !0,
			ok: "Save",
			onOk: (e) => T.setAltText(e.trim())
		});
	}, st = async (e) => {
		let t = T.input.sel();
		if (t) try {
			if (!e && navigator.clipboard?.read) for (let e of await navigator.clipboard.read()) {
				let n = e.types.find((e) => e.startsWith("image/"));
				if (n) return void T.insertImages([await e.getType(n)], t);
				if (e.types.includes("text/html")) {
					let n = await (await e.getType("text/html")).text();
					if (T.pasteRich(t, {
						files: [],
						getData: (e) => e === "text/html" ? n : ""
					})) return;
				}
			}
			let n = await navigator.clipboard.readText();
			n && _e(T, t, n);
		} catch {
			k(`The browser blocked clipboard access — use ${Q}V to paste`);
		}
	}, ct = (e) => {
		document.execCommand(e) || k(`Use ${Q}${e === "copy" ? "C" : "X"}`);
	}, lt = () => void Nt().then((e) => void (e.length && T.insertImages(e))), Y = () => de && w.current ? aa(w.current, de.pa, de.o) : null, X = {
		original: () => {
			let e = Y();
			e?.naturalWidth && T.imageOriginal(e.naturalWidth, e.naturalHeight);
		},
		replace: () => void Nt("image/*", !1).then((e) => e[0] && T.replaceImage(e[0])),
		alt: J,
		download: i.canDownload ? () => {
			let e = Y();
			e?.src && de && fetch(e.src).then((e) => e.blob()).then((e) => kt(e, de.target.split("/").pop() ?? "image"));
		} : void 0
	};
	Ye(() => {
		if (he.current) return;
		let e = w.current, t = x.current, n = null;
		if (E && de && e && t) {
			let r = aa(e, de.pa, de.o);
			if (r) {
				let e = r.getBoundingClientRect(), i = t.getBoundingClientRect();
				n = {
					x: e.left - i.left + t.scrollLeft,
					y: e.top - i.top + t.scrollTop,
					w: e.width,
					h: e.height
				};
			}
		}
		me((e) => e === n || e && n && e.x === n.x && e.y === n.y && e.w === n.w && e.h === n.h ? e : n);
	});
	let Z = (e, t) => {
		t.preventDefault(), t.stopPropagation();
		let n = Y();
		if (!de || !pe || !n) return;
		let { w: r, h: i, x: a, y: o } = pe, s = de.w / Math.max(1, r), c = t.clientX, l = t.clientY, u = r, d = i;
		he.current = !0, ge.current = s;
		let f = (t) => {
			let f = t.clientX - c, p = t.clientY - l, m = r + (e.includes("e") ? f : e.includes("w") ? -f : 0), h = i + (e.includes("s") ? p : e.includes("n") ? -p : 0);
			if (e.length === 2 && !t.shiftKey) {
				let e = Math.max(m / r, h / i);
				m = r * e, h = i * e;
			}
			let g = F / s * 1;
			u = Math.max(8, Math.min(m, g * 2)), d = Math.max(8, h), n.style.width = `${u * s}pt`, n.style.height = `${d * s}pt`, me({
				x: a,
				y: o,
				w: u,
				h: d
			});
		}, p = () => {
			window.removeEventListener("mousemove", f), window.removeEventListener("mouseup", p), he.current = !1, ge.current = null, u !== r || d !== i ? T.setImageSize(u * s, d * s) : me(null);
		};
		window.addEventListener("mousemove", f), window.addEventListener("mouseup", p);
	}, ut = () => {
		let t = T.state(), n = T.input.sel(), r = !!n && (n.a.pa !== n.f.pa || n.a.o !== n.f.o), i = [];
		if (dt?.canComment && i.push({
			label: "Comment",
			icon: "commentAdd",
			hint: Yn,
			run: () => dt.start(),
			disabled: !t
		}), t?.img && i.push({
			head: "Image",
			label: "Original size",
			icon: "imgOrig",
			run: X.original
		}, {
			label: "Fit to page width",
			icon: "fit",
			run: () => T.resizeImage("fit")
		}, {
			label: "Replace image…",
			icon: "imgReplace",
			run: X.replace
		}, {
			label: "Alt text…",
			icon: "alt",
			run: J
		}, ...X.download ? [{
			label: "Download image",
			icon: "save",
			run: X.download
		}] : [], {
			label: "Delete image",
			icon: "trash",
			run: () => T.deleteSelection()
		}), i.push({
			label: "Cut",
			icon: "cut",
			hint: `${Q}X`,
			disabled: !r,
			run: () => ct("cut"),
			sep: i.length > 0
		}, {
			label: "Copy",
			icon: "copy",
			hint: `${Q}C`,
			disabled: !r,
			run: () => ct("copy")
		}, {
			label: "Paste",
			icon: "paste",
			hint: `${Q}V`,
			run: () => void st(!1)
		}, {
			label: "Paste without formatting",
			icon: "pastePlain",
			hint: `${Q}⇧V`,
			run: () => void st(!0)
		}, {
			label: "Delete",
			icon: "trash",
			disabled: !r || !!t?.img,
			run: () => T.deleteSelection()
		}), t?.link) {
			let n = e(t.link);
			i.push({
				label: "Open link",
				icon: "external",
				sep: !0,
				disabled: !n,
				run: () => n && window.open(n, "_blank", "noopener,noreferrer")
			}, {
				label: "Edit link…",
				icon: "link",
				hint: `${Q}K`,
				run: ot
			}, {
				label: "Remove link",
				icon: "unlink",
				run: () => void T.setLink(null)
			});
		} else i.push({
			label: "Insert link…",
			icon: "link",
			hint: `${Q}K`,
			sep: !0,
			run: ot,
			disabled: !t
		});
		if (t?.inTable) {
			let e = (e) => () => T.tableOp(e);
			i.push({
				head: "Table",
				label: "Insert row above",
				icon: "rowAbove",
				sep: !0,
				run: e("rowAbove")
			}, {
				label: "Insert row below",
				icon: "rowBelow",
				run: e("rowBelow")
			}, {
				label: "Insert column left",
				icon: "colLeft",
				run: e("colLeft")
			}, {
				label: "Insert column right",
				icon: "colRight",
				run: e("colRight")
			}, {
				label: "Delete row",
				icon: "delRow",
				run: e("delRow")
			}, {
				label: "Delete column",
				icon: "delCol",
				run: e("delCol")
			}, {
				label: "Delete table",
				icon: "trash",
				run: e("delTable")
			}, ...t.cells && t.cells.n > 1 ? [{
				label: "Merge cells",
				icon: "merge",
				run: () => T.mergeCells()
			}] : [], ...t.cells?.merged && t.cells.n < 2 ? [{
				label: "Unmerge cells",
				icon: "merge",
				run: () => T.unmergeCell()
			}] : [], {
				label: "Distribute columns evenly",
				icon: "colAdd",
				run: () => T.distributeColumns()
			});
		} else i.push({
			label: "Insert image…",
			icon: "image",
			sep: !0,
			run: lt,
			disabled: !t
		}, {
			label: "Insert table",
			icon: "table",
			run: () => T.insertTable(3, 3),
			disabled: !t
		}, {
			label: "Page break",
			icon: "pagebreak",
			hint: `${Q}↵`,
			run: () => T.insertPageBreak(),
			disabled: !t
		});
		let a = (e, t) => () => void T.updateStyle(t).then((t) => t !== void 0 && k(t ? `“${e}” updated to match the selection` : `“${e}” already matches the selection`)).catch((e) => console.error("[office-engine] style update failed", e));
		return i.push({
			label: "Update style to match",
			icon: "styleMatch",
			sep: !0,
			disabled: !t || !!t.img,
			items: pr(u?.styles ?? []).map((e) => ({
				label: e.label,
				hint: e.value === t?.style ? "current" : void 0,
				sep: e.sep,
				run: a(e.label, e.value)
			}))
		}, {
			label: "Clear formatting",
			icon: "clear",
			hint: `${Q}\\`,
			run: () => T.clearFormat(),
			disabled: !t
		}, {
			label: "Select all",
			icon: "selectAll",
			hint: `${Q}A`,
			run: () => T.selectAll()
		}), i;
	}, dt = Wn();
	T.author = () => dt?.me.name ?? "Me";
	let ft = qn(dt), pt = V(() => {});
	pt.current = (e) => {
		let t = T.commentPlaces().get(e), n = x.current;
		if (!t || !n) return;
		let r = Number(t.pa.split(".")[0]), i = fi(R, r, ta(t.pa));
		if (i < 0) return;
		let a = () => {
			let t = w.current?.querySelector(`[data-cm~="${CSS.escape(e)}"]`);
			if (!t) return !1;
			let r = t.getBoundingClientRect(), i = n.getBoundingClientRect();
			return (r.top < i.top + 24 || r.bottom > i.bottom - 24) && (n.scrollTop += r.top - i.top - i.height / 3), !0;
		};
		a() || (n.scrollTop = Math.max(0, U[i] - 16), requestAnimationFrame(() => requestAnimationFrame(() => void a())));
	}, B(() => {
		if (dt) return dt.setHost({
			kind: "docx",
			hint: "Select the text to comment on.",
			pending: () => {
				let e = T.commentRange();
				return e ? {
					quote: e.quote,
					range: e
				} : null;
			},
			attach: (e, t) => T.markComment(e, t.range),
			placed: (e) => {
				let t = T.commentPlaces(), n = new Map([...t.keys()].map((e, t) => [e, t]));
				return e.filter((e) => t.has(e.root.id)).map((e) => ({
					...e,
					quote: t.get(e.root.id).quote
				})).sort((e, t) => n.get(e.root.id) - n.get(t.root.id));
			},
			reveal: (e) => pt.current(e)
		}), () => dt.setHost(null);
	}, [dt, T]), B(() => dt?.touch(), [dt, s]);
	let mt = dt ? dt.threads().filter((e) => !e.root.done || e.root.id === ft.active).map((e) => e.root.id) : [];
	Ye(() => {
		let e = globalThis.Highlight, t = CSS.highlights;
		if (!e || !t) return;
		let n = ft.draft?.range, r = w.current, i = n && T.posOf(n.a), a = n && T.posOf(n.f), o = r && i && M(r, i), s = r && a && M(r, a);
		if (!o || !s) return void t.delete("de-cm-draft");
		let c = document.createRange();
		c.setStart(o[0], o[1]), c.setEnd(s[0], s[1]), t.set("de-cm-draft", new e(c));
	}), B(() => () => void CSS.highlights?.delete("de-cm-draft"), []);
	let ht = u?.styles?.find((e) => e.canon === "title")?.id, gt = Me(() => oe ? ca(o.blocks, ht) : [], [
		oe,
		s,
		ht
	]), _t = R[Math.max(0, Ke - 1)]?.start ?? 0, vt = gt.reduce((e, t, n) => t.bi <= Math.max(_t, We) ? n : e, -1), yt = (e) => {
		let t = x.current, n = fi(R, e);
		!t || n < 0 || (t.scrollTop = Math.max(0, U[n] - 16), requestAnimationFrame(() => requestAnimationFrame(() => {
			let n = w.current?.querySelector(`[data-pa="${e}"]`);
			n && (t.scrollTop += n.getBoundingClientRect().top - t.getBoundingClientRect().top - 24), E && T.input.restore({
				a: {
					pa: String(e),
					o: 0
				},
				f: {
					pa: String(e),
					o: 0
				}
			});
		})));
	}, bt = zi({
		editor: T,
		blocks: () => o.blocks,
		scroll: () => x.current,
		pages: () => w.current,
		z: () => Ne,
		zoom: () => y,
		setZoom: b,
		loaded: () => !!_ && !_.error,
		laidOut: (e) => e < o.frontier && fi(R, e) >= 0,
		pageScrollTop: (e, t) => {
			let n = fi(R, e, t);
			return n < 0 ? -1 : Math.max(0, U[n] - 16);
		}
	});
	return Ri(t, Me(() => $i(bt), [bt])), /* @__PURE__ */ G("div", {
		style: {
			position: "relative",
			flex: 1,
			minWidth: 0,
			display: "flex"
		},
		children: [
			/* @__PURE__ */ G("div", {
				ref: x,
				className: "de-scroll",
				tabIndex: -1,
				onKeyDown: (e) => {
					(e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f" && (e.preventDefault(), O((e) => ({
						...e,
						open: !0
					})));
				},
				children: [
					u && we.length > 0 && /* @__PURE__ */ W("div", {
						ref: be,
						className: "de-measure de-doc",
						style: {
							...at,
							width: `${F}pt`
						},
						children: we.map(({ b: e, i: t }) => {
							let n = N(L[t] ?? j), r = /* @__PURE__ */ W(ci, {
								block: e,
								ctx: De,
								sp: ni(e, o.blocks[t - 1], o.blocks[t + 1])
							}, t);
							return n === F ? r : /* @__PURE__ */ W("div", {
								style: { width: `${n}pt` },
								children: r
							}, t);
						})
					}),
					/* @__PURE__ */ G("div", {
						ref: w,
						className: E ? "de-pages de-editing" : "de-pages",
						style: {
							height: Re,
							width: ze
						},
						contentEditable: E || void 0,
						suppressContentEditableWarning: !0,
						spellCheck: !1,
						onMouseDown: (e) => {
							if (!E) return;
							let t = e.target, n = t.tagName === "IMG" ? t.closest("[data-obj]") : null, r = n && w.current ? P(w.current, n, 0) : null;
							r && (e.preventDefault(), T.selectObject(r.pa, r.o));
						},
						onMouseUp: () => {
							T.painter && setTimeout(() => T.applyPainter(), 0);
						},
						onClick: (e) => {
							if (!dt) return;
							let t = (e.target.closest?.("[data-cm]")?.dataset.cm?.split(" ") ?? []).find((e) => mt.includes(e));
							t ? dt.select(t, !1) : ft.active && dt.select(null);
						},
						onContextMenu: (e) => {
							E && (e.preventDefault(), ne({
								x: e.clientX,
								y: e.clientY
							}));
						},
						children: [R.map((e, n) => (n < K || n > He) && n !== Ge ? null : /* @__PURE__ */ W(da, {
							index: n,
							count: Ue,
							slice: e,
							blocks: o.blocks,
							meta: u,
							page: z[n],
							top: U[n],
							left: Be(n),
							height: Fe[n],
							zoom: Ne,
							client: t,
							docStyle: at,
							editing: E,
							colResize: ee,
							onHF: E && _ ? g : void 0
						}, n)), Le > 0 && /* @__PURE__ */ W("div", {
							className: "de-page-skeleton",
							contentEditable: !1,
							style: {
								top: Ie,
								left: Ve,
								width: ke * Ne,
								height: Ae * Ne
							}
						})]
					}),
					pe && /* @__PURE__ */ G("div", {
						className: "de-img-sel",
						style: {
							left: pe.x,
							top: pe.y,
							width: pe.w,
							height: pe.h
						},
						children: [oa.map((e) => /* @__PURE__ */ W("span", {
							className: `de-img-h de-img-${e}`,
							onMouseDown: (t) => Z(e, t)
						}, e)), ge.current && /* @__PURE__ */ G("span", {
							className: "de-img-size",
							children: [
								Math.round(pe.w * ge.current),
								" × ",
								Math.round(pe.h * ge.current),
								" pt"
							]
						})]
					})
				]
			}),
			oe && /* @__PURE__ */ G("nav", {
				className: "de-outline",
				"aria-label": "Document outline",
				children: [/* @__PURE__ */ G("div", {
					className: "de-outline-head",
					children: [/* @__PURE__ */ W("span", { children: "Outline" }), /* @__PURE__ */ W("button", {
						type: "button",
						className: "de-tb",
						title: "Close outline",
						"aria-label": "Close outline",
						onClick: () => ce(!1),
						children: "×"
					})]
				}), gt.length ? gt.map((e, t) => /* @__PURE__ */ W("button", {
					type: "button",
					className: t === vt ? "de-outline-item on" : "de-outline-item",
					style: { paddingLeft: 10 + e.lvl * 14 },
					onClick: () => yt(e.bi),
					children: e.text
				}, e.bi)) : /* @__PURE__ */ W("div", {
					className: "de-outline-empty",
					children: "Headings you add to the document will appear here."
				})]
			}),
			D.open && /* @__PURE__ */ W(gr, {
				query: D.q,
				index: D.idx,
				count: q.length,
				editable: E,
				onQuery: (e) => O({
					open: !0,
					q: e,
					idx: 0
				}),
				onNav: (e) => q.length && tt((D.idx + e + q.length) % q.length),
				onClose: () => O({
					open: !1,
					q: D.q,
					idx: 0
				}),
				onReplace: (e, t) => {
					q.length && (t ? [...q].reverse().forEach((t) => rt(t, e)) : rt(q[Math.min(D.idx, q.length - 1)], e));
				}
			}),
			E && /* @__PURE__ */ W(hr, {
				editor: T,
				styles: u?.styles ?? [],
				onFind: () => O((e) => ({
					...e,
					open: !0
				})),
				outline: oe,
				onOutline: () => ce((e) => !e),
				painter: le,
				onLink: ot,
				image: X,
				onPageSetup: _ ? () => p(!0) : void 0,
				onHeaderFooter: _ ? () => h("header") : void 0,
				onNotice: k
			}),
			!E && _ && /* @__PURE__ */ W("button", {
				type: "button",
				className: oe ? "de-outline-toggle on" : "de-outline-toggle",
				title: "Document outline",
				onClick: () => ce((e) => !e),
				children: "☰"
			}),
			f && /* @__PURE__ */ W(kr, {
				page: j,
				onClose: () => p(!1),
				onOk: (e) => void T.setPage(e).catch((e) => console.error("[office-engine] page setup failed", e))
			}),
			m && u && /* @__PURE__ */ W(xr, {
				meta: u,
				focus: m,
				onClose: () => h(null),
				onOk: (e) => void T.setHeaderFooter(e).catch((e) => console.error("[office-engine] header / footer change failed", e))
			}),
			te && /* @__PURE__ */ W(Kt, {
				x: te.x,
				y: te.y,
				items: ut(),
				onClose: () => ne(null)
			}),
			re && /* @__PURE__ */ W(qt, {
				spec: re,
				onClose: () => ie(null)
			}),
			ae && /* @__PURE__ */ W(Yt, {
				text: ae,
				onDone: () => k(null)
			}),
			mt.length > 0 && /* @__PURE__ */ W("style", { children: Jn(".de-pages", mt, ft.active) }),
			/* @__PURE__ */ W(Ht, {
				zoom: y,
				effective: Ne,
				onChange: b
			}),
			/* @__PURE__ */ W(Bt, {
				text: Xe,
				onStatus: n
			})
		]
	});
}
function da({ index: e, count: t, slice: n, blocks: r, meta: i, page: a, top: o, left: s, height: c, zoom: l, client: u, docStyle: d, editing: f, colResize: p, onHF: m }) {
	let h = Me(() => ({
		client: u,
		page: e,
		pages: t,
		measuring: !1,
		editable: f,
		colResize: f ? p : void 0
	}), [
		u,
		e,
		t,
		f,
		p
	]), g = Me(() => ({
		...h,
		editable: !1
	}), [h]), _ = e === 0 && i?.titlePg, v = _ ? i?.firstHeader : i?.header, y = _ ? i?.firstFooter : i?.footer, b = _ ? "firstHeader" : "header", x = _ ? "firstFooter" : "footer", S = [];
	for (let e = n.start; e < n.end; e++) {
		let t = r[e], i = n.cuts?.[e];
		S.push(/* @__PURE__ */ W(ci, {
			block: t,
			ctx: h,
			pa: la(t) || t.t === "tbl" ? String(e) : void 0,
			bi: e,
			sp: ni(t, r[e - 1], r[e + 1]),
			rowFrom: i?.from,
			rowTo: i?.to,
			repeat: i?.repeat
		}, `${e}:${t.t === "p" ? t.ver ?? 0 : 0}`));
	}
	return /* @__PURE__ */ W("div", {
		className: "de-page",
		style: {
			top: o,
			left: s,
			width: a.w * ea * l,
			height: c
		},
		"data-page": e + 1,
		children: /* @__PURE__ */ G("div", {
			className: "de-page-inner de-doc",
			style: {
				...d,
				width: `${a.w}pt`,
				height: c / l,
				zoom: l
			},
			children: [
				m && /* @__PURE__ */ G(U, { children: [/* @__PURE__ */ W("div", {
					className: "de-hf-zone",
					contentEditable: !1,
					title: "Double-click to edit the header",
					style: {
						top: 0,
						height: `${a.mt}pt`
					},
					onDoubleClick: () => m(b)
				}), /* @__PURE__ */ W("div", {
					className: "de-hf-zone",
					contentEditable: !1,
					title: "Double-click to edit the footer",
					style: {
						bottom: 0,
						height: `${a.mb}pt`
					},
					onDoubleClick: () => m(x)
				})] }),
				v && /* @__PURE__ */ W("div", {
					className: "de-hf",
					contentEditable: !f && void 0,
					style: {
						top: `${a.header}pt`,
						padding: `0 ${a.mr}pt 0 ${a.ml}pt`
					},
					onDoubleClick: m && (() => m(b)),
					children: v.map((e, t) => /* @__PURE__ */ W(ci, {
						block: e,
						ctx: g
					}, t))
				}),
				/* @__PURE__ */ W("div", {
					className: a.cols && a.cols > 1 ? "de-page-cols" : void 0,
					style: {
						position: "absolute",
						top: `${a.mt}pt`,
						left: `${a.ml}pt`,
						width: `${a.w - a.ml - a.mr}pt`,
						...n.clip ? {
							maxHeight: `${a.h - a.mt - a.mb}pt`,
							overflow: "hidden"
						} : {},
						...a.cols && a.cols > 1 ? {
							columnCount: a.cols,
							columnGap: `${a.colGap ?? 36}pt`,
							columnFill: "auto",
							height: `${a.h - a.mt - a.mb}pt`
						} : {}
					},
					children: S
				}),
				y && /* @__PURE__ */ W("div", {
					className: "de-hf",
					contentEditable: !f && void 0,
					style: {
						bottom: `${a.footer}pt`,
						padding: `0 ${a.mr}pt 0 ${a.ml}pt`
					},
					onDoubleClick: m && (() => m(x)),
					children: y.map((e, t) => /* @__PURE__ */ W(ci, {
						block: e,
						ctx: g
					}, t))
				})
			]
		})
	});
}
// src/react/file/DetailsDialog.tsx
var fa = [
	["title", "Title"],
	["subject", "Subject"],
	["creator", "Author"],
	["keywords", "Keywords"],
	["description", "Comments"],
	["lastModifiedBy", "Last modified by"],
	["created", "Created"],
	["modified", "Modified"]
];
async function pa(e) {
	let t = await (await e.call("part", "docProps/core.xml")).text(), n = new DOMParser().parseFromString(t, "application/xml"), r = [];
	for (let [e, t] of fa) {
		let i = n.getElementsByTagNameNS("*", e)[0]?.textContent?.trim();
		if (!i) continue;
		let a = e === "created" || e === "modified" ? new Date(i) : null;
		r.push([t, a && !isNaN(a.getTime()) ? a.toLocaleString() : i]);
	}
	return r;
}
function ma(e) {
	let [t, n] = H([]), r = V(null);
	B(() => {
		r.current?.focus();
		let t = !0;
		return pa(e.client).then((e) => t && n(e), () => {}), () => {
			t = !1;
		};
	}, [e.client]);
	let i = [
		e.file,
		t,
		e.stats
	].filter((e) => e.length);
	return /* @__PURE__ */ W("div", {
		className: "de-dialog-back",
		onMouseDown: (t) => t.target === t.currentTarget && e.onClose(),
		onKeyDown: (t) => {
			t.key === "Escape" && (t.stopPropagation(), e.onClose());
		},
		children: /* @__PURE__ */ G("div", {
			className: "de-dialog",
			role: "dialog",
			"aria-label": "Document details",
			children: [
				/* @__PURE__ */ W("div", {
					className: "de-dialog-title",
					children: "Document details"
				}),
				/* @__PURE__ */ W("dl", {
					className: "de-details",
					children: i.map((e, t) => /* @__PURE__ */ G(Te, { children: [t > 0 && /* @__PURE__ */ W("div", { className: "de-details-sep" }), e.map(([e, t]) => /* @__PURE__ */ G(Te, { children: [/* @__PURE__ */ W("dt", { children: e }), /* @__PURE__ */ W("dd", { children: t })] }, e))] }, t))
				}),
				/* @__PURE__ */ W("div", {
					className: "de-dialog-btns",
					children: /* @__PURE__ */ W("button", {
						ref: r,
						type: "button",
						className: "de-btn de-btn-primary",
						onClick: e.onClose,
						children: "Close"
					})
				})
			]
		})
	});
}
// src/react/file/importFile.ts
var ha = /* @__PURE__ */ new Set([
	"docx",
	"dotx",
	"xlsx",
	"xltx",
	"pptx",
	"potx",
	"pages",
	"key",
	"numbers"
]), ga = [
	...ha,
	...Object.keys(S),
	...Object.keys(O),
	"gz"
].map((e) => "." + e).join(",");
async function _a(e) {
	let t = y(e.name);
	if (ha.has(t)) return {
		src: e,
		name: e.name,
		converted: !1
	};
	let n = new Uint8Array(await e.slice(0, 4096).arrayBuffer());
	if (S[t] && t !== "dot" || v(n) || (O[t] || f(e.name)) && ne(e.name, e.type, n, e.size <= 4096)) return {
		src: e,
		name: e.name,
		converted: !0
	};
	if (n[0] === 80 && n[1] === 75) return {
		src: e,
		name: e.name,
		converted: !1
	};
	throw Error(`Cannot open “${e.name}”: supported files are Word, Excel, PowerPoint (also 97-2003), OpenDocument, RTF, Pages, Keynote, Numbers, CSV, text, Markdown, HTML, SVG, Mermaid, PlantUML and Graphviz (also gzip-compressed: .svgz, .csv.gz)`);
}
// src/react/styles.css?inline
var va = ".de-root{--de-bg:#e9ebee;--de-chrome:#fff;--de-border:#dadde1;--de-text:#1d2127;--de-muted:#69707a;--de-accent:#1a73e8;--de-accent-hover:#1765cc;--de-accent-ink:#fff;--de-accent-soft:#1a73e81f;--de-grid:#e2e4e7;--de-head:#f6f7f8;--de-head-ink:#5f6368;--de-head-border:#d3d6da;--de-corner-border:#c4c7cc;--de-freeze:#b9bdc3;--de-on:#d3e3fd;--de-on-ink:#0b57d0;--de-on-ink-strong:#041e49;--de-ink:#444746;--de-ink-strong:#1f1f1f;--de-ink-soft:#3c4043;--de-hover:#44474614;--de-hover-solid:#f1f3f4;--de-hover-soft:#e8f0fe;--de-ebar:#eef2f9;--de-tb-sep:#c7c7c7;--de-pop:#fff;--de-pop-shadow:0 2px 6px 2px #3c404326, 0 1px 2px #3c40434d;--de-sep:#e3e3e3;--de-input-bg:#fff;--de-input-border:#747775;--de-swatch-border:#00000026;--de-disabled:#b0b4ba;--de-danger:#b42318;--de-danger-border:#f3c2bd;--de-ok:#137333;--de-tab-hover:#eceef1;--de-tab-on:#fff;--de-tab-ink:#188038;--de-toast-bg:#323232;--de-toast-ink:#fff;--de-backdrop:#20212452;--de-shadow:0 1px 2px #0f172a1a, 0 2px 8px #0f172a0f;--de-cm-bg:#fbbc0447;--de-cm-on:#fbbc0499;--de-cm-line:#f29900;--de-cm-card:#fff;--de-cm-quote:#f29900;--lightningcss-light:initial;--lightningcss-dark: ;color-scheme:light;background:var(--de-bg);width:100%;height:100%;min-height:200px;color:var(--de-text);text-align:left;isolation:isolate;flex-direction:column;font:13px/1.4 system-ui,-apple-system,Segoe UI,Roboto,Helvetica Neue,Arial,sans-serif;display:flex;position:relative;overflow:hidden}.de-root *,.de-root :before,.de-root :after{box-sizing:border-box}.de-root img{max-width:none}.de-root.de-dark{--de-bg:#17191c;--de-chrome:#23262a;--de-border:#3b3f45;--de-text:#e3e5e8;--de-muted:#9aa0a6;--de-accent:#669df6;--de-accent-hover:#8ab4f8;--de-accent-ink:#062e6f;--de-accent-soft:#669df62e;--de-head:#2a2d32;--de-head-ink:#bdc1c6;--de-head-border:#3f434a;--de-corner-border:#4a4f57;--de-freeze:#5f6368;--de-on:#3a4a66;--de-on-ink:#aecbfa;--de-on-ink-strong:#d3e3fd;--de-ink:#c4c7c5;--de-ink-strong:#e3e3e3;--de-ink-soft:#c4c7c5;--de-hover:#e3e3e31a;--de-hover-solid:#3a3d43;--de-hover-soft:#33405a;--de-ebar:#2b3140;--de-tb-sep:#5a5e66;--de-pop:#2e3136;--de-pop-shadow:0 2px 6px 2px #0006, 0 1px 2px #0009;--de-sep:#45494f;--de-input-bg:#1f2124;--de-input-border:#8e918f;--de-swatch-border:#ffffff2e;--de-disabled:#6f7378;--de-danger:#f2b8b5;--de-danger-border:#6e2b27;--de-ok:#81c995;--de-tab-hover:#34383e;--de-tab-on:#363a41;--de-tab-ink:#81c995;--de-toast-bg:#e3e3e3;--de-toast-ink:#1f1f1f;--de-backdrop:#0000008c;--de-shadow:0 1px 2px #00000080, 0 2px 10px #00000073;--de-cm-card:#2b2e33;--de-cm-quote:#fdd663;--lightningcss-light: ;--lightningcss-dark:initial;color-scheme:dark}.de-bar{background:var(--de-chrome);border-bottom:1px solid var(--de-border);z-index:21;flex:none;align-items:center;gap:10px;min-height:40px;padding:6px 12px;display:flex;position:relative}.de-badge{letter-spacing:.06em;text-transform:uppercase;color:#fff;border-radius:4px;flex:none;padding:4px 6px;font:600 10px/1 system-ui,sans-serif}.de-badge-docx{background:#2b579a}.de-badge-xlsx{background:#217346}.de-badge-pptx{background:#c43e1c}.de-title{text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0;font-weight:600;overflow:hidden}.de-status{color:var(--de-muted);font-variant-numeric:tabular-nums;white-space:nowrap;flex:none}.de-progress{background:var(--de-accent);height:2px;transition:width .2s,opacity .4s;position:absolute;bottom:-1px;left:0}.de-body{flex:1;min-height:0;display:flex;position:relative}.de-scroll{overscroll-behavior:contain;flex:1;min-width:0;position:relative;overflow:auto}.de-center{color:var(--de-muted);text-align:center;flex-direction:column;justify-content:center;align-items:center;gap:12px;padding:24px;display:flex;position:absolute;inset:0}.de-spinner{border:3px solid var(--de-accent-soft);border-top-color:var(--de-accent);border-radius:50%;width:28px;height:28px;animation:.8s linear infinite de-spin}@keyframes de-spin{to{transform:rotate(360deg)}}.de-error{max-width:460px;color:var(--de-danger);background:var(--de-pop);border:1px solid var(--de-danger-border);box-shadow:var(--de-shadow);border-radius:8px;padding:14px 18px}.de-zoom{z-index:4;background:var(--de-chrome);border:1px solid var(--de-border);box-shadow:var(--de-shadow);border-radius:8px;align-items:center;display:flex;position:absolute;bottom:16px;right:16px;overflow:hidden}.de-zoom button,.de-tab,.de-btn{appearance:none;color:inherit;font:inherit;cursor:pointer;background:0 0;border:0}.de-zoom button{width:32px;height:30px;font-size:16px;line-height:1}.de-zoom button:hover,.de-btn:hover{background:var(--de-accent-soft)}.de-zoom span{text-align:center;font-variant-numeric:tabular-nums;cursor:pointer;min-width:52px;font-size:12px}.de-btn{border-radius:6px;padding:4px 8px}.de-pages{position:relative}.de-page{box-shadow:var(--de-shadow);background:#fff;position:absolute;overflow:hidden}.de-page-inner{transform-origin:0 0;position:relative}.de-page-skeleton{box-shadow:var(--de-shadow);opacity:.6;background:#fff;position:absolute}.de-page-skeleton:after{content:\"\";background:repeating-linear-gradient(#eef0f2 0 10px,#0000 10px 24px);animation:1.4s ease-in-out infinite de-pulse;position:absolute;inset:12%}@keyframes de-pulse{50%{opacity:.45}}.de-doc{color:#000;font-kerning:normal;text-rendering:optimizelegibility}.de-doc a{color:inherit;-webkit-text-decoration:inherit;text-decoration:inherit}.de-hf{position:absolute;left:0;right:0}.de-measure{visibility:hidden;pointer-events:none;contain:layout style;position:absolute;top:0;left:-100000px}.de-p{white-space:pre-wrap;overflow-wrap:break-word;tab-size:36pt;margin:0}.de-p>span{white-space:inherit}.de-p.de-prot{box-shadow:-4px 0 0 -2px color-mix(in srgb, var(--de-muted) 55%, transparent);cursor:default}.de-marker{text-indent:0;white-space:pre;display:inline-block}.de-tbl{border-collapse:collapse;table-layout:fixed}[data-obj][data-tc]{outline-offset:1px;outline:2px solid}[data-obj][data-tc=del]{opacity:.45}.de-tbl-wrap{position:relative}.de-tbl-repeat{-webkit-user-select:none;user-select:none;cursor:default}.de-tbl-wrap>.de-tbl{margin:0!important}.de-col-resize{cursor:col-resize;z-index:2;touch-action:none;width:6px;position:absolute;top:0;bottom:0}.de-col-resize:hover{background:#1a73e859}.de-tbl td.de-cell-sel{box-shadow:inset 0 0 0 9999px #1a73e829}.de-tbl td{vertical-align:top;overflow-wrap:break-word;text-indent:0;padding:0}.de-img-missing,.de-ph{color:#6a737d;text-indent:0;vertical-align:bottom;background:repeating-linear-gradient(45deg,#f6f7f9 0 8px,#eff1f4 8px 16px);border:1px dashed #b8bec6;justify-content:center;align-items:center;font:12px/1.2 system-ui,sans-serif;display:inline-flex;overflow:hidden}.de-tbox{vertical-align:top;text-indent:0;padding:3.6pt 7.2pt;display:inline-block;overflow:hidden}.de-xlsx{flex-direction:column;flex:1;min-width:0;display:flex}.de-fx{background:var(--de-chrome);border-bottom:1px solid var(--de-border);flex:none;align-items:stretch;height:30px;font:12px/30px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;display:flex}.de-fx-ref{border-right:1px solid var(--de-border);width:88px;color:var(--de-muted);flex:none;padding:0 10px}.de-fx-val{text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0;padding:0 10px;overflow:hidden}.de-grid{color:#1d2127;background:#fff;outline:none;flex:1;min-height:0;position:relative;overflow:auto}.de-grid-view{z-index:1;position:sticky;top:0;left:0;overflow:hidden}.de-region{position:absolute;overflow:hidden}.de-gl-h,.de-gl-v{background:var(--de-grid);position:absolute}.de-gl-h{height:1px;left:0;right:0}.de-gl-v{width:1px;top:0;bottom:0}.de-cell{white-space:pre;align-items:flex-end;padding:0 3px 1px;line-height:1.2;display:flex;position:absolute;overflow:hidden}.de-cell>span{min-width:0}.de-cell.de-ov{overflow:visible}.de-head-c,.de-head-r{background:var(--de-head);color:var(--de-head-ink);font-variant-numeric:tabular-nums;border-right:1px solid var(--de-head-border);border-bottom:1px solid var(--de-head-border);-webkit-user-select:none;user-select:none;justify-content:center;align-items:center;font:11px/1 system-ui,sans-serif;display:flex;position:absolute}.de-head-on{background:var(--de-on);color:var(--de-on-ink);font-weight:600}.de-corner{background:var(--de-head);border-right:1px solid var(--de-corner-border);border-bottom:1px solid var(--de-corner-border);z-index:2;position:absolute;top:0;left:0}.de-freeze-h,.de-freeze-v{background:var(--de-freeze);z-index:2;position:absolute}.de-sel{border:2px solid var(--de-accent);pointer-events:none;z-index:3;position:absolute}.de-tabs{background:var(--de-head);border-top:1px solid var(--de-border);scrollbar-width:thin;flex:none;align-items:stretch;gap:2px;height:34px;padding:0 8px;display:flex;overflow-x:auto}.de-tab{color:var(--de-muted);white-space:nowrap;border-radius:0 0 6px 6px;flex:none;padding:0 14px}.de-tab:hover{background:var(--de-tab-hover)}.de-tab[aria-selected=true]{background:var(--de-tab-on);color:var(--de-tab-ink);box-shadow:inset 0 2px 0 var(--de-tab-ink);font-weight:600}.de-thumbs{border-right:1px solid var(--de-border);background:var(--de-chrome);flex:none;width:188px;position:relative;overflow-y:auto}.de-thumb{cursor:pointer;gap:6px;padding:0 10px 0 6px;display:flex;position:absolute;left:0;right:0}.de-thumb-n{text-align:right;width:18px;color:var(--de-muted);font-variant-numeric:tabular-nums;flex:none;font-size:11px}.de-thumb .de-slide{outline:1px solid var(--de-border)}.de-thumb[aria-current=true] .de-slide{outline:2px solid var(--de-accent)}.de-slide{background:#fff;position:relative;overflow:hidden}.de-slide-frame{box-shadow:var(--de-shadow);position:absolute}.de-slide-inner{transform-origin:0 0;color:#000;position:absolute;top:0;left:0;overflow:hidden}.de-el{position:absolute}.de-txt{flex-direction:column;display:flex;position:absolute;inset:0}.de-txt>div{white-space:pre-wrap;overflow-wrap:break-word}.de-txt.de-nowrap>div{white-space:pre}.de-slide-editable .de-txt>div[data-ro]{cursor:not-allowed;box-shadow:inset 2px 0 #b478148c}.de-slide-editable .de-el>.de-txt:empty{outline-offset:-1px;outline:1.5px dashed #3c404366}.de-slide-editable .de-el>.de-txt:empty:after{content:\"Click to add text\";color:#80868b;text-align:center;pointer-events:none;font:28px/1.2 system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif}.de-bul{text-indent:0;white-space:pre;display:inline-block}.de-stbl{border-collapse:collapse;table-layout:fixed;width:100%}.de-stbl td{vertical-align:top;padding:0;position:relative}.de-hidden-slide{opacity:.55}.de-mode{border:1px solid var(--de-border);background:var(--de-chrome);height:28px;color:inherit;font:inherit;cursor:pointer;border-radius:6px;flex:none;align-items:center;gap:6px;padding:0 10px;font-weight:500;display:inline-flex}.de-mode:hover{background:var(--de-accent-soft)}.de-mode-on{border-color:var(--de-accent);color:var(--de-accent)}.de-save-dirty{background:var(--de-accent);border-color:var(--de-accent);color:var(--de-accent-ink)}.de-save-dirty:hover{background:var(--de-accent-hover)}.de-mode:disabled{opacity:.6;cursor:default}.de-ebar-host{background:var(--de-chrome);border-bottom:1px solid var(--de-border);z-index:20;flex:none;padding:6px 10px;position:relative}.de-ebar{background:var(--de-ebar);min-width:0;height:40px;color:var(--de-ink);border-radius:20px;flex-wrap:nowrap;align-items:center;gap:2px;padding:0 8px;display:flex}.de-ebar-it{flex:none;align-items:center;display:inline-flex}.de-ebar-morewrap{margin-left:auto}.de-tb-pop.de-ebar-more{background:var(--de-ebar);flex-wrap:wrap;align-items:center;gap:2px;width:max-content;max-width:min(360px,90vw);padding:6px;display:flex;left:auto;right:0}.de-tb{appearance:none;width:28px;height:28px;color:var(--de-ink);cursor:pointer;background:0 0;border:0;border-radius:4px;justify-content:center;align-items:center;padding:0;font:600 14px/1 system-ui,sans-serif;transition:background-color .1s;display:inline-flex;position:relative}.de-tb:hover:not(:disabled){background:var(--de-hover)}.de-tb:focus-visible,.de-dd:focus-visible{outline:2px solid var(--de-accent);outline-offset:-2px}.de-tb-on{color:var(--de-on-ink-strong);background:var(--de-on)!important}.de-tb:disabled{opacity:.38;cursor:default}.de-tb-chev{gap:0;width:auto;padding:0 2px 0 4px}.de-tb-sep{background:var(--de-tb-sep);flex:none;width:1px;height:20px;margin:0 5px}.de-tb-color{display:inline-flex;position:relative}.de-tb-swatch{border-radius:1px;height:3px;position:absolute;bottom:3px;left:6px;right:6px;box-shadow:inset 0 0 0 1px #0000001f}.de-tb-pop{z-index:30;background:var(--de-pop);box-shadow:var(--de-pop-shadow);border-radius:8px;padding:10px;position:absolute;top:calc(100% + 6px);left:0}.de-tb-none{border:1px solid var(--de-border);background:var(--de-pop);width:100%;color:inherit;font:inherit;cursor:pointer;border-radius:4px;margin-bottom:8px;padding:5px}.de-tb-none:hover{background:var(--de-hover-solid)}.de-dd-wrap{display:inline-flex;position:relative}.de-dd{appearance:none;height:28px;color:var(--de-ink-strong);cursor:pointer;background:0 0;border:0;border-radius:4px;align-items:center;gap:4px;padding:0 2px 0 6px;font:13px/1 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;transition:background-color .1s;display:inline-flex}.de-dd:hover:not(:disabled),.de-dd-open{background:var(--de-hover)}.de-dd:disabled{opacity:.38;cursor:default}.de-dd>svg{color:var(--de-ink);flex:none}.de-dd-label{text-overflow:ellipsis;white-space:nowrap;text-align:left;flex:1;min-width:0;overflow:hidden}.de-dd-ph{color:var(--de-muted)}.de-dd-pop{z-index:40;background:var(--de-pop);min-width:100%;max-height:min(380px,60vh);box-shadow:var(--de-pop-shadow);color:var(--de-ink-strong);border-radius:8px;padding:6px 0;font:13px/1.3 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;position:absolute;top:calc(100% + 4px);left:0;overflow-y:auto}.de-dd-opt{white-space:nowrap;cursor:pointer;-webkit-user-select:none;user-select:none;align-items:center;gap:8px;min-height:32px;padding:4px 16px 4px 10px;display:flex}.de-dd-opt>svg{color:var(--de-ink);flex:none}.de-dd-hi{background:var(--de-hover-solid)}.de-dd-dis{opacity:.4;cursor:default}.de-dd-check{width:16px;color:var(--de-on-ink);flex:none;display:inline-flex}.de-dd-text{text-overflow:ellipsis;flex:1;min-width:0;overflow:hidden}.de-dd-hint{color:var(--de-muted);font-variant-numeric:tabular-nums;margin-left:auto;padding-left:28px;font-size:12px}.de-dd-sep{background:var(--de-sep);height:1px;margin:6px 0}.de-dd-head{color:var(--de-muted);letter-spacing:.04em;text-transform:uppercase;-webkit-user-select:none;user-select:none;padding:6px 16px 2px 10px;font-size:11px;font-weight:600}.de-dd.de-file{flex:none;padding:0 4px 0 8px;font-weight:500}.de-dd.de-file+.de-dd-pop{max-height:720px}.de-size{align-items:center;gap:1px;display:inline-flex;position:relative}.de-size-step{width:24px}.de-size-input{border:1px solid var(--de-input-border);width:38px;height:26px;color:var(--de-ink-strong);text-align:center;background:0 0;border-radius:4px;outline:none;padding:0;font:13px/1 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}.de-size-input:focus{border-color:var(--de-accent);box-shadow:inset 0 0 0 1px var(--de-accent);background:var(--de-input-bg)}.de-size-input:disabled{opacity:.38}.de-size-pop{width:40px;min-width:40px;padding:4px 0;left:25px}.de-size-pop .de-dd-opt{justify-content:center;min-height:28px;padding:0}.de-borders{grid-template-columns:repeat(4,30px);gap:4px;display:grid}.de-borders .de-tb{width:30px;height:30px}.de-tb-grid{grid-template-columns:repeat(8,18px);gap:4px;display:grid}.de-tb-grid button{border:1px solid var(--de-swatch-border);cursor:pointer;border-radius:50%;width:18px;height:18px;padding:0}.de-tb-grid button:hover{transform:scale(1.15)}.de-tb-grid button.on{box-shadow:0 0 0 2px var(--de-pop), 0 0 0 3.5px var(--de-accent)}.de-tb-custom{color:var(--de-muted);letter-spacing:.04em;text-transform:uppercase;margin:10px 0 6px;font-size:11px;font-weight:600}.de-tb-grid button.de-tb-add{background:var(--de-pop);border:1px dashed var(--de-input-border);color:var(--de-ink);justify-content:center;align-items:center;display:inline-flex}.de-tb-native{opacity:0;pointer-events:none;border:0;width:1px;height:1px;padding:0;position:absolute;bottom:0;left:0}.de-editing{caret-color:#000;outline:none}.de-editing .de-page-inner{cursor:text}.de-editing [contenteditable=false]{cursor:default}.de-find{z-index:6;background:var(--de-pop);border:1px solid var(--de-border);box-shadow:var(--de-shadow);border-radius:8px;flex-direction:column;gap:4px;padding:6px;display:flex;position:absolute;top:10px;right:18px}.de-find-row{align-items:center;gap:2px;display:flex}.de-find input{border:1px solid var(--de-border);background:var(--de-input-bg);width:200px;height:28px;color:var(--de-text);font:inherit;border-radius:6px;outline:none;padding:0 8px}.de-find input:focus{border-color:var(--de-accent)}.de-find-count{text-align:center;min-width:56px;color:var(--de-muted);font-variant-numeric:tabular-nums;font-size:12px}::highlight(de-find){background-color:#fde293}::highlight(de-find-cur){background-color:#ff9632}::highlight(de-cm-draft){background-color:#fbbc0499}.de-range{pointer-events:none;z-index:2;background:#1a73e81a;border:1px solid #1a73e899;position:absolute}.de-cell-edit{color:inherit;z-index:5;border:2px solid var(--de-accent);resize:none;white-space:pre-wrap;background:#fff;outline:none;padding:1px 3px;line-height:1.2;position:absolute;overflow:hidden;box-shadow:0 2px 8px #00000026}.de-fx-input{font:inherit;color:inherit;resize:none;white-space:pre;background:0 0;border:0;outline:none;margin:0}.de-fx-input:focus{background:var(--de-input-bg);box-shadow:inset 0 -2px 0 var(--de-accent)}.de-tb-hint{color:var(--de-muted);margin-left:8px;font-size:12px}.de-slide-editable [data-text]:hover{outline:1px dashed #1a73e899}.de-txt-edit{outline:2px solid var(--de-accent);outline-offset:0;caret-color:#000;cursor:text;z-index:2}.de-gridpick{grid-template-columns:repeat(8,16px);gap:3px;display:grid}.de-gridpick button{border:1px solid var(--de-border);background:var(--de-pop);cursor:pointer;border-radius:2px;width:16px;height:16px;padding:0}.de-gridpick button.on{background:var(--de-on);border-color:var(--de-accent)}.de-gridpick-label{text-align:center;color:var(--de-muted);margin-top:6px;font-size:12px}.de-prompt{align-items:center;gap:6px;display:flex}.de-prompt input{border:1px solid var(--de-border);background:var(--de-input-bg);width:240px;height:28px;color:var(--de-text);font:inherit;border-radius:6px;outline:none;padding:0 8px}.de-prompt input:focus{border-color:var(--de-accent)}.de-prompt .de-btn{border:1px solid var(--de-border);background:var(--de-pop)}.de-shape-sel{border:1.5px solid var(--de-accent);pointer-events:none;z-index:5;transform-origin:50%;position:absolute}.de-handle{border:1px solid var(--de-accent);pointer-events:auto;background:#fff;border-radius:2px;position:absolute}.de-h-nw,.de-h-se{cursor:nwse-resize}.de-h-ne,.de-h-sw{cursor:nesw-resize}.de-h-n,.de-h-s{cursor:ns-resize}.de-h-e,.de-h-w{cursor:ew-resize}.de-slide-editable [data-top]{cursor:move}.de-slide-editable [data-text]{cursor:text}.de-present{z-index:2147483000;cursor:none;background:#000;outline:none;justify-content:center;align-items:center;display:flex;position:fixed;inset:0}.de-present .de-slide{box-shadow:none}.de-present-n{color:#ffffff80;font:12px system-ui,sans-serif;position:absolute;bottom:12px;right:16px}.de-present-btn{z-index:4;position:absolute;bottom:56px;right:16px}.de-grip-c{cursor:col-resize;z-index:3;width:6px;position:absolute;top:0}.de-grip-r{cursor:row-resize;z-index:3;height:6px;position:absolute;left:0}.de-grip-c:hover,.de-grip-r:hover{background:#1a73e859}.de-ctx{z-index:50;background:var(--de-pop);min-width:240px;max-width:340px;box-shadow:var(--de-pop-shadow);color:var(--de-ink-strong);-webkit-user-select:none;user-select:none;border-radius:8px;padding:6px 0;font:13px/1.3 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;position:fixed}.de-ctx-row{display:contents}.de-ctx button{width:100%;min-height:30px;font:inherit;color:inherit;text-align:left;cursor:pointer;background:0 0;border:0;align-items:center;gap:10px;padding:4px 16px 4px 12px;display:flex}.de-ctx button.de-ctx-hi:not(:disabled){background:var(--de-hover-solid)}.de-ctx button:disabled{color:var(--de-disabled);cursor:default}.de-ctx-icon{width:16px;color:var(--de-ink);flex:none;display:inline-flex}.de-ctx button:disabled .de-ctx-icon{opacity:.4}.de-ctx-label{text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0;overflow:hidden}.de-ctx-hint{color:var(--de-muted);margin-left:16px;font-size:12px}.de-ctx-more{color:var(--de-muted);margin:0 -6px 0 8px;display:inline-flex;transform:rotate(-90deg)}.de-ctx-sub{min-width:200px;max-height:calc(100vh - 8px);overflow-y:auto}.de-ctx-sep{background:var(--de-sep);height:1px;margin:6px 0}.de-ctx-head{color:var(--de-muted);letter-spacing:.03em;text-transform:uppercase;padding:6px 16px 2px 38px;font-size:11px;font-weight:600}.de-tab-add{padding:0 10px;font-size:18px}.de-tab-input{border:1px solid var(--de-accent);background:var(--de-input-bg);width:120px;color:var(--de-text);font:inherit;border-radius:4px;margin:4px 2px;padding:0 6px}.de-fx{position:relative}.de-fref{pointer-events:none;z-index:2;border:2px solid;position:absolute}.de-fref-pt{border-style:dashed}.de-cell-hl{z-index:4;pointer-events:none;color:#202124;overflow-wrap:break-word;overflow:hidden}.de-cell-edit{overflow-wrap:break-word}.de-cell-edit-fx{color:#0000;caret-color:#202124;box-shadow:none;background:0 0}.de-cell-edit-fx::selection{color:#0000;background:#1a73e840}.de-fassist-at{z-index:30;position:absolute}.de-fassist{background:var(--de-pop);border:1px solid var(--de-border);min-width:240px;max-width:420px;box-shadow:var(--de-pop-shadow);color:var(--de-text);text-align:left;white-space:normal;border-radius:6px;padding:4px 0;font:12px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}.de-fsug{cursor:pointer;text-overflow:ellipsis;white-space:nowrap;padding:3px 10px;overflow:hidden}.de-fsug.on{background:var(--de-hover-soft)}.de-fsug-name{font-weight:600}.de-fsug-args{color:var(--de-muted);margin-left:2px}.de-fsug-desc{color:var(--de-muted);white-space:normal;margin-top:2px;font-size:11.5px}.de-fhint{padding:6px 10px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}.de-fhint .de-fsug-desc{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}.de-fhint b{color:var(--de-accent)}.de-img-sel{z-index:4;border:1.5px solid var(--de-accent);pointer-events:none;position:absolute}.de-img-h{border:1.5px solid var(--de-accent);pointer-events:auto;background:#fff;border-radius:2px;width:9px;height:9px;margin:-5px 0 0 -5px;position:absolute}.de-img-nw{cursor:nwse-resize;top:0;left:0}.de-img-n{cursor:ns-resize;top:0;left:50%}.de-img-ne{cursor:nesw-resize;top:0;left:100%}.de-img-e{cursor:ew-resize;top:50%;left:100%}.de-img-se{cursor:nwse-resize;top:100%;left:100%}.de-img-s{cursor:ns-resize;top:100%;left:50%}.de-img-sw{cursor:nesw-resize;top:100%;left:0}.de-img-w{cursor:ew-resize;top:50%;left:0}.de-img-size{color:#fff;white-space:nowrap;background:#202124d9;border-radius:4px;padding:2px 6px;font:11px/1.4 system-ui,sans-serif;position:absolute;bottom:-28px;left:50%;transform:translate(-50%)}.de-outline{z-index:6;background:var(--de-pop);width:240px;max-height:calc(100% - 24px);box-shadow:var(--de-pop-shadow);border-radius:10px;flex-direction:column;padding:6px 6px 10px;font:13px/1.35 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;display:flex;position:absolute;top:12px;left:12px;overflow-y:auto}.de-outline-head{color:var(--de-ink-strong);flex-shrink:0;justify-content:space-between;align-items:center;padding:4px 4px 6px 10px;font-weight:600;display:flex}.de-outline-item{width:100%;color:var(--de-ink-soft);font:inherit;text-align:left;text-overflow:ellipsis;white-space:nowrap;cursor:pointer;background:0 0;border:0;border-radius:6px;flex-shrink:0;padding:5px 10px;display:block;overflow:hidden}.de-outline-item:hover{background:var(--de-hover-solid)}.de-outline-item.on{color:var(--de-on-ink);font-weight:600}.de-outline-empty{color:var(--de-muted);flex-shrink:0;padding:8px 10px}.de-outline-toggle{z-index:6;border:1px solid var(--de-border);background:var(--de-pop);width:34px;height:34px;color:inherit;box-shadow:var(--de-shadow);cursor:pointer;border-radius:8px;font-size:16px;position:absolute;top:12px;left:12px}.de-outline-toggle.on{display:none}.de-symbols{grid-template-columns:repeat(12,26px);gap:2px;display:grid}.de-symbols button{width:26px;height:26px;color:var(--de-ink-strong);cursor:pointer;background:0 0;border:0;border-radius:4px;padding:0;font:15px/1 system-ui,sans-serif}.de-symbols button:hover{background:var(--de-hover-soft)}.de-dialog-back{z-index:60;background:var(--de-backdrop);justify-content:center;align-items:flex-start;padding-top:18vh;display:flex;position:fixed;inset:0}.de-dialog{background:var(--de-pop);width:min(420px,100vw - 32px);color:var(--de-ink-strong);border-radius:12px;flex-direction:column;gap:10px;padding:20px;font:14px/1.4 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;display:flex;box-shadow:0 8px 28px #00000047}.de-dialog-title{font-size:16px;font-weight:600}.de-dialog-label,.de-dialog-note{color:var(--de-muted);font-size:12.5px}.de-dialog input,.de-dialog textarea{border:1px solid var(--de-input-border);background:var(--de-input-bg);width:100%;color:var(--de-text);font:inherit;resize:vertical;border-radius:6px;outline:none;padding:8px 10px}.de-dialog input:focus,.de-dialog textarea:focus{border-color:var(--de-accent);box-shadow:inset 0 0 0 1px var(--de-accent)}.de-hf-zone{z-index:1;cursor:default;position:absolute;left:0;right:0}.de-hf-zone:hover{background:#1a73e80d}.de-hfd{width:460px}.de-hfd textarea{min-height:70px}.de-hfd-tabs{flex-wrap:wrap;gap:4px;display:flex}.de-hfd-tabs button{border:1px solid var(--de-border);background:var(--de-pop);color:var(--de-text);font:inherit;cursor:pointer;border-radius:14px;padding:5px 10px;font-size:12.5px}.de-hfd-tabs button.on{background:var(--de-accent);border-color:var(--de-accent);color:var(--de-accent-ink)}.de-ps{gap:10px;width:380px;max-width:calc(100vw - 32px)}.de-ps-note{color:var(--de-muted,#5f6368);margin-top:-4px;font-size:12px}.de-ps-row{flex-wrap:wrap;align-items:center;gap:12px;display:flex}.de-ps-head{align-items:center;gap:10px;min-width:72px;font-size:12px;font-weight:600;display:flex}.de-ps-grid{grid-template-columns:1fr 1fr;gap:8px 16px;display:grid}.de-ps-field{align-items:center;gap:6px;font-size:13px;display:flex}.de-ps-field>span{min-width:48px}.de-ps-field input{width:64px}.de-ps-field em{color:var(--de-muted,#5f6368);font-size:12px;font-style:normal}.de-ps-wide,.de-ps-wide select{flex:1}.de-ps-radio{cursor:pointer;align-items:center;gap:4px;font-size:13px;display:inline-flex}.de-ps-radio input{width:auto;margin:0;padding:0}.de-ps-preset{font-size:12px;font-weight:400}.de-ps select,.de-hfd select{border:1px solid var(--de-input-border);background:var(--de-input-bg);color:var(--de-text);font:inherit;border-radius:6px;padding:6px 8px}.de-page-cols>*{break-inside:avoid}.de-ps-bad{color:#c5221f}.de-dialog-btns .de-btn:disabled{opacity:.5;cursor:default}.de-dialog-btns{justify-content:flex-end;gap:8px;margin-top:4px;display:flex}.de-dialog-btns .de-btn{border:1px solid var(--de-border);background:var(--de-pop);border-radius:18px;padding:7px 14px}.de-dialog-btns .de-btn-primary{background:var(--de-accent);border-color:var(--de-accent);color:var(--de-accent-ink)}.de-dialog-btns .de-btn-primary:hover{background:var(--de-accent-hover)}.de-dialog-extra{margin-right:auto}.de-details{grid-template-columns:max-content 1fr;gap:7px 18px;margin:4px 0;font-size:13px;display:grid}.de-details dt{color:var(--de-muted)}.de-details dd{overflow-wrap:anywhere;min-width:0;margin:0}.de-details-sep{background:var(--de-sep);grid-column:1/-1;height:1px}.de-toast{z-index:60;background:var(--de-toast-bg);color:var(--de-toast-ink);border-radius:6px;padding:10px 16px;font:13px/1.4 system-ui,sans-serif;position:absolute;bottom:24px;left:50%;transform:translate(-50%);box-shadow:0 2px 8px #0000004d}.de-xlsx{position:relative}.de-xlsx .de-find{top:40px}.de-find-opts{color:var(--de-ink-soft);gap:10px;padding:2px 4px;font-size:12px}.de-find-opt{cursor:pointer;-webkit-user-select:none;user-select:none;align-items:center;gap:4px;display:inline-flex}.de-findcell{z-index:1;pointer-events:none;background:#fbbc0447;position:absolute}.de-findcell.on{background:#ff963273;box-shadow:inset 0 0 0 1.5px #e37400}.de-borders-pop{align-items:flex-start;gap:8px;display:flex}.de-borders-side{border-left:1px solid var(--de-sep);flex-direction:column;gap:4px;padding-left:8px;display:flex}.de-find .de-find-opt input{width:auto;height:auto;accent-color:var(--de-accent);margin:0;padding:0}.de-find-opts{justify-content:flex-start}.de-collab{flex:none;align-items:center;gap:8px;display:inline-flex}.de-collab-status{height:24px;color:var(--de-muted);background:var(--de-head);white-space:nowrap;border-radius:12px;align-items:center;gap:6px;padding:0 9px;font-size:12px;display:inline-flex}.de-collab-dot{background:#9aa0a6;border-radius:50%;flex:none;width:7px;height:7px}.de-collab-live .de-collab-dot{background:#1e8e3e;box-shadow:0 0 0 3px #1e8e3e2e}.de-collab-live{color:var(--de-ok)}.de-collab-connecting .de-collab-dot,.de-collab-syncing .de-collab-dot{background:#f9ab00;animation:1s ease-in-out infinite alternate de-collab-pulse}.de-collab-offline .de-collab-dot{background:#9aa0a6}.de-collab-error{color:var(--de-danger)}.de-collab-error .de-collab-dot{background:#d93025}@keyframes de-collab-pulse{to{opacity:.35}}@media (max-width:640px){.de-collab-label{display:none}}.de-peers{align-items:center;display:inline-flex}.de-peer{border:2px solid var(--de-chrome);color:#fff;letter-spacing:.02em;cursor:default;-webkit-user-select:none;user-select:none;border-radius:50%;place-items:center;width:26px;height:26px;margin-left:-6px;font-size:11px;font-weight:600;display:inline-grid}.de-peer:first-child{margin-left:0}.de-peer-more{background:var(--de-muted)}.de-peer-layer{pointer-events:none;z-index:4;position:absolute;inset:0;overflow:hidden}.de-peer-caret{background:var(--peer);border-radius:1px;width:2px;margin-left:-1px;position:absolute}.de-peer-caret:before{content:\"\";background:var(--peer);border-radius:50%;width:6px;height:6px;position:absolute;top:-3px;left:-2px}.de-peer-flag{background:var(--peer);color:#fff;white-space:nowrap;border-radius:4px 4px 4px 0;margin-bottom:2px;padding:1px 6px;font:600 11px/16px system-ui,-apple-system,Segoe UI,sans-serif;position:absolute;bottom:100%;left:-1px}.de-peer-sel{background:var(--peer);opacity:.18;border-radius:1px;position:absolute}.de-peer-outline{border:2px solid var(--peer);border-radius:3px;position:absolute}.de-peer-outline>.de-peer-flag{margin-bottom:1px;left:-2px}.de-peer-range{pointer-events:none;z-index:2;border:2px solid;position:absolute}.de-peer-tag{color:#fff;white-space:nowrap;border-radius:3px 3px 3px 0;padding:0 5px;font:600 10px/15px system-ui,-apple-system,Segoe UI,sans-serif;position:absolute;top:-17px;left:-2px}.de-cm-panel{background:var(--de-chrome);border-left:1px solid var(--de-border);width:320px;max-width:100%;min-height:0;color:var(--de-text);z-index:7;flex-direction:column;flex:none;font:13px/1.4 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;display:flex;position:relative}@media (max-width:640px){.de-cm-panel{width:min(100%,360px);box-shadow:var(--de-pop-shadow);position:absolute;inset:0 0 0 auto}}.de-cm-bar{border-bottom:1px solid var(--de-border);align-items:center;gap:6px;padding:8px 8px 8px 14px;display:flex}.de-cm-title{color:var(--de-ink-strong);flex:1;align-items:center;gap:6px;font-weight:600;display:flex}.de-cm-badge{background:var(--de-accent-soft);min-width:18px;color:var(--de-accent);text-align:center;border-radius:9px;padding:1px 6px;font:600 11px/16px system-ui,sans-serif}.de-cm-filter{color:var(--de-muted);font-size:12px}.de-cm-filter.on{color:var(--de-accent)}.de-cm-list{flex-direction:column;flex:1;gap:10px;min-height:0;padding:10px;display:flex;overflow-y:auto}.de-cm-new{border:1px dashed var(--de-border);width:100%;color:var(--de-ink);font:inherit;cursor:pointer;text-align:left;background:0 0;border-radius:8px;align-items:center;gap:8px;padding:8px 10px;display:flex}.de-cm-new:hover{background:var(--de-hover);border-color:var(--de-accent);color:var(--de-accent)}.de-cm-keys{color:var(--de-muted);margin-left:auto;font-size:11px}.de-cm-notice{background:var(--de-hover-soft);color:var(--de-ink-soft);border-radius:8px;align-items:center;gap:6px;padding:6px 6px 6px 10px;font-size:12px;display:flex}.de-cm-notice span{flex:1}.de-cm-card{border:1px solid var(--de-border);background:var(--de-cm-card);cursor:pointer;border-radius:10px;outline:none;flex:none;padding:10px 12px;transition:box-shadow .12s,border-color .12s}.de-cm-card:hover{border-color:var(--de-input-border)}.de-cm-card:focus-visible{box-shadow:0 0 0 2px var(--de-accent)}.de-cm-card.on{cursor:default;box-shadow:var(--de-pop-shadow);border-color:#0000}.de-cm-card.done{opacity:.75}.de-cm-card.on.done{opacity:1}.de-cm-quote{border-left:3px solid var(--de-cm-quote);color:var(--de-muted);-webkit-line-clamp:2;word-break:break-word;-webkit-box-orient:vertical;margin:0 0 8px;padding:0 0 0 8px;font-size:12px;display:-webkit-box;overflow:hidden}.de-cm-resolved{color:var(--de-ok);text-transform:uppercase;letter-spacing:.03em;margin:-2px 0 6px;font-size:11px;font-weight:600}.de-cm-item+.de-cm-item{border-top:1px solid var(--de-sep);margin-top:10px;padding-top:10px}.de-cm-head{align-items:center;gap:8px;display:flex}.de-cm-ava{color:#fff;text-transform:uppercase;border-radius:50%;flex:none;justify-content:center;align-items:center;width:28px;height:28px;font:600 11px/1 system-ui,sans-serif;display:inline-flex}.de-cm-who{flex-direction:column;flex:1;min-width:0;display:flex}.de-cm-name{color:var(--de-ink-strong);text-overflow:ellipsis;white-space:nowrap;font-weight:600;overflow:hidden}.de-cm-time{color:var(--de-muted);font-size:11px}.de-cm-icon{opacity:0;width:26px;height:26px}.de-cm-card:hover .de-cm-icon,.de-cm-card.on .de-cm-icon,.de-cm-icon:focus-visible{opacity:1}@media (hover:none){.de-cm-icon{opacity:1}}.de-cm-text{white-space:pre-wrap;word-break:break-word;color:var(--de-text);margin:6px 0 0 36px}.de-cm-at{color:var(--de-accent);font-weight:600}.de-cm-count{border-top:1px solid var(--de-sep);color:var(--de-accent);margin:8px 0 0 36px;padding-top:8px;font-size:12px}.de-cm-compose{cursor:auto;margin-top:10px;position:relative}.de-cm-item .de-cm-compose{margin-left:36px}.de-cm-compose textarea{resize:none;border:1px solid var(--de-border);background:var(--de-input-bg);width:100%;min-height:34px;max-height:200px;color:var(--de-text);font:inherit;border-radius:8px;outline:none;padding:7px 10px;line-height:1.4;display:block}.de-cm-compose textarea:focus{border-color:var(--de-accent);box-shadow:0 0 0 1px var(--de-accent)}.de-cm-actions{justify-content:flex-end;align-items:center;gap:6px;margin-top:6px;display:flex}.de-cm-tip{color:var(--de-muted);margin-right:auto;font-size:11px}.de-cm-actions .de-btn{border:1px solid var(--de-border);border-radius:16px;padding:5px 12px;font-size:12px}.de-cm-actions .de-btn-primary{background:var(--de-accent);border-color:var(--de-accent);color:var(--de-accent-ink)}.de-cm-actions .de-btn-primary:hover{background:var(--de-accent-hover)}.de-cm-actions .de-btn:disabled{opacity:.5;cursor:default}.de-cm-pop{z-index:30;background:var(--de-pop);max-height:220px;box-shadow:var(--de-pop-shadow);border-radius:8px;padding:4px;position:absolute;top:calc(100% - 32px);left:0;right:0;overflow-y:auto}.de-cm-pop button{width:100%;color:inherit;font:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:6px;align-items:center;gap:8px;padding:5px 8px;display:flex}.de-cm-pop button.on,.de-cm-pop button:hover{background:var(--de-hover-soft)}.de-cm-pop .de-cm-ava{width:22px;height:22px;font-size:10px}.de-cm-empty{color:var(--de-muted);text-align:center;padding:24px 8px}.de-cm-toggle .de-cm-n{background:var(--de-accent);min-width:16px;color:var(--de-accent-ink);border-radius:8px;padding:0 5px;font:600 10px/16px system-ui,sans-serif}.de-cm-mark{z-index:4;border-style:solid;border-width:0 8px 8px 0;border-color:transparent var(--de-cm-line) transparent transparent;pointer-events:none;width:0;height:0;position:absolute}.de-cm-mark.on{border-right-color:#c26401}.de-cm-pin{z-index:4;background:var(--de-cm-line);color:#fff;cursor:pointer;border:2px solid #fff;border-radius:13px 13px 13px 2px;justify-content:center;align-items:center;width:26px;height:26px;margin:-26px 0 0;padding:0;font:600 11px/1 system-ui,sans-serif;display:flex;position:absolute;box-shadow:0 1px 3px #00000059}.de-cm-pin.on{background:var(--de-accent);transform:scale(1.12)}.de-main{flex:1;min-width:0;min-height:0;display:flex;position:relative}.de-picture{box-sizing:border-box;justify-content:center;align-items:center;padding:24px;display:flex}.de-picture img{object-fit:contain;max-width:100%;max-height:100%;display:block}.de-body-stacked{flex-direction:column}.de-src-pane{background:var(--de-chrome);flex:none;min-width:0;min-height:0;display:flex;position:relative}.de-body-stacked .de-src-pane{width:auto!important}.de-split-handle{cursor:col-resize;background:var(--de-border);touch-action:none;flex:none;width:6px}.de-split-handle:hover,.de-split-handle:focus-visible{background:var(--de-accent);outline:none}.de-body-stacked .de-split-handle{cursor:row-resize;width:auto;height:6px}.de-src{--de-src-bg:#fff;--de-src-gutter:#f6f7f8;--de-src-sel:#1a73e840;--de-src-font:ui-monospace, SFMono-Regular, Menlo, Consolas, \"Liberation Mono\", monospace;min-width:0;min-height:0;color:var(--de-text);flex-direction:column;flex:1;display:flex}.de-dark .de-src{--de-src-bg:#1b1d20;--de-src-gutter:#202327;--de-src-sel:#669df659}.de-src-head{border-bottom:1px solid var(--de-border);flex:none;align-items:center;gap:10px;height:36px;padding:0 6px 0 12px;font-size:12px;display:flex}.de-src-title{align-items:center;gap:6px;font-weight:600;display:inline-flex}.de-src-lines{color:var(--de-muted)}.de-src-btn{width:28px;height:28px;color:var(--de-ink);cursor:pointer;background:0 0;border:0;border-radius:6px;place-items:center;display:inline-grid}.de-dark .de-src-btn{color:var(--de-text)}.de-src-btn:hover{background:var(--de-hover)}.de-src-notice{color:var(--de-muted);background:var(--de-head);border-bottom:1px solid var(--de-border);flex:none;padding:6px 12px;font-size:12px;line-height:1.4}.de-src-scroll{background:var(--de-src-bg);flex:1;align-items:stretch;min-height:0;display:flex;overflow:auto}.de-src-gutter,.de-src-hl,.de-src-input{font:13px/20px var(--de-src-font);letter-spacing:0;tab-size:4;white-space:pre;word-wrap:normal;overflow-wrap:normal;margin:0}.de-src-gutter{z-index:1;text-align:right;height:max-content;min-height:100%;color:var(--de-muted);background:var(--de-src-gutter);border-right:1px solid var(--de-border);-webkit-user-select:none;user-select:none;flex:none;padding:10px 10px 10px 12px;position:sticky;left:0}.de-src-code{flex:1 0 auto;height:max-content;min-height:100%;display:grid}.de-src-hl,.de-src-input{grid-area:1/1;padding:10px 24px 10px 12px}.de-src-hl{pointer-events:none;color:var(--de-text)}.de-src-input{resize:none;color:#0000;-webkit-text-fill-color:transparent;width:100%;height:100%;caret-color:var(--de-text);background:0 0;border:0;border-radius:0;outline:none;display:block;overflow:hidden}.de-src-input::selection{background:var(--de-src-sel)}.de-tk-c{color:#6a737d;font-style:italic}.de-tk-k{color:#8e3bc7}.de-tk-s{color:#1a7f37}.de-tk-o{color:#c2410c}.de-tk-n{color:#0b7a8a}.de-tk-h{color:#0b57d0;font-weight:600}.de-tk-a{color:#0b57d0}.de-tk-t{color:#b42318}.de-tk-m{color:#8a5a00}.de-tk-b{font-weight:700}.de-tk-i{font-style:italic}.de-dark .de-tk-c{color:#8b949e}.de-dark .de-tk-k{color:#d2a8ff}.de-dark .de-tk-s{color:#7ee787}.de-dark .de-tk-o{color:#ffa657}.de-dark .de-tk-n{color:#79c0ff}.de-dark .de-tk-h,.de-dark .de-tk-a{color:#8ab4f8}.de-dark .de-tk-t{color:#ff7b72}.de-dark .de-tk-m{color:#e3b341}", ya = "office-engine-styles";
function ba(e = typeof document < "u" ? document : void 0) {
	if (!e) return;
	let t = e instanceof Document ? e.head : e;
	if (t.querySelector?.(`style#${ya}`)) return;
	let n = (e instanceof Document ? e : e.ownerDocument).createElement("style");
	n.id = ya, n.textContent = va, t.appendChild(n);
}
// src/react/file/print.tsx
var xa = "\nhtml, body { margin: 0; padding: 0; background: #fff; }\n.de-print {\n  color: #000;\n  font: 13px/1.4 system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;\n  -webkit-print-color-adjust: exact;\n  print-color-adjust: exact;\n}\n.de-print *, .de-print *::before, .de-print *::after { box-sizing: border-box; }\n.de-print img { max-width: none; }\n.de-print-page { position: relative; overflow: hidden; background: #fff; break-after: page; }\n.de-print-page:last-child { break-after: auto; }\n.de-print-page > .de-page { left: 0; top: 0; box-shadow: none; }\n/* position: own paint layer, so clipping cells after layout (fitText) stays cheap */\n.de-print-table { position: relative; border-collapse: collapse; table-layout: fixed; }\n.de-print-table td { padding: 0 3px 1px; vertical-align: bottom; white-space: pre; }\n.de-print-table.de-print-grid td { border: 1px solid #e2e4e7; }\n.de-print-grid + .de-print-grid { margin-top: -1px; }\n@media screen {\n  body { background: #e9ebee; }\n  .de-print { padding: 24px 16px; }\n  .de-print-page { margin: 0 auto 24px; box-shadow: 0 1px 3px rgba(15, 23, 42, 0.18); }\n  .de-print-sheet { width: max-content; max-width: none; margin: 0 auto; padding: 16px; background: #fff; box-shadow: 0 1px 3px rgba(15, 23, 42, 0.18); }\n}\n@media print {\n  .de-print-fit { zoom: var(--de-fit, 1); }\n}\n", Sa = (e) => `${va}\n${xa}\n@page { size: ${e.size}; margin: ${e.margin}; }\n`, Ca = (e) => new Promise((t) => setTimeout(t, e));
async function wa(e, t) {
	await Ca(0), await new Promise((e) => {
		let n, r = setTimeout(a, 8e3), i = new MutationObserver(() => {
			clearTimeout(n), n = setTimeout(a, 250);
		});
		function a() {
			i.disconnect(), clearTimeout(n), clearTimeout(r), e();
		}
		i.observe(t, {
			subtree: !0,
			childList: !0,
			attributes: !0
		}), n = setTimeout(a, 250);
	});
	let n = /* @__PURE__ */ new Set();
	for (let e of t.querySelectorAll("[style*=\"url(\"]")) for (let t of e.style.backgroundImage.matchAll(/url\(["']?([^"')]+)["']?\)/g)) /^(?:blob|data):/i.test(t[1]) && n.add(t[1]);
	let r = [...t.querySelectorAll("img")].map((e) => e.complete ? null : new Promise((t) => (e.onload = t, e.onerror = t)));
	for (let e of n) r.push(new Promise((t) => {
		let n = new Image();
		n.onload = n.onerror = t, n.src = e;
	}));
	await Promise.race([Promise.all(r), Ca(1e4)]), await Promise.race([e.fonts?.ready, Ca(3e3)]);
}
var Ta = /[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufefc]/;
function Ea(e, t, n) {
	for (; e < t;) {
		let r = e + t >> 1;
		n(r) ? t = r : e = r + 1;
	}
	return e;
}
function Da(e) {
	let t = e.ownerDocument.defaultView, n = e.ownerDocument.createRange(), r = (e, t) => (n.setStart(e, t), n.setEnd(e, t + 1), n.getBoundingClientRect()), i = [], a = [];
	for (let o of e.querySelectorAll("[data-de-fit]")) {
		let e = o.firstChild;
		if (e?.nodeType !== Node.TEXT_NODE || e.nextSibling) continue;
		let s = e, c = s.data;
		n.selectNodeContents(s);
		let l = n.getBoundingClientRect(), u = o.getBoundingClientRect(), d = u.left + o.clientLeft - .5, f = u.left + o.clientLeft + o.clientWidth + .5;
		if (l.left >= d && l.right <= f) continue;
		let p = t.getComputedStyle(o);
		if (o.dataset.deFit === "#") {
			let e = o.clientWidth - parseFloat(p.paddingLeft) - parseFloat(p.paddingRight);
			i.push([s, "#".repeat(Math.max(1, Math.floor(e / (l.width / c.length))))]);
		} else if (Ta.test(c) || p.whiteSpace !== "pre" && p.whiteSpace !== "nowrap") a.push(o);
		else {
			let e = [], t = 0;
			for (let n of c.split("\n")) {
				let i = t + n.length, a = Ea(t, i, (e) => r(s, e).left >= d), o = Ea(a, i, (e) => r(s, e).right > f);
				/[\udc00-\udfff]/.test(c[a] ?? "") && a++, /[\ud800-\udbff]/.test(c[o - 1] ?? "") && o--, e.push(c.slice(a, Math.max(a, o))), t = i + 1;
			}
			i.push([s, e.join("\n")]);
		}
	}
	for (let [e, t] of i) e.data = t;
	for (let e of a) e.style.overflow = "hidden";
}
async function Oa(e, t) {
	let n = document.createElement("iframe");
	n.setAttribute("aria-hidden", "true"), n.tabIndex = -1, n.style.cssText = "position:fixed;left:-20000px;top:0;width:1100px;height:800px;border:0;visibility:hidden", document.body.appendChild(n);
	let r = n.contentDocument;
	r.open(), r.write("<!doctype html><html><head><meta charset=\"utf-8\"></head><body></body></html>"), r.close(), r.title = t;
	let i = r.createElement("style");
	i.textContent = Sa(e), r.head.appendChild(i);
	let a = r.createElement("div");
	a.className = "de-print", r.body.appendChild(a);
	let o = Ie(a);
	o.render(e.node);
	let s = !1, c = () => {
		s || (s = !0, o.unmount(), n.remove());
	};
	try {
		await wa(r, a), Da(a);
	} catch (e) {
		throw c(), e;
	}
	return {
		frame: n,
		doc: r,
		host: a,
		dispose: c
	};
}
var ka = null;
async function Aa(e, t) {
	ka?.dispose();
	let n = await Oa(e, t);
	ka = n;
	let r = n.frame.contentWindow, i = () => {
		ka === n && (ka = null), setTimeout(() => n.dispose(), 1e3);
	};
	r.addEventListener("afterprint", i, { once: !0 }), setTimeout(i, 6e5);
	let a = document.title;
	document.title = t;
	try {
		r.focus();
		let e = !1;
		try {
			e = r.document.execCommand("print", !1);
		} catch {
			e = !1;
		}
		e || r.print();
	} finally {
		document.title = a;
	}
}
var ja = (e) => e.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
function Ma(e) {
	return new Promise((t, n) => {
		let r = new FileReader();
		r.onload = () => t(r.result), r.onerror = () => n(r.error), r.readAsDataURL(e);
	});
}
async function Na(e, t) {
	let n = await Oa(e, t);
	try {
		let r = n.host.outerHTML.replace(/ contenteditable="(?:true|false)"| data-de-fit="#?"/g, ""), i = new Set(r.match(/blob:[^"'()\s&]+/g) ?? []);
		for (let e of i) try {
			let t = await Ma(await (await fetch(e)).blob());
			r = r.split(e).join(t);
		} catch {}
		let a = `<!doctype html>\n<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${ja(t)}</title><style>${Sa(e)}</style></head><body>${r}</body></html>\n`;
		return new Blob([a], { type: "text/html;charset=utf-8" });
	} finally {
		n.dispose();
	}
}
// src/react/file/FileMenu.tsx
var Pa = {
	docx: "Word document",
	xlsx: "Excel workbook",
	pptx: "PowerPoint presentation"
}, Fa = {
	docx: ".docx",
	xlsx: ".xlsx",
	pptx: ".pptx"
}, Ia = {
	docx: [{
		id: "txt",
		label: "Plain text",
		ext: ".txt",
		mime: "text/plain"
	}, {
		id: "md",
		label: "Markdown",
		ext: ".md",
		mime: "text/markdown"
	}],
	xlsx: [{
		id: "csv",
		label: "CSV (current sheet)",
		ext: ".csv",
		mime: "text/csv"
	}, {
		id: "tsv",
		label: "TSV (current sheet)",
		ext: ".tsv",
		mime: "text/tab-separated-values"
	}],
	pptx: [{
		id: "txt",
		label: "Plain text",
		ext: ".txt",
		mime: "text/plain"
	}]
}, La = /^(new:|open$|import$|rename$|details$|close$|extra:)/;
function Ra(e) {
	let [t, n] = H(!1), r = V(!1), i = V(e);
	i.current = e;
	let a = e.kind, o = [], s = (e) => {
		e.length && (e[0] = {
			...e[0],
			sep: o.length > 0
		}, o.push(...e));
	};
	s(e.canOpen ? [
		{
			value: "new:docx",
			label: "Document",
			icon: "doc",
			head: "New"
		},
		{
			value: "new:xlsx",
			label: "Spreadsheet",
			icon: "table"
		},
		{
			value: "new:pptx",
			label: "Presentation",
			icon: "slides"
		},
		{
			value: "open",
			label: "Open…",
			icon: "open",
			hint: `${Q}O`,
			sep: !0
		}
	] : []), e.canImport && a === "xlsx" && o.push({
		value: "import",
		label: "Import CSV into new sheet…",
		icon: "table",
		sep: !e.canOpen && o.length > 0
	});
	let c = [];
	a && e.canSave && c.push({
		value: "save",
		label: "Save",
		icon: "save",
		hint: `${Q}S`
	}), a && e.rename && c.push({
		value: "rename",
		label: "Rename…",
		icon: "edit"
	}), s(c), e.canDownload && a && s([
		{
			value: "original",
			label: Pa[a],
			icon: "save",
			hint: Fa[a],
			head: "Download as"
		},
		{
			value: "pdf",
			label: "PDF document",
			icon: "pdf",
			hint: ".pdf"
		},
		...e.picture ? [{
			value: "picture",
			label: e.picture.label,
			icon: "image",
			hint: e.picture.ext
		}] : [{
			value: "html",
			label: "Web page",
			icon: "html",
			hint: ".html"
		}, ...Ia[a].map((e) => ({
			value: "text:" + e.id,
			label: e.label,
			icon: "doc",
			hint: e.ext
		}))]
	]);
	let l = [];
	a && e.details && l.push({
		value: "details",
		label: "Document details",
		icon: "info"
	}), a && e.canDownload && l.push({
		value: "print",
		label: "Print",
		icon: "print",
		hint: `${Q}P`
	}), s(l), s(e.extra.map((e, t) => ({
		value: `extra:${t}`,
		label: e.label,
		icon: e.icon,
		hint: e.hint,
		disabled: e.disabled
	}))), e.close && s([{
		value: "close",
		label: "Close",
		icon: "close"
	}]);
	let u = async (e) => {
		let t = i.current;
		if (e.startsWith("new:")) return t.create(e.slice(4));
		if (e.startsWith("extra:")) return t.extra[Number(e.slice(6))]?.onClick();
		switch (e) {
			case "open": {
				let [e] = await Nt(ga, !1);
				e && t.open(e);
				return;
			}
			case "rename": return t.rename?.();
			case "details": return t.details?.();
			case "close": return t.close?.();
			case "save": return t.save();
		}
		let n = t.ops.current;
		if (e === "import") {
			let [e] = await Nt(".csv,.tsv,.tab,.txt", !1);
			if (!e) return;
			if (!n?.importText) throw Error("The document is still loading — try again in a moment");
			await n.importText(e, e.name.replace(/\.[^.]+$/, "").slice(0, 31) || "Imported");
		} else if (t.kind && t.canDownload) {
			if (e === "original") return t.downloadOriginal();
			if (e === "picture") return t.picture?.download();
			if (!n) throw Error("The document is still loading — try again in a moment");
			if (e.startsWith("text:")) {
				let r = Ia[t.kind].find((t) => "text:" + t.id === e);
				if (!r) return;
				kt(new Blob([await n.text(r.id)], { type: `${r.mime};charset=utf-8` }), t.base + r.ext);
			} else if (e === "pdf" || e === "print" || e === "html") {
				t.notify(e === "pdf" ? "Preparing PDF… choose “Save as PDF” in the print dialog" : "Preparing…");
				let r = await n.printable();
				r.notice && t.notify(r.notice), e === "html" ? kt(await Na(r, t.base), t.base + ".html") : await Aa(r, t.base);
			}
		}
	};
	return {
		options: o,
		busy: t,
		run: (e) => {
			let t = La.test(e);
			(!r.current || t) && (t || (r.current = !0, n(!0)), Promise.resolve().then(() => u(e)).catch((e) => i.current.notify(e.message || String(e))).finally(() => {
				t || (r.current = !1, n(!1));
			}));
		}
	};
}
function za({ actions: e }) {
	return e.options.length ? /* @__PURE__ */ W(Z, {
		title: "File",
		label: "File",
		className: "de-file",
		options: e.options,
		onChange: e.run,
		menuWidth: 280,
		disabled: e.busy
	}) : null;
}
// src/react/source/highlight.ts
var Ba = (e) => e.map(([e, t]) => [new RegExp(typeof e == "string" ? e : e.source, "y" + (typeof e == "string" ? "" : e.flags.replace(/[gy]/g, ""))), t]), Va = {
	mermaid: Ba([
		[/%%.*/, "c"],
		[/"[^"]*"/, "s"],
		[/\|[^|\n]*\|(?=\s*[\w"([{])/, "s"],
		["\\b(?:graph|flowchart|subgraph|end|direction|classDef|class|style|linkStyle|click|sequenceDiagram|participant|actor|loop|alt|else|opt|par|and|critical|option|break|rect|[Nn]ote|over|left of|right of|activate|deactivate|autonumber|title|classDiagram(?:-v2)?|stateDiagram(?:-v2)?|state|erDiagram|pie|showData|gantt|dateFormat|axisFormat|excludes|section|mindmap|namespace|TB|TD|BT|RL|LR|as|box|create|destroy|done|active|crit|milestone|after)\\b", "k"],
		[/<<-->>|<<->>|-->>|->>|--[x)]|-[x)]|<?-\.+->?|<?={2,}>?|<?-{2,}[>ox]?|->|~~~|<\|--|--\|>|\*--|--\*|o--|--o|\.\.>|\.\.\|>|<\.\.|\.\.|[|}][|o]--[|o][|{]|[|}][|o]\.\.[|o][|{]|:::|&/, "o"],
		[/\b\d+(?:\.\d+)?\b/, "n"],
		[/#[0-9a-fA-F]{3,8}\b/, "n"]
	]),
	plantuml: Ba([
		[/@(?:start|end)\w*/, "k"],
		[/![a-z]+\b.*/, "k"],
		[/"[^"]*"/, "s"],
		[/^\s*:[^;\n]*[;|<>/\]}]?/, "s"],
		[/\b(?:participant|actor|boundary|control|entity|database|collections|queue|class|interface|abstract|enum|annotation|package|namespace|node|component|usecase|rectangle|cloud|folder|frame|artifact|storage|card|file|object|state|start|stop|end|if|then|else|elseif|endif|while|endwhile|repeat|fork|again|merge|note|of|left|right|top|bottom|over|alt|opt|loop|par|break|critical|group|return|activate|deactivate|destroy|create|autonumber|title|skinparam|as|is|not|detach|kill|partition|split|switch|case|endswitch|hide|show|footbox|direction|to)\b/, "k"],
		[/<<[^>\n]*>>/, "a"],
		[/[<*o#x}|^+]{0,2}(?:-+|\.{2,}|=+)(?:\[[^\]\n]*\])?(?:up|down|left|right)?(?:-+|\.+|=+)?(?:\|>|>>?|[*o#x{|^+\\/]{1,2})|<\|?(?:-+|\.+)|--+|\.\.+|\+\+|\*\*|!!/, "o"],
		[/#[0-9a-zA-Z]{3,8}\b/, "n"],
		[/\b\d+\b/, "n"]
	]),
	graphviz: Ba([
		[/\/\/.*/, "c"],
		[/"(?:\\.|[^"\\])*"/, "s"],
		[/<(?:[^<>]|<[^<>]*>)*>/, "s"],
		[/\b(?:strict|graph|digraph|subgraph|node|edge)\b/i, "k"],
		[/[\w.]+(?=\s*=)/, "a"],
		[/->|--/, "o"],
		[/-?\b\d+(?:\.\d+)?\b/, "n"]
	]),
	html: Ba([
		[/<!\[CDATA\[.*?\]\]>/, "c"],
		[/<!doctype[^>]*>/i, "k"],
		[/<\/?[A-Za-z][\w:-]*/, "t"],
		[/\/?>/, "t"],
		[/[\w:-]+(?==)/, "a"],
		[/"[^"\n]*"|'[^'\n]*'/, "s"],
		[/&(?:#\d+|#x[0-9a-fA-F]+|\w+);/, "n"]
	]),
	markdown: Ba([
		[/`[^`\n]+`/, "m"],
		[/!?\[[^\]\n]*\]\([^)\n]*\)/, "a"],
		[/<https?:\/\/[^>\s]+>/, "a"],
		[/(\*\*|__)(?=\S)[^\n]*?\S\1/, "b"],
		[/(?<![\w*])\*(?=\S)[^*\n]*?\S\*(?!\*)|(?<!\w)_(?=\S)[^_\n]*?\S_(?!\w)/, "i"],
		[/~~(?=\S)[^\n]*?\S~~/, "c"],
		[/<\/?[A-Za-z][^>\n]*>/, "t"]
	])
}, Ha = be({
	mermaid: "mermaid",
	mmd: "mermaid",
	plantuml: "plantuml",
	puml: "plantuml",
	uml: "plantuml",
	dot: "graphviz",
	graphviz: "graphviz",
	gv: "graphviz",
	html: "html"
});
function Ua(e, t, n) {
	let r = "", i = 0;
	for (; i < e.length;) {
		let a = !1;
		for (let [o, s] of t) {
			o.lastIndex = i;
			let t = o.exec(e);
			if (t && t[0].length) {
				r && n.push(["", r]), r = "", n.push([s, t[0]]), i += t[0].length, a = !0;
				break;
			}
		}
		if (!a) {
			let t = /^[\p{L}\p{N}_]+/u.exec(e.slice(i, i + 64)), n = t ? t[0].length : 1;
			r += e.slice(i, i + n), i += n;
		}
	}
	r && n.push(["", r]);
}
function Wa(e, t, n, r, i, a = 0) {
	let o = e.indexOf(n, t + a);
	return o < 0 ? (i.push([r, e.slice(t)]), -1) : (i.push([r, e.slice(t, o + n.length)]), o + n.length);
}
function Ga(e, t, n = 3e5) {
	let r = e === "svg" ? "html" : e;
	if (t.length > n || !(r in Va)) return [["", t]];
	let i = [], a = null, o = null;
	return t.split("\n").forEach((e, t) => {
		if (t && i.push(["", "\n"]), r === "markdown") {
			let t = /^(\s*)(`{3,}|~{3,})\s*([\w-]*).*$/.exec(e);
			if (a) {
				t && t[2][0] === a.mark[0] && t[2].length >= a.mark.length && !t[3] ? (i.push(["k", e]), a = null) : a.lang ? s(a.lang, e) : i.push(["m", e]);
				return;
			}
			if (t) {
				a = {
					mark: t[2],
					lang: Ha[t[3].toLowerCase()]
				}, i.push(["k", e]);
				return;
			}
			if (/^\s{0,3}#{1,6}(\s|$)/.test(e)) return void i.push(["h", e]);
			if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(e)) return void i.push(["o", e]);
			let n = /^(\s*(?:>\s*)*)((?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?)?/.exec(e);
			n[0] && (n[1].includes(">") ? i.push(["c", n[1]]) : n[1] && i.push(["", n[1]]), n[2] && i.push(["o", n[2]])), Ua(e.slice(n[0].length), Va.markdown, i);
		} else s(r, e);
	}), i;
	function s(e, t) {
		let n = 0;
		if (o) {
			let e = Wa(t, 0, o, "c", i);
			if (e < 0) return;
			o = null, n = e;
		}
		let r = e === "html" ? [[/<!--/, "-->"]] : e === "graphviz" ? [[/\/\*/, "*/"]] : e === "plantuml" ? [[/\/'/, "'/"]] : [];
		for (; n <= t.length;) {
			let a = -1, s = "";
			for (let [e, i] of r) {
				let r = e.exec(t.slice(n));
				r && (a < 0 || r.index + n < a) && (a = r.index + n, s = i);
			}
			let c = a < 0 ? t.slice(n) : t.slice(n, a);
			if (e === "plantuml" && /^\s*'/.test(c) && n === 0 || e === "graphviz" && n === 0 && /^\s*#/.test(c) ? i.push(["c", c]) : Ua(c, Va[e], i), a < 0) return;
			let l = Wa(t, a, s, "c", i, s === "-->" ? 4 : 2);
			if (l < 0) {
				o = s;
				return;
			}
			if (n = l, n === t.length) return;
		}
	}
}
// src/react/source/SourceEditor.tsx
var Ka = {
	markdown: "Markdown",
	html: "HTML",
	svg: "SVG",
	mermaid: "Mermaid",
	plantuml: "PlantUML",
	graphviz: "Graphviz"
};
function qa({ text: e, format: t, onChange: n, readOnly: r, notice: i, onCopy: a, onDownload: o }) {
	let s = Me(() => Ga(t, e), [t, e]), c = Me(() => {
		let t = 1;
		for (let n = e.indexOf("\n"); n >= 0; n = e.indexOf("\n", n + 1)) t++;
		return t;
	}, [e]), l = Me(() => Array.from({ length: c }, (e, t) => t + 1).join("\n"), [c]), u = V(!1), d = (e, t) => {
		e.ownerDocument.execCommand?.("insertText", !1, t) || (e.setRangeText(t, e.selectionStart, e.selectionEnd, "end"), n(e.value));
	};
	return /* @__PURE__ */ G("div", {
		className: "de-src",
		"data-testid": "de-source",
		children: [
			/* @__PURE__ */ G("div", {
				className: "de-src-head",
				children: [
					/* @__PURE__ */ G("span", {
						className: "de-src-title",
						children: [/* @__PURE__ */ W(J, {
							name: "code",
							size: 15
						}), Ka[t] ?? "Source"]
					}),
					/* @__PURE__ */ G("span", {
						className: "de-src-lines",
						children: [
							c,
							" ",
							c === 1 ? "line" : "lines"
						]
					}),
					/* @__PURE__ */ W("span", { style: { flex: 1 } }),
					a && /* @__PURE__ */ W("button", {
						type: "button",
						className: "de-src-btn",
						onClick: a,
						title: "Copy the source",
						children: /* @__PURE__ */ W(J, {
							name: "copy",
							size: 15
						})
					}),
					o && /* @__PURE__ */ W("button", {
						type: "button",
						className: "de-src-btn",
						onClick: o,
						title: "Download the source",
						children: /* @__PURE__ */ W(J, {
							name: "save",
							size: 15
						})
					})
				]
			}),
			i && /* @__PURE__ */ W("div", {
				className: "de-src-notice",
				children: i
			}),
			/* @__PURE__ */ G("div", {
				className: "de-src-scroll",
				children: [/* @__PURE__ */ W("pre", {
					className: "de-src-gutter",
					"aria-hidden": "true",
					children: l
				}), /* @__PURE__ */ G("div", {
					className: "de-src-code",
					children: [/* @__PURE__ */ G("pre", {
						className: "de-src-hl",
						"aria-hidden": "true",
						children: [s.map(([e, t], n) => e ? /* @__PURE__ */ W("span", {
							className: `de-tk-${e}`,
							children: t
						}, n) : t), "\n"]
					}), /* @__PURE__ */ W("textarea", {
						className: "de-src-input",
						value: e,
						readOnly: r,
						onChange: (e) => n(e.target.value),
						onKeyDown: (e) => {
							let t = e.currentTarget;
							if (e.key === "Escape") {
								u.current = !0;
								return;
							}
							let n = u.current;
							if (u.current = !1, !(r || e.altKey || e.metaKey || e.ctrlKey || e.nativeEvent.isComposing)) {
								if (e.key === "Tab" && !e.shiftKey && !n) e.preventDefault(), d(t, "  ");
								else if (e.key === "Enter" && !e.shiftKey) {
									let n = t.value.lastIndexOf("\n", t.selectionStart - 1) + 1, r = /^[ \t]*/.exec(t.value.slice(n, t.selectionStart))[0];
									if (!r) return;
									e.preventDefault(), d(t, "\n" + r);
								}
							}
						},
						spellCheck: !1,
						autoCapitalize: "off",
						autoComplete: "off",
						autoCorrect: "off",
						wrap: "off",
						rows: 1,
						cols: 1,
						"aria-label": `${Ka[t] ?? "Source"} source`,
						"data-testid": "de-source-input"
					})]
				})]
			})
		]
	});
}
// src/react/picture/PictureView.tsx
function Ja({ client: e }) {
	let [t, r] = H(null);
	B(() => {
		let t = !0, i = "";
		return e.call("docx.start").catch(() => {}), e.call("plain.source").then((e) => {
			if (t) try {
				let t = n(e ?? "");
				i = URL.createObjectURL(new Blob([t.svg], { type: "image/svg+xml" })), r({
					url: i,
					w: t.w,
					h: t.h,
					alt: t.alt ?? ""
				});
			} catch (e) {
				r({ error: e.message });
			}
		}, (e) => t && r({ error: e.message })), () => {
			t = !1, i && URL.revokeObjectURL(i);
		};
	}, [e]);
	let i = t && "url" in t ? t : null;
	return It({
		printable: async () => {
			if (!i) throw Error("The picture is not shown");
			return {
				size: "auto",
				margin: "1cm",
				node: /* @__PURE__ */ W("img", {
					src: i.url,
					alt: i.alt,
					style: {
						width: `${i.w}px`,
						maxWidth: "100%"
					}
				})
			};
		},
		text: async () => await e.call("plain.source") ?? "",
		stats: () => i ? [["Picture size", `${Math.round(i.w)} × ${Math.round(i.h)} px`]] : []
	}), t ? "error" in t ? /* @__PURE__ */ W("div", {
		className: "de-center",
		children: /* @__PURE__ */ G("div", {
			className: "de-error",
			role: "alert",
			children: [/* @__PURE__ */ W("strong", { children: "SVG picture not drawn." }), /* @__PURE__ */ W("div", { children: t.error })]
		})
	}) : /* @__PURE__ */ W("div", {
		className: "de-scroll de-picture",
		"data-testid": "de-picture",
		children: /* @__PURE__ */ W("img", {
			src: t.url,
			alt: t.alt,
			draggable: !1,
			style: {
				width: `${t.w}px`,
				height: `${t.h}px`
			}
		})
	}) : /* @__PURE__ */ W("div", {
		className: "de-center",
		children: /* @__PURE__ */ W("div", { className: "de-spinner" })
	});
}
// src/react/pptx/PptxEditor.ts
var Ya = (e) => ({
	sz: e.sz,
	b: e.b,
	i: e.i,
	u: e.u,
	strike: e.strike,
	color: e.color,
	font: e.font,
	baseline: e.baseline,
	caps: e.caps,
	hl: e.hl
});
function Xa(e) {
	let t = e.runs.map((e) => e.fld ? {
		t: "fld",
		text: e.text,
		s: Ya(e),
		src: e.src
	} : {
		t: "text",
		text: e.br ? "\n" : e.text,
		s: Ya(e),
		src: e.src
	});
	return {
		runs: ue(t),
		base: e,
		algn: e.algn,
		k: e.k
	};
}
var Za = (e) => e.pp?.bullet ?? e.base.buKind ?? "none", Qa = (e) => e.pp?.lvl ?? e.base.lvl ?? 0;
function $a(e, t = 0) {
	let n = Za(e), r = Qa(e), i = e.runs.find((e) => e.t === "text")?.s?.sz ?? e.base.endSz, a = e.pp?.bullet ? n === "none" ? void 0 : {
		text: n === "bullet" ? "•" : `${t}.`,
		sz: i,
		color: e.base.bullet?.color
	} : e.base.bullet, o = (r - (e.base.lvl ?? 0)) * 48, s = e.pp?.bullet && n !== "none" && !e.base.bullet ? 27 : 0;
	return {
		...e.base,
		bullet: a,
		marL: Math.max(0, e.base.marL + o + s),
		indent: s ? -s : e.base.indent,
		lnPct: e.pp?.lnPct ?? e.base.lnPct,
		algn: e.algn,
		runs: e.runs.map((e) => e.t === "fld" ? {
			...e.s,
			text: e.text ?? "",
			fld: !0
		} : {
			...e.s,
			text: e.text ?? ""
		})
	};
}
var eo = class {
	client;
	input;
	paras = [];
	body;
	slide = -1;
	sid = -1;
	pendingSel = null;
	history = [];
	future = [];
	pend = null;
	timer;
	changedSinceCommit = !1;
	onChange;
	onCommitted;
	onEdited;
	committed = "";
	settled = Promise.resolve();
	onDirty;
	onState;
	constructor(e) {
		this.client = e, this.input = new he(this);
	}
	get active() {
		return this.sid >= 0;
	}
	begin(e, t, n) {
		this.end(), this.slide = e, this.sid = t, this.body = n, this.paras = (n.paras.length ? n.paras : [{
			algn: "left",
			marL: 0,
			indent: 0,
			spcBef: 0,
			spcAft: 0,
			runs: [],
			endSz: 18
		}]).map(Xa), this.history = [], this.future = [], this.pend = null, this.committed = this.plain();
	}
	plain() {
		return this.paras.map((e) => se(e.runs)).join("\n");
	}
	async flush() {
		this.commit(), await this.settled;
	}
	end() {
		this.sid >= 0 && this.changedSinceCommit && this.commit(), this.input.detach(), this.sid = -1, this.slide = -1, this.body = void 0, this.onState?.(null);
	}
	text() {
		if (!this.body) return;
		let e = [], t = this.paras.map((t) => {
			let n = Qa(t);
			return Za(t) === "number" ? e[n] = (e[n] ?? 0) + 1 : e[n] = 0, e.length = n + 1, $a(t, e[n]);
		});
		return {
			...this.body,
			empty: !1,
			paras: t
		};
	}
	para(e) {
		return this.paras[Number(e)];
	}
	span(e, t) {
		let n = [];
		for (let r = Number(e); r <= Number(t); r++) n.push(String(r));
		return n;
	}
	prev(e) {
		return Number(e) > 0 ? String(Number(e) - 1) : void 0;
	}
	next(e) {
		return Number(e) < this.paras.length - 1 ? String(Number(e) + 1) : void 0;
	}
	cmp(e, t) {
		return Number(e) - Number(t);
	}
	withRuns(e, t) {
		return {
			...e,
			runs: t
		};
	}
	split(e, t, n) {
		return [{
			...e,
			runs: t
		}, {
			...e,
			runs: n,
			caret: n.length ? void 0 : de(t, k(t)) ?? e.caret
		}];
	}
	join(e, t, n) {
		return {
			...e,
			runs: n
		};
	}
	defaultRun(e) {
		if (e.caret) return {
			...e.caret,
			text: ""
		};
		let t = [...e.runs].reverse().find((e) => e.t === "text");
		return t ? {
			...t,
			text: ""
		} : {
			t: "text",
			s: { sz: e.base.endSz }
		};
	}
	pendingStyle() {
		return this.pend ? {
			s: this.pend.s,
			d: this.pend.d
		} : void 0;
	}
	clearPending() {
		this.pend = null;
	}
	replace(e, t, n, r = {}) {
		let i = this.paras, a = Number(e[0]);
		if (this.paras = [
			...i.slice(0, a),
			...t,
			...i.slice(a + e.length)
		], r.history !== !1) {
			let e = Date.now(), t = this.history[this.history.length - 1], a = r.label ?? "edit";
			a === "type" && t?.label === "type" && e - t.t < 1500 ? (t.after = this.paras, t.selAfter = n, t.t = e) : this.history.push({
				before: i,
				after: this.paras,
				selBefore: this.input.lastSel ?? n,
				selAfter: n,
				label: a,
				t: e
			}), this.future = [];
		}
		this.pendingSel = n, this.changedSinceCommit = !0, this.onDirty?.(), clearTimeout(this.timer), this.timer = setTimeout(() => this.commit(), 400), this.onChange?.(), this.onState?.(this.state(n));
	}
	undo() {
		let e = this.history.pop();
		e && (this.future.push(e), this.restore(e.before, e.selBefore));
	}
	redo() {
		let e = this.future.pop();
		e && (this.history.push(e), this.restore(e.after, e.selAfter));
	}
	restore(e, t) {
		this.paras = e, this.pendingSel = t, this.changedSinceCommit = !0, clearTimeout(this.timer), this.timer = setTimeout(() => this.commit(), 400), this.onChange?.(), this.onState?.(this.state(t));
	}
	commit() {
		if (clearTimeout(this.timer), this.sid < 0 || !this.changedSinceCommit) return;
		this.changedSinceCommit = !1;
		let e = this.slide, t = this.sid, n = this.committed, r = this.plain();
		this.committed = r;
		let i = this.paras.map((e) => ({
			k: e.k,
			algn: e.algnSet ? e.algn : void 0,
			...e.pp,
			runs: e.runs.map((e) => e.t === "fld" ? {
				text: "",
				src: e.src,
				fld: !0
			} : {
				text: e.text ?? "",
				src: e.src,
				set: e.d
			})
		})), a = this.client.call("pptx.setText", e, t, i).then((i) => {
			this.onCommitted?.(e, i), this.onEdited?.({
				slide: e,
				sid: t,
				before: n,
				after: r
			});
		}).catch((e) => console.error("[office-engine] slide edit failed", e));
		this.settled = Promise.all([this.settled, a]).then(() => {});
	}
	format(e, t) {
		let n = this.input.sel();
		if (!n) return;
		if (I(n)) {
			this.pend = {
				s: {
					...this.pend?.s ?? {},
					...e
				},
				d: {
					...this.pend?.d ?? {},
					...t
				},
				at: n.a
			}, this.input.restore(n), this.onState?.(this.state(n));
			return;
		}
		let [r, i] = fe(this, n), a = this.span(r.pa, i.pa), o = a.map((n, o) => {
			let s = this.para(n), c = o === 0 ? r.o : 0, l = o === a.length - 1 ? i.o : k(s.runs);
			return this.withRuns(s, pe(s.runs, c, l, e, t));
		});
		this.replace(a, o, n, { label: "format" });
	}
	toggle(e) {
		let t = this.state(), n = !(t && t[e]);
		this.format({ [e]: n }, { [e]: n });
	}
	setSize(e) {
		this.format({ sz: e }, { sz: e });
	}
	setColor(e) {
		this.format({ color: e ?? void 0 }, { color: e });
	}
	setFont(e) {
		this.format({ font: c(e) }, { font: e });
	}
	setAlign(e) {
		let t = this.input.sel();
		if (!t) return;
		let [n, r] = fe(this, t), i = this.span(n.pa, r.pa);
		this.replace(i, i.map((t) => ({
			...this.para(t),
			algn: e,
			algnSet: !0
		})), t, { label: "align" });
	}
	paraOp(e, t) {
		let n = this.input.sel();
		if (!n) return;
		let [r, i] = fe(this, n), a = this.span(r.pa, i.pa);
		this.replace(a, a.map((t) => e(this.para(t))), n, { label: t });
	}
	toggleBullet(e) {
		let t = this.state()?.bullet === e ? "none" : e;
		this.paraOp((e) => ({
			...e,
			pp: {
				...e.pp,
				bullet: t
			}
		}), "bullet");
	}
	indentLevel(e) {
		this.paraOp((t) => ({
			...t,
			pp: {
				...t.pp,
				lvl: Math.max(0, Math.min(8, Qa(t) + e))
			}
		}), "indent");
	}
	setLineSpacing(e) {
		this.paraOp((t) => ({
			...t,
			pp: {
				...t.pp,
				lnPct: e
			}
		}), "spacing");
	}
	setHighlight(e) {
		this.format({ hl: e ?? void 0 }, { hl: e });
	}
	toggleBaseline(e) {
		let t = this.state()?.baseline ?? 0, n = e === "sup" ? t > 0 ? 0 : 30 : t < 0 ? 0 : -25;
		this.format({ baseline: n || void 0 }, { baseline: n || null });
	}
	clearFormat() {
		this.format({
			b: !1,
			i: !1,
			u: !1,
			strike: !1,
			hl: void 0,
			baseline: void 0
		}, {
			b: !1,
			i: !1,
			u: !1,
			strike: !1,
			hl: null,
			baseline: null
		});
	}
	state(e = this.input.sel()) {
		if (!e || this.sid < 0) return null;
		let [t] = fe(this, e), n = this.para(t.pa);
		if (!n) return null;
		let r = {
			...de(n.runs, I(e) ? t.o : t.o + 1)?.s ?? {},
			...I(e) ? this.pend?.s ?? {} : {}
		};
		return {
			b: !!r.b,
			i: !!r.i,
			u: !!r.u,
			strike: !!r.strike,
			sz: r.sz,
			color: r.color,
			font: r.font,
			algn: n.algn,
			hl: r.hl,
			baseline: r.baseline,
			bullet: Za(n),
			lvl: Qa(n),
			lnPct: n.pp?.lnPct ?? n.base.lnPct
		};
	}
	onSelection(e) {
		e && this.pend && (e.a.pa !== this.pend.at.pa || e.a.o !== this.pend.at.o) && (this.pend = null), this.onState?.(e ? this.state(e) : null);
	}
	shortcut;
}, to = [
	"#ffff00",
	"#00ff00",
	"#00ffff",
	"#ff00ff",
	"#ff0000",
	"#0000ff",
	"#ffc000",
	"#92d050",
	"#c0c0c0",
	"#000000"
], no = [
	{
		value: "text",
		label: "Text box",
		icon: "textbox"
	},
	{
		value: "image",
		label: "Image…",
		icon: "image"
	},
	{
		value: "line",
		label: "Line",
		icon: "line"
	},
	{
		value: "rect",
		label: "Rectangle",
		icon: "rect",
		sep: !0
	},
	{
		value: "roundRect",
		label: "Rounded rectangle",
		icon: "roundRect"
	},
	{
		value: "ellipse",
		label: "Ellipse",
		icon: "ellipse"
	},
	{
		value: "triangle",
		label: "Triangle",
		icon: "triangle"
	},
	{
		value: "rtTriangle",
		label: "Right triangle"
	},
	{
		value: "diamond",
		label: "Diamond"
	},
	{
		value: "parallelogram",
		label: "Parallelogram"
	},
	{
		value: "trapezoid",
		label: "Trapezoid"
	},
	{
		value: "pentagon",
		label: "Pentagon"
	},
	{
		value: "hexagon",
		label: "Hexagon"
	},
	{
		value: "octagon",
		label: "Octagon"
	},
	{
		value: "donut",
		label: "Donut"
	},
	{
		value: "can",
		label: "Cylinder"
	},
	{
		value: "heart",
		label: "Heart"
	},
	{
		value: "plus",
		label: "Plus"
	},
	{
		value: "rightArrow",
		label: "Arrow right",
		icon: "arrow",
		sep: !0
	},
	{
		value: "leftArrow",
		label: "Arrow left"
	},
	{
		value: "upArrow",
		label: "Arrow up"
	},
	{
		value: "downArrow",
		label: "Arrow down"
	},
	{
		value: "leftRightArrow",
		label: "Double arrow"
	},
	{
		value: "chevron",
		label: "Chevron"
	},
	{
		value: "homePlate",
		label: "Pentagon arrow"
	},
	{
		value: "star4",
		label: "4-point star",
		sep: !0
	},
	{
		value: "star5",
		label: "5-point star",
		icon: "star"
	},
	{
		value: "star6",
		label: "6-point star"
	},
	{
		value: "wedgeRectCallout",
		label: "Callout",
		sep: !0
	},
	{
		value: "wedgeRoundRectCallout",
		label: "Rounded callout"
	}
], ro = [
	.75,
	1,
	1.5,
	2.25,
	3,
	4.5,
	6
].map((e) => ({
	value: e,
	label: `${e} pt`
})), io = [
	{
		value: "solid",
		label: "Solid",
		hint: "────"
	},
	{
		value: "sysDot",
		label: "Dotted",
		hint: "········"
	},
	{
		value: "dash",
		label: "Dashed",
		hint: "- - - -"
	},
	{
		value: "lgDash",
		label: "Long dash",
		hint: "— — —"
	},
	{
		value: "dashDot",
		label: "Dash dot",
		hint: "-·-·-·"
	}
], ao = [
	1,
	1.15,
	1.5,
	2
].map((e) => ({
	value: e,
	label: e === 1 ? "Single" : e === 2 ? "Double" : String(e)
})), oo = [
	{
		value: "t",
		label: "Top",
		icon: "vTop"
	},
	{
		value: "ctr",
		label: "Middle",
		icon: "vMiddle"
	},
	{
		value: "b",
		label: "Bottom",
		icon: "vBottom"
	}
];
function so(e) {
	let { editor: t } = e, [n, r] = H(null);
	B(() => (t.onState = r, () => {
		t.onState = void 0;
	}), [t]);
	let i = !!n && t.active, a = Ot(n?.font), o = n?.sz ? Math.round(n.sz * 2) / 2 : void 0, s = i ? e.textAnchor : e.shape?.anchor;
	return /* @__PURE__ */ G(Rt, { children: [
		/* @__PURE__ */ W(Y, {
			icon: "undo",
			title: `Undo (${Q}Z)`,
			disabled: !i && !e.canUndo,
			onClick: () => i ? t.undo() : e.onUndo(!1)
		}),
		/* @__PURE__ */ W(Y, {
			icon: "redo",
			title: `Redo (${Q}Y)`,
			onClick: () => i ? t.redo() : e.onUndo(!0)
		}),
		/* @__PURE__ */ W(X, {}),
		/* @__PURE__ */ W(At, {
			title: "Insert",
			label: "Insert",
			icon: "plus",
			items: no,
			onPick: (t) => e.onInsert(t)
		}),
		/* @__PURE__ */ W(At, {
			title: "Slide",
			label: "Slide",
			icon: "slideAdd",
			items: [
				{
					value: "add",
					label: "New slide",
					icon: "slideAdd",
					hint: `${Q}M`
				},
				{
					value: "duplicate",
					label: "Duplicate slide",
					icon: "copy"
				},
				{
					value: "delete",
					label: "Delete slide",
					icon: "trash"
				},
				{
					value: "up",
					label: "Move slide up",
					icon: "up",
					sep: !0
				},
				{
					value: "down",
					label: "Move slide down",
					icon: "down"
				},
				{
					value: "hide",
					label: "Hide / show slide",
					icon: "hide",
					sep: !0
				}
			],
			onPick: (t) => e.onSlide(t)
		}),
		/* @__PURE__ */ W(X, {}),
		i ? /* @__PURE__ */ G(U, { children: [
			/* @__PURE__ */ W(ut, {
				title: "Font",
				width: 112,
				menuWidth: 200,
				value: a,
				placeholder: "Font",
				options: Dt(a),
				onChange: (e) => t.setFont(e)
			}),
			/* @__PURE__ */ W(X, {}),
			/* @__PURE__ */ W(dt, {
				value: o,
				onChange: (e) => t.setSize(e)
			}),
			/* @__PURE__ */ W(X, {}),
			/* @__PURE__ */ W(Y, {
				icon: "bold",
				title: `Bold (${Q}B)`,
				active: n?.b,
				onClick: () => t.toggle("b")
			}),
			/* @__PURE__ */ W(Y, {
				icon: "italic",
				title: `Italic (${Q}I)`,
				active: n?.i,
				onClick: () => t.toggle("i")
			}),
			/* @__PURE__ */ W(Y, {
				icon: "underline",
				title: `Underline (${Q}U)`,
				active: n?.u,
				onClick: () => t.toggle("u")
			}),
			/* @__PURE__ */ W(Y, {
				icon: "strike",
				title: "Strikethrough",
				active: n?.strike,
				onClick: () => t.toggle("strike")
			}),
			/* @__PURE__ */ W(wt, {
				icon: "color",
				title: "Text color",
				value: n?.color,
				onPick: (e) => t.setColor(e),
				noneLabel: "Automatic"
			}),
			/* @__PURE__ */ W(wt, {
				icon: "highlight",
				title: "Highlight color",
				value: n?.hl,
				palette: to,
				onPick: (e) => t.setHighlight(e)
			}),
			/* @__PURE__ */ W(Y, {
				icon: "sup",
				title: "Superscript",
				active: (n?.baseline ?? 0) > 0,
				onClick: () => t.toggleBaseline("sup")
			}),
			/* @__PURE__ */ W(Y, {
				icon: "sub",
				title: "Subscript",
				active: (n?.baseline ?? 0) < 0,
				onClick: () => t.toggleBaseline("sub")
			}),
			/* @__PURE__ */ W(X, {}),
			/* @__PURE__ */ W(Y, {
				icon: "alignLeft",
				title: "Align left",
				active: n?.algn === "left",
				onClick: () => t.setAlign("left")
			}),
			/* @__PURE__ */ W(Y, {
				icon: "alignCenter",
				title: "Center",
				active: n?.algn === "center",
				onClick: () => t.setAlign("center")
			}),
			/* @__PURE__ */ W(Y, {
				icon: "alignRight",
				title: "Align right",
				active: n?.algn === "right",
				onClick: () => t.setAlign("right")
			}),
			/* @__PURE__ */ W(Y, {
				icon: "justify",
				title: "Justify",
				active: n?.algn === "justify",
				onClick: () => t.setAlign("justify")
			}),
			/* @__PURE__ */ W(Z, {
				title: "Vertical align",
				icon: oo.find((e) => e.value === s)?.icon ?? "vTop",
				label: null,
				menuWidth: 140,
				value: s ?? "t",
				options: oo.map((e) => ({ ...e })),
				onChange: e.onAnchor
			}),
			/* @__PURE__ */ W(Z, {
				title: "Line spacing",
				icon: "lineSpacing",
				label: null,
				menuWidth: 140,
				value: n?.lnPct ? Math.round(n.lnPct * 100) / 100 : "",
				options: ao,
				onChange: (e) => t.setLineSpacing(e)
			}),
			/* @__PURE__ */ W(X, {}),
			/* @__PURE__ */ W(Y, {
				icon: "bullets",
				title: "Bulleted list",
				active: n?.bullet === "bullet",
				onClick: () => t.toggleBullet("bullet")
			}),
			/* @__PURE__ */ W(Y, {
				icon: "numbers",
				title: "Numbered list",
				active: n?.bullet === "number",
				onClick: () => t.toggleBullet("number")
			}),
			/* @__PURE__ */ W(Y, {
				icon: "outdent",
				title: "Decrease indent (Shift+Tab)",
				disabled: !n?.lvl,
				onClick: () => t.indentLevel(-1)
			}),
			/* @__PURE__ */ W(Y, {
				icon: "indent",
				title: "Increase indent",
				onClick: () => t.indentLevel(1)
			}),
			/* @__PURE__ */ W(Y, {
				icon: "clear",
				title: "Clear formatting",
				onClick: () => t.clearFormat()
			})
		] }) : e.shape ? /* @__PURE__ */ G(U, { children: [
			/* @__PURE__ */ W(wt, {
				icon: "fill",
				title: "Fill color",
				onPick: e.onFill,
				noneLabel: "Transparent"
			}),
			/* @__PURE__ */ W(wt, {
				icon: "borders",
				title: "Border color",
				onPick: (t) => e.onLine({ color: t }),
				noneLabel: "Transparent"
			}),
			/* @__PURE__ */ W(Z, {
				title: "Border weight",
				icon: "lineWeight",
				label: null,
				menuWidth: 120,
				options: ro,
				onChange: (t) => e.onLine({ w: t })
			}),
			/* @__PURE__ */ W(Z, {
				title: "Border dash",
				icon: "lineStyle",
				label: null,
				menuWidth: 170,
				options: io,
				onChange: (t) => e.onLine({ dash: t })
			}),
			/* @__PURE__ */ W(X, {}),
			/* @__PURE__ */ W(At, {
				title: "Arrange",
				label: "Arrange",
				icon: "front",
				items: [
					{
						value: "front",
						label: "Bring to front",
						icon: "front",
						hint: `${Q}⇧↑`
					},
					{
						value: "forward",
						label: "Bring forward",
						hint: `${Q}↑`
					},
					{
						value: "backward",
						label: "Send backward",
						hint: `${Q}↓`
					},
					{
						value: "back",
						label: "Send to back",
						icon: "back",
						hint: `${Q}⇧↓`
					}
				],
				onPick: (t) => e.onArrange(t)
			}),
			/* @__PURE__ */ W(Z, {
				title: "Rotate",
				icon: "rotate",
				label: null,
				menuWidth: 220,
				options: [
					{
						value: "cw",
						label: "Rotate 90° clockwise",
						icon: "rotate"
					},
					{
						value: "ccw",
						label: "Rotate 90° counter-clockwise",
						icon: "rotateCcw"
					},
					{
						value: "flipH",
						label: "Flip horizontally",
						icon: "flipH",
						sep: !0
					},
					{
						value: "flipV",
						label: "Flip vertically",
						icon: "flipV"
					}
				],
				onChange: (t) => e.onRotate(t)
			}),
			/* @__PURE__ */ W(Z, {
				title: "Align on slide",
				icon: "alignObj",
				label: null,
				menuWidth: 150,
				options: [
					{
						value: "left",
						label: "Left",
						icon: "alignLeft"
					},
					{
						value: "center",
						label: "Center",
						icon: "alignCenter"
					},
					{
						value: "right",
						label: "Right",
						icon: "alignRight"
					},
					{
						value: "top",
						label: "Top",
						icon: "vTop",
						sep: !0
					},
					{
						value: "middle",
						label: "Middle",
						icon: "vMiddle"
					},
					{
						value: "bottom",
						label: "Bottom",
						icon: "vBottom"
					}
				],
				onChange: (t) => e.onAlign(t)
			}),
			e.shape.canText && /* @__PURE__ */ W(Z, {
				title: "Vertical text align",
				icon: oo.find((e) => e.value === s)?.icon ?? "vTop",
				label: null,
				menuWidth: 140,
				value: s ?? "t",
				options: oo.map((e) => ({ ...e })),
				onChange: e.onAnchor
			}),
			/* @__PURE__ */ W(X, {}),
			/* @__PURE__ */ W(Y, {
				icon: "copy",
				title: `Duplicate (${Q}D)`,
				onClick: e.onDuplicate
			}),
			/* @__PURE__ */ W(Y, {
				icon: "trash",
				title: "Delete (Del)",
				onClick: e.onDelete
			})
		] }) : /* @__PURE__ */ G(U, { children: [/* @__PURE__ */ W(wt, {
			icon: "fill",
			title: "Slide background",
			onPick: e.onBackground,
			noneLabel: "Layout default"
		}), /* @__PURE__ */ W("span", {
			className: "de-tb-hint",
			children: "Click a shape or text to edit it"
		})] }),
		/* @__PURE__ */ W(X, {}),
		/* @__PURE__ */ W(Z, {
			title: "Present",
			icon: "play",
			label: "Present",
			menuWidth: 200,
			options: [{
				value: "cur",
				label: "From current slide",
				hint: "F5"
			}, {
				value: "start",
				label: "From beginning",
				hint: "⇧F5"
			}],
			onChange: (t) => e.onPresent(t === "start")
		})
	] });
}
// src/react/pptx/Presenter.tsx
function co({ client: e, meta: t, start: n, onClose: r }) {
	let i = V(null), a = t.slides.filter((e) => !e.hidden).map((e) => e.index), o = a.length ? a : t.slides.map((e) => e.index), [s, c] = H(Math.max(0, o.findIndex((e) => e >= n))), [l, u] = H({
		w: window.innerWidth,
		h: window.innerHeight
	}), d = V(r);
	d.current = r, B(() => {
		let e = i.current;
		e?.focus(), e && document.fullscreenElement !== e && e.requestFullscreen?.().catch(() => {});
		let t = () => u({
			w: window.innerWidth,
			h: window.innerHeight
		}), n = () => !document.fullscreenElement && d.current();
		return window.addEventListener("resize", t), document.addEventListener("fullscreenchange", n), () => {
			window.removeEventListener("resize", t), document.removeEventListener("fullscreenchange", n), document.fullscreenElement && document.exitFullscreen().catch(() => {});
		};
	}, []);
	let f = (e) => c((t) => Math.max(0, Math.min(o.length - 1, t + e))), p = Math.min(l.w / t.w, l.h / t.h);
	return /* @__PURE__ */ G("div", {
		ref: i,
		className: "de-present",
		tabIndex: -1,
		onClick: () => f(1),
		onContextMenu: (e) => {
			e.preventDefault(), f(-1);
		},
		onKeyDown: (e) => {
			if ([
				"ArrowRight",
				"ArrowDown",
				"PageDown",
				" ",
				"Enter",
				"n"
			].includes(e.key)) f(1);
			else if ([
				"ArrowLeft",
				"ArrowUp",
				"PageUp",
				"Backspace",
				"p"
			].includes(e.key)) f(-1);
			else if (e.key === "Home") c(0);
			else if (e.key === "End") c(o.length - 1);
			else if (e.key === "Escape") r();
			else return;
			e.preventDefault();
		},
		children: [/* @__PURE__ */ W("div", {
			style: {
				width: t.w * p,
				height: t.h * p
			},
			children: /* @__PURE__ */ W(Go, {
				client: e,
				index: o[s],
				meta: t,
				scale: p,
				live: !0
			}, o[s])
		}), /* @__PURE__ */ G("div", {
			className: "de-present-n",
			children: [
				s + 1,
				" / ",
				o.length
			]
		})]
	});
}
// src/react/pptx/geometry.ts
var $ = (e) => +e.toFixed(2), lo = (e) => "M" + e.map(([e, t]) => `${$(e)} ${$(t)}`).join(" L") + " Z", uo = (e, t, n) => (e?.[t] ?? n) / 1e5;
function fo(e, t) {
	let n = e / 2, r = t / 2;
	return `M0 ${$(r)} A${$(n)} ${$(r)} 0 1 0 ${$(e)} ${$(r)} A${$(n)} ${$(r)} 0 1 0 0 ${$(r)} Z`;
}
function po(e, t, n) {
	return n = Math.min(n, e / 2, t / 2), `M${$(n)} 0 H${$(e - n)} A${$(n)} ${$(n)} 0 0 1 ${$(e)} ${$(n)} V${$(t - n)} A${$(n)} ${$(n)} 0 0 1 ${$(e - n)} ${$(t)} H${$(n)} A${$(n)} ${$(n)} 0 0 1 0 ${$(t - n)} V${$(n)} A${$(n)} ${$(n)} 0 0 1 ${$(n)} 0 Z`;
}
function mo(e, t, n, r = -Math.PI / 2) {
	let i = [];
	for (let a = 0; a < n; a++) {
		let o = r + a * 2 * Math.PI / n;
		i.push([e / 2 + e / 2 * Math.cos(o), t / 2 + t / 2 * Math.sin(o)]);
	}
	return lo(i);
}
function ho(e, t, n, r) {
	let i = [];
	for (let a = 0; a < n * 2; a++) {
		let o = -Math.PI / 2 + a * Math.PI / n, s = a % 2 ? r : 1;
		i.push([e / 2 + e / 2 * s * Math.cos(o), t / 2 + t / 2 * s * Math.sin(o)]);
	}
	return lo(i);
}
var go = /* @__PURE__ */ new Set([
	"line",
	"straightConnector1",
	"bentConnector2",
	"bentConnector3",
	"bentConnector4",
	"curvedConnector3",
	"curvedConnector2",
	"curvedConnector4"
]);
function _o(e, t, n, r) {
	let i = Math.min(t, n);
	switch (e) {
		case "ellipse":
		case "flowChartConnector":
		case "cloud": return fo(t, n);
		case "roundRect":
		case "flowChartAlternateProcess": return po(t, n, i * uo(r, "adj", 16667));
		case "flowChartTerminator": return po(t, n, n / 2);
		case "triangle": return lo([
			[t * uo(r, "adj", 5e4), 0],
			[t, n],
			[0, n]
		]);
		case "rtTriangle": return lo([
			[0, 0],
			[t, n],
			[0, n]
		]);
		case "diamond":
		case "flowChartDecision": return lo([
			[t / 2, 0],
			[t, n / 2],
			[t / 2, n],
			[0, n / 2]
		]);
		case "parallelogram":
		case "flowChartInputOutput": {
			let e = i * uo(r, "adj", 25e3);
			return lo([
				[e, 0],
				[t, 0],
				[t - e, n],
				[0, n]
			]);
		}
		case "trapezoid": {
			let e = i * uo(r, "adj", 25e3);
			return lo([
				[e, 0],
				[t - e, 0],
				[t, n],
				[0, n]
			]);
		}
		case "pentagon": return mo(t, n, 5);
		case "hexagon": {
			let e = i * uo(r, "adj", 25e3);
			return lo([
				[e, 0],
				[t - e, 0],
				[t, n / 2],
				[t - e, n],
				[e, n],
				[0, n / 2]
			]);
		}
		case "heptagon": return mo(t, n, 7);
		case "octagon": {
			let e = i * uo(r, "adj", 29289);
			return lo([
				[e, 0],
				[t - e, 0],
				[t, e],
				[t, n - e],
				[t - e, n],
				[e, n],
				[0, n - e],
				[0, e]
			]);
		}
		case "decagon": return mo(t, n, 10);
		case "dodecagon": return mo(t, n, 12);
		case "star4": return ho(t, n, 4, .38);
		case "star5": return ho(t, n, 5, .38);
		case "star6": return ho(t, n, 6, .5);
		case "star8": return ho(t, n, 8, .6);
		case "star10":
		case "star12":
		case "star16":
		case "star24": return ho(t, n, Number(e.slice(4)), .7);
		case "homePlate": {
			let e = i * uo(r, "adj", 5e4);
			return lo([
				[0, 0],
				[t - e, 0],
				[t, n / 2],
				[t - e, n],
				[0, n]
			]);
		}
		case "chevron": {
			let e = i * uo(r, "adj", 5e4);
			return lo([
				[0, 0],
				[t - e, 0],
				[t, n / 2],
				[t - e, n],
				[0, n],
				[e, n / 2]
			]);
		}
		case "rightArrow":
		case "leftArrow": {
			let a = n * uo(r, "adj1", 5e4), o = i * uo(r, "adj2", 5e4), s = (n - a) / 2, c = [
				[0, s],
				[t - o, s],
				[t - o, 0],
				[t, n / 2],
				[t - o, n],
				[t - o, s + a],
				[0, s + a]
			];
			return lo(e === "leftArrow" ? c.map(([e, n]) => [t - e, n]) : c);
		}
		case "upArrow":
		case "downArrow": {
			let a = t * uo(r, "adj1", 5e4), o = i * uo(r, "adj2", 5e4), s = (t - a) / 2, c = [
				[s, n],
				[s, o],
				[0, o],
				[t / 2, 0],
				[t, o],
				[s + a, o],
				[s + a, n]
			];
			return lo(e === "downArrow" ? c.map(([e, t]) => [e, n - t]) : c);
		}
		case "leftRightArrow": {
			let e = n * uo(r, "adj1", 5e4), a = i * uo(r, "adj2", 5e4), o = (n - e) / 2;
			return lo([
				[0, n / 2],
				[a, 0],
				[a, o],
				[t - a, o],
				[t - a, 0],
				[t, n / 2],
				[t - a, n],
				[t - a, o + e],
				[a, o + e],
				[a, n]
			]);
		}
		case "plus":
		case "mathPlus": {
			let e = i * uo(r, "adj", 25e3);
			return lo([
				[e, 0],
				[t - e, 0],
				[t - e, e],
				[t, e],
				[t, n - e],
				[t - e, n - e],
				[t - e, n],
				[e, n],
				[e, n - e],
				[0, n - e],
				[0, e],
				[e, e]
			]);
		}
		case "snip1Rect": {
			let e = i * uo(r, "adj", 16667);
			return lo([
				[0, 0],
				[t - e, 0],
				[t, e],
				[t, n],
				[0, n]
			]);
		}
		case "snip2SameRect": {
			let e = i * uo(r, "adj1", 16667);
			return lo([
				[e, 0],
				[t - e, 0],
				[t, e],
				[t, n],
				[0, n],
				[0, e]
			]);
		}
		case "round1Rect":
		case "round2SameRect": {
			let e = i * uo(r, "adj1", 16667) || i * uo(r, "adj", 16667);
			return `M${$(e)} 0 H${$(t - e)} A${$(e)} ${$(e)} 0 0 1 ${$(t)} ${$(e)} V${$(n)} H0 V${$(e)} A${$(e)} ${$(e)} 0 0 1 ${$(e)} 0 Z`;
		}
		case "can":
		case "flowChartMagneticDisk": {
			let e = i * uo(r, "adj", 25e3) / 2;
			return `M0 ${$(e)} A${$(t / 2)} ${$(e)} 0 0 1 ${$(t)} ${$(e)} V${$(n - e)} A${$(t / 2)} ${$(e)} 0 0 1 0 ${$(n - e)} Z M0 ${$(e)} A${$(t / 2)} ${$(e)} 0 0 0 ${$(t)} ${$(e)}`;
		}
		case "donut": {
			let e = i * uo(r, "adj", 25e3);
			return fo(t, n) + ` M${$(e)} ${$(n / 2)} A${$(t / 2 - e)} ${$(n / 2 - e)} 0 1 1 ${$(t - e)} ${$(n / 2)} A${$(t / 2 - e)} ${$(n / 2 - e)} 0 1 1 ${$(e)} ${$(n / 2)} Z`;
		}
		case "heart": return `M${$(t / 2)} ${$(n * .25)} C${$(t / 2)} 0 0 0 0 ${$(n * .3)} C0 ${$(n * .6)} ${$(t / 2)} ${$(n * .8)} ${$(t / 2)} ${$(n)} C${$(t / 2)} ${$(n * .8)} ${$(t)} ${$(n * .6)} ${$(t)} ${$(n * .3)} C${$(t)} 0 ${$(t / 2)} 0 ${$(t / 2)} ${$(n * .25)} Z`;
		case "wedgeRectCallout":
		case "wedgeRoundRectCallout": {
			let e = t / 2 + t * uo(r, "adj1", -20833), i = n / 2 + n * uo(r, "adj2", 62500);
			return lo([
				[0, 0],
				[t, 0],
				[t, n],
				[t * .58, n],
				[e, i],
				[t * .42, n],
				[0, n]
			]);
		}
		case "line":
		case "straightConnector1": return `M0 0 L${$(t)} ${$(n)}`;
		case "bentConnector2": return `M0 0 H${$(t)} V${$(n)}`;
		case "bentConnector3": return `M0 0 H${$(t * uo(r, "adj1", 5e4))} V${$(n)} H${$(t)}`;
		case "bentConnector4": return `M0 0 H${$(t / 2)} V${$(n)} H${$(t)}`;
		case "curvedConnector2":
		case "curvedConnector3":
		case "curvedConnector4": return `M0 0 C${$(t / 2)} 0 ${$(t / 2)} ${$(n)} ${$(t)} ${$(n)}`;
		default: return `M0 0 H${$(t)} V${$(n)} H0 Z`;
	}
}
// src/react/pptx/Slide.tsx
function vo(e) {
	let t = [];
	return e.rot && t.push(`rotate(${e.rot}deg)`), {
		left: e.x,
		top: e.y,
		width: e.w,
		height: e.h,
		transform: t.length ? t.join(" ") : void 0
	};
}
function yo(e, t, n) {
	let r = tt(e, t?.t === "img" ? t.target : void 0, n);
	if (t) switch (t.t) {
		case "solid": {
			let e = L(t.c);
			return e ? { background: e } : void 0;
		}
		case "grad": {
			let e = xe(t.css);
			return e ? { background: e } : void 0;
		}
		case "img": return r && r !== "unsupported" ? {
			backgroundImage: `url("${r}")`,
			backgroundSize: t.tile ? "auto" : "100% 100%",
			backgroundRepeat: t.tile ? "repeat" : "no-repeat"
		} : void 0;
		default: return;
	}
}
function bo(e) {
	let t = { fontSize: `${e.baseline ? e.sz * .65 : e.sz}pt` };
	e.b && (t.fontWeight = 700), e.i && (t.fontStyle = "italic");
	let n = [e.u ? "underline" : "", e.strike ? "line-through" : ""].filter(Boolean).join(" ");
	return n && (t.textDecoration = n), e.color && (t.color = L(e.color)), e.font && (t.fontFamily = e.font), e.baseline && (t.verticalAlign = e.baseline > 0 ? "super" : "sub"), e.caps && (t.textTransform = "uppercase"), e.hl && (t.background = L(e.hl)), t;
}
var xo = "Contains content that cannot be edited here; ask the agent";
function So({ text: t, flow: n, edit: r }) {
	let [i, a, o, s] = t.ins, c = {
		...n ? {
			position: "relative",
			inset: "auto",
			minHeight: "100%"
		} : {},
		padding: `${a}px ${o}px ${s}px ${i}px`,
		justifyContent: t.anchor === "ctr" ? "center" : t.anchor === "b" ? "flex-end" : "flex-start"
	};
	return t.vert && (c.writingMode = t.vert === "vert270" ? "sideways-lr" : "vertical-rl"), t.empty && !r ? /* @__PURE__ */ W("div", {
		className: "de-txt",
		style: c
	}) : /* @__PURE__ */ W("div", {
		ref: r?.root,
		className: (t.wrap ? "de-txt" : "de-txt de-nowrap") + (r ? " de-txt-edit" : ""),
		style: c,
		contentEditable: r ? !0 : void 0,
		suppressContentEditableWarning: !0,
		spellCheck: !r && void 0,
		children: t.paras.map((t, n) => {
			let i = {
				textAlign: t.algn,
				paddingLeft: t.marL || void 0,
				textIndent: t.indent || void 0,
				paddingTop: t.spcBef || void 0,
				paddingBottom: t.spcAft || void 0,
				lineHeight: t.lnPx ? `${t.lnPx}px` : t.lnPct ? +(t.lnPct * 1.2).toFixed(3) : 1.2
			};
			(!t.runs.length || t.runs.every((e) => !e.text && !e.br)) && (i.fontSize = `${t.endSz}pt`);
			let a = t.indent < 0 ? -t.indent : 0, o = 0, s = t.runs.map((t, n) => {
				let i = o;
				if (o += t.fld || t.br ? 1 : t.text.length, r) return t.fld ? /* @__PURE__ */ W("span", {
					"data-o": i,
					"data-obj": "",
					contentEditable: !1,
					style: bo(t),
					children: t.text
				}, n) : /* @__PURE__ */ W("span", {
					"data-o": i,
					style: bo(t),
					children: t.br ? "\n" : t.text
				}, n);
				let a = e(t.href);
				return t.br ? /* @__PURE__ */ W("br", {}, n) : a ? /* @__PURE__ */ W("a", {
					href: a,
					target: "_blank",
					rel: "noreferrer noopener",
					style: { color: "inherit" },
					children: /* @__PURE__ */ W("span", {
						style: bo(t),
						children: t.text
					})
				}, n) : /* @__PURE__ */ W("span", {
					style: bo(t),
					children: t.text
				}, n);
			}), c = o === 0;
			return /* @__PURE__ */ G("div", {
				style: i,
				"data-pa": r ? String(n) : void 0,
				"data-ro": t.ro ? t.roWhy ?? "" : void 0,
				title: t.ro ? xo : void 0,
				children: [
					t.bullet && !c && /* @__PURE__ */ W("span", {
						className: "de-bul",
						contentEditable: !r && void 0,
						style: {
							minWidth: a || void 0,
							paddingRight: a ? void 0 : "0.4em",
							fontSize: `${t.bullet.sz}pt`,
							color: L(t.bullet.color),
							fontFamily: t.bullet.font
						},
						children: t.bullet.text
					}),
					s,
					c && (r ? /* @__PURE__ */ W("span", {
						"data-o": 0,
						"data-empty": "",
						children: "​"
					}) : "​")
				]
			}, n);
		})
	});
}
function Co({ id: e, s: t }) {
	return /* @__PURE__ */ W("marker", {
		id: e,
		viewBox: "0 0 10 10",
		refX: "5",
		refY: "5",
		markerWidth: "4",
		markerHeight: "4",
		orient: "auto-start-reverse",
		children: /* @__PURE__ */ W("path", {
			d: "M0 0 L10 5 L0 10 Z",
			fill: L(t.c)
		})
	});
}
function wo({ el: e, client: t, live: n, editing: r }) {
	let i = ke().replace(/:/g, ""), { box: a } = e, o = go.has(e.geom), s = yo(t, e.fill, n), c = e.path ?? _o(e.geom, a.w, a.h, e.adj), l = a.flipH || a.flipV, u = l ? `translate(${a.flipH ? a.w : 0} ${a.flipV ? a.h : 0}) scale(${a.flipH ? -1 : 1} ${a.flipV ? -1 : 1})` : void 0, d = !o && !e.path && (e.geom === "rect" || e.geom === "flowChartProcess"), f = !o && e.fill?.t === "solid" ? L(e.fill.c) : void 0, p = !o && s && e.fill?.t !== "solid" ? s : void 0, m = e.stroke, h = Math.max(a.w, 1), g = Math.max(a.h, 1);
	return /* @__PURE__ */ G("div", {
		className: "de-el",
		style: vo(a),
		"data-sid": e.id ?? e.sid,
		"data-text": e.sid !== void 0 && e.text ? "" : void 0,
		"data-top": e.top,
		children: [d && !m && (f || p) ? /* @__PURE__ */ W("div", { style: {
			position: "absolute",
			inset: 0,
			...p ?? { background: f }
		} }) : /* @__PURE__ */ G(U, { children: [p && /* @__PURE__ */ W("div", { style: {
			position: "absolute",
			inset: 0,
			...p,
			clipPath: d || !/^[\sA-Za-z0-9.,+-]*$/.test(c) ? void 0 : `path("${c}")`,
			transform: l ? `scale(${a.flipH ? -1 : 1}, ${a.flipV ? -1 : 1})` : void 0
		} }), (f || m) && /* @__PURE__ */ G("svg", {
			width: h,
			height: g,
			viewBox: `0 0 ${h} ${g}`,
			style: {
				position: "absolute",
				left: 0,
				top: 0,
				overflow: "visible"
			},
			children: [m && (m.head || m.tail) && /* @__PURE__ */ G("defs", { children: [m.head && /* @__PURE__ */ W(Co, {
				id: `h${i}`,
				s: m
			}), m.tail && /* @__PURE__ */ W(Co, {
				id: `t${i}`,
				s: m
			})] }), /* @__PURE__ */ W("path", {
				d: c,
				transform: u,
				fill: f ?? "none",
				fillRule: "evenodd",
				stroke: L(m?.c) ?? "none",
				strokeWidth: m?.w,
				strokeDasharray: m?.dash,
				strokeLinejoin: "round",
				markerStart: m?.head ? `url(#h${i})` : void 0,
				markerEnd: m?.tail ? `url(#t${i})` : void 0
			})]
		})] }), r && r.sid === e.sid ? /* @__PURE__ */ W(So, {
			text: r.text,
			edit: r.edit
		}) : e.text && /* @__PURE__ */ W(So, { text: e.text })]
	});
}
function To({ el: e, client: t, live: n }) {
	let r = tt(t, e.target, n), { box: i } = e, a = {
		...vo(i),
		overflow: "hidden"
	}, o = e.top;
	e.geom === "ellipse" ? a.borderRadius = "50%" : e.geom === "roundRect" && (a.borderRadius = Math.min(i.w, i.h) * .1667), e.stroke && (a.outline = `${e.stroke.w}px solid ${L(e.stroke.c) ?? "transparent"}`);
	let s = {
		position: "absolute",
		left: 0,
		top: 0,
		width: "100%",
		height: "100%"
	};
	if (e.crop) {
		let [t, n, r, a] = e.crop, o = i.w / Math.max(.01, 1 - t - r), c = i.h / Math.max(.01, 1 - n - a);
		s = {
			position: "absolute",
			left: -t * o,
			top: -n * c,
			width: o,
			height: c
		};
	}
	let c = i.flipH || i.flipV ? `scale(${i.flipH ? -1 : 1}, ${i.flipV ? -1 : 1})` : void 0;
	return c && (s.transform = c), /* @__PURE__ */ G("div", {
		className: "de-el",
		style: a,
		"data-sid": e.id,
		"data-top": o,
		children: [r && r !== "unsupported" ? /* @__PURE__ */ W("img", {
			src: r,
			alt: "",
			style: s,
			draggable: !1
		}) : r === "unsupported" ? /* @__PURE__ */ G("div", {
			className: "de-ph",
			style: {
				width: "100%",
				height: "100%"
			},
			children: [e.target?.split(".").pop()?.toUpperCase(), " image"]
		}) : null, e.video && /* @__PURE__ */ W("div", {
			className: "de-ph",
			style: {
				position: "absolute",
				right: 8,
				bottom: 8,
				padding: "2px 6px",
				border: 0,
				background: "rgba(0,0,0,.6)",
				color: "#fff"
			},
			children: "▶ media"
		})]
	});
}
var Eo = (e) => e ? `${Math.max(1, e.w)}px solid ${L(e.c) ?? "transparent"}` : void 0;
function Do({ cell: e, client: t, live: n, h: r, r: i, c: a }) {
	let o = yo(t, e.fill, n);
	return /* @__PURE__ */ W("td", {
		"data-r": i,
		"data-c": a,
		colSpan: e.colSpan > 1 ? e.colSpan : void 0,
		rowSpan: e.rowSpan > 1 ? e.rowSpan : void 0,
		style: {
			...o ?? {},
			borderLeft: Eo(e.bl),
			borderRight: Eo(e.br),
			borderTop: Eo(e.bt),
			borderBottom: Eo(e.bb),
			height: r
		},
		children: e.text && /* @__PURE__ */ W(So, {
			text: e.text,
			flow: !0
		})
	});
}
function Oo({ el: e, client: t, live: n }) {
	return /* @__PURE__ */ W("div", {
		className: "de-el",
		style: {
			...vo(e.box),
			height: "auto"
		},
		"data-sid": e.id,
		"data-top": e.top,
		children: /* @__PURE__ */ G("table", {
			className: "de-stbl",
			children: [/* @__PURE__ */ W("colgroup", { children: e.cols.map((e, t) => /* @__PURE__ */ W("col", { style: { width: e } }, t)) }), /* @__PURE__ */ W("tbody", { children: e.rows.map((e, r) => /* @__PURE__ */ W("tr", { children: e.cells.map((i, a) => i.hidden ? null : /* @__PURE__ */ W(Do, {
				cell: i,
				client: t,
				live: n,
				h: e.h,
				r,
				c: a
			}, a)) }, r)) })]
		})
	});
}
function ko({ el: e, client: t, live: n, editing: r }) {
	switch (e.t) {
		case "shape": return /* @__PURE__ */ W(wo, {
			el: e,
			client: t,
			live: n,
			editing: r
		});
		case "pic": return /* @__PURE__ */ W(To, {
			el: e,
			client: t,
			live: n
		});
		case "table": return /* @__PURE__ */ W(Oo, {
			el: e,
			client: t,
			live: n
		});
		case "placeholder": return /* @__PURE__ */ W("div", {
			className: "de-el de-ph",
			style: {
				...vo(e.box),
				display: "flex"
			},
			"data-sid": e.id,
			"data-top": e.top,
			children: e.label
		});
	}
}
var Ao = R(function({ model: e, client: t, scale: n, live: r = !0, editing: i, overlay: a }) {
	let o = yo(t, e.bg, r);
	return /* @__PURE__ */ W("div", {
		className: e.hidden ? "de-slide de-hidden-slide" : "de-slide",
		style: {
			width: e.w * n,
			height: e.h * n
		},
		children: /* @__PURE__ */ G("div", {
			className: "de-slide-inner",
			style: {
				width: e.w,
				height: e.h,
				transform: `scale(${n})`,
				background: "#fff",
				...o ?? {}
			},
			children: [e.els.map((e, n) => /* @__PURE__ */ W(ko, {
				el: e,
				client: t,
				live: r,
				editing: i
			}, n)), a]
		})
	});
}), jo = (e) => e ? e.paras.map((e) => e.runs.map((e) => e.br ? "\n" : e.text).join("")).join("\n") : "";
function Mo(e, t) {
	return !e || t === void 0 ? "" : e.els.filter((e) => e.top === t).map((e) => e.t === "shape" ? jo(e.text) : "").filter(Boolean).join("\n");
}
var No = (e, t) => t === void 0 ? void 0 : e?.els.find((e) => e.id === t || e.top === t), Po = {
	xfrm: "shape.transform",
	delete: "shape.delete",
	fill: "shape.fill",
	line: "shape.line",
	order: "shape.order",
	duplicate: "shape.duplicate",
	anchor: "shape.anchor",
	bg: "slide.background",
	insert: "shape.insert"
};
function Fo(e, t, n, r = e.model(t)) {
	let i = { slideIndex: t }, a = e.slideId(t);
	if (a !== void 0 && (i.slideId = a), n !== void 0) {
		i.shapeId = n;
		let e = No(r, n);
		e?.name && (i.shapeName = e.name);
		let t = e?.t === "shape" ? e.text?.paras.find((e) => e.ro) : void 0;
		t && (i.protected = !0, t.roWhy && (i.protectedReason = t.roWhy));
	}
	return i;
}
function Io(e, t, n, r, i) {
	let a = Math.max(-1, ...i.els.map((e) => e.top ?? -1));
	return n.map((n) => {
		let o = n.op === "bg" ? void 0 : n.op === "insert" || n.op === "duplicate" ? a >= 0 ? a : void 0 : n.op === "anchor" ? n.sid : n.top;
		return {
			format: "pptx",
			kind: Po[n.op],
			before: n.op === "delete" ? Mo(r, n.top) : "",
			after: n.op === "insert" ? n.text ?? "" : "",
			location: Fo(e, t, o, n.op === "delete" ? r : i),
			detail: { op: n }
		};
	});
}
function Lo(e, t) {
	let n = t.op === "add" ? t.after + 1 : t.op === "move" ? t.to : t.index;
	return {
		format: "pptx",
		kind: `slide.${t.op}`,
		before: "",
		after: "",
		location: Fo(e, n, void 0, void 0),
		detail: { op: t }
	};
}
// src/react/pptx/host.ts
var Ro = (e) => "slideIndex" in e;
function zo(e) {
	let t = (t) => e.slides()?.querySelector(`.de-slide-frame[data-slide="${t + 1}"]`) ?? null, n = (e, t) => e.querySelector(`[data-sid="${t}"]`), r = async (n) => n < 0 || n >= e.count ? null : (e.go(n), await Hi(() => !!t(n), 2e3), await Vi(1), t(n)), i = () => {
		let t = e.scroll(), n = e.slides();
		if (!t || !n) return e.current();
		let r = t.getBoundingClientRect(), i = -1;
		for (let e of Array.from(n.querySelectorAll(".de-slide-frame"))) e.getBoundingClientRect().top <= r.top + r.height / 3 + .5 && (i = Math.max(i, Number(e.dataset.slide) - 1));
		return i >= 0 ? i : e.current();
	};
	return {
		async flush() {
			let t = e.textRoot();
			t && e.editor.input.isComposing && (Gi(t)?.blur?.(), await Hi(() => !e.editor.input.isComposing, 500)), await e.editor.flush(), await e.ops();
		},
		getViewState() {
			return {
				format: "pptx",
				slideIndex: i(),
				zoom: e.zoom()
			};
		},
		async setViewState(t) {
			if (t.format !== "pptx") return !1;
			t.zoom !== e.zoom() && (e.setZoom(t.zoom), await Vi(3));
			let n = Math.max(0, Math.min(e.count - 1, t.slideIndex));
			for (let r = 0; r < 5; r++) if (e.go(n), await Vi(2), i() === n) return n === t.slideIndex;
			return !1;
		},
		hitTest(t, n) {
			let r = e.slides(), i = e.scroll();
			if (!r || !i) return null;
			let a = i.getBoundingClientRect();
			if (t < a.left || t > a.right || n < a.top || n > a.bottom) return null;
			let o = Wi(r).elementsFromPoint(t, n).filter((e) => r.contains(e)), s = Array.from(r.querySelectorAll(".de-slide-frame")), c = (e) => n < e.top ? e.top - n : n > e.bottom ? n - e.bottom : 0, l = o.find((e) => e.matches(".de-slide-frame")), u = l ?? s.sort((e, t) => c(e.getBoundingClientRect()) - c(t.getBoundingClientRect()))[0];
			if (!u) return null;
			let d = Number(u.dataset.slide) - 1, f = (e, t, n, r) => ({
				format: "pptx",
				kind: e,
				location: t,
				...r === void 0 ? {} : { quote: vi(r) },
				rect: n
			});
			if (!l) return f("region", Fo(e, d), u.getBoundingClientRect());
			let p = o.find((e) => e.matches("[data-sid]") && e.closest(".de-slide-frame") === u);
			if (!p) return f("slide", Fo(e, d), (u.querySelector(".de-slide") ?? u).getBoundingClientRect());
			let m = Fo(e, d, Number(p.dataset.sid)), h = o.find((e) => e.tagName === "TD" && p.contains(e));
			if (h) return f("cell", {
				...m,
				cell: {
					row: Number(h.dataset.r),
					col: Number(h.dataset.c)
				}
			}, h.getBoundingClientRect(), h.textContent ?? "");
			if (p.querySelector(".de-stbl")) return f("table", m, p.getBoundingClientRect());
			if (p.querySelector("img")) return f("image", m, p.getBoundingClientRect());
			let g = Ji(Wi(r), t, n);
			if (g && p.contains(g.node) && Yi(g.node, t, n)) {
				let e = g.node.parentElement?.closest(".de-txt > div") ?? g.node.parentElement;
				return f("text", m, p.getBoundingClientRect(), e.textContent?.replace(/​/g, "") ?? "");
			}
			return f("shape", m, p.getBoundingClientRect());
		},
		rectsFor(e) {
			if (!Ro(e)) return [];
			let r = t(e.slideIndex);
			if (!r) return [];
			if (e.shapeId === void 0) return [(r.querySelector(".de-slide") ?? r).getBoundingClientRect()];
			let i = n(r, e.shapeId);
			if (!i) return [];
			if (e.cell) {
				let t = i.querySelector(`td[data-r="${e.cell.row}"][data-c="${e.cell.col}"]`);
				return t ? [t.getBoundingClientRect()] : [];
			}
			return Ui([i.getBoundingClientRect()]);
		},
		async scrollTo(e) {
			if (!Ro(e)) return !1;
			let t = await r(e.slideIndex);
			return t ? e.shapeId === void 0 || !!n(t, e.shapeId) : !1;
		},
		selection() {
			let t = e.textRoot(), n = t ? ve(t) : null;
			if (e.editor.active && t && n && n.rangeCount && n.anchorNode && n.focusNode && t.contains(n.anchorNode) && t.contains(n.focusNode)) {
				let r = P(t, n.anchorNode, n.anchorOffset), i = P(t, n.focusNode, n.focusOffset);
				if (r && i) {
					let [t, n] = Number(r.pa) < Number(i.pa) || r.pa === i.pa && r.o <= i.o ? [r, i] : [i, r], a = e.editor.paras.map((e) => e.runs.map((e) => e.t === "text" ? e.text ?? "" : "￼").join("")), o = t.pa === n.pa, s = a[Number(t.pa)] ?? "", c = o ? s.slice(t.o, n.o) : [
						s.slice(t.o),
						...a.slice(Number(t.pa) + 1, Number(n.pa)),
						(a[Number(n.pa)] ?? "").slice(0, n.o)
					].join("\n"), l = bi(s, t.o, o ? n.o : s.length);
					return {
						format: "pptx",
						kind: "text",
						location: Fo(e, e.editor.slide, e.editor.sid),
						quote: vi(c),
						prefix: l.prefix,
						suffix: o ? l.suffix : "",
						collapsed: o && t.o === n.o
					};
				}
			}
			let r = e.selected();
			if (!r) return null;
			let i = e.model(r.slide), a = i ? i.els.filter((e) => e.top === r.top).map((e) => e.t === "shape" ? jo(e.text) : "").filter(Boolean).join("\n") : "", o = No(i, r.top)?.id ?? r.top;
			return {
				format: "pptx",
				kind: "shape",
				location: Fo(e, r.slide, o),
				quote: vi(a),
				prefix: "",
				suffix: "",
				collapsed: !1
			};
		}
	};
}
// src/react/pptx/PptxView.tsx
var Bo = /* @__PURE__ */ new WeakMap();
function Vo(e) {
	let t = Bo.get(e);
	return t || Bo.set(e, t = {
		models: /* @__PURE__ */ new Map(),
		pending: /* @__PURE__ */ new Map(),
		listeners: /* @__PURE__ */ new Map()
	}), t;
}
function Ho(e, t, n) {
	let r = Vo(e);
	r.models.set(t, n);
	for (let e of r.listeners.get(t) ?? []) e(n);
}
function Uo(e) {
	let t = Vo(e);
	t.models.clear(), t.pending.clear();
}
function Wo(e, t) {
	let n = Vo(e), [r, i] = H(() => n.models.get(t));
	return B(() => {
		let e = n.listeners.get(t);
		e || n.listeners.set(t, e = /* @__PURE__ */ new Set());
		let r = (e) => i(e);
		return e.add(r), () => {
			e.delete(r);
		};
	}, [n, t]), B(() => {
		let r = n.models.get(t);
		if (r) return i(r);
		let a = !0, o = n.pending.get(t);
		return o || (o = e.call("pptx.slide", t), n.pending.set(t, o), o.then((e) => {
			n.models.set(t, e), n.pending.delete(t), n.models.size > 120 && n.models.delete(n.models.keys().next().value);
		}, () => n.pending.delete(t))), o.then((e) => a && i(e), (e) => a && i({ error: e.message })), () => {
			a = !1;
		};
	}, [
		e,
		n,
		t
	]), r;
}
function Go(e) {
	let { client: t, index: n, meta: r, scale: i, live: a, editing: o, overlay: s } = e, c = Wo(t, n);
	return c ? "error" in c ? /* @__PURE__ */ W("div", {
		className: "de-slide de-ph",
		style: {
			width: r.w * i,
			height: r.h * i,
			display: "flex"
		},
		children: c.error
	}) : /* @__PURE__ */ W(Ao, {
		model: c,
		client: t,
		scale: i,
		live: a,
		editing: o,
		overlay: s
	}) : /* @__PURE__ */ W("div", {
		className: "de-slide",
		style: {
			width: r.w * i,
			height: r.h * i,
			background: "#fff"
		}
	});
}
var Ko = [
	"nw",
	"n",
	"ne",
	"e",
	"se",
	"s",
	"sw",
	"w"
];
function qo(e, t) {
	let n = e?.els.filter((e) => e.top === t) ?? [];
	if (!n.length) return;
	let r = Math.min(...n.map((e) => e.box.x)), i = Math.min(...n.map((e) => e.box.y)), a = Math.max(...n.map((e) => e.box.x + e.box.w)), o = Math.max(...n.map((e) => e.box.y + e.box.h));
	return {
		x: r,
		y: i,
		w: a - r,
		h: o - i,
		rot: n.length === 1 ? n[0].box.rot : void 0
	};
}
function Jo(e, t, n, r, i) {
	if (t === "move") return {
		...e,
		x: e.x + n,
		y: e.y + r
	};
	let { x: a, y: o, w: s, h: c } = e;
	if (t.includes("e") && (s += n), t.includes("s") && (c += r), t.includes("w") && (a += n, s -= n), t.includes("n") && (o += r, c -= r), i && t.length === 2 && e.w && e.h) {
		let n = Math.max(s / e.w, c / e.h), r = e.w * n, i = e.h * n;
		t.includes("w") && (a = e.x + e.w - r), t.includes("n") && (o = e.y + e.h - i), s = r, c = i;
	}
	return {
		...e,
		x: a,
		y: o,
		w: Math.max(4, s),
		h: Math.max(4, c)
	};
}
function Yo({ box: e, scale: t, onHandle: n }) {
	let r = 9 / t, i = {
		nw: [0, 0],
		n: [.5, 0],
		ne: [1, 0],
		e: [1, .5],
		se: [1, 1],
		s: [.5, 1],
		sw: [0, 1],
		w: [0, .5],
		move: [0, 0]
	};
	return /* @__PURE__ */ W("div", {
		className: "de-shape-sel",
		style: {
			left: e.x,
			top: e.y,
			width: e.w,
			height: e.h,
			borderWidth: 1.5 / t,
			transform: e.rot ? `rotate(${e.rot}deg)` : void 0
		},
		children: Ko.map((a) => /* @__PURE__ */ W("div", {
			className: `de-handle de-h-${a}`,
			style: {
				width: r,
				height: r,
				left: i[a][0] * e.w - r / 2,
				top: i[a][1] * e.h - r / 2,
				borderWidth: 1 / t
			},
			onMouseDown: (e) => {
				e.stopPropagation(), e.preventDefault(), n(a, e);
			}
		}, a))
	});
}
var Xo = 24, Zo = 24;
function Qo({ client: e, onStatus: t, initialZoom: n = "fit", thumbnails: r = !0 }) {
	let i = Ft(), a = e.info.pptx;
	It({
		printable: async () => {
			let t = e.info.pptx, n = await Promise.all(t.slides.map((t) => e.call("pptx.slide", t.index))), r = n.filter((e) => !e.hidden), i = r.length ? r : n;
			return {
				size: `${t.w}px ${t.h}px`,
				margin: "0",
				node: i.map((n) => /* @__PURE__ */ W("div", {
					className: "de-print-page",
					style: {
						width: t.w,
						height: t.h
					},
					children: /* @__PURE__ */ W(Ao, {
						model: {
							...n,
							hidden: !1
						},
						client: e,
						scale: 1
					})
				}, n.index))
			};
		},
		text: async () => {
			let t = e.info.pptx;
			return qr(await Promise.all(t.slides.map((t) => e.call("pptx.slide", t.index))));
		},
		stats: () => {
			let t = e.info.pptx;
			return [["Slides", t.count.toLocaleString()], ["Slide size", `${+(t.w / 96).toFixed(2)} × ${+(t.h / 96).toFixed(2)} in`]];
		}
	});
	let [o, s] = $e(), [c, l] = $e(), u = et(c), f = V(null), p = et(f), [m, h] = H(n), g = r && s.w >= 720 && a.count > 1, [, _] = Qe(), v = Me(() => new eo(e), [e]), y = Li(e), b = {
		slideId: (e) => a.slides[e]?.id,
		model: (t) => Vo(e).models.get(t)
	}, x = V(b);
	x.current = b;
	let S = V(Promise.resolve()), C = (e) => (S.current = Promise.all([S.current, e.catch(() => {})]), e), w = V(null), T = V(null), ee = V(null), [E, D] = H(null), [O, te] = H(null), [ne, re] = H(0), [ie, k] = H(null), [oe, se] = H(null), [ce, le] = H(0), [ue, de] = H(null), fe = l.w ? (l.w - 48) / a.w : 1, pe = l.h ? (l.h - 48) / a.h : 1, me = Math.max(.1, Math.min(fe, Math.max(pe, fe * .6), 2)), he = m === "fit" ? me : m, ge = a.h * he, _e = a.w * he, j = ge + Zo, M = 48 + a.count * j - Zo, N = Math.max(l.w, _e + 48), P = Math.max(Xo, (N - _e) / 2), F = Math.max(0, Math.floor((u.y - Xo) / j) - 1), ye = Math.min(a.count - 1, Math.floor((u.y + l.h) / j) + 1), I = Math.min(a.count - 1, Math.max(0, Math.floor((u.y + l.h / 3 - Xo) / j))), be = 142 / a.w, xe = a.h * be, Se = xe + 14, Ce = Math.max(0, Math.floor(p.y / Se) - 1), L = Math.min(a.count - 1, Math.floor((p.y + l.h) / Se) + 1);
	B(() => {
		let e = f.current;
		if (!e) return;
		let t = 10 + I * Se;
		(t < e.scrollTop || t + xe > e.scrollTop + e.clientHeight) && (e.scrollTop = t - e.clientHeight / 2 + xe / 2);
	}, [
		I,
		Se,
		xe
	]), B(() => {
		v.onChange = _, v.onDirty = () => i.setDirty(!0), v.onCommitted = (t, n) => Ho(e, t, n), v.onEdited = (e) => {
			y.listening && y.emitEdit({
				format: "pptx",
				kind: e.before === e.after ? "format" : "text",
				before: e.before,
				after: e.after,
				location: Fo(x.current, e.slide, e.sid)
			});
		}, v.shortcut = (e) => (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s" ? (i.save(), !0) : e.key === "Escape" && (we(), !0);
	}), B(() => (i.editable || we(), () => v.end()), [i.editable]), B(() => void it(c.current), []), Lt(() => {
		let e = v.active ? T.current : ee.current;
		e && ve(e)?.selectAllChildren(e);
	});
	let we = () => {
		v.active && (v.end(), T.current && ve(T.current)?.removeAllRanges(), c.current?.focus({ preventScroll: !0 }), _());
	}, Te = V(we);
	Te.current = we, B(() => A(e, "pptx", { endEditing: () => Te.current() }), [e]), B(() => e.on("collab:pptx", (t) => {
		t.meta ? (Uo(e), D(null), re((e) => e + 1)) : t.slide !== void 0 && t.model && Ho(e, t.slide, t.model);
	}), [e]), B(() => ae(e, {
		slide: E?.slide ?? I,
		top: E?.top
	}), [
		e,
		E?.slide,
		E?.top,
		I
	]);
	let Ee = v.active && v.text() ? {
		sid: v.sid,
		text: v.text(),
		edit: { root: (e) => {
			T.current = e, e && v.input.attach(e);
		} }
	} : void 0;
	Ye(() => {
		let e = T.current;
		if (!v.active || !e) return;
		if (w.current) {
			let { x: t, y: n } = w.current;
			w.current = null, e.focus({ preventScroll: !0 });
			let r = e.ownerDocument, i = r.caretPositionFromPoint?.(t, n), a = i ? null : r.caretRangeFromPoint?.(t, n), o = i?.offsetNode ?? a?.startContainer, s = i?.offset ?? a?.startOffset ?? 0, c = ve(e);
			o && e.contains(o) ? c?.collapse(o, s) : (c?.selectAllChildren(e), c?.collapseToEnd()), v.input.lastSel = v.input.readSel();
			return;
		}
		let t = v.pendingSel;
		t && (v.pendingSel = null, v.input.restore(t));
	});
	let De = (t) => Vo(e).models.get(t), R = (e, t, n, r) => {
		let i = De(e)?.els.find((e) => e.t === "shape" && e.sid === t);
		if (i && i.t === "shape" && i.text) {
			if (i.text.paras.some((e) => e.ro)) return de(xo);
			v.begin(e, t, i.text), w.current = {
				x: n,
				y: r
			}, _();
		}
	}, Oe = (e, t) => {
		if (!i.editable || t.button !== 0) return;
		let n = t.target;
		if (v.active && T.current?.contains(n)) return;
		let r = n.closest("[data-top]"), a = r ? Number(r.dataset.top) : NaN;
		if (we(), !r || Number.isNaN(a)) {
			D(null);
			return;
		}
		t.preventDefault(), c.current?.focus({ preventScroll: !0 });
		let o = qo(De(e), a);
		if (D({
			slide: e,
			top: a
		}), !o) return;
		let s = n.closest("[data-text]");
		te({
			slide: e,
			top: a,
			mode: "move",
			sx: t.clientX,
			sy: t.clientY,
			box: o,
			cur: o,
			moved: !1,
			sid: s ? Number(s.dataset.sid) : void 0,
			px: t.clientX,
			py: t.clientY
		});
	}, z = (e, t, n = !1) => C(ke(e, t, n)), ke = async (t, n, r = !1) => {
		try {
			let a = De(t), o = await e.call("pptx.shapes", t, n);
			if (Ho(e, t, o), y.listening) for (let e of Io(x.current, t, n, a, o)) y.emitEdit(e);
			if (i.setDirty(!0), le((e) => e + 1), r) {
				let e = o.els.map((e) => e.top ?? -1);
				D({
					slide: t,
					top: Math.max(...e)
				});
			}
			return o;
		} catch (e) {
			console.error("[office-engine]", e);
		}
	};
	B(() => {
		if (!O) return;
		let e = (e) => {
			let t = (e.clientX - O.sx) / he, n = (e.clientY - O.sy) / he, r = O.moved || Math.abs(e.clientX - O.sx) + Math.abs(e.clientY - O.sy) > 3;
			te({
				...O,
				moved: r,
				cur: r ? Jo(O.box, O.mode, t, n, e.shiftKey) : O.box
			});
		}, t = () => {
			let e = O;
			te(null), e.moved ? z(e.slide, [{
				op: "xfrm",
				top: e.top,
				box: e.cur
			}]) : e.mode === "move" && e.sid !== void 0 && R(e.slide, e.sid, e.px, e.py);
		};
		return window.addEventListener("mousemove", e), window.addEventListener("mouseup", t, { once: !0 }), () => {
			window.removeEventListener("mousemove", e), window.removeEventListener("mouseup", t);
		};
	});
	let Ae = async (t, n) => {
		let r = n ?? E?.slide ?? I, i = t === "text" ? a.w * .4 : t === "line" ? a.w * .25 : a.w * .2, o = t === "text" ? a.h * .1 : t === "line" ? 1 : a.w * .2, s = {
			x: (a.w - i) / 2,
			y: (a.h - o) / 2,
			w: i,
			h: o
		}, l;
		if (t === "image") {
			let [t] = await Nt("image/*", !1);
			if (!t) return;
			l = await e.call("pptx.image", r, await t.arrayBuffer(), (t.type.split("/")[1] ?? "png").replace("svg+xml", "svg"));
			let n = await new Promise((e) => {
				let n = new Image();
				n.onload = () => e({
					w: n.naturalWidth,
					h: n.naturalHeight
				}), n.onerror = () => e({
					w: 400,
					h: 300
				}), n.src = URL.createObjectURL(t);
			}), i = Math.min(1, a.w * .6 / n.w, a.h * .6 / n.h);
			s = {
				x: (a.w - n.w * i) / 2,
				y: (a.h - n.h * i) / 2,
				w: n.w * i,
				h: n.h * i
			};
		}
		let u = await z(r, [{
			op: "insert",
			kind: t,
			box: s,
			rid: l,
			text: t === "text" ? "Text" : void 0
		}], !0);
		if (c.current?.focus({ preventScroll: !0 }), u && t === "text") {
			let e = u.els[u.els.length - 1];
			e?.t === "shape" && e.sid !== void 0 && e.text && (v.begin(r, e.sid, e.text), _());
		}
	}, je = (e, t) => C(Ne(e, t)), Ne = async (t, n) => {
		we(), D(null);
		let r = await e.call("pptx.slides", t);
		Object.assign(a, r), y.listening && y.emitEdit(Lo(x.current, t)), Uo(e), i.setDirty(!0), re((e) => e + 1), n !== void 0 && requestAnimationFrame(() => K(n));
	}, Pe = (e) => C(Fe(e)), Fe = async (t) => {
		let n = await e.call("pptx.undo", t);
		n && (Ho(e, n.index, n.model), y.listening && y.emitEdit({
			format: "pptx",
			kind: t ? "redo" : "undo",
			before: "",
			after: "",
			location: Fo(x.current, n.index)
		}), le((e) => Math.max(0, e + (t ? 1 : -1))), D(null), K(n.index));
	}, U = (e, t = I) => {
		e === "add" ? je({
			op: "add",
			after: t
		}, t + 1) : e === "duplicate" ? je({
			op: "duplicate",
			index: t
		}, t + 1) : e === "delete" ? je({
			op: "delete",
			index: t
		}, Math.max(0, t - 1)) : e === "up" ? t > 0 && je({
			op: "move",
			from: t,
			to: t - 1
		}, t - 1) : e === "down" ? t < a.count - 1 && je({
			op: "move",
			from: t,
			to: t + 1
		}, t + 1) : e === "hide" && je({
			op: "hide",
			index: t,
			hidden: !De(t)?.hidden
		}, t);
	}, Ie = (e) => e ? De(e.slide)?.els.find((t) => t.top === e.top) : void 0, Le = V(E);
	Le.current = E;
	let Re = {
		arrange: (e) => {
			let t = Le.current;
			t && z(t.slide, [{
				op: "order",
				top: t.top,
				to: e
			}]);
		},
		duplicate: () => {
			let e = Le.current;
			e && z(e.slide, [{
				op: "duplicate",
				top: e.top
			}], !0);
		},
		remove: () => {
			let e = Le.current;
			e && z(e.slide, [{
				op: "delete",
				top: e.top
			}]), D(null);
		},
		rotate: (e) => {
			let t = Le.current, n = Ie(t), r = t && qo(De(t.slide), t.top);
			if (!t || !r) return;
			let i = {
				...r,
				flipH: n?.box.flipH,
				flipV: n?.box.flipV
			};
			e === "cw" ? i.rot = (i.rot ?? 0) + 90 : e === "ccw" ? i.rot = (i.rot ?? 0) - 90 : e === "flipH" ? i.flipH = !i.flipH : i.flipV = !i.flipV, z(t.slide, [{
				op: "xfrm",
				top: t.top,
				box: i
			}]);
		},
		align: (e) => {
			let t = Le.current, n = t && qo(De(t.slide), t.top);
			if (!t || !n) return;
			let r = { ...n }, i = (n.rot ?? 0) * Math.PI / 180, o = Math.abs(n.w * Math.cos(i)) + Math.abs(n.h * Math.sin(i)), s = Math.abs(n.w * Math.sin(i)) + Math.abs(n.h * Math.cos(i)), c = (o - n.w) / 2, l = (s - n.h) / 2;
			e === "left" ? r.x = c : e === "center" || e === "both" ? r.x = (a.w - r.w) / 2 : e === "right" ? r.x = a.w - r.w - c : e === "top" ? r.y = l : e === "middle" ? r.y = (a.h - r.h) / 2 : e === "bottom" && (r.y = a.h - r.h - l), e === "both" && (r.y = (a.h - r.h) / 2), z(t.slide, [{
				op: "xfrm",
				top: t.top,
				box: r
			}]);
		},
		anchor: (e) => {
			if (v.active && v.body) {
				v.body = {
					...v.body,
					anchor: e
				}, z(v.slide, [{
					op: "anchor",
					sid: v.sid,
					anchor: e
				}]), _();
				return;
			}
			let t = Le.current, n = Ie(t);
			t && n?.t === "shape" && n.sid !== void 0 && z(t.slide, [{
				op: "anchor",
				sid: n.sid,
				anchor: e
			}]);
		}
	}, ze = () => [
		...He?.canComment ? [{
			label: "Comment",
			icon: "commentAdd",
			hint: Yn,
			run: () => He.start()
		}] : [],
		{
			label: "Duplicate",
			icon: "copy",
			hint: `${Q}D`,
			run: Re.duplicate,
			sep: !!He?.canComment
		},
		{
			label: "Delete",
			icon: "trash",
			hint: "Del",
			run: Re.remove
		},
		{
			label: "Bring to front",
			icon: "front",
			hint: `${Q}⇧↑`,
			sep: !0,
			run: () => Re.arrange("front")
		},
		{
			label: "Bring forward",
			hint: `${Q}↑`,
			run: () => Re.arrange("forward")
		},
		{
			label: "Send backward",
			hint: `${Q}↓`,
			run: () => Re.arrange("backward")
		},
		{
			label: "Send to back",
			icon: "back",
			hint: `${Q}⇧↓`,
			run: () => Re.arrange("back")
		},
		{
			label: "Rotate 90° clockwise",
			icon: "rotate",
			sep: !0,
			run: () => Re.rotate("cw")
		},
		{
			label: "Rotate 90° counter-clockwise",
			icon: "rotateCcw",
			run: () => Re.rotate("ccw")
		},
		{
			label: "Flip horizontally",
			icon: "flipH",
			run: () => Re.rotate("flipH")
		},
		{
			label: "Flip vertically",
			icon: "flipV",
			run: () => Re.rotate("flipV")
		},
		{
			label: "Center on slide",
			icon: "alignObj",
			sep: !0,
			run: () => Re.align("both")
		}
	], Be = (e, t) => [
		...He?.canComment ? [{
			label: "Comment",
			icon: "commentAdd",
			hint: Yn,
			run: () => He.start(t && We(e, t.x, t.y) || void 0)
		}] : [],
		{
			label: "New slide",
			icon: "slideAdd",
			hint: `${Q}M`,
			run: () => U("add", e),
			sep: !!He?.canComment
		},
		{
			label: "Duplicate slide",
			icon: "copy",
			run: () => U("duplicate", e)
		},
		{
			label: "Delete slide",
			icon: "trash",
			run: () => U("delete", e),
			disabled: a.count <= 1
		},
		{
			label: De(e)?.hidden ? "Show slide" : "Hide slide",
			icon: "hide",
			run: () => U("hide", e)
		},
		{
			label: "Move slide up",
			icon: "up",
			sep: !0,
			run: () => U("up", e),
			disabled: e === 0
		},
		{
			label: "Move slide down",
			icon: "down",
			run: () => U("down", e),
			disabled: e >= a.count - 1
		},
		{
			label: "Insert text box",
			icon: "textbox",
			sep: !0,
			run: () => void Ae("text", e)
		},
		{
			label: "Insert image…",
			icon: "image",
			run: () => void Ae("image", e)
		},
		{
			label: "Present from this slide",
			icon: "play",
			sep: !0,
			run: () => k(e)
		}
	], Ve = (e) => {
		if (!E || v.active || !i.editable) return !1;
		let t = qo(De(E.slide), E.top), n = e.shiftKey ? 10 : 1, r = {
			ArrowUp: [0, -n],
			ArrowDown: [0, n],
			ArrowLeft: [-n, 0],
			ArrowRight: [n, 0]
		}, a = e.metaKey || e.ctrlKey;
		if (a && e.key.toLowerCase() === "d") Re.duplicate();
		else if (a && (e.key === "ArrowUp" || e.key === "ArrowDown")) Re.arrange(e.key === "ArrowUp" ? e.shiftKey ? "front" : "forward" : e.shiftKey ? "back" : "backward");
		else if (e.key === "Delete" || e.key === "Backspace") z(E.slide, [{
			op: "delete",
			top: E.top
		}]), D(null);
		else if (r[e.key] && t) z(E.slide, [{
			op: "xfrm",
			top: E.top,
			box: {
				...t,
				x: t.x + r[e.key][0],
				y: t.y + r[e.key][1]
			}
		}]);
		else if (e.key === "Escape") D(null);
		else return !1;
		return e.preventDefault(), !0;
	}, K = (e) => {
		let t = c.current;
		t && (t.scrollTop = Xo + Math.max(0, Math.min(a.count - 1, e)) * j - Math.max(0, (l.h - ge) / 2));
	}, He = Wn(), Ue = qn(He), We = (e, t, n) => {
		let r = a.slides[e];
		return r ? {
			quote: `Slide ${e + 1}`,
			at: {
				slide: r.path,
				x: Math.max(0, Math.min(a.w - 1, t)),
				y: Math.max(0, Math.min(a.h - 1, n))
			}
		} : null;
	}, Ge = V({
		selected: E,
		current: I,
		go: K
	});
	Ge.current = {
		selected: E,
		current: I,
		go: K
	}, B(() => {
		if (!He) return;
		let e = (e) => {
			let t = e.root.at, n = t && "slide" in t ? a.slides.findIndex((e) => e.path === t.slide) : -1;
			return n >= 0 ? {
				i: n,
				a: t
			} : null;
		};
		return He.setHost({
			kind: "pptx",
			hint: "Select a shape, or right-click the slide where the comment goes.",
			pending: () => {
				let { selected: e, current: t } = Ge.current, n = e ? qo(De(e.slide), e.top) : void 0;
				return n && e ? We(e.slide, n.x + n.w, n.y + 28) : We(t, 24, 40);
			},
			placed: (t) => {
				let n = [];
				for (let r of t) {
					let t = e(r);
					t && n.push({
						...r,
						quote: `Slide ${t.i + 1}`,
						k: [
							t.i,
							t.a.y,
							t.a.x
						]
					});
				}
				return n.sort((e, t) => e.k[0] - t.k[0] || e.k[1] - t.k[1] || e.k[2] - t.k[2]);
			},
			reveal: (t) => {
				let n = He.threads().find((e) => e.root.id === t), r = n && e(n);
				r && Ge.current.go(r.i);
			}
		}), () => He.setHost(null);
	}, [
		He,
		a,
		ne
	]), B(() => He?.touch(), [
		He,
		ne,
		a.count
	]);
	let Ke = Me(() => {
		let e = /* @__PURE__ */ new Map();
		if (!He) return e;
		for (let t of He.threads()) {
			let n = t.root.at;
			if (!n || !("slide" in n) || t.root.done && t.root.id !== Ue.active) continue;
			let r = e.get(n.slide);
			r || e.set(n.slide, r = []), r.push({
				id: t.root.id,
				x: n.x,
				y: n.y,
				who: t.root.author.initials ?? d(t.root.author.name),
				n: t.replies.length
			});
		}
		return e;
	}, [He, Ue]), qe = zi({
		...b,
		editor: v,
		scroll: () => c.current,
		slides: () => ee.current,
		textRoot: () => T.current,
		count: a.count,
		current: () => I,
		zoom: () => m,
		setZoom: h,
		go: K,
		selected: () => E,
		ops: () => S.current
	});
	Ri(e, Me(() => zo(qe), [qe])), B(() => y.emitSelection(), [
		y,
		E?.slide,
		E?.top
	]);
	let Je = (e) => {
		if (v.active || e.defaultPrevented || Ve(e)) return;
		if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
			e.preventDefault(), i.save();
			return;
		}
		if (e.key === "F5") {
			e.preventDefault(), k(e.shiftKey ? 0 : I);
			return;
		}
		let t = e.metaKey || e.ctrlKey;
		if (i.editable && t && (e.key.toLowerCase() === "z" || e.key.toLowerCase() === "y")) e.preventDefault(), Pe(e.key.toLowerCase() === "y" || e.shiftKey);
		else if (i.editable && t && !e.altKey && e.key.toLowerCase() === "m") e.preventDefault(), U("add");
		else {
			if (e.key === "PageDown" || e.key === "ArrowRight" || e.key === " " && !e.shiftKey) K(I + 1);
			else if (e.key === "PageUp" || e.key === "ArrowLeft") K(I - 1);
			else if (e.key === "Home") K(0);
			else if (e.key === "End") K(a.count - 1);
			else return;
			e.preventDefault();
		}
	}, Xe = (e) => {
		let t = O && O.slide === e && O.moved ? O.cur : E ? qo(De(e), E.top) : void 0;
		if (t && E) return /* @__PURE__ */ W(Yo, {
			box: t,
			scale: he,
			onHandle: (t, n) => {
				let r = qo(De(e), E.top);
				r && te({
					slide: e,
					top: E.top,
					mode: t,
					sx: n.clientX,
					sy: n.clientY,
					box: r,
					cur: r,
					moved: !1,
					px: n.clientX,
					py: n.clientY
				});
			}
		});
	}, Ze = [];
	for (let t = F; t <= ye; t++) Ze.push(/* @__PURE__ */ G("div", {
		className: i.editable ? "de-slide-frame de-slide-editable" : "de-slide-frame",
		style: {
			top: Xo + t * j,
			left: P
		},
		"data-slide": t + 1,
		onMouseDown: (e) => Oe(t, e),
		onContextMenu: (e) => {
			if (!i.editable) return;
			let n = e.target;
			if (v.active && T.current?.contains(n)) return;
			e.preventDefault();
			let r = n.closest("[data-top]");
			if (r) {
				we();
				let n = {
					slide: t,
					top: Number(r.dataset.top)
				};
				Le.current = n, D(n), se({
					x: e.clientX,
					y: e.clientY,
					items: ze()
				});
			} else {
				let n = e.currentTarget.getBoundingClientRect();
				se({
					x: e.clientX,
					y: e.clientY,
					items: Be(t, {
						x: (e.clientX - n.left) / he,
						y: (e.clientY - n.top) / he
					})
				});
			}
		},
		children: [(Ke.get(a.slides[t]?.path ?? "") ?? []).map((e) => /* @__PURE__ */ W("button", {
			type: "button",
			className: "de-cm-pin" + (Ue.active === e.id ? " on" : ""),
			style: {
				left: e.x * he,
				top: e.y * he
			},
			title: "Comment",
			"aria-label": "Show comment",
			"data-thread": e.id,
			onMouseDown: (e) => e.stopPropagation(),
			onClick: (t) => {
				t.stopPropagation(), He?.select(e.id, !1);
			},
			children: e.who
		}, e.id)), /* @__PURE__ */ W(Go, {
			client: e,
			index: t,
			meta: a,
			scale: he,
			live: !0,
			editing: v.slide === t ? Ee : void 0,
			overlay: i.editable && E?.slide === t ? Xe(t) : void 0
		})]
	}, `${ne}:${t}`));
	v.active && (v.slide < F || v.slide > ye) && we();
	let q = [];
	if (g) for (let t = Ce; t <= L; t++) q.push(/* @__PURE__ */ G("div", {
		className: "de-thumb",
		style: { top: 10 + t * Se },
		"aria-current": t === I,
		onClick: () => K(t),
		onContextMenu: (e) => {
			i.editable && (e.preventDefault(), K(t), se({
				x: e.clientX,
				y: e.clientY,
				items: Be(t)
			}));
		},
		children: [/* @__PURE__ */ W("span", {
			className: "de-thumb-n",
			children: t + 1
		}), /* @__PURE__ */ W(Go, {
			client: e,
			index: t,
			meta: a,
			scale: be,
			live: !0
		})]
	}, `${ne}:${t}`));
	return /* @__PURE__ */ G("div", {
		ref: o,
		style: {
			display: "flex",
			flex: 1,
			minWidth: 0
		},
		children: [g && /* @__PURE__ */ W("div", {
			ref: f,
			className: "de-thumbs",
			children: /* @__PURE__ */ W("div", {
				style: {
					height: 20 + a.count * Se,
					position: "relative"
				},
				children: q
			})
		}), /* @__PURE__ */ G("div", {
			style: {
				position: "relative",
				flex: 1,
				minWidth: 0,
				display: "flex"
			},
			children: [
				/* @__PURE__ */ W("div", {
					ref: c,
					className: "de-scroll",
					tabIndex: 0,
					onKeyDown: Je,
					style: { outline: "none" },
					onMouseDown: (e) => e.target === e.currentTarget && we(),
					children: /* @__PURE__ */ W("div", {
						ref: ee,
						style: {
							position: "relative",
							height: M,
							width: N
						},
						onMouseDown: (e) => e.target === e.currentTarget && we(),
						children: Ze
					})
				}),
				/* @__PURE__ */ W(Ht, {
					zoom: m,
					effective: he,
					onChange: h
				}),
				!i.editable && /* @__PURE__ */ W("button", {
					type: "button",
					className: "de-mode de-present-btn",
					title: "Present (F5)",
					onClick: () => k(I),
					children: "▶ Present"
				}),
				/* @__PURE__ */ W(Bt, {
					text: `Slide ${I + 1} of ${a.count}`,
					onStatus: t
				}),
				ue && /* @__PURE__ */ W(Yt, {
					text: ue,
					onDone: () => de(null)
				}),
				i.editable && /* @__PURE__ */ W(so, {
					editor: v,
					shape: E && !v.active ? (() => {
						let e = Ie(E), t = e?.t === "shape" ? e : void 0;
						return {
							canText: t?.sid !== void 0,
							anchor: t?.text?.anchor
						};
					})() : null,
					textAnchor: v.body?.anchor,
					canUndo: ce > 0,
					onUndo: (e) => void Pe(e),
					onInsert: (e) => void Ae(e),
					onFill: (e) => E && void z(E.slide, [{
						op: "fill",
						top: E.top,
						color: e
					}]),
					onLine: (e) => E && void z(E.slide, [{
						op: "line",
						top: E.top,
						...e
					}]),
					onArrange: Re.arrange,
					onRotate: Re.rotate,
					onAlign: Re.align,
					onAnchor: Re.anchor,
					onDuplicate: Re.duplicate,
					onDelete: Re.remove,
					onBackground: (e) => void z(I, [{
						op: "bg",
						color: e
					}]),
					onSlide: (e) => U(e),
					onPresent: (e) => k(e ? 0 : I)
				}),
				oe && /* @__PURE__ */ W(Kt, {
					x: oe.x,
					y: oe.y,
					items: oe.items,
					onClose: () => se(null)
				}),
				ie !== null && /* @__PURE__ */ W(co, {
					client: e,
					meta: a,
					start: ie,
					onClose: () => k(null)
				})
			]
		})]
	});
}
// src/react/useDocument.ts
function $o(e, t = {}, n = !1) {
	let [r, i] = H({
		client: null,
		error: null,
		loading: !!e,
		progress: null
	}), { name: a, worker: o, credentials: s } = t, c = t.headers ? JSON.stringify(t.headers) : "", l = V(null), u = V(n);
	u.current = n;
	let d = (e) => {
		l.current && l.current !== e && l.current.destroy(), l.current = e;
	};
	return B(() => () => d(null), []), B(() => {
		if (!e) {
			d(null), i({
				client: null,
				error: null,
				loading: !1,
				progress: null
			});
			return;
		}
		let t = !0;
		return u.current && l.current ? i((e) => ({
			...e,
			error: null,
			loading: !0
		})) : (d(null), i({
			client: null,
			error: null,
			loading: !0,
			progress: null
		})), D.open(e, {
			name: a,
			worker: o,
			credentials: s,
			headers: c ? JSON.parse(c) : void 0,
			onProgress: (e) => t && i((t) => ({
				...t,
				progress: e
			}))
		}).then((e) => {
			if (!t) return e.destroy();
			d(e), e.on("progress", (n) => t && l.current === e && i((e) => ({
				...e,
				progress: n
			}))), i((t) => ({
				...t,
				client: e,
				loading: !1
			}));
		}, (e) => {
			t && (d(null), i({
				client: null,
				error: e,
				loading: !1,
				progress: null
			}));
		}), () => {
			t = !1;
		};
	}, [
		e,
		a,
		o,
		s,
		c
	]), r;
}
// src/react/xlsx/XlsxToolbar.tsx
var es = [
	{
		value: "General",
		label: "Automatic",
		hint: "1000.12"
	},
	{
		value: "@",
		label: "Plain text",
		hint: "abc"
	},
	{
		value: "0",
		label: "Number",
		hint: "1000",
		sep: !0
	},
	{
		value: "0.00",
		label: "Number",
		hint: "1000.12"
	},
	{
		value: "#,##0",
		label: "Number",
		hint: "1,000"
	},
	{
		value: "#,##0.00",
		label: "Number",
		hint: "1,000.12"
	},
	{
		value: "0.00E+00",
		label: "Scientific",
		hint: "1.01E+03"
	},
	{
		value: "0%",
		label: "Percent",
		hint: "10%",
		sep: !0
	},
	{
		value: "0.00%",
		label: "Percent",
		hint: "10.12%"
	},
	{
		value: "\"$\"#,##0.00",
		label: "Currency",
		hint: "$1,000.12",
		sep: !0
	},
	{
		value: "\"$\"#,##0",
		label: "Currency rounded",
		hint: "$1,000"
	},
	{
		value: "_(\"$\"* #,##0.00_);_(\"$\"* (#,##0.00);_(\"$\"* \"-\"??_);_(@_)",
		label: "Accounting",
		hint: "$ (1,000.12)"
	},
	{
		value: "#,##0 \"₫\"",
		label: "Currency",
		hint: "1,000 ₫"
	},
	{
		value: "# ?/?",
		label: "Fraction",
		hint: "1000 1/8"
	},
	{
		value: "yyyy-mm-dd",
		label: "Date",
		hint: "2026-09-26",
		sep: !0
	},
	{
		value: "dd/mm/yyyy",
		label: "Date",
		hint: "26/09/2026"
	},
	{
		value: "d mmmm yyyy",
		label: "Long date",
		hint: "26 September 2026"
	},
	{
		value: "h:mm",
		label: "Time",
		hint: "15:59"
	},
	{
		value: "h:mm:ss AM/PM",
		label: "Time",
		hint: "3:59:00 PM"
	},
	{
		value: "yyyy-mm-dd h:mm",
		label: "Date time",
		hint: "2026-09-26 15:59"
	},
	{
		value: "[h]:mm:ss",
		label: "Duration",
		hint: "24:01:00"
	}
], ts = [
	6,
	7,
	8,
	9,
	10,
	11,
	12,
	14,
	16,
	18,
	20,
	24,
	28,
	36,
	48
], ns = [
	{
		k: "all",
		icon: "bAll",
		title: "All borders"
	},
	{
		k: "inner",
		icon: "bInner",
		title: "Inner borders"
	},
	{
		k: "outer",
		icon: "bOuter",
		title: "Outer borders"
	},
	{
		k: "none",
		icon: "bNone",
		title: "Clear borders"
	},
	{
		k: "top",
		icon: "bTop",
		title: "Top border"
	},
	{
		k: "bottom",
		icon: "bBottom",
		title: "Bottom border"
	},
	{
		k: "left",
		icon: "bLeft",
		title: "Left border"
	},
	{
		k: "right",
		icon: "bRight",
		title: "Right border"
	}
], rs = [
	{
		value: "thin",
		label: "Thin",
		hint: "───"
	},
	{
		value: "medium",
		label: "Medium",
		hint: "━━━"
	},
	{
		value: "thick",
		label: "Thick",
		hint: "▬▬▬"
	},
	{
		value: "dashed",
		label: "Dashed",
		hint: "- - -"
	},
	{
		value: "dotted",
		label: "Dotted",
		hint: "·····"
	},
	{
		value: "double",
		label: "Double",
		hint: "═══"
	}
], is = [
	{
		value: "left",
		label: "Left",
		icon: "alignLeft"
	},
	{
		value: "center",
		label: "Center",
		icon: "alignCenter"
	},
	{
		value: "right",
		label: "Right",
		icon: "alignRight"
	}
], as = [
	{
		value: "top",
		label: "Top",
		icon: "vTop"
	},
	{
		value: "center",
		label: "Middle",
		icon: "vMiddle"
	},
	{
		value: "bottom",
		label: "Bottom",
		icon: "vBottom"
	}
], os = [
	{
		value: 0,
		label: "None",
		icon: "rotNone"
	},
	{
		value: 45,
		label: "Tilt up",
		icon: "rotUp"
	},
	{
		value: -45,
		label: "Tilt down",
		icon: "rotDown"
	},
	{
		value: 255,
		label: "Stack vertically",
		icon: "rotStack"
	},
	{
		value: 90,
		label: "Rotate up",
		icon: "rotUp90"
	},
	{
		value: -90,
		label: "Rotate down",
		icon: "rotDown90"
	}
], ss = [
	"SUM",
	"AVERAGE",
	"COUNT",
	"MAX",
	"MIN"
];
function cs(e, t) {
	let n = e === "General" || e === "@" ? "0" : e, r = /0(\.0*)?/.exec(n);
	if (!r) return t > 0 ? "0.0" : "0";
	let i = Math.max(0, (r[1] ? r[1].length - 1 : 0) + t);
	return n.slice(0, r.index) + "0" + (i ? "." + "0".repeat(i) : "") + n.slice(r.index + r[0].length);
}
function ls(e) {
	let { css: t, onFormat: n } = e, [r, i] = H("#000000"), [a, o] = H("thin"), s = String(t.textDecoration ?? ""), c = t.textAlign ?? "", l = t.alignItems === "flex-start" ? "top" : t.alignItems === "center" ? "center" : "bottom", u = Number(t.textRotate ?? 0), d = (e) => typeof e == "string" && e.endsWith("pt") ? parseFloat(e) : typeof e == "number" ? Math.round(e * .75 * 2) / 2 : void 0, f = d(t.fontSize) ?? d(e.base.fontSize), p = Ot(t.fontFamily ?? e.base.fontFamily), m = es.find((t) => t.value === e.format), h = m ? es : [{
		value: e.format,
		label: "Custom",
		hint: e.format
	}, ...es];
	return /* @__PURE__ */ G(Rt, { children: [
		/* @__PURE__ */ W(Y, {
			icon: "undo",
			title: `Undo (${Q}Z)`,
			onClick: e.onUndo
		}),
		/* @__PURE__ */ W(Y, {
			icon: "redo",
			title: `Redo (${Q}Y)`,
			onClick: e.onRedo
		}),
		/* @__PURE__ */ W(Y, {
			icon: "paint",
			title: "Paint format (click, then select cells)",
			active: e.painter,
			onClick: e.onPaint
		}),
		/* @__PURE__ */ W(X, {}),
		/* @__PURE__ */ W(Y, {
			icon: "currency",
			title: "Format as currency",
			onClick: () => n({ numFmt: "\"$\"#,##0.00" })
		}),
		/* @__PURE__ */ W(Y, {
			icon: "percent",
			title: "Format as percent",
			onClick: () => n({ numFmt: "0%" })
		}),
		/* @__PURE__ */ W(Y, {
			icon: "decLess",
			title: "Decrease decimal places",
			onClick: () => n({ numFmt: cs(e.format, -1) })
		}),
		/* @__PURE__ */ W(Y, {
			icon: "decMore",
			title: "Increase decimal places",
			onClick: () => n({ numFmt: cs(e.format, 1) })
		}),
		/* @__PURE__ */ W(ut, {
			title: `Number format: ${m?.label ?? "Custom"}`,
			width: 96,
			menuWidth: 270,
			value: e.format,
			options: h,
			onChange: (e) => n({ numFmt: e })
		}),
		/* @__PURE__ */ W(X, {}),
		/* @__PURE__ */ W(ut, {
			title: "Font",
			width: 112,
			menuWidth: 200,
			value: p,
			placeholder: "Font",
			options: Dt(p),
			onChange: (e) => n({ font: e })
		}),
		/* @__PURE__ */ W(X, {}),
		/* @__PURE__ */ W(dt, {
			value: f,
			sizes: ts,
			onChange: (e) => n({ sz: e })
		}),
		/* @__PURE__ */ W(X, {}),
		/* @__PURE__ */ W(Y, {
			icon: "bold",
			title: `Bold (${Q}B)`,
			active: t.fontWeight === 700,
			onClick: () => e.onToggle("b")
		}),
		/* @__PURE__ */ W(Y, {
			icon: "italic",
			title: `Italic (${Q}I)`,
			active: t.fontStyle === "italic",
			onClick: () => e.onToggle("i")
		}),
		/* @__PURE__ */ W(Y, {
			icon: "underline",
			title: `Underline (${Q}U)`,
			active: s.includes("underline"),
			onClick: () => e.onToggle("u")
		}),
		/* @__PURE__ */ W(Y, {
			icon: "strike",
			title: `Strikethrough (${Q}⇧X)`,
			active: s.includes("line-through"),
			onClick: () => e.onToggle("strike")
		}),
		/* @__PURE__ */ W(wt, {
			icon: "color",
			title: "Text color",
			value: t.color,
			onPick: (e) => n({ color: e }),
			noneLabel: "Automatic"
		}),
		/* @__PURE__ */ W(X, {}),
		/* @__PURE__ */ W(wt, {
			icon: "fill",
			title: "Fill color",
			value: typeof t.background == "string" && !t.background.includes("gradient") ? t.background : void 0,
			onPick: (e) => n({ fill: e }),
			noneLabel: "No fill"
		}),
		/* @__PURE__ */ W(jt, {
			icon: "borders",
			title: "Borders",
			chevron: !0,
			children: (e) => /* @__PURE__ */ G("div", {
				className: "de-borders-pop",
				children: [/* @__PURE__ */ W("div", {
					className: "de-borders",
					role: "group",
					"aria-label": "Borders",
					children: ns.map((t) => /* @__PURE__ */ W("button", {
						type: "button",
						className: "de-tb",
						title: t.title,
						"aria-label": t.title,
						onClick: () => {
							e(), n({
								border: t.k,
								borderColor: r,
								borderStyle: a
							});
						},
						children: /* @__PURE__ */ W(J, { name: t.icon })
					}, t.k))
				}), /* @__PURE__ */ G("div", {
					className: "de-borders-side",
					children: [/* @__PURE__ */ W(wt, {
						icon: "color",
						title: "Border color",
						value: r,
						onPick: (e) => i(e ?? "#000000"),
						noneLabel: "Black"
					}), /* @__PURE__ */ W(Z, {
						title: "Border style",
						icon: "lineStyle",
						label: null,
						menuWidth: 150,
						value: a,
						options: [...rs],
						onChange: (e) => o(e)
					})]
				})]
			})
		}),
		/* @__PURE__ */ W(Z, {
			title: "Merge cells",
			icon: "merge",
			label: null,
			menuWidth: 190,
			options: [
				{
					value: "all",
					label: "Merge all"
				},
				{
					value: "across",
					label: "Merge horizontally"
				},
				{
					value: "down",
					label: "Merge vertically"
				},
				{
					value: "unmerge",
					label: "Unmerge",
					disabled: !e.merged,
					sep: !0
				}
			],
			onChange: (t) => e.onMerge(t)
		}),
		/* @__PURE__ */ W(X, {}),
		/* @__PURE__ */ W(Z, {
			title: "Horizontal align",
			icon: is.find((e) => e.value === c)?.icon ?? "alignLeft",
			label: null,
			menuWidth: 140,
			value: c,
			options: is.map((e) => ({ ...e })),
			onChange: (e) => n({ align: e === c ? null : e })
		}),
		/* @__PURE__ */ W(Z, {
			title: "Vertical align",
			icon: as.find((e) => e.value === l).icon,
			label: null,
			menuWidth: 140,
			value: l,
			options: as.map((e) => ({ ...e })),
			onChange: (e) => n({ valign: e })
		}),
		/* @__PURE__ */ W(Y, {
			icon: "wrap",
			title: "Wrap text",
			active: t.whiteSpace === "pre-wrap",
			onClick: () => n({ wrap: t.whiteSpace !== "pre-wrap" })
		}),
		/* @__PURE__ */ W(Z, {
			title: "Text rotation",
			icon: os.find((e) => e.value === u)?.icon ?? "rotNone",
			label: null,
			menuWidth: 180,
			value: u,
			options: os,
			onChange: (e) => n({ rotate: e || null })
		}),
		/* @__PURE__ */ W(X, {}),
		/* @__PURE__ */ W(At, {
			title: "Insert, delete or hide rows & columns",
			label: "Rows",
			icon: "rowAdd",
			items: [
				{
					value: "rowAbove",
					label: "Insert row above",
					icon: "rowAbove"
				},
				{
					value: "rowBelow",
					label: "Insert row below",
					icon: "rowBelow"
				},
				{
					value: "colLeft",
					label: "Insert column left",
					icon: "colLeft"
				},
				{
					value: "colRight",
					label: "Insert column right",
					icon: "colRight"
				},
				{
					value: "delRow",
					label: "Delete row(s)",
					icon: "delRow",
					sep: !0
				},
				{
					value: "delCol",
					label: "Delete column(s)",
					icon: "delCol"
				},
				{
					value: "hideRows",
					label: "Hide row(s)",
					icon: "hide",
					sep: !0
				},
				{
					value: "hideCols",
					label: "Hide column(s)",
					icon: "hide"
				},
				{
					value: "unhideRows",
					label: "Unhide rows",
					icon: "view"
				},
				{
					value: "unhideCols",
					label: "Unhide columns",
					icon: "view"
				}
			],
			onPick: (t) => e.onRows(t)
		}),
		/* @__PURE__ */ W(Z, {
			title: "Functions",
			icon: "sum",
			label: null,
			menuWidth: 170,
			options: [...ss.map((e) => ({
				value: e,
				label: e
			})), {
				value: "",
				label: "More functions…",
				sep: !0
			}],
			onChange: (t) => e.onFunc(t || null)
		}),
		/* @__PURE__ */ W(Z, {
			title: "Sort range",
			icon: "sort",
			label: null,
			menuWidth: 200,
			options: [{
				value: "asc",
				label: "Sort range A → Z",
				icon: "sortAZ"
			}, {
				value: "desc",
				label: "Sort range Z → A",
				icon: "sortZA"
			}],
			onChange: (t) => e.onSort(t === "desc")
		}),
		/* @__PURE__ */ W(At, {
			title: "View: freeze, gridlines",
			label: "View",
			icon: "freeze",
			items: [
				{
					value: "row",
					label: "Freeze 1 row"
				},
				{
					value: "col",
					label: "Freeze 1 column"
				},
				{
					value: "sel",
					label: "Freeze up to current cell"
				},
				{
					value: "none",
					label: "Unfreeze",
					disabled: !e.frozen
				},
				{
					value: "grid",
					label: e.gridlines ? "Hide gridlines" : "Show gridlines",
					icon: "gridlines",
					sep: !0
				}
			],
			onPick: (t) => t === "grid" ? e.onGridlines() : e.onFreeze(t)
		}),
		/* @__PURE__ */ W(X, {}),
		/* @__PURE__ */ W(Y, {
			icon: "clear",
			title: `Clear formatting (${Q}\\)`,
			onClick: () => n({ clear: !0 })
		}),
		/* @__PURE__ */ W(Y, {
			icon: "search",
			title: `Find & replace (${Q}F)`,
			onClick: e.onFind
		})
	] });
}
// src/react/xlsx/axis.ts
var us = class {
	def;
	count = 0;
	custom = /* @__PURE__ */ new Map();
	keys = [];
	cum = [];
	dirty = !1;
	constructor(e) {
		this.def = e;
	}
	set(e, t) {
		t === this.def ? this.custom.delete(e) : this.custom.set(e, t), this.dirty = !0;
	}
	setRange(e, t, n) {
		let r = Math.min(t, e + 2e4);
		for (let t = e; t <= r; t++) this.set(t, n);
	}
	build() {
		if (!this.dirty) return;
		this.keys = [...this.custom.keys()].sort((e, t) => e - t);
		let e = 0;
		this.cum = this.keys.map((t) => e += this.custom.get(t) - this.def), this.dirty = !1;
	}
	size(e) {
		return this.custom.get(e) ?? this.def;
	}
	pos(e) {
		this.build();
		let t = 0, n = this.keys.length - 1, r = -1;
		for (; t <= n;) {
			let i = t + n >> 1;
			this.keys[i] < e ? (r = i, t = i + 1) : n = i - 1;
		}
		return e * this.def + (r >= 0 ? this.cum[r] : 0);
	}
	total() {
		return this.pos(this.count);
	}
	index(e) {
		if (e <= 0) return 0;
		let t = 0, n = Math.max(0, this.count - 1);
		for (; t < n;) {
			let r = t + n + 1 >> 1;
			this.pos(r) <= e ? t = r : n = r - 1;
		}
		return t;
	}
}, ds = (e, t) => typeof e == "string" && e.endsWith("pt") ? parseFloat(e) * 4 / 3 : typeof e == "number" ? e : t;
function fs(e, t, n) {
	let r = n * .56;
	if (e.length * r <= t) return e;
	let i = /^(-?\d+)\.(\d+)$/.exec(e);
	if (i && (i[1].length + (e.startsWith("-"), 0)) * r <= t) {
		let n = Math.max(0, Math.floor(t / r) - i[1].length - 1), a = Number(e).toFixed(n);
		if (a.length * r <= t) return a;
	}
	return "#".repeat(Math.max(1, Math.floor(t / r)));
}
// src/react/xlsx/print.tsx
var ps = 2e3, ms = 2e4, hs = 100, gs = 700, _s = 960;
async function vs(e, t, n) {
	let r = /* @__PURE__ */ new Map();
	for (let i = 0; i < n; i += ps) {
		let a = await e.call("xlsx.block", t, i, Math.min(n, i + ps));
		for (let e of a.rows) r.set(e.r, e.cells);
	}
	return r;
}
var ys = () => /* @__PURE__ */ Error("The sheet is still loading — try again in a moment"), bs = be({
	"flex-start": "top",
	center: "middle",
	"flex-end": "bottom"
});
async function xs(e, t, n, r) {
	if (!n.done) throw ys();
	let i = await vs(e, t, Math.min(n.rows, ms)), a = -1, o = -1;
	for (let [e, t] of i) for (let n of t) (n[1] !== "" || n[2]) && (a = Math.max(a, e), o = Math.max(o, n[0]));
	let s = n.merges.filter((e) => e.r0 <= a && e.c0 <= o);
	for (let e of s) a = Math.max(a, Math.min(e.r1, 19999)), o = Math.max(o, e.c1);
	let c = [];
	for (let e = 0; e <= o; e++) n.colAxis.size(e) > 0 && c.push(e);
	let l = /* @__PURE__ */ new Map(), u = /* @__PURE__ */ new Set(), d = (e, t) => e * 16384 + t, f = new Int32Array(a + 2);
	for (let e of s) {
		l.set(d(e.r0, e.c0), e);
		let t = Math.min(e.r1, a);
		for (let n = e.r0; n <= t; n++) for (let t = e.c0; t <= e.c1; t++) (n !== e.r0 || t !== e.c0) && u.add(d(n, t));
		t > e.r0 && (f[e.r0 + 1]++, f[t + 1]--);
	}
	let p = (e, t, n) => {
		let r = 0;
		for (let i = t; i <= n; i++) e.size(i) > 0 && r++;
		return Math.max(1, r);
	}, m = ds(r.baseFont.fontSize, 14.67), h = [], g = [], _ = 0;
	for (let e = 0; e <= a; e++) {
		_ += f[e], !_ && g.length >= hs && (h.push(g), g = []);
		let t = n.rowAxis.size(e);
		if (!t) continue;
		let s = new Map((i.get(e) ?? []).map((e) => [e[0], e])), v = [];
		c.forEach((t, i) => {
			if (u.has(d(e, t))) return;
			let f = s.get(t), h = l.get(d(e, t)), [, g = "", _ = 0, y = 0, b] = f ?? [], { textAlign: x, textRotate: S, alignItems: C, whiteSpace: w, ...T } = r.styles[_] ?? {}, ee = h ? n.colAxis.pos(Math.min(h.c1, o) + 1) - n.colAxis.pos(h.c0) : n.colAxis.size(t), E = y === 1 && g ? fs(g, ee - 6, ds(T.fontSize, m)) : g, D = x ?? (y === 1 ? "right" : y === 2 ? "center" : "left"), O = c[i + 1], te = !!E && !h && D === "left" && !w && (O === void 0 || !s.get(O)?.[1] && !u.has(d(e, O))), ne = { ...T };
			ne.background !== void 0 && (ne.background = xe(ne.background)), D !== "left" && (ne.textAlign = D);
			let re = bs[C];
			re && re !== "bottom" && (ne.verticalAlign = re), w && (ne.whiteSpace = w), b && (ne.color = L(b)), v.push(/* @__PURE__ */ W("td", {
				style: ne,
				"data-de-fit": E && !te ? y === 1 ? "#" : "" : void 0,
				colSpan: h ? p(n.colAxis, h.c0, Math.min(h.c1, o)) : void 0,
				rowSpan: h ? p(n.rowAxis, h.r0, Math.min(h.r1, a)) : void 0,
				children: E
			}, t));
		}), g.push(/* @__PURE__ */ W("tr", {
			style: { height: t },
			children: v
		}, e));
	}
	(g.length || !h.length) && h.push(g);
	let v = c.reduce((e, t) => e + n.colAxis.size(t), 0), y = v > gs, b = Math.max(.35, Math.min(1, (y ? _s : gs) / Math.max(1, v))), x = n.gridLines ? "de-print-table de-print-grid" : "de-print-table", S = {
		width: v,
		...r.baseFont
	}, C = /* @__PURE__ */ W("colgroup", { children: c.map((e) => /* @__PURE__ */ W("col", { style: { width: n.colAxis.size(e) } }, e)) });
	return {
		node: /* @__PURE__ */ W("div", {
			className: "de-print-sheet de-print-fit",
			style: { "--de-fit": b },
			children: h.map((e, t) => /* @__PURE__ */ G("table", {
				className: x,
				style: S,
				children: [C, /* @__PURE__ */ W("tbody", { children: e })]
			}, t))
		}),
		size: y ? "landscape" : "auto",
		margin: "12mm",
		notice: n.rows > ms ? `Only the first ${ms.toLocaleString()} rows are included` : void 0
	};
}
// src/react/xlsx/XlsxView.tsx
var Ss = 128, Cs = 22, ws = 12e6, Ts = class {
	rows = 0;
	cols = 0;
	done = !1;
	error;
	header = !1;
	rowAxis = new us(20);
	colAxis = new us(64);
	merges = [];
	frozen = {
		rows: 0,
		cols: 0
	};
	gridLines = !0;
	blocks = /* @__PURE__ */ new Map();
	inflight = /* @__PURE__ */ new Set();
	sel;
	scrollPos;
	goto;
	topLeft;
};
function Es(e, t, n) {
	let r = /* @__PURE__ */ new Map();
	if (!e || !t) return r;
	for (let i of e.threads()) {
		let e = i.root.at;
		!e || !("sheet" in e) || e.sheet !== t || i.root.done && i.root.id !== n || r.has(e.r * 16384 + e.c) || r.set(e.r * 16384 + e.c, i.root.id);
	}
	return r;
}
var Ds = class {
	client;
	sheets = /* @__PURE__ */ new Map();
	focusGrid = !1;
	listeners = /* @__PURE__ */ new Set();
	off;
	constructor(e) {
		this.client = e;
		let t = [e.on("xlsx:progress", (e) => this.onProgress(e)), e.on("collab:xlsx", (t) => this.applied(t, e.info.xlsx))];
		this.off = () => t.forEach((e) => e());
	}
	subscribe(e) {
		return this.listeners.add(e), () => {
			this.listeners.delete(e);
		};
	}
	emit() {
		for (let e of this.listeners) e();
	}
	sheet(e) {
		let t = this.sheets.get(e);
		return t || (t = new Ts(), this.sheets.set(e, t), this.client.call("xlsx.load", e).catch((e) => {
			t.error = e.message, t.done = !0, this.emit();
		})), t;
	}
	onProgress(e) {
		let t = this.sheet(e.sheet);
		if (e.defaultRowH !== void 0 && !t.header) {
			t.header = !0, t.rowAxis.def = e.defaultRowH || 20, t.colAxis.def = e.defaultColW || 64;
			for (let n of e.colInfo ?? []) t.colAxis.setRange(n.min, n.max, n.w);
			t.frozen = e.frozen ?? t.frozen, t.gridLines = e.gridLines ?? !0;
		}
		for (let [n, r] of e.rowSizes) t.rowAxis.set(n, r);
		e.recalc && t.blocks.clear(), t.rows = Math.max(t.rows, e.rows), t.cols = Math.max(t.cols, e.cols), e.merges && (t.merges = e.merges), e.error && (t.error = e.error), t.done = e.done, this.emit();
	}
	ensure(e, t, n) {
		let r = this.sheet(e);
		if (r.header || r.done) for (let i = Math.floor(t / Ss); i <= Math.floor(n / Ss); i++) {
			let t = r.blocks.get(i);
			if (r.inflight.has(i) || t && (t.complete || t.rowsAt === r.rows && !r.done) || i * Ss > r.rows && !r.done && t) continue;
			r.inflight.add(i);
			let n = r.rows;
			this.client.call("xlsx.block", e, i * Ss, (i + 1) * Ss).then((e) => {
				let t = /* @__PURE__ */ new Map();
				for (let n of e.rows) t.set(n.r, n.cells);
				if (r.blocks.set(i, {
					rows: t,
					complete: e.complete,
					rowsAt: n
				}), r.blocks.size > 400) {
					let e = r.blocks.keys().next().value;
					r.blocks.delete(e);
				}
			}).catch(() => {}).finally(() => {
				r.inflight.delete(i), this.emit();
			});
		}
	}
	invalidate(e, t, n) {
		let r = this.sheet(e);
		for (let e = Math.floor(t / Ss); e <= Math.floor(n / Ss); e++) r.blocks.delete(e);
		r.rows = Math.max(r.rows, n + 1), this.emit();
	}
	applied(e, t) {
		if (!e) return;
		for (let n of e.styles ?? []) t.styles[n.index] = n.css, t.formats[n.index] = n.format;
		for (let t of e.recalc ?? []) this.sheets.get(t)?.blocks.clear();
		if (e.sheets) {
			t.sheets = e.sheets, this.sheets.clear(), this.emit();
			return;
		}
		let n = this.sheet(e.sheet);
		if (e.layout) {
			let t = e.layout;
			n.rowAxis = new us(t.defaultRowH || n.rowAxis.def), n.colAxis = new us(t.defaultColW || n.colAxis.def);
			for (let e of t.colInfo ?? []) n.colAxis.setRange(e.min, e.max, e.w);
			for (let [e, r] of t.rowSizes) n.rowAxis.set(e, r);
			n.merges = t.merges ?? [], n.frozen = t.frozen ?? n.frozen, t.gridLines !== void 0 && (n.gridLines = t.gridLines), n.rows = t.rows, n.cols = t.cols, n.blocks.clear(), this.emit();
		} else n.cols = Math.max(n.cols, e.range.c1 + 1), this.invalidate(e.sheet, e.range.r0, e.range.r1);
	}
	row(e, t) {
		return this.sheets.get(e)?.blocks.get(Math.floor(t / Ss))?.rows.get(t);
	}
	dispose() {
		this.off(), this.listeners.clear();
	}
}, Os = /* @__PURE__ */ new WeakMap();
function ks(e) {
	let t = Os.get(e);
	return t || Os.set(e, t = new Ds(e)), t;
}
function As({ client: e, onStatus: t, initialSheet: n }) {
	let r = e.info.xlsx, a = r.sheets.filter((e) => !e.hidden), [o, s] = H(n ?? a[0]?.index ?? 0), c = Me(() => ks(e), [e]), [, l] = Qe();
	B(() => c.subscribe(l), [c, l]);
	let d = c.sheet(o), f = d.error ? `Error: ${d.error}` : `${d.rows.toLocaleString()} rows × ${d.cols.toLocaleString()} cols${d.done ? "" : " · loading…"}${d.rows > 1048576 ? ` · over Excel’s ${ee.toLocaleString()}-row limit: save as CSV` : ""}`, p = Ft();
	It({
		printable: () => xs(e, b, c.sheet(b), r),
		text: (t) => e.call("xlsx.text", b, t === "tsv" ? "	" : ","),
		stats: () => {
			let e = c.sheet(b);
			return [
				["Sheets", `${r.sheets.length}${r.sheets.some((e) => e.hidden) ? ` (${r.sheets.filter((e) => e.hidden).length} hidden)` : ""}`],
				["Current sheet", r.sheets[b]?.name ?? ""],
				["Used range", `${e.rows.toLocaleString()} rows × ${e.cols.toLocaleString()} columns${e.done ? "" : " (loading)"}`]
			];
		},
		importText: async (t, n) => {
			let i = /\.(tsv|tab)$/i.test(t.name ?? "") ? "	" : void 0;
			if (e.interceptor) return m(t, n, i);
			let a = await e.call("xlsx.import", b, t, {
				name: n,
				sep: i
			});
			c.applied(a, r), p.setDirty(!0), s(b + 1);
		}
	});
	let m = async (t, n, a) => {
		let o = await t.text(), d = u(o, a ?? i(o)), f = await e.call("xlsx.bookOp", {
			op: "add",
			name: n,
			after: b
		});
		c.applied(f, r), p.setDirty(!0);
		let m = b + 1;
		s(m), await new Promise((e, t) => {
			let n = () => {}, r = () => {
				let r = c.sheet(m);
				if (r.error) t(Error(r.error));
				else if (r.done) e();
				else return;
				n();
			};
			n = c.subscribe(r), r();
		});
		let h = [];
		d.forEach((e, t) => e.forEach((e, n) => e !== "" && h.push({
			r: t,
			c: n,
			input: e
		}))), h.length && c.applied(await e.call("xlsx.set", m, h), r), l();
	}, [h, g] = H(null), [_, v] = H(null), y = async (t, n) => {
		try {
			let i = await e.call("xlsx.bookOp", t);
			c.applied(i, r), p.setDirty(!0), n !== void 0 && s(Math.max(0, Math.min(n, r.sheets.length - 1))), l();
		} catch (e) {
			js(e);
		}
	}, b = Math.min(o, r.sheets.length - 1), x = V(b);
	x.current = b;
	let S = Wn();
	B(() => {
		if (!S) return;
		let e = 0, t = (e) => {
			let t = e.root.at, n = t && "sheet" in t ? r.sheets.findIndex((e) => e.path === t.sheet) : -1;
			return n >= 0 ? {
				i: n,
				a: t
			} : null;
		};
		S.setHost({
			kind: "xlsx",
			hint: "Select a cell to comment on.",
			pending: () => {
				let e = x.current, n = r.sheets[e];
				if (!n) return null;
				let i = c.sheet(e).sel ?? {
					ar: 0,
					ac: 0
				}, a = S.threads().find((n) => {
					let r = t(n);
					return r?.i === e && r.a.r === i.ar && r.a.c === i.ac;
				});
				return {
					quote: `${n.name}!${w(i.ac)}${i.ar + 1}`,
					at: {
						sheet: n.path,
						r: i.ar,
						c: i.ac
					},
					existing: a?.root.id
				};
			},
			placed: (e) => {
				let n = [];
				for (let i of e) {
					let e = t(i);
					e && n.push({
						...i,
						quote: `${r.sheets[e.i].name}!${w(e.a.c)}${e.a.r + 1}`,
						k: [
							e.i,
							e.a.r,
							e.a.c
						]
					});
				}
				return n.sort((e, t) => e.k[0] - t.k[0] || e.k[1] - t.k[1] || e.k[2] - t.k[2]);
			},
			reveal: (n) => {
				let r = S.threads().find((e) => e.root.id === n), i = r && t(r);
				if (!i) return;
				let a = c.sheet(i.i);
				a.sel = {
					ar: i.a.r,
					ac: i.a.c,
					fr: i.a.r,
					fc: i.a.c
				}, a.goto = {
					r: i.a.r,
					c: i.a.c,
					n: ++e
				}, s(i.i), c.emit();
			}
		});
		let n = c.subscribe(() => S.touch());
		return () => {
			n(), S.setHost(null);
		};
	}, [
		S,
		c,
		r
	]);
	let C = V(null), T = V(0);
	Ri(e, {
		flush: async () => {
			await C.current?.flush();
		},
		getViewState: () => C.current?.getViewState() ?? null,
		setViewState: async (e) => {
			if (e.format !== "xlsx") return !1;
			let t = r.sheets.findIndex((t) => t.name === e.sheetName && !t.hidden), n = t >= 0 ? t : Math.min(e.sheetIndex, r.sheets.length - 1), i = c.sheet(n), a = Ni(e.topLeft), o = Ni(e.selection);
			return o && (i.sel = {
				ar: o.r0,
				ac: o.c0,
				fr: o.r1,
				fc: o.c1
			}), a && (i.topLeft = {
				r: a.r0,
				c: a.c0,
				n: ++T.current
			}), s(n), c.emit(), await Hi(() => {
				let e = C.current, t = e?.sheet === n ? e.getViewState() : null;
				return !!t && (!a || t.topLeft === ki(a.r0, a.c0));
			}, 5e3) && t >= 0;
		},
		hitTest: (e, t) => C.current?.hitTest(e, t) ?? null,
		rectsFor: (e) => "range" in e && e.sheetIndex === C.current?.sheet ? C.current.rectsFor(e) : [],
		scrollTo: async (e) => {
			if (!("range" in e)) return !1;
			let t = Math.min(e.sheetIndex, r.sheets.length - 1);
			if (t !== x.current && (s(t), !await Hi(() => C.current?.sheet === t, 3e3))) return !1;
			let n = Ni(e.range);
			return n && C.current?.scrollToCell(n.r0, n.c0), await Vi(2), !!C.current && C.current.rectsFor(e).length > 0;
		},
		selection: () => C.current?.selection() ?? null
	});
	let [E, D] = H(null), O = V(!1), te = !!E && Re(E.value) && Ps(E, Ve(E.value, E.caret));
	return /* @__PURE__ */ G("div", {
		className: "de-xlsx",
		children: [
			/* @__PURE__ */ W(Bt, {
				text: f,
				onStatus: t
			}),
			/* @__PURE__ */ W(Bs, {
				store: c,
				sheet: b,
				meta: r,
				client: e,
				edit: E,
				setEdit: D,
				hold: O,
				onSheet: s,
				api: C
			}, `${b}:${r.sheets[b]?.path}`),
			/* @__PURE__ */ G("div", {
				className: "de-tabs",
				role: "tablist",
				children: [p.editable && /* @__PURE__ */ W("button", {
					type: "button",
					className: "de-tab de-tab-add",
					title: "Add sheet",
					onClick: () => void y({
						op: "add",
						after: b
					}, b + 1),
					children: "+"
				}), r.sheets.filter((e) => !e.hidden).map((e) => h === e.index ? /* @__PURE__ */ W("input", {
					className: "de-tab-input",
					autoFocus: !0,
					defaultValue: e.name,
					onBlur: (t) => {
						g(null), t.target.value.trim() && t.target.value !== e.name && y({
							op: "rename",
							index: e.index,
							name: t.target.value
						});
					},
					onKeyDown: (e) => {
						e.key === "Enter" && e.target.blur(), e.key === "Escape" && g(null);
					}
				}, e.index) : /* @__PURE__ */ W("button", {
					type: "button",
					role: "tab",
					className: "de-tab",
					"aria-selected": e.index === b,
					onMouseDown: (t) => {
						te && (t.preventDefault(), e.index !== b && (O.current = !0));
					},
					onClick: () => s(e.index),
					onDoubleClick: () => p.editable && g(e.index),
					onContextMenu: (t) => {
						p.editable && (t.preventDefault(), v({
							index: e.index,
							x: t.clientX,
							y: t.clientY
						}));
					},
					children: e.name
				}, e.index))]
			}),
			_ && /* @__PURE__ */ W(Kt, {
				x: _.x,
				y: _.y,
				onClose: () => v(null),
				items: [
					{
						label: "Rename",
						run: () => g(_.index)
					},
					{
						label: "Duplicate name → new sheet",
						run: () => void y({
							op: "add",
							after: _.index,
							name: r.sheets[_.index].name + " (2)"
						}, _.index + 1)
					},
					{
						label: "Move left",
						disabled: _.index === 0,
						run: () => void y({
							op: "move",
							from: _.index,
							to: _.index - 1
						}, _.index - 1)
					},
					{
						label: "Move right",
						disabled: _.index >= r.sheets.length - 1,
						run: () => void y({
							op: "move",
							from: _.index,
							to: _.index + 1
						}, _.index + 1)
					},
					{
						label: "Delete sheet",
						disabled: r.sheets.length <= 1,
						run: () => void y({
							op: "delete",
							index: _.index
						}, Math.max(0, _.index - 1))
					}
				]
			})
		]
	});
}
function js(e) {
	console.error("[office-engine]", e);
}
function Ms(e) {
	return e === 255 ? {
		writingMode: "vertical-rl",
		textOrientation: "upright",
		whiteSpace: "nowrap"
	} : e === 90 ? {
		writingMode: "vertical-rl",
		transform: "rotate(180deg)",
		whiteSpace: "nowrap"
	} : e === -90 ? {
		writingMode: "vertical-rl",
		whiteSpace: "nowrap"
	} : {
		display: "inline-block",
		transform: `rotate(${-e}deg)`,
		whiteSpace: "nowrap"
	};
}
var Ns = be({
	center: "center",
	right: "flex-end",
	left: "flex-start",
	justify: "flex-start"
});
function Ps(e, t) {
	return t ? e.point && e.point.e === e.caret && e.caret === e.caretEnd ? !0 : e.caret === e.caretEnd ? t.pointable : t.refs.some((t) => t.s === e.caret && t.e === e.caretEnd) : !1;
}
var Fs = [
	"#1a73e8",
	"#e8710a",
	"#9334e6",
	"#188038",
	"#d93025",
	"#12a4b8",
	"#e52592",
	"#b08800"
], Is = (e) => e.replace(/\$/g, "").toUpperCase(), Ls = be({
	ArrowUp: [-1, 0],
	ArrowDown: [1, 0],
	ArrowLeft: [0, -1],
	ArrowRight: [0, 1]
}), Rs = (e) => ({
	r0: Math.min(e.ar, e.fr),
	c0: Math.min(e.ac, e.fc),
	r1: Math.max(e.ar, e.fr),
	c1: Math.max(e.ac, e.fc)
});
function zs(e, t) {
	let n = e;
	for (let e = !0; e;) {
		e = !1;
		for (let r of t) r.r1 < n.r0 || r.r0 > n.r1 || r.c1 < n.c0 || r.c0 > n.c1 || r.r0 >= n.r0 && r.r1 <= n.r1 && r.c0 >= n.c0 && r.c1 <= n.c1 || (n = {
			r0: Math.min(n.r0, r.r0),
			c0: Math.min(n.c0, r.c0),
			r1: Math.max(n.r1, r.r1),
			c1: Math.max(n.c1, r.c1)
		}, e = !0);
	}
	return n;
}
function Bs({ store: e, sheet: t, meta: n, client: r, edit: i, setEdit: a, hold: o, onSheet: s, api: c }) {
	let l = Ft(), u = l.editable, d = e.sheet(t), [f, p] = $e(), m = et(f), [h, g] = H(() => d.sel ?? {
		ar: 0,
		ac: 0,
		fr: 0,
		fc: 0
	});
	d.sel = h;
	let [_, v] = H(null), y = _ && _.r === h.ar && _.c === h.ac ? _.d : void 0, [b, x] = H(0), S = V(!1), C = V(null), T = V(null), ee = V(null), [E, D] = H(0), [O, te] = H(null), [ne, re] = H(null), ie = V(null), [k, oe] = H({
		open: !1,
		q: "",
		idx: 0,
		replace: !1,
		tick: 0
	}), [se, le] = H({}), [ue, de] = H([]), [fe, pe] = H(null), me = Wn(), he = qn(me), ge = Me(() => Es(me, n.sheets[t]?.path, he.active), [
		me,
		he,
		n.sheets,
		t
	]), _e = (e, t) => {
		let n = Ze(e, t);
		return ge.get(n ? n.r0 * 16384 + n.c0 : e * 16384 + t);
	}, [A, ve] = H(null), { rowAxis: M, colAxis: N, frozen: P } = d, F = Math.max(40, 12 + 7 * String(Math.max(d.rows, 1e3)).length), ye = Math.max(0, p.w - F), I = Math.max(0, p.h - Cs);
	M.count = Math.max(d.rows + (d.done ? 20 : 1), Math.ceil(I / M.def) + 1, P.rows + 1, h.fr + 2), N.count = Math.max(d.cols + 3, 26, Math.ceil(ye / Math.max(1, N.def)) + 1, P.cols + 1, h.fc + 2);
	let be = N.pos(P.cols), we = M.pos(P.rows), Te = N.total(), Ee = M.total(), De = F + Te, R = Math.min(Cs + Ee, ws), Oe = Math.max(0, Cs + Ee - p.h), z = Math.max(0, R - p.h), ke = z > 0 ? Math.min(Oe, m.y / z * Oe) : 0, Ae = m.x, Ne = be + Ae, Fe = we + ke, Ie = Math.max(0, ye - be), Le = Math.max(0, I - we), ze = M.index(Fe), Be = Math.min(M.count - 1, M.index(Fe + Le)), Ue = N.index(Ne), We = Math.min(N.count - 1, N.index(Ne + Ie)), Ge = Me(() => d.merges.filter((e) => e.r1 >= ze && e.r0 <= Be || e.r0 < P.rows ? e.c1 >= Ue && e.c0 <= We || e.c0 < P.cols : !1), [
		d.merges,
		ze,
		Be,
		Ue,
		We,
		P.rows,
		P.cols
	]);
	B(() => {
		P.rows && e.ensure(t, 0, P.rows - 1), e.ensure(t, Math.max(0, ze - 20), Be + 40);
		for (let n of Ge) n.r0 < ze && e.ensure(t, n.r0, n.r0);
	}), B(() => {
		let e = !0, { ar: n, ac: i } = h;
		return r.call("xlsx.cell", t, n, i).then((t) => e && v({
			r: n,
			c: i,
			d: t
		}), () => {}), () => {
			e = !1;
		};
	}, [
		r,
		t,
		h.ar,
		h.ac,
		d.done,
		b
	]);
	let Ye = n.styles, Xe = ds(n.baseFont.fontSize, 14.67), Ze = (e, t) => d.merges.find((n) => e >= n.r0 && e <= n.r1 && t >= n.c0 && t <= n.c1), q = zs(Rs(h), d.merges), Qe = q.r0 === q.r1 && q.c0 === q.c1 || d.merges.some((e) => e.r0 === q.r0 && e.c0 === q.c0 && e.r1 === q.r1 && e.c1 === q.c1), tt = V(q);
	tt.current = q, B(() => ae(r, {
		sheet: t,
		range: q,
		ar: h.ar,
		ac: h.ac
	}), [
		r,
		t,
		q.r0,
		q.c0,
		q.r1,
		q.c1,
		h.ar,
		h.ac
	]);
	let nt = Pe((e) => ce(r, e), () => j(r)), rt = n.sheets[t]?.path, at = nt.flatMap((e) => {
		let t = e.presence;
		return t?.k === "xlsx" && t.sheet === rt && t.range ? [{
			...e,
			range: t.range,
			ar: t.ar ?? t.range.r0,
			ac: t.ac ?? t.range.c0
		}] : [];
	});
	je(() => {
		o.current = !1;
		let t = f.current;
		return t && d.scrollPos && (t.scrollLeft = d.scrollPos.x, t.scrollTop = d.scrollPos.y), e.focusGrid ? (e.focusGrid = !1, t?.focus({ preventScroll: !0 })) : it(t ?? null), () => {
			t?.isConnected && (d.scrollPos = {
				x: t.scrollLeft,
				y: t.scrollTop
			});
		};
	}, []);
	let ot = (e) => {
		let t = Ze(e.ar, e.ac);
		t && (e = {
			...e,
			ar: t.r0,
			ac: t.c0
		}), g(e);
	};
	function J(n, r, i, a, o, s, c, l, u, f, p) {
		if (f <= 0 || p <= 0 || i < r || o < a) return null;
		let m = [];
		if (d.gridLines) {
			for (let e = r; e <= i; e++) m.push(/* @__PURE__ */ W("div", {
				className: "de-gl-h",
				style: { top: M.pos(e + 1) - c - 1 }
			}, "h" + e));
			for (let e = a; e <= o; e++) m.push(/* @__PURE__ */ W("div", {
				className: "de-gl-v",
				style: { left: N.pos(e + 1) - s - 1 }
			}, "v" + e));
		}
		let g = /* @__PURE__ */ new Set(), _ = [];
		for (let e of Ge) if (!(e.r1 < r || e.r0 > i || e.c1 < a || e.c0 > o)) {
			_.push(e);
			for (let t = Math.max(e.r0, r); t <= Math.min(e.r1, i); t++) for (let n = Math.max(e.c0, a); n <= Math.min(e.c1, o); n++) g.add(t * 16384 + n);
		}
		let v = (e, t, n, r, i, a = !1) => {
			let [l, u, d, f, p] = t, m = n ?? N.size(l), h = r ?? M.size(e);
			if (!m || !h) return null;
			let _ = Ye[d] ?? {}, v = u;
			f === 1 && u && (v = fs(u, m - 6, ds(_.fontSize, Xe)));
			let { textAlign: y, textRotate: b, alignItems: x, whiteSpace: S, ...C } = _;
			C.background !== void 0 && (C.background = xe(C.background));
			let w = Number(b ?? 0), T = y && Ns[y] || (f === 1 ? "flex-end" : f === 2 ? "center" : "flex-start"), ee = 0;
			if (v && !w && !S && T === "flex-start" && !a && i) {
				let t = l + 1;
				for (; t <= o + 8 && !i.has(t) && !g.has(e * 16384 + t);) t++;
				ee = N.pos(t) - N.pos(l);
			}
			let E = {
				...C,
				left: N.pos(l) - s,
				top: M.pos(e) - c,
				width: m,
				height: h,
				justifyContent: T,
				alignItems: x ?? "flex-end",
				textAlign: y ?? void 0
			};
			p && (E.color = L(p)), S && (E.whiteSpace = S), a && !C.background && (E.background = "linear-gradient(#fff, #fff) 0 0 / calc(100% - 1px) calc(100% - 1px) no-repeat");
			let D = ee > m;
			return /* @__PURE__ */ W("div", {
				className: D ? "de-cell de-ov" : "de-cell",
				style: E,
				children: v && /* @__PURE__ */ W("span", {
					style: w ? Ms(w) : D ? {
						maxWidth: ee - 6,
						overflow: "hidden",
						flex: "none"
					} : void 0,
					children: v
				})
			}, `${e}:${l}`);
		};
		for (let n of _) {
			let r = e.row(t, n.r0)?.find((e) => e[0] === n.c0) ?? [
				n.c0,
				"",
				0,
				0
			];
			m.push(v(n.r0, r, N.pos(n.c1 + 1) - N.pos(n.c0), M.pos(n.r1 + 1) - M.pos(n.r0), void 0, !0));
		}
		for (let n = r; n <= i; n++) {
			let r = e.row(t, n);
			if (!r) continue;
			let i;
			for (let e of r) {
				let t = e[0];
				t < a - 8 || t > o || g.has(n * 16384 + t) || t < a && (!e[1] || e[3] !== 0) || _.some((e) => e.r0 === n && e.c0 === t) || (!i && e[3] === 0 && e[1] && (i = new Set(r.filter((e) => e[1] !== "").map((e) => e[0]))), m.push(v(n, e, void 0, void 0, i)));
			}
		}
		if (q.r1 >= r && q.r0 <= i && q.c1 >= a && q.c0 <= o && !Qe && m.push(/* @__PURE__ */ W("div", {
			className: "de-range",
			style: {
				left: N.pos(q.c0) - s,
				top: M.pos(q.r0) - c,
				width: N.pos(q.c1 + 1) - N.pos(q.c0),
				height: M.pos(q.r1 + 1) - M.pos(q.r0)
			}
		}, "range")), h.ar >= r - 1 && h.ar <= i && h.ac >= a - 1 && h.ac <= o) {
			let e = Ze(h.ar, h.ac), t = e ? N.pos(e.c1 + 1) - N.pos(e.c0) : N.size(h.ac), n = e ? M.pos(e.r1 + 1) - M.pos(e.r0) : M.size(h.ar);
			m.push(/* @__PURE__ */ W("div", {
				className: "de-sel",
				style: {
					left: N.pos(h.ac) - s - 1,
					top: M.pos(h.ar) - c - 1,
					width: t + 1,
					height: n + 1
				}
			}, "sel"));
		}
		for (let [e, t] of ge) {
			let n = Math.floor(e / 16384), l = e % 16384;
			if (n < r || n > i || l < a || l > o) continue;
			let u = Ze(n, l), d = N.pos((u ? u.c1 : l) + 1);
			m.push(/* @__PURE__ */ W("div", {
				className: "de-cm-mark" + (he.active === t ? " on" : ""),
				style: {
					left: d - s - 8,
					top: M.pos(n) - c
				}
			}, "cm" + t));
		}
		for (let e of at) {
			let t = e.range;
			if (t.r1 < r || t.r0 > i || t.c1 < a || t.c0 > o) continue;
			let n = N.pos(t.c0), l = M.pos(t.r0), u = N.pos(t.c1 + 1), d = M.pos(t.r1 + 1), f = L(e.color);
			m.push(/* @__PURE__ */ W("div", {
				className: "de-peer-range",
				style: {
					left: n - s - 1,
					top: l - c - 1,
					width: u - n + 1,
					height: d - l + 1,
					borderColor: f,
					background: f && f + "12"
				},
				children: e.ar >= r && e.ar <= i && e.ac >= a && e.ac <= o && /* @__PURE__ */ W("span", {
					className: "de-peer-tag",
					style: { background: f },
					children: e.name
				})
			}, "peer" + e.site));
		}
		return bn.forEach((e, t) => {
			e.r < r || e.r > i || e.c < a || e.c > o || m.push(/* @__PURE__ */ W("div", {
				className: t === k.idx ? "de-findcell on" : "de-findcell",
				style: {
					left: N.pos(e.c) - s,
					top: M.pos(e.r) - c,
					width: N.size(e.c),
					height: M.size(e.r)
				}
			}, "fm" + t));
		}), Pt.forEach((e, t) => {
			if (e.r1 < r || e.r0 > i || e.c1 < a || e.c0 > o) return;
			let n = M.pos(Math.max(e.r0, r - 1)), l = M.pos(Math.min(e.r1, i + 1) + 1), u = N.pos(Math.max(e.c0, a - 1)), d = N.pos(Math.min(e.c1, o + 1) + 1);
			m.push(/* @__PURE__ */ W("div", {
				className: e.point ? "de-fref de-fref-pt" : "de-fref",
				style: {
					left: u - s - 1,
					top: n - c - 1,
					width: d - u + 1,
					height: l - n + 1,
					borderColor: L(e.color),
					background: L(e.color) && e.color + "14"
				}
			}, "fr" + t));
		}), /* @__PURE__ */ W("div", {
			className: "de-region",
			style: {
				left: l,
				top: u,
				width: f,
				height: p
			},
			children: m
		}, n);
	}
	function st(e, t, n, r, i, a) {
		if (a <= 0) return null;
		let o = [];
		for (let e = t; e <= n; e++) {
			let t = N.size(e);
			t && (o.push(/* @__PURE__ */ W("div", {
				"data-col": e,
				className: e >= q.c0 && e <= q.c1 ? "de-head-c de-head-on" : "de-head-c",
				style: {
					left: N.pos(e) - r,
					top: 0,
					width: t,
					height: Cs
				},
				children: w(e)
			}, e)), u && o.push(/* @__PURE__ */ W("div", {
				"data-grip-col": e,
				className: "de-grip-c",
				style: {
					left: N.pos(e + 1) - r - 3,
					height: Cs
				}
			}, "g" + e)));
		}
		return /* @__PURE__ */ W("div", {
			className: "de-region",
			style: {
				left: i,
				top: 0,
				width: a,
				height: Cs
			},
			children: o
		}, e);
	}
	function ct(e, t, n, r, i, a) {
		if (a <= 0) return null;
		let o = [];
		for (let e = t; e <= n; e++) {
			let t = M.size(e);
			t && (o.push(/* @__PURE__ */ W("div", {
				"data-row": e,
				className: e >= q.r0 && e <= q.r1 ? "de-head-r de-head-on" : "de-head-r",
				style: {
					left: 0,
					top: M.pos(e) - r,
					width: F,
					height: t
				},
				children: e + 1
			}, e)), u && o.push(/* @__PURE__ */ W("div", {
				"data-grip-row": e,
				className: "de-grip-r",
				style: {
					top: M.pos(e + 1) - r - 3,
					width: F
				}
			}, "g" + e)));
		}
		return /* @__PURE__ */ W("div", {
			className: "de-region",
			style: {
				left: 0,
				top: i,
				width: F,
				height: a
			},
			children: o
		}, e);
	}
	let lt = P.rows, Y = P.cols, X = Math.min(be, ye), Z = Math.min(we, I), ut = (e, t) => {
		let n = Ze(e, t);
		return {
			x: F + N.pos(t) - (t >= Y ? Ae : 0),
			y: Cs + M.pos(e) - (e >= lt ? ke : 0),
			w: n ? N.pos(n.c1 + 1) - N.pos(n.c0) : N.size(t),
			h: n ? M.pos(n.r1 + 1) - M.pos(n.r0) : M.size(e)
		};
	}, dt = (e, t) => {
		let n = f.current;
		if (!n) return;
		let r = N.pos(t), i = M.pos(e);
		if (t >= Y && (r - be < Ae ? n.scrollLeft = r - be : r + N.size(t) > Ne + Ie && (n.scrollLeft = r + N.size(t) - be - Ie)), e >= lt && Oe > 0) {
			let t = ke;
			i - we < ke ? t = i - we : i + M.size(e) > Fe + Le && (t = i + M.size(e) - we - Le), t !== ke && (n.scrollTop = t / Oe * z);
		}
	}, ft = d.goto?.n;
	B(() => {
		let e = d.goto;
		e && (ot({
			ar: e.r,
			ac: e.c,
			fr: e.r,
			fc: e.c
		}), dt(e.r, e.c));
	}, [ft]);
	let pt = d.topLeft?.n, mt = V(0);
	B(() => {
		let e = d.topLeft, t = f.current;
		if (!e || !t || mt.current === e.n) return;
		let n = Math.max(0, N.pos(e.c) - be), r = Math.max(0, M.pos(e.r) - we), i = Oe > 0 ? Math.min(r, Oe) / Oe * z : 0;
		t.scrollLeft = n, t.scrollTop = i, (d.done || Math.abs(t.scrollLeft - n) < 1 && Math.abs(t.scrollTop - i) < 1 && r <= Oe) && (mt.current = e.n);
	}, [
		pt,
		d.done,
		d.rows,
		p.w,
		p.h
	]);
	let ht = (e, t, n) => {
		let r = n.getBoundingClientRect(), i = e - r.left - F, a = t - r.top - Cs, o = i < be ? i : i + Ae, s = a < we ? a : a + ke;
		return {
			r: a < 0 ? -1 : M.index(Math.max(0, s)),
			c: i < 0 ? -1 : N.index(Math.max(0, o))
		};
	}, gt = () => f.current?.focus({ preventScroll: !0 }), _t = () => ot({
		ar: 0,
		ac: 0,
		fr: Math.max(0, d.rows - 1),
		fc: Math.max(0, d.cols - 1)
	});
	Lt(() => {
		i || (gt(), _t());
	});
	let vt = (n, r) => e.row(t, n)?.find((e) => e[0] === r)?.[2] ?? 0, yt = V(/* @__PURE__ */ new Set()), bt = (e) => {
		let t = xt(e);
		return yt.current.add(t), t.finally(() => yt.current.delete(t)), t;
	}, xt = async (t) => {
		try {
			let r = await t;
			e.applied(r, n), r && l.setDirty(!0), x((e) => e + 1);
		} catch (e) {
			typeof e.code != "string" && console.error("[office-engine]", e), pe(e.message);
		}
	}, St = (r, i, a) => r ? r.formula ? r.formula : r.type === "number" && /[dmyhs]/i.test((n.formats[vt(i, a)] ?? "").replace(/"[^"]*"|\[[^\]]*\]/g, "")) ? e.row(t, i)?.find((e) => e[0] === a)?.[1] ?? r.value : r.value : "", Ct = async (e, n = !1) => {
		if (!u || !d.done || i) return;
		let { ar: o, ac: s } = h, c = (e, r, i) => a({
			sheet: t,
			r: o,
			c: s,
			value: e,
			initial: r,
			bar: n,
			mode: i,
			caret: e.length,
			caretEnd: e.length,
			sync: +!n
		});
		if (e !== void 0) return c(e, "\0", "enter");
		let l = _ && _.r === o && _.c === s ? _.d : await r.call("xlsx.cell", t, o, s).catch(() => void 0), f = St(l, o, s);
		c(f, f, "edit");
	}, wt = V(null), Tt = (e) => {
		let n = i;
		if (!n || wt.current === n) return;
		wt.current = n, a(null);
		let o = He(n.value);
		if (o !== n.initial && bt(r.call("xlsx.set", n.sheet, [{
			r: n.r,
			c: n.c,
			input: o
		}])), n.sheet !== t) return Dt(n, e);
		e && Xt(e[0], e[1], !1), gt();
	}, Et = () => {
		let e = i;
		if (e && wt.current !== e) {
			if (wt.current = e, a(null), e.sheet !== t) return Dt(e);
			gt();
		}
	}, Dt = (t, n) => {
		let r = Math.max(0, t.r + (n?.[0] ?? 0)), i = Math.max(0, t.c + (n?.[1] ?? 0));
		e.sheet(t.sheet).sel = {
			ar: r,
			ac: i,
			fr: r,
			fc: i
		}, e.focusGrid = !0, s(t.sheet);
	}, Ot = !!i && i.sheet === t, kt = Ot && !i?.bar, At = i && Re(i.value) ? Ve(i.value, i.caret) : null, jt = !!i && Ps(i, At), Mt = !!i?.point && i.point.e === i.caret && i.caret === i.caretEnd, Nt = [], Pt = [];
	if (At && i) {
		let e = /* @__PURE__ */ new Map();
		for (let r of At.refs) {
			let a = Is(r.text), o = e.get(a);
			o || e.set(a, o = Fs[e.size % Fs.length]), Nt.push({
				s: r.s,
				e: r.e,
				color: o
			});
			let s = r.ref.sheet;
			(s === void 0 ? i.sheet : n.sheets.findIndex((e) => e.name.toLowerCase() === s.toLowerCase())) === t && Pt.push({
				r0: r.ref.r0,
				c0: r.ref.c0,
				r1: r.ref.r1,
				c1: r.ref.c1,
				color: o,
				point: Mt && r.s === i.point.s
			});
		}
	}
	let It = At?.word && i?.noSuggest !== At.word.s && i?.caret === i?.caretEnd ? At.word : void 0, Rt = It ? qe(It.text, 8) : [], zt = !Rt.length && At?.call ? Ke(At.call.name) : void 0, Bt = It ? `${It.s}:${It.text}` : "";
	B(() => D(0), [Bt]);
	let Vt = () => kt ? C.current : ee.current;
	je(() => {
		if (!i) return;
		let e = Vt();
		e && (e.getRootNode().activeElement !== e && e.focus({ preventScroll: !0 }), i.sync && e.setSelectionRange(i.caret, i.caretEnd));
	}, [
		i?.sync,
		kt,
		i !== null
	]);
	let Ht = (e) => {
		let t = e.selectionStart ?? e.value.length, n = e.selectionEnd ?? t;
		a((e) => e && (e.caret !== t || e.caretEnd !== n) ? {
			...e,
			caret: t,
			caretEnd: n
		} : e);
	}, Ut = (e) => {
		let t = e.value, n = e.selectionStart ?? t.length, r = e.selectionEnd ?? n;
		a((e) => e && {
			...e,
			value: t,
			caret: n,
			caretEnd: r,
			point: void 0
		});
	}, Wt = (e, r, i, o) => {
		a((a) => {
			if (!a) return a;
			let s = K(e, r, i, o, t === a.sheet ? void 0 : n.sheets[t]?.name), c = a.point && a.point.e === a.caret && a.caret === a.caretEnd, l = c ? a.point.s : a.caret, u = c ? a.point.e : a.caretEnd;
			if (c && a.value.slice(l, u) === s) return a;
			let d = l + s.length;
			return {
				...a,
				value: a.value.slice(0, l) + s + a.value.slice(u),
				caret: d,
				caretEnd: d,
				sync: a.sync + 1,
				point: {
					s: l,
					e: d,
					sheet: t,
					ar: e,
					ac: r,
					fr: i,
					fc: o
				}
			};
		});
	}, Gt = V(null), qt = (e, n, r) => {
		let a = i?.point && Mt && i.point.sheet === t ? i.point : null, o = a ? a.ar : Ot ? i.r : h.ar, s = a ? a.ac : Ot ? i.c : h.ac, c = (e) => Math.max(0, Math.min(M.count - 1, e)), l = (e) => Math.max(0, Math.min(N.count - 1, e));
		if (r) {
			let t = c((a ? a.fr : o) + e), r = l((a ? a.fc : s) + n);
			Wt(o, s, t, r), dt(t, r);
		} else {
			let t = c(o + e), r = l(s + n);
			Wt(t, r, t, r), dt(t, r);
		}
	}, Jt = (e) => {
		let t = It;
		t && a((n) => {
			if (!n) return n;
			let r = !e.args.length && !e.variadic, i = e.name + (t.call ? "" : r ? "()" : "("), a = t.s + e.name.length + (r && !t.call ? 2 : 1);
			return {
				...n,
				value: n.value.slice(0, t.s) + i + n.value.slice(t.e),
				caret: a,
				caretEnd: a,
				sync: n.sync + 1,
				point: void 0
			};
		});
	}, Xt = (e, t, n) => {
		let r = n ? h.fr : h.ar, i = n ? h.fc : h.ac, a = n ? void 0 : Ze(h.ar, h.ac), o = r + e, s = i + t;
		for (a && e > 0 && (o = a.r1 + e), a && t > 0 && (s = a.c1 + t), o = Math.max(0, Math.min(M.count - 1, o)), s = Math.max(0, Math.min(N.count - 1, s)); o > 0 && M.size(o) === 0 && e < 0;) o--;
		for (; M.size(o) === 0 && o < M.count - 1;) o++;
		for (; s > 0 && N.size(s) === 0 && t < 0;) s--;
		for (; N.size(s) === 0 && s < N.count - 1;) s++;
		n ? g({
			...h,
			fr: o,
			fc: s
		}) : ot({
			ar: o,
			ac: s,
			fr: o,
			fc: s
		}), dt(o, s);
	}, Zt = () => {
		let n = [], i = {
			...q,
			r1: Math.min(q.r1, q.r0 + 5e3),
			c1: Math.min(q.c1, q.c0 + 200)
		};
		for (let r = i.r0; r <= i.r1; r++) {
			let a = e.row(t, r);
			for (let e = i.c0; e <= i.c1; e++) a?.some((t) => t[0] === e && t[1] !== "") && n.push({
				r,
				c: e,
				input: ""
			});
		}
		n.length && bt(r.call("xlsx.set", t, n));
	}, Qt = Ye[vt(h.ar, h.ac)] ?? {}, $t = (e) => en(q, e), en = (e, n) => {
		bt(r.call("xlsx.format", t, e, n)), gt();
	}, tn = (e) => {
		let t = e === "b" ? Qt.fontWeight === 700 : e === "i" ? Qt.fontStyle === "italic" : String(Qt.textDecoration ?? "").includes(e === "u" ? "underline" : "line-through");
		$t({ [e]: !t });
	}, nn = () => void bt(r.call("xlsx.undo")), rn = () => void bt(r.call("xlsx.redo")), an = () => {
		let n = [], r = {
			...q,
			r1: Math.min(q.r1, q.r0 + 2e4)
		};
		for (let i = r.r0; i <= r.r1; i++) {
			let a = e.row(t, i), o = [];
			for (let e = r.c0; e <= r.c1; e++) o.push(a?.find((t) => t[0] === e)?.[1] ?? "");
			n.push(o.join("	"));
		}
		return n.join("\n");
	}, on = (e) => {
		if (i) return;
		let t = e.metaKey || e.ctrlKey, n = e.key.toLowerCase();
		if (t && n === "s") {
			e.preventDefault(), l.save();
			return;
		}
		if (t && n === "a" && !e.altKey && !e.shiftKey) {
			e.preventDefault(), _t();
			return;
		}
		if (u && t && !e.altKey) {
			if (n === "z") {
				e.preventDefault(), e.shiftKey ? rn() : nn();
				return;
			}
			if (n === "y") {
				e.preventDefault(), rn();
				return;
			}
			if (n === "b" || n === "i" || n === "u") {
				e.preventDefault(), tn(n);
				return;
			}
			if (n === "d" || n === "r") {
				e.preventDefault(), ln({
					op: "fill",
					range: q,
					dir: n === "d" ? "down" : "right"
				});
				return;
			}
			if (n === "\\") {
				e.preventDefault(), $t({ clear: !0 });
				return;
			}
			if (n === "x" && e.shiftKey) {
				e.preventDefault(), tn("strike");
				return;
			}
		}
		if (t && (n === "f" || n === "h")) {
			e.preventDefault(), oe((e) => ({
				...e,
				open: !0,
				replace: n === "h" || e.replace,
				tick: e.tick + 1
			}));
			return;
		}
		if (e.key === "Escape" && ne !== null) {
			re(null);
			return;
		}
		let r = Math.max(1, Math.floor(Le / M.def) - 1), a = {
			ArrowUp: [-1, 0],
			ArrowDown: [1, 0],
			ArrowLeft: [0, -1],
			ArrowRight: [0, 1],
			PageDown: [r, 0],
			PageUp: [-r, 0]
		};
		if (a[e.key]) {
			e.preventDefault();
			let [n, r] = a[e.key];
			t ? Xt(n ? n > 0 ? Math.max(0, d.rows - 1 - (e.shiftKey ? h.fr : h.ar)) : -1e9 : 0, r ? r > 0 ? Math.max(0, d.cols - 1 - (e.shiftKey ? h.fc : h.ac)) : -1e9 : 0, e.shiftKey) : Xt(n, r, e.shiftKey);
		} else e.key === "Enter" || e.key === "Tab" ? (e.preventDefault(), e.key === "Enter" ? Xt(e.shiftKey ? -1 : 1, 0, !1) : Xt(0, e.shiftKey ? -1 : 1, !1)) : u && (e.key === "F2" ? (e.preventDefault(), Ct()) : e.key === "Delete" || e.key === "Backspace" ? (e.preventDefault(), Zt()) : e.key.length === 1 && !t && !e.altKey && (e.preventDefault(), Ct(e.key)));
	}, sn = (e) => {
		if (e.button !== 0) return;
		let n = e.target.closest("[data-grip-col],[data-grip-row]");
		if (n) {
			e.preventDefault();
			let t = n.dataset.gripCol, r = Number(t ?? n.dataset.gripRow);
			ve(t === void 0 ? {
				axis: "row",
				i: r,
				start: e.clientY,
				size: M.size(r)
			} : {
				axis: "col",
				i: r,
				start: e.clientX,
				size: N.size(r)
			});
			return;
		}
		let r = e.currentTarget, { r: a, c: o } = ht(e.clientX, e.clientY, r);
		if (i && jt) {
			if (e.preventDefault(), a < 0 && o < 0) return;
			let n = a < 0 ? "col" : o < 0 ? "row" : "cell", [r, s] = [Math.max(a, 0), Math.max(o, 0)], c = n === "cell" ? Ze(a, o) : void 0;
			c && ([r, s] = [c.r0, c.c0]);
			let l = e.shiftKey && Mt && i.point.sheet === t ? i.point : null;
			l && ([r, s] = [l.ar, l.ac]), Gt.current = {
				ar: r,
				ac: s,
				axis: n
			}, cn(r, s, a, o, n);
		} else {
			if (i && Tt(), e.preventDefault(), ne !== null && a >= 0 && o >= 0) {
				let e = ne;
				ie.current = () => {
					re(null), en(tt.current, { xf: e });
				};
			}
			if (gt(), a < 0 && o < 0) ot({
				ar: 0,
				ac: 0,
				fr: Math.max(0, d.rows - 1),
				fc: Math.max(0, d.cols - 1)
			});
			else {
				if (a < 0) ot({
					ar: 0,
					ac: o,
					fr: Math.max(0, d.rows - 1),
					fc: o
				});
				else if (o < 0) ot({
					ar: a,
					ac: 0,
					fr: a,
					fc: Math.max(0, d.cols - 1)
				});
				else if (e.shiftKey) g({
					...h,
					fr: a,
					fc: o
				});
				else {
					ot({
						ar: a,
						ac: o,
						fr: a,
						fc: o
					});
					let e = _e(a, o);
					e ? me?.select(e, !1) : he.active && me?.select(null);
				}
				a >= 0 && o >= 0 && (S.current = !0);
			}
		}
	}, cn = (e, t, n, r, i) => {
		if (i === "col") Wt(0, t, Ce, Math.max(0, r));
		else if (i === "row") Wt(e, 0, Math.max(0, n), Se);
		else {
			let i = Ze(n, r), a = i && !(e >= i.r0 && e <= i.r1 && t >= i.c0 && t <= i.c1) ? i : void 0, o = a ? a.r0 < e ? a.r0 : a.r1 : Math.max(0, n), s = a ? a.c0 < t ? a.c0 : a.c1 : Math.max(0, r);
			Wt(e, t, o, s);
		}
	};
	B(() => {
		let e = () => {
			S.current = !1, Gt.current = null;
			let e = ie.current;
			ie.current = null, e && setTimeout(e, 0);
		};
		return window.addEventListener("mouseup", e), () => window.removeEventListener("mouseup", e);
	}, []), B(() => {
		if (!A) return;
		let e = A.axis === "col" ? N : M, t = (t) => {
			let n = (A.axis === "col" ? t.clientX : t.clientY) - A.start;
			e.set(A.i, Math.max(A.axis === "col" ? 8 : 6, Math.round(A.size + n))), x((e) => e + 1);
		}, n = () => {
			let t = e.size(A.i);
			ve(null);
			let [n, r] = (A.axis === "col" ? q.r0 === 0 && q.r1 >= d.rows - 1 && A.i >= q.c0 && A.i <= q.c1 : q.c0 === 0 && q.c1 >= d.cols - 1 && A.i >= q.r0 && A.i <= q.r1) ? A.axis === "col" ? [q.c0, q.c1] : [q.r0, q.r1] : [A.i, A.i];
			ln(A.axis === "col" ? {
				op: "colWidth",
				c0: n,
				c1: r,
				px: t
			} : {
				op: "rowHeight",
				r0: n,
				r1: r,
				px: t
			});
		};
		return window.addEventListener("mousemove", t), window.addEventListener("mouseup", n, { once: !0 }), () => {
			window.removeEventListener("mousemove", t), window.removeEventListener("mouseup", n);
		};
	});
	let ln = (e) => bt(r.call("xlsx.sheetOp", t, e)), un = d.merges.some((e) => e.r0 >= q.r0 && e.r1 <= q.r1 && e.c0 >= q.c0 && e.c1 <= q.c1), dn = () => void ln({
		op: un ? "unmerge" : "merge",
		range: q
	}), fn = (e) => void ln(e === "unmerge" ? {
		op: "unmerge",
		range: q
	} : {
		op: "merge",
		range: q,
		mode: e
	}), pn = (e) => void ln({
		op: "freeze",
		rows: e === "row" ? 1 : e === "sel" ? h.ar : 0,
		cols: e === "col" ? 1 : e === "sel" ? h.ac : 0
	}), mn = (n = "SUM") => {
		let { ar: i, ac: a } = h;
		if (!Qe) {
			let e = `${w(q.c0)}${q.r0 + 1}:${w(q.c1)}${q.r1 + 1}`;
			bt(r.call("xlsx.set", t, [{
				r: q.r1 + 1,
				c: q.c0,
				input: `=${n}(${e})`
			}]));
			return;
		}
		let o = (n, r) => e.row(t, n)?.find((e) => e[0] === r)?.[3] === 1, s = i - 1;
		for (; s >= 0 && o(s, a);) s--;
		let c = "";
		if (s < i - 1) c = `${w(a)}${s + 2}:${w(a)}${i}`;
		else {
			let e = a - 1;
			for (; e >= 0 && o(i, e);) e--;
			e < a - 1 && (c = `${w(e + 1)}${i + 1}:${w(a - 1)}${i + 1}`);
		}
		if (!c) return void Ct(`=${n}(`);
		bt(r.call("xlsx.set", t, [{
			r: i,
			c: a,
			input: `=${n}(${c})`
		}]));
	}, hn = (e) => {
		let t = q.r0 === q.r1 ? {
			r0: P.rows,
			c0: 0,
			r1: Math.max(P.rows, d.rows - 1),
			c1: Math.max(0, d.cols - 1)
		} : q;
		ln({
			op: "sort",
			range: t,
			col: h.ac,
			desc: e
		});
	}, gn = (e) => {
		let t = q.r1 - q.r0 + 1, n = q.c1 - q.c0 + 1, r = {
			rowAbove: {
				op: "insertRows",
				at: q.r0,
				n: t
			},
			rowBelow: {
				op: "insertRows",
				at: q.r1 + 1,
				n: t
			},
			colLeft: {
				op: "insertCols",
				at: q.c0,
				n
			},
			colRight: {
				op: "insertCols",
				at: q.c1 + 1,
				n
			},
			delRow: {
				op: "deleteRows",
				at: q.r0,
				n: t
			},
			delCol: {
				op: "deleteCols",
				at: q.c0,
				n
			},
			hideRows: {
				op: "hideRows",
				a: q.r0,
				b: q.r1,
				hidden: !0
			},
			hideCols: {
				op: "hideCols",
				a: q.c0,
				b: q.c1,
				hidden: !0
			},
			unhideRows: {
				op: "hideRows",
				a: Math.max(0, q.r0 - +(t === 1)),
				b: q.r1 + +(t === 1),
				hidden: !1
			},
			unhideCols: {
				op: "hideCols",
				a: Math.max(0, q.c0 - +(n === 1)),
				b: q.c1 + +(n === 1),
				hidden: !1
			}
		};
		r[e] && ln(r[e]);
	}, _n = (e) => {
		let n = e.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n").flatMap((e, t) => e.split("	").map((e, n) => ({
			r: h.ar + t,
			c: h.ac + n,
			input: e
		})));
		n.length && bt(r.call("xlsx.set", t, n.slice(0, 1e5)));
	}, vn = () => {
		let e = q.r1 - q.r0 + 1, t = q.c1 - q.c0 + 1, n = e === 1 ? `row ${q.r0 + 1}` : `rows ${q.r0 + 1}–${q.r1 + 1}`, r = t === 1 ? `column ${w(q.c0)}` : `columns ${w(q.c0)}–${w(q.c1)}`, i = e === 1 && t === 1, a = _e(h.ar, h.ac), o = a ? [{
			label: "Show comment",
			icon: "comment",
			run: () => me?.select(a)
		}] : me?.canComment ? [{
			label: "Comment",
			icon: "commentAdd",
			hint: Yn,
			run: () => me.start()
		}] : [];
		return [
			...o,
			{
				label: "Cut",
				icon: "cut",
				hint: `${Q}X`,
				sep: o.length > 0,
				run: () => document.execCommand("cut")
			},
			{
				label: "Copy",
				icon: "copy",
				hint: `${Q}C`,
				run: () => document.execCommand("copy")
			},
			{
				label: "Paste",
				icon: "paste",
				hint: `${Q}V`,
				run: () => void navigator.clipboard?.readText().then(_n).catch(() => pe(`The browser blocked clipboard access — use ${Q}V to paste`))
			},
			{
				label: `Insert ${e} row${e > 1 ? "s" : ""} above`,
				icon: "rowAbove",
				sep: !0,
				run: () => gn("rowAbove")
			},
			{
				label: `Insert ${e} row${e > 1 ? "s" : ""} below`,
				icon: "rowBelow",
				run: () => gn("rowBelow")
			},
			{
				label: `Insert ${t} column${t > 1 ? "s" : ""} left`,
				icon: "colLeft",
				run: () => gn("colLeft")
			},
			{
				label: `Insert ${t} column${t > 1 ? "s" : ""} right`,
				icon: "colRight",
				run: () => gn("colRight")
			},
			{
				label: `Delete ${n}`,
				icon: "delRow",
				sep: !0,
				run: () => gn("delRow")
			},
			{
				label: `Delete ${r}`,
				icon: "delCol",
				run: () => gn("delCol")
			},
			{
				label: `Hide ${n}`,
				icon: "hide",
				sep: !0,
				run: () => gn("hideRows")
			},
			{
				label: `Hide ${r}`,
				icon: "hide",
				run: () => gn("hideCols")
			},
			{
				label: "Unhide rows",
				icon: "view",
				run: () => gn("unhideRows")
			},
			{
				label: "Unhide columns",
				icon: "view",
				run: () => gn("unhideCols")
			},
			{
				label: un ? "Unmerge cells" : "Merge cells",
				icon: "merge",
				sep: !0,
				run: dn,
				disabled: i && !un
			},
			{
				label: `Sort ${i ? "sheet" : "range"} by ${w(h.ac)}, A → Z`,
				icon: "sortAZ",
				run: () => hn(!1)
			},
			{
				label: `Sort ${i ? "sheet" : "range"} by ${w(h.ac)}, Z → A`,
				icon: "sortZA",
				run: () => hn(!0)
			},
			{
				label: "Fill down",
				icon: "down",
				hint: `${Q}D`,
				run: () => void ln({
					op: "fill",
					range: q,
					dir: "down"
				}),
				disabled: e === 1
			},
			{
				label: "Fill right",
				hint: `${Q}R`,
				run: () => void ln({
					op: "fill",
					range: q,
					dir: "right"
				}),
				disabled: t === 1
			},
			{
				label: "Clear contents",
				icon: "trash",
				hint: "Del",
				sep: !0,
				run: Zt
			},
			{
				label: "Clear formatting",
				icon: "clear",
				hint: `${Q}\\`,
				run: () => $t({ clear: !0 })
			},
			{
				label: `Freeze up to ${w(h.ac)}${h.ar + 1}`,
				icon: "freeze",
				sep: !0,
				run: () => pn("sel")
			},
			{
				label: "Unfreeze",
				run: () => pn("none"),
				disabled: !P.rows && !P.cols
			}
		];
	};
	B(() => {
		if (!k.open || !k.q) {
			de([]);
			return;
		}
		let e = !0, n = setTimeout(() => {
			r.call("xlsx.find", t, k.q, se).then((t) => e && de(t), () => {});
		}, 150);
		return () => {
			e = !1, clearTimeout(n);
		};
	}, [
		r,
		t,
		k.open,
		k.q,
		k.tick,
		se,
		b
	]);
	let yn = (e) => {
		let t = ue[e];
		t && (oe((t) => ({
			...t,
			idx: e
		})), ot({
			ar: t.r,
			ac: t.c,
			fr: t.r,
			fc: t.c
		}), dt(t.r, t.c));
	}, bn = k.open ? ue : [], xn = (e) => {
		let t = Gt.current;
		if (t) {
			let { r: n, c: r } = ht(e.clientX, e.clientY, e.currentTarget);
			cn(t.ar, t.ac, n, r, t.axis);
			return;
		}
		if (!S.current) return;
		let { r: n, c: r } = ht(e.clientX, e.clientY, e.currentTarget);
		n >= 0 && r >= 0 && (n !== h.fr || r !== h.fc) && g((e) => ({
			...e,
			fr: n,
			fc: r
		}));
	}, Sn = i && Ot ? ut(i.r, i.c) : null, Cn = i ? i.value : St(y, h.ar, h.ac), wn = (e) => {
		if (!i || e.nativeEvent.isComposing) return;
		let t = e.metaKey || e.ctrlKey;
		if (Rt.length) {
			if (e.key === "ArrowDown" || e.key === "ArrowUp") {
				e.preventDefault();
				let t = Rt.length;
				D((n) => (Math.min(n, t - 1) + (e.key === "ArrowDown" ? 1 : t - 1)) % t);
				return;
			}
			if (e.key === "Tab" || e.key === "Enter" && !e.altKey && !e.shiftKey) {
				e.preventDefault(), Jt(Rt[Math.min(E, Rt.length - 1)]);
				return;
			}
			if (e.key === "Escape") {
				e.preventDefault();
				let t = It?.s;
				a((e) => e && {
					...e,
					noSuggest: t
				});
				return;
			}
		}
		let n = Ls[e.key];
		if (n && !t && !e.altKey && i.mode === "enter") {
			if (jt) {
				e.preventDefault(), qt(n[0], n[1], e.shiftKey);
				return;
			}
			if (kt && !e.shiftKey) {
				e.preventDefault(), Tt(n);
				return;
			}
		}
		if ((e.key === "Home" || e.key === "End") && !t && !e.altKey) {
			e.preventDefault();
			let t = e.currentTarget, n = t.value.length;
			e.key === "Home" ? t.setSelectionRange(0, e.shiftKey ? t.selectionEnd ?? 0 : 0, e.shiftKey ? "backward" : "none") : t.setSelectionRange(e.shiftKey ? t.selectionStart ?? n : n, n), Ht(t);
		} else if (e.key === "F2") e.preventDefault(), a((e) => e && {
			...e,
			mode: e.mode === "enter" ? "edit" : "enter"
		});
		else if (e.key === "Enter" && (e.altKey || e.shiftKey)) {
			e.preventDefault();
			let t = e.currentTarget;
			t.ownerDocument.execCommand?.("insertText", !1, "\n") || (t.setRangeText("\n", t.selectionStart, t.selectionEnd, "end"), Ut(t));
		} else e.key === "Enter" ? (e.preventDefault(), Tt([1, 0])) : e.key === "Tab" ? (e.preventDefault(), Tt([0, e.shiftKey ? -1 : 1])) : e.key === "Escape" && (e.preventDefault(), Et());
	}, Tn = null;
	if (i && (Rt.length || zt)) {
		let e = zt && At?.call ? Je(zt, At.call.arg) : -1;
		Tn = Rt.length ? /* @__PURE__ */ W("div", {
			className: "de-fassist",
			role: "listbox",
			onMouseDown: (e) => e.preventDefault(),
			children: Rt.map((e, t) => {
				let n = t === Math.min(E, Rt.length - 1);
				return /* @__PURE__ */ G("div", {
					role: "option",
					"aria-selected": n,
					className: n ? "de-fsug on" : "de-fsug",
					onMouseEnter: () => D(t),
					onClick: () => Jt(e),
					children: [
						/* @__PURE__ */ W("span", {
							className: "de-fsug-name",
							children: e.name
						}),
						/* @__PURE__ */ G("span", {
							className: "de-fsug-args",
							children: [
								"(",
								[...e.args, ...e.variadic ? ["..."] : []].join(", "),
								")"
							]
						}),
						n && /* @__PURE__ */ W("div", {
							className: "de-fsug-desc",
							children: e.desc
						})
					]
				}, e.name);
			})
		}) : /* @__PURE__ */ G("div", {
			className: "de-fassist de-fhint",
			onMouseDown: (e) => e.preventDefault(),
			children: [/* @__PURE__ */ G("div", { children: [
				zt.name,
				"(",
				[...zt.args, ...zt.variadic ? ["..."] : []].map((t, n, r) => /* @__PURE__ */ G("span", { children: [n === e ? /* @__PURE__ */ W("b", { children: t }) : t, n < r.length - 1 ? ", " : ""] }, n)),
				")"
			] }), /* @__PURE__ */ W("div", {
				className: "de-fsug-desc",
				children: zt.desc
			})]
		});
	}
	let En = i && Sn ? {
		left: Sn.x - 1,
		top: Sn.y - 1,
		minWidth: Sn.w + 2,
		width: Math.max(Sn.w + 2, Math.min(480, i.value.length * 8 + 16)),
		height: Math.max(Sn.h + 2, i.value.split("\n").length * 18 + 4),
		...n.baseFont
	} : void 0, Dn = [];
	if (i && Nt.length) {
		let e = 0;
		for (let t of Nt) t.s > e && Dn.push(i.value.slice(e, t.s)), Dn.push(/* @__PURE__ */ W("span", {
			style: { color: t.color },
			children: i.value.slice(t.s, t.e)
		}, t.s)), e = t.e;
		Dn.push(i.value.slice(e) + "​");
	}
	let On = (e, t, n = e, r = t) => {
		let i = f.current;
		if (!i) return null;
		let a = i.getBoundingClientRect(), o = ut(e, t), s = ut(n, r);
		return new DOMRect(a.left + o.x, a.top + o.y, s.x + s.w - o.x, s.y + s.h - o.y);
	}, kn = (n, r) => e.row(t, n)?.find((e) => e[0] === r)?.[1] ?? "", An = (e) => ({
		sheetIndex: t,
		sheetName: n.sheets[t]?.name ?? "",
		range: e
	});
	c.current = {
		sheet: t,
		async flush() {
			let e = f.current, t = e ? Gi(e) : null;
			i && t && (t === C.current || t === ee.current) && (t.blur(), await Bi()), c.current && i && Tt(), await Promise.all([...yt.current]);
		},
		getViewState() {
			let e = Math.max(ze, P.rows), r = Math.max(Ue, P.cols);
			return {
				format: "xlsx",
				sheetIndex: t,
				sheetName: n.sheets[t]?.name ?? "",
				topLeft: ki(e, r),
				selection: Ai(q)
			};
		},
		hitTest(e, t) {
			let n = f.current;
			if (!n) return null;
			let r = n.getBoundingClientRect();
			if (e < r.left || e > r.right || t < r.top || t > r.bottom) return null;
			let { r: i, c: a } = ht(e, t, n), o = (e, t, n, r) => ({
				format: "xlsx",
				kind: e,
				location: An(t),
				...r === void 0 ? {} : { quote: vi(r) },
				rect: n
			});
			if (i < 0 || a < 0) return o("region", i >= 0 ? `${i + 1}:${i + 1}` : a >= 0 ? `${w(a)}:${w(a)}` : "", new DOMRect(r.left, r.top, r.width, r.height));
			let s = Ze(i, a), [c, l, u, d] = s ? [
				s.r0,
				s.c0,
				s.r1,
				s.c1
			] : [
				i,
				a,
				i,
				a
			];
			return o("sheet-cell", Ai({
				r0: c,
				c0: l,
				r1: u,
				c1: d
			}), On(c, l, u, d), kn(c, l));
		},
		rectsFor(e) {
			let t = f.current;
			if (!t) return [];
			let n = Ni(e.range);
			if (!n) {
				let t = /^(\d+):(\d+)$/.exec(e.range), r = /^([A-Za-z]+):([A-Za-z]+)$/.exec(e.range), i = (e) => [...e.toUpperCase()].reduce((e, t) => e * 26 + t.charCodeAt(0) - 64, 0) - 1;
				n = t ? {
					r0: Number(t[1]) - 1,
					c0: 0,
					r1: Number(t[2]) - 1,
					c1: Math.max(0, d.cols - 1)
				} : r ? {
					r0: 0,
					c0: i(r[1]),
					r1: Math.max(0, d.rows - 1),
					c1: i(r[2])
				} : {
					r0: 0,
					c0: 0,
					r1: Math.max(0, d.rows - 1),
					c1: Math.max(0, d.cols - 1)
				};
			}
			let r = On(n.r0, n.c0, n.r1, n.c1), i = t.getBoundingClientRect();
			return !r || r.right < i.left + F || r.left > i.right || r.bottom < i.top + Cs || r.top > i.bottom ? [] : [r];
		},
		scrollToCell(e, t) {
			dt(e, t);
		},
		selection() {
			let e = [];
			for (let t = q.r0; t <= Math.min(q.r1, q.r0 + 49); t++) {
				let n = [];
				for (let e = q.c0; e <= Math.min(q.c1, q.c0 + 19); e++) n.push(kn(t, e));
				e.push(n.join("	"));
			}
			return {
				format: "xlsx",
				kind: "range",
				location: An(Ai(q)),
				quote: vi(e.join("\n")),
				prefix: "",
				suffix: "",
				collapsed: Qe
			};
		}
	}, B(() => () => {
		c.current?.sheet === t && (c.current = null);
	}, [c, t]);
	let jn = `${q.r0}:${q.c0}:${q.r1}:${q.c1}`;
	B(() => Li(r).emitSelection(), [
		r,
		t,
		jn
	]);
	let Mn = (() => {
		if (!En || !Tn) return;
		let e = En.top + En.height + 2;
		return e + 200 > p.h && En.top > 200 ? {
			left: En.left,
			bottom: p.h - En.top + 2
		} : {
			left: En.left,
			top: e
		};
	})();
	return /* @__PURE__ */ G(U, { children: [
		/* @__PURE__ */ G("div", {
			className: "de-fx",
			children: [
				/* @__PURE__ */ G("div", {
					className: "de-fx-ref",
					children: [
						w(h.ac),
						h.ar + 1,
						!Qe && `:${w(q.c1)}${q.r1 + 1}`
					]
				}),
				u ? /* @__PURE__ */ W("textarea", {
					ref: ee,
					className: "de-fx-val de-fx-input",
					value: Cn,
					rows: 1,
					wrap: "off",
					spellCheck: !1,
					"aria-label": "Cell content",
					onFocus: () => !i && void Ct(void 0, !0),
					onChange: (e) => Ut(e.target),
					onSelect: (e) => Ht(e.currentTarget),
					onKeyDown: wn,
					onScroll: (e) => {
						let t = e.currentTarget, n = parseFloat(getComputedStyle(t).lineHeight) || t.clientHeight, r = Math.round(t.scrollTop / n) * n;
						Math.abs(r - t.scrollTop) >= 1 && (t.scrollTop = r);
					},
					onBlur: (e) => {
						o.current || (e.currentTarget.scrollTop = 0, i && (i.bar || !Ot) && Tt());
					}
				}) : /* @__PURE__ */ W("div", {
					className: "de-fx-val",
					title: Cn,
					children: Cn
				}),
				i && !kt && Tn && /* @__PURE__ */ W("div", {
					className: "de-fassist-at",
					style: {
						left: 88,
						top: 30
					},
					children: Tn
				})
			]
		}),
		/* @__PURE__ */ W("div", {
			ref: f,
			className: "de-grid",
			tabIndex: 0,
			onKeyDown: on,
			onCopy: (e) => {
				i || (e.preventDefault(), e.clipboardData.setData("text/plain", an()));
			},
			onCut: (e) => {
				!i && u && (e.preventDefault(), e.clipboardData.setData("text/plain", an()), Zt());
			},
			onPaste: (e) => {
				!i && u && (e.preventDefault(), _n(e.clipboardData.getData("text/plain")));
			},
			children: /* @__PURE__ */ W("div", {
				style: {
					position: "relative",
					width: Math.max(De, p.w),
					height: Math.max(R, p.h)
				},
				children: /* @__PURE__ */ G("div", {
					className: "de-grid-view",
					style: {
						width: p.w,
						height: p.h,
						...n.baseFont
					},
					onMouseDown: sn,
					onMouseMove: xn,
					onContextMenu: (e) => {
						if (!u) return;
						e.preventDefault();
						let { r: t, c: n } = ht(e.clientX, e.clientY, e.currentTarget);
						t >= 0 && n >= 0 && (t < q.r0 || t > q.r1 || n < q.c0 || n > q.c1) && ot({
							ar: t,
							ac: n,
							fr: t,
							fc: n
						}), te({
							x: e.clientX,
							y: e.clientY
						});
					},
					onDoubleClick: () => !i && void Ct(),
					children: [
						J("main", ze, Be, Ue, We, Ne, Fe, F + X, Cs + Z, Ie, Le),
						lt > 0 && J("top", 0, lt - 1, Ue, We, Ne, 0, F + X, Cs, Ie, Z),
						Y > 0 && J("left", ze, Be, 0, Y - 1, 0, Fe, F, Cs + Z, X, Le),
						lt > 0 && Y > 0 && J("tl", 0, lt - 1, 0, Y - 1, 0, 0, F, Cs, X, Z),
						st("ch", Ue, We, Ne, F + X, Ie),
						Y > 0 && st("chf", 0, Y - 1, 0, F, X),
						ct("rh", ze, Be, Fe, Cs + Z, Le),
						lt > 0 && ct("rhf", 0, lt - 1, 0, Cs, Z),
						lt > 0 && /* @__PURE__ */ W("div", {
							className: "de-freeze-h",
							style: {
								left: 0,
								top: Cs + Z - 1,
								width: p.w,
								height: 2
							}
						}),
						Y > 0 && /* @__PURE__ */ W("div", {
							className: "de-freeze-v",
							style: {
								left: F + X - 1,
								top: 0,
								width: 2,
								height: p.h
							}
						}),
						/* @__PURE__ */ W("div", {
							className: "de-corner",
							style: {
								width: F,
								height: Cs
							}
						}),
						i && kt && En && /* @__PURE__ */ G(U, { children: [
							Dn.length > 0 && /* @__PURE__ */ W("div", {
								ref: T,
								className: "de-cell-edit de-cell-hl",
								style: En,
								"aria-hidden": !0,
								children: Dn
							}),
							/* @__PURE__ */ W("textarea", {
								ref: C,
								className: Dn.length ? "de-cell-edit de-cell-edit-fx" : "de-cell-edit",
								spellCheck: !1,
								value: i.value,
								style: En,
								onMouseDown: (e) => e.stopPropagation(),
								onChange: (e) => Ut(e.target),
								onSelect: (e) => Ht(e.currentTarget),
								onScroll: (e) => {
									T.current && (T.current.scrollTop = e.currentTarget.scrollTop);
								},
								onKeyDown: wn,
								onBlur: (e) => {
									if (!o.current) {
										if (e.relatedTarget && e.relatedTarget === ee.current) return a((e) => e && {
											...e,
											bar: !0,
											sync: 0
										});
										Tt();
									}
								}
							}),
							Tn && Mn && /* @__PURE__ */ W("div", {
								className: "de-fassist-at",
								style: Mn,
								children: Tn
							})
						] })
					]
				})
			})
		}),
		u && /* @__PURE__ */ W(ls, {
			css: Qt,
			base: n.baseFont,
			format: n.formats[vt(h.ar, h.ac)] ?? "General",
			merged: un,
			frozen: !!(P.rows || P.cols),
			gridlines: d.gridLines,
			painter: ne !== null,
			onToggle: tn,
			onFormat: $t,
			onUndo: nn,
			onRedo: rn,
			onPaint: () => {
				re((e) => e === null ? vt(h.ar, h.ac) : null), gt();
			},
			onMerge: fn,
			onFreeze: pn,
			onGridlines: () => void ln({
				op: "gridlines",
				show: !d.gridLines
			}),
			onFunc: (e) => e ? mn(e) : void Ct("="),
			onSort: hn,
			onRows: gn,
			onFind: () => oe((e) => ({
				...e,
				open: !0,
				tick: e.tick + 1
			}))
		}),
		k.open && /* @__PURE__ */ W(gr, {
			query: k.q,
			index: k.idx,
			count: ue.length,
			editable: u,
			replace: k.replace,
			placeholder: "Find in sheet",
			onQuery: (e) => oe((t) => ({
				...t,
				q: e,
				idx: 0
			})),
			onNav: (e) => ue.length && yn((k.idx + e + ue.length) % ue.length),
			onClose: () => {
				oe((e) => ({
					...e,
					open: !1
				})), gt();
			},
			onReplace: (e, n) => {
				let i = ue[Math.min(k.idx, ue.length - 1)];
				i && bt(r.call("xlsx.replace", t, k.q, e, se, n ? void 0 : {
					r: i.r,
					c: i.c
				}));
			},
			options: /* @__PURE__ */ W(U, { children: [
				["matchCase", "Match case"],
				["whole", "Entire cell"],
				["formulas", "In formulas"]
			].map(([e, t]) => /* @__PURE__ */ G("label", {
				className: "de-find-opt",
				children: [/* @__PURE__ */ W("input", {
					type: "checkbox",
					checked: !!se[e],
					onChange: (t) => le((n) => ({
						...n,
						[e]: t.target.checked
					}))
				}), t]
			}, e)) })
		}),
		fe && /* @__PURE__ */ W(Yt, {
			text: fe,
			onDone: () => pe(null)
		}),
		O && /* @__PURE__ */ W(Kt, {
			x: O.x,
			y: O.y,
			items: vn(),
			onClose: () => te(null)
		})
	] });
}
// src/collab/react.tsx
var Vs = /* @__PURE__ */ new WeakMap(), Hs = 0;
function Us(e) {
	if (!e) return "";
	let t;
	if (typeof e.transport == "string") t = e.transport;
	else {
		let n = Vs.get(e.transport);
		n === void 0 && Vs.set(e.transport, n = ++Hs), t = `#${n}`;
	}
	return `${t}|${e.room}|${e.base ?? 0}|${e.user.id ?? ""}|${e.user.name}|${e.user.color ?? ""}`;
}
function Ws(e, t) {
	let [n, r] = H({
		collab: null,
		status: null
	}), i = Us(t), a = V(t);
	return a.current = t, B(() => {
		let t = a.current;
		if (!e || !t) {
			r({
				collab: null,
				status: null
			});
			return;
		}
		let n;
		try {
			n = N(e, t);
		} catch (e) {
			r({
				collab: null,
				status: "error",
				error: e.message
			});
			return;
		}
		let i = () => r({
			collab: n,
			status: n.status,
			error: n.session.error
		});
		i();
		let o = [n.on("status", i), n.on("error", i)];
		return () => {
			o.forEach((e) => e()), n.close();
		};
	}, [e, i]), n;
}
var Gs = (e) => e.split(/\s+/).filter(Boolean).slice(0, 2).map((e) => e[0].toUpperCase()).join("") || "?", Ks = {
	connecting: "Connecting…",
	syncing: "Syncing…",
	live: "Live",
	offline: "Offline · changes will sync",
	error: "Not synced"
};
function qs({ client: e, state: t }) {
	let n = Pe((t) => ce(e, t), () => j(e)), [r, i] = H(0);
	if (B(() => {
		let e = t.collab?.session;
		if (!e) return;
		let n = setInterval(() => i(e.pending), 500);
		return () => clearInterval(n);
	}, [t.collab]), !t.status) return null;
	let a = t.status === "error" ? t.error ?? "Collaboration stopped" : t.status === "live" && r ? `Saving ${r} change${r > 1 ? "s" : ""}…` : Ks[t.status];
	return /* @__PURE__ */ G("span", {
		className: "de-collab",
		children: [/* @__PURE__ */ G("span", {
			className: `de-collab-status de-collab-${t.status}`,
			title: a,
			children: [/* @__PURE__ */ W("span", { className: "de-collab-dot" }), /* @__PURE__ */ W("span", {
				className: "de-collab-label",
				children: t.status === "live" ? n.length ? `${n.length + 1} editing` : "Live" : Ks[t.status]
			})]
		}), n.length > 0 && /* @__PURE__ */ G("span", {
			className: "de-peers",
			children: [n.slice(0, 5).map((e) => /* @__PURE__ */ W("span", {
				className: "de-peer",
				style: { background: L(e.color) },
				title: e.name,
				children: Gs(e.name)
			}, e.site)), n.length > 5 && /* @__PURE__ */ G("span", {
				className: "de-peer de-peer-more",
				title: n.slice(5).map((e) => e.name).join(", "),
				children: ["+", n.length - 5]
			})]
		})]
	});
}
function Js({ client: e, collab: t }) {
	let n = V(null), r = Pe((t) => ce(e, t), () => j(e)), [i, a] = H([]), o = Me(() => r.filter((e) => e.presence && e.presence.k !== "xlsx"), [r]);
	return B(() => {
		let r = n.current, i = r?.parentElement;
		if (!r || !i || !o.length) {
			a([]);
			return;
		}
		let s = 0, c = () => {
			s = 0;
			let n = r.getBoundingClientRect(), c = (e) => ({
				x: e.left - n.left,
				y: e.top - n.top,
				w: e.width,
				h: e.height
			}), l = [];
			for (let r of o) {
				let a = Ys(r, i, t, e);
				a && l.push({
					key: String(r.site),
					color: r.color,
					name: r.name,
					caret: a.caret ? {
						x: a.caret.left - n.left,
						y: a.caret.top - n.top,
						h: a.caret.height || 16
					} : void 0,
					boxes: a.sel.map(c),
					outline: a.outline ? c(a.outline) : void 0
				});
			}
			a(l);
		}, l = () => {
			s ||= requestAnimationFrame(c);
		};
		l(), i.addEventListener("scroll", l, !0), window.addEventListener("resize", l);
		let u = t?.on("change", l), d = setInterval(l, 400);
		return () => {
			cancelAnimationFrame(s), i.removeEventListener("scroll", l, !0), window.removeEventListener("resize", l), u?.(), clearInterval(d);
		};
	}, [
		o,
		t,
		e
	]), /* @__PURE__ */ W("div", {
		ref: n,
		className: "de-peer-layer",
		"aria-hidden": !0,
		children: i.map((e) => /* @__PURE__ */ G("div", {
			style: { "--peer": L(e.color) },
			children: [
				e.boxes.map((e, t) => /* @__PURE__ */ W("div", {
					className: "de-peer-sel",
					style: {
						left: e.x,
						top: e.y,
						width: e.w,
						height: e.h
					}
				}, t)),
				e.outline && /* @__PURE__ */ W("div", {
					className: "de-peer-outline",
					style: {
						left: e.outline.x - 3,
						top: e.outline.y - 3,
						width: e.outline.w + 6,
						height: e.outline.h + 6
					},
					children: /* @__PURE__ */ W("span", {
						className: "de-peer-flag",
						children: e.name
					})
				}),
				e.caret && /* @__PURE__ */ W("div", {
					className: "de-peer-caret",
					style: {
						left: e.caret.x,
						top: e.caret.y,
						height: e.caret.h
					},
					children: /* @__PURE__ */ W("span", {
						className: "de-peer-flag",
						children: e.name
					})
				})
			]
		}, e.key))
	});
}
function Ys(e, t, n, r) {
	let i = e.presence;
	if (i.k === "docx") {
		let r = n?.rects(t, e);
		return r ? {
			caret: r.caret,
			sel: r.sel
		} : null;
	}
	if (i.k === "pptx" && i.slide) {
		let e = r.info.pptx?.slides.findIndex((e) => e.path === i.slide) ?? -1, n = e >= 0 ? t.querySelector(`[data-slide="${e + 1}"]`) : null;
		return n ? {
			sel: [],
			outline: ((i.top === void 0 ? null : n.querySelector(`[data-top="${i.top}"]`)) ?? n).getBoundingClientRect()
		} : null;
	}
	return null;
}
function Xs(e) {
	switch (e.op) {
		case "insertRows":
		case "deleteRows": return `${e.at + 1}:${e.at + e.n}`;
		case "insertCols":
		case "deleteCols": return `${w(e.at)}:${w(e.at + e.n - 1)}`;
		case "merge":
		case "unmerge":
		case "fill":
		case "sort": return Ai(e.range);
		case "hideRows": return `${e.a + 1}:${e.b + 1}`;
		case "hideCols": return `${w(e.a)}:${w(e.b)}`;
		case "colWidth": return `${w(e.c0)}:${w(e.c1)}`;
		case "rowHeight": return `${e.r0 + 1}:${e.r1 + 1}`;
		default: return "";
	}
}
function Zs(e) {
	let t = Infinity, n = Infinity, r = -1, i = -1;
	for (let a of e) t = Math.min(t, a.r), n = Math.min(n, a.c), r = Math.max(r, a.r), i = Math.max(i, a.c);
	return {
		r0: t,
		c0: n,
		r1: r,
		c1: i
	};
}
function Qs(e, t) {
	let n = () => e.info.xlsx, r = (e) => n().sheets[e]?.name ?? "", i = (e, n, i, a = "", o = "", s, c = r(n)) => {
		let l = {
			sheetIndex: n,
			sheetName: c,
			range: i
		};
		t.emitEdit({
			format: "xlsx",
			kind: e,
			before: a,
			after: o,
			location: l,
			...s ? { detail: s } : {}
		});
	}, a = (e, n, i) => (a) => {
		let o = a?.code;
		typeof o == "string" && o.startsWith("xlsx-") && t.emitRefusal({
			format: "xlsx",
			code: o,
			message: a.message,
			location: {
				sheetIndex: e,
				sheetName: r(e),
				range: n
			},
			detail: i
		});
	};
	return e.observe((o, s) => {
		switch (o) {
			case "xlsx.set": {
				let [n, c] = s, l = r(n);
				if (!t.listening) return (e) => void e.catch(a(n, Ai(Zs(c)), { method: o }));
				if (c.length > 200) return (e) => void e.then(() => i("cell", n, Ai(Zs(c)), "", "", { cells: c.length }, l), a(n, Ai(Zs(c)), { method: o }));
				let u = c.map((t) => e.direct("xlsx.cell", n, t.r, t.c).then((e) => e ? e.formula ?? e.value : "", () => ""));
				return (e) => void e.then(async () => {
					let e = await Promise.all(u);
					c.forEach((t, r) => i("cell", n, ki(t.r, t.c), e[r], t.input, void 0, l));
				}, a(n, Ai(Zs(c)), { method: o }));
			}
			case "xlsx.format": {
				if (!t.listening) return;
				let [e, n, r] = s;
				return (t) => void t.then(() => i("format", e, Ai(n), "", "", { patch: r }), () => {});
			}
			case "xlsx.sheetOp": {
				let [e, n] = s;
				return t.listening ? (t) => void t.then(() => i(`sheet.${n.op}`, e, Xs(n), "", "", { op: n }), a(e, Xs(n), { op: n })) : (t) => void t.catch(a(e, Xs(n), { op: n }));
			}
			case "xlsx.bookOp": {
				if (!t.listening) return;
				let e = s[0], a = e.op === "rename" || e.op === "delete" ? r(e.index) : e.op === "move" ? r(e.from) : "", o = e.op === "add" ? (e.after ?? n().sheets.length - 1) + 1 : e.op === "move" ? e.to : e.index;
				return (t) => void t.then(() => i(`book.${e.op}`, o, "", a, e.op === "rename" ? e.name : e.op === "add" ? r(o) : "", { op: e }, e.op === "delete" || e.op === "rename" ? a : r(o)), () => {});
			}
			case "xlsx.replace": {
				if (!t.listening) return;
				let [e, n, r] = s;
				return (t) => void t.then((t) => t && i("replace", e, "", n, r), () => {});
			}
			case "xlsx.import": {
				if (!t.listening) return;
				let e = s[0];
				return (t) => void t.then(() => i("import", e + 1, ""), () => {});
			}
			case "xlsx.undo":
			case "xlsx.redo": return t.listening ? (e) => void e.then((e) => {
				let t = e;
				t && i(o === "xlsx.undo" ? "undo" : "redo", t.sheet, Ai(t.range));
			}, () => {}) : void 0;
		}
	});
}
// src/host/host.ts
function $s(e, t) {
	let n = Li(e), r = e.kind === "xlsx" ? Qs(e, n) : void 0, i = async () => {
		await n.ask("flush");
	};
	return {
		get format() {
			return e.kind;
		},
		onEdit: (e) => n.onEdit(e),
		onRefusal: (e) => n.onRefusal(e),
		flush: i,
		async saveBytes() {
			await i();
			let n = await e.call("save");
			return t.setDirty(!1), n;
		},
		getViewState: () => n.ask("getViewState") ?? null,
		setViewState: async (e) => await n.ask("setViewState", e) ?? !1,
		hitTest: (e, t) => n.ask("hitTest", e, t) ?? null,
		rectsFor: (e) => n.ask("rectsFor", e) ?? [],
		scrollTo: async (e) => await n.ask("scrollTo", e) ?? !1,
		selection: () => n.ask("selection") ?? null,
		onSelectionChange: (e) => n.onSelection(e),
		setReadOnly: (e) => t.setReadOnly(e),
		get readOnly() {
			return t.readOnly;
		},
		dispose() {
			r?.();
		}
	};
}
// src/react/DocViewer.tsx
var ec = {
	docx: ".docx",
	xlsx: ".xlsx",
	pptx: ".pptx"
}, tc = {
	pages: "Apple Pages document",
	keynote: "Apple Keynote presentation",
	numbers: "Apple Numbers spreadsheet"
}, nc = {
	doc: "Word 97-2003 document",
	xls: "Excel 97-2003 workbook",
	ppt: "PowerPoint 97-2003 presentation",
	rtf: "Rich Text Format document",
	odt: "OpenDocument text",
	ods: "OpenDocument spreadsheet",
	odp: "OpenDocument presentation"
}, rc = {
	csv: "csv",
	tsv: "tsv",
	text: "txt",
	markdown: "md",
	html: "html",
	svg: "svg",
	mermaid: "mmd",
	plantuml: "puml",
	graphviz: "dot"
}, ic = {
	csv: "CSV file",
	tsv: "Tab-separated values",
	text: "Plain text",
	markdown: "Markdown",
	html: "HTML page",
	svg: "SVG picture",
	mermaid: "Mermaid diagram",
	plantuml: "PlantUML diagram",
	graphviz: "Graphviz diagram"
}, ac = /* @__PURE__ */ new Set([
	"markdown",
	"html",
	"svg"
]), oc = (e) => {
	let t = O[y(f(e) ?? e)];
	return !!t && ac.has(t);
}, sc = {
	docx: "Untitled document",
	xlsx: "Untitled spreadsheet",
	pptx: "Untitled presentation"
}, cc = /* @__PURE__ */ new WeakMap(), lc = 0, uc = (e) => {
	let t = cc.get(e);
	return t === void 0 && cc.set(e, t = ++lc), t;
};
function dc(e) {
	return e < 1024 ? `${e} B` : e < 1048576 ? `${(e / 1024).toFixed(0)} KB` : `${(e / 1024 / 1024).toFixed(1)} MB`;
}
function fc(e) {
	let { src: t, name: n, className: i, style: a, toolbar: o = !0, toolbarExtra: s, zoom: c, thumbnails: l, headers: u, credentials: d, worker: m, styleTarget: h, theme: g, onLoad: v, onError: b } = e, x = q(g), { allowEdit: S = !0, allowSave: w = !0, allowDownload: T = !0, fileMenu: ee = !0, allowOpen: E = !0, captureSelectAll: D = !0, onSave: te, onDirtyChange: ne } = e, [ie, ae] = H(!!e.editable);
	B(() => {
		e.editable !== void 0 && ae(!!e.editable);
	}, [e.editable]);
	let [k, oe] = H(!1), [se, ce] = H(!1), [le, ue] = H(null), [de, fe] = H(!1);
	Ae(() => ba(h), [h]);
	let [pe, me] = H(null), [he, ge] = H(null);
	B(() => {
		me(null), ge(null);
	}, [t]);
	let _e = pe ? pe.name : n, { client: A, error: j, loading: ve, progress: M } = $o(pe ? pe.src : t, {
		name: _e,
		headers: u,
		credentials: d,
		worker: m
	}, !!pe?.live), N = he ?? _e, P = Ws(A, e.collab), F = A?.info?.imported, ye = F === "svg", I = !!A?.info?.from || ye, be = !I && !de && (!e.collab || P.status === "live" || P.status === "offline"), [xe, Se] = H(null), Ce = !!F && _.has(F), [L, we] = H(!1), Te = L && Ce, Ee = F && ac.has(F) ? F : null, De = Ee === "markdown" || Ee === "html", R = V(null), z = V(null), [ke, je] = H(null), Ne = V(!1), Pe = V(void 0);
	B(() => () => clearTimeout(Pe.current), []), B(() => {
		pe?.live || (clearTimeout(Pe.current), je(null), Ne.current = !1, R.current = null);
	}, [t, pe]), B(() => {
		if (!A || !Te) return;
		let e = De && R.current === "doc";
		if (ke !== null && !e) return;
		let t = !0;
		return (e && z.current ? z.current.text(Ee === "html" ? "html" : "md").catch(() => null) : Promise.resolve(null)).then(async (e) => typeof e == "string" ? e : await A.call("plain.source")).then((n) => {
			t && (e && (R.current = null), je(n ?? ""));
		}, () => {}), () => {
			t = !1;
		};
	}, [
		A,
		Te,
		ke,
		De,
		Ee
	]);
	let [Fe, U] = $e(), Ie = V(null), Le = U.w > 0 && U.w < 720, [Re, ze] = H(.45), Be = V(null);
	B(() => {
		let e = Be.current;
		if (e === null || !A) return;
		Be.current = null;
		let t = 0, n = 0, r = -1, i = () => {
			let a = Ie.current?.querySelector(".de-scroll");
			if (a && a.scrollHeight > a.clientHeight + 1) {
				if (a.scrollTop = e * (a.scrollHeight - a.clientHeight), a.scrollHeight === r) return;
				r = a.scrollHeight;
			}
			++n < 40 && (t = requestAnimationFrame(i));
		};
		return t = requestAnimationFrame(i), () => cancelAnimationFrame(t);
	}, [A]);
	let Ve = e.comments !== !1 && !ye, K = Me(() => A && Ve ? new Hn(A) : null, [A, Ve]);
	B(() => () => K?.dispose(), [K]);
	let He = e.comments || {};
	K && (K.opts = He, K.me = He.user ?? e.collab?.user ?? { name: "Me" }, K.canComment = !I && (He.canComment ?? (ie && be)));
	let Ue = qn(K), We = !!He.open;
	B(() => {
		K && We && K.toggle(!0);
	}, [K]);
	let Ge = K ? K.visible().length : 0, Ke = He.focus, qe = V(null);
	B(() => {
		if (!K || !Ke || qe.current === Ke || !K.loaded) return;
		let e = K.list.get(Ke)?.parent ?? Ke;
		K.threads().some((t) => t.root.id === e) && (qe.current = Ke, K.toggle(!0), K.list.get(e)?.done && K.setShowResolved(!0), K.select(e));
	}, [
		K,
		Ke,
		Ue.rev
	]), B(() => {
		A && v?.(A);
	}, [A, v]);
	let Je = V({
		setDirty: (e) => {},
		setReadOnly: fe,
		readOnly: de
	});
	Je.current.readOnly = de;
	let Ye = e.onHost, Xe = V(Ye);
	Xe.current = Ye;
	let Ze = !!Ye;
	B(() => {
		if (!A || !Ze) return;
		let e = $s(A, {
			setDirty: (e) => Je.current.setDirty(e),
			setReadOnly: (e) => Je.current.setReadOnly(e),
			get readOnly() {
				return Je.current.readOnly;
			}
		});
		Xe.current?.(e);
		let t = pt.current, n = Li(A), r = t?.ownerDocument, i = () => n.emitSelection();
		return r?.addEventListener("selectionchange", i), () => {
			r?.removeEventListener("selectionchange", i), e.dispose(), Xe.current?.(null);
		};
	}, [A, Ze]), B(() => {
		j && b?.(j);
	}, [j, b]);
	let Qe = V(!1);
	B(() => {
		oe(!!A && Qe.current), A && (Qe.current = !1);
	}, [A]);
	let et = Oe((e) => oe((t) => (t !== e && ne?.(e), e)), [ne]);
	Je.current.setDirty = et;
	let tt = (he ?? (A?.name || N || "document")).replace(/\.[^.]+$/, ""), nt = tt + (A ? ec[A.kind] : ""), it = Ee ? `.${re[Ee].ext}` : A ? ec[A.kind] : "", at = tt + it, ot = Oe(async () => {
		if (!A) return "";
		if (De && R.current === "doc" && z.current) {
			let e = await z.current.text(Ee === "html" ? "html" : "md");
			return R.current = null, je(e), e;
		}
		return ke ?? await A.call("plain.source") ?? "";
	}, [
		A,
		De,
		Ee,
		ke
	]), st = w && (!!te || T), ct = Oe(async () => {
		if (A && !se && st) {
			ce(!0);
			try {
				let e = Ee ? new Blob([await ot()], { type: `${re[Ee].mime};charset=utf-8` }) : await A.call("save");
				te ? await te(e, at) : kt(e, at), et(!1);
			} catch (e) {
				b?.(e), console.error("[office-engine] save failed", e), gt(e.message);
			} finally {
				ce(!1);
			}
		}
	}, [
		A,
		se,
		st,
		te,
		at,
		Ee,
		ot,
		et,
		b
	]), lt = Oe((e) => {
		e && (R.current = "doc"), et(e);
	}, [et]), Y = V(null), X = ie && be && !Te, Z = Me(() => ({
		bar: e.editBarTarget ?? le,
		editable: X,
		setDirty: lt,
		save: ct,
		canDownload: T,
		client: A,
		fileOps: z,
		selectAll: Y
	}), [
		le,
		e.editBarTarget,
		X,
		lt,
		ct,
		T,
		A
	]), ut = (e) => {
		je(e), Ne.current || et(!0), Ne.current = !0, R.current = "source", clearTimeout(Pe.current);
		let t = F;
		t && (Pe.current = setTimeout(() => {
			let n = Ie.current?.querySelector(".de-scroll");
			Be.current = n && n.scrollHeight > n.clientHeight ? n.scrollTop / (n.scrollHeight - n.clientHeight) : null;
			let r = A?.name || _e || `document.${re[t].ext}`;
			O[y(f(r) ?? r)] !== t && (r += `.${re[t].ext}`), Qe.current = !0, me({
				src: new Blob([e], { type: re[t].mime }),
				name: r,
				converted: !0,
				live: !0
			});
		}, 350));
	}, dt = () => `${(he ?? A?.name ?? N ?? "document").replace(/\.[^.]+$/, "")}.${re[F ?? "text"].ext}`, ft = (e) => {
		let t = Fe.current;
		if (!t) return;
		e.preventDefault();
		let n = e.currentTarget;
		n.setPointerCapture(e.pointerId);
		let r = t.getBoundingClientRect(), i = (e) => ze(Math.min(.85, Math.max(.15, Le ? (e.clientY - r.top) / r.height : (e.clientX - r.left) / r.width))), a = () => {
			n.removeEventListener("pointermove", i), n.removeEventListener("pointerup", a), n.removeEventListener("pointercancel", a);
		};
		n.addEventListener("pointermove", i), n.addEventListener("pointerup", a), n.addEventListener("pointercancel", a);
	}, pt = V(null);
	B(() => {
		let e = pt.current;
		if (!D || !e) return;
		let t = (t) => {
			if (t.defaultPrevented || !(t.metaKey || t.ctrlKey) || t.altKey || t.shiftKey || t.key.toLowerCase() !== "a") return;
			let n = t.composedPath()[0] ?? t.target;
			n && e.contains(n) || rt(n) || !Y.current || (t.preventDefault(), Y.current());
		}, n = e.ownerDocument;
		return n.addEventListener("keydown", t), () => n.removeEventListener("keydown", t);
	}, [D]);
	let mt = V(K);
	mt.current = K, B(() => {
		let e = pt.current;
		if (!e) return;
		let t = (t) => {
			let n = mt.current;
			if (t.defaultPrevented || !(t.metaKey || t.ctrlKey) || !t.altKey || t.shiftKey || t.code !== "KeyM" || !n?.canComment) return;
			let r = t.composedPath()[0] ?? t.target, i = e.ownerDocument;
			(r && e.contains(r) || r === i.body || r === i.documentElement) && (t.preventDefault(), n.start());
		}, n = e.ownerDocument;
		return n.addEventListener("keydown", t), () => n.removeEventListener("keydown", t);
	}, []);
	let [ht, gt] = H(null), _t = Oe(() => gt(null), []), [vt, yt] = H(null), [bt, xt] = H(!1), [St, Ct] = H(!1), wt = (e, t) => k ? yt({
		message: e,
		run: t
	}) : t(), Tt = Oe((e, t = !1) => {
		Qe.current = e.converted && (!!e.live || !oc(e.name)), ge(null), me(e), t && ae(!0);
	}, []), Et = ee && E && !e.collab, Dt = Ra({
		kind: A?.kind,
		base: tt,
		canOpen: Et,
		canImport: ee && S && be,
		canSave: ee && st,
		canDownload: ee && T && !!A,
		ops: z,
		create: (e) => wt(`A new ${sc[e].split(" ")[1]} replaces the current document. Your changes are not saved.`, () => {
			(e === "docx" ? r([]) : e === "xlsx" ? C([], "Sheet1") : p()).then((t) => Tt({
				src: t,
				name: sc[e] + ec[e],
				converted: !1
			}, S), (e) => gt(e.message));
		}),
		open: (e) => wt(`Opening “${e.name}” replaces the current document. Your changes are not saved.`, () => {
			_a(e).then(Tt, (e) => gt(e.message));
		}),
		save: ct,
		downloadOriginal: async () => {
			A && (kt(await A.call("save"), nt), te || et(!1));
		},
		picture: ye ? {
			label: "SVG picture",
			ext: ".svg",
			download: async () => kt(new Blob([await ot()], { type: "image/svg+xml" }), at)
		} : void 0,
		rename: () => xt(!0),
		details: () => Ct(!0),
		close: e.onClose,
		extra: e.fileMenuItems ?? [],
		notify: gt
	}), Ot = (e) => {
		if (e.defaultPrevented || !(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
		let t = e.key.toLowerCase();
		if (t === "s" && e.target.closest?.(".de-src")) e.preventDefault(), ct();
		else if (t === "a") {
			if (rt(e.target) || !Y.current) return;
			e.preventDefault(), Y.current();
		} else if (ee) t === "p" ? (e.preventDefault(), T && Dt.run("print")) : t === "o" && Et && (e.preventDefault(), Dt.run("open"));
		else return;
	}, At = M && M.total > 0 ? Math.min(100, M.loaded / M.total * 100) : 0, jt = ve || !!M && At < 100, Mt = he ?? A?.name ?? N ?? (typeof t == "string" ? decodeURIComponent(t.split(/[?#]/)[0].split("/").pop() ?? "") : t?.name) ?? "", Nt;
	return Nt = j ? /* @__PURE__ */ W("div", {
		className: "de-center",
		children: /* @__PURE__ */ G("div", {
			className: "de-error",
			role: "alert",
			children: [/* @__PURE__ */ W("strong", { children: "Cannot open document." }), /* @__PURE__ */ W("div", { children: j.message })]
		})
	}) : A ? ye ? /* @__PURE__ */ W(Ja, { client: A }, uc(A)) : A.kind === "docx" ? /* @__PURE__ */ W(ua, {
		client: A,
		initialZoom: c
	}, uc(A)) : A.kind === "xlsx" ? /* @__PURE__ */ W(As, { client: A }) : /* @__PURE__ */ W(Qo, {
		client: A,
		initialZoom: c,
		thumbnails: l
	}) : t || pe ? /* @__PURE__ */ G("div", {
		className: "de-center",
		children: [/* @__PURE__ */ W("div", { className: "de-spinner" }), /* @__PURE__ */ W("div", { children: M?.phase === "download" && M.total ? `Downloading… ${dc(M.loaded)} / ${dc(M.total)}` : "Opening…" })]
	}) : /* @__PURE__ */ W("div", {
		className: "de-center",
		children: "No document"
	}), /* @__PURE__ */ G("div", {
		ref: pt,
		className: "de-root" + (x ? " de-dark" : "") + (i ? ` ${i}` : ""),
		style: a,
		onKeyDown: Ot,
		children: [
			o && /* @__PURE__ */ G("div", {
				className: "de-bar",
				children: [
					A && /* @__PURE__ */ W("span", {
						className: `de-badge de-badge-${A.kind}`,
						children: A.info?.from ?? A.info?.converted ?? (A.info?.imported ? rc[A.info.imported] : A.kind)
					}),
					ee && /* @__PURE__ */ W(za, { actions: Dt }),
					/* @__PURE__ */ W("span", {
						className: "de-title",
						title: Mt,
						children: Mt
					}),
					/* @__PURE__ */ W("span", {
						className: "de-status",
						ref: Se,
						hidden: !A
					}),
					A && A.size > 0 && /* @__PURE__ */ W("span", {
						className: "de-status",
						children: dc(A.size)
					}),
					A && e.collab && /* @__PURE__ */ W(qs, {
						client: A,
						state: P
					}),
					s,
					A && Ce && /* @__PURE__ */ G("button", {
						type: "button",
						className: "de-mode" + (Te ? " de-mode-on" : ""),
						onClick: () => we((e) => !e),
						"aria-pressed": Te,
						title: Te ? "Hide the source" : "Edit the source side by side with the document",
						"data-testid": "de-code-toggle",
						children: [/* @__PURE__ */ W(J, {
							name: "code",
							size: 16
						}), "Code"]
					}),
					K && /* @__PURE__ */ G("button", {
						type: "button",
						className: "de-mode de-cm-toggle" + (Ue.open ? " de-mode-on" : ""),
						onClick: () => K.toggle(),
						title: K.canComment ? `Comments (${Yn} to comment on the selection)` : "Comments",
						"aria-pressed": Ue.open,
						"data-testid": "de-comments-toggle",
						children: [
							/* @__PURE__ */ W(J, {
								name: "comment",
								size: 16
							}),
							"Comments",
							Ge > 0 && /* @__PURE__ */ W("span", {
								className: "de-cm-n",
								children: Ge
							})
						]
					}),
					A && S && !I && !de && !Te && /* @__PURE__ */ G("button", {
						type: "button",
						className: ie ? "de-mode de-mode-on" : "de-mode",
						onClick: () => ae((e) => !e),
						title: ie ? "Switch to viewing" : "Edit document",
						children: [/* @__PURE__ */ W(J, {
							name: ie ? "view" : "edit",
							size: 16
						}), ie ? "View" : "Edit"]
					}),
					A && st && (ie && !I || k) && /* @__PURE__ */ G("button", {
						type: "button",
						className: k ? "de-mode de-save-dirty" : "de-mode",
						disabled: se,
						onClick: () => void ct(),
						title: "Save a copy (Ctrl+S)",
						children: [/* @__PURE__ */ W(J, {
							name: "save",
							size: 16
						}), se ? "Saving…" : k || te ? "Save" : "Download"]
					}),
					/* @__PURE__ */ W("div", {
						className: "de-progress",
						style: {
							width: `${jt ? Math.max(At, 3) : 100}%`,
							opacity: +!!jt
						}
					})
				]
			}),
			o && !e.editBarTarget && A && X && /* @__PURE__ */ W("div", {
				className: "de-ebar-host",
				ref: ue
			}),
			/* @__PURE__ */ G("div", {
				className: "de-body" + (Te && Le ? " de-body-stacked" : ""),
				ref: Fe,
				children: [
					Te && /* @__PURE__ */ W("div", {
						className: "de-src-pane",
						style: Le ? { height: `${Re * 100}%` } : { width: `${Re * 100}%` },
						children: ke === null ? /* @__PURE__ */ W("div", {
							className: "de-center",
							children: /* @__PURE__ */ W("div", { className: "de-spinner" })
						}) : /* @__PURE__ */ W(qa, {
							text: ke,
							format: F,
							onChange: ut,
							readOnly: !S || !!e.collab,
							notice: k && !Ne.current && !De ? "Changes made in the document are not in this source: editing it builds the document again from the source." : void 0,
							onCopy: () => navigator.clipboard?.writeText(ke).then(() => gt("Source copied"), () => gt("Cannot copy here")),
							onDownload: T ? () => kt(new Blob([ke], { type: re[F].mime }), dt()) : void 0
						})
					}),
					Te && /* @__PURE__ */ W("div", {
						className: "de-split-handle",
						role: "separator",
						"aria-orientation": Le ? "horizontal" : "vertical",
						"aria-label": "Resize the source",
						"aria-valuenow": Math.round(Re * 100),
						"aria-valuemin": 15,
						"aria-valuemax": 85,
						tabIndex: 0,
						onPointerDown: ft,
						onKeyDown: (e) => {
							let t = e.key === (Le ? "ArrowUp" : "ArrowLeft") ? -.05 : e.key === (Le ? "ArrowDown" : "ArrowRight") ? .05 : 0;
							t && (e.preventDefault(), ze((e) => Math.min(.85, Math.max(.15, e + t))));
						}
					}),
					/* @__PURE__ */ W("div", {
						className: "de-main",
						ref: Ie,
						children: /* @__PURE__ */ W(Pt.Provider, {
							value: Z,
							children: /* @__PURE__ */ W(Un.Provider, {
								value: K,
								children: /* @__PURE__ */ W(zt.Provider, {
									value: xe,
									children: Nt
								})
							})
						})
					}),
					A && P.collab && /* @__PURE__ */ W(Js, {
						client: A,
						collab: P.collab
					}),
					K && Ue.open && /* @__PURE__ */ W(ar, { ctl: K })
				]
			}),
			ht && /* @__PURE__ */ W(Yt, {
				text: ht,
				onDone: _t
			}),
			vt && /* @__PURE__ */ W(Jt, {
				title: "Discard unsaved changes?",
				message: vt.message,
				ok: "Continue",
				onOk: vt.run,
				onClose: () => yt(null)
			}),
			bt && A && /* @__PURE__ */ W(qt, {
				spec: {
					title: "Rename",
					label: "File name",
					initial: tt,
					ok: "Rename",
					onOk: (t) => {
						let n = t.trim().replace(/[\\/:*?"<>|]+/g, " ").replace(RegExp(`(\\${ec[A.kind]}|\\${it})$`, "i"), "");
						n && (ge(n + ec[A.kind]), e.onRename?.(n + it));
					}
				},
				onClose: () => xt(!1)
			}),
			St && A && /* @__PURE__ */ W(ma, {
				client: A,
				file: [
					["Name", at],
					["Type", A.info?.from ? `${tc[A.info.from]} (view only)` : A.info?.converted ? `${nc[A.info.converted]}, opened as ${Pa[A.kind]}` : A.info?.imported ? `${ic[A.info.imported]}, opened as ${Pa[A.kind]}` : Pa[A.kind]],
					...A.size > 0 ? [["File size", dc(A.size)]] : [],
					...k ? [["Status", "Unsaved changes"]] : []
				],
				stats: z.current?.stats() ?? [],
				onClose: () => Ct(!1)
			})
		]
	});
}
export { As as a, Ao as c, ua as d, yi as f, Ws as i, ba as l, qs as n, $o as o, Js as r, Qo as s, fc as t, va as u };

//# sourceMappingURL=DocViewer-BZLXUcxJ.js.map