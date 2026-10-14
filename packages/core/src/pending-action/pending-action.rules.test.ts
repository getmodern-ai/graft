import { describe, expect, it } from "vitest";

import {
  pendingActionDoneState,
  pendingActionFinishedAt,
  pendingActionIntegrationName,
  pendingActionSubject,
} from "./pending-action.rules";

const AT = new Date("2026-10-14T10:00:00Z");

describe("pendingActionDoneState", () => {
  it("reads an ask a revoke closed as closed, never as expired", () => {
    expect(pendingActionDoneState({ answeredAt: null, closedReason: "connection_revoked" })).toBe(
      "closed",
    );
    expect(pendingActionDoneState({ answeredAt: null, closedReason: "agent_revoked" })).toBe(
      "closed",
    );
  });

  it("reads an ask that ran out unanswered, or one closed before the reason was recorded, as expired", () => {
    expect(pendingActionDoneState({ answeredAt: null, closedReason: null })).toBe("expired");
  });

  it("reads an answered ask as answered, even when a revoke closed it before the agent took it", () => {
    expect(pendingActionDoneState({ answeredAt: AT, closedReason: "connection_revoked" })).toBe(
      "answered",
    );
  });
});

describe("pendingActionFinishedAt", () => {
  it("is the answer's moment when answered, else the expiry", () => {
    const expiresAt = new Date(AT.getTime() + 60_000);
    expect(pendingActionFinishedAt({ answeredAt: AT, expiresAt })).toBe(AT);
    expect(pendingActionFinishedAt({ answeredAt: null, expiresAt })).toBe(expiresAt);
  });
});

describe("pendingActionSubject", () => {
  it("lifts a tool ask's tool, integration and connection", () => {
    expect(
      pendingActionSubject({
        kind: "tool",
        payload: { toolId: "tool_1", vendor: "slack", connectionId: "conn_1" },
        connectionId: "conn_1",
        answer: { allow: true },
      }),
    ).toEqual({ toolId: "tool_1", vendor: "slack", connectionId: "conn_1" });
  });

  it("names no tool for any other kind, and falls back to the payload when the column was cleared", () => {
    expect(
      pendingActionSubject({
        kind: "build",
        payload: { toolId: "ignored", vendor: "github", connectionId: "conn_2" },
        connectionId: null,
        answer: null,
      }),
    ).toEqual({ toolId: null, vendor: "github", connectionId: "conn_2" });
  });

  it("names a proposal's connection once the answer made one, or the row a widening grows", () => {
    expect(
      pendingActionSubject({
        kind: "connection",
        payload: { vendor: "open_meteo" },
        connectionId: null,
        answer: { connectionId: "conn_3" },
      }),
    ).toEqual({ toolId: null, vendor: "open_meteo", connectionId: "conn_3" });
    expect(
      pendingActionSubject({
        kind: "connection",
        payload: { vendor: "open_meteo", widens: { connectionId: "conn_4", addedHosts: [] } },
        connectionId: null,
        answer: null,
      }).connectionId,
    ).toBe("conn_4");
    expect(
      pendingActionSubject({
        kind: "connection",
        payload: { vendor: "open_meteo" },
        connectionId: null,
        answer: { allow: false },
      }).connectionId,
    ).toBeNull();
  });
});

describe("pendingActionIntegrationName (GRA-314)", () => {
  it("reads the integration as the person does, off whichever field the kind carries", () => {
    expect(pendingActionIntegrationName({ vendor: "gmail", connectionName: "Gmail (work)" })).toBe(
      "Gmail",
    );
    expect(
      pendingActionIntegrationName({
        vendor: "demo",
        connectionName: "Demo",
        integrationName: "Demo Orders",
      }),
    ).toBe("Demo Orders");
    expect(
      pendingActionIntegrationName({ vendor: "unleashed", displayName: "Acme Unleashed" }),
    ).toBe("Acme Unleashed");
    expect(pendingActionIntegrationName({ vendor: "unleashed" })).toBe("unleashed");
    expect(pendingActionIntegrationName({ toolName: "x" })).toBeNull();
  });
});
