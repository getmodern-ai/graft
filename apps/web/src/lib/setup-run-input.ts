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

function propertiesOf(schema: Record<string, unknown>): Record<string, unknown> {
  const properties = schema.properties;
  return typeof properties === "object" && properties !== null && !Array.isArray(properties)
    ? (properties as Record<string, unknown>)
    : {};
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
  const properties = propertiesOf(inputSchema);
  const fields = Object.keys(properties);
  if (runInput && fields.includes(runInput.field)) {
    return {
      kind: "field",
      field: runInput.field,
      label: runInput.label,
      defaultValue: runInput.defaultValue,
    };
  }
  if (fields.length === 0) return { kind: "none" };
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
