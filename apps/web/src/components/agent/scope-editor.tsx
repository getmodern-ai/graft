import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

import { ConnectionPicker } from "@/components/connection/connection-picker";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { type Agent, agentKeys, setAgentScope } from "@/lib/agent-queries";
import type { Connection } from "@/lib/connection-queries";

const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>) =>
  a.size === b.size && [...a].every((id) => b.has(id));

/**
 * The agent's scope, edited as a set (CONTEXT.md, *Scope*). Saved whole — the server replaces the
 * set in one transaction — and in effect on the agent's next MCP call: the capability token minted
 * for its next exec names exactly these connections (ADR 0007).
 */
export function ScopeEditor({
  agent,
  connectionIds,
  connections,
}: {
  agent: Agent;
  connectionIds: readonly string[];
  connections: readonly Connection[];
}) {
  const queryClient = useQueryClient();
  const saved = new Set(connectionIds);
  const [draft, setDraft] = useState<Set<string>>(saved);
  const dirty = !sameSet(draft, saved);

  const save = useMutation({
    // The product event this counts as, by key (`lib/analytics-events.ts`, GRA-100).
    mutationKey: ["agent", "scope"],
    mutationFn: () => setAgentScope(agent.id, [...draft]),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: agentKeys.one(agent.id),
      });
      toast.success("Scope saved", {
        description: "In effect on the agent's next call.",
      });
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Scope</CardTitle>
        <CardDescription>
          The connections this agent may use. An authored tool running for it cannot reach a
          connection outside this set.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ConnectionPicker
          connections={connections}
          selected={draft}
          onChange={setDraft}
          disabled={agent.revokedAt !== null || save.isPending}
        />
      </CardContent>
      {connections.length > 0 && agent.revokedAt === null ? (
        <CardFooter className="justify-end gap-2">
          <Button variant="outline" disabled={!dirty} onClick={() => setDraft(new Set(saved))}>
            Reset
          </Button>
          <Button disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? "Saving…" : "Save scope"}
          </Button>
        </CardFooter>
      ) : null}
    </Card>
  );
}
