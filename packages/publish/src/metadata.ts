import type { PackageMetadata } from "./policy";

/**
 * Where the policy's facts about a package come from. One backing reads the npm registry, on the
 * server, at publish time; a fake answers from a table in tests. Never inside a sandbox: a sandbox
 * has no route to the registry (ADR 0013), and the policy is the server's decision, not the module's.
 */
export type PackageMetadataSource = {
  /**
   * What the registry knows about one version of a package, or null when the registry has no such
   * package or no such version. Rejects when the registry could not be asked — the publish turns
   * that into a diagnostic the model can retry on, distinct from a refusal it should rewrite for.
   */
  lookup(name: string, version: string): Promise<PackageMetadata | null>;
};

export type FakePackageMetadataSource = PackageMetadataSource & {
  /** Every `name@version` asked for, in order. */
  readonly lookups: string[];
};

/**
 * A table of answers, keyed `name@version` or by bare `name` for every version. A name with no
 * entry answers null, as the registry would for a package it does not have.
 */
export function createFakeMetadataSource(
  entries: Record<string, PackageMetadata | null | Error>,
): FakePackageMetadataSource {
  const lookups: string[] = [];
  return {
    lookups,
    lookup: async (name, version) => {
      lookups.push(`${name}@${version}`);
      const entry = entries[`${name}@${version}`] ?? entries[name] ?? null;
      if (entry instanceof Error) throw entry;
      return entry;
    },
  };
}

export const NPM_REGISTRY_URL = "https://registry.npmjs.org";
export const NPM_DOWNLOADS_URL = "https://api.npmjs.org";

export type RegistryMetadataOptions = {
  /** Injected so a test feeds recorded responses; production takes the global. */
  fetch?: typeof globalThis.fetch;
  registryUrl?: string;
  downloadsUrl?: string;
  /** Per request. The publish is interactive for the model, so a slow registry is a refusal, not a wait. */
  timeoutMs?: number;
};

/** The two documents read, trimmed to the fields the policy needs. */
type RegistryDocument = {
  time?: Record<string, string>;
  versions?: Record<string, { dist?: { attestations?: { provenance?: unknown } | null } }>;
};
type DownloadsDocument = { downloads?: unknown };

export class RegistryUnavailableError extends Error {
  constructor(
    readonly url: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(`${message} (${url})`, options);
    this.name = "RegistryUnavailableError";
  }
}

/**
 * The npm registry as a metadata source: the package document for the first-publish time and the
 * version's `dist.attestations`, and the downloads API for last week's count. Two requests, in
 * parallel, each under a timeout. A 404 from the registry is "no such package" (null); a 404 from
 * the downloads API is a package too new to have a count, which the policy's download rule then
 * refuses on its own terms. Anything else — a 5xx, a network failure, a body that is not JSON — is
 * `RegistryUnavailableError`, which the publish reports as a retryable diagnostic.
 *
 * The full package document is read rather than the abbreviated one because `time.created` is only
 * in the full one; for a package with a long history it is megabytes. Acceptable where this runs —
 * the server, once per declared dependency per publish — and the reason this source is never handed
 * to anything on a request path.
 */
export function createRegistryMetadataSource(
  options: RegistryMetadataOptions = {},
): PackageMetadataSource {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const registryUrl = (options.registryUrl ?? NPM_REGISTRY_URL).replace(/\/$/, "");
  const downloadsUrl = (options.downloadsUrl ?? NPM_DOWNLOADS_URL).replace(/\/$/, "");
  const timeoutMs = options.timeoutMs ?? 10_000;

  async function getJson<T>(url: string): Promise<{ status: number; body: T | null }> {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new RegistryUnavailableError(url, "the registry could not be reached", {
        cause: error,
      });
    }
    if (response.status === 404) return { status: 404, body: null };
    if (!response.ok) {
      throw new RegistryUnavailableError(url, `the registry answered ${response.status}`);
    }
    try {
      return { status: response.status, body: (await response.json()) as T };
    } catch (error) {
      throw new RegistryUnavailableError(url, "the registry's answer was not JSON", {
        cause: error,
      });
    }
  }

  return {
    lookup: async (name, version) => {
      // The registry takes a scoped name with its slash encoded and its `@` bare — what npm sends.
      const packageUrl = `${registryUrl}/${name.replace("/", "%2F")}`;
      const countUrl = `${downloadsUrl}/downloads/point/last-week/${name}`;
      const [doc, count] = await Promise.all([
        getJson<RegistryDocument>(packageUrl),
        getJson<DownloadsDocument>(countUrl),
      ]);
      if (doc.body === null) return null;
      const release = doc.body.versions?.[version];
      if (!release) return null;

      const created = doc.body.time?.created;
      const publishedAt = created ? new Date(created) : null;
      const downloads = count.body?.downloads;
      return {
        publishedAt: publishedAt && !Number.isNaN(publishedAt.getTime()) ? publishedAt : null,
        weeklyDownloads: typeof downloads === "number" ? downloads : null,
        hasProvenance: Boolean(release.dist?.attestations?.provenance),
      };
    },
  };
}
