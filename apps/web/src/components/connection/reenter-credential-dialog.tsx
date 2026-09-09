import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

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
import { FieldGroup } from "@/components/ui/field";
import { agentKeys } from "@/lib/agent-queries";
import {
  credentialFieldsFor,
  type DraftErrors,
  emptyFields,
  validateCredentialDraft,
} from "@/lib/connection-form";
import {
  type Connection,
  connectionKeys,
  setConnectionCredential,
  toolKeys,
} from "@/lib/connection-queries";

/**
 * Re-enter a connection's credential from the console, with no agent asking (GRA-28): a rotated
 * key, or the reconnection after a revoke (ADR 0007 — the credential is cleared, the tools stay and
 * re-ask). The scheme's secret inputs come from the table; the new credential replaces the old
 * through `PUT /api/connections/:id/credential` and touches no approval.
 */
export function ReenterCredentialDialog({
  connection,
  open,
  onOpenChange,
}: {
  connection: Connection;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [credential, setCredential] = useState<Record<string, string>>(() =>
    emptyFields(credentialFieldsFor(connection.scheme)),
  );
  const [errors, setErrors] = useState<DraftErrors>({});
  const reconnecting = connection.revokedAt !== null;

  const save = useMutation({
    mutationFn: (value: Record<string, string>) => setConnectionCredential(connection.id, value),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: connectionKeys.all });
      queryClient.invalidateQueries({ queryKey: toolKeys.all });
      queryClient.invalidateQueries({ queryKey: agentKeys.all });
      toast.success(
        reconnecting
          ? `${connection.displayName} is reconnected`
          : `${connection.displayName}'s credential is set`,
        {
          description: reconnecting
            ? "Its tools are usable again and ask afresh on their own terms."
            : "Approvals are unchanged; the next vendor call carries the new credential.",
        },
      );
      close();
    },
  });

  const close = () => {
    onOpenChange(false);
    setTimeout(() => {
      setCredential(emptyFields(credentialFieldsFor(connection.scheme)));
      setErrors({});
      save.reset();
    }, 200);
  };

  const submit = () => {
    const verdict = validateCredentialDraft(connection.scheme, credential);
    if (!verdict.ok) {
      setErrors(verdict.errors);
      return;
    }
    setErrors({});
    save.mutate(verdict.value);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent>
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {reconnecting ? "Reconnect" : "Re-enter the credential for"} {connection.displayName}
            </DialogTitle>
            <DialogDescription>
              Scheme <code className="font-mono">{connection.scheme}</code>, sent to{" "}
              {connection.hosts.join(", ")}.{" "}
              {reconnecting
                ? "The connection was revoked; a new credential reconnects it, and its tools ask again on their own terms."
                : "The new credential replaces the old one. Nothing else changes, and no approval is touched."}
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <CredentialFields
              scheme={connection.scheme}
              value={credential}
              onChange={setCredential}
              errors={errors}
              idPrefix={`reenter-${connection.id}`}
              disabled={save.isPending}
              autoFocus
            />
          </FieldGroup>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? "Saving…" : reconnecting ? "Reconnect" : "Save credential"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
