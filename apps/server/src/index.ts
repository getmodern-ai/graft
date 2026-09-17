import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { createAuth, SOCIAL_PROVIDER_NAMES } from "@graft/auth";
import {
  createConnectionDeps,
  createModelKeyDeps,
  defaultAgentDeps,
  defaultApprovalDeps,
  defaultLedgerDeps,
  defaultMcpOAuthDeps,
  defaultPendingActionDeps,
  defaultToolDeps,
  defaultWorkingSetDeps,
  oauthRedirectUri,
  protectedResourceMetadataUrl,
} from "@graft/core";
import { createDb } from "@graft/db";
import { applyMigrations, MIGRATIONS_DIR } from "@graft/db/migrate";
import { checkMigrationChain, readMigrationChain } from "@graft/db/migration-chain";
import { countPersons } from "@graft/db/repo/person";
import { signInProvidersFrom } from "@graft/env/schema";
import { env } from "@graft/env/server";
import { createAcquireRunner, createMcpDeps, startSweep } from "@graft/mcp";
import {
  createPublishDeps,
  createRegistryMetadataSource,
  DEFAULT_PACKAGE_POLICY,
} from "@graft/publish";
import type { SandboxProcessResult } from "@graft/sandbox";
import { importCapabilityTokenKeys } from "@graft/token";
import { createCredentialVault } from "@graft/vault";
import { serve } from "@hono/node-server";
import { initLogger } from "evlog";

import { API_MOUNT_PATH, createServer, MCP_MOUNT_PATH, PROXY_MOUNT_PATH } from "./app";
import { selectBackings } from "./backings";
import { bootstrapAdmin, MigrationChainBrokenError, migrateOnStart } from "./boot";
import {
  connectionSeeds,
  createDatabaseConnections,
  createDatabaseCredentialRotation,
  createInMemoryConnections,
  layerConnections,
  seedConnections,
} from "./connections";
import { createModel } from "./model";

/**
 * The server's boot: validated environment in, one listening process out. Everything it decides
 * here is a value `createServer` is handed, so the app itself never reads the environment.
 *
 * To run it on a laptop:
 *
 *   pnpm run db:start                                        # Postgres 18 in Docker, port 5432
 *   pnpm --filter @graft/server keys >> apps/server/.env     # a key pair, a keyring, an auth and a handoff secret
 *   cat >> apps/server/.env <<'EOF'
 *   GRAFT_DATABASE_URL=postgresql://postgres:password@localhost:5432/graft
 *   GRAFT_AUTH_URL=http://localhost:3000
 *   GRAFT_CORS_ORIGIN=http://localhost:3001
 *   GRAFT_CONSOLE_URL=http://localhost:3001
 *   EOF
 *   pnpm --filter @graft/server dev                          # migrates on start; GRAFT_MIGRATE_ON_START=false with db:push
 *
 * The self-hosted image runs this same file (`apps/server/Dockerfile`, GRA-33): `docker compose up`
 * is the recipe above with every value in the compose file, and `boot.ts` is the two steps the
 * image adds before it listens — the committed migrations, then the admin from `GRAFT_ADMIN_EMAIL`
 * and `GRAFT_ADMIN_PASSWORD` when the database holds nobody yet.
 *
 * Connections come from the database; `GRAFT_DEV_SEED=./dev-seed.json` layers a file of seeded
 * connections over it for a proxy smoke test without a console (`connections.ts` has the shape).
 * `.env` and the seed are gitignored, and the seed is refused under `NODE_ENV=production`.
 */

initLogger({ env: { service: "graft-server", environment: env.NODE_ENV } });

/**
 * The key pair is imported here, at boot, so a mis-pasted PEM fails the process with a sentence
 * rather than the first vendor call: `@graft/env` checks each key's shape, this checks that the two
 * are a pair. A deployment with no pair boots and the proxy answers 503 `proxy_unconfigured`.
 */
const keys =
  env.GRAFT_CAPABILITY_TOKEN_PRIVATE_KEY && env.GRAFT_CAPABILITY_TOKEN_PUBLIC_KEY
    ? await importCapabilityTokenKeys({
        privateKeyPem: env.GRAFT_CAPABILITY_TOKEN_PRIVATE_KEY,
        publicKeyPem: env.GRAFT_CAPABILITY_TOKEN_PUBLIC_KEY,
      })
    : null;

// The four seams' backings and the toolbox store, chosen once from `GRAFT_BACKINGS` and
// `GRAFT_SANDBOX_BACKEND` (`backings.ts`, ADR 0002). The keyring goes under the vault here; the
// sandbox, the store and the mirror are the publish's and the MCP server's below; the connection
// providers (ADR 0019) go to the connection service and to the proxy's connection read.
const backings = await selectBackings(env, { raw: process.env });
const { sandbox, store, providers } = backings;
const vault = createCredentialVault(backings.keyring);

// One pool for the process.
const db = createDb(env.GRAFT_DATABASE_URL);

/**
 * The committed migrations, applied before anything reads the schema (`boot.ts`; GRA-33). The chain
 * is checked for holes first and a hole refuses the start with the problems listed; a database that
 * cannot be reached refuses it with pg's reason and never the URL, which carries the password. Off
 * with `GRAFT_MIGRATE_ON_START=false` for a schema moved by `db:push`.
 */
if (env.GRAFT_MIGRATE_ON_START) {
  try {
    await migrateOnStart({
      readChain: () => readMigrationChain(MIGRATIONS_DIR),
      checkChain: checkMigrationChain,
      apply: () => applyMigrations(db),
      log: console.log,
    });
  } catch (error) {
    const reason =
      error instanceof MigrationChainBrokenError
        ? error.message
        : `the database at GRAFT_DATABASE_URL could not be migrated: ${error instanceof Error ? error.message : String(error)}`;
    console.error(`graft refused to start: ${reason}`);
    process.exit(1);
  }
}

// The providers a person may sign in with beside email and password (GRA-81, ADR 0020): a key per
// complete `GRAFT_GOOGLE_*` / `GRAFT_GITHUB_*` group, and the door lists exactly these.
const signInProviders = signInProvidersFrom(env);
const signInMethods = {
  social: SOCIAL_PROVIDER_NAMES.filter((name) => signInProviders[name] !== undefined),
};

const auth = createAuth({
  db,
  secret: env.GRAFT_AUTH_SECRET,
  baseURL: env.GRAFT_AUTH_URL,
  trustedOrigins: env.GRAFT_CORS_ORIGIN,
  socialProviders: signInProviders,
});

// The one admin a fresh self-hosted database opens with (`boot.ts`): through Better Auth's own
// sign-up, only while the database holds nobody, and a no-op on a laptop that never set the pair.
await bootstrapAdmin(
  env.GRAFT_ADMIN_EMAIL && env.GRAFT_ADMIN_PASSWORD
    ? { email: env.GRAFT_ADMIN_EMAIL, password: env.GRAFT_ADMIN_PASSWORD }
    : null,
  {
    countPersons: () => countPersons(db),
    signUp: async (input) => {
      await auth.api.signUpEmail({ body: input });
    },
    log: console.log,
  },
);

let connections = createDatabaseConnections(db, providers);
let seededCount = 0;
if (env.GRAFT_DEV_SEED) {
  const seeded = createInMemoryConnections();
  const seeds = connectionSeeds.parse(JSON.parse(await readFile(env.GRAFT_DEV_SEED, "utf8")));
  await seedConnections(seeded, vault, seeds);
  seededCount = seeded.ids().length;
  connections = layerConnections(seeded, connections);
}

// The vault's encrypt half is all the connection service may hold (GRA-1: decrypted in exactly
// one component, and that component is the proxy binding in `app.ts`). The providers ride beside
// it: what a registration names, what a proposal is routed through (ADR 0019).
const connectionDeps = createConnectionDeps({ encrypt: vault.encrypt }, providers);

/**
 * A person's own model key takes the same encrypt-only half on its request path (`@graft/core`'s
 * `ModelKeyDeps`); the decrypt goes to the model resolver alone (`model.ts`), which is the second
 * and last place on this server a stored secret becomes plaintext, after the proxy binding.
 */
const modelKeyDeps = createModelKeyDeps({ encrypt: vault.encrypt });

/**
 * Which model answers `acquire` (ADR 0004, ADR 0014; `model.ts`): the deployment's fixed model from
 * `GRAFT_MODEL_BACKEND`, a person's own key routed in front of it, Langfuse on when its pair is set.
 * `@graft/env` has already refused a self-hosted production boot without a provider and a key.
 */
const modelSetup = await createModel({
  env,
  db,
  decrypt: vault.decrypt,
  modelKey: modelKeyDeps,
  onRoute: (route) => {
    if (route.source === "person") {
      console.log(
        `acquire job ${route.jobId}: routed to the person's own model (${route.adapter})`,
      );
    }
  },
});

const publish = createPublishDeps({
  db,
  store,
  mirror: backings.mirror,
  sandbox: sandbox ?? {
    install: async (): Promise<SandboxProcessResult> => {
      const logs =
        "no sandbox backing is configured: set GRAFT_SANDBOX_IMAGE and GRAFT_SANDBOX_NETWORK to run the install step (packages/sandbox-docker/README.md)";
      return { status: "failed", exitCode: null, logs, stdout: "", stderr: logs };
    },
  },
  metadata: createRegistryMetadataSource(),
  policy: {
    allowlist: [...DEFAULT_PACKAGE_POLICY.allowlist, ...env.GRAFT_PACKAGE_ALLOWLIST],
    minAgeDays: env.GRAFT_PACKAGE_MIN_AGE_DAYS,
    minWeeklyDownloads: env.GRAFT_PACKAGE_MIN_WEEKLY_DOWNLOADS,
  },
});

/**
 * The handoff (ADR 0006): where the console answers, what signs the link, how long a call waits for
 * the person and how long the pending action outlives the call. Built once, because the API's card
 * and the MCP server's ask have to agree on the URL and the mark.
 */
const handoff = {
  consoleUrl: env.GRAFT_CONSOLE_URL,
  secret: env.GRAFT_HANDOFF_SECRET,
  waitMs: env.GRAFT_APPROVAL_WAIT_SECONDS * 1000,
  ttlMs: env.GRAFT_PENDING_ACTION_TTL_HOURS * 60 * 60 * 1000,
};

/**
 * One `McpDeps` for the endpoint and the sweep. What a sandbox is handed as `GRAFT_PROXY_URL` is the
 * proxy's public URL, so relocating the proxy stays the DNS change GRA-1 promises. The notifier and
 * the in-flight registry inside are the process's one of each: the sweep's `tools/list_changed`
 * reaches the endpoint's sessions, and the endpoint's runs hold the sweep off (ADR 0003, ADR 0009).
 */
const mcp = createMcpDeps({
  db,
  connection: connectionDeps,
  sandbox,
  keys,
  proxyPublicUrl: env.GRAFT_PROXY_PUBLIC_URL,
  publish,
  handoff,
  // What the agent tells the person to paste into the OAuth client they register (ADR 0005) — the
  // same value `GET /api/oauth/redirect-uri` shows and `GET /api/oauth/callback` serves.
  oauthRedirectUri: oauthRedirectUri(env.GRAFT_AUTH_URL),
  // The 401's discovery hint (ADR 0018): where the endpoint's protected resource metadata answers.
  resourceMetadataUrl: protectedResourceMetadataUrl(env.GRAFT_AUTH_URL),
  model: modelSetup.model,
  acquire: {
    maxAttempts: env.GRAFT_ACQUIRE_MAX_ATTEMPTS,
    tokenCeiling: env.GRAFT_ACQUIRE_TOKEN_CEILING,
  },
});

/**
 * The `acquire` job runner (GRA-29; `@graft/mcp`'s `acquire/runner.ts`), the second plain scheduler
 * in the process beside the sweep: the meta-tool kicks it as a job is queued, the poll picks up what
 * a previous process left. On the deps so the meta-tool can reach it; started once the app exists.
 */
const acquireRunner = createAcquireRunner(mcp, {
  concurrency: env.GRAFT_ACQUIRE_CONCURRENCY,
  onEvent: (event) => {
    if (event.kind === "claimed") {
      console.log(
        `acquire: job ${event.jobId} for agent ${event.agentId} ${event.resumed ? "resumed" : "started"}`,
      );
    } else if (event.kind === "finished") {
      const cause = event.failure ? ` (${event.failure})` : "";
      console.log(`acquire: job ${event.jobId} for agent ${event.agentId} ${event.status}${cause}`);
    } else {
      console.error(
        `acquire: job ${event.jobId} for agent ${event.agentId} failed: ${event.error}`,
      );
    }
  },
  onError: (error) => console.error("acquire runner tick failed", error),
});
mcp.acquireRunner = acquireRunner;

/**
 * Graft as the authorization server for its own MCP endpoint (ADR 0018): the issuer is
 * `GRAFT_AUTH_URL`'s origin, the consent page is the console's, and no variable is added — the
 * two URLs every deployment already sets are the two this needs. One object, because the protocol's
 * endpoints (`createServer`) and the console's consent routes (`api.mcpOAuth`) must agree on all of it.
 */
const mcpOAuth = {
  db,
  deps: defaultMcpOAuthDeps,
  agent: defaultAgentDeps,
  authUrl: env.GRAFT_AUTH_URL,
  consoleUrl: env.GRAFT_CONSOLE_URL,
};

const app = createServer({
  keys,
  vault,
  connections,
  // An authorization-code token the proxy refreshes goes back into the row it came from (ADR 0005).
  credentialRotation: createDatabaseCredentialRotation(db, connectionDeps),
  followRedirects: env.GRAFT_PROXY_FOLLOW_REDIRECTS,
  api: {
    auth: {
      handler: (request) => auth.handler(request),
      getSession: (headers) => auth.api.getSession({ headers }),
    },
    deps: {
      db,
      agent: defaultAgentDeps,
      connection: connectionDeps,
      workingSet: defaultWorkingSetDeps,
      tool: defaultToolDeps,
      ledger: defaultLedgerDeps,
      approval: defaultApprovalDeps,
      pendingAction: defaultPendingActionDeps,
      modelKey: modelKeyDeps,
    },
    corsOrigins: env.GRAFT_CORS_ORIGIN,
    signInMethods,
    handoff,
    // The consent's two ends (`oauth.ts`): the redirect URI on this server's origin, and the one
    // decrypt outside the proxy binding — the client secret, for the code exchange.
    oauth: { authUrl: env.GRAFT_AUTH_URL, decrypt: vault.decrypt },
    mcpOAuth,
    // A link provider's return route answers on this origin too (`provider-link.ts`, ADR 0019).
    authUrl: env.GRAFT_AUTH_URL,
  },
  mcpOAuth,
  // The console's build, served from the same origin as the API (`console.ts`); absent, the API is
  // whole and every console path says where the build was expected.
  console: { dir: env.GRAFT_CONSOLE_DIR },
  mcp,
});

/**
 * The working-set sweep (ADR 0009) on a plain timer — GRA-1's "no durable engine for the alpha". A
 * sweep that demoted something, or failed for some agent, is one log line; a quiet one is silent.
 */
const sweep = startSweep(mcp, {
  intervalSeconds: env.GRAFT_SWEEP_INTERVAL_SECONDS,
  onReport: (report) => {
    if (report.demoted.length === 0 && report.failed.length === 0) return;
    const skipped =
      report.skipped.length > 0 ? `, ${report.skipped.length} skipped for a run in flight` : "";
    const failed =
      report.failed.length > 0
        ? `, ${report.failed.length} failed: ${report.failed.map((f) => `${f.agentId} (${f.error})`).join("; ")}`
        : "";
    console.log(
      `working-set sweep: ${report.demoted.length} demotion(s) across ${report.agents} agent(s)${skipped}${failed}`,
    );
  },
  onError: (error) => console.error("working-set sweep failed", error),
});

acquireRunner.start();

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(
    `graft server listening on http://localhost:${info.port} — proxy at ${PROXY_MOUNT_PATH}, ` +
      `auth and the JSON API at ${API_MOUNT_PATH}, MCP at ${MCP_MOUNT_PATH} (OAuth issuer ${env.GRAFT_AUTH_URL}) ` +
      `(${backings.form} backings — sandbox ${sandbox ? "configured" : "unconfigured"}, ` +
      `keyring ${backings.keyring.id}, providers ${providers.map((provider) => provider.name).join(", ")}, ` +
      `sign-in ${["email", ...signInMethods.social].join(", ")}, ` +
      `toolbox ${backings.toolboxRoot ?? "held by the cloud backings"}), ` +
      `key pair ${keys ? "configured" : "absent (proxy answers 503)"}, ` +
      `${seededCount} connection(s) seeded over the database, ` +
      `working-set sweep every ${env.GRAFT_SWEEP_INTERVAL_SECONDS}s, ` +
      modelSetup.summary +
      `, acquire runner: ${env.GRAFT_ACQUIRE_CONCURRENCY} job(s) at once, ` +
      `console ${existsSync(join(env.GRAFT_CONSOLE_DIR, "index.html")) ? `served from ${env.GRAFT_CONSOLE_DIR}` : `not built at ${env.GRAFT_CONSOLE_DIR} (console paths answer 404)`}`,
  );
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    sweep.stop();
    acquireRunner.stop();
    mcp.notifier?.close();
    mcp.inFlight?.close();
    // The last job's spans are still buffered; a stop that skipped this would lose them.
    Promise.allSettled([modelSetup.langfuse?.flush()])
      .then(() => db.close())
      .finally(() => process.exit(0));
  });
}
