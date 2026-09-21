/**
 * What a person pastes into their harness to connect an agent (ADR 0007: a bearer token per agent,
 * carried in the `headers` block of a remote MCP server). The token is shown once, when the agent
 * is created, and this snippet deliberately does not embed it: the harness expands `${GRAFT_TOKEN}`
 * from its environment — OpenClaw was confirmed to do so in the GRA-25 spike, and a static header
 * is what both harnesses send — so the config file a person commits or shares carries no secret,
 * and rotating the token is one `export` rather than an edit.
 *
 * Each harness has its own shape (GRA-152): Hermes reads YAML under `mcp_servers` in
 * `~/.hermes/config.yaml` and resolves `${GRAFT_TOKEN}` from `~/.hermes/.env`; OpenClaw and every
 * other MCP client take the JSON `mcpServers` block and the variable from their environment. On
 * 2026-09-21 the console showed the JSON alone and a Hermes person rewrote it as YAML by hand. The
 * docs site's harness pages are the source of each shape, and what this file renders is what they
 * show, byte for byte, with the deployment's origin in place of `https://app.getgraft.ai`.
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

/** The harnesses the setup block knows a shape for. Hermes first (ADR 0016). */
export type Harness = "hermes" | "openclaw" | "generic";

export const HARNESS_ITEMS: readonly { value: Harness; label: string }[] = [
  { value: "hermes", label: "Hermes" },
  { value: "openclaw", label: "OpenClaw" },
  { value: "generic", label: "Any MCP client" },
];

export function readHarness(value: string | null): Harness | null {
  return HARNESS_ITEMS.some((item) => item.value === value) ? (value as Harness) : null;
}

/** Hermes's entry for `~/.hermes/config.yaml`: YAML under `mcp_servers`, the token as `${GRAFT_TOKEN}`. */
export function hermesConfigSnippet(origin: string): string {
  return [
    "mcp_servers:",
    "  graft:",
    `    url: "${mcpEndpointUrl(origin)}"`,
    "    headers:",
    `      Authorization: "Bearer \${${TOKEN_ENV_VAR}}"`,
  ].join("\n");
}

/** The line for `~/.hermes/.env`, where Hermes reads the variable from; the token when it is known. */
export function hermesEnvLine(token = "YOUR_AGENT_TOKEN"): string {
  return `${TOKEN_ENV_VAR}=${token}`;
}

export type SetupBlock = { label: string; code: string; copyLabel: string; hint: string };

/**
 * The two blocks a harness needs after the URL — where the token goes and what to add to its
 * configuration — in the harness's own words. Without a token the placeholder stands and the hint
 * says to replace it.
 */
export function harnessSetup(
  harness: Harness,
  origin: string,
  token?: string,
): { token: SetupBlock; config: SetupBlock } {
  const replace = token ? "" : "Replace YOUR_AGENT_TOKEN with your saved token. ";
  if (harness === "hermes") {
    return {
      token: {
        label: "Add your token to ~/.hermes/.env",
        code: hermesEnvLine(token),
        copyLabel: "Copy line",
        hint: `${replace}Hermes resolves \${${TOKEN_ENV_VAR}} from ~/.hermes/.env at connect time, so the config file holds no secret.`,
      },
      config: {
        label: "Add to ~/.hermes/config.yaml",
        code: hermesConfigSnippet(origin),
        copyLabel: "Copy configuration",
        hint: "Under mcp_servers, beside any other server. Reload with /reload-mcp in a session, or restart Hermes.",
      },
    };
  }
  return {
    token: {
      label: "Set your token",
      code: exportTokenLine(token ?? "YOUR_AGENT_TOKEN"),
      copyLabel: "Copy command",
      hint: `${replace}Run this command in the shell that starts your harness.`,
    },
    config: {
      label: "MCP configuration",
      code: mcpServersSnippet(origin),
      copyLabel: "Copy configuration",
      hint:
        harness === "openclaw"
          ? `Add this to OpenClaw's mcpServers block. OpenClaw expands \${${TOKEN_ENV_VAR}} from its environment.`
          : `Add this to your client's MCP configuration. It reads your token from ${TOKEN_ENV_VAR}.`,
    },
  };
}
