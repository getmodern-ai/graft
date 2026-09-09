import { parseArgs } from "node:util";

import { env } from "@graft/env/server";
import {
  CapabilityTokenUnconfiguredError,
  importCapabilityTokenKeys,
  mintCapabilityToken,
} from "@graft/token";

/**
 * Mint a capability token with the deployment's key pair, for a `curl` against the dev server:
 *
 *   pnpm --filter @graft/server mint -- --person person_1 --agent agent_1 \
 *     --connections conn_1,conn_2 [--tool execute] [--ttl 300] [--dry-run]
 *
 * What the server will do for real once GRA-3's exec path lands: mint once per exec, in the exec's
 * own environment. This script exists so the proxy can be exercised before that.
 */

const { values } = parseArgs({
  // pnpm forwards the `--` that separates its own flags from the script's; `parseArgs` would read
  // it as a positional and refuse everything after it.
  args: process.argv.slice(2).filter((arg) => arg !== "--"),
  options: {
    person: { type: "string" },
    agent: { type: "string" },
    connections: { type: "string" },
    tool: { type: "string", default: "execute" },
    ttl: { type: "string", default: "300" },
    "dry-run": { type: "boolean", default: false },
  },
});

if (!values.person || !values.agent || !values.connections) {
  console.error(
    "usage: mint --person <id> --agent <id> --connections <id>[,<id>...] [--tool t] [--ttl s] [--dry-run]",
  );
  process.exit(64);
}

if (!env.GRAFT_CAPABILITY_TOKEN_PRIVATE_KEY || !env.GRAFT_CAPABILITY_TOKEN_PUBLIC_KEY) {
  throw new CapabilityTokenUnconfiguredError();
}

const keys = await importCapabilityTokenKeys({
  privateKeyPem: env.GRAFT_CAPABILITY_TOKEN_PRIVATE_KEY,
  publicKeyPem: env.GRAFT_CAPABILITY_TOKEN_PUBLIC_KEY,
});

console.log(
  await mintCapabilityToken(
    {
      personId: values.person,
      agentId: values.agent,
      connectionIds: values.connections.split(",").map((id) => id.trim()),
      tool: values.tool,
      ttlSeconds: Number(values.ttl),
      dryRun: values["dry-run"],
    },
    keys,
  ),
);
