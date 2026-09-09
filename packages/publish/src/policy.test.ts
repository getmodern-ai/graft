import { describe, expect, it } from "vitest";

import {
  ageInDays,
  DEFAULT_PACKAGE_ALLOWLIST,
  DEFAULT_PACKAGE_POLICY,
  evaluatePackage,
  isAllowlisted,
  isExactVersion,
  isValidPackageName,
  type PackageMetadata,
} from "./policy";

/**
 * The package policy, rule by rule (ADR 0013). Pure: a name, a version, the registry's facts and a
 * clock in, a verdict out — so the network is never in a test here.
 */

const NOW = new Date("2026-09-09T12:00:00Z");
const config = { ...DEFAULT_PACKAGE_POLICY, now: NOW };

/** A package the registry knows well: attested, years old, downloaded plenty. */
const GOOD: PackageMetadata = {
  publishedAt: new Date("2018-01-17T19:39:14.694Z"),
  weeklyDownloads: 13_621_015,
  hasProvenance: true,
};

describe("exact versions", () => {
  it("accepts one release, with a prerelease or build tag", () => {
    for (const ok of [
      "1.2.3",
      "0.0.1",
      "22.0.1",
      "21.0.0-beta.4",
      "1.0.0+build.7",
      "1.0.0-rc.1+x",
    ]) {
      expect(isExactVersion(ok), ok).toBe(true);
    }
  });

  it("refuses every range, tag, alias and URL", () => {
    for (const bad of [
      "^1.2.3",
      "~1.2.3",
      ">=1.0.0",
      "1.x",
      "1.2",
      "*",
      "",
      "latest",
      "next",
      "npm:left-pad@1.3.0",
      "file:../x",
      "git+https://github.com/x/y.git",
      "https://example.com/x.tgz",
      "1.2.3 || 2.0.0",
      "v1.2.3",
    ]) {
      expect(isExactVersion(bad), bad).toBe(false);
    }
  });

  it("is the first rule, refusing a range even for an allowlisted SDK", () => {
    const verdict = evaluatePackage(
      { name: "@slack/web-api", version: "^7.0.0", metadata: null },
      config,
    );
    expect(verdict).toMatchObject({ allowed: false, rule: "exact-version" });
    expect((verdict as { message: string }).message).toContain("@slack/web-api@^7.0.0");
  });
});

describe("package names", () => {
  it("accepts npm's shape and refuses what the registry would", () => {
    for (const ok of ["left-pad", "@octokit/rest", "@aws-sdk/client-s3", "lodash.get", "a"]) {
      expect(isValidPackageName(ok), ok).toBe(true);
    }
    for (const bad of [
      "",
      "Left-Pad",
      " left-pad",
      "@scope",
      "@/x",
      "../x",
      "a/b",
      "x".repeat(215),
    ]) {
      expect(isValidPackageName(bad), bad).toBe(false);
    }
    expect(
      evaluatePackage({ name: "Not-A-Name", version: "1.0.0", metadata: GOOD }, config),
    ).toMatchObject({ allowed: false, rule: "invalid-name" });
  });
});

describe("the allowlist", () => {
  it("starts with the official vendor SDKs, the AWS scope as a pattern", () => {
    expect(DEFAULT_PACKAGE_ALLOWLIST).toEqual(
      expect.arrayContaining([
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
      ]),
    );
  });

  it("matches an exact name or a scope pattern, and nothing looser", () => {
    expect(isAllowlisted("stripe", DEFAULT_PACKAGE_ALLOWLIST)).toBe(true);
    expect(isAllowlisted("@aws-sdk/client-s3", DEFAULT_PACKAGE_ALLOWLIST)).toBe(true);
    expect(isAllowlisted("stripe-mock", DEFAULT_PACKAGE_ALLOWLIST)).toBe(false);
    expect(isAllowlisted("@aws-sdk", DEFAULT_PACKAGE_ALLOWLIST)).toBe(false);
    expect(isAllowlisted("@octokit/core", DEFAULT_PACKAGE_ALLOWLIST)).toBe(false);
    expect(isAllowlisted("googleapis", [])).toBe(false);
  });

  it("allows an exact-pinned allowlisted package with no registry facts at all", () => {
    expect(
      evaluatePackage({ name: "@aws-sdk/client-s3", version: "3.700.0", metadata: null }, config),
    ).toEqual({ allowed: true, reason: "allowlist" });
  });

  it("is extended by configuration", () => {
    const extended = { ...config, allowlist: [...DEFAULT_PACKAGE_ALLOWLIST, "left-pad"] };
    expect(
      evaluatePackage({ name: "left-pad", version: "1.3.0", metadata: null }, extended),
    ).toEqual({ allowed: true, reason: "allowlist" });
  });
});

describe("off the allowlist", () => {
  it("refuses a package the registry does not have", () => {
    expect(
      evaluatePackage({ name: "left-pad-typo", version: "1.0.0", metadata: null }, config),
    ).toMatchObject({ allowed: false, rule: "unknown-package" });
  });

  it("requires provenance", () => {
    const verdict = evaluatePackage(
      { name: "left-pad", version: "1.3.0", metadata: { ...GOOD, hasProvenance: false } },
      config,
    );
    expect(verdict).toMatchObject({ allowed: false, rule: "provenance" });
    expect((verdict as { message: string }).message).toContain("left-pad@1.3.0");
  });

  it("requires the package to be at least the configured age, from its first publish", () => {
    const young = new Date(NOW.getTime() - 89 * 86_400_000);
    expect(
      evaluatePackage(
        { name: "fresh", version: "1.0.0", metadata: { ...GOOD, publishedAt: young } },
        config,
      ),
    ).toMatchObject({ allowed: false, rule: "age", message: expect.stringContaining("89 days") });
    const exactly = new Date(NOW.getTime() - 90 * 86_400_000);
    expect(
      evaluatePackage(
        { name: "ok", version: "1.0.0", metadata: { ...GOOD, publishedAt: exactly } },
        config,
      ),
    ).toEqual({ allowed: true, reason: "attested" });
    expect(
      evaluatePackage(
        { name: "undated", version: "1.0.0", metadata: { ...GOOD, publishedAt: null } },
        config,
      ),
    ).toMatchObject({ allowed: false, rule: "age" });
    expect(ageInDays(new Date("2026-09-01T00:00:00Z"), NOW)).toBe(8);
  });

  it("requires the configured weekly downloads", () => {
    expect(
      evaluatePackage(
        { name: "quiet", version: "1.0.0", metadata: { ...GOOD, weeklyDownloads: 999 } },
        config,
      ),
    ).toMatchObject({ allowed: false, rule: "downloads", message: expect.stringContaining("999") });
    expect(
      evaluatePackage(
        { name: "ok", version: "1.0.0", metadata: { ...GOOD, weeklyDownloads: 1000 } },
        config,
      ),
    ).toEqual({ allowed: true, reason: "attested" });
    expect(
      evaluatePackage(
        { name: "uncounted", version: "1.0.0", metadata: { ...GOOD, weeklyDownloads: null } },
        config,
      ),
    ).toMatchObject({ allowed: false, rule: "downloads" });
  });

  it("takes the thresholds from configuration", () => {
    const lax = { ...config, minAgeDays: 0, minWeeklyDownloads: 0 };
    expect(
      evaluatePackage(
        {
          name: "new",
          version: "1.0.0",
          metadata: { publishedAt: NOW, weeklyDownloads: 0, hasProvenance: true },
        },
        lax,
      ),
    ).toEqual({ allowed: true, reason: "attested" });
  });

  it("allows an attested, old, popular package", () => {
    expect(
      evaluatePackage({ name: "@octokit/core", version: "6.1.0", metadata: GOOD }, config),
    ).toEqual({ allowed: true, reason: "attested" });
  });
});
