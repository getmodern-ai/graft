import { readFile } from "node:fs/promises";

import { env } from "@graft/env/server";
import { importCapabilityTokenKeys } from "@graft/token";
import { createCredentialVault, createLocalKeyring } from "@graft/vault";
import { serve } from "@hono/node-server";
import { initLogger } from "evlog";

import { createServer, PROXY_MOUNT_PATH } from "./app";
import { connectionSeeds, createInMemoryConnections, seedConnections } from "./connections";

/**
 * The server's boot: validated environment in, one listening process out. Everything it decides
 * here is a value `createServer` is handed, so the app itself never reads the environment.
 *
 * No database yet — the connection store is in memory and seeded from `GRAFT_DEV_SEED` when set
 * (GRA-6 brings the table). To run the proxy on a laptop:
 *
 *   pnpm --filter @graft/server keys  >> apps/server/.env    # a key pair and a keyring secret
 *   echo 'GRAFT_DEV_SEED=./dev-seed.json' >> apps/server/.env
 *   pnpm --filter @graft/server dev
 *   pnpm --filter @graft/server mint -- --person p --agent a --connections <id>   # a token
 *
 * `dev-seed.json` is an array of `connectionSeed`s (`connections.ts`); `.env` and the seed are
 * gitignored, and both are refused under `NODE_ENV=production`.
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

const connections = createInMemoryConnections();
if (env.GRAFT_DEV_SEED) {
  const seeds = connectionSeeds.parse(JSON.parse(await readFile(env.GRAFT_DEV_SEED, "utf8")));
  await seedConnections(connections, vault, seeds);
}

const app = createServer({
  keys,
  vault,
  connections,
  followRedirects: env.GRAFT_PROXY_FOLLOW_REDIRECTS,
});

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(
    `graft server listening on http://localhost:${info.port} — proxy at ${PROXY_MOUNT_PATH}, ` +
      `key pair ${keys ? "configured" : "absent (proxy answers 503)"}, ` +
      `${connections.ids().length} connection(s) seeded`,
  );
});
