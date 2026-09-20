import { describe, expect, it } from "vitest";

import {
  type Connection,
  connectionStatus,
  isGatewayConnection,
  isKeyringConnection,
  providerLabel,
} from "./connection-queries";

/**
 * What the console decides about a connection from its provider (ADR 0019): the keyring's rows are
 * read by their credential, a gateway's (GRA-58) by existing — connected with nothing entered,
 * revoked until Reconnect — and the badge names the provider in the person's words.
 */

const base: Connection = {
  id: "conn_1",
  provider: "keyring",
  vendor: "unleashed",
  displayName: "Acme Unleashed",
  scheme: "api_key_header",
  schemeConfig: { headerName: "api-auth-id" },
  primaryHost: "https://api.unleashedsoftware.com",
  hosts: ["api.unleashedsoftware.com"],
  credentialSetAt: null,
  oauth: null,
  providerReleaseFailedAt: null,
  revokedAt: null,
  createdAt: "2026-09-17T09:00:00.000Z",
  updatedAt: "2026-09-17T09:00:00.000Z",
};

const gateway: Connection = { ...base, id: "conn_g", provider: "gateway", scheme: "gateway" };

describe("a connection's provider on the console", () => {
  it("tells the keyring's rows from the gateway's, and labels the gateway in the person's words", () => {
    expect(isKeyringConnection(base)).toBe(true);
    expect(isGatewayConnection(base)).toBe(false);
    expect(isKeyringConnection(gateway)).toBe(false);
    expect(isGatewayConnection(gateway)).toBe(true);
    expect(providerLabel(gateway)).toBe("Through your API gateway");
    expect(providerLabel({ provider: "broker" })).toBe("via broker");
  });

  it("reads a gateway connection as connected with no credential set, and revoked when revoked", () => {
    expect(connectionStatus(base)).toBe("awaiting_credential");
    // A keyring row on the `none` scheme never has a credential and is connected (GRA-66).
    expect(connectionStatus({ ...base, scheme: "none" })).toBe("connected");
    expect(
      connectionStatus({ ...base, scheme: "none", revokedAt: "2026-09-17T10:00:00.000Z" }),
    ).toBe("revoked");
    expect(connectionStatus(gateway)).toBe("connected");
    expect(connectionStatus({ ...gateway, revokedAt: "2026-09-17T10:00:00.000Z" })).toBe("revoked");
  });
});
