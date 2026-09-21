import { describe, expect, it } from "vitest";

import {
  exportTokenLine,
  HARNESS_ITEMS,
  harnessSetup,
  hermesConfigSnippet,
  hermesEnvLine,
  mcpEndpointUrl,
  mcpServersSnippet,
  openclawConfigSnippet,
  readHarness,
} from "./mcp-snippet";

describe("the mcpServers snippet", () => {
  it("points at /mcp on the deployment's origin and references the token, never embedding it", () => {
    const snippet = mcpServersSnippet("https://graft.example/");
    expect(JSON.parse(snippet)).toEqual({
      mcpServers: {
        graft: {
          type: "http",
          url: "https://graft.example/mcp",
          // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal placeholder is what the harness expands
          headers: { Authorization: "Bearer ${GRAFT_TOKEN}" },
        },
      },
    });
    expect(snippet).not.toContain("grft_");
  });

  it("puts the token in the export line, and only there", () => {
    expect(exportTokenLine("grft_abc123")).toBe("export GRAFT_TOKEN='grft_abc123'");
    expect(mcpEndpointUrl("http://localhost:3001")).toBe("http://localhost:3001/mcp");
  });
});

/**
 * GRA-152: each harness gets its own shape. The Hermes strings are the docs site's Hermes page
 * (graft-docs `graft/harnesses/hermes.mdx`) with the deployment's origin in place of the hosted
 * one — change one and change the other.
 */
describe("the harness's own shape", () => {
  it("renders Hermes's YAML mcp_servers entry and its .env line, byte for byte as the docs show them", () => {
    expect(hermesConfigSnippet("https://app.getgraft.ai/")).toBe(
      [
        "mcp_servers:",
        "  graft:",
        '    url: "https://app.getgraft.ai/mcp"',
        "    headers:",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal placeholder is what Hermes resolves
        '      Authorization: "Bearer ${GRAFT_TOKEN}"',
      ].join("\n"),
    );
    expect(hermesEnvLine("grft_abc123")).toBe("GRAFT_TOKEN=grft_abc123");
    expect(hermesEnvLine()).toBe("GRAFT_TOKEN=YOUR_AGENT_TOKEN");
    expect(hermesConfigSnippet("https://app.getgraft.ai/")).not.toContain("grft_");
  });

  it("gives Hermes its two files, and the others the export line and the JSON block", () => {
    const hermes = harnessSetup("hermes", "http://localhost:3001", "grft_x");
    expect(hermes.token.label).toBe("Add your token to ~/.hermes/.env");
    expect(hermes.token.code).toBe("GRAFT_TOKEN=grft_x");
    expect(hermes.config.label).toBe("Add to ~/.hermes/config.yaml");
    expect(hermes.config.code).toBe(hermesConfigSnippet("http://localhost:3001"));
    expect(hermes.token.hint).not.toContain("Replace");

    // OpenClaw's own schema (GRA-161): mcp.servers with the transport said outright, the token in
    // the Gateway host's .env — the docs site's OpenClaw page, byte for byte.
    const openclaw = harnessSetup("openclaw", "http://localhost:3001");
    expect(openclaw.token.label).toBe("Add your token to ~/.openclaw/.env");
    expect(openclaw.token.code).toBe("GRAFT_TOKEN=YOUR_AGENT_TOKEN");
    expect(openclaw.token.hint).toContain("Replace YOUR_AGENT_TOKEN");
    expect(openclaw.config.label).toBe("Add to ~/.openclaw/openclaw.json");
    expect(JSON.parse(openclaw.config.code)).toEqual({
      mcp: {
        servers: {
          graft: {
            url: "http://localhost:3001/mcp",
            transport: "streamable-http",
            // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal placeholder is what OpenClaw expands
            headers: { Authorization: "Bearer ${GRAFT_TOKEN}" },
          },
        },
      },
    });
    expect(openclaw.config.code).not.toContain("mcpServers");
    expect(openclaw.config.hint).toContain("mcp.servers");
    expect(openclawConfigSnippet("https://app.getgraft.ai/")).toContain(
      '"transport": "streamable-http"',
    );

    const generic = harnessSetup("generic", "http://localhost:3001", "grft_x");
    expect(generic.config.code).toBe(mcpServersSnippet("http://localhost:3001"));
    expect(generic.config.hint).not.toContain("OpenClaw");
  });

  it("lists Hermes first and reads a harness back from the Select's value", () => {
    expect(HARNESS_ITEMS.map((item) => item.value)).toEqual(["hermes", "openclaw", "generic"]);
    expect(readHarness("openclaw")).toBe("openclaw");
    expect(readHarness("cursor")).toBeNull();
  });
});
