import type { ServerEnv } from "@graft/env/server";
import type { SandboxBackend } from "@graft/sandbox/types";
import { createDockerSandboxBackend } from "@graft/sandbox-docker";
import { createNoopToolboxMirror, type ToolboxMirror, type ToolboxStore } from "@graft/toolbox";
import { createLocalKeyring, type Keyring } from "@graft/vault";

/**
 * Which backing stands behind each of the three seams — sandbox, keyring, toolbox mirror — chosen
 * once at boot from `GRAFT_BACKINGS` (ADR 0002: one core, two backings per seam, the commercial
 * half hidden by absence).
 *
 * `open` is what this repository holds: the Docker sandbox when its pair of variables is set, the
 * local AES keyring, and the mirror that records a call and copies nothing. `cloud` is the hosted
 * form's, from a private package that is not in this repository's dependency graph: it is loaded by
 * a dynamic `import()` of a specifier held in a variable, so the type program never resolves it,
 * `pnpm install` never fetches it, and a checkout without it typechecks, tests and boots as the
 * self-hosted form. The private package arrives by being placed at `packages/cloud-backings/` —
 * gitignored here — where the workspace glob picks it up and its `workspace:*` dependencies on the
 * seam packages resolve.
 *
 * Nothing about the hosted backings is typed here beyond the seams they implement. What the private
 * module must export is `createCloudBackings(input: CloudBackingsInput)` returning the three
 * backings, and `assertCloudBackings` checks that shape at boot and says what is missing — the one
 * enforcement a boundary of absence can have. `NODE_ENV=production` with `open` is allowed: it is
 * the self-hosted form deployed, not something missing.
 */

export type BackingsForm = ServerEnv["GRAFT_BACKINGS"];

export type Backings = {
  form: BackingsForm;
  /**
   * Null in the open form when the Docker pair is unset: a publish that needs the install step then
   * refuses with a diagnostic saying so (`@graft/publish`). Never null from the cloud form.
   */
  sandbox: SandboxBackend | null;
  keyring: Keyring;
  mirror: ToolboxMirror;
};

/** What the private module's factory returns: the three seams and nothing else. */
export type CloudBackings = {
  sandbox: SandboxBackend;
  keyring: Keyring;
  mirror: ToolboxMirror;
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
  /** The toolbox as the server holds it — what a mirror reads a version from. */
  store: ToolboxStore;
};

/** The specifier imported under `cloud`. Held in a variable, never written in an `import`. */
export const CLOUD_BACKINGS_MODULE = "@graft/cloud-backings";

export type BackingsEnv = Pick<
  ServerEnv,
  | "NODE_ENV"
  | "GRAFT_BACKINGS"
  | "GRAFT_KEYRING_SECRET"
  | "GRAFT_SANDBOX_IMAGE"
  | "GRAFT_SANDBOX_NETWORK"
  | "GRAFT_PROXY_PUBLIC_URL"
  | "GRAFT_TOOLBOX_ROOT"
>;

export type SelectBackingsDeps = {
  store: ToolboxStore;
  /** `process.env` in the server; a test hands the cloud factory whatever it should see. */
  raw?: Readonly<Record<string, string | undefined>>;
  /** The module imported under `cloud`. Default `CLOUD_BACKINGS_MODULE`; a test points it at a file. */
  cloudModule?: string;
};

export async function selectBackings(
  env: BackingsEnv,
  deps: SelectBackingsDeps,
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
  // Bound to the toolbox root so the install step and the store see one tree (`@graft/toolbox`'s
  // README says how a bind of that directory is what makes them one).
  const sandbox =
    env.GRAFT_SANDBOX_IMAGE && env.GRAFT_SANDBOX_NETWORK
      ? createDockerSandboxBackend({
          image: env.GRAFT_SANDBOX_IMAGE,
          network: env.GRAFT_SANDBOX_NETWORK,
          toolboxHostRoot: env.GRAFT_TOOLBOX_ROOT,
        })
      : null;
  return {
    form: "open",
    sandbox,
    keyring: createLocalKeyring(env.GRAFT_KEYRING_SECRET),
    mirror: createNoopToolboxMirror(),
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
  const input: CloudBackingsInput = {
    env: { NODE_ENV: env.NODE_ENV, GRAFT_PROXY_PUBLIC_URL: env.GRAFT_PROXY_PUBLIC_URL },
    raw: deps.raw ?? process.env,
    store: deps.store,
  };
  const created: unknown = await factory(input);
  assertCloudBackings(created, specifier);
  return { form: "cloud", ...created };
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

/** Throw unless `value` carries the three seams, naming the first thing that is missing. */
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
}
