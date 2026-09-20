import type { ConnectionRow } from "@graft/db/repo/connection";
import { AUTH_SCHEMES, type RelayPlugin } from "@graft/proxy/types";
import { describe, expect, it } from "vitest";

import {
  type ConnectionProvider,
  DEFAULT_PROVIDERS,
  describeProviders,
  KEYRING_PROVIDER,
  keyringProvider,
  providerFor,
  providerLinkOf,
  providerListProblem,
  providerNamed,
} from "./provider";

/**
 * The provider seam on its own (ADR 0019): the keyring provider is today's behaviour restated, and
 * the three helpers over a list — by name, by coverage, and what a list must be to be one. A relay
 * provider is played by a fake shaped like the gateway's and the hosted form's link provider.
 */

const NOW = new Date("2026-09-17T09:00:00Z");

const row: ConnectionRow = {
  id: "conn_1",
  personId: "person_1",
  provider: "keyring",
  providerRef: null,
  vendor: "unleashed",
  displayName: "Acme Unleashed",
  scheme: "api_key_header",
  schemeConfig: { headerName: "api-auth-id" },
  primaryHost: "https://api.unleashedsoftware.com",
  hosts: ["api.unleashedsoftware.com"],
  credentialCiphertext: Buffer.from("cipher"),
  credentialSetAt: NOW,
  oauthClientId: null,
  oauthClientSecretCiphertext: null,
  oauthAuthorizeUrl: null,
  oauthTokenUrl: null,
  oauthScopes: null,
  oauthRefreshState: null,
  providerReleaseFailedAt: null,
  revokedAt: null,
  owner: "person",
  createdAt: NOW,
  updatedAt: NOW,
};

const fakeRelay: RelayPlugin = {
  kind: "relay",
  scheme: "fake_relay",
  rules: { prefix: null, passThrough: [], refuse: [], refusePrefixes: [] },
  relay: () => undefined,
  headerNames: () => [],
};

/** A relay provider covering one vendor, connecting with a link — the hosted form's shape. */
function linkProvider(
  name = "broker",
  covers: (vendor: string) => boolean = (vendor) => vendor === "gmail",
) {
  const revoked: string[] = [];
  const provider: ConnectionProvider = {
    name,
    connect: {
      kind: "link",
      scheme: "relay",
      target: async (vendor) => (covers(vendor) ? `${vendor}-app` : null),
      start: async () => ({ url: "https://broker.example/link", expiresAt: NOW }),
      complete: async () => ({ ok: true, ref: "acct_1", label: null }),
    },
    covers: async (vendor) => covers(vendor),
    resolve: (r) => ({
      mode: "relay",
      relay: { plugin: fakeRelay, obtain: async () => ({ accountId: r.providerRef ?? "" }) },
    }),
    revoke: async (r) => {
      revoked.push(r.id);
    },
  };
  return { provider, revoked };
}

describe("the keyring provider", () => {
  it("is today's behaviour: covers every vendor, connects through the form over every signing scheme, releases nothing", async () => {
    expect(keyringProvider.name).toBe(KEYRING_PROVIDER);
    expect(keyringProvider.connect).toEqual({ kind: "form", schemes: AUTH_SCHEMES });
    expect(await keyringProvider.covers("anything", ["api.anything.example"])).toBe(true);
    await expect(keyringProvider.revoke(row)).resolves.toBeUndefined();
  });

  it("resolves to the row's own columns for the proxy to decrypt and inject", () => {
    expect(keyringProvider.resolve(row)).toEqual({
      mode: "inject",
      scheme: "api_key_header",
      schemeConfig: { headerName: "api-auth-id" },
      credentialCiphertext: row.credentialCiphertext,
    });
    // No credential yet: the ciphertext is null and the proxy says `connection_not_ready`.
    expect(keyringProvider.resolve({ ...row, credentialCiphertext: null })).toMatchObject({
      mode: "inject",
      credentialCiphertext: null,
    });
  });

  it("resolves a scheme it cannot sign for as none, rather than guessing", () => {
    expect(
      keyringProvider.resolve({ ...row, scheme: "some_relay" as ConnectionRow["scheme"] }),
    ).toMatchObject({ mode: "inject", scheme: null });
  });

  it("is the default list, alone", () => {
    expect(DEFAULT_PROVIDERS).toEqual([keyringProvider]);
  });
});

describe("the provider list", () => {
  it("finds a provider by name, or null when the deployment has not enabled it", () => {
    const { provider } = linkProvider();
    expect(providerNamed([provider, keyringProvider], "broker")).toBe(provider);
    expect(providerNamed([provider, keyringProvider], "keyring")).toBe(keyringProvider);
    expect(providerNamed(DEFAULT_PROVIDERS, "broker")).toBeNull();
  });

  it("routes a proposal to the first provider that covers it, the keyring catching the rest, and asks nobody after a yes", async () => {
    const { provider } = linkProvider();
    const providers = [provider, keyringProvider];
    expect(await providerFor(providers, "gmail", ["gmail.googleapis.com"])).toBe(provider);
    expect(await providerFor(providers, "unleashed", ["api.unleashedsoftware.com"])).toBe(
      keyringProvider,
    );
    expect(await providerFor(DEFAULT_PROVIDERS, "gmail", ["gmail.googleapis.com"])).toBe(
      keyringProvider,
    );
    // Coverage may be a catalogue read (GRA-126): the providers are asked in order, and a later
    // one is never asked once an earlier one has answered yes.
    const asked: string[] = [];
    const first = linkProvider("first", (vendor) => {
      asked.push(`first:${vendor}`);
      return vendor === "gmail";
    }).provider;
    const second = linkProvider("second", (vendor) => {
      asked.push(`second:${vendor}`);
      return true;
    }).provider;
    expect(await providerFor([first, second, keyringProvider], "gmail", [])).toBe(first);
    expect(asked).toEqual(["first:gmail"]);
    expect(await providerFor([first, second, keyringProvider], "acme", [])).toBe(second);
    expect(asked).toEqual(["first:gmail", "first:acme", "second:acme"]);
  });

  it("throws for a list nothing in which covers the vendor — a list assembled without the keyring", async () => {
    const { provider } = linkProvider();
    await expect(providerFor([provider], "unleashed", [])).rejects.toThrow(
      /keyring should always be last/,
    );
  });

  it("requires distinct names and the keyring present and last", () => {
    const { provider } = linkProvider();
    expect(providerListProblem([provider, keyringProvider])).toBeNull();
    expect(providerListProblem(DEFAULT_PROVIDERS)).toBeNull();
    expect(providerListProblem([keyringProvider, provider])).toMatch(/present and last/);
    expect(providerListProblem([provider])).toMatch(/present and last/);
    expect(providerListProblem([])).toMatch(/present and last/);
    expect(providerListProblem([provider, linkProvider().provider, keyringProvider])).toMatch(
      /two connection providers are named broker/,
    );
    // A hosted provider calling itself the keyring is the shadowing the rule exists to refuse.
    expect(providerListProblem([linkProvider("keyring").provider, keyringProvider])).toMatch(
      /named keyring/,
    );
  });

  it("describes a list as names and connect shapes, nothing executable", () => {
    const { provider } = linkProvider();
    expect(describeProviders([provider, keyringProvider])).toEqual([
      { name: "broker", connect: { kind: "link" } },
      { name: "keyring", connect: { kind: "form", schemes: AUTH_SCHEMES } },
    ]);
    // A link's functions and its scheme are the server's; the wire carries the word alone.
    expect(JSON.parse(JSON.stringify(describeProviders([provider])))).toEqual([
      { name: "broker", connect: { kind: "link" } },
    ]);
    expect(providerLinkOf(provider)?.scheme).toBe("relay");
    expect(providerLinkOf(keyringProvider)).toBeNull();
  });
});
