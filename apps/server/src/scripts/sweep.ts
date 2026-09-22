import { parseArgs } from "node:util";

import { createConnectionDeps } from "@graft/core";
import { createDb } from "@graft/db";
import { env } from "@graft/env/server";
import { createMcpDeps, runSweep } from "@graft/mcp";
import { createCredentialVault } from "@graft/vault";

import { selectBackings } from "../backings";

/**
 * Run one sweep by hand and print the report (ADR 0009; `@graft/mcp`'s `runSweep`): the
 * working-set pass and, since GRA-189, the blob pass beside it (ADR 0023), whose actions are the
 * report's `blobs.actions`, over every agent with blobs, revoked ones included (GRA-195).
 *
 *   pnpm --filter @graft/server sweep            # demote, remove, mark and adopt what the rules say
 *   pnpm --filter @graft/server sweep -- --plan  # print what it would do; change nothing
 *
 * Reads the environment the server does. Two things this process cannot do that the server's own
 * sweep can: it has no sessions to notify, so a running server's harnesses learn of a demotion at
 * their next `tools/list` rather than from `tools/list_changed`; and it has no view of that server's
 * in-flight registry, so it cannot skip an agent with a run in flight, and a run in flight may be
 * writing a blob, whose `.tmp` this process would judge by age alone. With a server up, prefer
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
// No sandbox and no key pair: the sweep runs nothing, it only reads, demotes and removes. The blob
// store is the form's, the same tree the server's sweep reads. The handoff is the deps' shape and
// never used here, since a sweep asks nobody anything.
const deps = createMcpDeps({
  db,
  connection: createConnectionDeps({ encrypt: vault.encrypt }),
  sandbox: null,
  keys: null,
  blobStore: backings.blobStore,
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
