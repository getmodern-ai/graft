import { randomBytes } from "node:crypto";

import { CAPABILITY_TOKEN_ALG } from "@graft/token";
import { exportPKCS8, exportSPKI, generateKeyPair } from "jose";

/**
 * A fresh Ed25519 key pair, a keyring secret, an auth secret and a handoff secret, printed as `.env` lines:
 *
 *   pnpm --filter @graft/server keys >> apps/server/.env
 *
 * The PEMs are `\n`-escaped inside double quotes, which is the one spelling a `.env` file can hold
 * and one `@graft/env` accepts. Each secret is 32 URL-safe characters — the minimum
 * `GRAFT_KEYRING_SECRET`, `GRAFT_AUTH_SECRET` and `GRAFT_HANDOFF_SECRET` allow — and they are three
 * secrets because they guard three things and rotate independently. For a deployment, generate the pair with `openssl genpkey
 * -algorithm ed25519` and keep the private half in a secret store; this script is for a laptop.
 */

const pair = await generateKeyPair(CAPABILITY_TOKEN_ALG, { crv: "Ed25519", extractable: true });
const escaped = (pem: string) => pem.trim().replace(/\n/g, "\\n");

console.log(`GRAFT_KEYRING_SECRET=${randomBytes(24).toString("base64url")}`);
console.log(`GRAFT_AUTH_SECRET=${randomBytes(24).toString("base64url")}`);
console.log(`GRAFT_HANDOFF_SECRET=${randomBytes(24).toString("base64url")}`);
console.log(`GRAFT_CAPABILITY_TOKEN_PRIVATE_KEY="${escaped(await exportPKCS8(pair.privateKey))}"`);
console.log(`GRAFT_CAPABILITY_TOKEN_PUBLIC_KEY="${escaped(await exportSPKI(pair.publicKey))}"`);
