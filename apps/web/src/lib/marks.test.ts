import { describe, expect, it } from "vitest";

import {
  harnessMark,
  harnessMarkOfSetup,
  integrationMarkKey,
  integrationMarkSource,
  markInitials,
} from "./marks";

describe("harnessMark", () => {
  it("reads the harness off the name the client registered", () => {
    expect(harnessMark("Claude")).toBe("claude");
    expect(harnessMark("Claude Code (graft)")).toBe("claude-code");
    expect(harnessMark("claude-code")).toBe("claude-code");
    expect(harnessMark("Codex")).toBe("codex");
    expect(harnessMark("OpenAI Codex")).toBe("codex");
    expect(harnessMark("ChatGPT")).toBe("chatgpt");
    expect(harnessMark("Cursor")).toBe("cursor");
    expect(harnessMark("Hermes Agent")).toBe("hermes");
    expect(harnessMark("OpenClaw")).toBe("openclaw");
  });

  it("falls back to the host of the client's URI when the name matches nothing", () => {
    expect(harnessMark("Desktop app", "https://claude.ai")).toBe("claude");
    expect(harnessMark("Connector", "https://www.cursor.com/")).toBe("cursor");
    expect(harnessMark("My client", "https://chatgpt.com/")).toBe("chatgpt");
  });

  it("lets the name win over the URI", () => {
    expect(harnessMark("Claude Code", "https://claude.ai")).toBe("claude-code");
  });

  it("does not take a host that only ends in the same letters", () => {
    expect(harnessMark("Thing", "https://notclaude.ai")).toBe("generic");
    expect(harnessMark("Thing", "not a url")).toBe("generic");
  });

  it("draws the generic mark for a static-token agent and an unknown client", () => {
    expect(harnessMark(null, null)).toBe("generic");
    expect(harnessMark(undefined)).toBe("generic");
    expect(harnessMark("Inspector")).toBe("generic");
  });
});

describe("harnessMarkOfSetup", () => {
  it("maps Setup's harnesses, with another MCP client as the generic mark", () => {
    expect(harnessMarkOfSetup("claude-code")).toBe("claude-code");
    expect(harnessMarkOfSetup("hermes")).toBe("hermes");
    expect(harnessMarkOfSetup("other")).toBe("generic");
  });
});

describe("integrationMarkKey", () => {
  it("files a starter id and a catalogue slug under one key", () => {
    expect(integrationMarkKey("google_drive")).toBe("google-drive");
    expect(integrationMarkKey("google-drive")).toBe("google-drive");
    expect(integrationMarkKey(" HubSpot ")).toBe("hubspot");
  });
});

describe("integrationMarkSource", () => {
  it("prefers the directory's logo over the bundled file", () => {
    expect(integrationMarkSource("https://logo/gmail", "/gmail.png")).toBe("https://logo/gmail");
    expect(integrationMarkSource(null, "/gmail.png")).toBe("/gmail.png");
    expect(integrationMarkSource(undefined, undefined)).toBeNull();
  });

  it("steps down past a logo that failed to load, then to initials", () => {
    expect(integrationMarkSource("https://logo/x", "/x.png", ["https://logo/x"])).toBe("/x.png");
    expect(
      integrationMarkSource("https://logo/x", "/x.png", ["https://logo/x", "/x.png"]),
    ).toBeNull();
    expect(integrationMarkSource("https://logo/x", null, ["https://logo/x"])).toBeNull();
  });

  it("tries a new logo afresh when the props change", () => {
    expect(integrationMarkSource("https://logo/y", "/x.png", ["https://logo/x"])).toBe(
      "https://logo/y",
    );
  });
});

describe("markInitials", () => {
  it("takes the first letters of the first two words of the name", () => {
    expect(markInitials("Open-Meteo")).toBe("OM");
    expect(markInitials("Google Sheets")).toBe("GS");
    expect(markInitials("Microsoft Outlook Calendar")).toBe("MO");
    expect(markInitials("stripe")).toBe("S");
  });

  it("falls back to the slug, then to a question mark", () => {
    expect(markInitials(null, "acme_crm")).toBe("AC");
    expect(markInitials("", "")).toBe("?");
    expect(markInitials("  ")).toBe("?");
  });
});
