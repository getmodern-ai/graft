import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { type Agent, agentKeys, updateAgentLimits } from "@/lib/agent-queries";

/**
 * ADR 0009's two knobs, per agent. The rule they drive is the sweep (GRA-24): a tool unused for
 * longer than the idle window is demoted; when more tools are promoted than the cap, the least
 * recently used beyond it are demoted, never one used inside the window; nothing is demoted while
 * the agent has a run in flight, and a demoted tool stays in the toolbox one `find_tool` away.
 * Saved values take effect at the next sweep. The ranges are the service's
 * (`packages/core/src/agent/agent.service.ts`), which answers a sentence when a value is outside them.
 */
export function LimitsForm({ agent }: { agent: Agent }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(agent.name);
  const [cap, setCap] = useState(String(agent.workingSetCap));
  const [idleDays, setIdleDays] = useState(String(agent.idleWindowDays));
  const dirty =
    name.trim() !== agent.name ||
    Number(cap) !== agent.workingSetCap ||
    Number(idleDays) !== agent.idleWindowDays;

  const save = useMutation({
    mutationFn: () =>
      updateAgentLimits(agent.id, {
        name: name.trim(),
        workingSetCap: Number(cap),
        idleWindowDays: Number(idleDays),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: agentKeys.all });
      toast.success("Saved", {
        description: "The next sweep uses these limits.",
      });
    },
  });

  const disabled = agent.revokedAt !== null || save.isPending;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Name, cap and idle window</CardTitle>
        <CardDescription>
          The working set contracts by rule: a tool unused past the idle window is demoted, and when
          more than the cap are promoted the least recently used go first — never one used inside
          the window, and never while the agent has a run in flight. A demoted tool stays in the
          toolbox.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <Field>
          <FieldLabel htmlFor="limits-name">Name</FieldLabel>
          <Input
            id="limits-name"
            required
            disabled={disabled}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field>
            <FieldLabel htmlFor="limits-cap">Working-set cap</FieldLabel>
            <Input
              id="limits-cap"
              type="number"
              min={1}
              step={1}
              required
              disabled={disabled}
              value={cap}
              onChange={(event) => setCap(event.target.value)}
            />
            <FieldDescription>How many tools may be promoted at once.</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="limits-idle">Idle window (days)</FieldLabel>
            <Input
              id="limits-idle"
              type="number"
              min={1}
              step={1}
              required
              disabled={disabled}
              value={idleDays}
              onChange={(event) => setIdleDays(event.target.value)}
            />
            <FieldDescription>Unused this long, a tool is demoted.</FieldDescription>
          </Field>
        </div>
      </CardContent>
      {agent.revokedAt === null ? (
        <CardFooter className="justify-end gap-2">
          <Button
            variant="outline"
            disabled={!dirty || save.isPending}
            onClick={() => {
              setName(agent.name);
              setCap(String(agent.workingSetCap));
              setIdleDays(String(agent.idleWindowDays));
            }}
          >
            Reset
          </Button>
          <Button disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? "Saving…" : "Save"}
          </Button>
        </CardFooter>
      ) : null}
    </Card>
  );
}
