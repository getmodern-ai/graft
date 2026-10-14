import { describe, expect, it } from "vitest";

import {
  defaultToolAllowChoice,
  toolAllowAnswer,
  toolAllowOptions,
  toolLabel,
} from "./tool-allow-choice";

const base = { agentName: "Codex", integrationName: "Gmail", tool: "Send email" };

describe("toolAllowOptions (GRA-314)", () => {
  it("leads with every integration tool on a tool that cannot delete, pre-selected", () => {
    const options = toolAllowOptions({ ...base, destructive: false });
    expect(options.map((option) => option.value)).toEqual([
      "integration",
      "tool",
      "integration-destructive",
    ]);
    expect(options[0]).toMatchObject({
      title: "Every Gmail tool",
      description: "Codex won't ask again for Gmail. Tools that can delete still ask.",
      recommended: true,
    });
    expect(options[1]?.title).toBe("Just Send email");
    expect(defaultToolAllowChoice(false)).toBe("integration");
  });

  it("offers only the integration line that includes destructive tools on a destructive tool, and starts on the tool alone", () => {
    const options = toolAllowOptions({ ...base, tool: "Delete email", destructive: true });
    expect(options.map((option) => option.value)).toEqual(["tool", "integration-destructive"]);
    expect(options.some((option) => option.recommended)).toBe(false);
    expect(defaultToolAllowChoice(true)).toBe("tool");
  });

  it("offers no allow for one call", () => {
    for (const destructive of [false, true]) {
      for (const option of toolAllowOptions({ ...base, destructive })) {
        expect(option.title).not.toMatch(/once/i);
        expect(option.description).not.toContain("—");
      }
    }
  });
});

describe("toolAllowAnswer", () => {
  it("sends the tool's allow alone, or with the integration's, destructive tools only on the line that says so", () => {
    expect(toolAllowAnswer("tool", false)).toEqual({ allow: true, askEveryCall: false });
    expect(toolAllowAnswer("integration", true)).toEqual({
      allow: true,
      askEveryCall: true,
      allowVendor: true,
      includesDestructive: false,
    });
    expect(toolAllowAnswer("integration-destructive", false)).toEqual({
      allow: true,
      askEveryCall: false,
      allowVendor: true,
      includesDestructive: true,
    });
  });
});

describe("toolLabel", () => {
  it("reads the wire name as a person does", () => {
    expect(toolLabel("gmail__send-email", "gmail")).toBe("Send email");
    expect(toolLabel("demo__create_item", "demo")).toBe("Create item");
    expect(toolLabel("other__x", "demo")).toBe("Other x");
  });
});
