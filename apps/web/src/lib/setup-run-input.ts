import type { StarterRunInput } from "@graft/core/setup/starter-vendors";

/**
 * What Setup's result step asks for before it runs the tool (GRA-208; GRA-202, user story 21): the
 * starter's one input with its default (the city for Open-Meteo), when the tool's schema has that
 * field; nothing, for a tool that takes no input; otherwise the input as JSON, with the schema's
 * fields laid out empty, since a tool built for another vendor has fields no starter describes. The
 * server holds the input to the tool's own schema whatever is sent, and answers the run's own
 * sentence when it refuses.
 */
export type RunInputView =
  | { kind: "none" }
  | { kind: "field"; field: string; label: string; defaultValue: string }
  | { kind: "json"; initial: string };

type Schema = Record<string, unknown>;

function isSchema(value: unknown): value is Schema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Whether a schema takes input past its own `properties`: composition, a conditional, or keys it
 * admits by pattern or beyond its listed ones. `additionalProperties: false`, which a zod-built
 * schema carries, admits nothing more.
 */
function reachesPast(schema: Schema): boolean {
  if (["$ref", "allOf", "anyOf", "oneOf", "if", "patternProperties"].some((key) => key in schema)) {
    return true;
  }
  return "additionalProperties" in schema && schema.additionalProperties !== false;
}

/**
 * A local `$ref` (`#/$defs/<name>` or `#/definitions/<name>`) resolved against the root. A name
 * that is not a valid percent-encoding (a literal `%`, as in `#/$defs/discount%`) resolves to
 * nothing rather than throwing while the step renders (Greptile on #166): the `$ref` still marks
 * the schema as reaching past its own `properties`, so the step asks for the input as JSON.
 */
function resolveRef(root: Schema, ref: unknown): Schema | null {
  if (typeof ref !== "string") return null;
  const match = /^#\/(\$defs|definitions)\/([^/]+)$/.exec(ref);
  if (!match) return null;
  let name: string;
  try {
    name = decodeURIComponent(match[2] as string);
  } catch {
    return null;
  }
  const defs = root[match[1] as string];
  const target = isSchema(defs) ? defs[name] : undefined;
  return isSchema(target) ? target : null;
}

/**
 * The fields a schema lays out, following composition (Greptile on #166): the root's
 * `properties`, a local `$ref`'s, every `allOf` branch's, and the first `anyOf` or `oneOf`
 * branch's, since an authored tool's schema need only be `type: "object"` at the root. `composed`
 * says the schema reaches past its own `properties`, so a tool with no field found is still asked
 * for input as JSON rather than run with `{}`.
 */
function fieldsOf(root: Schema): { properties: Schema; composed: boolean } {
  const properties: Schema = {};
  let composed = false;
  const seen = new Set<Schema>();
  const walk = (schema: Schema, depth: number) => {
    if (depth > 8 || seen.has(schema)) return;
    seen.add(schema);
    if (reachesPast(schema)) composed = true;
    if (isSchema(schema.properties)) {
      for (const [field, property] of Object.entries(schema.properties)) {
        if (!(field in properties)) properties[field] = property;
      }
    }
    const ref = resolveRef(root, schema.$ref);
    if (ref) walk(ref, depth + 1);
    if (Array.isArray(schema.allOf)) {
      for (const branch of schema.allOf) if (isSchema(branch)) walk(branch, depth + 1);
    }
    for (const keyword of ["anyOf", "oneOf"] as const) {
      const branches = schema[keyword];
      const first = Array.isArray(branches) ? branches.find(isSchema) : undefined;
      if (first) walk(first, depth + 1);
    }
  };
  walk(root, 0);
  return { properties, composed };
}

/** An empty value of a property's declared type, for the JSON skeleton. */
function emptyOf(property: unknown): unknown {
  const type =
    typeof property === "object" && property !== null
      ? (property as { type?: unknown }).type
      : undefined;
  if (type === "number" || type === "integer") return 0;
  if (type === "boolean") return false;
  if (type === "array") return [];
  if (type === "object") return {};
  return "";
}

export function runInputView(
  inputSchema: Record<string, unknown>,
  runInput: StarterRunInput | null,
): RunInputView {
  const { properties, composed } = fieldsOf(inputSchema);
  const fields = Object.keys(properties);
  if (runInput && fields.includes(runInput.field)) {
    return {
      kind: "field",
      field: runInput.field,
      label: runInput.label,
      defaultValue: runInput.defaultValue,
    };
  }
  if (fields.length === 0 && !composed) return { kind: "none" };
  const skeleton = Object.fromEntries(fields.map((field) => [field, emptyOf(properties[field])]));
  return { kind: "json", initial: JSON.stringify(skeleton, null, 2) };
}

/** The input the run is sent from what the person typed, or the sentence saying why it cannot be. */
export function runInputOf(
  view: RunInputView,
  value: string,
): { ok: true; input: Record<string, unknown> } | { ok: false; message: string } {
  if (view.kind === "none") return { ok: true, input: {} };
  if (view.kind === "field") return { ok: true, input: { [view.field]: value.trim() } };
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return { ok: false, message: "The input is not valid JSON." };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, message: "The input is a JSON object, one key per field." };
  }
  return { ok: true, input: parsed as Record<string, unknown> };
}

/** The run's answer as the code block shows it: JSON, indented, or the text itself. */
export function runResultText(result: unknown): string {
  if (typeof result === "string") return result;
  return JSON.stringify(result, null, 2) ?? "";
}
