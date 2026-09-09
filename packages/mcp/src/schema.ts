import type { JsonSchemaType } from "@modelcontextprotocol/sdk/validation";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";

import { isPlainObject } from "./result";

/**
 * Validating a call's input against a tool's stored JSON Schema — `run_tool` refuses on it, and a
 * first-class call is checked the same way, because a harness that validated client-side is not
 * something this server can see (GRA-19's acceptance criterion).
 *
 * The validator is the MCP SDK's own Ajv provider, the one it uses for elicitation answers and
 * structured output: `strict: false` and `validateSchema: false`, which is the right posture for a
 * schema a model wrote — an unknown keyword is ignored rather than refused. One dependency does the
 * job the SDK already carries, so no second schema language enters the process.
 */

export type InputVerdict =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; message: string };

export type InputValidator = (input: unknown) => InputVerdict;

const provider = new AjvJsonSchemaValidator();

/** Compiled validators by schema text; a toolbox has tens of tools, so the cache is bounded low. */
const compiled = new Map<string, InputValidator>();
const CACHE_LIMIT = 256;

/**
 * A validator for an object schema, or the reason there cannot be one. The schema must describe an
 * object because a tool's arguments are named; the toolbox stores nothing else (`@graft/core`'s
 * tool service refuses another `type` at create).
 */
export function compileInputSchema(schema: unknown): InputValidator | { error: string } {
  if (!isPlainObject(schema) || schema.type !== "object") {
    return { error: 'inputSchema must be a JSON Schema object with "type": "object"' };
  }
  const key = JSON.stringify(schema);
  const cached = compiled.get(key);
  if (cached) return cached;

  let validate: ReturnType<typeof provider.getValidator<Record<string, unknown>>>;
  try {
    validate = provider.getValidator<Record<string, unknown>>(schema as JsonSchemaType);
  } catch (error) {
    return { error: `inputSchema could not be compiled: ${describe(error)}` };
  }
  const validator: InputValidator = (input) => {
    // An absent input is an empty object: a tool with no required fields is callable with nothing.
    const candidate = input === undefined || input === null ? {} : input;
    const result = validate(candidate);
    if (result.valid) return { ok: true, value: result.data };
    return { ok: false, message: `input does not match the tool's schema: ${result.errorMessage}` };
  };
  if (compiled.size >= CACHE_LIMIT) {
    const oldest = compiled.keys().next().value;
    if (oldest !== undefined) compiled.delete(oldest);
  }
  compiled.set(key, validator);
  return validator;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
