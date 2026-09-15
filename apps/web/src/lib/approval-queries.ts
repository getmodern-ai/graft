import type { ApprovalRow } from "@graft/db/repo/approval";
import { queryOptions } from "@tanstack/react-query";

import { api, type Jsonified } from "./api";

/**
 * An agent's standing approvals (ADR 0008: per agent, per tool; the record is the person's to
 * revisit), on GRA-23's routes. The ask-every-call setting is the person's opt-in per tool, both
 * ways (ADR 0008, amendment of 2026-09-15); withdrawing makes the tool ask again on its next call —
 * the one way back from a `deny`.
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

export function setApprovalAskEveryCall(agentId: string, toolId: string, on: boolean) {
  return api<{ approval: Approval }>(
    `/approvals/${encodeURIComponent(toolId)}/ask-every-call?agentId=${encodeURIComponent(agentId)}`,
    { method: "PUT", body: { on } },
  );
}

export function withdrawApproval(agentId: string, toolId: string) {
  return api<{ approval: Approval }>(
    `/approvals/${encodeURIComponent(toolId)}?agentId=${encodeURIComponent(agentId)}`,
    { method: "DELETE" },
  );
}
