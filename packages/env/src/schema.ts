import { z } from "zod";

/**
 * The server's environment, as rules — pure, so every rule below has a test that does not boot a
 * process. `server.ts` is the one file that reads `process.env`, through `createEnv`, and it
 * imports the shapes from here. The posture is Cando's (ADR 0011): configuration errors fail at
 * boot with a sentence naming the variable, runtime errors degrade; a group of settings that only
 * makes sense complete is refused when half-set, because a partial set is always a typo or a
 * half-finished deploy and would otherwise present as a feature that silently never works.
 *
 * Every Graft variable is `GRAFT_*`.
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
 * The local keyring's seed (`@graft/vault`, ADR 0002's self-hosted backing). Required whenever the
 * open backings are selected — `GRAFT_BACKINGS=open`, the default; `serverEnvIssues` holds the
 * rule — and the reason is the direction of the failure: every optional feature in this file
 * degrades safely when absent, but a vault with no key cannot degrade — the alternative to
 * encrypting a person's API key is storing it in the clear — so a deploy that forgot the secret
 * must fail to boot rather than start accepting credentials. Thirty-two characters because the key
 * is derived from it by a plain hash, so the secret has to carry the entropy itself. Optional as a
 * field only because the hosted form's keyring arrives with the private package and its own
 * configuration (GRA-20): a secret nothing in that deployment reads would be a lie in its
 * environment, and the cross-field rule keeps the failure direction for the form that does read it.
 */
export const keyringSecret = z
  .string()
  .min(
    32,
    "GRAFT_KEYRING_SECRET must be at least 32 characters — the local keyring derives its key from it",
  )
  .optional();

/**
 * Which backings the server puts behind its three seams — sandbox, keyring, toolbox mirror
 * (ADR 0002): `open`, the backings this repository holds, or `cloud`, the hosted form's from the
 * private package placed at `packages/cloud-backings/`. `apps/server/src/backings.ts` does the
 * selecting; this only validates the word. Default `open`, so a checkout without the private
 * package boots as the self-hosted form, and `NODE_ENV=production` with `open` is that form
 * deployed rather than a misconfiguration. `cloud` without the package fails at boot with a
 * sentence from the selector, not from here: the environment cannot see what is installed.
 */
export const backingsForm = z.enum(["open", "cloud"]).default("open");

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
 * Which of the open form's backings authored code runs on (ADR 0002: every seam has two backings
 * behind one interface; under `GRAFT_BACKINGS=cloud` the private package's sandbox is used and this
 * is not read). `docker` — `@graft/sandbox-docker`, the self-hosted form's — by default, which needs the
 * `GRAFT_SANDBOX_IMAGE`/`GRAFT_SANDBOX_NETWORK` pair (`sandboxKeys`); without the pair the server
 * boots with no sandbox and every run refuses, saying so. `fake` is the in-process directory
 * `@graft/sandbox` ships for unit tests, allowed here so a laptop without a daemon can drive the MCP
 * endpoint end to end, and refused under `NODE_ENV=production` (`serverEnvIssues`): it is a
 * directory, not a sandbox, and a run in it reaches whatever the server process can.
 */
export const sandboxBackend = z.enum(["docker", "fake"]).default("docker");

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
 * Where the server keeps every person's toolbox as files (`@graft/toolbox`, ADR 0002's self-hosted
 * backing of the storage seam): one directory per toolbox id under this root. Relative to the
 * server's working directory when not absolute; the store resolves it. The default suits a laptop
 * and is gitignored; a deployment sets an absolute path that is also the Docker backing's
 * `toolboxHostRoot`, so the sandboxes mount the same tree.
 */
export const toolboxRoot = z
  .string()
  .min(1, "GRAFT_TOOLBOX_ROOT must name a directory")
  .default("./.graft/toolboxes");

/**
 * The named Docker volume `GRAFT_TOOLBOX_ROOT` is mounted from, when the server itself runs in a
 * container beside the daemon it creates sandboxes on — the compose file (GRA-33). Set, the Docker
 * backing mounts each toolbox into its sandboxes as a subpath of this one volume
 * (`@graft/sandbox-docker`'s `toolboxVolume`), so the tree the server writes and the tree a sandbox
 * mounts are one. Unset, the backing binds `GRAFT_TOOLBOX_ROOT/<toolbox>` from the host, which is
 * right for a server running on the host itself. A volume name, not a path.
 */
export const toolboxVolume = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/,
    "GRAFT_TOOLBOX_VOLUME must be a Docker volume name — letters, digits, '.', '_' and '-'",
  )
  .optional();

/**
 * The package policy's two thresholds (ADR 0013; `@graft/publish`'s `evaluatePackage`): a package
 * off the allowlist installs only with npm provenance *and* at least this many days since its first
 * publish *and* at least this many downloads last week. Whole numbers, zero allowed — a laptop
 * testing the install step against a fresh package sets both to `0` rather than editing code.
 */
export const packageMinAgeDays = z.coerce
  .number({ error: "GRAFT_PACKAGE_MIN_AGE_DAYS must be a whole number of days" })
  .int("GRAFT_PACKAGE_MIN_AGE_DAYS must be a whole number of days")
  .min(0, "GRAFT_PACKAGE_MIN_AGE_DAYS must be zero or more")
  .default(90);

export const packageMinWeeklyDownloads = z.coerce
  .number({ error: "GRAFT_PACKAGE_MIN_WEEKLY_DOWNLOADS must be a whole number" })
  .int("GRAFT_PACKAGE_MIN_WEEKLY_DOWNLOADS must be a whole number")
  .min(0, "GRAFT_PACKAGE_MIN_WEEKLY_DOWNLOADS must be zero or more")
  .default(1000);

/**
 * An npm package name, or a scope pattern `@scope/*` — the shape an allowlist entry takes. A bare
 * `*` is not one: an allowlist of everything is no policy. The other holder of the name rule is
 * `@graft/publish`'s `isValidPackageName`, which this package cannot import (the environment is a
 * leaf); the two must agree on what a name may be.
 */
const ALLOWLIST_ENTRY =
  /^(@[a-z0-9][a-z0-9._~-]*\/([a-z0-9][a-z0-9._~-]*|\*)|[a-z0-9][a-z0-9._~-]*)$/;

/**
 * Names added to the package policy's allowlist for this deployment, comma-separated — exact package
 * names or `@scope/*`. The default allowlist is the official vendor SDKs in `@graft/publish`'s
 * `DEFAULT_PACKAGE_ALLOWLIST` and grows through the review queue (ADR 0013); this is how a
 * deployment admits one ahead of a release. Parsed to a list here, so no consumer splits the string.
 */
export const packageAllowlist = z
  .string()
  .optional()
  .transform((raw, ctx) => {
    if (raw === undefined) return [] as string[];
    const names = raw
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    for (const name of names) {
      if (!ALLOWLIST_ENTRY.test(name) || name.length > 214) {
        ctx.addIssue({
          code: "custom",
          message: `GRAFT_PACKAGE_ALLOWLIST entry "${name}" is not a package name or a scope pattern like @scope/*`,
        });
        return z.NEVER;
      }
    }
    return [...new Set(names)];
  });

/**
 * Where the console's build is (`apps/web`, GRA-26): the directory `vite build` wrote, which
 * `apps/server` serves same-origin with the API so the session cookie never crosses an origin
 * (`apps/server/src/console.ts`). Relative to the server's working directory when not absolute,
 * like `GRAFT_TOOLBOX_ROOT`; the default is the sibling workspace's `dist`, where a checkout that ran
 * `pnpm run build` has it. A directory with no build in it is not a boot failure — the server serves
 * the API and answers every console path with a JSON 404 saying so — because the API is whole
 * without the console, and a deployment that serves the console from elsewhere is legitimate.
 */
export const consoleDir = z
  .string()
  .min(1, "GRAFT_CONSOLE_DIR must name a directory")
  .default("../web/dist");

/**
 * How often the working-set sweep runs (ADR 0009; "@graft/mcp"'s `startSweep`): on this cadence the
 * server contracts every agent's working set by its cap and idle window, from a plain timer in the
 * process (GRA-1: no durable engine for the alpha). Five minutes by default — a window is days long
 * and a cap is exceeded only by a promotion the agent just made, so nothing here is urgent, and a
 * sweep is two reads per agent. Whole seconds, at least one; a fraction is a typo.
 */
export const sweepIntervalSeconds = z.coerce
  .number({ error: "GRAFT_SWEEP_INTERVAL_SECONDS must be a whole number of seconds" })
  .int("GRAFT_SWEEP_INTERVAL_SECONDS must be a whole number of seconds")
  .min(1, "GRAFT_SWEEP_INTERVAL_SECONDS must be at least one second")
  .default(300);

/**
 * How many drafts one `acquire` job may make before it gives up (ADR 0004: attempts are bounded by
 * count; ADR 0012, L1: a failed dry run is diagnosed and retried inside the job). Every module the
 * model writes is an attempt — a draft the check refuses spends one as surely as a draft whose dry
 * run fails — so four rather than three: one to learn the check's rules, one to learn the vendor's,
 * and two to be wrong about something else. A whole number, at least one; bounded above because a
 * job that drafts twenty times is not converging, it is spending.
 */
export const acquireMaxAttempts = z.coerce
  .number({ error: "GRAFT_ACQUIRE_MAX_ATTEMPTS must be a whole number of attempts" })
  .int("GRAFT_ACQUIRE_MAX_ATTEMPTS must be a whole number of attempts")
  .min(1, "GRAFT_ACQUIRE_MAX_ATTEMPTS must be at least 1")
  .max(20, "GRAFT_ACQUIRE_MAX_ATTEMPTS must be at most 20")
  .default(4);

/**
 * The most tokens one `acquire` job may spend, input and output summed across every model turn
 * (ADR 0004, ADR 0014: acquisition is the unit of price, so its cost has a ceiling). A job that
 * reaches it ends with a result naming the ceiling. Four hundred thousand fits a documentation page
 * or three at four thousand tokens each, the skill, and a handful of drafts with their diagnoses, and
 * is well under what a provider's context would let a runaway loop reach. At least a thousand — a
 * lower figure ends every job on its first turn, which is a typo.
 */
export const acquireTokenCeiling = z.coerce
  .number({ error: "GRAFT_ACQUIRE_TOKEN_CEILING must be a whole number of tokens" })
  .int("GRAFT_ACQUIRE_TOKEN_CEILING must be a whole number of tokens")
  .min(1_000, "GRAFT_ACQUIRE_TOKEN_CEILING must be at least 1000")
  .default(400_000);

/**
 * How many `acquire` jobs the in-process runner works at once (`@graft/mcp`'s `acquire/runner.ts`;
 * GRA-1: no durable engine for the alpha). Each job holds a sandbox, a model conversation and a
 * publish; two lets a second agent's job start while the first waits on a vendor, and keeps a
 * laptop's Docker daemon at two containers. Bounded above so a typo cannot ask one process for a
 * hundred concurrent sandboxes.
 */
export const acquireConcurrency = z.coerce
  .number({ error: "GRAFT_ACQUIRE_CONCURRENCY must be a whole number of jobs" })
  .int("GRAFT_ACQUIRE_CONCURRENCY must be a whole number of jobs")
  .min(1, "GRAFT_ACQUIRE_CONCURRENCY must be at least 1")
  .max(32, "GRAFT_ACQUIRE_CONCURRENCY must be at most 32")
  .default(2);

/**
 * Which model answers `acquire` (ADR 0004; `@graft/model`'s adapter seam, ADR 0002). Unset, the
 * server boots with no model and `acquire` refuses `acquire_unconfigured`, saying so — the sandbox's
 * posture, and allowed only outside production under the open backings (`serverEnvIssues`).
 * `scripted` is `@graft/model/scripted` playing the JSON file `GRAFT_MODEL_SCRIPT` names, for a
 * laptop driving the whole loop without a provider key; it is a canned answer sheet, not a model,
 * and is refused under `NODE_ENV=production`. `provider` is `@graft/model/provider`: a real
 * provider through the AI SDK, configured by `GRAFT_MODEL_PROVIDER` and `GRAFT_MODEL_API_KEY`
 * (`modelProviderKeys`), with the two model ids and the base URL optional beside them.
 */
export const modelBackend = z.enum(["scripted", "provider"]).optional();

/** The scripted model's script, all-or-nothing with `GRAFT_MODEL_BACKEND=scripted` — see `modelBackend`. */
export const modelScriptKeys = ["GRAFT_MODEL_BACKEND", "GRAFT_MODEL_SCRIPT"] as const;

/**
 * The provider behind `GRAFT_MODEL_BACKEND=provider` — `@graft/model/provider`'s two: Anthropic, or
 * OpenAI, which through `GRAFT_MODEL_BASE_URL` also covers an OpenAI-compatible gateway. The word
 * is validated here; the model ids are not — a provider's catalogue is not something this schema
 * can know, so a wrong id fails the first job with the provider's own sentence.
 */
export const modelProvider = z.enum(["anthropic", "openai"]).optional();

/**
 * The provider-backed model's two required settings, read together under
 * `GRAFT_MODEL_BACKEND=provider` and nowhere else — a provider named with no key can call nothing,
 * a key with no provider names nothing to call. `GRAFT_MODEL_AUTHORING` and `GRAFT_MODEL_TRIAGE`
 * (`modelProviderOptionalKeys`) default per provider in `@graft/model/provider`'s
 * `PROVIDER_MODEL_DEFAULTS` — for Anthropic `claude-fable-5-1` and `claude-haiku-4-5-20251001`,
 * for OpenAI `gpt-5.6-sol` (the model Cando ships in production for the same work) and
 * `gpt-5.4-mini` — and `GRAFT_MODEL_BASE_URL` has no default. Any of the five set while
 * `GRAFT_MODEL_BACKEND` is not `provider` is refused: nothing would read it, and a deploy that
 * meant to turn the model on would find `acquire` refusing `acquire_unconfigured` with the key
 * sitting in the environment.
 */
export const modelProviderKeys = ["GRAFT_MODEL_PROVIDER", "GRAFT_MODEL_API_KEY"] as const;
export const modelProviderOptionalKeys = [
  "GRAFT_MODEL_AUTHORING",
  "GRAFT_MODEL_TRIAGE",
  "GRAFT_MODEL_BASE_URL",
] as const;

/**
 * Langfuse (`@graft/model/langfuse`), all-or-nothing: with the pair, every model call `acquire`
 * makes is traced under the job, the person and the attempt; without it nothing is traced and the
 * call is exactly what it would be otherwise. `GRAFT_LANGFUSE_BASE_URL` sits outside the group
 * because it has a correct default — the SDK's, the EU cloud — and a region is not a half-finished
 * deploy. The shape and the reasons are Cando's (ADR 0011).
 */
export const langfuseKeys = ["GRAFT_LANGFUSE_PUBLIC_KEY", "GRAFT_LANGFUSE_SECRET_KEY"] as const;

/**
 * A secret as an environment value: non-empty, and not the placeholder a secrets store leaves in a
 * variable nobody has populated. A placeholder would pass every other check and fail at the first
 * call with the provider's own error, far from the boot log; refused here it is one sentence.
 */
export function secretValue(name: string) {
  return z
    .string()
    .min(1, `${name} must not be empty`)
    .refine(
      (value) => !value.startsWith("PLACEHOLDER"),
      `${name} still holds the secret store's placeholder; populate it or unset it`,
    )
    .optional();
}

/**
 * The Docker sandbox backing's two settings (`@graft/sandbox-docker`, ADR 0002), all-or-nothing:
 * the prebuilt image sandboxes are created from, and the internal network they join. Individually
 * optional so a server with no Docker boots and only the sandbox is unavailable — a publish that
 * declares packages then refuses with a diagnostic saying no backing is configured — but a partial
 * pair is a half-finished deploy and would present as every install failing with nothing at boot to
 * say why.
 */
export const sandboxKeys = ["GRAFT_SANDBOX_IMAGE", "GRAFT_SANDBOX_NETWORK"] as const;

/**
 * Where the console answers (CONTEXT.md, *Console*) — the base every handoff URL is built on
 * (ADR 0006: a meta-tool returns a URL the person opens in the console). Required, because a
 * handoff URL is how an approval reaches a person whose harness cannot ask in place, and a server
 * that cannot build one would answer every such call with a refusal that reads as a broken tool.
 * An absolute URL rather than an origin: a console served under a path is a legitimate deployment.
 */
export const consoleUrl = z.url({
  protocol: /^https?$/,
  error:
    "GRAFT_CONSOLE_URL must be an absolute http(s) URL — where the console answers, the base of every handoff URL",
});

/**
 * What signs a handoff URL (`@graft/mcp`'s `handoff.ts`; ADR 0006: the URL is a phishing-shaped
 * artefact, so it is signed and bound to the agent that requested it). Thirty-two characters for the
 * reason `keyringSecret` gives, and its own variable rather than the auth secret because a rotation
 * of one must not force the other: rotating this one only invalidates links not yet opened.
 */
export const handoffSecret = z
  .string()
  .min(32, "GRAFT_HANDOFF_SECRET must be at least 32 characters — handoff URLs are signed with it");

/**
 * How long a tool call waits for the person to answer a handoff before returning
 * `awaiting_approval` (GRA-23). Under the tool-call timeout of every known harness by a margin, so
 * the answer the agent relays is Graft's own sentence and not a transport error; zero returns at
 * once. Bounded above because a call held for minutes is the client-compatibility risk ADR 0004
 * names.
 */
export const approvalWaitSeconds = z.coerce
  .number({ error: "GRAFT_APPROVAL_WAIT_SECONDS must be a whole number of seconds" })
  .int("GRAFT_APPROVAL_WAIT_SECONDS must be a whole number of seconds")
  .min(0, "GRAFT_APPROVAL_WAIT_SECONDS must be zero or more")
  .max(
    300,
    "GRAFT_APPROVAL_WAIT_SECONDS must be at most 300 — a tool call cannot be held for longer",
  )
  .default(25);

/**
 * How long a pending action stays answerable (ADR 0006: the person may answer hours later). A day
 * by default; at most the week `@graft/core`'s pending-action service allows, so a value here can
 * never be one the service refuses at the first ask.
 */
export const pendingActionTtlHours = z.coerce
  .number({ error: "GRAFT_PENDING_ACTION_TTL_HOURS must be a whole number of hours" })
  .int("GRAFT_PENDING_ACTION_TTL_HOURS must be a whole number of hours")
  .min(1, "GRAFT_PENDING_ACTION_TTL_HOURS must be at least 1")
  .max(168, "GRAFT_PENDING_ACTION_TTL_HOURS must be at most 168 — one week")
  .default(24);

/**
 * The admin bootstrapped on first start (GRA-1, user story 28; GRA-33): the one account a fresh
 * self-hosted database opens with, so the person who ran `docker compose up` can sign in without a
 * sign-up form facing the network first. Both optional — a laptop signs up through the console — and
 * all-or-nothing (`adminKeys`), because an email with no password would present as a console nobody
 * can enter. Read once, by `apps/server/src/boot.ts`, and only while the database holds no person;
 * a later change to either variable changes nothing, and the boot line says so.
 */
export const adminEmail = z
  .email({
    error: "GRAFT_ADMIN_EMAIL must be an email address — the account bootstrapped on first start",
  })
  .optional();

/** Eight characters is Better Auth's own floor; a shorter value would fail the sign-up, not the boot. */
export const adminPassword = z
  .string()
  .min(
    8,
    "GRAFT_ADMIN_PASSWORD must be at least 8 characters — Better Auth refuses a shorter password",
  )
  .optional();

export const adminKeys = ["GRAFT_ADMIN_EMAIL", "GRAFT_ADMIN_PASSWORD"] as const;

/**
 * Whether the server applies the committed migrations before it listens (GRA-33). On by default,
 * because the self-hosted image is the one process that ever touches its database, and a compose
 * file with a separate migration step is a step somebody forgets. Off is for the development loop
 * that moves the schema with `db:push`: a pushed database has no migration ledger, so the migrator
 * would try to create tables that exist and refuse to start. `apps/server/src/boot.ts` runs it.
 */
export const migrateOnStart = z.stringbool().default(true);

/**
 * The gateway provider (ADR 0019, GRA-58): a company's API gateway fronts the vendors it covers and
 * holds their credentials, and a vendor whose hosts it covers connects with no person step and
 * relays every call through it. Four settings, all-or-nothing (`gatewayKeys`) and off by default —
 * a deployment without them has the keyring alone, exactly as before — because each without the
 * others is a half-finished setup: covered hosts with nowhere to relay to, an upstream that would
 * refuse every call for want of the identity header, a header with no gateway to present it to.
 *
 * The hosts are a comma-separated list, each an exact hostname (`api.vendor.example`) or a wildcard
 * suffix (`*.googleapis.com`, any host at least one label under it); lower-cased and de-duplicated
 * here so the provider compares what the operator wrote once. A bare `*` is refused — a gateway that
 * covers every vendor would shadow the keyring for every proposal, which is a decision to make by
 * naming the hosts, not by a wildcard that also catches a typo.
 */
/** A DNS name: labels of letters, digits and hyphens, dot-separated, no port, no scheme. */
const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

export const gatewayHosts = z
  .string()
  .transform((raw, ctx) => {
    const entries = raw
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.length > 0);
    if (entries.length === 0) {
      ctx.addIssue({
        code: "custom",
        message: "GRAFT_GATEWAY_HOSTS must name at least one vendor host the gateway covers",
      });
      return z.NEVER;
    }
    for (const entry of entries) {
      const host = entry.startsWith("*.") ? entry.slice(2) : entry;
      if (!HOSTNAME.test(host) || !host.includes(".")) {
        ctx.addIssue({
          code: "custom",
          message: `GRAFT_GATEWAY_HOSTS entry ${JSON.stringify(entry)} is not a hostname or a *.suffix pattern — expected something like api.vendor.example or *.googleapis.com`,
        });
        return z.NEVER;
      }
    }
    return [...new Set(entries)];
  })
  .optional();

/**
 * Where the gateway answers: an absolute URL with an origin and an optional base path, and nothing
 * a relayed request would have to merge with — no query, no fragment, no credentials in the URL.
 * `http` is admitted here so a laptop can point at a fake gateway on a loopback port, and refused
 * under `NODE_ENV=production` by `serverEnvIssues`: the identity header is a secret, and a
 * production deployment does not send one in the clear.
 */
export const gatewayUpstreamUrl = z
  .url({
    protocol: /^https?$/,
    error:
      "GRAFT_GATEWAY_UPSTREAM_URL must be an absolute http(s) URL — where your API gateway answers",
  })
  .refine((value) => {
    // zod runs a refinement even after the format check failed; a non-URL is that check's to name.
    try {
      const url = new URL(value);
      return url.search === "" && url.hash === "" && url.username === "" && url.password === "";
    } catch {
      return true;
    }
  }, "GRAFT_GATEWAY_UPSTREAM_URL takes an origin and an optional path, with no query, fragment or credentials")
  .optional();

/** An HTTP header name is a token; letters, digits and hyphens is the shape every gateway's is. */
const HEADER_NAME = /^[A-Za-z0-9-]+$/;

/** The header the deployment identifies itself to the gateway with: `Authorization`, `X-Api-Key`, a gateway's own. */
export const gatewayHeaderName = z
  .string()
  .regex(
    HEADER_NAME,
    "GRAFT_GATEWAY_HEADER_NAME must be a header name — letters, digits and hyphens, like X-Api-Key",
  )
  .optional();

/**
 * The prefix the gateway wants on caller headers, for a gateway that forwards a caller's header to
 * the vendor only when it carries one (Pipedream's `x-pd-proxy-` is the shape). Unset, the default:
 * caller headers travel under their own names, minus the credential-shaped ones the proxy strips
 * anyway. Read only beside the group; set without it, refused as a setting nothing would read.
 */
export const gatewayHeaderPrefix = z
  .string()
  .regex(
    HEADER_NAME,
    "GRAFT_GATEWAY_HEADER_PREFIX must be a header-name prefix — letters, digits and hyphens, like x-gateway-",
  )
  .optional();

export const gatewayKeys = [
  "GRAFT_GATEWAY_HOSTS",
  "GRAFT_GATEWAY_UPSTREAM_URL",
  "GRAFT_GATEWAY_HEADER_NAME",
  "GRAFT_GATEWAY_HEADER_VALUE",
] as const;

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

  const partialSandbox = partialGroupIssue(
    value,
    "The Docker sandbox backing is partially configured — set both the image and the network or neither.",
    sandboxKeys,
  );
  if (partialSandbox) issues.push(partialSandbox);

  const partialAdmin = partialGroupIssue(
    value,
    "The bootstrapped admin is partially configured — set both GRAFT_ADMIN_EMAIL and GRAFT_ADMIN_PASSWORD or neither.",
    adminKeys,
  );
  if (partialAdmin) issues.push(partialAdmin);

  /**
   * The keyring secret is the open form's — `createLocalKeyring` derives its key from it — so it is
   * required exactly when the open backings are selected. Under `cloud` the private package brings
   * its own keyring and its own configuration, and nothing here reads the secret.
   */
  if ((value.GRAFT_BACKINGS ?? "open") === "open" && value.GRAFT_KEYRING_SECRET === undefined) {
    issues.push(
      "GRAFT_KEYRING_SECRET is required with the open backings (GRAFT_BACKINGS=open, the default): the local keyring derives its key from it.",
    );
  }

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

  /**
   * The scripted model is a script, so it is the pair or nothing: `scripted` named with no script
   * has nothing to play, a script beside another backend is a file nobody reads — both a
   * half-finished setup. And an answer sheet in place of a model is refused in production, like the
   * fake sandbox.
   */
  if (value.GRAFT_MODEL_BACKEND === "scripted" && value.GRAFT_MODEL_SCRIPT === undefined) {
    issues.push(
      "The scripted model is partially configured — set GRAFT_MODEL_BACKEND=scripted and GRAFT_MODEL_SCRIPT together, or neither. Missing: GRAFT_MODEL_SCRIPT",
    );
  }
  if (value.GRAFT_MODEL_BACKEND !== "scripted" && value.GRAFT_MODEL_SCRIPT !== undefined) {
    issues.push(
      "The scripted model is partially configured — set GRAFT_MODEL_BACKEND=scripted and GRAFT_MODEL_SCRIPT together, or neither. Missing: GRAFT_MODEL_BACKEND=scripted",
    );
  }
  if (value.NODE_ENV === "production" && value.GRAFT_MODEL_BACKEND === "scripted") {
    issues.push(
      "GRAFT_MODEL_BACKEND=scripted is the canned test model and is refused under NODE_ENV=production.",
    );
  }

  /**
   * The provider-backed model reads its settings only under `GRAFT_MODEL_BACKEND=provider` — see
   * `modelProviderKeys`. Under it the pair is required, and what is missing is named; outside it
   * any of the five settings is a model nobody would use, and is refused for it.
   */
  const providerSettings = [...modelProviderKeys, ...modelProviderOptionalKeys].filter(
    (key) => value[key] !== undefined,
  );
  if (value.GRAFT_MODEL_BACKEND === "provider") {
    const missing = modelProviderKeys.filter((key) => value[key] === undefined);
    if (missing.length > 0) {
      issues.push(
        `GRAFT_MODEL_BACKEND=provider needs GRAFT_MODEL_PROVIDER (anthropic or openai) and GRAFT_MODEL_API_KEY. Missing: ${missing.join(", ")}`,
      );
    }
  } else if (providerSettings.length > 0) {
    issues.push(
      `${providerSettings.join(", ")} configure the provider-backed model, but GRAFT_MODEL_BACKEND is not provider, so nothing would read them; set GRAFT_MODEL_BACKEND=provider or unset them.`,
    );
  }

  /**
   * The self-hosted form authors with the deployment's own provider and key and refuses to start
   * without them (ADR 0014): `acquire` is the product, and a self-hosted server that boots with no
   * model would answer every `acquire` with `acquire_unconfigured` while looking installed.
   * Production under the open backings is that form. The hosted form (`cloud`) runs Graft's fixed
   * model or a person's own key (ADR 0014), and its deployment is checked by the private package's
   * configuration, not here. Development keeps the scripted backend, or no model at all, so a laptop
   * needs no key to run the rest.
   */
  if (
    value.NODE_ENV === "production" &&
    (value.GRAFT_BACKINGS ?? "open") === "open" &&
    value.GRAFT_MODEL_BACKEND !== "provider"
  ) {
    issues.push(
      "The self-hosted form needs a model to author with (ADR 0014): set GRAFT_MODEL_BACKEND=provider with GRAFT_MODEL_PROVIDER (anthropic or openai) and GRAFT_MODEL_API_KEY.",
    );
  }

  const partialLangfuse = partialGroupIssue(
    value,
    "Langfuse is partially configured — set GRAFT_LANGFUSE_PUBLIC_KEY and GRAFT_LANGFUSE_SECRET_KEY together, or neither.",
    langfuseKeys,
  );
  if (partialLangfuse) issues.push(partialLangfuse);

  /**
   * The gateway provider is the four settings or nothing (`gatewayKeys`); the prefix rides beside
   * them and is refused alone, as a provider setting nothing would read. In production the upstream
   * is https: the identity header is a secret (ADR 0019, GRA-58).
   */
  const partialGateway = partialGroupIssue(
    value,
    "The gateway provider is partially configured — set GRAFT_GATEWAY_HOSTS, GRAFT_GATEWAY_UPSTREAM_URL, GRAFT_GATEWAY_HEADER_NAME and GRAFT_GATEWAY_HEADER_VALUE together, or none of them.",
    gatewayKeys,
  );
  if (partialGateway) issues.push(partialGateway);
  const gatewayConfigured = gatewayKeys.every((key) => value[key] !== undefined);
  if (!gatewayConfigured && value.GRAFT_GATEWAY_HEADER_PREFIX !== undefined) {
    issues.push(
      "GRAFT_GATEWAY_HEADER_PREFIX configures the gateway provider, but the gateway group is not set, so nothing would read it; set the four GRAFT_GATEWAY_* settings or unset it.",
    );
  }
  if (
    value.NODE_ENV === "production" &&
    typeof value.GRAFT_GATEWAY_UPSTREAM_URL === "string" &&
    value.GRAFT_GATEWAY_UPSTREAM_URL.startsWith("http:")
  ) {
    issues.push(
      "GRAFT_GATEWAY_UPSTREAM_URL must be https under NODE_ENV=production: the deployment identity header is a secret and does not travel in the clear.",
    );
  }

  // `GRAFT_SANDBOX_BACKEND` chooses among the open form's sandboxes; under `cloud` the private
  // package brings the sandbox, and a `fake` set beside it would be two answers to one question.
  if (value.GRAFT_BACKINGS === "cloud" && value.GRAFT_SANDBOX_BACKEND === "fake") {
    issues.push(
      "GRAFT_SANDBOX_BACKEND=fake names an open-form sandbox and has no meaning under GRAFT_BACKINGS=cloud, where the private package's sandbox is used; unset it.",
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

  /** Which form's backings stand behind the seams — see `backingsForm`. */
  GRAFT_BACKINGS: backingsForm,

  /** The local keyring's seed — see `keyringSecret` for when this one is required. */
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

  /** Where toolboxes live as files, and the volume that directory is mounted from — see `toolboxRoot`, `toolboxVolume`. */
  GRAFT_TOOLBOX_ROOT: toolboxRoot,
  GRAFT_TOOLBOX_VOLUME: toolboxVolume,

  /** The package policy's thresholds and extra names — see `packageMinAgeDays`, `packageAllowlist`. */
  GRAFT_PACKAGE_MIN_AGE_DAYS: packageMinAgeDays,
  GRAFT_PACKAGE_MIN_WEEKLY_DOWNLOADS: packageMinWeeklyDownloads,
  GRAFT_PACKAGE_ALLOWLIST: packageAllowlist,

  /** The Docker sandbox backing's image and internal network, all-or-nothing — see `sandboxKeys`. */
  GRAFT_SANDBOX_IMAGE: z.string().min(1).optional(),
  GRAFT_SANDBOX_NETWORK: z.string().min(1).optional(),

  /** Which backing runs authored code, and whether the fake may — see `sandboxBackend`. */
  GRAFT_SANDBOX_BACKEND: sandboxBackend,

  /** Where the console's build is served from — see `consoleDir`. */
  GRAFT_CONSOLE_DIR: consoleDir,
  /** The console's URL and the handoff signing secret, both required — see `consoleUrl`, `handoffSecret`. */
  GRAFT_CONSOLE_URL: consoleUrl,
  GRAFT_HANDOFF_SECRET: handoffSecret,

  /** The ask flow's two clocks, each with a correct default — see `approvalWaitSeconds`, `pendingActionTtlHours`. */
  GRAFT_APPROVAL_WAIT_SECONDS: approvalWaitSeconds,
  GRAFT_PENDING_ACTION_TTL_HOURS: pendingActionTtlHours,

  /** How often the working-set sweep runs — see `sweepIntervalSeconds`. */
  GRAFT_SWEEP_INTERVAL_SECONDS: sweepIntervalSeconds,

  /** The acquire job's three bounds, each with a correct default — see `acquireMaxAttempts`, `acquireTokenCeiling`, `acquireConcurrency`. */
  GRAFT_ACQUIRE_MAX_ATTEMPTS: acquireMaxAttempts,
  GRAFT_ACQUIRE_TOKEN_CEILING: acquireTokenCeiling,
  GRAFT_ACQUIRE_CONCURRENCY: acquireConcurrency,

  /** Which model answers `acquire`, and the scripted one's script — see `modelBackend`, `modelScriptKeys`. */
  GRAFT_MODEL_BACKEND: modelBackend,
  GRAFT_MODEL_SCRIPT: z.string().min(1).optional(),

  /** The provider-backed model's settings — see `modelProviderKeys` for the group and the defaults. */
  GRAFT_MODEL_PROVIDER: modelProvider,
  GRAFT_MODEL_API_KEY: secretValue("GRAFT_MODEL_API_KEY"),
  GRAFT_MODEL_AUTHORING: z.string().min(1).optional(),
  GRAFT_MODEL_TRIAGE: z.string().min(1).optional(),
  GRAFT_MODEL_BASE_URL: z
    .url({
      protocol: /^https?$/,
      error:
        "GRAFT_MODEL_BASE_URL must be an absolute http(s) URL — the provider's endpoint, or an OpenAI-compatible gateway's",
    })
    .optional(),

  /** Langfuse, all-or-nothing, and its region — see `langfuseKeys`. */
  GRAFT_LANGFUSE_PUBLIC_KEY: secretValue("GRAFT_LANGFUSE_PUBLIC_KEY"),
  GRAFT_LANGFUSE_SECRET_KEY: secretValue("GRAFT_LANGFUSE_SECRET_KEY"),
  GRAFT_LANGFUSE_BASE_URL: z
    .url({
      protocol: /^https?$/,
      error: "GRAFT_LANGFUSE_BASE_URL must be an absolute http(s) URL — the Langfuse region's host",
    })
    .optional(),

  /** The admin opened on first start, all-or-nothing — see `adminKeys`. */
  GRAFT_ADMIN_EMAIL: adminEmail,
  GRAFT_ADMIN_PASSWORD: adminPassword,

  /** The gateway provider, all-or-nothing, and its optional header prefix — see `gatewayKeys` (ADR 0019, GRA-58). */
  GRAFT_GATEWAY_HOSTS: gatewayHosts,
  GRAFT_GATEWAY_UPSTREAM_URL: gatewayUpstreamUrl,
  GRAFT_GATEWAY_HEADER_NAME: gatewayHeaderName,
  GRAFT_GATEWAY_HEADER_VALUE: secretValue("GRAFT_GATEWAY_HEADER_VALUE"),
  GRAFT_GATEWAY_HEADER_PREFIX: gatewayHeaderPrefix,

  /** Whether the boot applies the committed migrations — see `migrateOnStart`. */
  GRAFT_MIGRATE_ON_START: migrateOnStart,
};

/**
 * One line per issue, the variable named on each — what the boot prints before it refuses to start
 * (`server.ts`). The messages in this file already name their variable; zod's own for a value that
 * is simply absent is "expected string, received undefined", which a person reading a container's
 * log at midnight should not have to decode, so that one becomes "<VARIABLE> is not set". A
 * cross-field sentence (`serverEnvIssues`) has no path and stands as it is.
 */
export function describeEnvIssues(
  issues: readonly { path?: readonly (PropertyKey | { key: PropertyKey })[]; message: string }[],
): string {
  return issues
    .map((issue) => {
      const name = (issue.path ?? [])
        .map((segment) => String(typeof segment === "object" ? segment.key : segment))
        .join(".");
      if (!name) return issue.message;
      if (/received undefined$/.test(issue.message)) return `${name} is not set`;
      return issue.message.includes(name) ? issue.message : `${name}: ${issue.message}`;
    })
    .join("\n");
}

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
