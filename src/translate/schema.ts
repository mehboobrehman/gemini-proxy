/**
 * Sanitizes a JSON-Schema tool-parameter definition into the subset Gemini's
 * `Schema` proto accepts. This MUST be a whitelist, not a blacklist — an
 * unknown keyword left in place (e.g. `$schema`, `additionalProperties`,
 * `patternProperties`) reliably 400s the upstream call, and new JSON-Schema
 * keywords appear over time that a blacklist would never catch.
 */

const ALLOWED_KEYS = new Set([
  "type",
  "format",
  "description",
  "nullable",
  "enum",
  "items",
  "properties",
  "required",
  "anyOf",
  "minimum",
  "maximum",
  "minItems",
  "maxItems",
  "minLength",
  "maxLength",
  "pattern",
]);

const STRING_FORMATS = new Set(["enum", "date-time"]);
const NUMERIC_FORMATS = new Set(["float", "double", "int32", "int64"]);

const MAX_REF_DEPTH = 5;

function resolveRef(ref: string, root: Record<string, unknown>): unknown {
  // Only local refs like "#/$defs/Foo" or "#/definitions/Foo" are meaningful here.
  const parts = ref.replace(/^#\//, "").split("/");
  let node: unknown = root;
  for (const part of parts) {
    if (!node || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}

function shallowMergeObjects(nodes: Record<string, unknown>[]): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  let rest: Record<string, unknown> = {};
  for (const node of nodes) {
    if (node.properties && typeof node.properties === "object") {
      Object.assign(properties, node.properties as Record<string, unknown>);
    }
    if (Array.isArray(node.required)) required.push(...(node.required as string[]));
    rest = { ...rest, ...node };
  }
  const merged: Record<string, unknown> = { ...rest, type: "OBJECT" };
  if (Object.keys(properties).length > 0) merged.properties = properties;
  if (required.length > 0) merged.required = [...new Set(required)];
  return merged;
}

function sanitizeNode(node: unknown, root: Record<string, unknown>, depth: number): unknown {
  if (node === null || typeof node !== "object") return node;

  if (Array.isArray(node)) return node.map((n) => sanitizeNode(n, root, depth));

  const obj = node as Record<string, unknown>;

  if (typeof obj.$ref === "string") {
    if (depth >= MAX_REF_DEPTH) return { type: "OBJECT" };
    const resolved = resolveRef(obj.$ref, root);
    if (!resolved) return { type: "OBJECT" };
    return sanitizeNode(resolved, root, depth + 1);
  }

  if (Array.isArray(obj.allOf)) {
    const merged = (obj.allOf as unknown[]).map((n) => sanitizeNode(n, root, depth + 1) as Record<string, unknown>);
    return shallowMergeObjects(merged);
  }

  const out: Record<string, unknown> = {};

  // type: ["string","null"] -> nullable STRING; "const" -> single-value enum
  let type = obj.type;
  if (Array.isArray(type)) {
    const nonNull = (type as string[]).filter((t) => t !== "null");
    if (nonNull.length !== type.length) out.nullable = true;
    type = nonNull[0];
  }
  if (typeof obj.const !== "undefined") {
    out.enum = [obj.const];
    if (!type) type = typeof obj.const === "number" ? "number" : typeof obj.const === "boolean" ? "boolean" : "string";
  }
  if (typeof type === "string") out.type = type.toUpperCase();

  const oneOfOrAnyOf = [
    ...(Array.isArray(obj.oneOf) ? (obj.oneOf as unknown[]) : []),
    ...(Array.isArray(obj.anyOf) ? (obj.anyOf as unknown[]) : []),
  ];
  if (oneOfOrAnyOf.length > 0) {
    out.anyOf = oneOfOrAnyOf.map((n) => sanitizeNode(n, root, depth + 1));
  }

  for (const key of Object.keys(obj)) {
    if (!ALLOWED_KEYS.has(key)) continue;
    if (key === "type" || key === "anyOf") continue; // already handled
    const value = obj[key];

    if (key === "items") {
      out.items = sanitizeNode(value, root, depth + 1);
      continue;
    }
    if (key === "properties" && value && typeof value === "object") {
      const props: Record<string, unknown> = {};
      for (const [propKey, propVal] of Object.entries(value as Record<string, unknown>)) {
        props[propKey] = sanitizeNode(propVal, root, depth + 1);
      }
      out.properties = props;
      continue;
    }
    if (key === "format") {
      const fmt = String(value);
      const isNumeric = type === "number" || type === "integer";
      if ((isNumeric && NUMERIC_FORMATS.has(fmt)) || (!isNumeric && STRING_FORMATS.has(fmt))) {
        out.format = fmt;
      }
      continue;
    }
    out[key] = value;
  }

  return out;
}

/**
 * Sanitizes an OpenAI tool's `parameters` JSON Schema for Gemini. Returns
 * `undefined` when the result would have no properties — Gemini rejects an
 * empty `{"type":"OBJECT","properties":{}}`, so the caller should omit the
 * `parameters` field entirely in that case.
 */
export function sanitizeToolParameters(rawSchema: unknown): Record<string, unknown> | undefined {
  if (!rawSchema || typeof rawSchema !== "object") return undefined;
  const root = rawSchema as Record<string, unknown>;
  const sanitized = sanitizeNode(root, root, 0) as Record<string, unknown> | undefined;
  if (!sanitized) return undefined;
  const props = sanitized.properties as Record<string, unknown> | undefined;
  if (!props || Object.keys(props).length === 0) return undefined;
  if (!sanitized.type) sanitized.type = "OBJECT";
  return sanitized;
}

/** Sanitizes a `response_format.json_schema.schema` the same way, but keeps an empty-properties object (valid for response schemas, unlike tool parameters). */
export function sanitizeResponseSchema(rawSchema: unknown): Record<string, unknown> | undefined {
  if (!rawSchema || typeof rawSchema !== "object") return undefined;
  const root = rawSchema as Record<string, unknown>;
  return sanitizeNode(root, root, 0) as Record<string, unknown>;
}
