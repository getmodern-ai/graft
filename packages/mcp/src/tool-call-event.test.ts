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
      // GRA-155: the hit count rides even when the arguments were not given.
      detail: { hits: 0 },
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

  /** GRA-155: what the call was about, per tool, in counts and names — never the answer's content. */
  it("carries find_tool's word and hit counts, acquire's goal length, similar offer and job, and run_tool's target", () => {
    const found = toolResult({ tools: [{ name: "a" }, { name: "b" }], connections: [] });
    // The query is counted, not copied: it may carry the person's names (Greptile on #122).
    expect(toolCallEvent(session, "find_tool", found, 5, { query: "gmail inbox" }).detail).toEqual({
      queryWords: 2,
      hits: 2,
    });
    expect(
      JSON.stringify(toolCallEvent(session, "find_tool", found, 5, { query: "acme invoices" })),
    ).not.toContain("acme");
    const opened = toolResult({ jobId: "acq_1", status: "running", progress: [], attempts: 0 });
    expect(
      toolCallEvent(session, "acquire", opened, 25, { goal: "List the items" }).detail,
    ).toEqual({ goalLength: 14, similarOffered: false, jobId: "acq_1" });
    const similar = toolRefusal("similar_tools_exist", "Already there.", { tools: [] });
    expect(toolCallEvent(session, "acquire", similar, 3, { goal: "List the items" })).toMatchObject(
      {
        outcome: "refused",
        reason: "similar_tools_exist",
        detail: { goalLength: 14, similarOffered: true },
      },
    );
    expect(
      toolCallEvent(
        session,
        "acquire_status",
        toolResult({ jobId: "acq_1", status: "succeeded" }),
        2,
        {
          jobId: "acq_1",
        },
      ).detail,
    ).toEqual({ jobId: "acq_1", status: "succeeded" });
    expect(
      toolCallEvent(session, "run_tool", toolResult({}), 2, { vendor: "demo", name: "list-items" })
        .detail,
    ).toEqual({ tool: "demo__list-items" });
    // A tool the table does not name carries none, and an execute tool's arguments stay out.
    expect(
      toolCallEvent(session, "promote", toolResult({}), 1, { vendor: "demo" }),
    ).not.toHaveProperty("detail");
    expect(
      toolCallEvent(session, executeToolName("conn_x"), toolResult({}), 1, { path: "/secret" }),
    ).not.toHaveProperty("detail");
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
