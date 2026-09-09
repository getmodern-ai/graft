import { describe, expect, it } from "vitest";

import { exportTokenLine, mcpEndpointUrl, mcpServersSnippet } from "./mcp-snippet";

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
