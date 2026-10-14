import { describe, expect, it } from "vitest";

import {
  askEveryCallSent,
  defaultToolAllowChoice,
  toolAllowAnswer,
  toolAllowMenuLabel,
  toolAllowMenuOptions,
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

describe("toolAllowMenuOptions (GRA-311)", () => {
  it("offers every integration tool, recommended and first, then the tool alone, on a tool that cannot delete", () => {
    const options = toolAllowMenuOptions({ ...base, destructive: false });
    expect(options).toEqual([
      {
        value: "integration",
        title: "Every Gmail tool",
        description: "Won't ask again for Gmail. Tools that can delete still ask.",
        recommended: true,
        destructive: false,
      },
      {
        value: "tool",
        title: "Just Send email",
        description: "Won't ask again for this tool.",
        recommended: false,
        destructive: false,
      },
    ]);
  });

  it("never offers the narrower integration line on a destructive tool, and draws the wider one destructive", () => {
    const options = toolAllowMenuOptions({
      agentName: "Codex",
      integrationName: "HubSpot",
      tool: "Delete contacts",
      destructive: true,
    });
    expect(options.map((option) => option.value)).toEqual(["tool", "integration-destructive"]);
    expect(options[0]).toMatchObject({ title: "Just Delete contacts", recommended: true });
    expect(options[1]).toMatchObject({
      title: "Every HubSpot tool, including ones that delete",
      description: "Codex won't ask again for anything in HubSpot.",
      recommended: false,
      destructive: true,
    });
  });

  it("offers no allow for one call and no em dash", () => {
    for (const destructive of [false, true]) {
      for (const option of toolAllowMenuOptions({ ...base, destructive })) {
        expect(option.title).not.toMatch(/once/i);
        expect(`${option.title}${option.description}`).not.toContain("—");
      }
    }
  });

  it("maps every menu choice to its body, none carrying askEveryCall", () => {
    const bodies = [false, true].flatMap((destructive) =>
      toolAllowMenuOptions({ ...base, destructive }).map((option) => [
        option.value,
        toolAllowAnswer(option.value),
      ]),
    );
    expect(Object.fromEntries(bodies)).toEqual({
      integration: { allow: true, allowVendor: true, includesDestructive: false },
      tool: { allow: true },
      "integration-destructive": { allow: true, allowVendor: true, includesDestructive: true },
    });
    for (const [, body] of bodies) expect(body).not.toHaveProperty("askEveryCall");
  });
});

describe("toolAllowMenuLabel", () => {
  it("reads as the row's sentence, as a question of what to allow", () => {
    expect(
      toolAllowMenuLabel({ agentName: "Codex", action: "send email", integrationName: "Gmail" }),
    ).toBe("Allow Codex to send email in Gmail");
    expect(toolAllowMenuLabel({ agentName: "Codex", action: null, integrationName: "Gmail" })).toBe(
      "Allow Codex to use a Gmail tool",
    );
  });
});

describe("askEveryCallSent", () => {
  it("sends the tick only where the person chose it", () => {
    expect(askEveryCallSent(false, false)).toBeUndefined();
    expect(askEveryCallSent(true, false)).toBe(true);
    expect(askEveryCallSent(true, true)).toBe(true);
    expect(askEveryCallSent(false, true)).toBe(false);
  });
});

describe("toolAllowAnswer", () => {
  it("leaves askEveryCall out unless it is given", () => {
    expect(toolAllowAnswer("tool")).toEqual({ allow: true });
    expect(toolAllowAnswer("integration")).not.toHaveProperty("askEveryCall");
  });

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
