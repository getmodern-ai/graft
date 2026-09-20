import type { AgentScopeMode } from "@graft/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { AgentDetailsSection } from "@/components/agent/agent-details-section";

import { ConnectionPicker } from "@/components/connection/connection-picker";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { type Agent, agentKeys, setAgentScope } from "@/lib/agent-queries";
import type { Connection } from "@/lib/connection-queries";
import {
  readScopeMode,
  SCOPE_MODE_DESCRIPTION,
  SCOPE_MODE_ITEMS,
  scopeBodyFor,
  scopeDirty,
} from "@/lib/scope-mode";

/**
 * The agent's scope (CONTEXT.md, *Scope*; ADR 0007 as amended 2026-09-19): the mode as the
 * `Select` primitive — `All connections`, every connection the person has now and adds later, or
 * `Selected connections`, the picker. Both modes show the current connections; only a selected
 * list is editable. The server saves the mode and list in one transaction, taking effect on
 * the agent's next MCP call, when the capability token minted for its next exec names exactly the
 * connections the scope resolves to.
 *
 * Switching to `Selected connections` starts the picker from the scope as it stands — `connectionIds`
 * from `GET /agents/:id` is the resolved set under either mode — so a person narrowing an agent
 * unticks what it should lose rather than re-ticking what it should keep; the parent remounts this
 * on a save (its `key`), which is how the draft follows the saved state.
 */
export function ScopeEditor({
  agent,
  connectionIds,
  connections,
}: {
  agent: Agent;
  /** The scope as it resolves for the agent's mode — the list, or every connection of the person's. */
  connectionIds: readonly string[];
  connections: readonly Connection[];
}) {
  const queryClient = useQueryClient();
  const saved = { mode: agent.scopeMode, connectionIds: new Set(connectionIds) };
  const [mode, setMode] = useState<AgentScopeMode>(agent.scopeMode);
  const [draft, setDraft] = useState<Set<string>>(new Set(connectionIds));
  const dirty = scopeDirty(saved, { mode, connectionIds: draft });
  const frozen = agent.revokedAt !== null;

  const save = useMutation({
    mutationFn: () => setAgentScope(agent.id, scopeBodyFor(mode, draft)),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: agentKeys.one(agent.id),
      });
      toast.success("Scope saved", {
        description: "In effect on the agent's next call.",
      });
    },
  });

  const reset = () => {
    setMode(saved.mode);
    setDraft(new Set(saved.connectionIds));
  };

  return (
    <AgentDetailsSection
      title="Connections"
      description={
        <>
          The connections this agent may use. An authored tool running for it cannot reach a
          connection outside them.
        </>
      }
      actions={
        frozen ? null : (
          <>
            <Button variant="outline" disabled={!dirty || save.isPending} onClick={reset}>
              Reset
            </Button>
            <Button disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? "Saving…" : "Save scope"}
            </Button>
          </>
        )
      }
    >
      <Field>
        <FieldLabel htmlFor="scope-mode">Connections</FieldLabel>
        <Select
          value={mode}
          items={SCOPE_MODE_ITEMS}
          disabled={frozen || save.isPending}
          onValueChange={(next) => {
            const read = readScopeMode(next);
            if (read) setMode(read);
          }}
        >
          <SelectTrigger id="scope-mode" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SCOPE_MODE_ITEMS.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <FieldDescription>{SCOPE_MODE_DESCRIPTION[mode]}</FieldDescription>
        <ConnectionPicker
          connections={connections}
          selected={
            mode === "all" ? new Set(connections.map((connection) => connection.id)) : draft
          }
          onChange={setDraft}
          disabled={mode === "all" || frozen || save.isPending}
        />
      </Field>
    </AgentDetailsSection>
  );
}
