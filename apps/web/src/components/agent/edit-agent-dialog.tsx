import {
  AGENT_NAME_MAX_LENGTH,
  IDLE_WINDOW_DAYS_RANGE,
  WORKING_SET_CAP_RANGE,
} from "@graft/core/agent/agent.rules";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type RefObject, useState } from "react";
import { toast } from "sonner";

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
import { type Agent, agentKeys, updateAgentLimits } from "@/lib/agent-queries";

/** Mounted for each edit, so cancelling discards the draft and reopening reads the saved values. */
export function EditAgentDialog({
  agent,
  onClose,
  returnFocus,
}: {
  agent: Agent;
  onClose: () => void;
  returnFocus: RefObject<HTMLButtonElement | null>;
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(true);
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
      toast.success("Agent saved", { description: "The next sweep uses these limits." });
      setOpen(false);
    },
  });
  const disabled = save.isPending || agent.revokedAt !== null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!save.isPending) setOpen(next);
      }}
      onOpenChangeComplete={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        className="sm:max-w-lg"
        finalFocus={returnFocus}
        showCloseButton={!save.isPending}
      >
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            if (!disabled && dirty && name.trim()) save.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>Edit agent</DialogTitle>
            <DialogDescription>
              Change the name and how the working set contracts. Saved limits take effect at the
              next sweep.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="edit-agent-name">Name</FieldLabel>
              <Input
                id="edit-agent-name"
                autoFocus
                required
                maxLength={AGENT_NAME_MAX_LENGTH}
                disabled={disabled}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            <div className="grid grid-cols-2 gap-4">
              <Field>
                <FieldLabel htmlFor="edit-agent-cap">Working-set cap</FieldLabel>
                <Input
                  id="edit-agent-cap"
                  type="number"
                  {...WORKING_SET_CAP_RANGE}
                  step={1}
                  required
                  disabled={disabled}
                  value={cap}
                  onChange={(event) => setCap(event.target.value)}
                />
                <FieldDescription>How many tools may be promoted at once.</FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="edit-agent-idle">Idle window (days)</FieldLabel>
                <Input
                  id="edit-agent-idle"
                  type="number"
                  {...IDLE_WINDOW_DAYS_RANGE}
                  step={1}
                  required
                  disabled={disabled}
                  value={idleDays}
                  onChange={(event) => setIdleDays(event.target.value)}
                />
                <FieldDescription>Unused this long, a tool is demoted.</FieldDescription>
              </Field>
            </div>
          </FieldGroup>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={save.isPending}
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={disabled || !dirty || !name.trim()}>
              {save.isPending ? "Saving…" : "Save changes"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
