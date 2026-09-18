import { join } from "node:path";

import {
  type ConnectionProvider,
  createGatewayProvider,
  createPipedreamProvider,
  keyringProvider,
  providerListProblem,
} from "@graft/core";
import { consoleTransport, createSmtpTransport, type EmailTransport } from "@graft/email";
import type { ServerEnv } from "@graft/env/server";
import {
  type Analytics,
  type LogDrain,
  type ModelTelemetryBacking,
  NO_ANALYTICS,
} from "@graft/observability";
import { createPipedreamClient, type PipedreamClient } from "@graft/pipedream";
import { createUpstreamFetch } from "@graft/proxy";
import { createFakeSandboxBackend } from "@graft/sandbox/fake";
import type { SandboxBackend } from "@graft/sandbox/types";
import { createDockerSandboxBackend } from "@graft/sandbox-docker";
import {
  createFilesystemToolboxStore,
  createNoopToolboxMirror,
  type ToolboxMirror,
  type ToolboxStore,
} from "@graft/toolbox";
import { createLocalKeyring, type Keyring } from "@graft/vault";

/**
 * Which backing stands behind each of the five seams — sandbox, keyring, toolbox mirror, the
 * connection providers (ADR 0019) and transactional mail (ADR 0021, GRA-90) — chosen once at boot from `GRAFT_BACKINGS` (ADR 0002: one core,
 * two backings per seam, the commercial half hidden by absence), and the toolbox store beside them,
 * because the store and the sandbox have to see one tree (`packages/toolbox/README.md`) and which
 * tree depends on the sandbox chosen. Under `open` that is the filesystem store, rooted where the
 * sandbox backing sees the same directory; under `cloud` the private package may answer with a store
 * of its own — one over the drives its sandboxes mount (GRA-39) — and the selector takes that in
 * place of the filesystem store, since a version written to this machine's disk is one no hosted
 * sandbox would ever see.
 *
 * The providers are a list rather than one backing, because a deployment runs several at once — a
 * broker for the vendors it has, the keyring for the rest — and a proposal is routed to the first
 * that covers it. The keyring is always present and last: `open` enables it alone, and `cloud`
 * appends it after whatever the private package answers, so today's behaviour is every deployment's
 * floor and no hosted provider can shadow it (`providerListProblem` refuses a list that tries). Two
 * providers are open code switched on by configuration rather than by form (ADR 0019, "code is open
 * while configuration may be hosted"), and `environmentProviders` puts them on the list in either
 * form: the **gateway** provider (GRA-58) whenever the `GRAFT_GATEWAY_*` group is set, first, ahead
 * of any broker the hosted package answers with, because an operator who named a vendor host as
 * covered by their gateway meant it; and the **Pipedream** provider (GRA-59) whenever the
 * `GRAFT_PIPEDREAM_*` group is set, after the hosted providers and ahead of the keyring, since the
 * hosted tier is what sets it (graft-cloud's app stack), though a self-host may. Absent otherwise.
 *
 * `open` is what this repository holds: the sandbox `GRAFT_SANDBOX_BACKEND` names — Docker when
 * its pair of variables is set, none when it is not, or the in-process fake for a laptop without a
 * daemon, whose toolbox then lives in the fake's own temporary directory — the local AES keyring,
 * the mirror that records a call and copies nothing, and for mail the SMTP relay the environment
 * names or, unset, the console transport, which prints the one email the server sends into its own
 * log (`@graft/email`). Mail is the seam where the
 * vendor is most tempting to write into the core, and the reason it is not: the hosted form's
 * transport and the ids of its templates are that vendor's and Graft Cloud's, and a self-host has
 * neither — so they live in the private package, which answers `mail` beside the other seams, and
 * a self-host reads its reset link out of `docker compose logs`. `cloud` is the hosted form's, from a
 * private package that is not in this repository's dependency graph: it is loaded by a dynamic
 * `import()` of a specifier held in a variable, so the type program never resolves it, and a
 * checkout without it typechecks, tests and boots as the self-hosted form. The private package
 * arrives by being placed at `packages/cloud-backings/` — gitignored here — where the workspace
 * glob picks it up and its `workspace:*` dependencies on the seam packages resolve.
 * `apps/server/package.json` lists it under `optionalDependencies`, which is what makes the import
 * below resolvable from this file when the package is present: pnpm links an optional workspace
 * dependency into this app's `node_modules` when the workspace has it and installs without
 * complaint — frozen lockfile included — when it does not. In the image (`apps/server/Dockerfile`,
 * GRA-38) the same name resolves to the package's own build, laid at
 * `/app/node_modules/@graft/cloud-backings` by the Dockerfile when the checkout it was built from had
 * the package; the open image has no such directory, and the import fails there as it fails here
 * without the package.
 *
 * Nothing about the hosted backings is typed here beyond the seams they implement. What the private
 * module must export is `createCloudBackings(input: CloudBackingsInput)` returning the three
 * backings and, if it has one, its store; `assertCloudBackings` checks that shape at boot and says
 * what is missing — the one enforcement a boundary of absence can have. `NODE_ENV=production` with
 * `open` is allowed: it is the self-hosted form deployed, not something missing.
 */

export type BackingsForm = ServerEnv["GRAFT_BACKINGS"];

export type Backings = {
  form: BackingsForm;
  /**
   * Null in the open form when Docker is named and its pair is unset: the server boots, every run
   * refuses saying so, and a publish that needs the install step refuses with a diagnostic
   * (`@graft/publish`). Never null from the cloud form or the fake.
   */
  sandbox: SandboxBackend | null;
  keyring: Keyring;
  mirror: ToolboxMirror;
  /**
   * The connection providers, in routing order, the keyring last (ADR 0019). `["keyring"]` under
   * `open`; whatever the private package answers, then the keyring, under `cloud`. The boot line
   * names them.
   */
  providers: readonly ConnectionProvider[];
  /** The toolbox as the server holds it, where the sandbox backing sees the same tree. */
  store: ToolboxStore;
  /**
   * How the server's one email leaves (ADR 0021): the SMTP relay the environment names when the
   * `GRAFT_SMTP_URL`/`GRAFT_MAIL_FROM` pair is set (GRA-92), else the console transport, under
   * `open`; under `cloud` the private package's transport first, then the same two. A hosted
   * deploy without a mail key still boots and still logs the link. The boot line names it.
   */
  mail: EmailTransport;
  /**
   * The directory the store writes on this machine — `<root>/<toolboxId>/<path>` — when it is the
   * filesystem store, and null when the cloud backings answered with a store of their own and the
   * toolbox is nowhere on this disk. For a boot line or a script telling a reader where to look;
   * nothing reads the toolbox through it.
   */
  toolboxRoot: string | null;
  /**
   * The three observability seams (GRA-100; ADR 0002 as amended 2026-09-19), each with **no backing
   * in the open form**: wide events stay on stdout, nothing is counted, model calls are untraced —
   * a self-host phones nowhere. Under `cloud` the private package answers whichever of the three
   * its environment configures; the boot line names each.
   */
  logDrain: LogDrain | null;
  analytics: Analytics;
  modelTelemetry: ModelTelemetryBacking | null;
};

/**
 * What the private module's factory returns: the three seams; a toolbox store when the hosted form
 * holds the toolbox somewhere this machine's disk is not (GRA-39) — absent, the selector's
 * filesystem store at `GRAFT_TOOLBOX_ROOT` is what the publish writes; and the connection providers
 * the hosted tier enables beyond the keyring (ADR 0019), in routing order, the keyring not among
 * them — the selector appends it. Absent, the keyring alone. And the mail transport (ADR 0021),
 * when the hosted tier has one configured; absent, the console's.
 */
export type CloudBackings = {
  sandbox: SandboxBackend;
  keyring: Keyring;
  mirror: ToolboxMirror;
  store?: ToolboxStore;
  providers?: ConnectionProvider[];
  /** The hosted form's mail transport (ADR 0021, GRA-90); absent, the selector keeps the console's. */
  mail?: EmailTransport;
  /** The hosted form's observability backings (GRA-100), each present only when configured there. */
  logDrain?: LogDrain;
  analytics?: Analytics;
  modelTelemetry?: ModelTelemetryBacking;
};

/**
 * What the private module's factory is handed. Its own variables it validates itself from `raw`;
 * `env` carries the two values of the open environment it may rely on having been checked. The
 * private package declares this type structurally, since it cannot import from an app; the two
 * declarations are kept the same by hand, and `assertCloudBackings` checks the answer at boot.
 */
export type CloudBackingsInput = {
  env: { NODE_ENV: ServerEnv["NODE_ENV"]; GRAFT_PROXY_PUBLIC_URL: string };
  raw: Readonly<Record<string, string | undefined>>;
  /** The filesystem store at the toolbox root — what a factory that owns no store is read through. */
  store: ToolboxStore;
};

/** The specifier imported under `cloud`. Held in a variable, never written in an `import`. */
export const CLOUD_BACKINGS_MODULE = "@graft/cloud-backings";

export type BackingsEnv = Pick<
  ServerEnv,
  | "NODE_ENV"
  | "GRAFT_BACKINGS"
  | "GRAFT_KEYRING_SECRET"
  | "GRAFT_SANDBOX_BACKEND"
  | "GRAFT_SANDBOX_IMAGE"
  | "GRAFT_SANDBOX_NETWORK"
  | "GRAFT_PROXY_PUBLIC_URL"
  | "GRAFT_TOOLBOX_ROOT"
  | "GRAFT_TOOLBOX_VOLUME"
  | "GRAFT_GATEWAY_HOSTS"
  | "GRAFT_GATEWAY_UPSTREAM_URL"
  | "GRAFT_GATEWAY_HEADER_NAME"
  | "GRAFT_GATEWAY_HEADER_VALUE"
  | "GRAFT_GATEWAY_HEADER_PREFIX"
  | "GRAFT_PIPEDREAM_PROJECT_ID"
  | "GRAFT_PIPEDREAM_ENVIRONMENT"
  | "GRAFT_PIPEDREAM_CLIENT_ID"
  | "GRAFT_PIPEDREAM_CLIENT_SECRET"
  | "GRAFT_SMTP_URL"
  | "GRAFT_MAIL_FROM"
>;

/**
 * The gateway provider the environment configures, or null when the group is unset. `@graft/env`
 * has refused a partial group by the time this runs, so the four are read as one; the check on each
 * is what makes the narrowing true for a caller that assembled the environment some other way.
 */
export function gatewayProviderFrom(
  env: Pick<
    BackingsEnv,
    | "GRAFT_GATEWAY_HOSTS"
    | "GRAFT_GATEWAY_UPSTREAM_URL"
    | "GRAFT_GATEWAY_HEADER_NAME"
    | "GRAFT_GATEWAY_HEADER_VALUE"
    | "GRAFT_GATEWAY_HEADER_PREFIX"
  >,
): ConnectionProvider | null {
  const hosts = env.GRAFT_GATEWAY_HOSTS;
  const upstreamUrl = env.GRAFT_GATEWAY_UPSTREAM_URL;
  const headerName = env.GRAFT_GATEWAY_HEADER_NAME;
  const headerValue = env.GRAFT_GATEWAY_HEADER_VALUE;
  if (!hosts || !upstreamUrl || !headerName || !headerValue) return null;
  return createGatewayProvider({
    hosts,
    upstreamUrl,
    headerName,
    headerValue,
    headerPrefix: env.GRAFT_GATEWAY_HEADER_PREFIX ?? null,
    // The relay leg's own way out (ADR 0019 as amended for GRA-58): the gateway's hostname exempt
    // from the resolver's private-address rule, on this fetch and on no other — the proxy's shared
    // fetch keeps the full guard for every vendor host, so a keyring connection spelling the
    // gateway's name is still judged on the address it resolves to (`@graft/proxy`'s `upstream.ts`).
    upstreamFetch: createUpstreamFetch({ unguardedHosts: [new URL(upstreamUrl).hostname] }),
  });
}

/**
 * The Pipedream provider the environment configures, or null when its group is unset (ADR 0019,
 * GRA-59). `@graft/env` has refused a partial group by the time this runs, so the four are read as
 * one; the client is built from them unless the caller hands one in — a fake in a test, one
 * pointed at a fake Pipedream in the proof script (`SelectBackingsDeps.pipedreamClient`).
 */
export function pipedreamProviderFrom(
  env: Pick<
    BackingsEnv,
    | "GRAFT_PIPEDREAM_PROJECT_ID"
    | "GRAFT_PIPEDREAM_ENVIRONMENT"
    | "GRAFT_PIPEDREAM_CLIENT_ID"
    | "GRAFT_PIPEDREAM_CLIENT_SECRET"
  >,
  deps: Pick<SelectBackingsDeps, "pipedreamClient"> = {},
): ConnectionProvider | null {
  const projectId = env.GRAFT_PIPEDREAM_PROJECT_ID;
  const environment = env.GRAFT_PIPEDREAM_ENVIRONMENT;
  const clientId = env.GRAFT_PIPEDREAM_CLIENT_ID;
  const clientSecret = env.GRAFT_PIPEDREAM_CLIENT_SECRET;
  if (!projectId || !environment || !clientId || !clientSecret) return null;
  const client =
    deps.pipedreamClient ??
    createPipedreamClient({ projectId, environment, clientId, clientSecret });
  return createPipedreamProvider({ client });
}

/**
 * The mail transport the environment configures (ADR 0021 as amended for GRA-92), or null when the
 * `GRAFT_SMTP_URL`/`GRAFT_MAIL_FROM` pair is unset: the SMTP relay every self-host has, in either
 * form — the one backing of this seam that is open code switched on by configuration. `@graft/env`
 * has refused a half-set pair by the time this runs; the check on both is what makes the narrowing
 * true for a caller that assembled the environment some other way.
 */
export function environmentMail(
  env: Pick<BackingsEnv, "GRAFT_SMTP_URL" | "GRAFT_MAIL_FROM">,
): EmailTransport | null {
  if (!env.GRAFT_SMTP_URL || !env.GRAFT_MAIL_FROM) return null;
  return createSmtpTransport({ url: env.GRAFT_SMTP_URL, from: env.GRAFT_MAIL_FROM });
}

export type SelectBackingsDeps = {
  /** `process.env` in the server; a test hands the cloud factory whatever it should see. */
  raw?: Readonly<Record<string, string | undefined>>;
  /** The module imported under `cloud`. Default `CLOUD_BACKINGS_MODULE`; a test points it at a file. */
  cloudModule?: string;
  /**
   * The Pipedream Connect client the provider is built over, in place of the one
   * `GRAFT_PIPEDREAM_*` would build — a fake in a test, one pointed at a fake Pipedream in the proof
   * script. Read only when the group is set; without the group there is no provider to hand it to.
   */
  pipedreamClient?: PipedreamClient;
};

export async function selectBackings(
  env: BackingsEnv,
  deps: SelectBackingsDeps = {},
): Promise<Backings> {
  if (env.GRAFT_BACKINGS === "cloud") return loadCloudBackings(env, deps);
  return openBackings(env, deps);
}

/**
 * The providers configuration switches on in either form (ADR 0019), in routing order: the gateway
 * (GRA-58) ahead of Pipedream (GRA-59), because an operator who named a vendor host as covered by
 * their gateway meant it, ahead of a broker's app table; each on the list only when its
 * all-or-nothing group is set, and both ahead of the keyring, which the caller appends last.
 */
export function environmentProviders(
  env: BackingsEnv,
  deps: Pick<SelectBackingsDeps, "pipedreamClient"> = {},
): ConnectionProvider[] {
  return [gatewayProviderFrom(env), pipedreamProviderFrom(env, deps)].filter(
    (provider): provider is ConnectionProvider => provider !== null,
  );
}

function openBackings(env: BackingsEnv, deps: SelectBackingsDeps): Backings {
  if (env.GRAFT_KEYRING_SECRET === undefined) {
    // `@graft/env` refuses this combination at boot (`serverEnvIssues`); the check here is what
    // makes the narrowing true for a caller that assembled the environment some other way.
    throw new Error(
      "GRAFT_KEYRING_SECRET is required with GRAFT_BACKINGS=open: the local keyring derives its key from it",
    );
  }
  let sandbox: SandboxBackend | null;
  let toolboxRoot: string;
  if (env.GRAFT_SANDBOX_BACKEND === "fake") {
    // The fake mounts a toolbox by symlink from its own root, so the store has to live there too;
    // a laptop's toolbox then lasts as long as the process. Refused in production by `@graft/env`.
    const fake = createFakeSandboxBackend();
    sandbox = fake;
    toolboxRoot = join(fake.root, "toolboxes");
  } else {
    // The install step and the store have to see one tree (`packages/toolbox/README.md`). On a host
    // that is the toolbox root bound into every sandbox, `<root>/<toolboxId>`; in the compose file,
    // where this server is itself a container, it is the named volume the root is mounted from,
    // `GRAFT_TOOLBOX_VOLUME`, each sandbox taking its own subpath (GRA-33). The Docker backing reads
    // `DOCKER_HOST` itself.
    toolboxRoot = env.GRAFT_TOOLBOX_ROOT;
    sandbox =
      env.GRAFT_SANDBOX_IMAGE && env.GRAFT_SANDBOX_NETWORK
        ? createDockerSandboxBackend({
            image: env.GRAFT_SANDBOX_IMAGE,
            network: env.GRAFT_SANDBOX_NETWORK,
            ...(env.GRAFT_TOOLBOX_VOLUME
              ? { toolboxVolume: env.GRAFT_TOOLBOX_VOLUME }
              : { toolboxHostRoot: toolboxRoot }),
          })
        : null;
  }
  const store = createFilesystemToolboxStore({ root: toolboxRoot });
  return {
    form: "open",
    sandbox,
    keyring: createLocalKeyring(env.GRAFT_KEYRING_SECRET),
    mirror: createNoopToolboxMirror(),
    providers: [...environmentProviders(env, deps), keyringProvider],
    store,
    toolboxRoot: store.root,
    mail: environmentMail(env) ?? consoleTransport,
    logDrain: null,
    analytics: NO_ANALYTICS,
    modelTelemetry: null,
  };
}

async function loadCloudBackings(env: BackingsEnv, deps: SelectBackingsDeps): Promise<Backings> {
  const specifier = deps.cloudModule ?? CLOUD_BACKINGS_MODULE;
  let loaded: unknown;
  try {
    loaded = await import(specifier);
  } catch (error) {
    if (isModuleNotFound(error)) {
      throw new Error(
        `GRAFT_BACKINGS=cloud, but ${specifier} is not installed in this checkout. The hosted backings are a private package placed at packages/cloud-backings/ (ADR 0002); link it in, or set GRAFT_BACKINGS=open for the backings this repository holds.`,
        { cause: error },
      );
    }
    throw new Error(`GRAFT_BACKINGS=cloud, but ${specifier} failed to load`, { cause: error });
  }
  const factory = (loaded as Record<string, unknown> | null)?.createCloudBackings;
  if (typeof factory !== "function") {
    throw new Error(`${specifier} does not export createCloudBackings(input)`);
  }
  // The filesystem store is handed to every factory and is what one that owns no store is read
  // through. A factory that answers with its own — the hosted form's, over the drives its sandboxes
  // mount (GRA-39) — is what the publish writes to instead, and there is then no toolbox on this disk.
  const filesystem = createFilesystemToolboxStore({ root: env.GRAFT_TOOLBOX_ROOT });
  const input: CloudBackingsInput = {
    env: { NODE_ENV: env.NODE_ENV, GRAFT_PROXY_PUBLIC_URL: env.GRAFT_PROXY_PUBLIC_URL },
    raw: deps.raw ?? process.env,
    store: filesystem,
  };
  const created: unknown = await factory(input);
  assertCloudBackings(created, specifier);
  const {
    store: own,
    providers: hosted,
    mail,
    logDrain,
    analytics,
    modelTelemetry,
    ...seams
  } = created;
  // The environment's gateway first (GRA-58), the hosted providers, then the Pipedream provider the
  // environment switches on (GRA-59), and the keyring after all of them, always: the floor every
  // deployment has (ADR 0019). `environmentProviders` states the order between the two configured
  // ones; the hosted list sits between them here because each side's reason places it there.
  const gateway = gatewayProviderFrom(env);
  const pipedream = pipedreamProviderFrom(env, deps);
  const providers = [
    ...(gateway ? [gateway] : []),
    ...(hosted ?? []),
    ...(pipedream ? [pipedream] : []),
    keyringProvider,
  ];
  const problem = providerListProblem(providers);
  if (problem) {
    throw new Error(`${specifier}'s createCloudBackings returned connection providers: ${problem}`);
  }
  return {
    form: "cloud",
    ...seams,
    providers,
    store: own ?? filesystem,
    toolboxRoot: own ? null : filesystem.root,
    // The hosted transport when the package has one, the relay the environment names otherwise,
    // the console as the floor — the hosted tier sets no relay today, but a form is not a rule.
    mail: mail ?? environmentMail(env) ?? consoleTransport,
    logDrain: logDrain ?? null,
    analytics: analytics ?? NO_ANALYTICS,
    modelTelemetry: modelTelemetry ?? null,
  };
}

const MODULE_NOT_FOUND_CODES = new Set(["ERR_MODULE_NOT_FOUND", "MODULE_NOT_FOUND"]);

function isModuleNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (typeof code === "string" && MODULE_NOT_FOUND_CODES.has(code)) return true;
  // Vite's module runner, which vitest imports through, reports the same failure as a plain Error.
  return (
    typeof message === "string" &&
    /cannot find (package|module)|failed to (load|resolve)/i.test(message)
  );
}

/** The functions each seam is made of — what a backing must at least carry to be one. */
const SEAM_MEMBERS = {
  sandbox: ["ensure", "destroy", "list", "install"],
  keyring: ["generateDataKey", "unwrapDataKey"],
  mirror: ["mirrorVersion"],
} as const;

/** The store's verbs (`ToolboxStore` in `@graft/toolbox`), for the factory that answers with one. */
const STORE_MEMBERS = ["readTree", "writeTree", "read", "list", "exists", "remove"] as const;

/** A connection provider's functions (`ConnectionProvider` in `@graft/core`), and how it connects. */
const PROVIDER_MEMBERS = ["covers", "resolve", "revoke"] as const;
const PROVIDER_CONNECT_KINDS = new Set(["form", "link", "none"]);
/** What a provider that connects with a link carries beyond the word (`ProviderLink` in `@graft/core`). */
const PROVIDER_LINK_MEMBERS = ["target", "start", "complete"] as const;

/**
 * Throw unless `value` carries the three seams — and, when it carries a store, the whole store,
 * when it carries providers, a list of whole providers, when it carries a mail transport, a named
 * one that sends, and when it carries an observability backing, a named one with its functions —
 * naming the first thing that is missing.
 */
export function assertCloudBackings(
  value: unknown,
  specifier: string,
): asserts value is CloudBackings {
  const record = (typeof value === "object" && value !== null ? value : {}) as Record<
    string,
    unknown
  >;
  for (const [seam, members] of Object.entries(SEAM_MEMBERS)) {
    const backing = record[seam];
    if (typeof backing !== "object" || backing === null) {
      throw new Error(`${specifier}'s createCloudBackings returned no ${seam} backing`);
    }
    for (const member of members) {
      if (typeof (backing as Record<string, unknown>)[member] !== "function") {
        throw new Error(
          `${specifier}'s createCloudBackings returned a ${seam} backing without ${member}()`,
        );
      }
    }
  }
  if (typeof (record.keyring as Record<string, unknown>).id !== "string") {
    throw new Error(`${specifier}'s createCloudBackings returned a keyring with no id`);
  }
  if (record.store !== undefined) {
    if (typeof record.store !== "object" || record.store === null) {
      throw new Error(`${specifier}'s createCloudBackings returned a store that is not an object`);
    }
    for (const member of STORE_MEMBERS) {
      if (typeof (record.store as Record<string, unknown>)[member] !== "function") {
        throw new Error(`${specifier}'s createCloudBackings returned a store without ${member}()`);
      }
    }
  }
  if (record.mail !== undefined) {
    const mail = record.mail as Record<string, unknown> | null;
    if (typeof mail !== "object" || mail === null || typeof mail.send !== "function") {
      throw new Error(
        `${specifier}'s createCloudBackings returned a mail transport without send()`,
      );
    }
    if (typeof mail.name !== "string" || mail.name.length === 0) {
      throw new Error(`${specifier}'s createCloudBackings returned a mail transport with no name`);
    }
  }
  const named: Array<[key: string, what: string, members: readonly string[]]> = [
    ["logDrain", "log drain", ["drain", "flush"]],
    ["analytics", "analytics backing", ["capture", "shutdown"]],
    ["modelTelemetry", "model telemetry backing", ["flush", "shutdown"]],
  ];
  for (const [key, what, members] of named) {
    const backing = record[key];
    if (backing === undefined) continue;
    if (typeof backing !== "object" || backing === null) {
      throw new Error(
        `${specifier}'s createCloudBackings returned a ${what} that is not an object`,
      );
    }
    const b = backing as Record<string, unknown>;
    if (typeof b.name !== "string" || b.name.length === 0) {
      throw new Error(`${specifier}'s createCloudBackings returned a ${what} with no name`);
    }
    for (const member of members) {
      if (typeof b[member] !== "function") {
        throw new Error(
          `${specifier}'s createCloudBackings returned a ${what} without ${member}()`,
        );
      }
    }
    if (key === "modelTelemetry") {
      const telemetry = b.telemetry as Record<string, unknown> | undefined;
      if (typeof telemetry?.traced !== "function" || !Array.isArray(telemetry.integrations)) {
        throw new Error(
          `${specifier}'s createCloudBackings returned a model telemetry backing without telemetry.traced() and telemetry.integrations`,
        );
      }
    }
  }
  if (record.providers !== undefined) {
    if (!Array.isArray(record.providers)) {
      throw new Error(`${specifier}'s createCloudBackings returned providers that are not a list`);
    }
    for (const [index, provider] of (record.providers as unknown[]).entries()) {
      const at = `provider ${index}`;
      if (typeof provider !== "object" || provider === null) {
        throw new Error(
          `${specifier}'s createCloudBackings returned a ${at} that is not an object`,
        );
      }
      const p = provider as Record<string, unknown>;
      if (typeof p.name !== "string" || p.name.length === 0) {
        throw new Error(`${specifier}'s createCloudBackings returned a ${at} with no name`);
      }
      const connect = p.connect as Record<string, unknown> | undefined;
      if (typeof connect?.kind !== "string" || !PROVIDER_CONNECT_KINDS.has(connect.kind)) {
        throw new Error(
          `${specifier}'s createCloudBackings returned provider ${p.name} with no connect kind (form, link or none)`,
        );
      }
      for (const member of PROVIDER_MEMBERS) {
        if (typeof p[member] !== "function") {
          throw new Error(
            `${specifier}'s createCloudBackings returned provider ${p.name} without ${member}()`,
          );
        }
      }
      if (connect.kind === "link") {
        for (const member of PROVIDER_LINK_MEMBERS) {
          if (typeof connect[member] !== "function") {
            throw new Error(
              `${specifier}'s createCloudBackings returned provider ${p.name}, which connects with a link, without connect.${member}()`,
            );
          }
        }
        if (typeof connect.scheme !== "string" || connect.scheme.length === 0) {
          throw new Error(
            `${specifier}'s createCloudBackings returned provider ${p.name}, which connects with a link, with no relay scheme`,
          );
        }
      }
    }
  }
}
