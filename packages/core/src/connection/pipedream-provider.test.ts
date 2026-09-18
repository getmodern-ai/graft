import type { ConnectionRow } from "@graft/db/repo/connection";
import { createFakePipedreamClient } from "@graft/pipedream/fake";
import { RELAYS } from "@graft/proxy/relay";
import { describe, expect, it } from "vitest";

import {
  createPipedreamProvider,
  newestUnclaimedAccount,
  PIPEDREAM_APPS,
  PIPEDREAM_PROVIDER,
  pipedreamAppFor,
} from "./pipedream-provider";
import { keyringProvider, providerFor, providerLinkOf, providerListProblem } from "./provider";

/**
 * The Pipedream provider over the fake client (GRA-59): which vendors it covers and at which hosts,
 * what its link mints and confirms, what it hands the proxy for a call, and what it lets go of on
 * a revoke. The relay itself is `@graft/proxy`'s `pipedream-relay.test.ts`; the flow through the
 * server's routes is `apps/server/src/provider-link.test.ts`.
 */

const NOW = new Date("2026-09-17T10:00:00Z");
const USER = "graft-person-person_1";

const row: ConnectionRow = {
  id: "conn_g",
  personId: "person_1",
  provider: PIPEDREAM_PROVIDER,
  providerRef: "apn_1",
  vendor: "gmail",
  displayName: "Gmail",
  scheme: "pipedream_connect_proxy",
  schemeConfig: {},
  primaryHost: "https://gmail.googleapis.com/gmail/v1",
  hosts: ["gmail.googleapis.com", "www.googleapis.com"],
  credentialCiphertext: null,
  credentialSetAt: null,
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

function setup() {
  const client = createFakePipedreamClient({ now: () => NOW });
  const provider = createPipedreamProvider({ client });
  return { client, provider };
}

describe("the vendor table", () => {
  it("covers Gmail at Google's two API hosts and nothing else — a host outside the vendor's own is not covered", () => {
    expect(pipedreamAppFor("gmail", ["gmail.googleapis.com"])?.app).toBe("gmail");
    expect(pipedreamAppFor("gmail", ["gmail.googleapis.com", "www.googleapis.com"])?.app).toBe(
      "gmail",
    );
    expect(pipedreamAppFor("GMAIL", ["Gmail.googleapis.com:443"])?.app).toBe("gmail");
    // The relay would send the account's token wherever the vendor URL points, so a stray host is a
    // proposal the keyring handles, never Pipedream.
    expect(pipedreamAppFor("gmail", ["gmail.googleapis.com", "evil.example"])).toBeNull();
    expect(pipedreamAppFor("slack", ["slack.com"])).toBeNull();
    expect(PIPEDREAM_APPS.map((entry) => entry.vendor)).toEqual(["gmail"]);
  });

  it("routes a Gmail proposal to Pipedream ahead of the keyring, and any other to the keyring", () => {
    const { provider } = setup();
    const providers = [provider, keyringProvider];
    expect(providerListProblem(providers)).toBeNull();
    expect(providerFor(providers, "gmail", ["gmail.googleapis.com"])).toBe(provider);
    expect(providerFor(providers, "gmail", ["gmail.googleapis.com", "evil.example"])).toBe(
      keyringProvider,
    );
    expect(providerFor(providers, "unleashed", ["api.unleashedsoftware.com"])).toBe(
      keyringProvider,
    );
    expect(provider.connect.kind).toBe("link");
    expect(providerLinkOf(provider)?.target("gmail", ["gmail.googleapis.com"])).toBe("gmail");
    expect(providerLinkOf(provider)?.target("notion", ["api.notion.com"])).toBeNull();
    expect(providerLinkOf(provider)?.scheme).toBe("pipedream_connect_proxy");
  });
});

describe("the link", () => {
  it("mints a connect token for the person's external user id under the app, with both return URIs, and answers the link with the app preselected", async () => {
    const { client, provider } = setup();
    const link = providerLinkOf(provider);
    const started = await link?.start({
      personId: "person_1",
      vendor: "gmail",
      hosts: ["gmail.googleapis.com"],
      returnTo: {
        success: "http://graft.test/return?outcome=success",
        error: "http://graft.test/return?outcome=error",
      },
    });
    expect(client.tokens).toEqual([
      expect.objectContaining({
        externalUserId: USER,
        app: "gmail",
        success: "http://graft.test/return?outcome=success",
        error: "http://graft.test/return?outcome=error",
      }),
    ]);
    expect(new URL(started?.url ?? "").searchParams.get("app")).toBe("gmail");
    expect(started?.expiresAt.getTime()).toBeGreaterThan(NOW.getTime());
    await expect(
      link?.start({
        personId: "person_1",
        vendor: "notion",
        hosts: ["api.notion.com"],
        returnTo: { success: "s", error: "e" },
      }),
    ).rejects.toThrow(/does not cover notion/);
  });

  it("confirms the account by asking Pipedream what it holds — the newest healthy one no row has claimed — and reports nothing new as a failure", async () => {
    const { client, provider } = setup();
    const link = providerLinkOf(provider);
    const input = {
      personId: "person_1",
      vendor: "gmail",
      hosts: ["gmail.googleapis.com"],
      takenRefs: [] as string[],
    };
    expect(await link?.complete(input)).toEqual({
      ok: false,
      message: expect.stringContaining("No new gmail account was connected"),
    });

    const first = client.connect({ externalUserId: USER, app: "gmail", name: "a@gmail.com" });
    expect(await link?.complete(input)).toEqual({ ok: true, ref: first.id, label: "a@gmail.com" });

    // A second account at the same vendor is the new one, never the one already claimed.
    const second = client.connect({ externalUserId: USER, app: "gmail", name: "b@gmail.com" });
    expect(await link?.complete({ ...input, takenRefs: [first.id] })).toEqual({
      ok: true,
      ref: second.id,
      label: "b@gmail.com",
    });
    // Another person's account is never this person's: the list was asked under their id alone.
    client.connect({ externalUserId: "graft-person-p2", app: "gmail" });
    expect(await link?.complete({ ...input, takenRefs: [first.id, second.id] })).toMatchObject({
      ok: false,
    });
    expect(
      newestUnclaimedAccount(
        [
          { ...first, id: "old", createdAt: "2026-01-01T00:00:00Z" },
          { ...first, id: "unhealthy", healthy: false, createdAt: "2026-09-01T00:00:00Z" },
          { ...first, id: "dead", dead: true, createdAt: "2026-09-02T00:00:00Z" },
          { ...first, id: "new", createdAt: "2026-08-01T00:00:00Z" },
        ],
        [],
      )?.id,
    ).toBe("new");
  });
});

describe("resolve and revoke", () => {
  it("resolves a connected row to the Pipedream relay with fields obtained per call — the account id and the person's external id, Graft's token — and stores nothing", async () => {
    const { client, provider } = setup();
    const resolution = provider.resolve(row);
    expect(resolution.mode).toBe("relay");
    if (resolution.mode !== "relay") throw new Error("expected a relay");
    expect(resolution.relay.plugin).toBe(RELAYS.pipedream_connect_proxy);
    await expect(resolution.relay.obtain()).resolves.toEqual({
      accessToken: "fake-connect-access-token",
      projectId: client.projectId,
      environment: "development",
      externalUserId: USER,
      accountId: "apn_1",
      apiOrigin: client.apiOrigin,
    });
    expect(resolution.relay.rules).toBeUndefined();
  });

  it("a row with no account resolves pending, so the proxy names Pipedream as holding nothing yet; a revoked one still awaiting Pipedream's release resolves to nothing the proxy can use (GRA-68)", () => {
    const { provider } = setup();
    expect(provider.resolve({ ...row, providerRef: null })).toEqual({ mode: "pending" });
    const notReady = { mode: "inject", scheme: null, schemeConfig: {}, credentialCiphertext: null };
    expect(provider.resolve({ ...row, revokedAt: NOW })).toEqual(notReady);
    expect(provider.resolve({ ...row, providerRef: null, revokedAt: NOW })).toEqual(notReady);
  });

  it("revoke deletes the account at Pipedream by the row's reference, and does nothing for a row that has none", async () => {
    const { client, provider } = setup();
    client.connect({ externalUserId: USER, app: "gmail", id: "apn_1" });
    await provider.revoke(row);
    expect(client.deleted).toEqual(["apn_1"]);
    expect(client.accounts).toEqual([]);
    await provider.revoke({ ...row, providerRef: null });
    expect(client.deleted).toEqual(["apn_1"]);
    // Pipedream refusing is the provider's error, for the service to report by class name.
    await expect(provider.revoke(row)).rejects.toMatchObject({ name: "PipedreamError" });
  });
});
