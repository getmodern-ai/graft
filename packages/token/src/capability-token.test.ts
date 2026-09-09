import {
  decodeJwt,
  decodeProtectedHeader,
  exportPKCS8,
  exportSPKI,
  generateKeyPair,
  SignJWT,
} from "jose";
import { describe, expect, it } from "vitest";

import {
  CAPABILITY_TOKEN_ALG,
  type CapabilityTokenKeys,
  capabilityTokenJwks,
  createCapabilityTokenVerifier,
  importCapabilityTokenKeys,
  MAX_CAPABILITY_TOKEN_TTL_SECONDS,
  mintCapabilityToken,
  verifyCapabilityToken,
} from "./capability-token";

/**
 * Mint and verify over a key pair generated for the test — the token CONTEXT.md describes, with the
 * claims and the expiry asserted rather than assumed. The PEM round trip mirrors how a deployment
 * gets its keys: `openssl genpkey` emits PKCS#8 and SPKI, and `@graft/env` hands them to the server
 * as strings.
 */

async function testKeys(): Promise<CapabilityTokenKeys> {
  const pair = await generateKeyPair(CAPABILITY_TOKEN_ALG, { crv: "Ed25519", extractable: true });
  return importCapabilityTokenKeys({
    privateKeyPem: await exportPKCS8(pair.privateKey),
    publicKeyPem: await exportSPKI(pair.publicKey),
  });
}

const INPUT = {
  personId: "person_1",
  agentId: "agent_1",
  connectionIds: ["conn_1", "conn_2"],
  tool: "execute",
  ttlSeconds: 300,
};

/** A well-signed token with whatever claims a test wants — what our own minter would never write. */
function foreign(keys: CapabilityTokenKeys, claims: Record<string, unknown>) {
  return new SignJWT({
    person: "person_1",
    agent: "agent_1",
    connections: ["conn_1"],
    tool: "t",
    ...claims,
  })
    .setProtectedHeader({ alg: "EdDSA" })
    .setIssuer("graft")
    .setAudience("proxy")
    .setJti("j")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(keys.privateKey);
}

describe("capability token", () => {
  it("round-trips: what was minted is what verifies", async () => {
    const keys = await testKeys();
    const token = await mintCapabilityToken(INPUT, keys);

    const verdict = await verifyCapabilityToken(token, keys.publicKey);
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.claims).toMatchObject({
      person: "person_1",
      agent: "agent_1",
      connections: ["conn_1", "conn_2"],
      tool: "execute",
      dryRun: false,
    });
    expect(verdict.claims.jti).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("carries the documented claims and header, and no sub", async () => {
    const keys = await testKeys();
    const now = new Date("2026-09-09T10:00:00Z");
    const token = await mintCapabilityToken(INPUT, keys, now);

    expect(decodeProtectedHeader(token)).toEqual({ alg: "EdDSA", kid: keys.kid, typ: "JWT" });
    const claims = decodeJwt(token);
    const issuedAt = Math.floor(now.getTime() / 1000);
    expect(claims).toMatchObject({
      iss: "graft",
      aud: "proxy",
      person: "person_1",
      agent: "agent_1",
      connections: ["conn_1", "conn_2"],
      tool: "execute",
      iat: issuedAt,
      exp: issuedAt + 300,
    });
    expect(claims).not.toHaveProperty("sub");
    expect(typeof claims.jti).toBe("string");
  });

  it("names each connection once, however the input repeated it", async () => {
    const keys = await testKeys();
    const token = await mintCapabilityToken(
      { ...INPUT, connectionIds: ["conn_1", "conn_1", "conn_2"] },
      keys,
    );
    expect(decodeJwt(token).connections).toEqual(["conn_1", "conn_2"]);
  });

  /** The dry-run claim: present only when asked for, read as false when absent. */
  describe("the dry-run claim", () => {
    it("round-trips through mint and verify", async () => {
      const keys = await testKeys();
      const token = await mintCapabilityToken({ ...INPUT, dryRun: true }, keys);

      expect(decodeJwt(token)).toMatchObject({ dryRun: true, tool: "execute" });
      const verdict = await verifyCapabilityToken(token, keys.publicKey);
      expect(verdict.ok).toBe(true);
      if (!verdict.ok) return;
      expect(verdict.claims.dryRun).toBe(true);
    });

    it("is absent from an ordinary token, which verifies as before with dryRun false", async () => {
      const keys = await testKeys();
      for (const input of [INPUT, { ...INPUT, dryRun: false }]) {
        const token = await mintCapabilityToken(input, keys);

        expect(decodeJwt(token)).not.toHaveProperty("dryRun");
        const verdict = await verifyCapabilityToken(token, keys.publicKey);
        expect(verdict.ok).toBe(true);
        if (!verdict.ok) return;
        expect(verdict.claims).toMatchObject({ agent: "agent_1", dryRun: false });
      }
    });

    /** Well-signed by our key and still not ours: the claim is a boolean or it is not there. */
    it("refuses a well-signed token whose dryRun is not a boolean", async () => {
      const keys = await testKeys();
      const token = await foreign(keys, { dryRun: "yes" });

      expect(await verifyCapabilityToken(token, keys.publicKey)).toEqual({
        ok: false,
        reason: "invalid",
      });
    });
  });

  it("mints a different jti every time", async () => {
    const keys = await testKeys();
    const [a, b] = await Promise.all([
      mintCapabilityToken(INPUT, keys),
      mintCapabilityToken(INPUT, keys),
    ]);
    expect(decodeJwt(a).jti).not.toBe(decodeJwt(b).jti);
  });

  it("refuses an expired token as expired, not merely invalid", async () => {
    const keys = await testKeys();
    const minted = new Date("2026-09-09T10:00:00Z");
    const token = await mintCapabilityToken(INPUT, keys, minted);

    // Five minutes plus the five seconds of tolerance, and one more.
    const later = new Date(minted.getTime() + (300 + 6) * 1000);
    expect(await verifyCapabilityToken(token, keys.publicKey, later)).toEqual({
      ok: false,
      reason: "expired",
    });
    // Inside the tolerance it still verifies — two hosts' clocks may disagree by that much.
    const nearly = new Date(minted.getTime() + (300 + 3) * 1000);
    expect((await verifyCapabilityToken(token, keys.publicKey, nearly)).ok).toBe(true);
  });

  it("refuses a token signed with another key", async () => {
    const [ours, theirs] = await Promise.all([testKeys(), testKeys()]);
    const token = await mintCapabilityToken(INPUT, theirs);

    expect(await verifyCapabilityToken(token, ours.publicKey)).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it("refuses a token for another audience or issuer, and malformed input", async () => {
    const keys = await testKeys();
    const wrongAudience = await new SignJWT({
      person: "p",
      agent: "a",
      connections: ["c"],
      tool: "t",
    })
      .setProtectedHeader({ alg: "EdDSA" })
      .setIssuer("graft")
      .setAudience("somewhere-else")
      .setJti("j")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(keys.privateKey);
    const wrongIssuer = await new SignJWT({
      person: "p",
      agent: "a",
      connections: ["c"],
      tool: "t",
    })
      .setProtectedHeader({ alg: "EdDSA" })
      .setIssuer("someone-else")
      .setAudience("proxy")
      .setJti("j")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(keys.privateKey);

    for (const token of [wrongAudience, wrongIssuer, "", "not-a-jwt", "a.b.c"]) {
      expect(await verifyCapabilityToken(token, keys.publicKey)).toEqual({
        ok: false,
        reason: "invalid",
      });
    }
  });

  /** Well-signed by our key and still not a capability token: a claim the proxy needs is wrong. */
  it("refuses a well-signed token missing a required claim or naming no connection", async () => {
    const keys = await testKeys();
    const cases = [
      foreign(keys, { person: undefined }),
      foreign(keys, { agent: undefined }),
      foreign(keys, { connections: undefined }),
      foreign(keys, { connections: [] }),
      foreign(keys, { connections: "conn_1" }),
      foreign(keys, { connections: ["conn_1", ""] }),
      foreign(keys, { tool: undefined }),
    ];

    for (const token of await Promise.all(cases)) {
      expect(await verifyCapabilityToken(token, keys.publicKey)).toEqual({
        ok: false,
        reason: "invalid",
      });
    }
  });

  it("bounds the lifetime and refuses empty identifiers and an empty scope", async () => {
    const keys = await testKeys();

    await expect(
      mintCapabilityToken({ ...INPUT, ttlSeconds: MAX_CAPABILITY_TOKEN_TTL_SECONDS + 1 }, keys),
    ).rejects.toThrow(/ttlSeconds/);
    await expect(mintCapabilityToken({ ...INPUT, ttlSeconds: 0 }, keys)).rejects.toThrow(
      /ttlSeconds/,
    );
    await expect(mintCapabilityToken({ ...INPUT, ttlSeconds: 1.5 }, keys)).rejects.toThrow(
      /ttlSeconds/,
    );
    await expect(mintCapabilityToken({ ...INPUT, personId: " " }, keys)).rejects.toThrow(
      /personId/,
    );
    await expect(mintCapabilityToken({ ...INPUT, connectionIds: [] }, keys)).rejects.toThrow(
      /connectionIds/,
    );
    await expect(mintCapabilityToken({ ...INPUT, connectionIds: ["c", ""] }, keys)).rejects.toThrow(
      /connectionIds/,
    );
  });

  it("refuses to import a private and public key that are not a pair", async () => {
    const [a, b] = await Promise.all([
      generateKeyPair(CAPABILITY_TOKEN_ALG, { crv: "Ed25519", extractable: true }),
      generateKeyPair(CAPABILITY_TOKEN_ALG, { crv: "Ed25519", extractable: true }),
    ]);

    await expect(
      importCapabilityTokenKeys({
        privateKeyPem: await exportPKCS8(a.privateKey),
        publicKeyPem: await exportSPKI(b.publicKey),
      }),
    ).rejects.toThrow(/not a pair/);
  });

  it("publishes the public key as a JWK set the token's kid points into", async () => {
    const keys = await testKeys();
    const token = await mintCapabilityToken(INPUT, keys);
    const jwks = await capabilityTokenJwks(keys.publicKey);

    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0]).toMatchObject({
      kty: "OKP",
      crv: "Ed25519",
      kid: keys.kid,
      alg: "EdDSA",
      use: "sig",
    });
    expect(jwks.keys[0]).not.toHaveProperty("d");
    expect(decodeProtectedHeader(token).kid).toBe(keys.kid);
  });
});

/** The two `ProxyDeps` the host binds, from a key pair or from none. */
describe("createCapabilityTokenVerifier", () => {
  it("verifies with the keys it was given and publishes them", async () => {
    const keys = await testKeys();
    const verifier = createCapabilityTokenVerifier(keys);
    const token = await mintCapabilityToken(INPUT, keys);

    expect((await verifier.verifyToken(token)).ok).toBe(true);
    expect((await verifier.jwks())?.keys[0]).toMatchObject({ kid: keys.kid });
  });

  it("answers unconfigured, honestly, when the deployment has no key pair", async () => {
    const keys = await testKeys();
    const verifier = createCapabilityTokenVerifier(null);
    const token = await mintCapabilityToken(INPUT, keys);

    expect(await verifier.verifyToken(token)).toEqual({ ok: false, reason: "unconfigured" });
    expect(await verifier.jwks()).toBeNull();
  });
});
