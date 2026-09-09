import { parseArgs } from "node:util";

import { createConnectionDeps } from "@graft/core";
import { createDb } from "@graft/db";
import { env } from "@graft/env/server";
import { createMcpDeps, runSweep } from "@graft/mcp";
import { createCredentialVault } from "@graft/vault";

import { selectBackings } from "../backings";

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
// The keyring the deployment's form selects (`../backings.ts`, ADR 0002): the sweep encrypts
// nothing, but the connection deps carry the vault's encrypt half whichever form is running.
const backings = await selectBackings(env, { raw: process.env });
const vault = createCredentialVault(backings.keyring);
// No sandbox and no key pair: the sweep runs nothing, it only reads and demotes. The handoff is the
// deps' shape and never used here — a sweep asks nobody anything.
const deps = createMcpDeps({
  db,
  connection: createConnectionDeps({ encrypt: vault.encrypt }),
  sandbox: null,
  keys: null,
  proxyPublicUrl: env.GRAFT_PROXY_PUBLIC_URL,
  handoff: {
    consoleUrl: env.GRAFT_CONSOLE_URL,
    secret: env.GRAFT_HANDOFF_SECRET,
    waitMs: env.GRAFT_APPROVAL_WAIT_SECONDS * 1000,
    ttlMs: env.GRAFT_PENDING_ACTION_TTL_HOURS * 60 * 60 * 1000,
  },
});

try {
  const report = await runSweep({ db }, deps, new Date(), { apply: !values.plan });
  console.log(JSON.stringify({ plan: values.plan, ...report }, null, 2));
} finally {
  deps.notifier?.close();
  deps.inFlight?.close();
  await db.close();
}
