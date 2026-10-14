import type { ToolCallEvent } from "@graft/mcp";
import { describe, expect, it } from "vitest";

import { toolCalledProperties } from "./tool-called";

/**
 * `tool_called`'s properties off the MCP hook's event (GRA-100; GRA-244): the fields every call
 * carried before, unchanged for an authored tool, and a stock copy's run adding its origin and, on a
 * failure, its kind and the vendor's status, flat, as an analytics backend indexes them.
 */
const base: ToolCallEvent = {
  tool: "demo__list-items",
  kind: "authored",
  agentId: "agent_a",
  personId: "person_1",
  outcome: "ok",
  latencyMs: 12,
  uiExtensionDeclared: false,
};

describe("toolCalledProperties", () => {
  it("is what it was for an authored tool, with no stock keys", () => {
    expect(toolCalledProperties(base)).toEqual({
      tool: "demo__list-items",
      kind: "authored",
      agent_id: "agent_a",
      outcome: "ok",
      reason: null,
      latency_ms: 12,
    });
  });

  it("adds a stock run's origin, and a failure's kind and vendor status", () => {
    expect(
      toolCalledProperties({
        ...base,
        tool: "run_tool",
        kind: "meta",
        stock: { toolId: "stock_t", versionId: "stock_v", remix: false },
      }),
    ).toEqual({
      tool: "run_tool",
      kind: "meta",
      agent_id: "agent_a",
      outcome: "ok",
      reason: null,
      latency_ms: 12,
      stock_tool_id: "stock_t",
      stock_version_id: "stock_v",
      stock_remix: false,
      failure_kind: null,
      vendor_status: null,
    });
    expect(
      toolCalledProperties({
        ...base,
        outcome: "error",
        stock: {
          toolId: "stock_t",
          versionId: "stock_v",
          remix: true,
          failureKind: "threw",
          vendorStatus: 503,
        },
      }),
    ).toMatchObject({
      outcome: "error",
      stock_remix: true,
      failure_kind: "threw",
      vendor_status: 503,
    });
  });
});
