import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { TokenOnce } from "@/components/agent/token-once";
import { ConnectionPicker } from "@/components/connection/connection-picker";
import { RetryNotice } from "@/components/retry-notice";
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
import { Skeleton } from "@/components/ui/skeleton";
import { agentKeys, type CreatedAgent, createAgent } from "@/lib/agent-queries";
import type { Connection } from "@/lib/connection-queries";

/**
 * Create an agent: a name, the cap and the idle window (ADR 0009's two per-agent knobs), and the
 * initial scope. The answer carries the token, and this dialog is where it is shown — once. Closing
 * the dialog is the end of it; the agent's page shows the prefix and the snippet, never the token.
 *
 * The connections arrive from a read the agents route starts without awaiting (`agents.index.tsx`),
 * so the dialog can open before they have: `connections` is `undefined` until then, the scope
 * draws skeleton rows in the picker's place, and Create waits — a scope chosen from a list that
 * has not arrived would be an empty one nobody chose (raised by Greptile on #30). A read that
 * failed shows the same Retry a table body does, and Create still waits.
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
                connectionIds: [...scope],
              });
            }}
          >
            <DialogHeader>
              <DialogTitle>New agent</DialogTitle>
              <DialogDescription>
                One harness connection to Graft — a token, a scope and a working set of its own.
              </DialogDescription>
            </DialogHeader>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="agent-name">Name</FieldLabel>
                <Input
                  id="agent-name"
                  required
                  autoFocus
                  placeholder="laptop Hermes"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
                <FieldDescription>Where the harness runs, and which one it is.</FieldDescription>
              </Field>
              <div className="grid grid-cols-2 gap-4">
                <Field>
                  <FieldLabel htmlFor="agent-cap">Working-set cap</FieldLabel>
                  <Input
                    id="agent-cap"
                    type="number"
                    min={1}
                    step={1}
                    required
                    value={cap}
                    onChange={(event) => setCap(event.target.value)}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="agent-idle">Idle window (days)</FieldLabel>
                  <Input
                    id="agent-idle"
                    type="number"
                    min={1}
                    step={1}
                    required
                    value={idleDays}
                    onChange={(event) => setIdleDays(event.target.value)}
                  />
                </Field>
              </div>
              <Field>
                <FieldLabel>Scope</FieldLabel>
                <FieldDescription>
                  The connections this agent may use. Its tools cannot reach a connection outside
                  the scope; you can change it any time.
                </FieldDescription>
                {connections ? (
                  <ConnectionPicker
                    connections={connections}
                    selected={scope}
                    onChange={setScope}
                  />
                ) : connectionsFailed ? (
                  <p className="text-muted-foreground text-sm">
                    <RetryNotice
                      error={connectionsFailed.error}
                      message="Could not load your connections."
                      onRetry={connectionsFailed.onRetry}
                      retrying={connectionsFailed.retrying}
                    />
                  </p>
                ) : (
                  // Two rows at the picker's own height, so the dialog does not jump when it lands.
                  <div className="flex flex-col gap-2.5" aria-busy="true">
                    {[0, 1].map((row) => (
                      <Skeleton key={row} className="h-14 w-full rounded-lg" />
                    ))}
                  </div>
                )}
              </Field>
            </FieldGroup>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={close}>
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={create.isPending || name.trim().length === 0 || connections === undefined}
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
