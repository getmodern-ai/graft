import { isKebabCase } from "@graft/core";

/**
 * How a tool is named on the wire.
 *
 * An authored tool is `<vendor>__<name>` (ADR 0003: the working set is what the harness sees, as
 * ordinary first-class MCP tools). Both halves are kebab-case as the toolbox stores them — the
 * `isKebabCase` rule in `@graft/core` — so a double underscore is a separator neither half can
 * contain, and a wire name splits back into its pair without a lookup. The per-connection execute
 * tool of the advanced set is `execute__<connectionId>`; a connection id is a UUID, which the same
 * alphabet admits. Meta-tools carry a single underscore (`find_tool`) and never the double one, so
 * the three kinds are told apart by shape alone. CONTEXT.md records the separator under *Tool*.
 *
 * MCP recommends `^[a-zA-Z0-9_-]{1,128}$` for a tool name; every name built here fits it, which
 * `tool-names.test.ts` pins.
 */
export const TOOL_NAME_SEPARATOR = "__";

export const EXECUTE_TOOL_PREFIX = `execute${TOOL_NAME_SEPARATOR}`;

export const MCP_TOOL_NAME = /^[a-zA-Z0-9_-]{1,128}$/;

/** `<vendor>__<name>` — what the harness sees an authored tool as. */
export function authoredToolName(vendor: string, name: string): string {
  return `${vendor}${TOOL_NAME_SEPARATOR}${name}`;
}

/**
 * The pair a first-class name stands for, or null when the name is not one: a meta-tool, an execute
 * tool, or anything with a half that is not kebab-case.
 */
export function parseAuthoredToolName(wire: string): { vendor: string; name: string } | null {
  if (wire.startsWith(EXECUTE_TOOL_PREFIX)) return null;
  const parts = wire.split(TOOL_NAME_SEPARATOR);
  if (parts.length !== 2) return null;
  const [vendor, name] = parts as [string, string];
  if (!isKebabCase(vendor) || !isKebabCase(name)) return null;
  return { vendor, name };
}

/** `execute__<connectionId>` — the advanced set's "run code against this connection" tool. */
export function executeToolName(connectionId: string): string {
  return `${EXECUTE_TOOL_PREFIX}${connectionId}`;
}

/** The connection id an execute tool's name carries, or null when the name is not one. */
export function parseExecuteToolName(wire: string): string | null {
  if (!wire.startsWith(EXECUTE_TOOL_PREFIX)) return null;
  const connectionId = wire.slice(EXECUTE_TOOL_PREFIX.length);
  return connectionId.length > 0 ? connectionId : null;
}
