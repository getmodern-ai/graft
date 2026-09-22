/**
 * The package policy (CONTEXT.md; ADR 0013): may this package be installed into a version while a
 * tool is being published? Pure — a name, a version, what the registry says about it, the
 * configuration and the clock in; a verdict out — so every rule below has a test with no network.
 *
 * A refusal here is a blocked shortcut, not a blocked tool: the publish turns it into a diagnostic
 * naming the package and the rule, and the authoring model writes the calls through `ctx.fetch`
 * instead, which it can always do.
 */

/**
 * Official vendor SDKs, allowed by name. The allowlist says the *name* is admissible and waives
 * npm provenance, which a vendor's own client may not publish; it waives nothing else (GRA-176).
 * Exact versions are still required of them (ADR 0013), the registry is still asked about them and
 * its age and download rules still apply, and the check still requires the proxy binding (ADR
 * 0010). An entry ending in `/*` admits a whole scope, which is how the AWS SDK's
 * one-client-per-service layout is covered.
 *
 * The list grows from real `acquire` runs through the review queue (ADR 0013): a package the model
 * reached for and the policy refused is reviewed by a person and, if it is a vendor's own client,
 * added here. `GRAFT_PACKAGE_ALLOWLIST` extends it per deployment without a release.
 */
export const DEFAULT_PACKAGE_ALLOWLIST: readonly string[] = [
  "googleapis",
  "@octokit/rest",
  "@slack/web-api",
  "@linear/sdk",
  "@notionhq/client",
  "airtable",
  "stripe",
  "@hubspot/api-client",
  "@sendgrid/mail",
  "twilio",
  "@aws-sdk/*",
];

export type PackagePolicyConfig = {
  /** Exact package names, or `@scope/*` for a whole scope. */
  allowlist: readonly string[];
  /** A package younger than this, counted from its first publish, is refused. */
  minAgeDays: number;
  /** A package with fewer downloads in the last week is refused. */
  minWeeklyDownloads: number;
};

export const DEFAULT_MIN_AGE_DAYS = 90;
export const DEFAULT_MIN_WEEKLY_DOWNLOADS = 1000;

export const DEFAULT_PACKAGE_POLICY: PackagePolicyConfig = {
  allowlist: DEFAULT_PACKAGE_ALLOWLIST,
  minAgeDays: DEFAULT_MIN_AGE_DAYS,
  minWeeklyDownloads: DEFAULT_MIN_WEEKLY_DOWNLOADS,
};

/**
 * What the registry knows about a package that the policy asks about. `publishedAt` is the
 * package's first publish (`time.created`), not the version's: a typosquat is a young *package*, and
 * a fresh version of an old one is not what the age rule is for. `hasProvenance` is whether the
 * version asked about carries an npm provenance attestation. Null fields are facts the registry did
 * not have, and each fails the rule that needs it. The whole of it is null only when the registry
 * has no such package or no such version — it is asked about an allowlisted name too (GRA-176).
 */
export type PackageMetadata = {
  publishedAt: Date | null;
  weeklyDownloads: number | null;
  hasProvenance: boolean;
};

export const PACKAGE_POLICY_RULES = [
  "invalid-name",
  "exact-version",
  "unknown-package",
  "provenance",
  "age",
  "downloads",
] as const;
export type PackagePolicyRule = (typeof PACKAGE_POLICY_RULES)[number];

export type PackageVerdict =
  | { allowed: true; reason: "allowlist" | "attested" }
  | { allowed: false; rule: PackagePolicyRule; message: string };

/**
 * An npm package name as the registry accepts one: lowercase, URL-safe, optionally scoped, at most
 * 214 characters. The `import-not-vendored` rule in the check matches on the same names, so a name
 * that fails here would never have resolved anyway.
 */
const PACKAGE_NAME = /^(@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const PACKAGE_NAME_MAX_LENGTH = 214;

export function isValidPackageName(name: string): boolean {
  return name.length <= PACKAGE_NAME_MAX_LENGTH && PACKAGE_NAME.test(name);
}

/**
 * An exact version: `1.2.3`, with a prerelease or build tag allowed. Every range operator, `x`,
 * `*`, a dist-tag, a URL, a `file:` or `npm:` alias is a resolution the registry would make at
 * install time and could make differently tomorrow — ADR 0013 pins.
 */
const EXACT_VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

export function isExactVersion(spec: string): boolean {
  return EXACT_VERSION.test(spec);
}

/** Whether a name is on the allowlist, by exact name or by scope pattern. */
export function isAllowlisted(name: string, allowlist: readonly string[]): boolean {
  for (const entry of allowlist) {
    if (entry === name) return true;
    if (entry.endsWith("/*") && name.startsWith(entry.slice(0, -1))) return true;
  }
  return false;
}

/** How old a package is at `now`, in whole days. */
export function ageInDays(publishedAt: Date, now: Date): number {
  return Math.floor((now.getTime() - publishedAt.getTime()) / 86_400_000);
}

/**
 * The policy over one declared dependency. The rules run in the order a reader of a refusal wants
 * them: the name and the version first, because those are the module's to fix; then what the
 * registry said. The allowlist is not a rule of its own but a waiver of the provenance rule alone
 * (GRA-176) — a vendor's own client may publish no attestation, and admitting one that does not is
 * what the list is for; an allowlisted name the registry has never heard of, or one nobody
 * downloads, is not a vendor's client, and the age and download rules are what say so. `metadata`
 * null is the registry having no such package or no such version, for an allowlisted name as for
 * any other. What the age rule can see is bounded by `PackageMetadata` above: it catches a young
 * package, never a young *version* of an old one.
 */
export function evaluatePackage(
  pkg: { name: string; version: string; metadata: PackageMetadata | null },
  config: PackagePolicyConfig & { now: Date },
): PackageVerdict {
  const { name, version, metadata } = pkg;

  if (!isValidPackageName(name)) {
    return {
      allowed: false,
      rule: "invalid-name",
      message: `${JSON.stringify(name)} is not a package name the registry would accept.`,
    };
  }

  if (!isExactVersion(version)) {
    return {
      allowed: false,
      rule: "exact-version",
      message: `${name}@${version} is not an exact version: a dependency is pinned to one release, like ${name}@1.2.3, so the install resolves to the same files every time.`,
    };
  }

  const allowlisted = isAllowlisted(name, config.allowlist);

  if (metadata === null) {
    return {
      allowed: false,
      rule: "unknown-package",
      message: `${name}@${version} is not in the registry.`,
    };
  }

  if (!allowlisted && !metadata.hasProvenance) {
    return {
      allowed: false,
      rule: "provenance",
      message: `${name}@${version} carries no npm provenance attestation, and it is not an official vendor SDK on the allowlist.`,
    };
  }

  const age = metadata.publishedAt === null ? null : ageInDays(metadata.publishedAt, config.now);
  if (age === null || age < config.minAgeDays) {
    return {
      allowed: false,
      rule: "age",
      message:
        age === null
          ? `${name} has no first-publish date in the registry; the policy requires at least ${config.minAgeDays} days.`
          : `${name} was first published ${age} day${age === 1 ? "" : "s"} ago; the policy requires at least ${config.minAgeDays}.`,
    };
  }

  const downloads = metadata.weeklyDownloads;
  if (downloads === null || downloads < config.minWeeklyDownloads) {
    return {
      allowed: false,
      rule: "downloads",
      message:
        downloads === null
          ? `${name} has no download count in the registry; the policy requires at least ${config.minWeeklyDownloads} a week.`
          : `${name} was downloaded ${downloads} time${downloads === 1 ? "" : "s"} last week; the policy requires at least ${config.minWeeklyDownloads}.`,
    };
  }

  return { allowed: true, reason: allowlisted ? "allowlist" : "attested" };
}
