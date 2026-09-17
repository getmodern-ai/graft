import type { ConnectionRow } from "@graft/db/repo/connection";
import { GATEWAY_RELAY_FIELDS, gatewayRelay } from "@graft/proxy/gateway-relay";
import { describe, expect, it } from "vitest";

import {
  createGatewayProvider,
  GATEWAY_PROVIDER,
  gatewayCovers,
  gatewayCoversHost,
} from "./gateway-provider";
import { keyringProvider, providerFor, providerListProblem } from "./provider";

/**
 * The gateway provider on its own (ADR 0019, GRA-58): which proposals it covers, that it connects
 * with no person step under the `gateway` scheme, what it hands the proxy per call, and that it
 * holds nothing to release. The relay itself is proved in `@graft/proxy`'s `gateway-relay.test.ts`
 * against a fake gateway; the flow that makes a row is `@graft/mcp`'s `connection-request.test.ts`.
 */

const CONFIG = {
  hosts: ["api.unleashedsoftware.com", "*.googleapis.com"],
  upstreamUrl: "https://gateway.corp.example/graft",
  headerName: "X-Deployment-Token",
  headerValue: "deployment-identity-secret-value",
};

const row: ConnectionRow = {
  id: "conn_g",
  personId: "person_1",
  provider: GATEWAY_PROVIDER,
  providerRef: null,
  vendor: "unleashed",
  displayName: "Acme Unleashed",
  scheme: "gateway",
  schemeConfig: {},
  primaryHost: "https://api.unleashedsoftware.com",
  hosts: ["api.unleashedsoftware.com"],
  credentialCiphertext: null,
  credentialSetAt: null,
  oauthClientId: null,
  oauthClientSecretCiphertext: null,
  oauthAuthorizeUrl: null,
  oauthTokenUrl: null,
  oauthScopes: null,
  oauthRefreshState: null,
  revokedAt: null,
  owner: "person",
  createdAt: new Date("2026-09-17T09:00:00Z"),
  updatedAt: new Date("2026-09-17T09:00:00Z"),
};

describe("which hosts the gateway covers", () => {
  it("matches an exact host case-insensitively, and a *.suffix pattern one or more labels under it, never the suffix itself", () => {
    expect(gatewayCoversHost("api.unleashedsoftware.com", "API.UnleashedSoftware.com")).toBe(true);
    expect(gatewayCoversHost("api.unleashedsoftware.com", "files.unleashedsoftware.com")).toBe(
      false,
    );
    expect(gatewayCoversHost("*.googleapis.com", "gmail.googleapis.com")).toBe(true);
    expect(gatewayCoversHost("*.googleapis.com", "www.gmail.googleapis.com")).toBe(true);
    expect(gatewayCoversHost("*.googleapis.com", "googleapis.com")).toBe(false);
    expect(gatewayCoversHost("*.googleapis.com", "evilgoogleapis.com")).toBe(false);
  });

  it("covers a proposal only when every host in it is covered, and never an empty one", () => {
    const patterns = CONFIG.hosts;
    expect(gatewayCovers(patterns, ["api.unleashedsoftware.com"])).toBe(true);
    expect(gatewayCovers(patterns, ["gmail.googleapis.com", "www.googleapis.com"])).toBe(true);
    // One host outside the gateway's routes and the whole proposal falls to the keyring (ADR 0010:
    // a connection's calls may go to every host it declares).
    expect(gatewayCovers(patterns, ["gmail.googleapis.com", "accounts.google.com"])).toBe(false);
    expect(gatewayCovers(patterns, ["api.other.example"])).toBe(false);
    expect(gatewayCovers(patterns, [])).toBe(false);
  });
});

describe("the gateway provider", () => {
  const provider = createGatewayProvider(CONFIG);

  it("connects with no person step under the gateway scheme, covers by its hosts, and routes ahead of the keyring", () => {
    expect(provider.name).toBe("gateway");
    expect(provider.connect).toEqual({ kind: "none", scheme: "gateway" });
    expect(provider.covers("unleashed", ["api.unleashedsoftware.com"])).toBe(true);
    expect(provider.covers("acme", ["api.acme.example"])).toBe(false);
    const providers = [provider, keyringProvider];
    expect(providerListProblem(providers)).toBeNull();
    expect(providerFor(providers, "unleashed", ["api.unleashedsoftware.com"])).toBe(provider);
    expect(providerFor(providers, "acme", ["api.acme.example"])).toBe(keyringProvider);
  });

  it("resolves every row to the same relay: the catalogued plugin, the three fields, the identity header named for the dry run, and no rule override", async () => {
    const resolution = provider.resolve(row);
    expect(resolution.mode).toBe("relay");
    if (resolution.mode !== "relay") throw new Error("expected a relay");
    expect(resolution.relay.plugin).toBe(gatewayRelay);
    expect(resolution.relay.headerNames).toEqual(["x-deployment-token"]);
    expect(resolution.relay.rules).toBeUndefined();
    await expect(resolution.relay.obtain()).resolves.toEqual({
      [GATEWAY_RELAY_FIELDS.upstreamUrl]: CONFIG.upstreamUrl,
      [GATEWAY_RELAY_FIELDS.headerName]: CONFIG.headerName,
      [GATEWAY_RELAY_FIELDS.headerValue]: CONFIG.headerValue,
    });
    // A revoked row, or one with a provider_ref: the provider reads nothing off the row.
    expect(provider.resolve({ ...row, providerRef: "route-7", revokedAt: new Date() })).toEqual(
      resolution,
    );
  });

  it("hands the proxy a prefix rule with the framing passed through when the deployment set one", () => {
    const prefixed = createGatewayProvider({ ...CONFIG, headerPrefix: "x-graft-" });
    const resolution = prefixed.resolve(row);
    if (resolution.mode !== "relay") throw new Error("expected a relay");
    expect(resolution.relay.rules).toEqual({
      prefix: "x-graft-",
      passThrough: ["content-type", "content-length", "accept", "accept-encoding"],
    });
    const unprefixed = createGatewayProvider({ ...CONFIG, headerPrefix: null }).resolve(row);
    if (unprefixed.mode !== "relay") throw new Error("expected a relay");
    expect(unprefixed.relay.rules).toBeUndefined();
  });

  it("holds nothing per connection, so a revoke releases nothing", async () => {
    await expect(provider.revoke(row)).resolves.toBeUndefined();
  });
});
