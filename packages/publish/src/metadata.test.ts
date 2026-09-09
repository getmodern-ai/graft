import { describe, expect, it } from "vitest";

import {
  createFakeMetadataSource,
  createRegistryMetadataSource,
  RegistryUnavailableError,
} from "./metadata";

/**
 * The registry-backed metadata source against recorded responses — what `registry.npmjs.org` and
 * `api.npmjs.org` answered on 9 September 2026, trimmed to the fields the source reads. Never the
 * live registry: the point is what the source does with each shape of answer, and the live shapes
 * are pinned here so a change in them is a red test rather than a policy that quietly refuses
 * everything.
 */

const LEFT_PAD = {
  name: "left-pad",
  "dist-tags": { latest: "1.3.0" },
  time: {
    created: "2014-03-14T09:09:20.762Z",
    modified: "2024-04-16T05:01:57.431Z",
    "1.3.0": "2018-04-09T01:10:45.796Z",
  },
  versions: {
    "1.3.0": {
      name: "left-pad",
      version: "1.3.0",
      dist: {
        integrity:
          "sha512-XI5MPzVNApjAyhQzphX8BkmKsKUxD4LdyK24iZeQGinBN9yTQT3bFlCBy/aVx2HrNcqQGsdot8ghrjyrvMCoEA==",
        tarball: "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz",
      },
    },
  },
};
const LEFT_PAD_DOWNLOADS = {
  downloads: 1_436_537,
  start: "2026-08-31",
  end: "2026-09-06",
  package: "left-pad",
};

const OCTOKIT_REST = {
  name: "@octokit/rest",
  "dist-tags": { latest: "22.0.1" },
  time: {
    created: "2018-01-17T19:39:14.694Z",
    modified: "2026-07-24T15:24:17.702Z",
    "22.0.1": "2025-10-31T20:59:36.519Z",
  },
  versions: {
    "22.0.1": {
      name: "@octokit/rest",
      version: "22.0.1",
      dist: {
        integrity:
          "sha512-Jzbhzl3CEexhnivb1iQ0KJ7s5vvjMWcmRtq5aUsKmKDrRW6z3r84ngmiFKFvpZjpiU/9/S6ITPFRpn5s/3uQJw==",
        tarball: "https://registry.npmjs.org/@octokit/rest/-/rest-22.0.1.tgz",
        attestations: {
          url: "https://registry.npmjs.org/-/npm/v1/attestations/@octokit%2frest@22.0.1",
          provenance: { predicateType: "https://slsa.dev/provenance/v1" },
        },
      },
    },
  },
};
const OCTOKIT_REST_DOWNLOADS = {
  downloads: 13_621_015,
  start: "2026-08-31",
  end: "2026-09-06",
  package: "@octokit/rest",
};

type Recorded = Record<string, { status: number; body: unknown }>;

/** A `fetch` that answers from the recording and records what was asked. */
function recordedFetch(recording: Recorded) {
  const requests: string[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    requests.push(url);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const answer = recording[url];
    if (!answer) throw new TypeError(`fetch failed: no recording for ${url}`);
    return new Response(
      typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body),
      { status: answer.status, headers: { "content-type": "application/json" } },
    );
  }) as typeof globalThis.fetch;
  return { fetch, requests };
}

const REGISTRY: Recorded = {
  "https://registry.npmjs.org/left-pad": { status: 200, body: LEFT_PAD },
  "https://api.npmjs.org/downloads/point/last-week/left-pad": {
    status: 200,
    body: LEFT_PAD_DOWNLOADS,
  },
  "https://registry.npmjs.org/@octokit%2Frest": { status: 200, body: OCTOKIT_REST },
  "https://api.npmjs.org/downloads/point/last-week/@octokit/rest": {
    status: 200,
    body: OCTOKIT_REST_DOWNLOADS,
  },
  "https://registry.npmjs.org/this-package-does-not-exist-graft-xyz": {
    status: 404,
    body: { error: "Not found" },
  },
  "https://api.npmjs.org/downloads/point/last-week/this-package-does-not-exist-graft-xyz": {
    status: 404,
    body: { error: "package this-package-does-not-exist-graft-xyz not found" },
  },
};

describe("the npm registry metadata source", () => {
  it("reads the first publish, the version's provenance and last week's downloads, in two requests", async () => {
    const { fetch, requests } = recordedFetch(REGISTRY);
    const source = createRegistryMetadataSource({ fetch });

    expect(await source.lookup("left-pad", "1.3.0")).toEqual({
      publishedAt: new Date("2014-03-14T09:09:20.762Z"),
      weeklyDownloads: 1_436_537,
      hasProvenance: false,
    });
    expect(requests).toEqual([
      "https://registry.npmjs.org/left-pad",
      "https://api.npmjs.org/downloads/point/last-week/left-pad",
    ]);
  });

  it("encodes a scoped name's slash for the registry and not for the downloads API, and sees the attestation", async () => {
    const { fetch, requests } = recordedFetch(REGISTRY);
    const source = createRegistryMetadataSource({ fetch });

    expect(await source.lookup("@octokit/rest", "22.0.1")).toEqual({
      publishedAt: new Date("2018-01-17T19:39:14.694Z"),
      weeklyDownloads: 13_621_015,
      hasProvenance: true,
    });
    expect(requests).toEqual([
      "https://registry.npmjs.org/@octokit%2Frest",
      "https://api.npmjs.org/downloads/point/last-week/@octokit/rest",
    ]);
  });

  it("answers null for a package the registry does not have, and for a version it does not", async () => {
    const source = createRegistryMetadataSource({ fetch: recordedFetch(REGISTRY).fetch });
    expect(await source.lookup("this-package-does-not-exist-graft-xyz", "1.0.0")).toBeNull();
    expect(await source.lookup("left-pad", "9.9.9")).toBeNull();
  });

  it("answers a null download count when the downloads API has none, and the policy decides", async () => {
    const { fetch } = recordedFetch({
      ...REGISTRY,
      "https://api.npmjs.org/downloads/point/last-week/left-pad": {
        status: 404,
        body: { error: "package left-pad not found" },
      },
    });
    const source = createRegistryMetadataSource({ fetch });
    expect(await source.lookup("left-pad", "1.3.0")).toMatchObject({ weeklyDownloads: null });
  });

  it("throws RegistryUnavailableError for a 5xx, a network failure and a body that is not JSON", async () => {
    const down = createRegistryMetadataSource({
      fetch: recordedFetch({
        ...REGISTRY,
        "https://registry.npmjs.org/left-pad": { status: 503, body: "unavailable" },
      }).fetch,
    });
    await expect(down.lookup("left-pad", "1.3.0")).rejects.toBeInstanceOf(RegistryUnavailableError);
    await expect(down.lookup("left-pad", "1.3.0")).rejects.toThrow(/answered 503/);

    const unreachable = createRegistryMetadataSource({ fetch: recordedFetch({}).fetch });
    await expect(unreachable.lookup("left-pad", "1.3.0")).rejects.toThrow(/could not be reached/);

    const garbled = createRegistryMetadataSource({
      fetch: recordedFetch({
        ...REGISTRY,
        "https://registry.npmjs.org/left-pad": { status: 200, body: "<html>" },
      }).fetch,
    });
    await expect(garbled.lookup("left-pad", "1.3.0")).rejects.toThrow(/not JSON/);
  });

  it("takes the registry and downloads URLs from options, for a mirror", async () => {
    const { fetch, requests } = recordedFetch({
      "https://mirror.example/registry/left-pad": { status: 200, body: LEFT_PAD },
      "https://mirror.example/api/downloads/point/last-week/left-pad": {
        status: 200,
        body: LEFT_PAD_DOWNLOADS,
      },
    });
    const source = createRegistryMetadataSource({
      fetch,
      registryUrl: "https://mirror.example/registry/",
      downloadsUrl: "https://mirror.example/api",
    });
    expect(await source.lookup("left-pad", "1.3.0")).toMatchObject({ weeklyDownloads: 1_436_537 });
    expect(requests[0]).toBe("https://mirror.example/registry/left-pad");
  });
});

describe("the fake metadata source", () => {
  it("answers from its table by name@version, then by name, else null, and records the lookups", async () => {
    const source = createFakeMetadataSource({
      "left-pad@1.3.0": { publishedAt: null, weeklyDownloads: 1, hasProvenance: false },
      lodash: { publishedAt: null, weeklyDownloads: 2, hasProvenance: true },
      broken: new Error("registry down"),
    });
    expect(await source.lookup("left-pad", "1.3.0")).toMatchObject({ weeklyDownloads: 1 });
    expect(await source.lookup("left-pad", "1.0.0")).toBeNull();
    expect(await source.lookup("lodash", "4.17.21")).toMatchObject({ weeklyDownloads: 2 });
    await expect(source.lookup("broken", "1.0.0")).rejects.toThrow("registry down");
    expect(source.lookups).toEqual([
      "left-pad@1.3.0",
      "left-pad@1.0.0",
      "lodash@4.17.21",
      "broken@1.0.0",
    ]);
  });
});
