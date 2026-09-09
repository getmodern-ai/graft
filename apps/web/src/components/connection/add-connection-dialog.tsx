import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

import { ConnectionFormFields, HostsNotice } from "@/components/connection/connection-form";
import { CredentialFields } from "@/components/connection/credential-fields";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FieldGroup, FieldLegend, FieldSet } from "@/components/ui/field";
import { ApiError } from "@/lib/api";
import {
  type ConnectionDraft,
  type DraftErrors,
  emptyDraft,
  validateConnectionDraft,
} from "@/lib/connection-form";
import { connectionKeys, createConnection } from "@/lib/connection-queries";

/**
 * The person's own Add connection (GRA-28): the same form as an agent's proposal with no pending
 * action behind it. The connection is registered with its credential in one call
 * (`POST /api/connections` with `credential`), and belongs to the person; it reaches an agent when
 * they add it to that agent's scope (ADR 0007).
 */
export function AddConnectionDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<ConnectionDraft>(() => emptyDraft());
  const [errors, setErrors] = useState<DraftErrors>({});

  const create = useMutation({
    mutationFn: createConnection,
    onSuccess: ({ connection }) => {
      queryClient.invalidateQueries({ queryKey: connectionKeys.all });
      toast.success(`${connection.displayName} is connected`, {
        description: "Add it to an agent's scope on the agent's page to let that agent use it.",
      });
      close();
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 400) {
        const details = error.details as { reason?: string } | undefined;
        if (details?.reason === "host_not_public") setErrors({ primaryHost: error.message });
      }
    },
  });

  const close = () => {
    onOpenChange(false);
    setTimeout(() => {
      setDraft(emptyDraft());
      setErrors({});
      create.reset();
    }, 200);
  };

  const submit = () => {
    const verdict = validateConnectionDraft(draft);
    if (!verdict.ok) {
      setErrors(verdict.errors);
      return;
    }
    setErrors({});
    create.mutate(verdict.value);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-2xl">
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>Add a connection</DialogTitle>
            <DialogDescription>
              One vendor account: its hosts, its auth scheme and its credential, entered once and
              never shown again. Agents use it once you add it to their scope.
            </DialogDescription>
          </DialogHeader>
          <FieldSet>
            <FieldLegend variant="label">The connection</FieldLegend>
            <FieldGroup>
              <ConnectionFormFields
                draft={draft}
                onChange={setDraft}
                errors={errors}
                idPrefix="add-connection"
                disabled={create.isPending}
              />
            </FieldGroup>
          </FieldSet>
          <HostsNotice draft={draft} />
          <FieldSet>
            <FieldLegend variant="label">The secret</FieldLegend>
            <FieldGroup>
              <CredentialFields
                scheme={draft.scheme}
                value={draft.credential}
                onChange={(credential) => setDraft({ ...draft, credential })}
                errors={errors}
                idPrefix="add-connection"
                disabled={create.isPending}
              />
            </FieldGroup>
          </FieldSet>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" disabled={create.isPending}>
              {create.isPending ? "Connecting…" : "Connect"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
