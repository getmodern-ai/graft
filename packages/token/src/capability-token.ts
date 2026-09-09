import { randomUUID } from "node:crypto";

import type { CapabilityClaims, JsonWebKeySet, ProxyDeps, TokenVerdict } from "@graft/proxy/types";
import {
  type CryptoKey,
  calculateJwkThumbprint,
  errors,
  exportJWK,
  importPKCS8,
  importSPKI,
  jwtVerify,
  SignJWT,
} from "jose";

/**
 * The capability token (CONTEXT.md): a short-lived EdDSA (Ed25519) JWT the server mints once per
 * exec and the proxy verifies statelessly with the public key. The token, and not a lookup, is
 * what the proxy trusts (ADR 0007: the scope is where the security property lives, and the token
 * carries it). It rides in the per-process environment of the exec and never in the sandbox's
 * creation-time environment (GRA-1, "The proxy and the capability token"); the runner inside the
 * sandbox reads what it was handed and mints nothing. It is also the placeholder credential an SDK
 * is constructed with (ADR 0010), which is why the proxy accepts it wherever an SDK puts a key.
 *
 * Claims: `iss` "graft", `aud` "proxy", `person` the owner every connection is compared against,
 * `agent` the harness connection the exec ran for, `connections` the connection ids in reach for
 * this exec — at least one — `tool` the tool it was minted for, `exp`, `iat`, `jti`. There is
 * deliberately no `sub`: the token has two principals, and naming them as the glossary does reads
 * better than choosing one for the standard claim and inventing a name for the other. The proxy
 * compares `person` and `connections`; `agent`, `tool` and `jti` are for the wide event and for a
 * denylist, should revocation ever need to lag by less than a token lifetime. One optional claim,
 * `dryRun` (CONTEXT.md, *Dry run*): written only when the minter asks for a dry run, so a token
 * minted without it carries no such key at all, and read as `false` when absent.
 *
 * Copied from Cando's `capability-token.ts` (ADR 0011) and made pure on the way in: the keys are
 * an argument everywhere rather than read from the environment, so this package imports nothing
 * but jose and the proxy's types, and `apps/server` decides where a deployment's keys come from.
 * The types come from `@graft/proxy/types`, not the package index, so a consumer that wants the
 * claims does not pull the Hono app into its graph.
 */

export const CAPABILITY_TOKEN_ISSUER = "graft";
export const CAPABILITY_TOKEN_AUDIENCE = "proxy";
export const CAPABILITY_TOKEN_ALG = "EdDSA";

/**
 * The longest a token may live. A token is sized to the exec that carries it plus slack, which is
 * minutes; six hours is a bound against a bug minting one that is effectively perpetual, not an
 * expectation. Nothing re-mints inside an exec.
 */
export const MAX_CAPABILITY_TOKEN_TTL_SECONDS = 6 * 60 * 60;

/** Seconds of skew tolerated between the minting and verifying clocks — one host today, two later. */
const CLOCK_TOLERANCE_SECONDS = 5;

export type CapabilityTokenKeys = {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  /** RFC 7638 thumbprint of the public key; the JWT header's `kid` and the JWKS entry's. */
  kid: string;
};

export type MintCapabilityTokenInput = {
  personId: string;
  agentId: string;
  /** The connections in reach for this exec — the agent's scope, or the part of it the exec needs. */
  connectionIds: readonly string[];
  tool: string;
  ttlSeconds: number;
  /**
   * Mint for a dry run: the proxy forwards `GET`/`HEAD` and answers every other method with a
   * preview instead of sending it. Absent or false leaves the token exactly as before.
   */
  dryRun?: boolean;
};

/** Minting was asked of a deployment that has no key pair. */
export class CapabilityTokenUnconfiguredError extends Error {
  constructor() {
    super(
      "This deployment has no capability token key pair — set GRAFT_CAPABILITY_TOKEN_PRIVATE_KEY and GRAFT_CAPABILITY_TOKEN_PUBLIC_KEY",
    );
    this.name = "CapabilityTokenUnconfiguredError";
  }
}

/**
 * Both halves from PEM — PKCS#8 for the private key, SPKI for the public — which is what
 * `openssl genpkey -algorithm ed25519` emits and what jose imports. The pair is checked to be a
 * pair: a private key that does not match the public one would mint tokens nothing verifies,
 * discovered at the first vendor call rather than here.
 */
export async function importCapabilityTokenKeys(pem: {
  privateKeyPem: string;
  publicKeyPem: string;
}): Promise<CapabilityTokenKeys> {
  const [privateKey, publicKey] = await Promise.all([
    importPKCS8(pem.privateKeyPem, CAPABILITY_TOKEN_ALG),
    importCapabilityTokenPublicKey(pem.publicKeyPem),
  ]);
  const kid = await thumbprint(publicKey);
  const probe = await new SignJWT({})
    .setProtectedHeader({ alg: CAPABILITY_TOKEN_ALG })
    .sign(privateKey);
  try {
    await jwtVerify(probe, publicKey, { algorithms: [CAPABILITY_TOKEN_ALG] });
  } catch {
    throw new Error(
      "GRAFT_CAPABILITY_TOKEN_PRIVATE_KEY and GRAFT_CAPABILITY_TOKEN_PUBLIC_KEY are not a pair",
    );
  }
  return { privateKey, publicKey, kid };
}

export function importCapabilityTokenPublicKey(publicKeyPem: string): Promise<CryptoKey> {
  return importSPKI(publicKeyPem, CAPABILITY_TOKEN_ALG);
}

async function thumbprint(publicKey: CryptoKey): Promise<string> {
  return calculateJwkThumbprint(await exportJWK(publicKey));
}

/**
 * Mint. `ttlSeconds` is the exec's budget plus slack, bounded above; `now` is injectable so a test
 * can mint a token that is already expired without waiting for it to become so.
 */
export async function mintCapabilityToken(
  input: MintCapabilityTokenInput,
  keys: CapabilityTokenKeys,
  now: Date = new Date(),
): Promise<string> {
  for (const [name, value] of Object.entries({
    personId: input.personId,
    agentId: input.agentId,
    tool: input.tool,
  })) {
    if (typeof value !== "string" || value.trim() === "") {
      throw new Error(`capability token ${name} must be a non-empty string`);
    }
  }
  if (
    !Array.isArray(input.connectionIds) ||
    input.connectionIds.length === 0 ||
    input.connectionIds.some((id) => typeof id !== "string" || id.trim() === "")
  ) {
    throw new Error("capability token connectionIds must name at least one connection");
  }
  if (
    !Number.isInteger(input.ttlSeconds) ||
    input.ttlSeconds <= 0 ||
    input.ttlSeconds > MAX_CAPABILITY_TOKEN_TTL_SECONDS
  ) {
    throw new Error(
      `capability token ttlSeconds must be a whole number of seconds between 1 and ${MAX_CAPABILITY_TOKEN_TTL_SECONDS}`,
    );
  }

  const issuedAt = Math.floor(now.getTime() / 1000);
  return new SignJWT({
    person: input.personId,
    agent: input.agentId,
    connections: [...new Set(input.connectionIds)],
    tool: input.tool,
    // Present only when true — an ordinary token carries no `dryRun` key at all.
    ...(input.dryRun === true ? { dryRun: true } : {}),
  })
    .setProtectedHeader({ alg: CAPABILITY_TOKEN_ALG, kid: keys.kid, typ: "JWT" })
    .setIssuer(CAPABILITY_TOKEN_ISSUER)
    .setAudience(CAPABILITY_TOKEN_AUDIENCE)
    .setJti(randomUUID())
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + input.ttlSeconds)
    .sign(keys.privateKey);
}

/**
 * Verify. Three answers rather than a boolean, for the proxy's three refusals: `expired` when the
 * signature is good and only the clock disagrees; `invalid` for a bad signature, wrong issuer or
 * audience, malformed token or missing claim — one word for every one of those on purpose, so a
 * prober learns nothing about which check failed; `unconfigured` is the verifier's answer when
 * there is no key (`createCapabilityTokenVerifier`). The claims are shape-checked after jose accepts
 * them, because a token this function did not mint may be well-signed and still not say what the
 * proxy needs.
 */
export async function verifyCapabilityToken(
  token: string,
  publicKey: CryptoKey,
  now: Date = new Date(),
): Promise<TokenVerdict> {
  try {
    const { payload } = await jwtVerify(token, publicKey, {
      issuer: CAPABILITY_TOKEN_ISSUER,
      audience: CAPABILITY_TOKEN_AUDIENCE,
      algorithms: [CAPABILITY_TOKEN_ALG],
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
      currentDate: now,
      requiredClaims: ["person", "agent", "connections", "tool", "exp", "iat", "jti"],
    });
    const claims = toClaims(payload);
    return claims ? { ok: true, claims } : { ok: false, reason: "invalid" };
  } catch (error) {
    if (error instanceof errors.JWTExpired) return { ok: false, reason: "expired" };
    return { ok: false, reason: "invalid" };
  }
}

function toClaims(payload: Record<string, unknown>): CapabilityClaims | null {
  const { person, agent, connections, tool, jti, exp, dryRun } = payload;
  if (
    typeof person !== "string" ||
    typeof agent !== "string" ||
    !Array.isArray(connections) ||
    connections.length === 0 ||
    connections.some((id) => typeof id !== "string" || id === "") ||
    typeof tool !== "string" ||
    typeof jti !== "string" ||
    typeof exp !== "number" ||
    // Optional, but when present it must be the boolean this library writes: a well-signed token
    // saying `dryRun: "yes"` is not one we minted, and is refused like any other malformed claim.
    (dryRun !== undefined && typeof dryRun !== "boolean")
  ) {
    return null;
  }
  return {
    person,
    agent,
    connections: connections as string[],
    tool,
    jti,
    exp,
    dryRun: dryRun === true,
  };
}

/**
 * The verification key as an RFC 7517 key set — what the proxy serves at
 * `/.well-known/jwks.json`, so a later standalone proxy verifies the same way.
 */
export async function capabilityTokenJwks(publicKey: CryptoKey): Promise<JsonWebKeySet> {
  const jwk = await exportJWK(publicKey);
  return {
    keys: [{ ...jwk, kid: await thumbprint(publicKey), alg: CAPABILITY_TOKEN_ALG, use: "sig" }],
  };
}

/**
 * The two `ProxyDeps` a host binds from its keys — or from none. A deployment without a key pair
 * boots, and the proxy answers 503 `proxy_unconfigured` to every call and to the JWKS route, rather
 * than looking like every token is bad.
 */
export function createCapabilityTokenVerifier(
  keys: CapabilityTokenKeys | null,
): Pick<ProxyDeps, "verifyToken" | "jwks"> {
  return {
    verifyToken: (token) =>
      keys
        ? verifyCapabilityToken(token, keys.publicKey)
        : Promise.resolve({ ok: false, reason: "unconfigured" }),
    jwks: () => (keys ? capabilityTokenJwks(keys.publicKey) : Promise.resolve(null)),
  };
}
