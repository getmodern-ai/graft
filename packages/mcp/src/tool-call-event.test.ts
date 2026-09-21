import { describe, expect, it } from "vitest";

import { toolAwaiting, toolAwaitingOrError, toolError, toolRefusal, toolResult } from "./result";
import { authoredToolName, executeToolName } from "./tool-names";
import { toolCallEvent } from "./tools";

/**
 * What `McpDeps.onToolCall` is told (GRA-100): the answer read back into an outcome, the name
 * into a kind, the scope into who, and whether the client declared the MCP Apps extension
 * (GRA-150: an observation on the line, never an admission). Pure, so it is pinned here rather
 * than through a session.
 */
const session = {
  scope: { agentId: "agent_a", personId: "person_1" },
  uiExtensionDeclared: () => false,
};

describe("toolCallEvent", () => {
  it("reads a meta-tool's ok answer", () => {
    expect(toolCallEvent(session, "find_tool", toolResult({ tools: [] }), 12)).toEqual({
      tool: "find_tool",
      kind: "meta",
      agentId: "agent_a",
      personId: "person_1",
      outcome: "ok",
      latencyMs: 12,
      uiExtensionDeclared: false,
    });
  });

  it("names the refusal's reason for an execute tool, and nothing else of the answer", () => {
    const result = toolRefusal("connection_not_in_scope", "Not yours", { connectionId: "conn_x" });
    expect(toolCallEvent(session, executeToolName("conn_x"), result, 3)).toEqual({
      tool: executeToolName("conn_x"),
      kind: "execute",
      agentId: "agent_a",
      personId: "person_1",
      outcome: "refused",
      reason: "connection_not_in_scope",
      latencyMs: 3,
      uiExtensionDeclared: false,
    });
  });

  it("reads an awaiting answer as ok — a result, not an error (GRA-112) — and sorts a refusal the other way", () => {
    const awaiting = {
      error: "awaiting_approval",
      reason: "awaiting_approval",
      url: "https://c/x",
    };
    expect(toolAwaiting(awaiting)).toEqual({
      content: [{ type: "text", text: JSON.stringify(awaiting) }],
      structuredContent: awaiting,
      isError: false,
    });
    expect(toolAwaitingOrError(awaiting)).toEqual(toolAwaiting(awaiting));
    expect(toolCallEvent(session, "acquire", toolAwaitingOrError(awaiting), 30)).toMatchObject({
      kind: "meta",
      outcome: "ok",
    });
    const refused = { error: "refused", reason: "approval_declined", message: "No." };
    expect(toolAwaitingOrError(refused)).toEqual(toolError(refused));
    expect(toolCallEvent(session, "acquire", toolAwaitingOrError(refused), 30)).toMatchObject({
      outcome: "refused",
      reason: "approval_declined",
    });
  });

  it("reads a run's failure as an error on an authored tool", () => {
    const result = toolError({ error: "run_failed", exitCode: 1, stderrTail: "boom" });
    expect(
      toolCallEvent(session, authoredToolName("demo", "list-items"), result, 250),
    ).toMatchObject({
      tool: "demo__list-items",
      kind: "authored",
      outcome: "error",
      latencyMs: 250,
    });
    expect(toolCallEvent(session, "demo__list-items", result, 250)).not.toHaveProperty("reason");
  });

  it("carries the client's MCP Apps declaration as an observation, whichever way it went", () => {
    const declared = { ...session, uiExtensionDeclared: () => true };
    expect(toolCallEvent(declared, "find_tool", toolResult({ tools: [] }), 1)).toMatchObject({
      uiExtensionDeclared: true,
    });
    expect(toolCallEvent(session, "find_tool", toolResult({ tools: [] }), 1)).toMatchObject({
      uiExtensionDeclared: false,
    });
  });
});
