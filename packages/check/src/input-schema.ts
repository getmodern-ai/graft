/**
 * Rules over a tool's input schema rather than its code. Imports nothing, so a caller that only
 * wants the rule (the stock harness's own test) does not load the compiler for it.
 */

/** A property the schema both lists in `required` and gives a `default`. */
export type RequiredDefault = {
  /** Dotted from the input's root: `query`, `filter.limit`, `items[].kind`. */
  path: string;
  /** The property's own name, the last segment of `path`. */
  field: string;
  default: unknown;
};

const MAX_DEPTH = 8;

/**
 * Every property listed in `required` that also carries a `default`, at any depth the schema
 * nests objects (properties, array items, and the branches of `anyOf`, `oneOf` and `allOf`).
 *
 * Such a property contradicts itself: the validator refuses a call that leaves it out before the
 * default could apply, and nothing fills a default in for the module either (`@graft/mcp`'s
 * `schema.ts` validates without Ajv's `useDefaults`), so the default only misleads the caller about
 * what may be omitted. The stock `gmail__search-messages` refused `{}` this way in production.
 */
export function requiredWithDefault(schema: unknown): RequiredDefault[] {
  const found: RequiredDefault[] = [];
  walk(schema, "", 0, found);
  return found;
}

function walk(node: unknown, path: string, depth: number, found: RequiredDefault[]): void {
  const schema = objectOrNull(node);
  if (!schema || depth > MAX_DEPTH) return;
  const properties = objectOrNull(schema.properties);
  if (properties) {
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const field of required) {
      if (typeof field !== "string") continue;
      const property = objectOrNull(properties[field]);
      if (property && "default" in property) {
        found.push({ path: join(path, field), field, default: property.default });
      }
    }
    for (const [field, child] of Object.entries(properties)) {
      walk(child, join(path, field), depth + 1, found);
    }
  }
  if (Array.isArray(schema.items)) {
    for (const item of schema.items) walk(item, `${path}[]`, depth + 1, found);
  } else {
    walk(schema.items, `${path}[]`, depth + 1, found);
  }
  for (const key of ["anyOf", "oneOf", "allOf"] as const) {
    const branches = schema[key];
    if (!Array.isArray(branches)) continue;
    for (const branch of branches) walk(branch, path, depth + 1, found);
  }
}

function join(path: string, field: string): string {
  return path === "" ? field : `${path}.${field}`;
}

function objectOrNull(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
