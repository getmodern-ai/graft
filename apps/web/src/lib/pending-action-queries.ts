import { queryOptions } from "@tanstack/react-query";

import { api } from "./api";

/**
 * Pending actions and handoffs as the console sees them (ADR 0006, ADR 0008).
 *
 * **GRA-23 owns the server side of this file and has not merged yet.** Its endpoints — the open
 * list, the handoff verdict, the answer, the relax — are being built on `aleks/gra-23-approvals`,
 * so the shapes here are the console's own view held in one place, to be replaced by the server's
 * exported types when that branch lands (the GRA-26 brief). Every screen under `routes/_auth/_shell/
 * pending*` reads through this file and nothing else, which is what makes the swap mechanical.
 */

export type PendingActionView = {
  id: string;
  /** The meta-tool's word for the ask: `approval` for a tool call, `build` for `acquire`. */
  kind: string;
  /** The agent that asked (ADR 0006: the page shows the requesting agent). */
  agent: { id: string; name: string; revokedAt: string | null };
  /** The tool the ask is about, for a tool call; its description is the model's own prose (ADR 0008). */
  tool: {
    id: string;
    vendor: string;
    name: string;
    description: string;
    readOnly: boolean;
    destructive: boolean;
  } | null;
  /** The connection the ask is about — the vendor host the page shows (ADR 0006). */
  connection: {
    id: string;
    vendor: string;
    displayName: string;
    primaryHost: string;
  } | null;
  createdAt: string;
  expiresAt: string;
  answeredAt: string | null;
  /** Whether a destructive tool's per-call ask has been relaxed for this agent (ADR 0008). */
  perCallRelaxed: boolean;
};

/** What a handoff link resolves to (`@graft/mcp`'s `handoff.ts` on GRA-23's branch). */
export type HandoffView =
  | { ok: true; action: PendingActionView }
  | {
      ok: false;
      reason: "tampered" | "expired" | "consumed" | "answered" | "not_found";
      message: string;
    };

export type PendingAnswer = {
  decision: "allow" | "deny";
  /** For a destructive tool: also relax the per-call ask, so later calls pass silently (ADR 0008). */
  relaxPerCall?: boolean;
};

export const pendingKeys = {
  all: ["pending-actions"] as const,
  one: (id: string) => ["pending-actions", id] as const,
};

export const pendingActionsQuery = queryOptions({
  queryKey: pendingKeys.all,
  queryFn: () => api<{ actions: PendingActionView[] }>("/pending-actions"),
});

/** The selected action, verified against its handoff token when the link carried one. */
export const pendingActionQuery = (id: string, token: string | null) =>
  queryOptions({
    queryKey: [...pendingKeys.one(id), token] as const,
    queryFn: () =>
      api<HandoffView>(
        `/pending-actions/${encodeURIComponent(id)}${
          token ? `?t=${encodeURIComponent(token)}` : ""
        }`,
      ),
  });

export function answerPendingAction(id: string, answer: PendingAnswer) {
  return api<{ action: PendingActionView }>(`/pending-actions/${encodeURIComponent(id)}/answer`, {
    method: "POST",
    body: answer,
  });
}

/** The relax switch on a standing approval, outside an ask (ADR 0008). */
export function setPerCallRelaxed(agentId: string, toolId: string, relaxed: boolean) {
  return api<{ perCallRelaxed: boolean }>(
    `/agents/${encodeURIComponent(agentId)}/approvals/${encodeURIComponent(toolId)}/relax`,
    { method: relaxed ? "POST" : "DELETE" },
  );
}
