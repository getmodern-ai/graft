import type { AgentScopeMode } from "@graft/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { ScopeModeField } from "@/components/agent/scope-mode-field";
import { TokenOnce } from "@/components/agent/token-once";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { agentKeys, type CreatedAgent, createAgent } from "@/lib/agent-queries";
import type { Connection } from "@/lib/connection-queries";

/**
 * Create an agent: a name, the cap and the idle window (ADR 0009's two per-agent knobs), and the
 * scope — `All connections` by default, or `Selected connections` with the picker (ADR 0007 as amended
 * 2026-09-19; `scope-mode-field.tsx`). The answer carries the token, and this dialog is where it is
 * shown — once. Closing the dialog is the end of it; `AgentConnectionDialog` reopens the
 * instructions with the prefix and a placeholder, never the token (ADR 0007).
 *
 * The connections arrive from a read the agents route starts without awaiting (`agents.index.tsx`),
 * so the dialog can open before they have: `connections` is `undefined` until then and, under
 * `Selected connections`, the scope draws skeleton rows in the picker's place and Create waits — a scope
 * chosen from a list that has not arrived would be an empty one nobody chose (raised by Greptile on
 * #30). A read that failed shows the same Retry a table body does, and Create still waits. Under
 * `All connections` nothing is chosen from the list, so Create does not wait for it.
 */
export function CreateAgentDialog({
  open,
  onOpenChange,
  connections,
  connectionsFailed,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The person's connections, or `undefined` while the read is pending or has failed. */
  connections: readonly Connection[] | undefined;
  /** Set while the connections read has failed: what to show and how to try again. */
  connectionsFailed?: { error: unknown; onRetry: () => void; retrying: boolean };
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [cap, setCap] = useState("20");
  const [idleDays, setIdleDays] = useState("21");
  const [scopeMode, setScopeMode] = useState<AgentScopeMode>("all");
  const [scope, setScope] = useState<Set<string>>(new Set());
  const [created, setCreated] = useState<CreatedAgent | null>(null);

  const create = useMutation({
    mutationFn: createAgent,
    onSuccess: (answer) => {
      setCreated(answer);
      queryClient.invalidateQueries({ queryKey: agentKeys.all });
    },
  });

  const close = () => {
    onOpenChange(false);
    // Reset after the close animation, so the token is not visibly blanked mid-fade.
    setTimeout(() => {
      setCreated(null);
      setName("");
      setCap("20");
      setIdleDays("21");
      setScopeMode("all");
      setScope(new Set());
      create.reset();
    }, 200);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent className="sm:max-w-lg">
        {created ? (
          <>
            <DialogHeader>
              <DialogTitle>{created.agent.name} is ready</DialogTitle>
              <DialogDescription>
                Connect your harness with the token below. It will not be shown again.
              </DialogDescription>
            </DialogHeader>
            <TokenOnce token={created.token} />
            <DialogFooter>
              <Button onClick={close}>I have copied the token</Button>
            </DialogFooter>
          </>
        ) : (
          <form
            className="contents"
            onSubmit={(event) => {
              event.preventDefault();
              create.mutate({
                name,
                workingSetCap: Number(cap),
                idleWindowDays: Number(idleDays),
                scopeMode,
                ...(scopeMode === "listed" ? { connectionIds: [...scope] } : {}),
              });
            }}
          >
            <DialogHeader>
              <DialogTitle>New agent</DialogTitle>
              <DialogDescription>
                Give this agent a name, then choose its tool limits and connections.
              </DialogDescription>
            </DialogHeader>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="agent-name">Name</FieldLabel>
                <Input
                  id="agent-name"
                  required
                  autoFocus
                  placeholder="Enter agent name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
                <FieldDescription>For example, Hermes on your laptop.</FieldDescription>
              </Field>
              <div className="grid grid-cols-2 gap-4">
                <Field>
                  <FieldLabel htmlFor="agent-cap">Working set cap</FieldLabel>
                  <Input
                    id="agent-cap"
                    type="number"
                    placeholder="20"
                    min={1}
                    step={1}
                    required
                    value={cap}
                    onChange={(event) => setCap(event.target.value)}
                  />
                  <FieldDescription>Target number of tools in the working set.</FieldDescription>
                </Field>
                <Field>
                  <FieldLabel htmlFor="agent-idle">Idle window (days)</FieldLabel>
                  <Input
                    id="agent-idle"
                    type="number"
                    placeholder="21"
                    min={1}
                    step={1}
                    required
                    value={idleDays}
                    onChange={(event) => setIdleDays(event.target.value)}
                  />
                  <FieldDescription>
                    Days without use before a tool leaves the working set.
                  </FieldDescription>
                </Field>
              </div>
              <ScopeModeField
                id="agent-scope"
                mode={scopeMode}
                onModeChange={setScopeMode}
                selected={scope}
                onSelectedChange={setScope}
                connections={connections}
                connectionsFailed={connectionsFailed}
              />
            </FieldGroup>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={close}>
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={
                  create.isPending ||
                  name.trim().length === 0 ||
                  (scopeMode === "listed" && connections === undefined)
                }
              >
                {create.isPending ? "Creating…" : "Create agent"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
