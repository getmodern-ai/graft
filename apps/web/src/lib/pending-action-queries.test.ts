import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import { ApiError } from "./api";
import {
  isLinkReadKey,
  type PendingAction,
  pendingActionQuery,
  pendingActionsQuery,
  settleAnsweredAsk,
  settleConnectedAsk,
} from "./pending-action-queries";

function card(id: string): PendingAction {
  return {
    id,
    agentId: "agt_1",
    agent: { id: "agt_1", name: "laptop Hermes", clientName: null },
    kind: "tool",
    payload: { toolId: "tool_1" },
    expiresAt: "2026-10-15T00:00:00.000Z",
    createdAt: "2026-10-14T00:00:00.000Z",
    answeredAt: null,
    answer: null,
    consumedAt: null,
    askedCount: 1,
    account: null,
    url: `https://console.example/pending/${id}?t=h_token`,
  };
}

const ANSWERED_AT = "2026-10-14T01:32:54.760Z";

describe("isLinkReadKey", () => {
  it("tells a link read from the list, and one ask's link from another's", () => {
    const key = pendingActionQuery("pa_1", "h_token").queryKey;
    expect(isLinkReadKey(key)).toBe(true);
    expect(isLinkReadKey(key, "pa_1")).toBe(true);
    expect(isLinkReadKey(key, "pa_2")).toBe(false);
    expect(isLinkReadKey(pendingActionsQuery.queryKey)).toBe(false);
  });
});

describe("the link read", () => {
  it("keeps the server's refusals out of the global toast, and not a transport failure", () => {
    const quietError = pendingActionQuery("pa_1", "h_token").meta?.quietError as (
      error: unknown,
    ) => boolean;
    expect(quietError(new ApiError(409, "CONFLICT", "used", { reason: "consumed" }))).toBe(true);
    expect(quietError(new TypeError("Failed to fetch"))).toBe(false);
  });
});

describe("settleAnsweredAsk (GRA-334)", () => {
  it("writes the answer into the link read and refetches the list, never the link", async () => {
    const client = new QueryClient();
    const link = pendingActionQuery("pa_1", "h_token");
    const linkFn = vi.fn(async (): Promise<{ pendingAction: PendingAction }> => {
      throw new ApiError(409, "CONFLICT", "used", { reason: "consumed" });
    });
    const listFn = vi.fn(async () => ({ pendingActions: [] as PendingAction[] }));
    client.setQueryData(link.queryKey, { pendingAction: card("pa_1") });
    client.setQueryData(pendingActionsQuery.queryKey, { pendingActions: [card("pa_1")] });
    // Both observed, as on the page, so an invalidation would refetch either.
    const unwatchLink = new QueryObserver(client, {
      queryKey: link.queryKey,
      queryFn: linkFn,
      staleTime: Number.POSITIVE_INFINITY,
    }).subscribe(() => {});
    const unwatchList = new QueryObserver(client, {
      queryKey: pendingActionsQuery.queryKey,
      queryFn: listFn,
      staleTime: Number.POSITIVE_INFINITY,
    }).subscribe(() => {});

    settleAnsweredAsk(client, "pa_1", {
      pendingAction: { answeredAt: ANSWERED_AT, answer: { allow: false }, consumedAt: ANSWERED_AT },
    });

    const settled = client.getQueryData(link.queryKey);
    expect(settled?.pendingAction.answeredAt).toBe(ANSWERED_AT);
    expect(settled?.pendingAction.answer).toEqual({ allow: false });
    expect(settled?.pendingAction.agent?.name).toBe("laptop Hermes");
    await vi.waitFor(() => expect(listFn).toHaveBeenCalledTimes(1));
    expect(linkFn).not.toHaveBeenCalled();
    expect(client.getQueryState(link.queryKey)?.isInvalidated).toBe(false);
    unwatchLink();
    unwatchList();
  });

  it("writes nothing where no link read is cached", () => {
    const client = new QueryClient();
    settleAnsweredAsk(client, "pa_1", {
      pendingAction: { answeredAt: ANSWERED_AT, answer: null, consumedAt: null },
    });
    expect(client.getQueryData(pendingActionQuery("pa_1", "h_token").queryKey)).toBeUndefined();
  });
});

describe("settleConnectedAsk (Greptile on #250)", () => {
  it("records the connection on the cached link read, and leaves an ask already answered alone", () => {
    const client = new QueryClient();
    const link = pendingActionQuery("pa_1", "h_token");
    client.setQueryData(link.queryKey, { pendingAction: card("pa_1") });
    settleConnectedAsk(client, "pa_1", "conn_1", new Date(ANSWERED_AT));
    expect(client.getQueryData(link.queryKey)?.pendingAction).toMatchObject({
      answeredAt: ANSWERED_AT,
      answer: { connectionId: "conn_1" },
    });
    settleConnectedAsk(client, "pa_1", "conn_2");
    expect(client.getQueryData(link.queryKey)?.pendingAction.answer).toEqual({
      connectionId: "conn_1",
    });
  });
});
