import { z } from "zod";

/**
 * The server's environment, as rules — pure, so every rule below has a test that does not boot a
 * process. `server.ts` is the one file that reads `process.env`, through `createEnv`, and it
 * imports the shapes from here. The posture is Cando's (ADR 0011): configuration errors fail at
 * boot with a sentence naming the variable, runtime errors degrade; a group of settings that only
 * makes sense complete is refused when half-set, because a partial set is always a typo or a
 * half-finished deploy and would otherwise present as a feature that silently never works.
 *
 * Every Graft variable is `GRAFT_*`. Later tickets add to this file: the sandbox (GRA-4), the model
 * adapter (GRA-29).
 */

/**
 * A PEM block as an environment value — the capability token key pair's shape (`@graft/token`).
 *
 * `openssl genpkey -algorithm ed25519` emits the private key as PKCS#8 (`-----BEGIN PRIVATE
 * KEY-----`) and `openssl pkey -pubout` the public key as SPKI (`-----BEGIN PUBLIC KEY-----`),
 * which is what jose imports, and this checks for exactly those labels. A `.env` file cannot hold a
 * real newline inside a value, so a literal `\n` sequence is accepted and unescaped — a container's
 * environment carries real newlines, and both spellings leave here as one canonical block. A key in
 * another format fails the shape, so a mis-pasted key fails boot with a sentence naming the variable
 * rather than at the first mint.
 */
export function pemKey(label: "PRIVATE KEY" | "PUBLIC KEY", name: string) {
  const pattern = new RegExp(
    `^-----BEGIN ${label}-----\\n[A-Za-z0-9+/=\\n]+\\n-----END ${label}-----$`,
  );
  const kind = label === "PRIVATE KEY" ? "PKCS#8 Ed25519 private key" : "SPKI Ed25519 public key";
  return z
    .string()
    .transform((raw, ctx) => {
      const pem = raw.replace(/\\n/g, "\n").replace(/\r/g, "").trim();
      if (!pattern.test(pem)) {
        ctx.addIssue({
          code: "custom",
          message: `${name} must be a PEM-encoded ${kind} (-----BEGIN ${label}----- … -----END ${label}-----), with real or \\n-escaped line breaks`,
        });
        return z.NEVER;
      }
      return `${pem}\n`;
    })
    .optional();
}

export const capabilityTokenPrivateKey = pemKey(
  "PRIVATE KEY",
  "GRAFT_CAPABILITY_TOKEN_PRIVATE_KEY",
);
export const capabilityTokenPublicKey = pemKey("PUBLIC KEY", "GRAFT_CAPABILITY_TOKEN_PUBLIC_KEY");

/**
 * The capability token key pair, all-or-nothing.
 *
 * Individually optional so a deploy without them boots and only the proxy is unavailable — it
 * answers 503 `proxy_unconfigured`, and nothing mints a token. A *partial* pair is a half-finished
 * deploy: a private key alone would mint tokens the proxy cannot verify, a public key alone would
 * verify tokens nobody can mint, and either presents as every vendor call failing with nothing in
 * the boot log to say why. `GRAFT_PROXY_PUBLIC_URL` and `GRAFT_PROXY_FOLLOW_REDIRECTS` sit outside
 * the group because each has a correct default.
 */
export const capabilityTokenKeys = [
  "GRAFT_CAPABILITY_TOKEN_PRIVATE_KEY",
  "GRAFT_CAPABILITY_TOKEN_PUBLIC_KEY",
] as const;

/**
 * The local keyring's seed (`@graft/vault`, ADR 0002's self-hosted backing). Required, not
 * optional, and the reason is the direction of the failure: every optional feature in this file
 * degrades safely when absent, but a vault with no key cannot degrade — the alternative to
 * encrypting a person's API key is storing it in the clear — so a deploy that forgot the secret
 * must fail to boot rather than start accepting credentials. Thirty-two characters because the key
 * is derived from it by a plain hash, so the secret has to carry the entropy itself. The hosted
 * form's KMS keyring (GRA-20) will bring its own variable and loosen this one.
 */
export const keyringSecret = z
  .string()
  .min(
    32,
    "GRAFT_KEYRING_SECRET must be at least 32 characters — the local keyring derives its key from it",
  );

/**
 * The database (GRA-6). Required, for the same reason the keyring secret is: nothing degrades
 * without one — the person's account, every agent and every connection live there, so a server with
 * no database has nothing to serve and should say so at boot. A connection string, not a URL in
 * zod's sense: `postgresql://user:pass@host:5432/db` carries credentials `z.url()` would refuse.
 */
export const databaseUrl = z
  .string()
  .regex(
    /^postgres(ql)?:\/\/.+/,
    "GRAFT_DATABASE_URL must be a postgres:// or postgresql:// connection string",
  );

/**
 * Better Auth's secret — it signs every session cookie and token (`@graft/auth`). Thirty-two
 * characters for the reason `keyringSecret` gives, and a separate variable from it on purpose: the
 * two guard different things, and a deployment that rotates one must not have to rotate the other.
 */
export const authSecret = z
  .string()
  .min(32, "GRAFT_AUTH_SECRET must be at least 32 characters — Better Auth signs sessions with it");

/**
 * Where Better Auth answers — the server's own public origin, which its callback and cookie logic
 * need to know as an absolute URL. Required rather than derived from `PORT`: behind a proxy or a
 * domain the port says nothing about the origin a browser sees, and a wrong value here presents as
 * every sign-in failing with nothing in the boot log to say why.
 */
export const authUrl = z.url({
  protocol: /^https?$/,
  error: "GRAFT_AUTH_URL must be an absolute http(s) URL — the server's public origin",
});

/**
 * The console's origins, as a comma-separated list of origins — `http://localhost:3001` — or unset
 * for a deployment with no console yet. Each entry is checked to be an origin and nothing more: a
 * path or a trailing slash would make the CORS and `trustedOrigins` comparison silently never match.
 * Parsed to a list here, so no consumer splits the string a second time.
 */
export const corsOrigins = z
  .string()
  .optional()
  .transform((raw, ctx) => {
    if (raw === undefined) return [] as string[];
    const origins = raw
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    for (const origin of origins) {
      let parsed: URL;
      try {
        parsed = new URL(origin);
      } catch {
        ctx.addIssue({
          code: "custom",
          message: `GRAFT_CORS_ORIGIN entry "${origin}" is not a URL`,
        });
        return z.NEVER;
      }
      if (parsed.origin !== origin) {
        ctx.addIssue({
          code: "custom",
          message: `GRAFT_CORS_ORIGIN entry "${origin}" must be an origin — scheme, host and port, no path or trailing slash (${parsed.origin})`,
        });
        return z.NEVER;
      }
    }
    return [...new Set(origins)];
  });

/**
 * Which backing authored code runs on (ADR 0002: every seam has two backings behind one interface).
 * `docker` — `@graft/sandbox-docker`, the self-hosted form's — by default. `fake` is the in-process
 * directory `@graft/sandbox` ships for unit tests, allowed here so a laptop without a daemon can
 * drive the MCP endpoint end to end, and refused under `NODE_ENV=production` (`serverEnvIssues`):
 * it is a directory, not a sandbox, and a run in it reaches whatever the server process can.
 */
export const sandboxBackend = z.enum(["docker", "fake"]).default("docker");

/**
 * What the Docker backing needs: the prebuilt image (`pnpm --filter @graft/sandbox-docker
 * image:build` tags this default) and the `internal: true` network whose only other member is the
 * proxy — compose names it `<project>_sandbox`, so the default assumes a project called `graft`.
 * Neither is checked at boot: the backing inspects the network at the first sandbox, where a
 * misconfiguration refuses one run rather than the whole server (`packages/sandbox-docker/README.md`).
 */
export const sandboxImage = z.string().min(1).default("graft-sandbox:dev");
export const sandboxNetwork = z.string().min(1).default("graft_sandbox");

/** `PORT` when set, 3000 otherwise: what the dev server listens on and what the proxy URL defaults to. */
export const port = z.coerce.number().int().min(1).max(65535).default(3000);

/**
 * Where the proxy answers when `GRAFT_PROXY_PUBLIC_URL` is unset: the server's own origin on the
 * port it listens on, at the path `apps/server` mounts it. A sandbox is handed this value, never a
 * URL written into agent code, so moving the proxy to its own host later is this one variable
 * (GRA-1, "the proxy separable from the server by DNS alone").
 */
export function defaultProxyPublicUrl(listeningPort: number): string {
  return `http://localhost:${listeningPort}/api/proxy`;
}

/**
 * A group of settings that only makes sense complete. Factored so a second hand-written copy of
 * this comparison is not where two groups drift — one of them getting the `present.length === 0`
 * case wrong and reporting every unconfigured deploy as broken.
 */
function partialGroupIssue(
  value: Record<string, unknown>,
  sentence: string,
  keys: readonly string[],
): string | null {
  const present = keys.filter((key) => value[key] !== undefined);
  if (present.length === 0 || present.length === keys.length) return null;

  const missing = keys.filter((key) => value[key] === undefined);
  return `${sentence} Missing: ${missing.join(", ")}`;
}

/**
 * Cross-field rules, as a pure function so they can be tested without booting the module.
 * `createEnv` runs at import time against the real `process.env`, which makes the rules below
 * awkward to exercise any other way — and they are exactly the kind of logic that is easy to get
 * subtly wrong and impossible to notice until a deploy is already broken.
 */
export function serverEnvIssues(value: Record<string, unknown>): string[] {
  const issues: string[] = [];

  const partial = partialGroupIssue(
    value,
    "The capability token key pair is partially configured — set both the private and the public key or neither.",
    capabilityTokenKeys,
  );
  if (partial) issues.push(partial);

  /**
   * The seed file is for a laptop: connections with their plaintext credentials in a JSON file the
   * server encrypts into memory at boot (`apps/server/src/connections.ts`). In production the
   * connections come from the database (GRA-6) and a credential on disk is exactly what the vault
   * exists to prevent. Refused at boot, where a misconfiguration is cheap.
   */
  if (value.NODE_ENV === "production" && value.GRAFT_DEV_SEED !== undefined) {
    issues.push(
      "GRAFT_DEV_SEED is the development seed file and is refused under NODE_ENV=production.",
    );
  }

  // The fake backing is a directory on the server's own disk — see `sandboxBackend`.
  if (value.NODE_ENV === "production" && value.GRAFT_SANDBOX_BACKEND === "fake") {
    issues.push(
      "GRAFT_SANDBOX_BACKEND=fake is the in-process test backing and is refused under NODE_ENV=production; use docker.",
    );
  }

  return issues;
}

/**
 * The default that depends on another key: `GRAFT_PROXY_PUBLIC_URL` from `PORT`. A `.default()` on
 * the field cannot see another key, so `finalServerSchema` applies this after the object parses; a
 * pure function so the composition — not just each default alone — has a test.
 */
export function withDerivedDefaults<T extends { PORT: number; GRAFT_PROXY_PUBLIC_URL?: string }>(
  value: T,
): T & { GRAFT_PROXY_PUBLIC_URL: string } {
  return {
    ...value,
    GRAFT_PROXY_PUBLIC_URL: value.GRAFT_PROXY_PUBLIC_URL ?? defaultProxyPublicUrl(value.PORT),
  };
}

export const serverSchema = {
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: port,

  /** The database, required — see `databaseUrl`. */
  GRAFT_DATABASE_URL: databaseUrl,

  /** Better Auth's secret and public origin, both required — see `authSecret` and `authUrl`. */
  GRAFT_AUTH_SECRET: authSecret,
  GRAFT_AUTH_URL: authUrl,

  /** The console's origins, optional — a list once parsed, see `corsOrigins`. */
  GRAFT_CORS_ORIGIN: corsOrigins,

  /** The local keyring's seed — see `keyringSecret` for why this one is required. */
  GRAFT_KEYRING_SECRET: keyringSecret,

  /**
   * The capability token signing key, PKCS#8 PEM — the secret half of the pair `@graft/token`
   * imports. All-or-nothing with the public key — see `capabilityTokenKeys`.
   */
  GRAFT_CAPABILITY_TOKEN_PRIVATE_KEY: capabilityTokenPrivateKey,

  /**
   * The matching verification key, SPKI PEM — plain environment, not a secret: the proxy also
   * publishes it at `/api/proxy/.well-known/jwks.json`. Held separately from the private key rather
   * than derived from it so a verify-only deployment (a standalone proxy, later) needs only this one.
   */
  GRAFT_CAPABILITY_TOKEN_PUBLIC_KEY: capabilityTokenPublicKey,

  /**
   * The proxy's public base URL — what a sandbox is handed as the origin of every vendor call
   * (ADR 0010). Unset means `http://localhost:<PORT>/api/proxy`, where the dev server answers;
   * `finalServerSchema` fills that in, because it derives from another key. A URL, not an origin:
   * the mount path is part of what the sandbox needs.
   */
  GRAFT_PROXY_PUBLIC_URL: z.url().optional(),

  /**
   * The proxy's break glass (GRA-1, "The proxy and the capability token"): follow a vendor redirect
   * when it stays inside the connection's host set. Off by default, and it exists only so a vendor
   * that insists on redirects can be unblocked by a configuration change rather than a deploy of
   * new code. Even on, only hops inside the set are followed, and only three deep.
   */
  GRAFT_PROXY_FOLLOW_REDIRECTS: z.stringbool().default(false),

  /**
   * A JSON file of connections to seed the in-memory store with at boot — development only, refused
   * in production (`serverEnvIssues`). `apps/server/src/connections.ts` has the shape.
   */
  GRAFT_DEV_SEED: z.string().min(1).optional(),

  /** The sandbox backing and what the Docker one needs — see `sandboxBackend`. */
  GRAFT_SANDBOX_BACKEND: sandboxBackend,
  GRAFT_SANDBOX_IMAGE: sandboxImage,
  GRAFT_SANDBOX_NETWORK: sandboxNetwork,
};

/** The object schema `createEnv` is handed: the fields, the cross-field rules, the derived default. */
export function finalServerSchema<T extends z.ZodRawShape>(shape: T) {
  return z
    .object(shape)
    .check((ctx) => {
      for (const message of serverEnvIssues(ctx.value)) {
        ctx.issues.push({ code: "custom", input: ctx.value, message });
      }
    })
    .transform((value) => withDerivedDefaults(value as z.infer<z.ZodObject<T>> & { PORT: number }));
}
