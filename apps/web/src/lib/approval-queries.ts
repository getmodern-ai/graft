import type { ApprovalRow } from "@graft/db/repo/approval";
import { queryOptions } from "@tanstack/react-query";

import { api, type Jsonified } from "./api";

/**
 * An agent's standing approvals (ADR 0008: per agent, per tool; the record is the person's to
 * revisit), on GRA-23's routes. Relaxing lifts a destructive tool's per-call ask; withdrawing makes
 * the tool ask again on its next call — the one way back from a `deny`.
 */

export type Approval = Jsonified<ApprovalRow>;

export const approvalKeys = {
  ofAgent: (agentId: string) => ["approvals", agentId] as const,
};

export const approvalsQuery = (agentId: string) =>
  queryOptions({
    queryKey: approvalKeys.ofAgent(agentId),
    queryFn: () =>
      api<{ approvals: Approval[] }>(`/approvals?agentId=${encodeURIComponent(agentId)}`),
  });

export function relaxApproval(agentId: string, toolId: string) {
  return api<{ approval: Approval }>(
    `/approvals/${encodeURIComponent(toolId)}/relax?agentId=${encodeURIComponent(agentId)}`,
    { method: "POST" },
  );
}

export function withdrawApproval(agentId: string, toolId: string) {
  return api<{ approval: Approval }>(
    `/approvals/${encodeURIComponent(toolId)}?agentId=${encodeURIComponent(agentId)}`,
    { method: "DELETE" },
  );
}
