/**
 * What a person pastes into their harness to connect an agent (ADR 0007: a bearer token per agent,
 * carried in the `headers` block of a remote MCP server). The token is shown once, when the agent
 * is created, and this snippet deliberately does not embed it: the harness expands `${GRAFT_TOKEN}`
 * from its environment — OpenClaw was confirmed to do so in the GRA-25 spike, and a static header
 * is what both harnesses send — so the config file a person commits or shares carries no secret,
 * and rotating the token is one `export` rather than an edit. The harness-specific variants are
 * roadmap GRA-27; this is the generic `mcpServers` block.
 */

export const TOKEN_ENV_VAR = "GRAFT_TOKEN";

/** Where the harness connects: this deployment's origin plus the server's MCP mount (`/mcp`). */
export function mcpEndpointUrl(origin: string): string {
  return `${origin.replace(/\/+$/, "")}/mcp`;
}

/** The `mcpServers` block, pretty-printed, with the token as an environment reference. */
export function mcpServersSnippet(origin: string): string {
  const block = {
    mcpServers: {
      graft: {
        type: "http",
        url: mcpEndpointUrl(origin),
        headers: { Authorization: `Bearer \${${TOKEN_ENV_VAR}}` },
      },
    },
  };
  return JSON.stringify(block, null, 2);
}

/** The shell line that puts the token where the snippet reads it. Single-quoted: a token has no quotes. */
export function exportTokenLine(token: string): string {
  return `export ${TOKEN_ENV_VAR}='${token}'`;
}
