import { describe, expect, it } from "vitest";

import { openRotationReplay, sealRotationReplay } from "./mcp-oauth.replay";
import type { TokenResponse } from "./mcp-oauth.service";

/** The seal a rotated refresh token keeps for its retry (ADR 0018): opens for its holder and nobody else. */
const successor: TokenResponse = {
  access_token: "grfta_successor-access",
  token_type: "Bearer",
  expires_in: 3600,
  refresh_token: "grftr_successor-refresh",
  scope: "mcp",
};

describe("the rotation replay seal", () => {
  it("round-trips the successor under the retired token and the row it was sealed for", () => {
    const sealed = sealRotationReplay("grftr_retired", "row_1", successor);
    expect(sealed).not.toContain("successor");
    expect(openRotationReplay("grftr_retired", "row_1", sealed)).toEqual(successor);
  });

  it("opens for nothing else: another token, another row, a tampered byte, a stray value, nothing", () => {
    const sealed = sealRotationReplay("grftr_retired", "row_1", successor);
    expect(openRotationReplay("grftr_other", "row_1", sealed)).toBeNull();
    expect(openRotationReplay("grftr_retired", "row_2", sealed)).toBeNull();
    const bytes = Buffer.from(sealed, "base64url");
    bytes[20] = (bytes[20] ?? 0) ^ 0xff;
    expect(openRotationReplay("grftr_retired", "row_1", bytes.toString("base64url"))).toBeNull();
    expect(openRotationReplay("grftr_retired", "row_1", "not-a-seal")).toBeNull();
    expect(openRotationReplay("grftr_retired", "row_1", null)).toBeNull();
    expect(openRotationReplay("grftr_retired", "row_1", "")).toBeNull();
  });

  it("seals the same pair differently each time — a fresh nonce per seal", () => {
    const a = sealRotationReplay("grftr_retired", "row_1", successor);
    const b = sealRotationReplay("grftr_retired", "row_1", successor);
    expect(a).not.toBe(b);
    expect(openRotationReplay("grftr_retired", "row_1", b)).toEqual(successor);
  });
});
