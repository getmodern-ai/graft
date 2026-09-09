import { parseArgs } from "node:util";

import { createConnectionDeps } from "@graft/core";
import { createDb } from "@graft/db";
import { env } from "@graft/env/server";
import { createMcpDeps, runSweep } from "@graft/mcp";
import { createCredentialVault, createLocalKeyring } from "@graft/vault";

/**
 * Run one working-set sweep by hand and print the report (ADR 0009; `@graft/mcp`'s `runSweep`):
 *
 *   pnpm --filter @graft/server sweep            # demote what the rule says, print the report
 *   pnpm --filter @graft/server sweep -- --plan  # print what it would demote; change nothing
 *
 * Reads the environment the server does. Two things this process cannot do that the server's own
 * sweep can: it has no sessions to notify, so a running server's harnesses learn of a demotion at
 * their next `tools/list` rather than from `tools/list_changed`; and it has no view of that server's
 * in-flight registry, so it cannot skip an agent with a run in flight. With a server up, prefer
 * `--plan`, or stop the server first. The scheduled sweep inside the server
 * (`GRAFT_SWEEP_INTERVAL_SECONDS`) is the one that runs for real.
 */

const { values } = parseArgs({
  // pnpm forwards the `--` that separates its own flags from the script's; `parseArgs` would read
  // it as a positional and refuse everything after it.
  args: process.argv.slice(2).filter((arg) => arg !== "--"),
  options: {
    plan: { type: "boolean", default: false },
  },
});

const db = createDb(env.GRAFT_DATABASE_URL);
const vault = createCredentialVault(createLocalKeyring(env.GRAFT_KEYRING_SECRET));
// No sandbox and no key pair: the sweep runs nothing, it only reads and demotes.
const deps = createMcpDeps({
  db,
  connection: createConnectionDeps({ encrypt: vault.encrypt }),
  sandbox: null,
  keys: null,
  proxyPublicUrl: env.GRAFT_PROXY_PUBLIC_URL,
});

try {
  const report = await runSweep({ db }, deps, new Date(), { apply: !values.plan });
  console.log(JSON.stringify({ plan: values.plan, ...report }, null, 2));
} finally {
  deps.notifier?.close();
  deps.inFlight?.close();
  await db.close();
}
