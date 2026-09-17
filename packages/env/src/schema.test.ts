import { describe, expect, it } from "vitest";

import {
  acquireConcurrency,
  acquireMaxAttempts,
  acquireTokenCeiling,
  adminEmail,
  adminPassword,
  approvalWaitSeconds,
  authSecret,
  authUrl,
  backingsForm,
  capabilityTokenPrivateKey,
  capabilityTokenPublicKey,
  consoleDir,
  consoleUrl,
  corsOrigins,
  databaseUrl,
  defaultProxyPublicUrl,
  describeEnvIssues,
  finalServerSchema,
  handoffSecret,
  keyringSecret,
  migrateOnStart,
  modelBackend,
  modelProvider,
  packageAllowlist,
  packageMinAgeDays,
  packageMinWeeklyDownloads,
  pendingActionTtlHours,
  pipedreamEnvironment,
  pipedreamProjectId,
  port,
  sandboxBackend,
  serverEnvIssues,
  serverSchema,
  sweepIntervalSeconds,
  toolboxRoot,
  toolboxVolume,
  withDerivedDefaults,
} from "./schema";

/**
 * The environment's rules, each guarding a failure that boots cleanly and goes green on a health
 * check, then misbehaves at the first real request — the worst kind, because nothing in the deploy
 * says anything is wrong. Pure functions, so no `process.env` is touched here.
 */

/** The open form's one required cross-field input, so a test about another rule sees that rule alone. */
const SECRET = { GRAFT_KEYRING_SECRET: "x".repeat(32) };
/** The self-hosted form authors with a provider and a key (ADR 0014); every production case carries one. */
const MODEL = {
  GRAFT_MODEL_BACKEND: "provider",
  GRAFT_MODEL_PROVIDER: "openai",
  GRAFT_MODEL_API_KEY: "sk-test-key",
};

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
    expect(serverEnvIssues({ ...SECRET, GRAFT_CAPABILITY_TOKEN_PRIVATE_KEY: PRIVATE_PEM })).toEqual(
      [expect.stringMatching(/partially configured.*Missing: GRAFT_CAPABILITY_TOKEN_PUBLIC_KEY/)],
    );
    expect(
      serverEnvIssues({ ...SECRET, GRAFT_CAPABILITY_TOKEN_PUBLIC_KEY: PUBLIC_PEM }),
    ).toHaveLength(1);
    expect(
      serverEnvIssues({
        ...SECRET,
        GRAFT_CAPABILITY_TOKEN_PRIVATE_KEY: PRIVATE_PEM,
        GRAFT_CAPABILITY_TOKEN_PUBLIC_KEY: PUBLIC_PEM,
      }),
    ).toEqual([]);
    expect(serverEnvIssues({ ...SECRET })).toEqual([]);
  });
});

describe("GRAFT_KEYRING_SECRET", () => {
  it("requires thirty-two characters and names itself when short", () => {
    expect(keyringSecret.parse("x".repeat(32))).toBe("x".repeat(32));
    const result = keyringSecret.safeParse("x".repeat(31));
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain("GRAFT_KEYRING_SECRET");
  });

  it("is required exactly when the open backings are selected, which is the default", () => {
    expect(serverEnvIssues({})).toEqual([expect.stringMatching(/GRAFT_KEYRING_SECRET.*open/)]);
    expect(serverEnvIssues({ GRAFT_BACKINGS: "open" })).toHaveLength(1);
    expect(serverEnvIssues({ GRAFT_BACKINGS: "cloud" })).toEqual([]);
    expect(serverEnvIssues({ ...SECRET })).toEqual([]);
  });
});

describe("GRAFT_BACKINGS", () => {
  it("is open by default and accepts only the two forms", () => {
    expect(backingsForm.parse(undefined)).toBe("open");
    expect(backingsForm.parse("cloud")).toBe("cloud");
    for (const bad of ["hosted", "docker", "", "Open"]) {
      expect(backingsForm.safeParse(bad).success, bad).toBe(false);
    }
  });

  it("refuses the fake sandbox beside the cloud form, whose sandbox is the private package's", () => {
    expect(serverEnvIssues({ GRAFT_BACKINGS: "cloud", GRAFT_SANDBOX_BACKEND: "fake" })).toEqual([
      expect.stringMatching(/GRAFT_SANDBOX_BACKEND=fake.*GRAFT_BACKINGS=cloud/),
    ]);
    expect(serverEnvIssues({ GRAFT_BACKINGS: "cloud", GRAFT_SANDBOX_BACKEND: "docker" })).toEqual(
      [],
    );
  });
});

describe("GRAFT_DATABASE_URL", () => {
  it("accepts either scheme with credentials in it, and names itself otherwise", () => {
    expect(databaseUrl.parse("postgresql://postgres:password@localhost:5432/graft")).toBe(
      "postgresql://postgres:password@localhost:5432/graft",
    );
    expect(databaseUrl.parse("postgres://u@h/db")).toBe("postgres://u@h/db");
    for (const bad of ["", "mysql://h/db", "localhost:5432/graft"]) {
      const result = databaseUrl.safeParse(bad);
      expect(result.success, bad).toBe(false);
      expect(result.error?.issues[0]?.message).toContain("GRAFT_DATABASE_URL");
    }
  });
});

describe("GRAFT_AUTH_SECRET and GRAFT_AUTH_URL", () => {
  it("requires thirty-two characters of secret, naming itself when short", () => {
    expect(authSecret.parse("y".repeat(32))).toBe("y".repeat(32));
    expect(authSecret.safeParse("y".repeat(31)).error?.issues[0]?.message).toContain(
      "GRAFT_AUTH_SECRET",
    );
  });

  it("requires an absolute URL for the origin", () => {
    expect(authUrl.parse("http://localhost:3000")).toBe("http://localhost:3000");
    expect(authUrl.safeParse("localhost:3000").success).toBe(false);
    expect(authUrl.safeParse("").error?.issues[0]?.message).toContain("GRAFT_AUTH_URL");
  });
});

describe("GRAFT_CORS_ORIGIN", () => {
  it("is an empty list when unset, and a trimmed, de-duplicated list when set", () => {
    expect(corsOrigins.parse(undefined)).toEqual([]);
    expect(
      corsOrigins.parse(
        " http://localhost:3001, https://console.graft.example ,http://localhost:3001",
      ),
    ).toEqual(["http://localhost:3001", "https://console.graft.example"]);
  });

  it("refuses an entry that is more than an origin, saying which and what it should have been", () => {
    for (const bad of ["http://localhost:3001/", "https://console.graft.example/app", "console"]) {
      const result = corsOrigins.safeParse(bad);
      expect(result.success, bad).toBe(false);
      expect(result.error?.issues[0]?.message).toContain(bad);
    }
  });
});

describe("GRAFT_DEV_SEED", () => {
  it("is refused under NODE_ENV=production and accepted otherwise", () => {
    expect(
      serverEnvIssues({
        ...SECRET,
        ...MODEL,
        NODE_ENV: "production",
        GRAFT_DEV_SEED: "./seed.json",
      }),
    ).toEqual([expect.stringMatching(/GRAFT_DEV_SEED.*production/)]);
    expect(
      serverEnvIssues({ ...SECRET, NODE_ENV: "development", GRAFT_DEV_SEED: "./seed.json" }),
    ).toEqual([]);
    expect(serverEnvIssues({ ...SECRET, ...MODEL, NODE_ENV: "production" })).toEqual([]);
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

describe("GRAFT_TOOLBOX_ROOT", () => {
  it("defaults to the laptop's gitignored directory and refuses an empty value", () => {
    expect(toolboxRoot.parse(undefined)).toBe("./.graft/toolboxes");
    expect(toolboxRoot.parse("/var/lib/graft/toolboxes")).toBe("/var/lib/graft/toolboxes");
    expect(toolboxRoot.safeParse("").error?.issues[0]?.message).toContain("GRAFT_TOOLBOX_ROOT");
  });
});

describe("GRAFT_TOOLBOX_VOLUME", () => {
  it("is optional, takes a volume name, and refuses a path, naming itself", () => {
    expect(toolboxVolume.parse(undefined)).toBeUndefined();
    expect(toolboxVolume.parse("graft_toolboxes")).toBe("graft_toolboxes");
    for (const bad of ["/var/lib/graft/toolboxes", "./toolboxes", ""]) {
      const result = toolboxVolume.safeParse(bad);
      expect(result.success, bad).toBe(false);
      expect(result.error?.issues[0]?.message).toContain("GRAFT_TOOLBOX_VOLUME");
    }
  });
});

describe("the package policy's thresholds and extra names", () => {
  it("default to ninety days and a thousand downloads, coerce whole numbers, and refuse anything else", () => {
    expect(packageMinAgeDays.parse(undefined)).toBe(90);
    expect(packageMinWeeklyDownloads.parse(undefined)).toBe(1000);
    expect(packageMinAgeDays.parse("0")).toBe(0);
    expect(packageMinWeeklyDownloads.parse("250")).toBe(250);
    for (const bad of ["-1", "1.5", "ninety"]) {
      const result = packageMinAgeDays.safeParse(bad);
      expect(result.success, bad).toBe(false);
      expect(result.error?.issues[0]?.message).toContain("GRAFT_PACKAGE_MIN_AGE_DAYS");
    }
  });

  it("parses the allowlist to a trimmed, de-duplicated list of names and scope patterns", () => {
    expect(packageAllowlist.parse(undefined)).toEqual([]);
    expect(packageAllowlist.parse(" left-pad, @octokit/*,left-pad ,@my-org/sdk")).toEqual([
      "left-pad",
      "@octokit/*",
      "@my-org/sdk",
    ]);
  });

  it("refuses an entry that is not a package name, saying which", () => {
    for (const bad of ["Left-Pad", "../x", "@scope", "left pad", "*"]) {
      const result = packageAllowlist.safeParse(bad);
      expect(result.success, bad).toBe(false);
      expect(result.error?.issues[0]?.message).toContain(bad);
    }
  });
});

describe("the Docker sandbox backing's pair", () => {
  it("is all-or-nothing", () => {
    expect(serverEnvIssues({ ...SECRET, GRAFT_SANDBOX_IMAGE: "graft-sandbox:dev" })).toEqual([
      expect.stringMatching(
        /sandbox backing is partially configured.*Missing: GRAFT_SANDBOX_NETWORK/,
      ),
    ]);
    expect(serverEnvIssues({ ...SECRET, GRAFT_SANDBOX_NETWORK: "graft_sandbox" })).toHaveLength(1);
    expect(
      serverEnvIssues({
        ...SECRET,
        GRAFT_SANDBOX_IMAGE: "graft-sandbox:dev",
        GRAFT_SANDBOX_NETWORK: "x",
      }),
    ).toEqual([]);
  });
});

/** The whole object as `createEnv` is handed it — fields, cross-field rules and the derived default. */
describe("GRAFT_SWEEP_INTERVAL_SECONDS", () => {
  it("defaults to five minutes, coerces whole seconds, and refuses zero, a fraction or a word, naming itself", () => {
    expect(sweepIntervalSeconds.parse(undefined)).toBe(300);
    expect(sweepIntervalSeconds.parse("60")).toBe(60);
    for (const bad of ["0", "-5", "1.5", "often"]) {
      const result = sweepIntervalSeconds.safeParse(bad);
      expect(result.success, bad).toBe(false);
      expect(result.error?.issues[0]?.message).toContain("GRAFT_SWEEP_INTERVAL_SECONDS");
    }
  });
});

describe("finalServerSchema", () => {
  const schema = finalServerSchema(serverSchema);
  const minimal = {
    GRAFT_DATABASE_URL: "postgresql://postgres:password@localhost:5432/graft",
    GRAFT_AUTH_SECRET: "auth-secret-that-is-long-enough-32-chars",
    GRAFT_AUTH_URL: "http://localhost:3000",
    GRAFT_KEYRING_SECRET: "test-secret-that-is-long-enough-32",
    GRAFT_CONSOLE_URL: "http://localhost:3001",
    GRAFT_HANDOFF_SECRET: "handoff-secret-that-is-long-enough-32",
  };

  it("parses the minimum a laptop needs, with every default filled in", () => {
    expect(schema.parse(minimal)).toEqual({
      NODE_ENV: "development",
      PORT: 3000,
      GRAFT_DATABASE_URL: minimal.GRAFT_DATABASE_URL,
      GRAFT_AUTH_SECRET: minimal.GRAFT_AUTH_SECRET,
      GRAFT_AUTH_URL: minimal.GRAFT_AUTH_URL,
      GRAFT_CORS_ORIGIN: [],
      GRAFT_BACKINGS: "open",
      GRAFT_KEYRING_SECRET: minimal.GRAFT_KEYRING_SECRET,
      GRAFT_PROXY_FOLLOW_REDIRECTS: false,
      GRAFT_PROXY_PUBLIC_URL: "http://localhost:3000/api/proxy",
      GRAFT_SANDBOX_BACKEND: "docker",
      GRAFT_TOOLBOX_ROOT: "./.graft/toolboxes",
      GRAFT_PACKAGE_MIN_AGE_DAYS: 90,
      GRAFT_PACKAGE_MIN_WEEKLY_DOWNLOADS: 1000,
      GRAFT_PACKAGE_ALLOWLIST: [],
      GRAFT_CONSOLE_DIR: "../web/dist",
      GRAFT_CONSOLE_URL: minimal.GRAFT_CONSOLE_URL,
      GRAFT_HANDOFF_SECRET: minimal.GRAFT_HANDOFF_SECRET,
      GRAFT_APPROVAL_WAIT_SECONDS: 25,
      GRAFT_PENDING_ACTION_TTL_HOURS: 24,
      GRAFT_SWEEP_INTERVAL_SECONDS: 300,
      GRAFT_MIGRATE_ON_START: true,
      GRAFT_ACQUIRE_MAX_ATTEMPTS: 4,
      GRAFT_ACQUIRE_TOKEN_CEILING: 400_000,
      GRAFT_ACQUIRE_CONCURRENCY: 2,
    });
  });

  it("refuses a half-configured Docker sandbox backing and accepts the pair", () => {
    expect(schema.safeParse({ ...minimal, GRAFT_SANDBOX_IMAGE: "graft-sandbox:dev" }).success).toBe(
      false,
    );
    expect(
      schema.parse({
        ...minimal,
        GRAFT_SANDBOX_IMAGE: "graft-sandbox:dev",
        GRAFT_SANDBOX_NETWORK: "graft_sandbox",
      }),
    ).toMatchObject({
      GRAFT_SANDBOX_IMAGE: "graft-sandbox:dev",
      GRAFT_SANDBOX_NETWORK: "graft_sandbox",
    });
  });

  it("boots the cloud form without a keyring secret, and refuses a form it does not know", () => {
    const { GRAFT_KEYRING_SECRET: _omitted, ...withoutSecret } = minimal;
    expect(schema.parse({ ...withoutSecret, GRAFT_BACKINGS: "cloud" })).toMatchObject({
      GRAFT_BACKINGS: "cloud",
    });
    expect(schema.safeParse({ ...minimal, GRAFT_BACKINGS: "hosted" }).success).toBe(false);
  });

  it("refuses the minimum with any one of the six required values missing", () => {
    for (const key of Object.keys(minimal)) {
      const { [key]: _omitted, ...rest } = minimal as Record<string, string>;
      const result = schema.safeParse(rest);
      expect(result.success, key).toBe(false);
    }
  });

  it("reads a stringbool for the break-glass flag", () => {
    expect(schema.parse({ ...minimal, GRAFT_PROXY_FOLLOW_REDIRECTS: "true" })).toMatchObject({
      GRAFT_PROXY_FOLLOW_REDIRECTS: true,
    });
    expect(schema.safeParse({ ...minimal, GRAFT_PROXY_FOLLOW_REDIRECTS: "maybe" }).success).toBe(
      false,
    );
  });

  it("refuses an empty environment, a half pair, and a seed file in production", () => {
    expect(schema.safeParse({}).success).toBe(false);
    const half = schema.safeParse({ ...minimal, GRAFT_CAPABILITY_TOKEN_PRIVATE_KEY: PRIVATE_PEM });
    expect(half.success).toBe(false);
    expect(half.error?.issues.map((issue) => issue.message)).toEqual([
      expect.stringMatching(/partially configured/),
    ]);
    expect(
      schema.safeParse({
        ...minimal,
        ...MODEL,
        NODE_ENV: "production",
        GRAFT_DEV_SEED: "seed.json",
      }).success,
    ).toBe(false);
  });
});

describe("GRAFT_CONSOLE_URL and GRAFT_HANDOFF_SECRET", () => {
  it("requires an absolute http(s) URL for the console, a path allowed, naming itself otherwise", () => {
    expect(consoleUrl.parse("http://localhost:3001")).toBe("http://localhost:3001");
    expect(consoleUrl.parse("https://graft.example/console")).toBe("https://graft.example/console");
    for (const bad of ["", "localhost:3001", "ftp://console.example", "console"]) {
      const result = consoleUrl.safeParse(bad);
      expect(result.success, bad).toBe(false);
      expect(result.error?.issues[0]?.message).toContain("GRAFT_CONSOLE_URL");
    }
  });

  it("requires thirty-two characters of handoff secret, naming itself when short", () => {
    expect(handoffSecret.parse("h".repeat(32))).toBe("h".repeat(32));
    expect(handoffSecret.safeParse("h".repeat(31)).error?.issues[0]?.message).toContain(
      "GRAFT_HANDOFF_SECRET",
    );
  });
});

describe("the ask flow's clocks", () => {
  it("waits 25 seconds by default, accepts zero, and refuses a negative, fractional or minutes-long wait", () => {
    expect(approvalWaitSeconds.parse(undefined)).toBe(25);
    expect(approvalWaitSeconds.parse("0")).toBe(0);
    expect(approvalWaitSeconds.parse("300")).toBe(300);
    for (const bad of ["-1", "2.5", "301", "soon"]) {
      const result = approvalWaitSeconds.safeParse(bad);
      expect(result.success, bad).toBe(false);
      expect(result.error?.issues[0]?.message).toContain("GRAFT_APPROVAL_WAIT_SECONDS");
    }
  });

  it("keeps a pending action a day by default, at least an hour and at most a week", () => {
    expect(pendingActionTtlHours.parse(undefined)).toBe(24);
    expect(pendingActionTtlHours.parse("1")).toBe(1);
    expect(pendingActionTtlHours.parse("168")).toBe(168);
    for (const bad of ["0", "169", "1.5", "tomorrow"]) {
      const result = pendingActionTtlHours.safeParse(bad);
      expect(result.success, bad).toBe(false);
      expect(result.error?.issues[0]?.message).toContain("GRAFT_PENDING_ACTION_TTL_HOURS");
    }
  });
});

describe("the sandbox backing", () => {
  it("is docker unless said otherwise", () => {
    expect(sandboxBackend.parse(undefined)).toBe("docker");
    expect(sandboxBackend.parse("fake")).toBe("fake");
    expect(sandboxBackend.safeParse("blaxel").success).toBe(false);
  });

  it("refuses the fake backing in production and nowhere else", () => {
    expect(
      serverEnvIssues({
        ...SECRET,
        ...MODEL,
        NODE_ENV: "production",
        GRAFT_SANDBOX_BACKEND: "fake",
      }),
    ).toEqual([expect.stringMatching(/GRAFT_SANDBOX_BACKEND=fake.*NODE_ENV=production/)]);
    expect(
      serverEnvIssues({ ...SECRET, NODE_ENV: "development", GRAFT_SANDBOX_BACKEND: "fake" }),
    ).toEqual([]);
    expect(
      serverEnvIssues({
        ...SECRET,
        ...MODEL,
        NODE_ENV: "production",
        GRAFT_SANDBOX_BACKEND: "docker",
      }),
    ).toEqual([]);
  });
});

describe("the acquire job's bounds", () => {
  it("default to four attempts, four hundred thousand tokens and two concurrent jobs", () => {
    expect(acquireMaxAttempts.parse(undefined)).toBe(4);
    expect(acquireTokenCeiling.parse(undefined)).toBe(400_000);
    expect(acquireConcurrency.parse(undefined)).toBe(2);
  });

  it("take whole numbers inside their bounds, naming the variable otherwise", () => {
    expect(acquireMaxAttempts.parse("6")).toBe(6);
    expect(acquireTokenCeiling.parse("50000")).toBe(50_000);
    expect(acquireConcurrency.parse("1")).toBe(1);
    for (const [schema, bad, name] of [
      [acquireMaxAttempts, "0", "GRAFT_ACQUIRE_MAX_ATTEMPTS"],
      [acquireMaxAttempts, "21", "GRAFT_ACQUIRE_MAX_ATTEMPTS"],
      [acquireMaxAttempts, "2.5", "GRAFT_ACQUIRE_MAX_ATTEMPTS"],
      [acquireTokenCeiling, "999", "GRAFT_ACQUIRE_TOKEN_CEILING"],
      [acquireTokenCeiling, "lots", "GRAFT_ACQUIRE_TOKEN_CEILING"],
      [acquireConcurrency, "0", "GRAFT_ACQUIRE_CONCURRENCY"],
      [acquireConcurrency, "33", "GRAFT_ACQUIRE_CONCURRENCY"],
    ] as const) {
      const result = schema.safeParse(bad);
      expect(result.success, `${name}=${bad}`).toBe(false);
      expect(result.error?.issues[0]?.message).toContain(name);
    }
  });
});

describe("GRAFT_MODEL_BACKEND", () => {
  it("is unset by default — no model, and acquire says so — and admits scripted and provider", () => {
    expect(modelBackend.parse(undefined)).toBeUndefined();
    expect(modelBackend.parse("scripted")).toBe("scripted");
    expect(modelBackend.parse("provider")).toBe("provider");
    expect(modelBackend.safeParse("gpt").success).toBe(false);
  });

  it("is all-or-nothing with its script, and refused in production", () => {
    // The open backings' keyring secret beside every input, so the one issue asserted is this rule's.
    const keyed = { GRAFT_KEYRING_SECRET: "k".repeat(32) };
    expect(serverEnvIssues({ ...keyed, GRAFT_MODEL_BACKEND: "scripted" })).toEqual([
      expect.stringMatching(/scripted model is partially configured.*Missing: GRAFT_MODEL_SCRIPT/),
    ]);
    expect(serverEnvIssues({ ...keyed, GRAFT_MODEL_SCRIPT: "./script.json" })).toEqual([
      expect.stringMatching(/Missing: GRAFT_MODEL_BACKEND/),
    ]);
    expect(
      serverEnvIssues({
        ...keyed,
        GRAFT_MODEL_BACKEND: "scripted",
        GRAFT_MODEL_SCRIPT: "./script.json",
      }),
    ).toEqual([]);
    expect(
      serverEnvIssues({
        ...keyed,
        NODE_ENV: "production",
        GRAFT_MODEL_BACKEND: "scripted",
        GRAFT_MODEL_SCRIPT: "./script.json",
      }),
    ).toEqual([
      expect.stringMatching(/GRAFT_MODEL_BACKEND=scripted.*production/),
      expect.stringMatching(/self-hosted form needs a model/),
    ]);
  });
});

/** The full schema and the laptop minimum, for the describes below (the `finalServerSchema` describe has its own). */
const fullSchema = finalServerSchema(serverSchema);
const MINIMAL = {
  GRAFT_DATABASE_URL: "postgresql://postgres:password@localhost:5432/graft",
  GRAFT_AUTH_SECRET: "auth-secret-that-is-long-enough-32-chars",
  GRAFT_AUTH_URL: "http://localhost:3000",
  GRAFT_KEYRING_SECRET: "test-secret-that-is-long-enough-32",
  GRAFT_CONSOLE_URL: "http://localhost:3001",
  GRAFT_HANDOFF_SECRET: "handoff-secret-that-is-long-enough-32",
};

describe("the provider-backed model", () => {
  const PROVIDER = {
    ...SECRET,
    GRAFT_MODEL_BACKEND: "provider",
    GRAFT_MODEL_PROVIDER: "openai",
    GRAFT_MODEL_API_KEY: "sk-test-key",
  };

  it("takes the two provider names and nothing else", () => {
    expect(modelProvider.parse("anthropic")).toBe("anthropic");
    expect(modelProvider.parse("openai")).toBe("openai");
    expect(modelProvider.parse(undefined)).toBeUndefined();
    expect(modelProvider.safeParse("gemini").success).toBe(false);
  });

  it("needs the provider and the key together under GRAFT_MODEL_BACKEND=provider, naming what is missing", () => {
    expect(serverEnvIssues(PROVIDER)).toEqual([]);
    const { GRAFT_MODEL_API_KEY: _key, ...withoutKey } = PROVIDER;
    expect(serverEnvIssues(withoutKey)).toEqual([
      expect.stringMatching(
        /needs GRAFT_MODEL_PROVIDER.*GRAFT_MODEL_API_KEY.*Missing: GRAFT_MODEL_API_KEY$/,
      ),
    ]);
    expect(serverEnvIssues({ ...SECRET, GRAFT_MODEL_BACKEND: "provider" })).toEqual([
      expect.stringMatching(/Missing: GRAFT_MODEL_PROVIDER, GRAFT_MODEL_API_KEY$/),
    ]);
  });

  it("refuses provider settings that nothing would read — the backend is not provider", () => {
    const { GRAFT_MODEL_BACKEND: _backend, ...pairAlone } = PROVIDER;
    expect(serverEnvIssues(pairAlone)).toEqual([
      expect.stringMatching(
        /^GRAFT_MODEL_PROVIDER, GRAFT_MODEL_API_KEY configure the provider-backed model, but GRAFT_MODEL_BACKEND is not provider/,
      ),
    ]);
    expect(
      serverEnvIssues({
        ...SECRET,
        GRAFT_MODEL_BACKEND: "scripted",
        GRAFT_MODEL_SCRIPT: "./s.json",
        GRAFT_MODEL_TRIAGE: "gpt-5.4-mini",
      }),
    ).toEqual([expect.stringMatching(/^GRAFT_MODEL_TRIAGE configure/)]);
  });

  it("is allowed in production, unlike the scripted backend, and takes the optional model ids and base URL", () => {
    expect(serverEnvIssues({ ...PROVIDER, NODE_ENV: "production" })).toEqual([]);
    expect(
      fullSchema.parse({
        ...MINIMAL,
        ...PROVIDER,
        GRAFT_MODEL_AUTHORING: "gpt-5.6-sol",
        GRAFT_MODEL_TRIAGE: "gpt-5.4-mini",
        GRAFT_MODEL_BASE_URL: "https://gateway.example/v1",
      }),
    ).toMatchObject({
      GRAFT_MODEL_BACKEND: "provider",
      GRAFT_MODEL_PROVIDER: "openai",
      GRAFT_MODEL_AUTHORING: "gpt-5.6-sol",
      GRAFT_MODEL_TRIAGE: "gpt-5.4-mini",
      GRAFT_MODEL_BASE_URL: "https://gateway.example/v1",
    });
    expect(
      fullSchema.safeParse({ ...MINIMAL, ...PROVIDER, GRAFT_MODEL_BASE_URL: "gateway.example" })
        .success,
    ).toBe(false);
  });

  it("refuses a key that still holds the secret store's placeholder, and an empty one", () => {
    const placeholder = fullSchema.safeParse({
      ...MINIMAL,
      ...PROVIDER,
      GRAFT_MODEL_API_KEY: "PLACEHOLDER-populate-me",
    });
    expect(placeholder.success).toBe(false);
    expect(placeholder.error?.issues.map((issue) => issue.message)).toEqual([
      expect.stringMatching(/GRAFT_MODEL_API_KEY still holds the secret store's placeholder/),
    ]);
    // An empty string reads as unset (`emptyStringAsUndefined` in server.ts is the same rule at the door).
    expect(fullSchema.safeParse({ ...MINIMAL, ...PROVIDER, GRAFT_MODEL_API_KEY: "" }).success).toBe(
      false,
    );
  });
});

describe("the self-hosted form", () => {
  const PRODUCTION = { ...SECRET, NODE_ENV: "production" };

  it("refuses to boot in production under the open backings without a provider and a key, naming both variables", () => {
    const issues = serverEnvIssues(PRODUCTION);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/self-hosted form needs a model/);
    expect(issues[0]).toContain("GRAFT_MODEL_PROVIDER");
    expect(issues[0]).toContain("GRAFT_MODEL_API_KEY");
    expect(issues[0]).toContain("ADR 0014");
    // The scripted backend is not a model; it is refused in production on its own account too.
    expect(
      serverEnvIssues({
        ...PRODUCTION,
        GRAFT_MODEL_BACKEND: "scripted",
        GRAFT_MODEL_SCRIPT: "./s.json",
      }),
    ).toEqual([
      expect.stringMatching(/scripted.*production/),
      expect.stringMatching(/self-hosted form needs a model/),
    ]);
  });

  it("boots in production with the provider and the key; the hosted form and development are not held to it", () => {
    expect(
      serverEnvIssues({
        ...PRODUCTION,
        GRAFT_MODEL_BACKEND: "provider",
        GRAFT_MODEL_PROVIDER: "anthropic",
        GRAFT_MODEL_API_KEY: "sk-ant-test",
      }),
    ).toEqual([]);
    expect(serverEnvIssues({ NODE_ENV: "production", GRAFT_BACKINGS: "cloud" })).toEqual([]);
    expect(serverEnvIssues({ ...SECRET, NODE_ENV: "development" })).toEqual([]);
    expect(serverEnvIssues({ ...SECRET, NODE_ENV: "test" })).toEqual([]);
  });
});

describe("Langfuse", () => {
  it("is the key pair or nothing, with the region's URL its own setting", () => {
    expect(serverEnvIssues({ ...SECRET, GRAFT_LANGFUSE_PUBLIC_KEY: "pk-lf-1" })).toEqual([
      expect.stringMatching(/Langfuse is partially configured.*Missing: GRAFT_LANGFUSE_SECRET_KEY/),
    ]);
    expect(
      serverEnvIssues({
        ...SECRET,
        GRAFT_LANGFUSE_PUBLIC_KEY: "pk-lf-1",
        GRAFT_LANGFUSE_SECRET_KEY: "sk-lf-1",
      }),
    ).toEqual([]);
    expect(
      fullSchema.parse({
        ...MINIMAL,
        GRAFT_LANGFUSE_PUBLIC_KEY: "pk-lf-1",
        GRAFT_LANGFUSE_SECRET_KEY: "sk-lf-1",
        GRAFT_LANGFUSE_BASE_URL: "https://us.cloud.langfuse.com",
      }),
    ).toMatchObject({ GRAFT_LANGFUSE_BASE_URL: "https://us.cloud.langfuse.com" });
    expect(
      fullSchema.safeParse({
        ...MINIMAL,
        GRAFT_LANGFUSE_PUBLIC_KEY: "pk-lf-1",
        GRAFT_LANGFUSE_SECRET_KEY: "PLACEHOLDER",
      }).success,
    ).toBe(false);
  });
});

describe("the Pipedream provider's group (GRA-59)", () => {
  const PIPEDREAM = {
    GRAFT_PIPEDREAM_PROJECT_ID: "proj_abc123",
    GRAFT_PIPEDREAM_ENVIRONMENT: "development",
    GRAFT_PIPEDREAM_CLIENT_ID: "pd_client",
    GRAFT_PIPEDREAM_CLIENT_SECRET: "pd_secret",
  };

  it("is off by default and the four together, naming what is missing", () => {
    expect(serverEnvIssues(SECRET)).toEqual([]);
    expect(serverEnvIssues({ ...SECRET, ...PIPEDREAM })).toEqual([]);
    const { GRAFT_PIPEDREAM_CLIENT_SECRET: _secret, ...withoutSecret } = PIPEDREAM;
    expect(serverEnvIssues({ ...SECRET, ...withoutSecret })).toEqual([
      expect.stringMatching(
        /Pipedream provider is partially configured.*Missing: GRAFT_PIPEDREAM_CLIENT_SECRET$/,
      ),
    ]);
    expect(serverEnvIssues({ ...SECRET, GRAFT_PIPEDREAM_PROJECT_ID: "proj_abc123" })).toEqual([
      expect.stringMatching(
        /Missing: GRAFT_PIPEDREAM_ENVIRONMENT, GRAFT_PIPEDREAM_CLIENT_ID, GRAFT_PIPEDREAM_CLIENT_SECRET$/,
      ),
    ]);
  });

  it("takes a proj_ id and one of the two environments, naming the variable otherwise", () => {
    expect(pipedreamProjectId.parse("proj_Abc123")).toBe("proj_Abc123");
    expect(pipedreamProjectId.parse(undefined)).toBeUndefined();
    const swapped = pipedreamProjectId.safeParse("pd_client");
    expect(swapped.success).toBe(false);
    expect(swapped.error?.issues[0]?.message).toContain("GRAFT_PIPEDREAM_PROJECT_ID");
    expect(pipedreamEnvironment.parse("production")).toBe("production");
    const bad = pipedreamEnvironment.safeParse("staging");
    expect(bad.success).toBe(false);
    expect(bad.error?.issues[0]?.message).toContain("GRAFT_PIPEDREAM_ENVIRONMENT");
  });

  it("parses the group whole, and refuses a client secret or id still holding the secret store's placeholder", () => {
    expect(fullSchema.parse({ ...MINIMAL, ...PIPEDREAM })).toMatchObject(PIPEDREAM);
    const placeholder = fullSchema.safeParse({
      ...MINIMAL,
      ...PIPEDREAM,
      GRAFT_PIPEDREAM_CLIENT_SECRET: "PLACEHOLDER — populate in the AWS console",
    });
    expect(placeholder.success).toBe(false);
    expect(placeholder.error?.issues.map((issue) => issue.message)).toEqual([
      expect.stringMatching(
        /GRAFT_PIPEDREAM_CLIENT_SECRET still holds the secret store's placeholder/,
      ),
    ]);
    expect(
      fullSchema.safeParse({ ...MINIMAL, ...PIPEDREAM, GRAFT_PIPEDREAM_CLIENT_ID: "PLACEHOLDER" })
        .success,
    ).toBe(false);
  });
});

describe("GRAFT_CONSOLE_DIR", () => {
  it("defaults to the console workspace's build beside the server, and takes any non-empty path", () => {
    expect(consoleDir.parse(undefined)).toBe("../web/dist");
    expect(consoleDir.parse("/srv/graft/console")).toBe("/srv/graft/console");
  });

  it("refuses an empty value, naming the variable", () => {
    const result = consoleDir.safeParse("");
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain("GRAFT_CONSOLE_DIR");
  });
});

describe("the bootstrapped admin (GRA-33)", () => {
  it("takes an email address and a password of Better Auth's minimum, and is optional", () => {
    expect(adminEmail.parse(undefined)).toBeUndefined();
    expect(adminEmail.parse("admin@example.com")).toBe("admin@example.com");
    expect(adminEmail.safeParse("admin").error?.issues[0]?.message).toContain("GRAFT_ADMIN_EMAIL");
    expect(adminPassword.parse("eight-ch")).toBe("eight-ch");
    expect(adminPassword.safeParse("seven77").error?.issues[0]?.message).toContain(
      "GRAFT_ADMIN_PASSWORD",
    );
  });

  it("is all-or-nothing", () => {
    expect(serverEnvIssues({ ...SECRET, GRAFT_ADMIN_EMAIL: "admin@example.com" })).toEqual([
      expect.stringMatching(/admin is partially configured.*Missing: GRAFT_ADMIN_PASSWORD/),
    ]);
    expect(serverEnvIssues({ ...SECRET, GRAFT_ADMIN_PASSWORD: "change-me-please" })).toEqual([
      expect.stringMatching(/Missing: GRAFT_ADMIN_EMAIL/),
    ]);
    expect(
      serverEnvIssues({
        ...SECRET,
        GRAFT_ADMIN_EMAIL: "admin@example.com",
        GRAFT_ADMIN_PASSWORD: "change-me-please",
      }),
    ).toEqual([]);
  });
});

describe("GRAFT_MIGRATE_ON_START", () => {
  it("is on unless said otherwise, and reads a stringbool", () => {
    expect(migrateOnStart.parse(undefined)).toBe(true);
    expect(migrateOnStart.parse("false")).toBe(false);
    expect(migrateOnStart.parse("0")).toBe(false);
    expect(migrateOnStart.safeParse("later").success).toBe(false);
  });
});

describe("describeEnvIssues", () => {
  it("names the variable on every line, says 'is not set' for a missing one, and keeps a cross-field sentence whole", () => {
    const text = describeEnvIssues([
      {
        path: ["GRAFT_AUTH_SECRET"],
        message: "Invalid input: expected string, received undefined",
      },
      { path: ["GRAFT_AUTH_URL"], message: "GRAFT_AUTH_URL must be an absolute http(s) URL" },
      { message: "The bootstrapped admin is partially configured — set both or neither." },
    ]);
    expect(text.split("\n")).toEqual([
      "GRAFT_AUTH_SECRET is not set",
      "GRAFT_AUTH_URL must be an absolute http(s) URL",
      "The bootstrapped admin is partially configured — set both or neither.",
    ]);
  });

  it("prefixes a message that does not already name its variable", () => {
    expect(describeEnvIssues([{ path: [{ key: "PORT" }], message: "Too small" }])).toBe(
      "PORT: Too small",
    );
  });
});
