import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createFilesystemToolboxStore } from "@graft/toolbox";
import { LOCAL_KEYRING_ID } from "@graft/vault";
import { describe, expect, it } from "vitest";

import { assertCloudBackings, type BackingsEnv, selectBackings } from "./backings";

/**
 * The selector's contract (ADR 0002): under `open` it builds the backings this repository holds;
 * under `cloud` it loads a module by name and takes what `createCloudBackings` answers, or refuses
 * with a sentence naming what is wrong. The cloud half is driven with modules under `./testing/`
 * standing where the private package would, since the private package is by design not here.
 */

const store = createFilesystemToolboxStore({
  root: mkdtempSync(join(tmpdir(), "graft-backings-")),
});

const base: BackingsEnv = {
  NODE_ENV: "test",
  GRAFT_BACKINGS: "open",
  GRAFT_KEYRING_SECRET: "test-secret-that-is-long-enough-32",
  GRAFT_PROXY_PUBLIC_URL: "http://localhost:3000/api/proxy",
  GRAFT_TOOLBOX_ROOT: store.root,
};

const fixture = (name: string) =>
  fileURLToPath(new URL(`./testing/cloud-backings-${name}.ts`, import.meta.url));

describe("the open form", () => {
  it("builds the local keyring and the recording mirror, and no sandbox without the Docker pair", async () => {
    const backings = await selectBackings(base, { store });

    expect(backings.form).toBe("open");
    expect(backings.sandbox).toBeNull();
    expect(backings.keyring.id).toBe(LOCAL_KEYRING_ID);
    await expect(backings.mirror.mirrorVersion("person1", "tools/v/t/v1")).resolves.toBeUndefined();
  });

  it("builds the Docker sandbox backing when the pair is set", async () => {
    const backings = await selectBackings(
      { ...base, GRAFT_SANDBOX_IMAGE: "graft-sandbox:dev", GRAFT_SANDBOX_NETWORK: "graft-sandbox" },
      { store },
    );

    expect(backings.sandbox).not.toBeNull();
    expect(typeof backings.sandbox?.install).toBe("function");
  });

  it("refuses to build the local keyring with no secret", async () => {
    await expect(
      selectBackings({ ...base, GRAFT_KEYRING_SECRET: undefined }, { store }),
    ).rejects.toThrow(/GRAFT_KEYRING_SECRET/);
  });
});

describe("the cloud form", () => {
  const cloud: BackingsEnv = { ...base, GRAFT_BACKINGS: "cloud", GRAFT_KEYRING_SECRET: undefined };

  it("loads the module, hands its factory the environment, the raw variables and the store, and takes its three backings", async () => {
    const backings = await selectBackings(cloud, {
      store,
      raw: { GRAFT_FAKE_CLOUD_MARKER: "reached" },
      cloudModule: fixture("fake"),
    });

    expect(backings.form).toBe("cloud");
    expect(backings.keyring.id).toBe("fake-cloud");
    expect(await backings.sandbox?.list()).toEqual([]);
    await backings.mirror.mirrorVersion("person1", ".drafts/job1");
    expect(JSON.parse(await store.read("person1", ".drafts/job1/mirrored.json"))).toEqual({
      nodeEnv: "test",
      proxy: "http://localhost:3000/api/proxy",
      marker: "reached",
    });
  });

  it("refuses a module that is not installed, saying which and how to boot without it", async () => {
    await expect(
      selectBackings(cloud, { store, cloudModule: "@graft/no-such-cloud-backings" }),
    ).rejects.toThrow(/@graft\/no-such-cloud-backings is not installed.*GRAFT_BACKINGS=open/);
  });

  it("refuses a module without the export", async () => {
    await expect(selectBackings(cloud, { store, cloudModule: "@graft/toolbox" })).rejects.toThrow(
      /does not export createCloudBackings/,
    );
  });

  it("refuses a factory that answers with fewer than three backings", async () => {
    await expect(selectBackings(cloud, { store, cloudModule: fixture("broken") })).rejects.toThrow(
      /returned no mirror backing/,
    );
  });
});

describe("assertCloudBackings", () => {
  const complete = {
    sandbox: { ensure() {}, destroy() {}, list() {}, install() {} },
    keyring: { id: "k", generateDataKey() {}, unwrapDataKey() {} },
    mirror: { mirrorVersion() {} },
  };

  it("accepts the three seams and names the first missing function or the missing id", () => {
    expect(() => assertCloudBackings(complete, "m")).not.toThrow();
    expect(() =>
      assertCloudBackings({ ...complete, sandbox: { ...complete.sandbox, install: 1 } }, "m"),
    ).toThrow(/sandbox backing without install\(\)/);
    expect(() =>
      assertCloudBackings({ ...complete, keyring: { ...complete.keyring, id: undefined } }, "m"),
    ).toThrow(/keyring with no id/);
    expect(() => assertCloudBackings(null, "m")).toThrow(/no sandbox backing/);
  });
});
