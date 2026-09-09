import { readFile } from "node:fs/promises";

import { createAuth } from "@graft/auth";
import { createConnectionDeps, defaultAgentDeps } from "@graft/core";
import { createDb } from "@graft/db";
import { env } from "@graft/env/server";
import { importCapabilityTokenKeys } from "@graft/token";
import { createFilesystemToolboxStore } from "@graft/toolbox";
import { createCredentialVault } from "@graft/vault";
import { serve } from "@hono/node-server";
import { initLogger } from "evlog";

import { API_MOUNT_PATH, createServer, PROXY_MOUNT_PATH } from "./app";
import { selectBackings } from "./backings";
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

// The three seams' backings, chosen once from `GRAFT_BACKINGS` (`backings.ts`, ADR 0002). The keyring
// goes under the vault here; the sandbox and the mirror are the publish's, which GRA-19 wires over
// MCP, and the boot line below says whether a sandbox backing is configured at all.
const store = createFilesystemToolboxStore({ root: env.GRAFT_TOOLBOX_ROOT });
const backings = await selectBackings(env, { store, raw: process.env });
const vault = createCredentialVault(backings.keyring);

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
    // The vault's encrypt half is all the connection service may hold (GRA-1: decrypted in exactly
    // one component, and that component is the proxy binding in `app.ts`).
    deps: {
      db,
      agent: defaultAgentDeps,
      connection: createConnectionDeps({ encrypt: vault.encrypt }),
    },
    corsOrigins: env.GRAFT_CORS_ORIGIN,
  },
});

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(
    `graft server listening on http://localhost:${info.port} — proxy at ${PROXY_MOUNT_PATH}, ` +
      `auth and the JSON API at ${API_MOUNT_PATH}, ` +
      `key pair ${keys ? "configured" : "absent (proxy answers 503)"}, ` +
      `${backings.form} backings (keyring ${backings.keyring.id}, sandbox ${backings.sandbox ? "configured" : "absent"}), ` +
      `${seededCount} connection(s) seeded over the database`,
  );
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    db.close().finally(() => process.exit(0));
  });
}
