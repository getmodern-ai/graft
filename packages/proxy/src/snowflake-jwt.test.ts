import {
  createHash,
  createPrivateKey,
  createPublicKey,
  createVerify,
  generateKeyPairSync,
} from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  normalizeSnowflakeAccount,
  SNOWFLAKE_JWT_LIFETIME_SECONDS,
  SnowflakeKeyError,
  signSnowflakeJwt,
  snowflakeCredentialSignature,
} from "./snowflake-jwt";

/**
 * Modern's Snowflake recipe, lifted with its tests (ADR 0011): the claims, the signature, and the
 * PEM tolerance that lets a key parse however it was pasted. The plugin around it — when to sign,
 * what to cache — is `schemes.test.ts`'s.
 */

function makeKeypair() {
  return generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
}

// Generated once — key generation is the slow part, the signing under test is cheap.
const kp1 = makeKeypair();

function fingerprintOf(publicKeyPem: string): string {
  const der = createPublicKey(publicKeyPem).export({ format: "der", type: "spki" });
  return `SHA256:${createHash("sha256").update(der).digest("base64")}`;
}

function decode(token: string) {
  const [header, payload, signature] = token.split(".");
  return {
    header: JSON.parse(Buffer.from(header ?? "", "base64url").toString()) as Record<
      string,
      unknown
    >,
    payload: JSON.parse(Buffer.from(payload ?? "", "base64url").toString()) as {
      iss: string;
      sub: string;
      iat: number;
      exp: number;
    },
    signingInput: `${header}.${payload}`,
    signature: signature ?? "",
  };
}

function verify(token: string, publicKeyPem: string): boolean {
  const { signingInput, signature } = decode(token);
  return createVerify("RSA-SHA256")
    .update(signingInput)
    .verify(publicKeyPem, Buffer.from(signature, "base64url"));
}

const NOW = 1_700_000_000;

const sign = (overrides: Partial<Parameters<typeof signSnowflakeJwt>[0]> = {}) =>
  signSnowflakeJwt({
    account: "myorg-myaccount",
    user: "svc_user",
    privateKeyPem: kp1.privateKey,
    nowSeconds: NOW,
    ...overrides,
  });

describe("signSnowflakeJwt", () => {
  it("signs an RS256 JWT with Snowflake's iss and sub claims and a verifiable signature", () => {
    const { token, issuedAt, expiresAt } = sign();
    const { header, payload } = decode(token);

    expect(header).toEqual({ alg: "RS256", typ: "JWT" });
    expect(payload.sub).toBe("MYORG-MYACCOUNT.SVC_USER");
    expect(payload.iss).toBe(`MYORG-MYACCOUNT.SVC_USER.${fingerprintOf(kp1.publicKey)}`);
    expect(payload.iat).toBe(NOW);
    expect(payload.exp - payload.iat).toBe(SNOWFLAKE_JWT_LIFETIME_SECONDS);
    expect(issuedAt).toBe(NOW);
    expect(expiresAt).toBe(NOW + SNOWFLAKE_JWT_LIFETIME_SECONDS);
    expect(verify(token, kp1.publicKey)).toBe(true);
  });

  it("dates the token by the clock it is handed, not the wall clock", () => {
    expect(decode(sign({ nowSeconds: 42 }).token).payload).toMatchObject({
      iat: 42,
      exp: 42 + SNOWFLAKE_JWT_LIFETIME_SECONDS,
    });
  });

  it("normalises an account URL host into the upper-cased locator", () => {
    const { token } = sign({ account: "https://myorg-myaccount.snowflakecomputing.com" });
    expect(decode(token).payload.sub).toBe("MYORG-MYACCOUNT.SVC_USER");
    expect(normalizeSnowflakeAccount(" myorg-myaccount.snowflakecomputing.com/ ")).toBe(
      "MYORG-MYACCOUNT",
    );
  });

  it("throws a typed error when the private key cannot be parsed, without echoing it", () => {
    expect(() => sign({ privateKeyPem: "not-a-pem" })).toThrow(SnowflakeKeyError);
    expect(() => sign({ privateKeyPem: "not-a-pem" })).not.toThrow(/not-a-pem/);
  });
});

describe("snowflakeCredentialSignature", () => {
  it("changes with the account, the user or the key, and never holds the key", () => {
    const base = snowflakeCredentialSignature("a", "u", kp1.privateKey);
    expect(snowflakeCredentialSignature("a", "u", kp1.privateKey)).toBe(base);
    expect(snowflakeCredentialSignature("b", "u", kp1.privateKey)).not.toBe(base);
    expect(snowflakeCredentialSignature("a", "v", kp1.privateKey)).not.toBe(base);
    expect(snowflakeCredentialSignature("a", "u", makeKeypair().privateKey)).not.toBe(base);
    expect(base).not.toContain("PRIVATE KEY");
    expect(base.length).toBeLessThan(64);
  });
});

/**
 * OpenSSL 3 rejects a correct key with `DECODER routines::unsupported` once its PEM line breaks are
 * lost in a copy-paste, a form or a JSON round trip. These prove the PEM is reconstructed so a
 * correct key parses however it was pasted — and that the recovered key is the SAME key
 * (fingerprint and signature verify).
 */
describe("signSnowflakeJwt — private key PEM normalisation", () => {
  const expectedIss = `MYORG-MYACCOUNT.SVC_USER.${fingerprintOf(kp1.publicKey)}`;

  function expectValid(privateKeyPem: string) {
    const { token } = sign({ privateKeyPem });
    expect(verify(token, kp1.publicKey)).toBe(true);
    expect(decode(token).payload.iss).toBe(expectedIss);
  }

  it("still accepts a correct, untouched multiline PEM", () => {
    expectValid(kp1.privateKey);
  });

  it("accepts a PEM whose newlines were collapsed onto one line (armor intact)", () => {
    expectValid(kp1.privateKey.replace(/\n/g, ""));
  });

  it("accepts a PEM whose body newlines became spaces", () => {
    expectValid(kp1.privateKey.replace(/\n/g, " "));
  });

  it("accepts literal \\n escape sequences instead of real newlines", () => {
    expectValid(kp1.privateKey.replace(/\n/g, "\\n"));
  });

  it("accepts a value wrapped in surrounding quotes", () => {
    expectValid(`"${kp1.privateKey.replace(/\n/g, "\\n")}"`);
  });

  it("accepts a headerless bare base64 body (PKCS#8, no BEGIN/END armor)", () => {
    const body = kp1.privateKey.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
    expectValid(body);
  });

  it("accepts a headerless bare base64 body via the PKCS#1 fallback", () => {
    const pkcs1 = createPrivateKey(kp1.privateKey)
      .export({ type: "pkcs1", format: "pem" })
      .toString();
    const body = pkcs1.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
    expectValid(body);
  });

  it("accepts a passphrase-protected traditional PEM (Proc-Type/DEK-Info) without corrupting it", () => {
    // The base64-body reconstruction must NOT run on a traditional encrypted PEM: its
    // Proc-Type/DEK-Info header lines carry the cipher and IV and would be folded into the body if
    // stripped. It must parse via the untouched as-is path.
    const { privateKey: encrypted, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: {
        type: "pkcs1",
        format: "pem",
        cipher: "aes-256-cbc",
        passphrase: "sekret",
      },
    });
    expect(encrypted).toContain("Proc-Type");

    const { token } = sign({ privateKeyPem: encrypted, passphrase: "sekret" });
    expect(verify(token, publicKey)).toBe(true);
    // And a mangled encrypted PEM fails cleanly rather than being "repaired" into garbage.
    expect(() =>
      sign({ privateKeyPem: encrypted.replace(/\n/g, " "), passphrase: "sekret" }),
    ).toThrow(SnowflakeKeyError);
  });
});
