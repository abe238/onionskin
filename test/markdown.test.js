// Markdown reading with exact source offsets (src/markdown.js): what the preview shows for each source, and which exact source range a
// selection in the preview stands for (or the whole block it falls back to, or why it is refused). The fixture table is the contract
// every later reader and writer must agree with; its offsets are written out by hand, never computed from the source. Then properties
// over generated inputs: runs and skips tile the source, every run relates to its source by its kind's rule, identical replacements
// are the identity, and 1 MiB adversarial inputs stay within 2 seconds.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CapError } from "../src/xml.js";
import { MD_LIMITS, applyReplacements, isVerbatim, readMarkdown, sourceOffset, sourceRange } from "../src/markdown.js";

// ---- helpers -------------------------------------------------------------------------------------------------------------------
/** The inline nodes as text, spans marked {em:...}, {strong:...}, {code:...}, {link(href):...}, {img(src):...}. */
function inl(nodes) {
  return nodes
    .map((x) => {
      if (x.type === "run") return x.display;
      const head = x.type === "link" ? `link(${x.href})` : x.type === "image" ? `img(${x.src})` : x.type;
      return `{${head}:${inl(x.children)}}`;
    })
    .join("");
}
const TAG = { paragraph: "p", quote: "bq", item: "li" };
/** One line per leaf block: its path ("bq>ul>li>p") and what it shows. Blank blocks are left out. */
function shown(tree) {
  const out = [];
  const walk = (blocks, path) => {
    for (const b of blocks) {
      if (b.type === "blank") continue;
      const tag = b.type === "heading" ? `h${b.level}` : b.type === "list" ? (b.ordered ? "ol" : "ul") : b.type === "literal" ? (b.what === "frontmatter" ? "fm" : "html") : b.type === "code" && b.info ? `code[${b.info}]` : TAG[b.type] || b.type;
      const p = path ? `${path}>${tag}` : tag;
      if (b.type === "quote") walk(b.children, p);
      else if (b.type === "list") for (const it of b.items) walk(it.children, `${p}>li`);
      else if (b.type === "table") out.push(`${p} ${b.rows.map((r) => r.cells.map((c) => inl(c.inline)).join(" ¦ ")).join(" / ")}`);
      else if (b.type === "hr") out.push(p);
      else out.push(`${p} ${inl(b.inline)}`);
    }
  };
  walk(tree.blocks, "");
  return out;
}
/**
 * The selection a person makes by highlighting `needle` (the `occ`-th time it shows) in the preview: the start in the run that holds
 * its first character, the end in the run that holds its last. [a, b] highlights from the start of `a` to the end of the next `b`.
 * This searches the DISPLAYED text, as a person's eyes do; the module itself never searches.
 */
function pick(tree, needle, occ = 0) {
  const R = tree.runs;
  const starts = [];
  let all = "";
  for (const r of R) starts.push(all.length), (all += r.display);
  const at = (g, isEnd) => {
    for (let k = 0; k < R.length; k++) {
      const a = starts[k];
      const b = a + R[k].display.length;
      if (isEnd ? g > a && g <= b : g >= a && g < b) return [k, g - a];
    }
    throw new Error(`no run at ${g}`);
  };
  let from;
  let to;
  if (Array.isArray(needle)) {
    from = all.indexOf(needle[0]);
    const e = all.indexOf(needle[1], from + 1);
    assert.ok(from >= 0 && e >= 0, `needles ${JSON.stringify(needle)} not shown in ${JSON.stringify(all)}`);
    to = e + needle[1].length;
  } else {
    from = -1;
    for (let k = 0; k <= occ; k++) from = all.indexOf(needle, from + 1);
    assert.ok(from >= 0, `${JSON.stringify(needle)} (#${occ}) not shown in ${JSON.stringify(all)}`);
    to = from + needle.length;
  }
  const [startRun, startOffset] = at(from, false);
  const [endRun, endOffset] = at(to, true);
  return { startRun, startOffset, endRun, endOffset };
}
/** A raw selection: the run that shows `needle`, at offsets a..b of that run's display. */
function inRun(tree, needle, a, b) {
  const r = tree.runs.find((x) => x.display.includes(needle));
  assert.ok(r, `no run shows ${JSON.stringify(needle)}`);
  const base = r.display.indexOf(needle);
  return { startRun: r.id, startOffset: base + a, endRun: r.id, endOffset: base + b };
}

// ---- the fixture table ---------------------------------------------------------------------------------------------------------
// sel: [selection, expected]. selection: a needle (string), [needle, occurrence], {span: [a, b]} (from a to the end of b), or a
// function of the tree. expected: {from, to, quote} for an exact range; {block: [from, to]} for the whole-block offer; "refused".
const CASES = [
  // empty and whitespace
  { name: "empty file", src: "", show: [] },
  { name: "whitespace only", src: "   \n\t\n  ", show: [] },
  // plain text and emphasis
  { name: "plain paragraph", src: "Hello world", show: ["p Hello world"], sel: [["world", { from: 6, to: 11, quote: "world" }]] },
  { name: "bold", src: "a **red** b", show: ["p a {strong:red} b"], sel: [["red", { from: 4, to: 7, quote: "red" }], ["a red", { block: [0, 11] }]] },
  { name: "bold inside a word", src: "un**believ**able", show: ["p un{strong:believ}able"], sel: [["believ", { from: 4, to: 10, quote: "believ" }], ["unbeliev", { block: [0, 16] }]] },
  { name: "underscores inside a word stay text", src: "snake_case_name", show: ["p snake_case_name"], sel: [["case", { from: 6, to: 10, quote: "case" }]] },
  { name: "nested emphasis", src: "***both*** and *one **two** one*", show: ["p {em:{strong:both}} and {em:one {strong:two} one}"], sel: [["two", { from: 22, to: 25, quote: "two" }], ["both", { from: 3, to: 7, quote: "both" }]] },
  { name: "underscore emphasis", src: "_a_ and __b__", show: ["p {em:a} and {strong:b}"], sel: [["b", { from: 10, to: 11, quote: "b" }]] },
  { name: "rule of three", src: "*foo**bar**baz*", show: ["p {em:foo{strong:bar}baz}"], sel: [["bar", { from: 6, to: 9, quote: "bar" }]] },
  { name: "leftover delimiter", src: "**foo*", show: ["p *{em:foo}"], sel: [["foo", { from: 2, to: 5, quote: "foo" }], ["*foo", { block: [0, 6] }]] },
  { name: "unmatched delimiters are text", src: "2 * 3 * 4 and **open", show: ["p 2 * 3 * 4 and **open"], sel: [["* 3 *", { from: 2, to: 7, quote: "* 3 *" }]] },
  { name: "intraword underscores at the end", src: "foo_bar_", show: ["p foo_bar_"] },
  { name: "unterminated strong at end of file", src: "**bold never closed", show: ["p **bold never closed"], sel: [["**bold", { from: 0, to: 6, quote: "**bold" }]] },
  // entities and escapes
  {
    name: "entities",
    src: "Fish &amp; chips &#233;t&eacute; &copy; 2026",
    show: ["p Fish & chips été © 2026"],
    sel: [["&", { from: 5, to: 10, quote: "&amp;" }], ["été", { from: 17, to: 32, quote: "&#233;t&eacute;" }], ["©", { from: 33, to: 39, quote: "&copy;" }]],
  },
  { name: "unknown entities stay literal", src: "&bogus; and &#xZZ;", show: ["p &bogus; and &#xZZ;"], sel: [["bogus", { from: 1, to: 6, quote: "bogus" }]] },
  {
    name: "astral numeric entity",
    src: "smile &#x1F600; now",
    show: ["p smile 😀 now"],
    sel: [["😀", { from: 6, to: 15, quote: "&#x1F600;" }], [(t) => inRun(t, "😀", 0, 1), { block: [0, 19] }]],
  },
  {
    name: "backslash escapes",
    src: "\\*not em\\* and \\# and \\a",
    show: ["p *not em* and # and \\a"],
    sel: [["*not em*", { from: 0, to: 10, quote: "\\*not em\\*" }], ["\\a", { from: 22, to: 24, quote: "\\a" }], [(t) => inRun(t, "#", 0, 0), "refused"]],
  },
  // code spans
  { name: "code span keeps its spaces", src: "use `a  b` here", show: ["p use {code:a  b} here"], sel: [["a  b", { from: 5, to: 9, quote: "a  b" }], ["use a", { block: [0, 15] }]] },
  { name: "code span with a backtick inside", src: "``code with ` tick``", show: ["p {code:code with ` tick}"], sel: [["` tick", { from: 12, to: 18, quote: "` tick" }]] },
  { name: "code span with spaces at the ends (verbatim)", src: "` a `", show: ["p {code: a }"], sel: [["a", { from: 2, to: 3, quote: "a" }]] },
  { name: "unclosed backtick is text", src: "a `b c", show: ["p a `b c"], sel: [["`b", { from: 2, to: 4, quote: "`b" }]] },
  // links and images
  {
    name: "repeated identical link labels",
    src: "see [here](a.md) and [here](b.md)",
    show: ["p see {link(a.md):here} and {link(b.md):here}"],
    sel: [[["here", 0], { from: 5, to: 9, quote: "here" }], [["here", 1], { from: 22, to: 26, quote: "here" }], [{ span: ["here", "here"] }, { block: [0, 33] }]],
  },
  {
    name: "link destination with parentheses",
    src: "[wiki](https://en.wikipedia.org/wiki/Foo_(bar)) end",
    show: ["p {link(https://en.wikipedia.org/wiki/Foo_(bar)):wiki} end"],
    sel: [[["wiki", 0], { from: 1, to: 5, quote: "wiki" }], ["end", { from: 48, to: 51, quote: "end" }]],
  },
  { name: "link with a title", src: '[a](/u "T") b', show: ["p {link(/u):a} b"], sel: [["b", { from: 12, to: 13, quote: "b" }]] },
  { name: "angle-bracket destination", src: "[a](<my file.md>)", show: ["p {link(my file.md):a}"], sel: [["a", { from: 1, to: 2, quote: "a" }]] },
  {
    name: "emphasis inside a link label",
    src: "[**bold** link](x)",
    show: ["p {link(x):{strong:bold} link}"],
    sel: [["bold", { from: 3, to: 7, quote: "bold" }], ["link", { from: 10, to: 14, quote: "link" }], ["bold link", { block: [0, 18] }]],
  },
  { name: "a link inside a link label stays text around it", src: "[a [b](c) d](e)", show: ["p [a {link(c):b} d](e)"], sel: [["d](e)", { from: 10, to: 15, quote: "d](e)" }]] },
  { name: "reference links are literal", src: "[just brackets] and [ref][x]", show: ["p [just brackets] and [ref][x]"], sel: [["[just", { from: 0, to: 5, quote: "[just" }]] },
  { name: "unterminated link at end of file", src: "[a](b", show: ["p [a](b"], sel: [["a](b", { from: 1, to: 5, quote: "a](b" }]] },
  {
    name: "image is literal and never loaded",
    src: 'Look ![a cat](cat.png "t") here',
    show: ['p Look {img(cat.png):![a cat](cat.png "t")} here'],
    sel: [["a cat", { from: 7, to: 12, quote: "a cat" }], ["Look ![", { from: 0, to: 7, quote: "Look ![" }]],
  },
  { name: "a link inside image alt stays literal", src: "![x [y](z)](p.png)", show: ["p {img(p.png):![x [y](z)](p.png)}"] },
  { name: "autolinks are literal", src: "go <https://a.b> now", show: ["p go <https://a.b> now"], sel: [["https", { from: 4, to: 9, quote: "https" }]] },
  // headings
  { name: "heading with trailing #s", src: "## Title ##", show: ["h2 Title"], sel: [["Title", { from: 3, to: 8, quote: "Title" }]] },
  { name: "closing #s need a space before them", src: "### C# ###   ", show: ["h3 C#"], sel: [["C#", { from: 4, to: 6, quote: "C#" }]] },
  { name: "escaped closing #", src: "# foo \\#", show: ["h1 foo #"], sel: [["foo #", { from: 2, to: 8, quote: "foo \\#" }]] },
  { name: "empty heading and a hashtag", src: "#\n#hashtag", show: ["h1 ", "p #hashtag"] },
  { name: "heading with code and link", src: "# Use `npm` [docs](d)", show: ["h1 Use {code:npm} {link(d):docs}"] },
  { name: "setext underline stays text", src: "Title\n=====", show: ["p Title ====="], sel: [["Title", { from: 0, to: 5, quote: "Title" }]] },
  // lists
  {
    name: "nested lists three deep",
    src: "- one\n  - two\n    - three\n- four",
    show: ["ul>li>p one", "ul>li>ul>li>p two", "ul>li>ul>li>ul>li>p three", "ul>li>p four"],
    sel: [["three", { from: 20, to: 25, quote: "three" }], ["four", { from: 28, to: 32, quote: "four" }], [{ span: ["two", "three"] }, "refused"]],
  },
  { name: "ordered list keeps its start", src: "3. a\n4. b", show: ["ol>li>p a", "ol>li>p b"], check: (t) => assert.equal(t.blocks[0].start, 3) },
  { name: "ordered list with )", src: "1) x\n2) y", show: ["ol>li>p x", "ol>li>p y"] },
  {
    name: "task markers are literal",
    src: "- [ ] todo\n- [x] done",
    show: ["ul>li>p [ ] todo", "ul>li>p [x] done"],
    sel: [["[x]", { from: 13, to: 16, quote: "[x]" }]],
    check: (t) => assert.deepEqual(t.blocks[0].items.map((i) => i.task), [{ checked: false, from: 2, to: 5 }, { checked: true, from: 13, to: 16 }]),
  },
  { name: "wrapped line in a list item", src: "- alpha\n  beta", show: ["ul>li>p alpha beta"], sel: [["alpha beta", { from: 2, to: 14, quote: "alpha\n  beta" }]] },
  { name: "lazy continuation starts a paragraph", src: "- alpha\nbeta", show: ["ul>li>p alpha", "p beta"] },
  { name: "loose list", src: "- a\n\n- b", show: ["ul>li>p a", "ul>li>p b"], check: (t) => assert.equal(t.blocks[0].tight, false) },
  { name: "item starting with a blank line", src: "-\n  foo", show: ["ul>li>p foo"], sel: [["foo", { from: 4, to: 7, quote: "foo" }]] },
  { name: "indented code in a list item", src: "-     code", show: ["ul>li>code code"], sel: [["code", { from: 6, to: 10, quote: "code" }]] },
  { name: "a bullet interrupts a paragraph, a 2. does not", src: "text\n- item\n\ntext\n2. no", show: ["p text", "ul>li>p item", "p text 2. no"] },
  { name: "tab after a list marker and in indentation", src: "-\ta\n\tb", show: ["ul>li>p a b"], sel: [["a b", { from: 2, to: 6, quote: "a\n\tb" }]] },
  { name: "code span across a line in a list item", src: "- `a\n  b`", show: ["ul>li>p {code:a\nb}"], sel: [["b", { from: 7, to: 8, quote: "b" }], ["a\nb", { block: [2, 9] }]] },
  { name: "link destination on the next line in a list item", src: "- [a](\n  u)", show: ["ul>li>p {link(u):a}"], sel: [["a", { from: 3, to: 4, quote: "a" }]] },
  // block quotes
  {
    name: "block quote containing a list",
    src: "> - a\n> - b\n>\n> text",
    show: ["bq>ul>li>p a", "bq>ul>li>p b", "bq>p text"],
    sel: [["b", { from: 10, to: 11, quote: "b" }], ["text", { from: 16, to: 20, quote: "text" }]],
  },
  { name: "wrapped line in a quote offers the block", src: "> one\n> two", show: ["bq>p one two"], sel: [["one two", { block: [2, 11] }], ["two", { from: 8, to: 11, quote: "two" }]] },
  { name: "emphasis across a line in a quote", src: "> *a\n> b*", show: ["bq>p {em:a b}"], sel: [["a", { from: 3, to: 4, quote: "a" }], ["b", { from: 7, to: 8, quote: "b" }]] },
  { name: "link label across a line in a quote", src: "> [a\n> b](u)", show: ["bq>p {link(u):a b}"], sel: [["a b", { block: [2, 12] }], ["b", { from: 7, to: 8, quote: "b" }]] },
  { name: "image across a line in a quote", src: "> ![a\n> b](p)", show: ["bq>p {img(p):![a\nb](p)}"], sel: [["a", { from: 4, to: 5, quote: "a" }], ["a\nb", { block: [2, 13] }]] },
  { name: "nested quote", src: ">> deep", show: ["bq>bq>p deep"], sel: [["deep", { from: 3, to: 7, quote: "deep" }]] },
  // tables
  {
    name: "table with inline formatting and escaped pipes",
    src: "| Name | Note |\n| --- | :-: |\n| **Bo** | a \\| b |\n| `x\\|y` | *i* |",
    show: ["table Name ¦ Note / {strong:Bo} ¦ a | b / {code:x|y} ¦ {em:i}"],
    sel: [["Bo", { from: 34, to: 36, quote: "Bo" }], ["a | b", { from: 41, to: 47, quote: "a \\| b" }], [{ span: ["Bo", "a"] }, { block: [0, 66] }]],
    check: (t) => assert.deepEqual(t.blocks[0].align, [null, "center"]),
  },
  { name: "table without outer pipes", src: "a | b\n--|--\n1 | 2", show: ["table a ¦ b / 1 ¦ 2"], sel: [["2", { from: 16, to: 17, quote: "2" }]] },
  { name: "header and delimiter cell counts differ: not a table", src: "a | b\n---", show: ["p a | b ---"] },
  { name: "table inside a quote", src: "> | a |\n> |---|\n> | b |", show: ["bq>table a / b"], sel: [["b", { from: 20, to: 21, quote: "b" }]] },
  // code blocks
  { name: "fenced code with a longer fence around a shorter one", src: "````md\n```\ninner\n```\n````", show: ["code[md] ```\ninner\n```"], sel: [["inner", { from: 11, to: 16, quote: "inner" }]] },
  { name: "tilde fence with info and CRLF", src: "~~~ js \r\nlet a = 1;\r\n~~~\r\n", show: ["code[js] let a = 1;"], sel: [["a = 1", { from: 13, to: 18, quote: "a = 1" }]] },
  { name: "unterminated fence at end of file", src: "```\nnever closed\n", show: ["code never closed"], check: (t) => assert.equal(t.blocks[0].closed, false) },
  { name: "indented code", src: "    code here\n\n    more", show: ["code code here\n\nmore"], sel: [["more", { from: 19, to: 23, quote: "more" }]] },
  { name: "thematic breaks", src: "a\n\n***\n\n* * *\nb", show: ["p a", "hr", "hr", "p b"] },
  // literal blocks
  {
    name: "front matter",
    src: "---\ntitle: Hi\ntags: [a]\n---\n# Body",
    show: ["fm ---\ntitle: Hi\ntags: [a]\n---", "h1 Body"],
    sel: [["Hi", { from: 11, to: 13, quote: "Hi" }]],
    check: (t) => assert.equal(t.blocks[0].protected, true),
  },
  { name: "--- later in the file is not front matter", src: "x\n---\ny: 1\n---", show: ["p x --- y: 1 ---"] },
  {
    name: "raw HTML block shown literally",
    src: '<div class="x">\n*not em*\n</div>\n\nafter',
    show: ['html <div class="x">\n*not em*\n</div>', "p after"],
    sel: [["not em", { from: 17, to: 23, quote: "not em" }]],
  },
  { name: "HTML comment block", src: "<!-- note\n**x** -->\ntext", show: ["html <!-- note\n**x** -->", "p text"] },
  { name: "script block shown literally", src: "<script>\nalert(1)\n</script>\nok", show: ["html <script>\nalert(1)\n</script>", "p ok"] },
  {
    name: "inline HTML shown literally",
    src: 'a <span title="*x*">b</span> c',
    show: ['p a <span title="*x*">b</span> c'],
    sel: [["b", { from: 20, to: 21, quote: "b" }], ['"*x*"', { from: 14, to: 19, quote: '"*x*"' }], ['x*">b', { from: 16, to: 21, quote: 'x*">b' }]],
  },
  { name: "a < b > c is text", src: "a < b > c", show: ["p a < b > c"], sel: [["< b >", { from: 2, to: 7, quote: "< b >" }]] },
  { name: "a tag at the start of a paragraph keeps the paragraph", src: "<b>Note:</b> some **bold**", show: ["p <b>Note:</b> some {strong:bold}"], sel: [["bold", { from: 20, to: 24, quote: "bold" }]] },
  { name: "a custom tag alone on its line is an HTML block", src: "<x-note>\n*kept*\n</x-note>\n\n*em*", show: ["html <x-note>\n*kept*\n</x-note>", "p {em:em}"] },
  // more links and fences
  { name: "badge: an image inside a link", src: "[![alt](i.png)](u)", show: ["p {link(u):{img(i.png):![alt](i.png)}}"], sel: [["alt", { from: 3, to: 6, quote: "alt" }]] },
  {
    name: "link title on the next line in a list item",
    src: '- [a](u\n  "t") b',
    show: ["ul>li>p {link(u):a} b"],
    sel: [["b", { from: 15, to: 16, quote: "b" }]],
    check: (t) => assert.equal(t.blocks[0].items[0].children[0].inline[0].title, "t"),
  },
  { name: "a longer fence closes a shorter one", src: "```\na\n````\nb", show: ["code a", "p b"], sel: [["b", { from: 11, to: 12, quote: "b" }]] },
  { name: "a tilde fence does not close a backtick fence", src: "```\n~~~\n```", show: ["code ~~~"], sel: [["~~~", { from: 4, to: 7, quote: "~~~" }]] },
  // characters
  {
    name: "emoji and other astral characters",
    src: "I 😀 **you** 👍🏽",
    show: ["p I 😀 {strong:you} 👍🏽"],
    sel: [["😀", { from: 2, to: 4, quote: "😀" }], ["you", { from: 7, to: 10, quote: "you" }], ["👍🏽", { from: 13, to: 17, quote: "👍🏽" }], [(t) => inRun(t, "😀", 0, 1), { block: [0, 17] }], [(t) => inRun(t, "👍🏽", 0, 2), { block: [0, 17] }]],
  },
  {
    name: "Café precomposed and decomposed",
    src: "Café and Cafe\u0301",
    show: ["p Café and Cafe\u0301"],
    sel: [["Café", { from: 0, to: 4, quote: "Café" }], ["Cafe\u0301", { from: 9, to: 14, quote: "Cafe\u0301" }], [(t) => inRun(t, "Cafe\u0301", 0, 4), { block: [0, 14] }]],
  },
  { name: "combining accent inside emphasis", src: "*e\u0301*", show: ["p {em:e\u0301}"], sel: [["e\u0301", { from: 1, to: 3, quote: "e\u0301" }]] },
  // line endings and BOM
  { name: "CRLF soft break", src: "one\r\ntwo\r\n", show: ["p one two"], sel: [["one two", { from: 0, to: 8, quote: "one\r\ntwo" }], [" ", { from: 3, to: 5, quote: "\r\n" }]] },
  {
    name: "mixed line endings",
    src: "a\nb\r\nc\rd",
    show: ["p a b c d"],
    sel: [["c d", { from: 5, to: 8, quote: "c\rd" }]],
    check: (t) => assert.deepEqual(t.info.newlines, { lf: 1, crlf: 1, cr: 1 }),
  },
  { name: "hard breaks", src: "a  \nb\\\nc", show: ["p a\nb\nc"], sel: [["a\nb", { from: 0, to: 5, quote: "a  \nb" }], ["b\nc", { from: 4, to: 8, quote: "b\\\nc" }]] },
  { name: "BOM is outside every offset", src: "\uFEFF# Hi\n", show: ["h1 Hi"], sel: [["Hi", { from: 2, to: 4, quote: "Hi" }]], check: (t) => (assert.equal(t.bom, true), assert.equal(t.text, "# Hi\n")) },
  // selections that do not map
  { name: "selection across blocks is refused", src: "para one\n\npara two", show: ["p para one", "p para two"], sel: [[{ span: ["one", "para two"] }, "refused"]] },
  {
    name: "a selection ending at the start of the next block is the first block",
    src: "first\n\nsecond",
    show: ["p first", "p second"],
    sel: [[() => ({ startRun: 0, startOffset: 0, endRun: 1, endOffset: 0 }), { from: 0, to: 5, quote: "first" }]],
  },
  { name: "backward selection", src: "abc", show: ["p abc"], sel: [[() => ({ startRun: 0, startOffset: 3, endRun: 0, endOffset: 1 }), { from: 1, to: 3, quote: "bc" }]] },
  { name: "empty and unknown selections are refused", src: "abc", show: ["p abc"], sel: [[() => ({ startRun: 0, startOffset: 2, endRun: 0, endOffset: 2 }), "refused"], [() => ({ startRun: 5, startOffset: 0, endRun: 5, endOffset: 1 }), "refused"], [() => ({ startRun: 0, startOffset: 0, endRun: 0, endOffset: 4 }), "refused"]] },
];

const resolveSel = (tree, s) => {
  if (typeof s === "function") return s(tree);
  if (typeof s === "string") return pick(tree, s);
  if (Array.isArray(s)) return pick(tree, s[0], s[1]);
  return pick(tree, s.span);
};

test("the fixture table: what each source shows, and the source range each selection stands for", () => {
  assert.ok(CASES.length >= 60, `${CASES.length} cases`);
  for (const c of CASES) {
    const tree = readMarkdown(c.src);
    assert.deepEqual(shown(tree), c.show, `${c.name}: shown`);
    for (const [s, want] of c.sel || []) {
      const got = sourceRange(tree, resolveSel(tree, s));
      const label = `${c.name}: ${JSON.stringify(typeof s === "function" ? "raw" : s)}`;
      if (want === "refused") assert.equal(got.refused, true, `${label} -> ${JSON.stringify(got)}`);
      else if (want.block) assert.deepEqual(got.block && [got.block.from, got.block.to], want.block, `${label} -> ${JSON.stringify(got)}`);
      else assert.deepEqual(got, want, label);
      if (got.block) assert.equal(got.block.source, tree.text.slice(got.block.from, got.block.to));
      if (got.block || got.refused) assert.equal(typeof got.reason, "string");
    }
    if (c.check) c.check(tree);
    checkTiling(c.src, tree, c.name);
  }
});

// ---- carets --------------------------------------------------------------------------------------------------------------------
test("a caret maps to its run's own edge, inside atomic runs it is null, and an empty file starts at zero", () => {
  const t = readMarkdown("a **red** b &amp; 😀");
  const red = t.runs.find((r) => r.display === "red");
  const after = t.runs[red.id + 1];
  assert.equal(sourceOffset(t, red.id, 3), 7, "end of red is before the closing ** (inside the bold)");
  assert.equal(sourceOffset(t, after.id, 0), 9, "start of the next run is after the closing **");
  assert.equal(sourceOffset(t, red.id, 1), 5);
  const amp = t.runs.find((r) => r.kind === "entity");
  assert.equal(sourceOffset(t, amp.id, 0), 12);
  assert.equal(sourceOffset(t, amp.id, 1), 17);
  const last = t.runs[t.runs.length - 1];
  assert.equal(sourceOffset(t, last.id, last.display.length - 1), null, "inside the surrogate pair of 😀");
  assert.equal(sourceOffset(t, 99, 0), null);
  assert.equal(sourceOffset(readMarkdown(""), null, 0), 0);
  assert.equal(sourceOffset(readMarkdown("  \n"), null, 0), 0);
  const ent = readMarkdown("x&#x1F600;y");
  const e = ent.runs.find((r) => r.kind === "entity");
  assert.equal(sourceOffset(ent, e.id, 1), null, "inside an entity that shows two code units");
});

// ---- replacements --------------------------------------------------------------------------------------------------------------
test("applyReplacements: exact splices, the whole call refused on any stale, overlapping or splitting replacement", () => {
  const src = "a **red** b\n";
  assert.equal(applyReplacements(src, [{ from: 4, to: 7, old: "red", new: "blue" }]), "a **blue** b\n");
  assert.equal(applyReplacements(src, [{ from: 10, to: 11, old: "b", new: "c" }, { from: 0, to: 1, old: "a", new: "z" }]), "z **red** c\n");
  assert.equal(applyReplacements(src, [{ from: 12, to: 12, old: "", new: "more\n" }]), "a **red** b\nmore\n");
  assert.equal(applyReplacements(src, []), src);
  const bom = "\uFEFF# Hi\r\n";
  assert.equal(applyReplacements(bom, [{ from: 2, to: 4, old: "Hi", new: "Yo" }]), "\uFEFF# Yo\r\n");
  const code = (fn) => {
    try {
      fn();
    } catch (e) {
      return e.code;
    }
    return "accepted";
  };
  assert.equal(code(() => applyReplacements(src, [{ from: 4, to: 7, old: "rex", new: "x" }])), "stale");
  assert.equal(code(() => applyReplacements(src, [{ from: 4, to: 7, old: "red", new: "x" }, { from: 6, to: 8, old: "d*", new: "" }])), "overlap");
  assert.equal(code(() => applyReplacements(src, [{ from: 4, to: 4, old: "", new: "x" }, { from: 4, to: 7, old: "red", new: "y" }])), "overlap");
  assert.equal(code(() => applyReplacements(src, [{ from: 4, to: 99, old: "", new: "" }])), "invalid");
  assert.equal(code(() => applyReplacements(src, [{ from: 1.5, to: 2, old: "", new: "" }])), "invalid");
  assert.equal(code(() => applyReplacements(src, "nope")), "invalid");
  assert.equal(code(() => applyReplacements("a😀b", [{ from: 1, to: 2, old: "\ud83d", new: "x" }])), "split");
  // a refused call changes nothing: the second, valid replacement is not applied either
  assert.equal(code(() => applyReplacements(src, [{ from: 0, to: 1, old: "a", new: "z" }, { from: 4, to: 7, old: "RED", new: "x" }])), "stale");
});

test("replacing an exact selection changes the display only there", () => {
  for (const [src, needle, word] of [["a **red** b", "red", "blue"], ["see [here](a.md) and [here](b.md)", ["here", 1], "there"], ["| Name | Note |\n| --- | :-: |\n| **Bo** | x |", "Bo", "Al"], ["> - one\n> - two", "two", "three"]]) {
    const t = readMarkdown(src);
    const r = sourceRange(t, Array.isArray(needle) ? pick(t, needle[0], needle[1]) : pick(t, needle));
    assert.ok(r.quote, JSON.stringify(r));
    const next = readMarkdown(applyReplacements(src, [{ from: r.from, to: r.to, old: r.quote, new: word }]));
    const before = shown(t).join("\n");
    const after = shown(next).join("\n");
    const q = Array.isArray(needle) ? needle[0] : needle;
    let at = -1;
    for (let k = 0; k <= (Array.isArray(needle) ? needle[1] : 0); k++) at = before.indexOf(q, at + 1);
    assert.equal(after, before.slice(0, at) + word + before.slice(at + q.length), src);
  }
});

// ---- limits ----------------------------------------------------------------------------------------------------------------------
test("limits: over 1 MiB, over 20,000 lines or nested deeper than 32 levels is refused with a sentence", () => {
  const refused = (src, limit) => {
    assert.throws(() => readMarkdown(src), (e) => e instanceof CapError && e.limit === limit && /Onionskin can read/.test(e.message));
  };
  refused("a".repeat(MD_LIMITS.bytes + 1), "bytes");
  refused("é".repeat(MD_LIMITS.bytes / 2 + 1), "bytes");
  assert.equal(readMarkdown("a".repeat(MD_LIMITS.bytes)).runs.length, 1);
  assert.equal(readMarkdown("\uFEFF" + "a".repeat(MD_LIMITS.bytes - 3)).info.bytes, MD_LIMITS.bytes);
  refused("\uFEFF" + "a".repeat(MD_LIMITS.bytes - 2), "bytes");
  refused("x\n".repeat(MD_LIMITS.lines + 1), "lines");
  assert.equal(readMarkdown("x\n".repeat(MD_LIMITS.lines)).info.lines, MD_LIMITS.lines);
  refused("\r".repeat(MD_LIMITS.lines + 1), "lines");
  refused(">".repeat(MD_LIMITS.depth + 1) + " x", "nesting depth");
  assert.equal(shown(readMarkdown(">".repeat(MD_LIMITS.depth) + " x"))[0].endsWith("p x"), true);
  const deepList = Array.from({ length: MD_LIMITS.depth + 1 }, (_, k) => "  ".repeat(k) + "- x").join("\n");
  refused(deepList, "nesting depth");
  // "*a *a x*b*b" nests one em in the other; 32 levels read, 33 are refused
  refused("*a ".repeat(MD_LIMITS.depth + 1) + "x" + "*b".repeat(MD_LIMITS.depth + 1), "nesting depth");
  const deepEm = readMarkdown("*a ".repeat(MD_LIMITS.depth) + "x" + "*b".repeat(MD_LIMITS.depth));
  assert.equal(shown(deepEm)[0], "p " + "{em:a ".repeat(MD_LIMITS.depth) + "x" + "}b".repeat(MD_LIMITS.depth));
  assert.throws(() => readMarkdown(Buffer.from("x")), TypeError);
});

test("the module stays usable in the page: no node: imports and no Buffer in src/markdown.js or what it imports", () => {
  for (const f of ["../src/markdown.js", "../src/xml.js"]) {
    const s = readFileSync(new URL(f, import.meta.url), "utf8");
    assert.doesNotMatch(s, /from\s+["']node:|require\(|\bBuffer\b|\bprocess\./, f);
  }
  const imports = [...readFileSync(new URL("../src/markdown.js", import.meta.url), "utf8").matchAll(/^import .* from "(.*)";$/gm)].map((m) => m[1]);
  assert.deepEqual(imports, ["./xml.js"]);
});

// ---- properties over generated inputs -------------------------------------------------------------------------------------------
const RULES = {
  indent: /^[ \t]+$/,
  trailing: /^[ \t]+$/,
  blank: /^[ \t]*(?:\r\n|\n|\r)?$/,
  eol: /^(?:\r\n|\n|\r)$/,
  quote: /^>[ \t]?$/,
  marker: /^(?:[-+*]|[0-9]{1,9}[.)])[ \t]*$/,
  heading: /^[# \t]+$/,
  hr: /^[-*_ \t]+$/,
  fence: /^[`~ \t]+$/,
  table: /^[|:\- \t]+$/,
  emphasis: /^[*_]+$/,
  code: /^`+$/,
  link: /^[\s\S]+$/, // the brackets, the destination and the title: the only skips that may hold words
};
/** (1) runs and skips tile the source; skip kinds hold only their own marks; top-level blocks tile; (2) each run follows its rule. */
function checkTiling(src, tree, label) {
  const text = src.charCodeAt(0) === 0xfeff ? src.slice(1) : src;
  assert.equal(tree.text, text, label);
  const all = [...tree.runs, ...tree.skips].sort((a, b) => a.from - b.from);
  let pos = 0;
  let rebuilt = "";
  for (const x of all) {
    assert.equal(x.from, pos, `${label}: tiling at ${pos}`);
    assert.ok(x.to > x.from, `${label}: empty piece at ${pos}`);
    const s = text.slice(x.from, x.to);
    rebuilt += s;
    pos = x.to;
    if (x.skip) {
      assert.ok(RULES[x.skip], `${label}: skip kind ${x.skip}`);
      assert.match(s, RULES[x.skip], `${label}: ${x.skip} skip ${JSON.stringify(s)}`);
      continue;
    }
    if (isVerbatim(x)) assert.equal(x.display, s, `${label}: ${x.kind} run`);
    else if (x.kind === "escape") assert.equal(s, "\\" + x.display, `${label}: escape`);
    else if (x.kind === "entity") assert.match(s, /^&(?:#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z0-9]{1,32});$/, `${label}: entity`);
    else if (x.kind === "softbreak") assert.ok(x.display === " " && /^[ \t]*(?:\r\n|\n|\r)[ \t]*$/.test(s), `${label}: softbreak ${JSON.stringify(s)}`);
    else if (x.kind === "hardbreak") assert.ok(x.display === "\n" && /^(?:[ \t]*  |\\)(?:\r\n|\n|\r)[ \t]*$/.test(s), `${label}: hardbreak ${JSON.stringify(s)}`);
    else assert.fail(`${label}: run kind ${x.kind}`);
  }
  assert.equal(pos, text.length, `${label}: tiling ends`);
  assert.equal(rebuilt, text);
  tree.runs.forEach((r, i) => assert.equal(r.id, i));
  let bp = 0;
  for (const b of tree.blocks) {
    assert.equal(b.from, bp, `${label}: top-level blocks tile at ${bp}`);
    bp = b.to;
  }
  assert.equal(bp, text.length, `${label}: top-level blocks end`);
}

/** A small seeded generator (mulberry32): the same inputs on every run. */
function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}
const ATOMS = ["a", "b", "word", " ", "  ", "\t", "é", "e\u0301", "😀", "👍🏽", "*", "**", "_", "__", "`", "``", "[", "]", "(", ")", "](", "![", "!", "\\", "\\*", "\\|", "&amp;", "&#233;", "&copy;", "&bogus;", "&#x1F600;", "<b>", "</b>", "<!--", "-->", "<", ">", "#", "# ", "> ", "- ", "* ", "1. ", "2) ", "|", " | ", "---", "|---|", "***", "\n", "\n", "\n", "\r\n", "\r", "\n\n", "    ", "```", "~~~", "[ ] ", "<div>", "http://x.y", '"t"'];
function generate(r) {
  const parts = r() < 0.05 ? ["\uFEFF"] : [];
  if (r() < 0.05) parts.push("---\nk: v\n---\n");
  const len = Math.floor(r() * 80);
  for (let k = 0; k < len; k++) parts.push(ATOMS[Math.floor(r() * ATOMS.length)]);
  return parts.join("");
}

test("properties over generated inputs: tiling, run rules, exact selections and identical replacements", () => {
  const r = rng(20261121);
  const G = new Intl.Segmenter("en", { granularity: "grapheme" });
  for (let n = 0; n < 3000; n++) {
    const src = generate(r);
    const tree = readMarkdown(src);
    checkTiling(src, tree, JSON.stringify(src));
    assert.deepEqual(readMarkdown(src).runs, tree.runs, "the same reading twice");
    for (const run of tree.runs) {
      // a whole run always maps exactly to its own range
      const whole = sourceRange(tree, { startRun: run.id, startOffset: 0, endRun: run.id, endOffset: run.display.length });
      assert.deepEqual(whole, { from: run.from, to: run.to, quote: tree.text.slice(run.from, run.to) }, JSON.stringify(src));
      if (!isVerbatim(run)) continue;
      // a sub-range on whole characters maps exactly, and its quote is what was displayed
      const cuts = [...G.segment(run.display)].map((s) => s.index).concat(run.display.length);
      const a = cuts[Math.floor(r() * cuts.length)];
      const b = cuts[Math.floor(r() * cuts.length)];
      if (a === b) continue;
      const got = sourceRange(tree, { startRun: run.id, startOffset: Math.min(a, b), endRun: run.id, endOffset: Math.max(a, b) });
      assert.equal(got.quote, run.display.slice(Math.min(a, b), Math.max(a, b)), JSON.stringify(src));
      assert.equal(sourceOffset(tree, run.id, a), run.from + a);
    }
    // (3) replacements whose new text equals the old are the identity
    const body = tree.text;
    const reps = [];
    for (let p = 0; p < body.length; ) {
      const from = p + Math.floor(r() * 5);
      const to = Math.min(body.length, from + Math.floor(r() * 6));
      if (from > body.length) break;
      const ok = (q) => !((body.charCodeAt(q) & 0xfc00) === 0xdc00 && q > 0);
      if (ok(from) && ok(to) && (!reps.length || from > reps[reps.length - 1].from)) reps.push({ from, to, old: body.slice(from, to), new: body.slice(from, to) });
      p = Math.max(to, from + 1);
    }
    assert.equal(applyReplacements(src, reps), src);
  }
});

// ---- adversarial inputs ---------------------------------------------------------------------------------------------------------
const MiB = MD_LIMITS.bytes;
const fill = (unit, max = MiB) => unit.repeat(Math.floor(max / unit.length));
const ADVERSARIAL = [
  ["deeply nested brackets", fill("["), "parse"],
  ["nested brackets that close", fill("[", MiB / 2) + fill("]", MiB / 2), "parse"],
  ["nested links that close", "[".repeat(200_000) + "a" + "](x)".repeat(200_000), "parse"],
  ["nested images that close", "![".repeat(170_000) + "a" + "](x)".repeat(170_000), "parse"],
  ["thousands of backticks", fill("`"), "parse"],
  ["backtick runs of every length", Array.from({ length: 1400 }, (_, k) => "`".repeat(k + 1) + "x").join(""), "parse"],
  ["backticks and spaces", fill("` "), "parse"],
  ["long run of *", fill("*"), "parse"],
  ["long run of _", fill("_"), "parse"],
  ["alternating *_", fill("*_"), "parse"],
  ["*a **b repeated", fill("*a **b "), "parse"],
  ["_a* repeated", fill("_a*"), "parse"],
  ["[a]( repeated", fill("[a]("), "parse"],
  ["[a](< repeated", fill("[a](<"), "parse"],
  ['[a](x " repeated', fill('[a](x "'), "parse"],
  ["[a](( repeated", fill("[a](("), "parse"],
  ["<!-- repeated", fill("<!--"), "parse"],
  ["<a  repeated", fill("<a "), "parse"],
  ["![ repeated", fill("!["), "parse"],
  ["]( repeated", fill("]("), "parse"],
  ["backslashes", fill("\\"), "parse"],
  ["& and &# repeated", fill("&#"), "parse"],
  ["one huge table row", fill("a|", MiB / 2 - 4) + "\n" + fill("-|", MiB / 2 - 4), "parse"],
  ["quotes 30 deep on 16,000 lines", fill("> ".repeat(30) + "a\n"), "parse"],
  ["lists 30 deep, repeated", fill(Array.from({ length: 30 }, (_, k) => "  ".repeat(k) + "- a\n").join(""), 600_000), "parse"],
  ["soft breaks on 20,000 lines", "word word word word word word word word word word\n".repeat(MD_LIMITS.lines), "parse"],
  ["emphasis nested past the limit", fill("*a ", MiB / 2) + "x" + fill("*b", MiB / 2 - 2), "refuse"],
];

test("1 MiB adversarial inputs parse (or are refused) within 2 seconds each", () => {
  for (const [name, src, expect] of ADVERSARIAL) {
    assert.ok(src.length <= MiB, `${name}: ${src.length}`);
    // the best of up to three attempts: a busy machine or a parallel test run can slow one attempt, a quadratic scan slows all three
    let best = Infinity;
    let outcome;
    for (let attempt = 0; attempt < 3 && best >= 2000; attempt++) {
      const t0 = performance.now();
      try {
        const tree = readMarkdown(src);
        outcome = "parse";
        assert.ok(tree.runs.length > 0 || tree.skips.length > 0);
      } catch (e) {
        if (!(e instanceof CapError)) throw e;
        outcome = "refuse";
      }
      best = Math.min(best, performance.now() - t0);
    }
    assert.equal(outcome, expect, name);
    assert.ok(best < 2000, `${name}: ${best.toFixed(0)} ms`);
    if (process.env.MD_TIMES) console.log(`${name}: ${best.toFixed(0)} ms (${outcome})`);
  }
});
