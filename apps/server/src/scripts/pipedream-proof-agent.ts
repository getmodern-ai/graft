import { parseArgs } from "node:util";

import { executeToolName } from "@graft/mcp/tool-names";
import { sandboxPath } from "@graft/toolbox";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/**
 * The agent's side of the Pipedream proof (GRA-59; `pipedream-proof.ts` is the server's): a harness
 * played by the MCP SDK's client over streamable HTTP with the throwaway agent's token, doing what
 * a harness's model would — propose Gmail with `request_connection`, relay the link, and once the
 * person has connected, run the module that reads a message and its attachment through the relay.
 *
 *   pnpm --filter @graft/server pipedream-proof-agent -- --token grft_… request
 *   pnpm --filter @graft/server pipedream-proof-agent -- --token grft_… tools
 *   pnpm --filter @graft/server pipedream-proof-agent -- --token grft_… execute --connection <id>
 */

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    token: { type: "string" },
    server: { type: "string", default: "http://localhost:3000" },
    connection: { type: "string" },
  },
});

const step = positionals[0] ?? "request";
const token = values.token;
if (!token) {
  console.error("--token <agent token> is required (the proof server prints it at boot)");
  process.exit(2);
}

const PROPOSAL = {
  vendor: "gmail",
  displayName: "Gmail",
  primaryHost: "https://gmail.googleapis.com/gmail/v1",
  hosts: ["www.googleapis.com"],
  scheme: "oauth_authorization_code",
  schemeConfig: {
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scopes: "https://www.googleapis.com/auth/gmail.readonly",
  },
  docsUrl:
    "https://developers.google.com/gmail/api/reference/rest/v1/users.messages.attachments/get",
};

const transport = new StreamableHTTPClientTransport(new URL(`${values.server}/mcp`), {
  requestInit: { headers: { authorization: `Bearer ${token}` } },
});
const client = new Client({ name: "pipedream-proof-agent", version: "0.0.0" });
await client.connect(transport);

function text(result: CallToolResult): string {
  const first = result.content[0];
  return first?.type === "text" ? first.text : JSON.stringify(result);
}

try {
  if (step === "tools") {
    const { tools } = await client.listTools();
    console.log(tools.map((tool) => tool.name).join("\n"));
  } else if (step === "request") {
    const result = (await client.callTool({
      name: "request_connection",
      arguments: PROPOSAL,
    })) as CallToolResult;
    console.log(text(result));
  } else if (step === "execute") {
    const connectionId = values.connection;
    if (!connectionId) {
      console.error("--connection <id> is required for execute");
      process.exit(2);
    }
    const result = (await client.callTool({
      name: executeToolName(connectionId),
      arguments: {
        command: `echo '{}' | node /graft/runner.mjs ${sandboxPath("tools/gmail/read-attachment/v1")}`,
      },
    })) as CallToolResult;
    console.log(text(result));
  } else {
    console.error(`unknown step ${step}: request, tools or execute`);
    process.exit(2);
  }
} finally {
  await client.close();
}
