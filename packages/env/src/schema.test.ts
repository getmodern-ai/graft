import { describe, expect, it } from "vitest";

import {
  capabilityTokenPrivateKey,
  capabilityTokenPublicKey,
  defaultProxyPublicUrl,
  finalServerSchema,
  keyringSecret,
  port,
  serverEnvIssues,
  serverSchema,
  withDerivedDefaults,
} from "./schema";

/**
 * The environment's rules, each guarding a failure that boots cleanly and goes green on a health
 * check, then misbehaves at the first real request — the worst kind, because nothing in the deploy
 * says anything is wrong. Pure functions, so no `process.env` is touched here.
 */

const PRIVATE_PEM = [
  "-----BEGIN PRIVATE KEY-----",
  "MC4CAQAwBQYDK2VwBCIEIJ5gLkmYOm3ssWstT3kzAB9CemdBU1OemoxXpOLoWHwT",
  "-----END PRIVATE KEY-----",
].join("\n");
const PUBLIC_PEM = [
  "-----BEGIN PUBLIC KEY-----",
  "MCowBQYDK2VwAyEAj2uCF9JXBSzQ5uPuwHvUGeFxErE7W9fqWkzfF7ITOuI=",
  "-----END PUBLIC KEY-----",
].join("\n");

describe("the capability token key pair", () => {
  it("accepts a PEM with real line breaks and one with \\n-escaped ones, canonically", () => {
    expect(capabilityTokenPrivateKey.parse(PRIVATE_PEM)).toBe(`${PRIVATE_PEM}\n`);
    expect(capabilityTokenPrivateKey.parse(PRIVATE_PEM.replace(/\n/g, "\\n"))).toBe(
      `${PRIVATE_PEM}\n`,
    );
    expect(capabilityTokenPublicKey.parse(`${PUBLIC_PEM}\r\n`)).toBe(`${PUBLIC_PEM}\n`);
  });

  it("is optional — absent means the proxy answers unconfigured", () => {
    expect(capabilityTokenPrivateKey.parse(undefined)).toBeUndefined();
  });

  it("refuses a key of the other label, a placeholder, or anything that is not PEM, naming the variable", () => {
    for (const bad of [PUBLIC_PEM, "PLACEHOLDER", "not a key", "-----BEGIN RSA PRIVATE KEY-----"]) {
      const result = capabilityTokenPrivateKey.safeParse(bad);
      expect(result.success, bad).toBe(false);
      expect(result.error?.issues[0]?.message).toContain("GRAFT_CAPABILITY_TOKEN_PRIVATE_KEY");
    }
    expect(capabilityTokenPublicKey.safeParse(PRIVATE_PEM).success).toBe(false);
  });

  it("is all-or-nothing", () => {
    expect(serverEnvIssues({ GRAFT_CAPABILITY_TOKEN_PRIVATE_KEY: PRIVATE_PEM })).toEqual([
      expect.stringMatching(/partially configured.*Missing: GRAFT_CAPABILITY_TOKEN_PUBLIC_KEY/),
    ]);
    expect(serverEnvIssues({ GRAFT_CAPABILITY_TOKEN_PUBLIC_KEY: PUBLIC_PEM })).toHaveLength(1);
    expect(
      serverEnvIssues({
        GRAFT_CAPABILITY_TOKEN_PRIVATE_KEY: PRIVATE_PEM,
        GRAFT_CAPABILITY_TOKEN_PUBLIC_KEY: PUBLIC_PEM,
      }),
    ).toEqual([]);
    expect(serverEnvIssues({})).toEqual([]);
  });
});

describe("GRAFT_KEYRING_SECRET", () => {
  it("requires thirty-two characters and names itself when short", () => {
    expect(keyringSecret.parse("x".repeat(32))).toBe("x".repeat(32));
    const result = keyringSecret.safeParse("x".repeat(31));
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain("GRAFT_KEYRING_SECRET");
  });
});

describe("GRAFT_DEV_SEED", () => {
  it("is refused under NODE_ENV=production and accepted otherwise", () => {
    expect(serverEnvIssues({ NODE_ENV: "production", GRAFT_DEV_SEED: "./seed.json" })).toEqual([
      expect.stringMatching(/GRAFT_DEV_SEED.*production/),
    ]);
    expect(serverEnvIssues({ NODE_ENV: "development", GRAFT_DEV_SEED: "./seed.json" })).toEqual([]);
    expect(serverEnvIssues({ NODE_ENV: "production" })).toEqual([]);
  });
});

describe("PORT and the derived proxy URL", () => {
  it("coerces the port and defaults it to 3000", () => {
    expect(port.parse(undefined)).toBe(3000);
    expect(port.parse("3210")).toBe(3210);
    expect(port.safeParse("0").success).toBe(false);
    expect(port.safeParse("70000").success).toBe(false);
    expect(port.safeParse("eighty").success).toBe(false);
  });

  it("derives the proxy URL from the port when unset, and keeps a set value", () => {
    expect(defaultProxyPublicUrl(3000)).toBe("http://localhost:3000/api/proxy");
    expect(withDerivedDefaults({ PORT: 3210 })).toEqual({
      PORT: 3210,
      GRAFT_PROXY_PUBLIC_URL: "http://localhost:3210/api/proxy",
    });
    expect(
      withDerivedDefaults({ PORT: 3000, GRAFT_PROXY_PUBLIC_URL: "https://graft.example/api/proxy" })
        .GRAFT_PROXY_PUBLIC_URL,
    ).toBe("https://graft.example/api/proxy");
  });
});

/** The whole object as `createEnv` is handed it — fields, cross-field rules and the derived default. */
describe("finalServerSchema", () => {
  const schema = finalServerSchema(serverSchema);
  const minimal = { GRAFT_KEYRING_SECRET: "test-secret-that-is-long-enough-32" };

  it("parses the minimum a laptop needs, with every default filled in", () => {
    expect(schema.parse(minimal)).toEqual({
      NODE_ENV: "development",
      PORT: 3000,
      GRAFT_KEYRING_SECRET: minimal.GRAFT_KEYRING_SECRET,
      GRAFT_PROXY_FOLLOW_REDIRECTS: false,
      GRAFT_PROXY_PUBLIC_URL: "http://localhost:3000/api/proxy",
    });
  });

  it("reads a stringbool for the break-glass flag", () => {
    expect(schema.parse({ ...minimal, GRAFT_PROXY_FOLLOW_REDIRECTS: "true" })).toMatchObject({
      GRAFT_PROXY_FOLLOW_REDIRECTS: true,
    });
    expect(schema.safeParse({ ...minimal, GRAFT_PROXY_FOLLOW_REDIRECTS: "maybe" }).success).toBe(
      false,
    );
  });

  it("refuses the missing keyring secret, a half pair, and a seed file in production", () => {
    expect(schema.safeParse({}).success).toBe(false);
    const half = schema.safeParse({ ...minimal, GRAFT_CAPABILITY_TOKEN_PRIVATE_KEY: PRIVATE_PEM });
    expect(half.success).toBe(false);
    expect(half.error?.issues.map((issue) => issue.message)).toEqual([
      expect.stringMatching(/partially configured/),
    ]);
    expect(
      schema.safeParse({ ...minimal, NODE_ENV: "production", GRAFT_DEV_SEED: "seed.json" }).success,
    ).toBe(false);
  });
});
