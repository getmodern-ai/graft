import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { keyringProvider } from "@graft/core";
import { LOCAL_KEYRING_ID } from "@graft/vault";
import { describe, expect, it } from "vitest";

import {
  assertCloudBackings,
  type BackingsEnv,
  environmentProviders,
  gatewayProviderFrom,
  selectBackings,
} from "./backings";

/**
 * The selector's contract (ADR 0002): under `open` it builds the backings this repository holds and
 * the store where the sandbox chosen can see it; under `cloud` it loads a module by name and takes
 * what `createCloudBackings` answers, or refuses with a sentence naming what is wrong. The cloud half
 * is driven with modules under `./testing/` standing where the private package would, since the
 * private package is by design not here.
 */

const toolboxRoot = mkdtempSync(join(tmpdir(), "graft-backings-"));

const base: BackingsEnv = {
  NODE_ENV: "test",
  GRAFT_BACKINGS: "open",
  GRAFT_KEYRING_SECRET: "test-secret-that-is-long-enough-32",
  GRAFT_SANDBOX_BACKEND: "docker",
  GRAFT_PROXY_PUBLIC_URL: "http://localhost:3000/api/proxy",
  GRAFT_TOOLBOX_ROOT: toolboxRoot,
};

const fixture = (name: string) =>
  fileURLToPath(new URL(`./testing/cloud-backings-${name}.ts`, import.meta.url));

describe("the open form", () => {
  it("builds the local keyring, the recording mirror and the store at the toolbox root, and no sandbox without the Docker pair", async () => {
    const backings = await selectBackings(base);

    expect(backings.form).toBe("open");
    expect(backings.sandbox).toBeNull();
    expect(backings.keyring.id).toBe(LOCAL_KEYRING_ID);
    expect(backings.providers).toEqual([keyringProvider]);
    expect(backings.toolboxRoot).toBe(toolboxRoot);
    await expect(backings.mirror.mirrorVersion("person1", "tools/v/t/v1")).resolves.toBeUndefined();
    // The open form's mail is the console transport: the link goes into the server's log (ADR 0021).
    expect(backings.mail.name).toBe("console");
  });

  it("builds the Docker sandbox backing when the pair is set", async () => {
    const backings = await selectBackings({
      ...base,
      GRAFT_SANDBOX_IMAGE: "graft-sandbox:dev",
      GRAFT_SANDBOX_NETWORK: "graft-sandbox",
    });

    expect(backings.sandbox).not.toBeNull();
    expect(typeof backings.sandbox?.install).toBe("function");
    expect(backings.toolboxRoot).toBe(toolboxRoot);
  });

  it("builds the Docker backing over the shared toolbox volume when one is named, the store still at the root", async () => {
    const backings = await selectBackings({
      ...base,
      GRAFT_SANDBOX_IMAGE: "graft-sandbox:dev",
      GRAFT_SANDBOX_NETWORK: "graft-sandbox",
      GRAFT_TOOLBOX_VOLUME: "graft_toolboxes",
    });

    expect(backings.sandbox).not.toBeNull();
    expect(backings.toolboxRoot).toBe(toolboxRoot);
  });

  it("builds the fake sandbox with the store inside the fake's own root, so the two see one tree", async () => {
    const backings = await selectBackings({ ...base, GRAFT_SANDBOX_BACKEND: "fake" });
    const sandbox = backings.sandbox;
    if (!sandbox) throw new Error("the fake is always a sandbox");

    expect(backings.toolboxRoot).not.toBe(toolboxRoot);
    expect(backings.toolboxRoot?.endsWith("/toolboxes")).toBe(true);
    // What the store writes is what a sandbox of the fake mounts.
    await backings.store.writeTree("person1", "tools/v/t/v1", [{ path: "a.txt", content: "one" }]);
    const { handle } = await sandbox.ensure({ name: "s" });
    await handle.mountToolbox({ toolboxId: "person1", mountPath: "/tools" });
    expect(await handle.read("/tools/tools/v/t/v1/a.txt")).toBe("one");
  });

  it("refuses to build the local keyring with no secret", async () => {
    await expect(selectBackings({ ...base, GRAFT_KEYRING_SECRET: undefined })).rejects.toThrow(
      /GRAFT_KEYRING_SECRET/,
    );
  });
});

describe("the mail relay from the environment (ADR 0021, GRA-92)", () => {
  const SMTP = {
    GRAFT_SMTP_URL: "smtps://user:pass@smtp.example.com:465",
    GRAFT_MAIL_FROM: "Graft <no-reply@graft.example>",
  };

  it("is the console without the pair and the SMTP transport with it, in the open form", async () => {
    expect((await selectBackings(base)).mail.name).toBe("console");
    expect((await selectBackings({ ...base, ...SMTP })).mail.name).toBe("smtp");
  });

  it("yields to the hosted transport in the cloud form, and stands in when the package answers none", async () => {
    const cloud: BackingsEnv = {
      ...base,
      ...SMTP,
      GRAFT_BACKINGS: "cloud",
      GRAFT_KEYRING_SECRET: undefined,
    };
    expect((await selectBackings(cloud, { cloudModule: fixture("fake") })).mail.name).toBe(
      "fake-mail",
    );
    expect((await selectBackings(cloud, { cloudModule: fixture("own-store") })).mail.name).toBe(
      "smtp",
    );
  });
});

describe("the gateway provider from the environment (ADR 0019, GRA-58)", () => {
  const gateway: Partial<BackingsEnv> = {
    GRAFT_GATEWAY_HOSTS: ["api.unleashedsoftware.com"],
    GRAFT_GATEWAY_UPSTREAM_URL: "https://gateway.corp.example/graft",
    GRAFT_GATEWAY_HEADER_NAME: "X-Deployment-Token",
    GRAFT_GATEWAY_HEADER_VALUE: "deployment-identity-secret-value",
  };

  it("is null with the group unset, and the provider with it — the prefix carried when set", async () => {
    expect(gatewayProviderFrom(base)).toBeNull();
    const provider = gatewayProviderFrom({ ...base, ...gateway });
    expect(provider?.name).toBe("gateway");
    expect(provider?.connect).toEqual({ kind: "none", scheme: "gateway" });
    expect(await provider?.covers("unleashed", ["api.unleashedsoftware.com"])).toBe(true);
    expect(await provider?.covers("acme", ["api.acme.example"])).toBe(false);
    const prefixed = gatewayProviderFrom({
      ...base,
      ...gateway,
      GRAFT_GATEWAY_HEADER_PREFIX: "x-graft-",
    });
    const resolution = prefixed?.resolve({} as never);
    expect(resolution?.mode === "relay" ? resolution.relay.rules : null).toEqual({
      prefix: "x-graft-",
      passThrough: ["content-type", "content-length", "accept", "accept-encoding"],
    });
  });

  it("goes first in the open form's order, the keyring after it", async () => {
    const backings = await selectBackings({ ...base, ...gateway });
    expect(backings.providers.map((provider) => provider.name)).toEqual(["gateway", "keyring"]);
    expect(backings.providers[1]).toBe(keyringProvider);
  });

  it("goes first in the cloud form's order too, ahead of what the private package answers", async () => {
    const backings = await selectBackings(
      { ...base, ...gateway, GRAFT_BACKINGS: "cloud", GRAFT_KEYRING_SECRET: undefined },
      { cloudModule: fixture("fake") },
    );
    expect(backings.providers.map((provider) => provider.name)).toEqual([
      "gateway",
      "fake-broker",
      "keyring",
    ]);
  });
});

describe("the providers the environment configures (ADR 0019)", () => {
  const gateway: Partial<BackingsEnv> = {
    GRAFT_GATEWAY_HOSTS: ["api.unleashedsoftware.com"],
    GRAFT_GATEWAY_UPSTREAM_URL: "https://gateway.corp.example/graft",
    GRAFT_GATEWAY_HEADER_NAME: "X-Deployment-Token",
    GRAFT_GATEWAY_HEADER_VALUE: "deployment-identity-secret-value",
  };

  it("is the gateway alone, and nothing without it: every other provider is the private package's (GRA-103)", async () => {
    const names = (providers: readonly { name: string }[]) => providers.map((p) => p.name);
    expect(names(environmentProviders(base))).toEqual([]);
    expect(names(environmentProviders({ ...base, ...gateway }))).toEqual(["gateway"]);
    const open = await selectBackings({ ...base, ...gateway });
    expect(names(open.providers)).toEqual(["gateway", "keyring"]);
    expect(open.providers[1]).toBe(keyringProvider);
    // Under `cloud` the hosted providers sit between the gateway and the keyring, in the order the
    // private package answers them.
    const cloud = await selectBackings(
      { ...base, ...gateway, GRAFT_BACKINGS: "cloud", GRAFT_KEYRING_SECRET: undefined },
      { cloudModule: fixture("fake") },
    );
    expect(names(cloud.providers)).toEqual(["gateway", "fake-broker", "keyring"]);
  });
});

describe("the cloud form", () => {
  const cloud: BackingsEnv = { ...base, GRAFT_BACKINGS: "cloud", GRAFT_KEYRING_SECRET: undefined };

  it("loads the module, hands its factory the environment, the raw variables and the store, and takes its three backings", async () => {
    const backings = await selectBackings(cloud, {
      raw: { GRAFT_FAKE_CLOUD_MARKER: "reached" },
      cloudModule: fixture("fake"),
    });

    expect(backings.form).toBe("cloud");
    expect(backings.keyring.id).toBe("fake-cloud");
    // The hosted provider first, the keyring appended last (ADR 0019).
    expect(backings.providers.map((provider) => provider.name)).toEqual(["fake-broker", "keyring"]);
    expect(backings.providers[1]).toBe(keyringProvider);
    // The hosted mail transport is taken as it is (ADR 0021).
    expect(backings.mail.name).toBe("fake-mail");
    expect(backings.toolboxRoot).toBe(toolboxRoot);
    expect(await backings.sandbox?.list()).toEqual([]);
    await backings.mirror.mirrorVersion("person1", ".drafts/job1");
    expect(JSON.parse(await backings.store.read("person1", ".drafts/job1/mirrored.json"))).toEqual({
      nodeEnv: "test",
      proxy: "http://localhost:3000/api/proxy",
      marker: "reached",
    });
  });

  it("takes the store a factory answers with in place of the filesystem store, and then reports no toolbox directory here", async () => {
    const backings = await selectBackings(cloud, { cloudModule: fixture("own-store") });

    expect(backings.form).toBe("cloud");
    expect(backings.keyring.id).toBe("own-store");
    expect(backings.toolboxRoot).toBeNull();
    // The factory wrote a marker through its own store before answering; reading it back through
    // the selector's store is what shows the two are one.
    expect(await backings.store.read("person1", "tools/own/marker/v1/marker.txt")).toBe(
      "written by the factory's own store",
    );
    // A write through it lands in the factory's store, not in a directory at the toolbox root.
    await backings.store.writeTree("own-person", ".drafts/job1", [{ path: "a.txt", content: "a" }]);
    expect(await backings.store.exists("own-person", ".drafts/job1/a.txt")).toBe(true);
    expect(existsSync(join(toolboxRoot, "own-person"))).toBe(false);
  });

  it("appends the keyring when a factory answers no providers, and keeps the console transport when it answers no mail", async () => {
    const backings = await selectBackings(cloud, { cloudModule: fixture("own-store") });
    expect(backings.providers).toEqual([keyringProvider]);
    expect(backings.mail.name).toBe("console");
  });

  it("refuses a factory whose provider calls itself the keyring", async () => {
    await expect(
      selectBackings(cloud, { cloudModule: fixture("shadowing-provider") }),
    ).rejects.toThrow(/connection providers: two connection providers are named keyring/);
  });

  it("refuses a factory whose store is not a whole store", async () => {
    await expect(selectBackings(cloud, { cloudModule: fixture("half-store") })).rejects.toThrow(
      /returned a store without writeTree\(\)/,
    );
  });

  it("refuses a module that is not installed, saying which and how to boot without it", async () => {
    await expect(
      selectBackings(cloud, { cloudModule: "@graft/no-such-cloud-backings" }),
    ).rejects.toThrow(/@graft\/no-such-cloud-backings is not installed.*GRAFT_BACKINGS=open/);
  });

  it("refuses a module without the export", async () => {
    await expect(selectBackings(cloud, { cloudModule: "@graft/toolbox" })).rejects.toThrow(
      /does not export createCloudBackings/,
    );
  });

  it("refuses a factory that answers with fewer than three backings", async () => {
    await expect(selectBackings(cloud, { cloudModule: fixture("broken") })).rejects.toThrow(
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

  const store = {
    readTree() {},
    writeTree() {},
    read() {},
    list() {},
    exists() {},
    remove() {},
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

  const link = {
    kind: "link",
    scheme: "relay",
    target() {},
    start() {},
    complete() {},
  };

  it("accepts providers beside the seams and names what a malformed one lacks", () => {
    const provider = {
      name: "broker",
      connect: link,
      covers() {},
      resolve() {},
      revoke() {},
    };
    expect(() => assertCloudBackings({ ...complete, providers: [provider] }, "m")).not.toThrow();
    expect(() =>
      assertCloudBackings(
        { ...complete, providers: [{ ...provider, connect: { kind: "none", scheme: "gateway" } }] },
        "m",
      ),
    ).not.toThrow();
    // A link provider carries its flow (ADR 0019; GRA-59): the three functions and its relay scheme.
    expect(() =>
      assertCloudBackings(
        { ...complete, providers: [{ ...provider, connect: { ...link, complete: undefined } }] },
        "m",
      ),
    ).toThrow(/provider broker, which connects with a link, without connect\.complete\(\)/);
    expect(() =>
      assertCloudBackings(
        { ...complete, providers: [{ ...provider, connect: { ...link, scheme: "" } }] },
        "m",
      ),
    ).toThrow(/with no relay scheme/);
    expect(() => assertCloudBackings({ ...complete, providers: [] }, "m")).not.toThrow();
    expect(() => assertCloudBackings({ ...complete, providers: "no" }, "m")).toThrow(
      /providers that are not a list/,
    );
    expect(() =>
      assertCloudBackings({ ...complete, providers: [{ ...provider, name: "" }] }, "m"),
    ).toThrow(/provider 0 with no name/);
    expect(() =>
      assertCloudBackings(
        { ...complete, providers: [{ ...provider, connect: { kind: "magic" } }] },
        "m",
      ),
    ).toThrow(/provider broker with no connect kind/);
    expect(() =>
      assertCloudBackings({ ...complete, providers: [{ ...provider, revoke: 1 }] }, "m"),
    ).toThrow(/provider broker without revoke\(\)/);
  });

  it("holds each provider's connect shape to what the type accepts: a relay scheme for none and link, the proxy's signing schemes for a form (GRA-62)", () => {
    const provider = { name: "gw", covers() {}, resolve() {}, revoke() {} };
    const withConnect = (connect: unknown) => () =>
      assertCloudBackings({ ...complete, providers: [{ ...provider, connect }] }, "m");
    // No person step (GRA-58): the relay scheme every row records, one the proxy implements. A
    // package built against the older `{ kind: "none" }` is refused at the seam, naming the provider.
    expect(withConnect({ kind: "none", scheme: "gateway" })).not.toThrow();
    expect(withConnect({ kind: "none", scheme: "relay" })).not.toThrow();
    expect(withConnect({ kind: "none" })).toThrow(
      /provider gw, which connects with no person step, with no relay scheme/,
    );
    expect(withConnect({ kind: "none", scheme: "magic" })).toThrow(
      /provider gw, which connects with no person step, with relay scheme magic, which is not one of gateway, relay/,
    );
    // A link's scheme is held to the same list, not only to being a string: a signing scheme's name
    // is not a relay scheme (`RELAY_SCHEMES` and `AUTH_SCHEMES` are kept apart in `@graft/proxy`).
    expect(withConnect({ ...link, scheme: "bearer" })).toThrow(
      /provider gw, which connects with a link, with relay scheme bearer, which is not one of gateway, relay/,
    );
    // A form is the scheme picker over the proxy's signing schemes: at least one, and no stranger.
    expect(withConnect({ kind: "form", schemes: ["bearer", "none"] })).not.toThrow();
    expect(withConnect({ kind: "form", schemes: [] })).toThrow(
      /provider gw, which connects with a form, with no schemes/,
    );
    expect(withConnect({ kind: "form" })).toThrow(/which connects with a form, with no schemes/);
    expect(withConnect({ kind: "form", schemes: ["bearer", "gateway"] })).toThrow(
      /provider gw, which connects with a form, with scheme gateway, which is not one of api_key_header, api_key_query/,
    );
  });

  it("accepts a store beside the seams, whole or absent, and names the first verb a partial one lacks", () => {
    expect(() => assertCloudBackings({ ...complete, store }, "m")).not.toThrow();
    expect(() => assertCloudBackings({ ...complete, store: undefined }, "m")).not.toThrow();
    expect(() =>
      assertCloudBackings({ ...complete, store: { ...store, remove: "no" } }, "m"),
    ).toThrow(/store without remove\(\)/);
    expect(() => assertCloudBackings({ ...complete, store: null }, "m")).toThrow(
      /store that is not an object/,
    );
  });
});
