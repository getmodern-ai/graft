import type { SuggestedIntegrationDeps } from "@graft/core";
import type { SuggestedConnectionAskRow } from "@graft/db/repo/pending-action";
import type { FakeStore } from "@graft/mcp/testing/fake-deps";

/**
 * `listSuggestedConnectionAsks` over the in-memory store, the statement's rule in code
 * (`packages/db/src/repo/pending-action.ts`; its rendered SQL is pinned in `repo/scope.test.ts`):
 * the person's live agents' `connection` asks, the newest per vendor, left out when answered with a
 * connection or when the person holds an unrevoked connection of the vendor; newest first.
 */
export function fakeSuggestedDeps(store: FakeStore): SuggestedIntegrationDeps {
  return {
    listSuggestedConnectionAsks: async (_db, personId, limit) => {
      const newest = new Map<string, SuggestedConnectionAskRow & { answeredWith: unknown }>();
      const rows = [...store.pendingActions.values()].sort(
        (a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id),
      );
      for (const row of rows) {
        const agent = store.agents.get(row.agentId);
        const vendor = row.payload.vendor;
        if (!agent || agent.personId !== personId || agent.revokedAt) continue;
        if (row.kind !== "connection" || typeof vendor !== "string" || newest.has(vendor)) continue;
        const connected = [...store.connections.values()].some(
          (c) => c.personId === personId && c.vendor === vendor && !c.revokedAt,
        );
        if (connected) continue;
        newest.set(vendor, {
          id: row.id,
          agentId: row.agentId,
          agentName: agent.name,
          vendor,
          displayName: typeof row.payload.displayName === "string" ? row.payload.displayName : null,
          docsUrl: typeof row.payload.docsUrl === "string" ? row.payload.docsUrl : null,
          answeredWith: row.answer?.connectionId ?? null,
          createdAt: row.createdAt,
          expiresAt: row.expiresAt,
          answeredAt: row.answeredAt,
          consumedAt: row.consumedAt,
        });
      }
      return [...newest.values()]
        .filter((row) => row.answeredWith == null)
        .slice(0, limit)
        .map(({ answeredWith: _, ...row }) => row);
    },
    now: () => store.now(),
  };
}
