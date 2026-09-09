import { describe, expect, it } from "vitest";

import {
  authoredToolName,
  executeToolName,
  MCP_TOOL_NAME,
  parseAuthoredToolName,
  parseExecuteToolName,
} from "./tool-names";

describe("tool names on the wire", () => {
  it("joins vendor and name with a double underscore and splits back without a lookup", () => {
    expect(authoredToolName("google-workspace", "list-messages")).toBe(
      "google-workspace__list-messages",
    );
    expect(parseAuthoredToolName("google-workspace__list-messages")).toEqual({
      vendor: "google-workspace",
      name: "list-messages",
    });
  });

  it("is never confused with a meta-tool or an execute tool", () => {
    for (const wire of [
      "find_tool",
      "run_tool",
      "execute__conn_1",
      "a__b__c",
      "Vendor__name",
      "",
    ]) {
      expect(parseAuthoredToolName(wire), wire).toBeNull();
    }
    expect(parseExecuteToolName("execute__3f2a1c5e-0b1d-4e9a-8c7b-1234567890ab")).toBe(
      "3f2a1c5e-0b1d-4e9a-8c7b-1234567890ab",
    );
    expect(parseExecuteToolName("execute__")).toBeNull();
    expect(parseExecuteToolName("demo__list-items")).toBeNull();
  });

  it("fits what MCP recommends for a tool name", () => {
    for (const wire of [
      authoredToolName("unleashed", "create-sales-order"),
      executeToolName("3f2a1c5e-0b1d-4e9a-8c7b-1234567890ab"),
      authoredToolName("a".repeat(32), "b".repeat(64)),
    ]) {
      expect(wire, wire).toMatch(MCP_TOOL_NAME);
    }
  });
});
