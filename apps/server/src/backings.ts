import { join } from "node:path";

import { type ConnectionProvider, keyringProvider, providerListProblem } from "@graft/core";
import type { ServerEnv } from "@graft/env/server";
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
 * Which backing stands behind each of the four seams — sandbox, keyring, toolbox mirror, and the
 * connection providers (ADR 0019) — chosen once at boot from `GRAFT_BACKINGS` (ADR 0002: one core,
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
 * floor and no hosted provider can shadow it (`providerListProblem` refuses a list that tries).
 *
 * `open` is what this repository holds: the sandbox `GRAFT_SANDBOX_BACKEND` names — Docker when
 * its pair of variables is set, none when it is not, or the in-process fake for a laptop without a
 * daemon, whose toolbox then lives in the fake's own temporary directory — the local AES keyring,
 * and the mirror that records a call and copies nothing. `cloud` is the hosted form's, from a
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
   * The directory the store writes on this machine — `<root>/<toolboxId>/<path>` — when it is the
   * filesystem store, and null when the cloud backings answered with a store of their own and the
   * toolbox is nowhere on this disk. For a boot line or a script telling a reader where to look;
   * nothing reads the toolbox through it.
   */
  toolboxRoot: string | null;
};

/**
 * What the private module's factory returns: the three seams; a toolbox store when the hosted form
 * holds the toolbox somewhere this machine's disk is not (GRA-39) — absent, the selector's
 * filesystem store at `GRAFT_TOOLBOX_ROOT` is what the publish writes; and the connection providers
 * the hosted tier enables beyond the keyring (ADR 0019), in routing order, the keyring not among
 * them — the selector appends it. Absent, the keyring alone.
 */
export type CloudBackings = {
  sandbox: SandboxBackend;
  keyring: Keyring;
  mirror: ToolboxMirror;
  store?: ToolboxStore;
  providers?: ConnectionProvider[];
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
>;

export type SelectBackingsDeps = {
  /** `process.env` in the server; a test hands the cloud factory whatever it should see. */
  raw?: Readonly<Record<string, string | undefined>>;
  /** The module imported under `cloud`. Default `CLOUD_BACKINGS_MODULE`; a test points it at a file. */
  cloudModule?: string;
};

export async function selectBackings(
  env: BackingsEnv,
  deps: SelectBackingsDeps = {},
): Promise<Backings> {
  if (env.GRAFT_BACKINGS === "cloud") return loadCloudBackings(env, deps);
  return openBackings(env);
}

function openBackings(env: BackingsEnv): Backings {
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
    providers: [keyringProvider],
    store,
    toolboxRoot: store.root,
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
  const { store: own, providers: hosted, ...seams } = created;
  // The keyring after the hosted providers, always: the floor every deployment has (ADR 0019).
  const providers = [...(hosted ?? []), keyringProvider];
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

/**
 * Throw unless `value` carries the three seams — and, when it carries a store, the whole store,
 * and, when it carries providers, a list of whole providers — naming the first thing that is
 * missing.
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
    }
  }
}
