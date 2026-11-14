import assert from "node:assert/strict";

/** Tiny JSON-schema subset validator: type, const, enum, required, properties, additionalProperties, items, maxLength, pattern. */
export function validate(v, s, root, p) {
  if (s.const !== undefined) assert.equal(v, s.const, p);
  if (s.enum) assert.ok(s.enum.includes(v), `${p}: ${v} not in enum`);
  if (s.type) {
    const types = [].concat(s.type);
    const t = v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v;
    assert.ok(types.includes(t) || (t === "integer" && types.includes("number")), `${p}: type ${t} not in ${types}`);
  }
  if (typeof v === "string") {
    if (s.maxLength) assert.ok([...v].length <= s.maxLength, `${p}: too long`);
    if (s.pattern) assert.match(v, new RegExp(s.pattern), p);
  }
  if (Array.isArray(v) && s.items) v.forEach((x, i) => validate(x, s.items, root, `${p}[${i}]`));
  if (v && typeof v === "object" && !Array.isArray(v)) {
    for (const k of s.required || []) assert.ok(k in v, `${p}: missing ${k}`);
    for (const [k, x] of Object.entries(v)) {
      if (s.properties?.[k]) validate(x, s.properties[k], root, `${p}.${k}`);
      else if (s.additionalProperties === false) assert.fail(`${p}: unexpected ${k}`);
    }
  }
}
