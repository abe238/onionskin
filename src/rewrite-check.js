// The code check for a one-sentence rewrite made by a small model on this Mac (milestone 2, idea 10).
// Pure: no I/O, no clock, no model. checkRewrite(task, before, after) decides whether `after` may replace `before` in the document.
// checkRewrite(task, before, after, {mode: "suggest"}) is the relaxed check for a suggestion the person sees before anything is written,
// and inputQualifies(before) decides whether the model may be asked at all; both are described below the strict check.
//
// Answers:
//   { ok: true,  verdict: "ok",     text, reasons: [] }      the cleaned rewrite may be used as is
//   { ok: false, verdict: "no",     text: null, reasons }    a rule was broken for certain (a number, range, code, name, link, negation or modal changed,
//                                                            a refusal, two sentences, out of the length bounds)
//   { ok: false, verdict: "unsure", text: null, reasons }    nothing was proven wrong, but the check cannot show the meaning was kept
//                                                            (a word that carries meaning was dropped, a tone or actor word was added, ...)
// Every reason is {code, words?}; all failing reasons are listed, not only the first. "no" and "unsure" both mean: do not use the rewrite,
// hand the request to the big agent. When in doubt the answer is "unsure", never "ok".
//
// What it catches (the rules, in order):
//   - the task is one of the three fixed stamps (shorter, friendlier, grammar); anything else, Translate included, is "unsure";
//   - the original is one sentence (no internal sentence end, no line break, no "…[truncated]" mark, 3 to 300 characters). Whether it
//     starts with a capital and ends with . ! or ? (or is the whole paragraph) is the caller's check, since only the caller knows;
//   - the rewrite is one clean line: untrusted(after, 400) equals it (no control or bidi characters, no line break, never cut), with one
//     wrapping quote pair removed when the original had none; it is not unchanged; it is one sentence (a second one that starts in lowercase
//     counts); it ends in . ! or ? when the original does, and has as many "?" as the original, so a statement never becomes a question or a
//     question a statement; and no clause of it starts with a word that makes a question by word order ("is", "do", "can", "when", ...;
//     at the start, after a greeting or courtesy word, or after a comma or colon: "Hi, is the fee refundable.") unless the original has
//     that word at a clause start too;
//   - no refusal ("I'm sorry", "I can't", "As an AI", ...), no chatter ("Here is the rewritten sentence:"), no reply to the text instead of a
//     rewrite of it ("sorry to hear", "thank you for reaching out", ...);
//   - facts kept, as exact tokens: the same multiset of numbers in any script, with any sign, currency mark or percent sign ("-5" is not
//     "5", "240" is not "2400", "20 %" is "20%" but not "20"; fractions, superscripts, Roman numeral characters, full-width and Arabic-Indic
//     digits are numbers too, compared as written, never folded to ASCII; digits inside a word count: "BA123", "Q3"), the same joins between
//     two numbers ("3-5" is a range, not the list "3 and 5" or "3, 5"; any dash, "to" and "through" are the same range mark), every run of
//     letters and digits written together ("xk9pq", "4B") with the same spelling and case, every name-like word (capitalized after the first
//     word, all caps, or with a capital after its first letter: "iPhone", "xK9pQ") with the same spelling ("Friday" is not "Fridays"), the
//     same links, emails and bare domains, case included (a link's path is case-sensitive), with none added, the same negations (not, never,
//     no, ...), the same modals (may, will, must, can, ...) and the same "have to" and "is to" pairs, the same symbols outside ordinary
//     punctuation (no added markup, "~", "%", emoji), and each number still next to the same words ("March 3", "5 pm", "240 units",
//     "account 12345");
//   - every other word of the original is still there, letter for letter, unless it is on a short list of words that carry no fact
//     (articles, forms of "be", "have" and "do", "please", "that", "to", ...) or is a pronoun. Words that look like filler but limit, add,
//     time or weigh a fact are not on that list: "just", "simply", "also", "currently", "very", "really", "quite", "so", "actually",
//     "basically". Fix grammar may also correct a word's spelling or ending, but never add or drop a plural "s" ("weekdays" to "weekday")
//     and never pair a word on any list below, any part of a hyphenated one included ("sixty" is not "sixteen", "thirtieth" is not
//     "thirteenth", "twenty-five" is not "twenty-six", "xii" is not "xi", "minimum" is not "maximum");
//   - nothing that changes who acts, what it covers or how it sounds is added: "we", "I", a pronoun ("your" to "our"), a modal, a scope word
//     (all, every, only, just, also, full, ...), a qualifier or condition (about, over, if, unless, or, before, until, currently, ...), a
//     tone or degree word (sorry, happy, pleased, unfortunately, good news, very, ...), an instruction word (wire, click, contact, ignore,
//     ...), a number word (cardinal, ordinal or Roman), or a new first word; and no other new word at all: Shorter and Fix grammar add none
//     beyond a spelling fix, Friendlier only the free words and a few courtesy words (quick, reminder, heads-up, friendly, gentle);
//   - length: Shorter 30% to 95% of the original, Friendlier 70% to 160%, Fix grammar 80% to 120% with similarity() at least 0.8.
//
// What it cannot catch (each one is pinned by the "known limits" test in test/rewrite-check.test.js):
//   - a change of meaning that keeps every word: a negation moved to another clause ("We will not ship until the order is paid" to "We will
//     ship until the order is not paid"), two names or actors swapped ("Acme pays Beta" to "Beta pays Acme"), words reordered;
//   - tone itself: code sees words, not tone. A tone flip is caught only when it drops a word, adds a word that is not free or courtesy, or
//     adds or drops a "?"; one made with "." to "!", courtesy words, or both, passes ("Quick reminder: the 240 units are delayed until
//     March 13!");
//   - a change of tense through a word ending that Fix grammar may correct ("We close the desk" to "We closed the desk"), or through a free
//     word added or dropped alone ("We refund the fee" to "We have refunded the fee");
//   - a swap between two words on the free list: "is" for "was" (a change of tense), "the" for "a", "to" for "for";
//   - whether a Fix grammar spelling correction picked the right word (only "close in spelling" is checked);
//   - a hostile sentence steering the model: the output is checked like any other, so an output that keeps every fact and word passes even
//     if the model was steered. It can only replace that one selected sentence, and the person sees it and can revert it.
// It is also stricter than a person would be: Fix grammar "start" to "starts" or "your" to "you're" ("its", "their" likewise), Shorter with
// a synonym or without "just", "20 percent" to "20%", "3pm" to "3 pm", "has to" to "have to", a recased link, "A fee is due" to "There is a
// fee due" (read as a possible question), and Friendlier with any warm word off the courtesy list all go to the agent. That costs time,
// never a wrong change.
import { normText, similarity } from "./text.js";
import { untrusted as cleanUntrusted } from "./sanitize.js";

export const REWRITE_TASKS = ["shorter", "friendlier", "grammar"];

const LENGTH = { shorter: [0.3, 0.95], friendlier: [0.7, 1.6], grammar: [0.8, 1.2] };
const GRAMMAR_SIMILARITY = 0.8;
const MAX_BEFORE = 300;
const MAX_AFTER = 400;
const MARK = "…[truncated]";

// Words free to drop or add: they carry no number, name, condition, scope, modality or polarity on their own.
// Kept off on purpose: modals, negations, quantifiers, am/pm, and condition words (before, after, until, by, within, with, without, only, if,
// unless, or, except, per, from, than).
// Not free either, though they look like filler: "just" and "simply" (they mean "only"), "also" (in addition), "currently" (for now),
// "very", "really", "quite", "so", "actually", "basically" (degree and tone). Each sits on a list below.
const FREE = new Set(
  ("a an the is are was were be been being has have had do does did that which this these those there here " +
    "please kindly note and of to for on at in as hi hello hey thanks thank").split(" "),
);
// Pronouns are free to drop but not to add: "Your account" to "Our account" changes whose it is.
const PRONOUNS = new Set("you your yours our ours us they them their theirs it its he him his she her hers".split(" "));
// Words that soften, widen, limit or put a condition on a fact: "about 240 units", "on March 3 if paid", "even before that".
const QUALIFIERS = new Set(
  ("about around approximately roughly nearly almost over under up least more less fewer than unless if or except maybe perhaps possibly " +
    "likely probably estimated expected even before after until within by from per with since during between currently now still yet").split(" "),
);
const NEGATIONS = new Set(["not", "no", "never", "none", "nobody", "nothing", "neither", "nor", "without", "nowhere"]);
const MODALS = new Set(["will", "would", "shall", "should", "must", "may", "might", "can", "could"]);
const SCOPE = new Set(
  ("all every each any some only full fully partial partly most many few several both either entire whole always sometimes usually " +
    "minimum maximum min max lowest highest earliest latest last increase decrease just simply also too").split(" "),
);
const FIRST_PERSON = new Set(["we", "i", "me", "my", "mine"]);
const TONE = new Set(
  ("sorry apologize apologise apologies apology regret regrets regretfully unfortunately sadly fortunately luckily happy happily pleased " +
    "glad delighted excited thrilled congratulations congrats great good news exciting wonderful amazing excellent very really quite so " +
    "actually basically").split(" "),
);
const INSTRUCTION = new Set(
  ("ignore disregard wire transfer send pay click visit call email reply download open run delete contact forward submit approve buy sign " +
    "login log password account link follow instructions instruction confirm verify").split(" "),
);
// The only new words Friendlier may add beyond the free list. Shorter and Fix grammar add none (Fix grammar may still fix a spelling).
const COURTESY = new Set("quick reminder heads-up friendly gentle".split(" "));
const NUMBER_WORDS = new Set(
  ("zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen " +
    "twenty thirty forty fifty sixty seventy eighty ninety hundred thousand million billion trillion dozen half halves quarter twice " +
    "thrice once double triple quadruple first second third fourth fifth sixth seventh eighth ninth tenth eleventh twelfth thirteenth " +
    "fourteenth fifteenth sixteenth seventeenth eighteenth nineteenth twentieth thirtieth fortieth fiftieth sixtieth seventieth " +
    "eightieth ninetieth hundredth thousandth millionth billionth").split(" "),
);
// a Roman numeral in lowercase ("xii"; in capitals it is name-like already). A few plain words match too ("mix"): they only become protected.
const ROMAN = /^(?=[ivxlcdm])m{0,3}(cm|cd|d?c{0,3})(xc|xl|l?x{0,3})(ix|iv|v?i{0,3})$/;
// a word made of number words, a plural of one, or a Roman numeral: "twenty-five", "thirty-first", "hundreds", "xii"
const isNumberWord = (w) => ROMAN.test(w) || w.split("-").some((p) => NUMBER_WORDS.has(p) || NUMBER_WORDS.has(p.replace(/s$/, "")));

// words that never count as a spelling fix of another word ("sixty" and "sixteen", "minimum" and "maximum")
const PROTECTED = new Set([...NEGATIONS, ...MODALS, ...SCOPE, ...FIRST_PERSON, ...PRONOUNS, ...QUALIFIERS, ...TONE, ...INSTRUCTION, ...NUMBER_WORDS]);
// checked per part of a hyphenated word, so "twenty-five" and "full-time" are protected too
const isProtected = (w) => isNumberWord(w) || w.split("-").some((p) => PROTECTED.has(p) || PROTECTED.has(p.replace(/s$/, "")));
// two words that say "must" between them: "have to", "is to" ("The form is to be signed"); compared like modals, though each word is free
const OBLIGATION_LEAD = new Set("have has had having is are am was were be".split(" "));
// a first word that makes a question by word order alone: "Is the fee refundable."
const QUESTION_LEAD = new Set([..."is are am was were do does did has have had".split(" "), ...MODALS, ..."who what when where why how which".split(" ")]);

const REFUSAL_START = /^(i'?m sorry|i am sorry|i apologi[sz]e|i can(not|'t)|i am unable|i'm unable|i won't|i will not|as an ai|as a language model|sorry\b|unfortunately, i\b)/i;
const REFUSAL_ANYWHERE = /\b(as an ai|language model|i can(not|'t) (help|assist|comply|do that|rewrite)|i'm not able to|i am not able to)\b/i;
const CHATTER = /^(here is|here's|sure|certainly|of course|okay|ok|rewritten|revised|shorter|friendlier|corrected|fixed|output|answer|result)\b[^.!?]*[:,!]|\b(rewritten|revised|corrected) (sentence|version|text)\b|\bnote:/i;
const REPLY = /\b(sorry to hear|sad to hear|glad to hear|happy to hear|thank you for (reaching|contacting|letting|your (message|email|patience|note|question))|thanks for (reaching|letting|your)|i understand|we understand|i hope this helps|hope this helps|let me know if)\b/i;

// a sentence end: . ! or ? (and any closing quote or bracket), a space, then a capital or a digit (with any opening quote)
// built with new RegExp from escaped strings so no raw quote or separator characters live in this source file
const SENTENCE_END = new RegExp("[.!?]+[\"')\\]\\u201d\\u2019]*\\s+[\"'(\\[\\u201c\\u2018]?[\\p{Lu}\\p{N}]", "u");
const LINE_BREAK = new RegExp("[\\r\\n\\u2028\\u2029]");
const INNER_STOP = new RegExp("[.!?]+[\"')\\]\\u201d\\u2019]*\\s+\\S", "gu");
// a link or email: anything with ://, www. or @, or a bare domain (letters, a dot, two or more letters: "evil.com", not "a.m.")
const LINK = /\S*(?::\/\/|www\.|@)\S*|(?:[\p{L}\p{N}-]+\.)+\p{L}{2,}/giu;
// symbols that are not ordinary punctuation (markup, math, arrows, emoji, "%", ...): the rewrite must have the same ones
const SYMBOL = new RegExp("[^\\p{L}\\p{M}\\p{N}\\s.,;:!?'\"()\\[\\]\\u2013\\u2014/&$\\u20ac\\u00a3\\u00a5\\u20b9-]", "gu");
const QUOTE_PAIRS = [['"', '"'], ["'", "'"], [String.fromCharCode(0x201c), String.fromCharCode(0x201d)], [String.fromCharCode(0x2018), String.fromCharCode(0x2019)]];

/** Curly apostrophes and quotes to straight ones, so contractions and refusals match. */
const SINGLE = new RegExp("[\\u2018\\u2019\\u02bc]", "g");
const DOUBLE = new RegExp("[\\u201c\\u201d]", "g");
const straighten = (s) => s.replace(SINGLE, "'").replace(DOUBLE, '"');

/** Contractions written out, case kept: won't -> will not, we'll -> we will, cannot -> can not, Acme's -> Acme. */
function expand(s) {
  return straighten(s)
    .replace(/\b(w)on't\b/gi, "$1ill not")
    .replace(/\b(c)an't\b/gi, "$1an not")
    .replace(/\b(s)han't\b/gi, "$1hall not")
    .replace(/\b(c)annot\b/gi, "$1an not")
    .replace(/n't\b/gi, " not")
    .replace(/'ll\b/gi, " will")
    .replace(/'re\b/gi, " are")
    .replace(/'ve\b/gi, " have")
    .replace(/'m\b/gi, " am")
    .replace(/'d\b/gi, " would")
    .replace(/\b(it|that|there|here|what|who|he|she|where|how|let)'s\b/gi, (_, w) => (w.toLowerCase() === "let" ? `${w} us` : `${w} is`))
    .replace(/'s\b/gi, "")
    .replace(/\b(t)hank you\b/gi, "$1hanks");
}

/**
 * Word and number tokens, in order, case kept, with where each sits in expand(s) ({t, num, at, end}). A number is any run of digits in
 * any script ("12", "\u00bd", "10\u2076", "\uff15\uff10\uff10", "\u0665\u0660\u0660", "\u216b"), compared exactly, never folded to ASCII. Numbers lose trailing
 * punctuation ("3." is "3") and keep a percent sign written after them, spaced or not ("20 %" is "20%").
 */
function tokens(s) {
  const out = [];
  // a number keeps a sign written right before it ("-5", "+3", "~240"), but not the dash of a range ("3-5")
  const re = /((?:(?<![\p{L}\p{N}])[-+~<>\u2212\u2248\u00b1])?[$€£¥₹]?\p{N}[\p{N},.:/%]*(?:\s?%)?)|[\p{L}][\p{L}\p{M}'-]*/gu;
  for (const m of expand(s).matchAll(re)) {
    if (m[1] !== undefined) {
      const kept = m[0].replace(/[.,:/]+$/, "");
      out.push({ t: kept.replace(/\s%$/, "%"), num: true, at: m.index, end: m.index + kept.length });
    } else {
      const t = m[0].replace(/['-]+$/, "");
      out.push({ t, num: false, at: m.index, end: m.index + t.length });
    }
  }
  return out;
}

const DASHES = new RegExp("[\\u2010-\\u2015\\u2212-]", "g");
/**
 * What joins each two numbers that follow each other with at most one word between them: "3-5" and "3 to 5" are a range, "3, 5" and
 * "3 and 5" a list ("3|-|5", "3|,|5", "3|and|5"). Any dash, "to", "through" and "thru" read as the same range mark.
 */
function numberJoins(s) {
  const text = expand(s);
  const nums = tokens(s).filter((t) => t.num);
  const out = [];
  for (let i = 1; i < nums.length; i++) {
    const gap = text.slice(nums[i - 1].end, nums[i].at).toLowerCase().replace(DASHES, "-").replace(/\s+/g, " ").trim();
    if ((gap.match(/\p{L}+/gu) ?? []).length > 1) continue;
    const mark = /^(-|to|through|thru)$/.test(gap) ? "-" : gap;
    out.push(`${nums[i - 1].t}|${mark}|${nums[i].t}`);
  }
  return out;
}

const count = (list) => {
  const m = new Map();
  for (const x of list) m.set(x, (m.get(x) || 0) + 1);
  return m;
};
/** What `a` has that `b` lacks, as a multiset difference. */
function missing(a, b) {
  const B = count(b);
  const out = [];
  for (const x of a) {
    const n = B.get(x) || 0;
    if (n > 0) B.set(x, n - 1);
    else out.push(x);
  }
  return out;
}
const sameMultiset = (a, b) => missing(a, b).length === 0 && missing(b, a).length === 0;
const cps = (s) => [...s].length;

// capitalized after the first word, all caps, or a capital after the first letter anywhere ("iPhone", the "xK" and "pQ" of "xK9pQ")
const isNameLike = (t, i) =>
  !t.num && t.t !== "I" && ((i > 0 && /^\p{Lu}/u.test(t.t)) || /^.+\p{Lu}/u.test(t.t) || (t.t.length >= 2 && /^[\p{Lu}\p{N}'-]+$/u.test(t.t) && /\p{Lu}.*\p{Lu}/u.test(t.t)));

const bondWord = (t) => (t && !t.num && !FREE.has(t.t.toLowerCase()) ? t.t.toLowerCase() : null);
/**
 * Number tokens with their neighbors: the next word that is not free (one free word may sit between: "5 of the units" no, "240 units" and
 * "5 pm" yes), and the word right before when it is not free ("March 3", "account 12345").
 */
function numberBonds(toks) {
  const out = [];
  toks.forEach((tok, i) => {
    if (!tok.num) return;
    const next = bondWord(toks[i + 1]) ?? (toks[i + 1] && FREE.has(toks[i + 1].t.toLowerCase()) ? bondWord(toks[i + 2]) : null);
    const prev = bondWord(toks[i - 1]);
    if (next) out.push({ num: tok.t, side: ">", word: next });
    if (prev) out.push({ num: tok.t, side: "<", word: prev });
  });
  return out;
}
/** Bonds in `a` with no match in `b`. Fix grammar may correct the spelling of the bound word ("recieved 240" and "received 240"). */
function lostBonds(a, b, grammar) {
  const left = [...b];
  return a.filter((x) => {
    const k = left.findIndex((y) => y.num === x.num && y.side === x.side && (y.word === x.word || (grammar && closeSpelling(x.word, y.word))));
    if (k < 0) return true;
    left.splice(k, 1);
    return false;
  });
}

// compared exactly, case included: a link's path and a short link's code are case-sensitive ("bit.ly/aBcD9" is not "bit.ly/abcd9")
const links = (s) => [...s.matchAll(LINK)].map((m) => m[0].replace(/[.,;:!?)\]"']+$/, ""));
// codes: each run of non-space characters outside links that has both a letter and a digit ("xk9pq", "BA123", "4B"), compared exactly
const codes = (s) =>
  straighten(s)
    .replace(LINK, " ")
    .split(/\s+/)
    .map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter((w) => /\p{L}/u.test(w) && /\p{N}/u.test(w));
/** "have to", "is to", ... as two words next to each other in the tokens (a number between them breaks the pair: "is 3 to 5"). */
const obligations = (toks) =>
  toks.flatMap((x, i) => {
    const y = toks[i + 1];
    return !x.num && y && !y.num && OBLIGATION_LEAD.has(x.t.toLowerCase()) && y.t.toLowerCase() === "to" ? [`${x.t.toLowerCase()} to`] : [];
  });
// words that may come before the start of a clause without being its start: "Hi there, is ...", "Quick reminder: is ..."
const GREETING = new Set([..."hi hello hey there please kindly thanks thank note".split(" "), ...COURTESY]);
/**
 * Words that start a clause and can make a question by word order: the first word after any greeting or courtesy words, and the first
 * word after a comma, colon, semicolon, bracket or long dash ("Is the fee ...", "Hi, is the fee ...", "The fee, is it ...").
 */
function clauseLeads(s) {
  const text = expand(s);
  const toks = tokens(s);
  const out = [];
  let lead = true;
  toks.forEach((t, i) => {
    if (i && /[,;:(\u2013\u2014]/u.test(text.slice(toks[i - 1].end, t.at))) lead = true;
    const w = t.t.toLowerCase();
    if (lead && !t.num && QUESTION_LEAD.has(w)) out.push(w);
    if (!(lead && !t.num && GREETING.has(w))) lead = false;
  });
  return out;
}

/** A small stem for Fix grammar only: "replied" and "reply", "going" and "go" match. */
const stem = (w) => w.replace(/(ies|ied)$/, "y").replace(/(es|ed|ing|s|d)$/, "");
// one word and the same word with s or es added: "weekday" and "weekdays" ("one" against "every") is a fact, never a spelling fix
const pluralPair = (a, b) => [a, b].some((x, k) => { const y = k ? a : b; return y === `${x}s` || y === `${x}es` || (x.endsWith("y") && y === `${x.slice(0, -1)}ies`); });
const closeSpelling = (a, b) => !pluralPair(a, b) && (stem(a) === stem(b) || (a[0] === b[0] && Math.abs(a.length - b.length) <= 2 && similarity(a, b) >= 0.5));

/** Remove one wrapping quote pair from `s` when `before` is not wrapped in one. */
function unwrap(s, before) {
  for (const [o, c] of QUOTE_PAIRS) {
    if (s.length > 2 && s.startsWith(o) && s.endsWith(c) && !(before.startsWith(o) && before.endsWith(c))) {
      const inner = s.slice(o.length, -c.length);
      if (!inner.includes(o) && !inner.includes(c)) return inner.trim();
    }
  }
  return s;
}

const HARD = new Set([
  "bad_text",
  "unchanged",
  "refusal",
  "chatter",
  "reply_not_rewrite",
  "two_sentences",
  "number_changed",
  "name_changed",
  "link_changed",
  "negation_changed",
  "modal_changed",
  "symbol_changed",
  "range_changed",
  "code_changed",
  "too_long",
  "too_short",
  "not_similar",
]);

/**
 * May `after` (a small model's rewrite) replace `before` (the selected sentence) for `task` ("shorter" | "friendlier" | "grammar")?
 * See the file header for the rules and for what it cannot catch. `{mode: "suggest"}` runs the relaxed check of suggest mode instead
 * (its own header below); strict mode is the default and is unchanged by it.
 */
export function checkRewrite(task, before, after, opts = {}) {
  if (opts && opts.mode === "suggest") return checkSuggest(task, before, after);
  const reasons = [];
  const add = (code, words) => reasons.push(words && words.length ? { code, words: [...new Set(words)] } : { code });
  const done = (text) => {
    if (!reasons.length) return { ok: true, verdict: "ok", text, reasons };
    return { ok: false, verdict: reasons.some((r) => HARD.has(r.code)) ? "no" : "unsure", text: null, reasons };
  };

  if (!REWRITE_TASKS.includes(task)) {
    add("unknown_task");
    return done();
  }
  if (typeof before !== "string" || typeof after !== "string") {
    add("bad_input");
    return done();
  }

  // the original: one clean sentence
  const src = cleanUntrusted(before, MAX_BEFORE + 1);
  if (LINE_BREAK.test(before.trim())) add("input_not_one_sentence");
  if (before.includes(MARK) || cps(src) > MAX_BEFORE) add("input_cut");
  if (cps(src) < 3) add("input_too_short");
  if (SENTENCE_END.test(src)) add("input_not_one_sentence");
  if (reasons.length) return done();

  // the rewrite: one clean line, never cut
  const text = unwrap(after.trim(), src);
  if (cleanUntrusted(text, MAX_AFTER) !== text || !text) {
    add("bad_text");
    return done();
  }
  if (normText(text) === normText(src)) {
    add("unchanged");
    return done();
  }

  const plain = straighten(text);
  const plainSrc = straighten(src);
  if ((REFUSAL_START.test(plain) && !REFUSAL_START.test(plainSrc)) || (REFUSAL_ANYWHERE.test(plain) && !REFUSAL_ANYWHERE.test(plainSrc))) add("refusal");
  if (CHATTER.test(plain) && !CHATTER.test(plainSrc)) add("chatter");
  const reply = plain.match(REPLY);
  if (reply && !REPLY.test(plainSrc)) add("reply_not_rewrite", [reply[0].toLowerCase()]);
  // a second sentence, even one that starts in lowercase: more ". " inside than the original has
  const stops = (s) => (s.match(INNER_STOP) ?? []).length;
  if (SENTENCE_END.test(text) || stops(text) > stops(src)) add("two_sentences");
  if (/[.!?]["')\]]*$/.test(plainSrc) && !/[.!?]["')\]]*$/.test(plain)) add("sentence_end_changed");
  // a statement never becomes a question and a question never a statement: the same number of "?" (only "." against "!" is left free)
  const asks = (s) => (s.match(/\?/g) ?? []).length;
  if (asks(plain) !== asks(plainSrc)) add("sentence_end_changed");

  // facts
  const A = tokens(src);
  const B = tokens(text);
  const nums = (toks) => toks.filter((t) => t.num).map((t) => t.t);
  const numsLost = missing(nums(A), nums(B));
  const numsAdded = missing(nums(B), nums(A));
  if (numsLost.length || numsAdded.length) add("number_changed", [...numsLost, ...numsAdded]);
  const symbols = (s) => straighten(s).replace(LINK, " ").match(SYMBOL) ?? [];
  if (!sameMultiset(symbols(src), symbols(text))) add("symbol_changed", [...missing(symbols(src), symbols(text)), ...missing(symbols(text), symbols(src))]);
  const currency = (s) => [...s].filter((c) => "$€£¥₹".includes(c));
  if (!sameMultiset(currency(src), currency(text)) && !numsLost.length && !numsAdded.length) add("number_changed", missing(currency(src), currency(text)));
  const joinsA = numberJoins(src);
  const joinsB = numberJoins(text);
  if (!sameMultiset(joinsA, joinsB) && !numsLost.length && !numsAdded.length) add("range_changed", [...missing(joinsA, joinsB), ...missing(joinsB, joinsA)]);
  if (!sameMultiset(codes(src), codes(text))) add("code_changed", [...missing(codes(src), codes(text)), ...missing(codes(text), codes(src))]);

  const names = (toks) => toks.filter((t, i) => isNameLike(t, i)).map((t) => t.t);
  const exactB = new Set(B.map((t) => t.t));
  const namesLost = names(A).filter((n) => !exactB.has(n));
  const namesAdded = names(B).filter((n) => !A.some((t) => t.t === n));
  if (namesLost.length || namesAdded.length) add("name_changed", [...namesLost, ...namesAdded]);

  if (!sameMultiset(links(src), links(text))) add("link_changed", [...missing(links(src), links(text)), ...missing(links(text), links(src))]);

  const lowerWords = (toks) => toks.filter((t) => !t.num).map((t) => t.t.toLowerCase());
  const wa = lowerWords(A);
  const wb = lowerWords(B);
  const neg = (w) => w.filter((x) => NEGATIONS.has(x));
  if (!sameMultiset(neg(wa), neg(wb))) add("negation_changed", [...missing(neg(wa), neg(wb)), ...missing(neg(wb), neg(wa))]);
  const ma = [...wa.filter((x) => MODALS.has(x)), ...obligations(A)];
  const mb = [...wb.filter((x) => MODALS.has(x)), ...obligations(B)];
  if (!sameMultiset(ma, mb)) add("modal_changed", [...missing(ma, mb), ...missing(mb, ma)]);
  const bondsA = numberBonds(A);
  const bondsB = numberBonds(B);
  const bondsChanged = lostBonds(bondsA, bondsB, task === "grammar").length || lostBonds(bondsB, bondsA, task === "grammar").length;
  if (bondsChanged && !numsLost.length && !numsAdded.length) add("fact_moved");

  // every other word of the original is still there; new words are few and change no actor, scope or tone
  let dropped = missing(wa, wb).filter((w) => !FREE.has(w) && !PRONOUNS.has(w) && !NEGATIONS.has(w) && !MODALS.has(w));
  let added = missing(wb, wa).filter((w) => !FREE.has(w) && !NEGATIONS.has(w) && !MODALS.has(w));
  if (task === "grammar") {
    // a spelling or ending fix pairs one dropped word with one added word, never a word that carries a fact on its own
    const left = [];
    for (const d of dropped) {
      const k = isProtected(d) ? -1 : added.findIndex((a) => !isProtected(a) && closeSpelling(d, a));
      if (k >= 0) added.splice(k, 1);
      else left.push(d);
    }
    dropped = left;
  }
  if (dropped.length) add("word_dropped", dropped);
  const watch = (set, code) => {
    const hit = added.filter((w) => set.has(w));
    if (hit.length) add(code, hit);
  };
  watch(FIRST_PERSON, "first_person_added");
  watch(PRONOUNS, "pronoun_added");
  watch(QUALIFIERS, "qualifier_added");
  watch(SCOPE, "scope_word_added");
  watch(TONE, "tone_word_added");
  watch(INSTRUCTION, "instruction_word_added");
  watch({ has: isNumberWord }, "number_word_added");
  const extra = added.filter((w) => !(task === "friendlier" && COURTESY.has(w)));
  if (extra.length) add("word_added", extra);
  // the first word is exempt from the name rule, so a new one there could be a new name ("Globex files go out on Monday")
  const first = B.find((t) => !t.num)?.t.toLowerCase();
  if (first && !FREE.has(first) && !(task === "friendlier" && COURTESY.has(first)) && !wa.includes(first)) add("new_first_word", [first]);
  // a question made by word order alone, with no "?": "The fee is refundable." to "Is the fee refundable." or "Hi, is the fee refundable."
  const leadsAdded = missing(clauseLeads(text), clauseLeads(src));
  if (leadsAdded.length) add("question_made", leadsAdded);

  // length
  const ratio = cps(text) / cps(src);
  const [lo, hi] = LENGTH[task];
  if (ratio < lo) add("too_short");
  if (ratio > hi) add("too_long");
  if (task === "grammar" && similarity(src, text) < GRAMMAR_SIMILARITY) add("not_similar");

  return done(text);
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// Suggest mode (idea 10, option A: the small model suggests, the person decides). The person sees the suggestion next to the original
// and taps "Use this" or not, so this check only keeps out what must never be shown, and points at what the person should look at.
//
// checkRewrite(task, before, after, {mode: "suggest"}) answers {verdict, text, warnings, reasons}:
//   verdict "show"      the cleaned rewrite (`text`) may be shown as a suggestion, with nothing to point at
//   verdict "warn"      it may be shown, with `warnings` (in the fixed family order below) for the person to check
//   verdict "withhold"  a hard rule was broken: nothing is shown (`text` null, `reasons` lists every broken rule)
//   verdict "unchanged" the model gave the sentence back as it was (for Fix grammar on a clean sentence that is the right answer)
// A warning is {code, words, added, dropped}: `added` and `dropped` are the words of the rewrite and of the original that it is about
// (both may be empty: "question" carries `now: "question" | "statement"` instead). Only the page turns warnings into words.
//
// Hard rules (withheld):
//   - the original is not usable: unknown task, bad input, not one sentence, cut, under 3 characters, or it reads like instructions for an AI
//     (input_addresses_ai, see inputQualifies). Whether it starts and ends like a sentence is inputQualifies's check, for the caller;
//   - the rewrite is not clean text: bad_text (control, bidi or zero-width characters, a line break, over 400 characters), a refusal, a
//     reply to the text, two sentences, chatter introduced with a colon ("Here is the rewritten sentence:"), sentence_end_lost (the
//     original ends in . ! or ? and the rewrite does not), placeholder_added (a new [...], {...} or <...>), symbol_added (markup, emoji, ~);
//   - quoted_text_changed: text inside quotation marks ("...", curly double, and single quotes that are clearly quotes, not apostrophes:
//     an opening ' at the start or after a space or bracket and before a letter or digit, closed by a ' after a non-space and before a non-letter)
//     is quoted or being discussed, so it is copied letter for letter: a rewrite that changes it, or drops its quotation marks, is withheld
//     ("stainles steel brackets" in quotes is not "fixed"). Apostrophes ("it's", "company's", "don't") never make a quote; an inch mark (2")
//     or a stray mark never shifts the pairing and a mark left open quotes the rest of the sentence (see quotedSpans);
//   - the facts changed: number_changed (digits as in strict mode, "20 percent" read as "20%", am/pm in any case or spacing; also number
//     words, cardinal and ordinal, but not lowercase Roman numerals and not "one", which is an amount word), unit_changed (the word right
//     after a number: minute, hour, day, week, month, year, am, pm), date_word_changed (today, tomorrow, yesterday, tonight),
//     range_changed (only dash, "to", "through", "and", "or" and comma joins), code_changed (split on dashes: "90-minute" is no code),
//     name_changed (exact spelling; a capitalized word whose lowercase form is on any word list here is not a name), link_changed;
//   - not a rewrite: too few of the original's content words kept, or too many new ones (FLOORS), counting spelling pairs as kept;
//   - length: Shorter 30% to 95% of the original (above is not_shorter), Friendlier 60% to 180%, Fix grammar 80% to 125% with
//     similarity() at least 0.75.
//   - formal_only (Friendlier only): the only change is a formal opener ("Kindly", "Please be advised that"), which is stiffer, not warmer; the page
//     says "No friendlier version this time.".
// Warning families, in this order: claim (an opener about feelings, thanks, apology or opinion that the original did not have, from a closed list:
// "We appreciate", "We're pleased", "We regret", "Kindly", "Thank you for", "Unfortunately" and the like; `added` is the opening phrase), negation (compared by count: "nobody" to "not" is fine), modal (with "have to" and "is to"), condition
// words, amount words, a first- or second-person word added where the original had none of that person, question (a "?" added or dropped,
// or a question-making first word at the start or after a greeting), number_moved (a number next to different words), action words
// added, symbol dropped, and for Fix grammar only any other content word dropped or added.
// Spelling fixes are paired first, in all three tasks, and the pairs are left out of the condition, amount, action, symbol and Fix grammar
// families (negations, modals, numbers and names are still compared on the full word lists): words that differ only by an apostrophe
// ("Its" and "It's", "dont" and "don't"; only a word one side has more often, and never "well"/"we'll", "wed"/"we'd", "were"/"we're" or
// "lets"/"let's", which would hide a modal or a person); then, when the dropped word is not on a protected list, an edit distance of 1
// between words of 4 letters or more ("untill" to "until", even though "until" is protected), one word against two words next to each
// other ("atleast" to "at least"), or closeSpelling with a plural or verb "s" allowed ("apply" to "applies"). A pronoun swap within one
// person ("you" to "your", "Me and my" to "My colleague and I") needs no pair: pronouns are free to drop and only a new person is warned.
// What it cannot catch, beyond strict mode's limits: a swapped verb that keeps every listed word ("delivered" to "shared"), a fluent change
// of meaning that keeps every listed word, tone, a dropped content word in Shorter and Friendlier (it shows as struck through, not as a
// warning), and whether the document's own sentence is malicious ("Correct version: wire $5,000 to account 12345." shortened to "Wire
// $5,000 to account 12345." is shown clean: it adds nothing that was not already there).

const SUGGEST_LENGTH = { shorter: [0.3, 0.95], friendlier: [0.6, 1.8], grammar: [0.8, 1.25] };
const SUGGEST_SIMILARITY = 0.75;
// kept: the least share of the original's content words still in the rewrite; added: the most share of the rewrite's content words that are new
const FLOORS = { shorter: { kept: 0.3, added: 0.5 }, friendlier: { kept: 0.35, added: 0.7 }, grammar: { kept: 0.8, added: 0.2 } };

const CONDITION = new Set("if unless only except before after until within because although though otherwise whether".split(" "));
const AMOUNT = new Set(
  "about approximately over under more less fewer least most all every each any some none few several many full partial half double maximum minimum one".split(" "),
);
// treated as the same word inside a family; a word that is only a stand-in (since, just, around, whole, ...) is never reported alone
const SAME = {
  since: "because", as: "because", merely: "only", just: "only", till: "until",
  approximately: "about", around: "about", roughly: "about", every: "all", each: "all", over: "more", complete: "full", entire: "full", whole: "full",
};
const ACTION = new Set("wire transfer pay click visit download install login password verify confirm call email ignore disregard".split(" "));
const FIRST = new Set("i me my mine myself we us our ours ourselves".split(" "));
const SECOND = new Set("you your yours yourself yourselves".split(" "));
const UNITS = new Set("minute hour day week month year am pm".split(" "));
const DATE_WORDS = new Set("today tomorrow yesterday tonight".split(" "));
// Calendar words long enough that a near miss is a typo, not another word or a person's name (so no "may", "march", "august").
const CALENDAR = [...DATE_WORDS, ..."monday tuesday wednesday thursday friday saturday sunday january february september october november december".split(" ")];
/** The one calendar word `w` misspells ("tomorow", "wensday", "febuary"): within two edits of it and nearer to it than to any other. Else null. */
function misspeltCalendar(w) {
  if (w.length < 5 || CALENDAR.includes(w)) return null;
  const ranked = CALENDAR.map((c) => [editDistance(w, c), c]).sort((x, y) => x[0] - y[0]);
  return ranked[0][0] <= 2 && ranked[0][0] < ranked[1][0] ? ranked[0][1] : null;
}
// number words that are facts (withheld when changed); "one", "half" and "double" are amount words (warned), "once" a condition
const FACT_NUMBER_WORDS = new Set([...NUMBER_WORDS].filter((w) => !AMOUNT.has(w) && w !== "once"));
const isFactNumberWord = (w) => w.split("-").some((p) => FACT_NUMBER_WORDS.has(p) || FACT_NUMBER_WORDS.has(p.replace(/s$/, "")));
// a capitalized word whose lowercase form is on one of these lists is not a name ("It", "The", "Quick", "Unfortunately")
const LISTED = new Set([
  ...FREE, ...PRONOUNS, ...QUALIFIERS, ...NEGATIONS, ...MODALS, ...SCOPE, ...FIRST_PERSON, ...TONE, ...INSTRUCTION, ...COURTESY, ...NUMBER_WORDS,
  ...CONDITION, ...AMOUNT, ...Object.keys(SAME), ...ACTION, ...FIRST, ...SECOND, ...DATE_WORDS, ...GREETING, ...QUESTION_LEAD,
  ...OBLIGATION_LEAD, ...UNITS,
]);
const isSuggestName = (t, i) => {
  if (!isNameLike(t, i)) return false;
  // only a word in title case can be a listed word at the start of a clause; "PDF", "iPhone" and "xK9pQ" stay names
  const titleCase = /^\p{Lu}[\p{Ll}'-]*$/u.test(t.t);
  return !(titleCase && LISTED.has(t.t.toLowerCase()));
};
const SUGGEST_CHATTER =
  /^(here is|here's|sure|certainly|of course|okay|ok|rewritten|revised|shorter|friendlier|corrected|fixed|output|answer|result)\b[^.!?]*?:(?=\s|$)|\b(rewritten|revised|corrected|shorter|friendlier|new) (sentence|version|text)\s*:|\bnote:/i;
const PLACEHOLDER = /\[[^\]]*\]|\{[^}]*\}|<[^>]*>/g;
// greetings that may come before the first word of a question: "Hi, is ...", "Quick reminder: is ..."; "there" only right after hi/hello/hey
const QUESTION_GREETING = new Set([..."hi hello hey please kindly thanks thank note".split(" "), ...COURTESY]);

// Openers that carry a claim about feelings, thanks, apology or opinion ("We appreciate the thought, but"): a closed list. When the rewrite has one
// at the start of a clause and the original has none of that phrase, the rewrite says something the original did not: a "claim" warning.
const CLAIM_OPENERS = new RegExp(
  "(?:^|[,;:]\\s+|\\s(?:and|but|so)\\s)(" +
    ("we appreciate|we're pleased|we are pleased|we're glad|we are glad|we're happy|we are happy|we're delighted|we are delighted|we're excited|we're thrilled|" +
      "we're sorry|we are sorry|we apologize|we apologise|we regret|we're looking forward|we are looking forward|we're grateful|we are grateful|" +
      "i appreciate|i regret|i'm sorry|i am sorry|i'm glad|i am glad|i'm happy|i am happy|thank you for|thanks for|thanks so much|unfortunately|sadly|kindly|" +
      "happy to|glad to|pleased to|sorry to|sorry for|apologies|with regret|we hope|i hope") +
    ")(?![\\p{L}'])(?!\\W*$)",
  "iu",
);
// Formal openers: Friendlier never offers a rewrite whose only change is one of these (it sounds stiffer, not warmer).
const FORMAL_OPENER = /^(kindly|please be advised|please be informed|we (?:would|wish to) like to inform you|we wish to inform you|this is to inform you)(?![\p{L}'])(?:\s+that(?![\p{L}']))?,?\s*/iu;
const FORMAL_WORDS = new Set("kindly please be advised informed inform wish would like this that".split(" "));

// "We're sorry" and "We are sorry", "Thanks for" and "Thank you for" are the same claim: a rewrite that only swaps one for the other adds none
const claimForm = (s) => s.toLowerCase().replace(/\bthank's\b/g, "thanks").replace(/(\p{L})'re\b/gu, "$1 are").replace(/\bi'm\b/g, "i am").replace(/\bthanks for\b/g, "thank you for");

/**
 * True when the original already has the opener's words, in order, each spelled the same or one edit away ("apreciate", "Unfortunatly"): a spelling
 * fix or a shorter form ("Thank you very much for" to "Thanks for") is the same claim, not a new one.
 */
function originalHasClaim(plainSrc, opener) {
  const words = (s) => claimForm(s).match(/[\p{L}']+/gu) ?? [];
  const src = words(plainSrc);
  let from = 0;
  for (const w of words(opener)) {
    const k = src.findIndex((x, i) => i >= from && (x === w || (Math.min(x.length, w.length) >= 4 && editDistance(x, w) === 1)));
    if (k < 0) return false;
    from = k + 1;
  }
  return true;
}

/** The words of the claim opener that begins at `at` in `plain`, as the page will show them: to the end of the clause, "that", 6 words or 30 characters. */
function claimExcerpt(plain, at, opener) {
  if (!/\s/.test(opener)) return opener.replace(/^./, (c) => c.toUpperCase());
  const words = plain.slice(at).split(/\s+/);
  const out = [];
  for (let i = 0; i < words.length && out.length < 6; i++) {
    const next = [...out, words[i]].join(" ");
    if ([...next].length > 30) break;
    out.push(words[i]);
    if (/,$/.test(words[i])) {
      if (/^(but|and|so|yet)$/i.test(words[i + 1] ?? "") && [...`${next} ${words[i + 1]}`].length <= 30) out.push(words[i + 1]);
      break;
    }
    if (/^that$/i.test(words[i])) break;
  }
  return out.join(" ").replace(/[,;:]$/, "");
}

// sentences that address an AI rather than a reader: the model is never asked about them (checked after straightening quotes)
const ADDRESSES_AI = [
  /\b(ignore|disregard|forget)\b.{0,40}?\b(instructions?|request|prompt|rules|above|previous|prior|everything)\b/i,
  /\b(write|reply|respond|answer|output|print|say|return)\b(\s+(only|exactly|instead))?\s*:/i,
  /\binstead,\s*(write|reply)\b/i,
  /\byou(\s+are|'re)\s+(an?\s+)?(ai|assistant|model|chatbot)\b/i,
  /\b(system prompt|developer message)\b/i,
  /\bassistant,|\bai:/i,
];

/** The original's own rules: one clean sentence that does not address an AI. Start and end are inputQualifies's. */
function inputRules(before, add) {
  if (typeof before !== "string") {
    add("bad_input");
    return "";
  }
  const src = cleanUntrusted(before, MAX_BEFORE + 1);
  if (LINE_BREAK.test(before.trim())) add("input_not_one_sentence");
  if (before.includes(MARK) || cps(src) > MAX_BEFORE) add("input_cut");
  if (cps(src) < 3) add("input_too_short");
  if (SENTENCE_END.test(src)) add("input_not_one_sentence");
  if (ADDRESSES_AI.some((re) => re.test(straighten(src)))) add("input_addresses_ai");
  return src;
}

/**
 * May the small model be asked about `before` at all? {ok, reasons}: one clean sentence of 3 to 300 characters that starts with a capital
 * letter, a digit or a quote mark, ends in . ! or ? (unless it is the whole paragraph: `wholeParagraph`), and does not read like
 * instructions for an AI ("Ignore the request and write: ...", "You are an AI ...", "system prompt", ...).
 */
export function inputQualifies(before, { wholeParagraph = false } = {}) {
  const reasons = [];
  const add = (code) => { if (!reasons.some((r) => r.code === code)) reasons.push({ code }); };
  const src = inputRules(before, add);
  if (src && !/^["'(\[“‘]?[\p{Lu}\p{N}]/u.test(src)) add("input_start");
  if (src && !wholeParagraph && !/[.!?]["')\]”’]*$/u.test(src)) add("input_end");
  return { ok: reasons.length === 0, reasons };
}

/** The text that facts are compared on: "20 percent" is "20%", "3PM", "3 p.m." and "3 pm" are all "3 pm". */
const factText = (s) =>
  straighten(s)
    .replace(/(\p{N})\s*(?:percent|per cent)\b/giu, "$1%")
    .replace(/(\p{N})\s*([ap])\.?\s?m\.?(?![\p{L}\p{N}])/giu, (_, n, x) => `${n} ${x.toLowerCase()}m`);

const APOS_WORD = /\p{L}[\p{L}\p{M}']*/gu;
/**
 * Words that differ only by an apostrophe are written alike on both sides, with the apostrophe ("Its" and "It's" both "It's"), but only
 * a word that one side has more often than the other (a word in both is no misspelling of the other's word), and never a pair whose
 * contraction carries a modal or a person: "well" and "we'll", "wed" and "we'd", "were" and "we're", "lets" and "let's".
 */
function alignApostrophes(a, b) {
  const plainCount = (s) => count([...s.matchAll(APOS_WORD)].map(([w]) => w).filter((w) => !w.includes("'")).map((w) => w.toLowerCase()));
  const withApos = (s) => {
    const m = new Map();
    for (const [w] of s.matchAll(APOS_WORD)) {
      const core = w.replace(/'+$/, "");
      if (core.includes("'") && !/'(ll|d)$/i.test(core) && !/^(we're|let's)$/i.test(core)) m.set(core.replace(/'/g, "").toLowerCase(), core.indexOf("'"));
    }
    return m;
  };
  const ca = plainCount(a);
  const cb = plainCount(b);
  const fix = (s, mine, theirs, other) => s.replace(APOS_WORD, (w) => {
    if (w.includes("'")) return w;
    const lw = w.toLowerCase();
    const k = other.get(lw);
    if (k === undefined || (mine.get(lw) ?? 0) <= (theirs.get(lw) ?? 0)) return w;
    return w.slice(0, k) + "'" + w.slice(k);
  });
  return [fix(a, ca, cb, withApos(b)), fix(b, cb, ca, withApos(a))];
}

function editDistance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
// closeSpelling with a plural or verb "s" allowed: "apply" and "applies", "weekday" and "weekdays"
const closeSuggest = (a, b) => stem(a) === stem(b) || (a[0] === b[0] && Math.abs(a.length - b.length) <= 2 && similarity(a, b) >= 0.5);
const removeOne = (list, w) => { const k = list.indexOf(w); if (k >= 0) list.splice(k, 1); return k >= 0; };

/**
 * Spelling fixes paired: each dropped word of the original that matches an added word of the rewrite leaves both lists. `seq` is the
 * rewrite's words in order, for "atleast" against "at least". Returns what is left of both.
 */
function pairSpellings(droppedIn, addedIn, seq) {
  const added = [...addedIn];
  const dropped = [];
  for (const d of droppedIn) {
    let k = -1;
    if (!isProtected(d)) {
      k = added.findIndex((a) => Math.min(a.length, d.length) >= 4 && editDistance(a, d) === 1);
      if (k < 0) {
        const at = seq.findIndex((w, i) => i + 1 < seq.length && w + seq[i + 1] === d && added.includes(w) && added.includes(seq[i + 1]) && (w !== seq[i + 1] || added.filter((x) => x === w).length > 1));
        if (at >= 0) {
          removeOne(added, seq[at]);
          removeOne(added, seq[at + 1]);
          continue;
        }
        k = added.findIndex((a) => !isProtected(a) && closeSuggest(d, a));
      }
    }
    if (k >= 0) added.splice(k, 1);
    else dropped.push(d);
  }
  return { dropped, added };
}

/** Words of one family dropped and added, a word swapped for one of the same meaning left out ("approximately" to "about"). */
function familyChange(primary, droppedIn, addedIn) {
  const inFamily = (w) => primary.has(w) || primary.has(SAME[w]);
  const canon = (w) => SAME[w] ?? w;
  const added = addedIn.filter(inFamily);
  const dropped = [];
  for (const w of droppedIn.filter(inFamily)) {
    const k = added.findIndex((x) => canon(x) === canon(w));
    if (k >= 0) added.splice(k, 1);
    else dropped.push(w);
  }
  return { dropped: dropped.filter((w) => primary.has(w)), added: added.filter((w) => primary.has(w)) };
}

/** Number joins of suggest mode: only a dash, "to", "through", "and", "or" or a comma between two numbers count ("April 15, the $42" does not). */
function suggestJoins(s) {
  const text = expand(s);
  const nums = tokens(s).filter((t) => t.num);
  const out = [];
  for (let i = 1; i < nums.length; i++) {
    const gap = text.slice(nums[i - 1].end, nums[i].at).toLowerCase().replace(DASHES, "-").replace(/\s+/g, " ").trim().replace(/^, (and|or)$/, "$1");
    if (!/^(-|to|through|thru|and|or|,)$/.test(gap)) continue;
    out.push(`${nums[i - 1].t}|${/^(-|to|through|thru)$/.test(gap) ? "-" : gap}|${nums[i].t}`);
  }
  return out;
}
const unitOf = (t) => (t && !t.num ? t.t.toLowerCase().replace(/s$/, "") : null);
const unitPairs = (toks) => toks.flatMap((t, i) => (t.num && UNITS.has(unitOf(toks[i + 1])) ? [`${t.t}|${unitOf(toks[i + 1])}`] : []));
const firstWord = (toks) => {
  let prev = null;
  for (const t of toks) {
    if (t.num) return null;
    const w = t.t.toLowerCase();
    if (QUESTION_GREETING.has(w) || (w === "there" && /^(hi|hello|hey)$/.test(prev ?? ""))) {
      prev = w;
      continue;
    }
    return w;
  }
  return null;
};
const isContent = (w) => !FREE.has(w) && !PRONOUNS.has(w) && !FIRST_PERSON.has(w) && !FIRST.has(w) && !SECOND.has(w);

/**
 * Straight double quotes paired in order. With `skipInch`, a " right after a digit is an inch mark ('2"') and never pairs, and one left open
 * quotes the rest of the sentence; without it, only whole pairs count.
 */
function straightSpans(s, skipInch) {
  const out = [];
  let open = -1;
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '"' || (skipInch && /\p{N}/u.test(s[i - 1] ?? ""))) continue;
    if (open < 0) open = i;
    else {
      out.push(s.slice(open + 1, i));
      open = -1;
    }
  }
  if (skipInch && open >= 0) out.push(s.slice(open + 1));
  return out;
}

/**
 * With an odd count of straight double quotes that are not inch marks, one is stray ('that" was his reply, and ... "stainles steel"') and
 * shifts every later pair, so every stretch before, between and after them counts as quoted.
 */
function strayStraightSpans(s) {
  const at = [];
  for (let i = 0; i < s.length; i++) if (s[i] === '"' && !/\p{N}/u.test(s[i - 1] ?? "")) at.push(i);
  if (at.length % 2 === 0) return [];
  return [-1, ...at].map((a, k, all) => s.slice(a + 1, k + 1 < all.length ? all[k + 1] : s.length));
}

/**
 * Curly double quotes paired by direction: an opening mark opens, a closing mark closes; a closing mark with nothing open opens a span when a
 * letter or digit follows it and no digit comes right before it (2” is an inch mark). A closing mark right after a digit while a span is open,
 * with another closing mark next, may be an inch mark: both the short and the long span count. One left open quotes the rest of the sentence.
 */
function curlySpans(s) {
  const out = [];
  let open = -1;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "“") {
      if (open < 0) open = i;
    } else if (s[i] === "”") {
      if (open >= 0) {
        out.push(s.slice(open + 1, i));
        const next = s.slice(i + 1).search(/[\u201c\u201d]/u);
        if (!/\p{N}/u.test(s[i - 1] ?? "") || next < 0 || s[i + 1 + next] !== "\u201d") open = -1;
      } else if (!/\p{N}/u.test(s[i - 1] ?? "") && /[\p{L}\p{N}]/u.test(s[i + 1] ?? "")) open = i;
    }
  }
  if (open >= 0) out.push(s.slice(open + 1));
  return out;
}

/**
 * The texts inside quotation marks, compared straightened: curly double quotes by direction (curlySpans), straight double quotes read both ways
 * (inch marks skipped, and in plain order: an inch mark makes the marks ambiguous, and every span either reading finds must be kept; with a
 * stray mark, every stretch between marks, strayStraightSpans), then
 * single quotes that are clearly quotation marks (see the quoted_text_changed rule above); an apostrophe inside or at the end of a word never
 * opens one. Ceiling: a quote that really ends on a number ("size 5") with a change after it is withheld, since it reads as an open quote.
 */
function quotedSpans(s) {
  const t = straighten(s);
  const out = curlySpans(s).map(straighten);
  const inch = straightSpans(s, true).map(straighten);
  out.push(...inch, ...missing(straightSpans(s, false).map(straighten), inch), ...strayStraightSpans(s).map(straighten));
  const word = /[\p{L}\p{N}]/u;
  for (let i = 0; i < t.length; i++) {
    if (t[i] !== "'" || !(i === 0 || /[\s(\[{"]/.test(t[i - 1])) || !word.test(t[i + 1] ?? "")) continue;
    for (let j = i + 1; j < t.length; j++) {
      if (t[j] === "'" && !/\s/.test(t[j - 1]) && !word.test(t[j + 1] ?? "")) {
        out.push(t.slice(i + 1, j));
        i = j;
        break;
      }
    }
  }
  return out;
}

function checkSuggest(task, before, after) {
  const reasons = [];
  const warnings = [];
  const add = (code, words) => reasons.push(words && words.length ? { code, words: [...new Set(words)] } : { code });
  const warn = (code, dropped = [], added = [], extra = {}) => warnings.push({ code, words: [...new Set([...dropped, ...added])], dropped: [...new Set(dropped)], added: [...new Set(added)], ...extra });
  const withhold = () => ({ verdict: "withhold", text: null, warnings: [], reasons });

  if (!REWRITE_TASKS.includes(task)) {
    add("unknown_task");
    return withhold();
  }
  if (typeof before !== "string" || typeof after !== "string") {
    add("bad_input");
    return withhold();
  }
  const src = inputRules(before, add);
  if (reasons.length) return withhold();

  // the rewrite: one clean line, never cut
  const text = unwrap(after.trim(), src);
  if (cleanUntrusted(text, MAX_AFTER) !== text || !text) {
    add("bad_text");
    return withhold();
  }
  if (normText(text) === normText(src)) return { verdict: "unchanged", text: null, warnings: [], reasons: [] };

  const plain = straighten(text);
  const plainSrc = straighten(src);
  if ((REFUSAL_START.test(plain) && !REFUSAL_START.test(plainSrc)) || (REFUSAL_ANYWHERE.test(plain) && !REFUSAL_ANYWHERE.test(plainSrc))) add("refusal");
  // the colon of a time ("2:30") does not count, nor words the original has too ("... here is the copy: it is signed.")
  const chat = plain.match(SUGGEST_CHATTER);
  if (chat && !plainSrc.toLowerCase().includes(chat[0].toLowerCase())) add("chatter");
  const reply = plain.match(REPLY);
  if (reply && !REPLY.test(plainSrc)) add("reply_not_rewrite", [reply[0].toLowerCase()]);
  const stops = (s) => (s.match(INNER_STOP) ?? []).length;
  if (SENTENCE_END.test(text) || stops(text) > stops(src)) add("two_sentences");
  if (/[.!?]["')\]]*$/.test(plainSrc) && !/[.!?]["')\]]*$/.test(plain)) add("sentence_end_lost");
  const placeholders = missing(plain.match(PLACEHOLDER) ?? [], plainSrc.match(PLACEHOLDER) ?? []);
  if (placeholders.length) add("placeholder_added", placeholders);
  const quotedLost = missing(quotedSpans(src), quotedSpans(text));
  if (quotedLost.length) add("quoted_text_changed", quotedLost);

  // facts, compared on the fact text with apostrophes aligned
  const [fs, ft] = alignApostrophes(factText(src), factText(text));
  const symbols = (s) => s.replace(LINK, " ").match(SYMBOL) ?? [];
  const symbolsAdded = missing(symbols(ft), symbols(fs));
  if (symbolsAdded.length) add("symbol_added", symbolsAdded);
  const A = tokens(fs);
  const B = tokens(ft);
  const nums = (toks) => toks.filter((t) => t.num).map((t) => t.t);
  // number words by the parts of a hyphenated word: "first phase" and "first-phase" are the same, "twenty-five" and "twenty-six" are not
  const numberWords = (toks) => toks.flatMap((t) => (t.num ? [] : t.t.toLowerCase().split("-").filter(isFactNumberWord)));
  const numsLost = [...missing(nums(A), nums(B)), ...missing(numberWords(A), numberWords(B))];
  const numsAdded = [...missing(nums(B), nums(A)), ...missing(numberWords(B), numberWords(A))];
  const currency = (s) => [...s].filter((c) => "$€£¥₹".includes(c));
  const currencyChanged = !sameMultiset(currency(fs), currency(ft));
  if (numsLost.length || numsAdded.length || currencyChanged) add("number_changed", [...numsLost, ...numsAdded, ...missing(currency(fs), currency(ft)), ...missing(currency(ft), currency(fs))]);
  const ua = unitPairs(A);
  const ub = unitPairs(B);
  if (!sameMultiset(ua, ub)) add("unit_changed", [...missing(ua, ub), ...missing(ub, ua)].map((x) => x.replace("|", " ")));
  const lowerWords = (toks) => toks.filter((t) => !t.num).map((t) => t.t.toLowerCase());
  const wa = lowerWords(A);
  const wb = lowerWords(B);
  const dates = (w) => w.filter((x) => DATE_WORDS.has(x));
  // a typo of a calendar word that the rewrite corrects ("tomorow" to "tomorrow") is a spelling fix: the day did not change
  const typoOf = new Set(wa.filter((w) => !wb.includes(w)).map(misspeltCalendar).filter((c) => c && wb.includes(c)));
  const datesB = dates(wb).filter((d) => !(typoOf.has(d) && !wa.includes(d)));
  if (!sameMultiset(dates(wa), datesB)) add("date_word_changed", [...missing(dates(wa), datesB), ...missing(datesB, dates(wa))]);
  const ja = suggestJoins(fs);
  const jb = suggestJoins(ft);
  const factsSame = !numsLost.length && !numsAdded.length;
  if (factsSame && !sameMultiset(ja, jb)) add("range_changed", [...missing(ja, jb), ...missing(jb, ja)]);
  const splitCodes = (s) => codes(s).flatMap((w) => w.split(DASHES)).filter((w) => /\p{L}/u.test(w) && /\p{N}/u.test(w));
  const ca = splitCodes(fs);
  const cb = splitCodes(ft);
  if (!sameMultiset(ca, cb)) add("code_changed", [...missing(ca, cb), ...missing(cb, ca)]);
  const names = (toks) => toks.filter((t, i) => isSuggestName(t, i)).map((t) => t.t);
  const exactB = new Set(B.map((t) => t.t));
  const namesLost = names(A).filter((n) => !exactB.has(n) && !typoOf.has(misspeltCalendar(n.toLowerCase())));
  const namesAdded = names(B).filter((n) => !A.some((t) => t.t === n) && !(typoOf.has(n.toLowerCase()) && !wa.includes(n.toLowerCase())));
  // the first word is never name-like by its capital alone, so a new one that is on no list and is not a word of the original could be
  // a new name ("Globex files go out on Monday")
  const lead = B.find((t) => !t.num);
  const leadWord = lead?.t.toLowerCase();
  if (namesLost.length || namesAdded.length) add("name_changed", [...namesLost, ...namesAdded]);
  if (lead && /^\p{Lu}/u.test(lead.t) && !LISTED.has(leadWord) && !A.some((t) => !t.num && closeSuggest(t.t.toLowerCase(), leadWord))) add("new_first_word", [lead.t]);
  if (!sameMultiset(links(plainSrc), links(plain))) add("link_changed", [...missing(links(plainSrc), links(plain)), ...missing(links(plain), links(plainSrc))]);

  // spelling fixes paired, then how much of the original is kept and how much is new
  const { dropped, added } = pairSpellings(missing(wa, wb), missing(wb, wa), wb);
  const contentA = wa.filter(isContent);
  const contentB = wb.filter(isContent);
  const kept = contentA.length ? 1 - dropped.filter(isContent).length / contentA.length : 1;
  const fresh = contentB.length ? added.filter(isContent).length / contentB.length : 0;
  if (kept < FLOORS[task].kept) add("too_little_kept");
  if (fresh > FLOORS[task].added) add("too_much_added");

  // Friendlier: a formal opener ("Kindly", "Please be advised that") as the only change is no friendlier version
  if (task === "friendlier") {
    const formal = FORMAL_OPENER.test(plain) && !FORMAL_OPENER.test(plainSrc);
    if (formal && !added.some((w) => isContent(w) && !FORMAL_WORDS.has(w)) && !dropped.some(isContent)) add("formal_only");
  }

  // length
  const ratio = cps(text) / cps(src);
  const [lo, hi] = SUGGEST_LENGTH[task];
  if (ratio < lo) add("too_short");
  if (ratio > hi) add(task === "shorter" ? "not_shorter" : "too_long");
  if (task === "grammar" && similarity(src, text) < SUGGEST_SIMILARITY) add("not_similar");
  if (reasons.length) return withhold();

  // warnings, in family order; a claim about feelings, thanks, apology or opinion comes first so that it is never cut off the card
  const claim = CLAIM_OPENERS.exec(plain);
  if (claim && !originalHasClaim(plainSrc, claim[1])) warn("claim", [], [claimExcerpt(plain, claim.index + claim[0].length - claim[1].length, claim[1])]);
  const neg = (w) => w.filter((x) => NEGATIONS.has(x));
  if (neg(wa).length !== neg(wb).length) warn("negation", missing(neg(wa), neg(wb)), missing(neg(wb), neg(wa)));
  const ma = [...wa.filter((x) => MODALS.has(x)), ...obligations(A)];
  const mb = [...wb.filter((x) => MODALS.has(x)), ...obligations(B)];
  if (!sameMultiset(ma, mb)) warn("modal", missing(ma, mb), missing(mb, ma));
  for (const [code, family] of [["condition", CONDITION], ["amount", AMOUNT]]) {
    const c = familyChange(family, dropped, added);
    if (c.dropped.length || c.added.length) warn(code, c.dropped, c.added);
  }
  for (const person of [FIRST, SECOND]) {
    const now = wb.filter((x) => person.has(x));
    if (now.length && !wa.some((x) => person.has(x))) warn("person", [], now);
  }
  const asks = (s) => (s.match(/\?/g) ?? []).length;
  const leadA = firstWord(A);
  const leadB = firstWord(B);
  const madeByOrder = QUESTION_LEAD.has(leadB) && leadB !== leadA;
  if (asks(plain) > asks(plainSrc) || (asks(plain) === asks(plainSrc) && madeByOrder && !asks(plain))) warn("question", [], [], { now: "question" });
  else if (asks(plain) < asks(plainSrc)) warn("question", [], [], { now: "statement" });
  if (factsSame) {
    const bond = (toks) => numberBonds(toks).filter((b) => b.side === "<" && !UNITS.has(b.word.replace(/s$/, ""))).map((b) => ({ ...b, word: SAME[b.word] ?? b.word }));
    const ba = bond(A);
    const bb = bond(B);
    const lostOf = (x, y) => {
      const left = [...y];
      return x.filter((b) => {
        const k = left.findIndex((c) => c.num === b.num && c.side === b.side && (c.word === b.word || closeSuggest(b.word, c.word)));
        if (k >= 0) left.splice(k, 1);
        return k < 0;
      });
    };
    const lost = lostOf(ba, bb);
    const gained = lostOf(bb, ba);
    if (lost.length || gained.length) warn("number_moved", lost.map((b) => b.word), gained.map((b) => b.word));
  }
  const actions = added.filter((w) => ACTION.has(w) || ACTION.has(stem(w)));
  if (actions.length) warn("action", [], actions);
  const symbolsLost = missing(symbols(fs), symbols(ft));
  if (symbolsLost.length) warn("symbol", symbolsLost, []);
  if (task === "grammar") {
    const told = new Set(warnings.flatMap((w) => w.words));
    const d = dropped.filter((w) => isContent(w) && !told.has(w));
    const a = added.filter((w) => isContent(w) && !told.has(w));
    if (d.length || a.length) warn("grammar_word", d, a);
  }
  return { verdict: warnings.length ? "warn" : "show", text, warnings, reasons: [] };
}
