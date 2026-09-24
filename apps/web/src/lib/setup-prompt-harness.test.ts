import { describe, expect, it } from "vitest";

import { promptHarnessOfClient, promptHarnessOfShape } from "./setup-prompt-harness";

describe("promptHarnessOfShape", () => {
  it("maps the three configuration shapes onto the prompt's harnesses", () => {
    expect(promptHarnessOfShape("hermes")).toBe("hermes");
    expect(promptHarnessOfShape("openclaw")).toBe("openclaw");
    expect(promptHarnessOfShape("generic")).toBe("other");
  });
});

describe("promptHarnessOfClient", () => {
  it("reads the harness off the name the client registered", () => {
    expect(promptHarnessOfClient("Claude")).toBe("claude");
    expect(promptHarnessOfClient("Claude Code (graft)")).toBe("claude-code");
    expect(promptHarnessOfClient("claude-code")).toBe("claude-code");
    expect(promptHarnessOfClient("Codex")).toBe("codex");
    expect(promptHarnessOfClient("ChatGPT")).toBe("chatgpt");
    expect(promptHarnessOfClient("OpenAI Codex")).toBe("codex");
  });

  it("falls back to any MCP client", () => {
    expect(promptHarnessOfClient("Cursor")).toBe("other");
    expect(promptHarnessOfClient(null)).toBe("other");
    expect(promptHarnessOfClient(undefined)).toBe("other");
  });
});
