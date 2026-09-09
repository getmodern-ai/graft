import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { createAuth } from "@graft/auth";
import {
  createConnectionDeps,
  defaultAgentDeps,
  defaultToolDeps,
  defaultWorkingSetDeps,
} from "@graft/core";
import { createDb } from "@graft/db";
import { env } from "@graft/env/server";
import { createMcpDeps } from "@graft/mcp";
import {
  createPublishDeps,
  createRegistryMetadataSource,
  DEFAULT_PACKAGE_POLICY,
} from "@graft/publish";
import {
  createFakeSandboxBackend,
  type SandboxBackend,
  type SandboxProcessResult,
} from "@graft/sandbox";
import { createDockerSandboxBackend } from "@graft/sandbox-docker";
import { importCapabilityTokenKeys } from "@graft/token";
import { createFilesystemToolboxStore, createNoopToolboxMirror } from "@graft/toolbox";
import { createCredentialVault, createLocalKeyring } from "@graft/vault";
import { serve } from "@hono/node-server";
import { initLogger } from "evlog";

import { API_MOUNT_PATH, createServer, MCP_MOUNT_PATH, PROXY_MOUNT_PATH } from "./app";
import {
  connectionSeeds,
  createDatabaseConnections,
  createInMemoryConnections,
  layerConnections,
  seedConnections,
} from "./connections";

/**
 * The server's boot: validated environment in, one listening process out. Everything it decides
 * here is a value `createServer` is handed, so the app itself never reads the environment.
 *
 * To run it on a laptop:
 *
 *   pnpm run db:start                                        # Postgres 18 in Docker, port 5432
 *   pnpm --filter @graft/server keys >> apps/server/.env     # a key pair, a keyring secret, an auth secret
 *   cat >> apps/server/.env <<'EOF'
 *   GRAFT_DATABASE_URL=postgresql://postgres:password@localhost:5432/graft
 *   GRAFT_AUTH_URL=http://localhost:3000
 *   GRAFT_CORS_ORIGIN=http://localhost:3001
 *   EOF
 *   pnpm run db:migrate                                      # or db:push while the schema is moving
 *   pnpm --filter @graft/server dev
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

// The local keyring is the one backing this repository holds (ADR 0002); the hosted form's KMS
// keyring arrives with the private package (GRA-20) and is selected here.
const vault = createCredentialVault(createLocalKeyring(env.GRAFT_KEYRING_SECRET));

// One pool for the process; the migrations are applied separately (`pnpm run db:migrate`), so a
// server never alters the schema it is about to serve.
const db = createDb(env.GRAFT_DATABASE_URL);

const auth = createAuth({
  db,
  secret: env.GRAFT_AUTH_SECRET,
  baseURL: env.GRAFT_AUTH_URL,
  trustedOrigins: env.GRAFT_CORS_ORIGIN,
});

let connections = createDatabaseConnections(db);
let seededCount = 0;
if (env.GRAFT_DEV_SEED) {
  const seeded = createInMemoryConnections();
  const seeds = connectionSeeds.parse(JSON.parse(await readFile(env.GRAFT_DEV_SEED, "utf8")));
  await seedConnections(seeded, vault, seeds);
  seededCount = seeded.ids().length;
  connections = layerConnections(seeded, connections);
}

// The vault's encrypt half is all the connection service may hold (GRA-1: decrypted in exactly
// one component, and that component is the proxy binding in `app.ts`).
const connectionDeps = createConnectionDeps({ encrypt: vault.encrypt });

/**
 * The sandbox backing (ADR 0002) and the toolbox store, which have to see one tree
 * (`packages/toolbox/README.md`): with Docker the store's root is bound into every toolbox volume;
 * with the fake the store sits inside the fake's own temporary directory, so a laptop's toolbox lives
 * as long as the process. Docker without its image and network is no backing at all — the server
 * boots, every run refuses saying so, and the install step answers the publish the same way. The
 * fake is refused in production by `@graft/env`. The Docker backing reads `DOCKER_HOST` itself.
 */
let sandbox: SandboxBackend | null;
let toolboxRoot: string;
if (env.GRAFT_SANDBOX_BACKEND === "fake") {
  const fake = createFakeSandboxBackend();
  sandbox = fake;
  toolboxRoot = join(fake.root, "toolboxes");
} else {
  toolboxRoot = env.GRAFT_TOOLBOX_ROOT;
  sandbox =
    env.GRAFT_SANDBOX_IMAGE && env.GRAFT_SANDBOX_NETWORK
      ? createDockerSandboxBackend({
          image: env.GRAFT_SANDBOX_IMAGE,
          network: env.GRAFT_SANDBOX_NETWORK,
          toolboxHostRoot: toolboxRoot,
        })
      : null;
}
const store = createFilesystemToolboxStore({ root: toolboxRoot });

const publish = createPublishDeps({
  db,
  store,
  mirror: createNoopToolboxMirror(),
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

const app = createServer({
  keys,
  vault,
  connections,
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
    },
    corsOrigins: env.GRAFT_CORS_ORIGIN,
  },
  // What a sandbox is handed as `GRAFT_PROXY_URL` is the proxy's public URL, so relocating the proxy
  // stays the DNS change GRA-1 promises.
  mcp: createMcpDeps({
    db,
    connection: connectionDeps,
    sandbox,
    keys,
    proxyPublicUrl: env.GRAFT_PROXY_PUBLIC_URL,
    publish,
  }),
});

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(
    `graft server listening on http://localhost:${info.port} — proxy at ${PROXY_MOUNT_PATH}, ` +
      `auth and the JSON API at ${API_MOUNT_PATH}, MCP at ${MCP_MOUNT_PATH} ` +
      `(sandbox: ${env.GRAFT_SANDBOX_BACKEND}${sandbox ? "" : ", unconfigured"}; toolbox: ${store.root}), ` +
      `key pair ${keys ? "configured" : "absent (proxy answers 503)"}, ` +
      `${seededCount} connection(s) seeded over the database`,
  );
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    db.close().finally(() => process.exit(0));
  });
}
