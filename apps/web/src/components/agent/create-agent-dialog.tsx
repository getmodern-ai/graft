import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { TokenOnce } from "@/components/agent/token-once";
import { ConnectionPicker } from "@/components/connection/connection-picker";
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
 * initial scope. The answer carries the token, and this dialog is where it is shown — once. Closing
 * the dialog is the end of it; the agent's page shows the prefix and the snippet, never the token.
 */
export function CreateAgentDialog({
  open,
  onOpenChange,
  connections,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connections: readonly Connection[];
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
                <ConnectionPicker connections={connections} selected={scope} onChange={setScope} />
              </Field>
            </FieldGroup>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={close}>
                Cancel
              </Button>
              <Button type="submit" disabled={create.isPending || name.trim().length === 0}>
                {create.isPending ? "Creating…" : "Create agent"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
