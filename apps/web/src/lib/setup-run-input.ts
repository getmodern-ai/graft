import type { StarterRunInput } from "@graft/core/setup/starter-vendors";

/**
 * What Setup's result step asks for before it runs the tool (GRA-208; GRA-202, user story 21),
 * drawn from **the tool's own `inputSchema`** (GRA-217): the starter's `runInput` only names a
 * field, and on the Sheets walk of 2026-09-25 the tool took `spreadsheetId` and `range` where the
 * starter said `spreadsheet`, so the step fell back to a raw JSON editor and the run failed.
 *
 * - **A form** for a schema of plain fields: strings, numbers, integers, booleans, enums, and lists
 *   of strings or numbers. Each field starts at the starter's default when its name is the
 *   starter's field, else the schema's `default`, else its first `examples` entry, else empty. A
 *   required field with no value says what the tool needs (`needs`), and the run waits for it
 *   (`missingFields`).
 * - **Nothing**, for a tool that takes no input.
 * - **JSON**, only for a schema too complex to draw: a nested object, a list of objects, a field
 *   whose type is a union, or a root that composes or admits keys it does not list.
 *
 * The server holds the input to the tool's own schema whatever is sent, and answers the run's own
 * sentence when it refuses.
 */
export type RunFieldKind = "string" | "number" | "integer" | "boolean" | "enum" | "list";

export type RunField = {
  name: string;
  kind: RunFieldKind;
  /** The field's label: the starter's for its field, else the schema's `title`, else the name humanised. */
  label: string;
  /** The schema's `description`, shown under the field. */
  description: string | null;
  required: boolean;
  /** The value the field starts at, as the input holds it (`"true"`/`"false"` for a boolean). */
  initial: string;
  /** An enum's values in the schema's order: the text the select shows, and the value sent. */
  options: { label: string; value: string | number }[];
  /** A list's item type, for sending it: numbers are parsed, strings are sent as typed. */
  itemKind?: "string" | "number" | "integer";
  /** For a required field that starts empty: the sentence saying what the tool needs. */
  needs: string | null;
};

export type RunInputView =
  | { kind: "none" }
  | { kind: "form"; fields: RunField[] }
  | { kind: "json"; initial: string; required: string[] };

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
 * for input as JSON rather than run with `{}`. `required` gathers the root's and every `allOf`
 * branch's (a `$ref`'s included), which bind whatever else holds; an `anyOf` or `oneOf` branch's
 * do not, since another branch may stand.
 */
function fieldsOf(root: Schema): { properties: Schema; required: Set<string>; composed: boolean } {
  const properties: Schema = {};
  const required = new Set<string>();
  let composed = false;
  const seen = new Set<Schema>();
  const walk = (schema: Schema, depth: number, binding: boolean) => {
    if (depth > 8 || seen.has(schema)) return;
    seen.add(schema);
    if (reachesPast(schema)) composed = true;
    if (isSchema(schema.properties)) {
      for (const [field, property] of Object.entries(schema.properties)) {
        if (!(field in properties)) properties[field] = property;
      }
    }
    if (binding && Array.isArray(schema.required)) {
      for (const field of schema.required) if (typeof field === "string") required.add(field);
    }
    const ref = resolveRef(root, schema.$ref);
    if (ref) walk(ref, depth + 1, binding);
    if (Array.isArray(schema.allOf)) {
      for (const branch of schema.allOf) if (isSchema(branch)) walk(branch, depth + 1, binding);
    }
    for (const keyword of ["anyOf", "oneOf"] as const) {
      const branches = schema[keyword];
      const first = Array.isArray(branches) ? branches.find(isSchema) : undefined;
      if (first) walk(first, depth + 1, false);
    }
  };
  walk(root, 0, true);
  return { properties, required, composed };
}

/** A property's one type, `null` aside (`["string", "null"]` is a string); undefined for a union. */
function typeOf(property: Schema): string | undefined {
  const { type } = property;
  if (typeof type === "string") return type;
  if (Array.isArray(type)) {
    const named = type.filter((entry) => entry !== "null");
    return named.length === 1 && typeof named[0] === "string" ? named[0] : undefined;
  }
  return undefined;
}

const SCALARS = new Set(["string", "number", "integer"]);

/** How a property is drawn, or null when it is too complex to draw (the step asks for JSON). */
function kindOf(property: Schema): Pick<RunField, "kind" | "options" | "itemKind"> | null {
  if (["$ref", "allOf", "anyOf", "oneOf", "not", "if"].some((key) => key in property)) return null;
  if (Array.isArray(property.enum)) {
    const values = property.enum.filter(
      (value): value is string | number => typeof value === "string" || typeof value === "number",
    );
    return values.length === property.enum.length && values.length > 0
      ? { kind: "enum", options: values.map((value) => ({ label: String(value), value })) }
      : null;
  }
  const type = typeOf(property);
  if (type === undefined && property.type === undefined) return { kind: "string", options: [] };
  if (type === "string" || type === "number" || type === "integer" || type === "boolean") {
    return { kind: type, options: [] };
  }
  if (type === "array" && isSchema(property.items)) {
    const itemType = typeOf(property.items);
    if (itemType && SCALARS.has(itemType) && !("enum" in property.items)) {
      return { kind: "list", options: [], itemKind: itemType as RunField["itemKind"] };
    }
  }
  return null;
}

const ACRONYMS: Record<string, string> = {
  id: "ID",
  ids: "IDs",
  url: "URL",
  uri: "URI",
  api: "API",
  html: "HTML",
  json: "JSON",
};

/** A field's name as words: `spreadsheetId` is "spreadsheet ID", `page_size` is "page size". */
export function humaniseFieldName(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-.]+/g, " ")
    .trim()
    .split(/\s+/)
    .map((word) => ACRONYMS[word.toLowerCase()] ?? word.toLowerCase())
    .join(" ");
}

function capitalised(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function article(noun: string): string {
  if (/^(u[sn]i|use|url|uri)/i.test(noun)) return "a";
  return /^[aeiou]/i.test(noun) ? "an" : "a";
}

/**
 * What a required field with no value says: "This tool needs a spreadsheet ID." From the schema's
 * `description` when it reads as a noun phrase ("The ID of the spreadsheet to read"), else from
 * the field's name humanised, with its article.
 */
export function needsSentence(name: string, description: string | null): string {
  const first =
    description
      ?.split(/(?<=[.!?])\s/)[0]
      ?.trim()
      .replace(/[.!?]+$/, "") ?? "";
  if (/^(the|a|an|your)\s/i.test(first) && first.length <= 80) {
    return `This tool needs ${first.charAt(0).toLowerCase()}${first.slice(1)}.`;
  }
  const noun = humaniseFieldName(name);
  return `This tool needs ${article(noun)} ${noun}.`;
}

/** A schema value as the input holds it: text, a number or boolean written out, a list joined. */
function asInputText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (
    Array.isArray(value) &&
    value.every((entry) => typeof entry === "string" || typeof entry === "number")
  ) {
    return value.join(", ");
  }
  return null;
}

/** Where a field starts: the starter's default for its field, the schema's `default`, its first example. */
function initialOf(name: string, property: Schema, runInput: StarterRunInput | null): string {
  if (runInput && runInput.field === name) return runInput.defaultValue;
  const fromDefault = asInputText(property.default);
  if (fromDefault !== null) return fromDefault;
  const example = Array.isArray(property.examples) ? asInputText(property.examples[0]) : null;
  return example ?? "";
}

/** An empty value of a property's declared type, for the JSON skeleton. */
function emptyOf(property: unknown): unknown {
  const type = isSchema(property) ? typeOf(property) : undefined;
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
  const { properties, required, composed } = fieldsOf(inputSchema);
  const names = Object.keys(properties);
  if (names.length === 0 && !composed) return { kind: "none" };

  // A property of `true` admits anything, drawn as text; any other non-schema is not drawn.
  const schemaOf = (name: string): Schema | null => {
    const property = properties[name];
    return property === true ? {} : isSchema(property) ? property : null;
  };
  const fields: RunField[] = [];
  for (const name of names) {
    const schema = schemaOf(name);
    const shape = schema ? kindOf(schema) : null;
    if (composed || !schema || !shape) {
      fields.length = 0;
      break;
    }
    const description =
      typeof schema.description === "string" && schema.description.trim() !== ""
        ? schema.description.trim()
        : null;
    const title =
      typeof schema.title === "string" && schema.title.trim() !== "" ? schema.title : null;
    const label =
      runInput && runInput.field === name
        ? runInput.label
        : (title ?? capitalised(humaniseFieldName(name)));
    let initial = initialOf(name, schema, runInput);
    if (shape.kind === "boolean" && initial !== "true") initial = "false";
    if (shape.kind === "enum" && !shape.options.some((option) => option.label === initial)) {
      initial = "";
    }
    const isRequired = required.has(name);
    fields.push({
      name,
      ...shape,
      label,
      description,
      required: isRequired,
      initial,
      needs: isRequired && initial.trim() === "" ? needsSentence(name, description) : null,
    });
  }
  if (fields.length === names.length && names.length > 0) {
    // The required fields first, each group in the schema's order as stored: a stored schema's
    // keys come back from Postgres's jsonb in its own order (shortest first), not the author's.
    const ordered = [
      ...fields.filter((field) => field.required),
      ...fields.filter((field) => !field.required),
    ];
    return { kind: "form", fields: ordered };
  }

  // Too complex to draw: the fields as JSON, a string field at its starting value.
  const skeleton = Object.fromEntries(
    names.map((name) => {
      const schema = schemaOf(name);
      const start =
        schema && kindOf(schema)?.kind === "string" ? initialOf(name, schema, runInput) : "";
      return [name, start !== "" ? start : emptyOf(schema)];
    }),
  );
  return {
    kind: "json",
    initial: JSON.stringify(skeleton, null, 2),
    required: names.filter((name) => required.has(name)),
  };
}

/** The values a form starts with, by field name. */
export function initialValues(view: RunInputView): Record<string, string> {
  return view.kind === "form"
    ? Object.fromEntries(view.fields.map((field) => [field.name, field.initial]))
    : {};
}

/** The form's required fields still empty: the run waits until there are none. */
export function missingFields(view: RunInputView, values: Record<string, string>): RunField[] {
  if (view.kind !== "form") return [];
  return view.fields.filter(
    (field) =>
      field.required && field.kind !== "boolean" && (values[field.name] ?? "").trim() === "",
  );
}

/**
 * The JSON input's required keys still absent or empty; none while the text does not parse, since
 * the run's refusal of that text says why.
 */
export function missingJsonFields(view: RunInputView, text: string): string[] {
  if (view.kind !== "json") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!isSchema(parsed)) return [];
  return view.required.filter((name) => {
    const value = parsed[name];
    return (
      value === undefined || value === null || (typeof value === "string" && value.trim() === "")
    );
  });
}

/** Whether Run can be pressed: nothing required is missing. */
export function canRun(view: RunInputView, values: Record<string, string>, text: string): boolean {
  return missingFields(view, values).length === 0 && missingJsonFields(view, text).length === 0;
}

type InputResult = { ok: true; input: Record<string, unknown> } | { ok: false; message: string };

function numberOf(text: string, integer: boolean): number | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || (integer && !Number.isInteger(value))) return null;
  return value;
}

/** One form field's value as the tool takes it, or the sentence saying why it cannot be sent. */
function fieldValue(
  field: RunField,
  text: string,
): { value: unknown } | { message: string } | null {
  const trimmed = text.trim();
  if (field.kind === "boolean") return { value: trimmed === "true" };
  if (trimmed === "") return null;
  switch (field.kind) {
    case "number":
    case "integer": {
      const value = numberOf(trimmed, field.kind === "integer");
      return value === null
        ? {
            message: `${field.label} is ${field.kind === "integer" ? "a whole number" : "a number"}.`,
          }
        : { value };
    }
    case "list": {
      const items = trimmed
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item !== "");
      if (field.itemKind === "string" || field.itemKind === undefined) return { value: items };
      const numbers = items.map((item) => numberOf(item, field.itemKind === "integer"));
      return numbers.some((value) => value === null)
        ? { message: `${field.label} is a list of numbers, separated by commas.` }
        : { value: numbers };
    }
    case "enum": {
      const option = field.options.find((entry) => entry.label === trimmed);
      return option
        ? { value: option.value }
        : { message: `${field.label} is one of the listed values.` };
    }
    default:
      return { value: trimmed };
  }
}

/**
 * The input the run is sent, or the sentence saying why it cannot be: for a form, each field with a
 * value in its own type (an empty optional field is left out, a required one names what it needs);
 * for JSON, the parsed object.
 */
export function runInputOf(
  view: RunInputView,
  values: Record<string, string>,
  text = "",
): InputResult {
  if (view.kind === "none") return { ok: true, input: {} };
  if (view.kind === "form") {
    const missing = missingFields(view, values)[0];
    if (missing) {
      return { ok: false, message: needsSentence(missing.name, missing.description) };
    }
    const input: Record<string, unknown> = {};
    for (const field of view.fields) {
      const value = fieldValue(field, values[field.name] ?? "");
      if (value === null) continue;
      if ("message" in value) return { ok: false, message: value.message };
      input[field.name] = value.value;
    }
    return { ok: true, input };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
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
