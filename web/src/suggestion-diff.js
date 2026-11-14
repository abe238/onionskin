/** The changed middle of an excerpt, whole (never cut): the text before it, what goes, what comes, the text after it. */
export function splitChange(before = "", after = "") {
  const a = [...before];
  const b = [...after];
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  // a whole word at each edge ("each" to "every", not "e" + "ach" to "very")
  while (p > 0 && !/\s/.test(a[p - 1])) p--;
  while (s > 0 && !/\s/.test(a[a.length - s])) s--;
  return { pre: a.slice(0, p).join(""), del: a.slice(p, a.length - s).join(""), ins: b.slice(p, b.length - s).join(""), post: a.slice(a.length - s).join("") };
}
