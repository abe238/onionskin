import fs from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Strict validator for docs/contracts/ops.schema.json. Hand-rolled on purpose: the schema uses a small subset of JSON Schema
 * (type, enum, const, required, properties, additionalProperties:false, items, min/max, pattern, minProperties, anyOf, oneOf, $ref),
 * so a dependency would cost more than these ~90 lines. Unknown fields are always errors.
 */
const OPS_SCHEMA_PATH = fileURLToPath(new URL("../../docs/contracts/ops.schema.json", import.meta.url));
const SCHEMA = JSON.parse(fs.readFileSync(OPS_SCHEMA_PATH, "utf8"));

const typeOf = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v);
const isType = (v, t) => (t === "number" ? typeof v === "number" && Number.isFinite(v) : t === "integer" ? Number.isInteger(v) : typeOf(v) === t);

function resolve(schema) {
  if (schema.$ref) {
    const name = schema.$ref.replace("#/$defs/", "");
    if (!SCHEMA.$defs[name]) throw new Error(`schema bug: unknown $ref ${schema.$ref}`);
    return SCHEMA.$defs[name];
  }
  return schema;
}

function check(value, schema, at, errors) {
  schema = resolve(schema);
  if ("const" in schema && value !== schema.const) return errors.push(`${at}: must be ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value)) return errors.push(`${at}: must be one of ${schema.enum.map((x) => JSON.stringify(x)).join(", ")}`);
  if (schema.type) {
    const types = [].concat(schema.type);
    if (!types.some((t) => isType(value, t))) return errors.push(`${at}: must be ${types.join(" or ")}, got ${typeOf(value)}`);
  }
  if (typeof value === "string") {
    if (schema.maxLength != null && [...value].length > schema.maxLength) errors.push(`${at}: longer than ${schema.maxLength} characters`);
    if (schema.minLength != null && value.length < schema.minLength) errors.push(`${at}: must not be empty`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${at}: does not match ${schema.pattern}`);
  }
  if (typeof value === "number") {
    if (schema.minimum != null && value < schema.minimum) errors.push(`${at}: must be >= ${schema.minimum}`);
    if (schema.maximum != null && value > schema.maximum) errors.push(`${at}: must be <= ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems != null && value.length < schema.minItems) errors.push(`${at}: needs at least ${schema.minItems} item(s)`);
    if (schema.maxItems != null && value.length > schema.maxItems) errors.push(`${at}: at most ${schema.maxItems} items`);
    if (schema.items) value.forEach((v, i) => check(v, schema.items, `${at}[${i}]`, errors));
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const props = schema.properties || {};
    for (const k of schema.required || []) if (!(k in value)) errors.push(`${at}: missing required field "${k}"`);
    if (schema.minProperties != null && Object.keys(value).length < schema.minProperties) errors.push(`${at}: needs at least ${schema.minProperties} field(s)`);
    for (const [k, v] of Object.entries(value)) {
      if (k in props) check(v, props[k], `${at}.${k}`, errors);
      else if (schema.additionalProperties === false) errors.push(`${at}: unknown field "${k}"`);
    }
  }
  if (schema.anyOf && !schema.anyOf.some((s) => { const e = []; check(value, s, at, e); return !e.length; })) errors.push(`${at}: does not match any allowed shape`);
  if (schema.oneOf) {
    // discriminated by "op": validate against the one branch that names this op, so the message is about that op
    const branch = value && typeof value === "object" ? schema.oneOf.find((s) => resolve(s).properties?.op?.const === value.op) : null;
    if (branch) check(value, branch, at, errors);
    else errors.push(`${at}: unknown op ${JSON.stringify(value && value.op)}`);
  }
}

const DOC_OPS = new Set(["replace_text", "insert_paragraph_after", "insert_paragraph_before", "delete_paragraph", "set_paragraph_style", "format_text"]);
const HTML_OPS = new Set(["set_text", "set_attribute", "remove_attribute", "insert_html", "replace_element", "delete_element"]);
const HTML_TARGET = ["anchor_id", "path", "element_id"];

/** Rules JSON Schema cannot say without heavy machinery: exclusive field groups and what `expect` must contain. */
function semantic(op, at, errors) {
  const html = HTML_OPS.has(op.op) || (op.op === "replace_text" && ("path" in (op.target || {}) || "element_id" in (op.target || {})));
  if (html) {
    // an element of an HTML file: exactly one of anchor_id, path, element_id (replace_text names one of the last two for HTML)
    const t = op.target || {};
    if (HTML_TARGET.filter((k) => k in t).length !== 1 || Object.keys(t).some((k) => !HTML_TARGET.includes(k))) errors.push(`${at}.target: give exactly one of anchor_id, path or element_id`);
  } else if (DOC_OPS.has(op.op)) {
    const t = op.target || {};
    const n = ["anchor_id", "para_id", "body_path", "text_hash"].filter((k) => k in t);
    if (!n.length) errors.push(`${at}.target: give anchor_id, or para_id, or body_path with text_hash, or text_hash`);
    if ("anchor_id" in t && n.length > 1) errors.push(`${at}.target: anchor_id cannot be combined with other locator fields`);
  }
  if (op.op === "set_cells" || op.op === "format_cells") {
    const t = op.target || {};
    if ("anchor_id" in t ? "sheet" in t || "range" in t : !("sheet" in t && "range" in t)) errors.push(`${at}.target: give anchor_id alone, or sheet with range`);
  }
  if (op.op === "set_shape_text" || op.op === "replace_text_in_shape") {
    const t = op.target || {};
    if ("anchor_id" in t ? "slide_id" in t || "shape_id" in t : !("slide_id" in t && "shape_id" in t)) errors.push(`${at}.target: give anchor_id alone, or slide_id with shape_id`);
  }
  if (op.op === "replace_text") {
    const mode = "text" in op ? "text" : "find" in op ? "find" : null;
    if ("text" in op && ("find" in op || "replace" in op || "occurrence" in op || "all" in op)) errors.push(`${at}: use either text, or find with replace`);
    else if (mode === "find" && !("replace" in op)) errors.push(`${at}: find needs replace`);
    else if (!mode) errors.push(`${at}: give text, or find with replace`);
    if (op.all && op.occurrence) errors.push(`${at}: all and occurrence are exclusive`);
  }
  if (op.op === "replace_text_in_shape" && op.all && op.occurrence) errors.push(`${at}: all and occurrence are exclusive`);
  if (op.op === "duplicate_slide") {
    if ("to" in op !== "where" in op) errors.push(`${at}: give to and where together, or neither (the copy then follows its slide)`);
    const ids = (op.shapes || []).map((s) => s.shape_id);
    if (new Set(ids).size !== ids.length) errors.push(`${at}.shapes: each shape_id at most once`);
  }
  if (op.op === "format_all" || op.op === "replace_all_text") return;
  const e = op.expect || {};
  if (op.op === "add_sheet") {
    if (e.absent !== true || "quote" in e || "text_hash" in e) errors.push(`${at}.expect: add_sheet needs exactly { "absent": true }`);
  } else if ("absent" in e) errors.push(`${at}.expect: absent is only for add_sheet`);
  else if (!("quote" in e) && !("text_hash" in e)) errors.push(`${at}.expect: give quote or text_hash (what the target looked like when you read it)`);
}

/** Returns {ok, errors:[...strings]}. Never throws on bad input. */
export function validateOps(doc) {
  const errors = [];
  check(doc, SCHEMA, "$", errors);
  if (!errors.length) doc.ops.forEach((op, i) => semantic(op, `$.ops[${i}]`, errors));
  return { ok: errors.length === 0, errors: errors.slice(0, 50) };
}
