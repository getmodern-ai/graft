import { describe, expect, it } from "vitest";

import {
  AGENT_STATUS_CHIP,
  APPROVAL_DECISION_CHIP,
  AWAITING_CLIENT_SECRET_CHIP,
  AWAITING_RECONNECTION_CHIP,
  agentStatusChip,
  CALL_OUTCOME_CHIP,
  CONNECTION_STATUS_CHIP,
  connectionStatusChips,
  DRY_RUN_CHIP,
  MODEL_KEY_STATUS_CHIP,
  NO_PASSING_VERSION_CHIP,
  type StatusChip,
  TOOL_ANNOTATION_CHIP,
  toolAnnotationChip,
  WORKING_SET_CHANGE_CHIP,
} from "./status-chips";

const EVERY_CHIP: StatusChip[] = [
  ...Object.values(AGENT_STATUS_CHIP),
  ...Object.values(CONNECTION_STATUS_CHIP),
  AWAITING_CLIENT_SECRET_CHIP,
  AWAITING_RECONNECTION_CHIP,
  ...Object.values(CALL_OUTCOME_CHIP),
  DRY_RUN_CHIP,
  NO_PASSING_VERSION_CHIP,
  ...Object.values(APPROVAL_DECISION_CHIP),
  ...Object.values(WORKING_SET_CHANGE_CHIP),
  ...Object.values(MODEL_KEY_STATUS_CHIP),
  ...Object.values(TOOL_ANNOTATION_CHIP),
];

describe("status chips", () => {
  // Sentence case, as every label in the console is: a capital first letter and no full stop.
  // "OK" is the one all-capitals label, an initialism rather than a word.
  it("labels every chip in sentence case", () => {
    for (const chip of EVERY_CHIP) {
      expect(chip.label).toMatch(/^[A-Z][^.]*$/);
      expect(chip.label.slice(1)).toMatch(chip.label === "OK" ? /^K$/ : /^[^A-Z]*$/);
    }
  });

  // The tone rule AGENTS.md states, pinned: working states are success, refused ones destructive,
  // waiting ones outline.
  it("gives the working states the success tone", () => {
    expect(AGENT_STATUS_CHIP.active.variant).toBe("success");
    expect(CONNECTION_STATUS_CHIP.connected.variant).toBe("success");
    expect(CALL_OUTCOME_CHIP.ok.variant).toBe("success");
    expect(APPROVAL_DECISION_CHIP.allow.variant).toBe("success");
    expect(MODEL_KEY_STATUS_CHIP.set.variant).toBe("success");
  });

  it("gives the refused states the destructive tone", () => {
    expect(AGENT_STATUS_CHIP.revoked.variant).toBe("destructive");
    expect(CONNECTION_STATUS_CHIP.revoked.variant).toBe("destructive");
    expect(CONNECTION_STATUS_CHIP.consent_required.variant).toBe("destructive");
    expect(CALL_OUTCOME_CHIP.error.variant).toBe("destructive");
    expect(APPROVAL_DECISION_CHIP.deny.variant).toBe("destructive");
  });

  it("gives the waiting states the outline tone", () => {
    expect(CONNECTION_STATUS_CHIP.awaiting_credential.variant).toBe("outline");
    expect(CONNECTION_STATUS_CHIP.awaiting_consent.variant).toBe("outline");
    expect(AWAITING_CLIENT_SECRET_CHIP.variant).toBe("outline");
    expect(AWAITING_RECONNECTION_CHIP.variant).toBe("outline");
    expect(NO_PASSING_VERSION_CHIP.variant).toBe("outline");
    expect(MODEL_KEY_STATUS_CHIP.unset.variant).toBe("outline");
    expect(AGENT_STATUS_CHIP.awaiting_harness.variant).toBe("outline");
  });

  it("keeps the three tool annotations visually distinct", () => {
    const variants = new Set(Object.values(TOOL_ANNOTATION_CHIP).map((chip) => chip.variant));
    expect(variants.size).toBe(3);
    expect(toolAnnotationChip(true, false)).toBe(TOOL_ANNOTATION_CHIP["read-only"]);
    expect(toolAnnotationChip(false, true)).toBe(TOOL_ANNOTATION_CHIP.destructive);
    expect(toolAnnotationChip(false, false)).toBe(TOOL_ANNOTATION_CHIP.write);
    // The check never emits both, but were it to, read-only is what lets a call pass unasked, so
    // it is the one to show.
    expect(toolAnnotationChip(true, true)).toBe(TOOL_ANNOTATION_CHIP["read-only"]);
  });

  it("reads an agent's status off its revocation, its token and its client", () => {
    const tokened = { tokenPrefix: "grft_abc", connectedVia: null };
    expect(agentStatusChip({ revokedAt: null, ...tokened })).toBe(AGENT_STATUS_CHIP.active);
    expect(
      agentStatusChip({
        revokedAt: null,
        tokenPrefix: null,
        connectedVia: { clientId: "c_1", clientName: "Claude" },
      }),
    ).toBe(AGENT_STATUS_CHIP.active);
    expect(agentStatusChip({ revokedAt: "2026-09-11T00:00:00.000Z", ...tokened })).toBe(
      AGENT_STATUS_CHIP.revoked,
    );
    // Setup's agent before any harness reached it (ADR 0024), and revoked once it was.
    const bare = { tokenPrefix: null, connectedVia: null };
    expect(agentStatusChip({ revokedAt: null, ...bare })).toBe(AGENT_STATUS_CHIP.awaiting_harness);
    expect(agentStatusChip({ revokedAt: "2026-09-11T00:00:00.000Z", ...bare })).toBe(
      AGENT_STATUS_CHIP.revoked,
    );
  });

  it("gives a revoked connection its way back as a second chip", () => {
    expect(connectionStatusChips({ oauth: null }, "revoked")).toEqual([
      CONNECTION_STATUS_CHIP.revoked,
      AWAITING_RECONNECTION_CHIP,
    ]);
  });

  it("names the client secret as what an OAuth connection is missing", () => {
    expect(connectionStatusChips({ oauth: null }, "awaiting_credential")).toEqual([
      CONNECTION_STATUS_CHIP.awaiting_credential,
    ]);
    expect(
      connectionStatusChips(
        { oauth: { status: "awaiting_consent" } as never },
        "awaiting_credential",
      ),
    ).toEqual([AWAITING_CLIENT_SECRET_CHIP]);
    // Only the credential chip changes for OAuth; the rest are the same words either way.
    expect(connectionStatusChips({ oauth: { status: "connected" } as never }, "connected")).toEqual(
      [CONNECTION_STATUS_CHIP.connected],
    );
  });
});
