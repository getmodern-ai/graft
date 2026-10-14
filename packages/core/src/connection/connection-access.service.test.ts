import type { ConnectionRow } from "@graft/db/repo/connection";
import type { VendorToolApprovalRow } from "@graft/db/repo/connection-access";
import { describe, expect, it, vi } from "vitest";

import type { ServiceContext } from "../context";
import type { ConnectionAccessDeps } from "./connection-access.deps";
import { getConnectionAccess } from "./connection-access.service";

const NOW = new Date("2026-10-14T10:00:00Z");
const ctx = { db: {} } as unknown as ServiceContext;
const PRINCIPAL = { personId: "person_1" };
const OPTIONS = { executeToolName: (id: string) => `execute__${id}` };

const gmail = { id: "conn_1", personId: "person_1", vendor: "gmail" } as ConnectionRow;

function toolApproval(
  agentId: string,
  over: Partial<VendorToolApprovalRow> & { toolId?: string } = {},
): VendorToolApprovalRow {
  const { toolId = "tool_send", ...rest } = over;
  return {
    agentId,
    decision: "allow",
    askEveryCall: false,
    toolVersionId: "ver_2",
    decidedAt: NOW,
    tool: {
      id: toolId,
      vendor: "gmail",
      name: "send-email",
      description: "Sends an email",
      readOnly: false,
      destructive: false,
      currentVersionId: "ver_2",
    },
    ...rest,
  };
}

function deps(over: Partial<ConnectionAccessDeps> = {}): ConnectionAccessDeps {
  return {
    findConnection: vi.fn(async () => gmail),
    listVendorConnectionIds: vi.fn(async () => ["conn_1", "conn_2"]),
    listAgentAccessForConnection: vi.fn(async () => [
      {
        id: "agent_claude",
        name: "Claude",
        scopeMode: "all" as const,
        connectedViaClientName: "Claude",
        createdAt: NOW,
        inScope: true,
      },
      {
        id: "agent_hermes",
        name: "Hermes",
        scopeMode: "listed" as const,
        connectedViaClientName: null,
        createdAt: NOW,
        inScope: false,
      },
    ]),
    lastVendorUseByAgent: vi.fn(async () => [{ agentId: "agent_claude", lastUsedAt: NOW }]),
    listVendorToolApprovals: vi.fn(async () => [
      toolApproval("agent_claude"),
      toolApproval("agent_claude", { toolId: "tool_delete", toolVersionId: "ver_1" }),
    ]),
    listVendorApprovalsForVendor: vi.fn(async () => [
      { agentId: "agent_claude", includesDestructive: false, grantedAt: NOW },
    ]),
    listBuildApprovalsForConnection: vi.fn(async () => [
      { agentId: "agent_claude", grantedAt: NOW },
    ]),
    ...over,
  };
}

describe("getConnectionAccess", () => {
  it("is null for a connection that is not the person's, and reads nothing else", async () => {
    const d = deps({ findConnection: vi.fn(async () => null) });
    expect(await getConnectionAccess(ctx, PRINCIPAL, "conn_x", d, OPTIONS)).toBeNull();
    expect(d.findConnection).toHaveBeenCalledWith(ctx.db, "person_1", "conn_x");
    expect(d.listAgentAccessForConnection).not.toHaveBeenCalled();
    expect(d.listVendorToolApprovals).not.toHaveBeenCalled();
  });

  it("reads each kind of record once under the person, by the connection's vendor", async () => {
    const d = deps();
    await getConnectionAccess(ctx, PRINCIPAL, "conn_1", d, OPTIONS);
    expect(d.listAgentAccessForConnection).toHaveBeenCalledOnce();
    expect(d.listAgentAccessForConnection).toHaveBeenCalledWith(ctx.db, "person_1", "conn_1");
    expect(d.lastVendorUseByAgent).toHaveBeenCalledWith(ctx.db, "person_1", {
      vendor: "gmail",
      // Every connection of the person's to the vendor: a call through another was a use too.
      toolNames: ["execute__conn_1", "execute__conn_2"],
    });
    expect(d.listVendorConnectionIds).toHaveBeenCalledWith(ctx.db, "person_1", "gmail");
    expect(d.listVendorToolApprovals).toHaveBeenCalledWith(ctx.db, "person_1", "gmail");
    expect(d.listVendorApprovalsForVendor).toHaveBeenCalledWith(ctx.db, "person_1", "gmail");
    expect(d.listBuildApprovalsForConnection).toHaveBeenCalledWith(ctx.db, "person_1", "conn_1");
  });

  it("assembles every active agent with its scope, last use and answers", async () => {
    const access = await getConnectionAccess(ctx, PRINCIPAL, "conn_1", deps(), OPTIONS);
    expect(access?.connectionId).toBe("conn_1");
    expect(access?.vendor).toBe("gmail");
    const [claude, hermes] = access?.agents ?? [];
    expect(claude).toMatchObject({
      agent: { id: "agent_claude", name: "Claude", scopeMode: "all" },
      inScope: true,
      lastUsedAt: NOW,
      vendorApproval: { includesDestructive: false, grantedAt: NOW },
      buildApproval: { grantedAt: NOW },
    });
    expect(claude?.toolApprovals.map((a) => [a.tool.id, a.forCurrentVersion])).toEqual([
      ["tool_send", true],
      ["tool_delete", false],
    ]);
    expect(hermes).toEqual({
      agent: {
        id: "agent_hermes",
        name: "Hermes",
        scopeMode: "listed",
        connectedViaClientName: null,
      },
      inScope: false,
      lastUsedAt: null,
      toolApprovals: [],
      vendorApproval: null,
      buildApproval: null,
    });
  });

  it("reads an approval with no version as not for the current one", async () => {
    const access = await getConnectionAccess(
      ctx,
      PRINCIPAL,
      "conn_1",
      deps({
        listVendorToolApprovals: vi.fn(async () => [
          toolApproval("agent_claude", { toolVersionId: null }),
        ]),
      }),
      OPTIONS,
    );
    expect(access?.agents[0]?.toolApprovals[0]?.forCurrentVersion).toBe(false);
  });
});
