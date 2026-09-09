import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

import { CredentialFields } from "@/components/connection/credential-fields";
import { ConsentStatus } from "@/components/connection/oauth-client-notice";
import { useOAuthConsent } from "@/components/connection/use-oauth-consent";
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
import { startOAuthConsent } from "@/lib/oauth-consent";

/**
 * Re-enter a connection's credential from the console, with no agent asking (GRA-28): a rotated
 * key, or the reconnection after a revoke (ADR 0007 — the credential is cleared, the tools stay and
 * re-ask). The scheme's secret inputs come from the table; the new credential replaces the old
 * through `PUT /api/connections/:id/credential` and touches no approval. For an OAuth consent what
 * is re-entered is the client secret, and the consent follows in a popup (ADR 0005): the connection
 * is reconnected when the vendor sends the browser back, not when the secret is saved.
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
  const oauth = connection.oauth !== null;
  const consent = useOAuthConsent({
    onConnected: () => {
      queryClient.invalidateQueries({ queryKey: toolKeys.all });
      toast.success(`${connection.displayName} is ${reconnecting ? "reconnected" : "connected"}`, {
        description: "The consent completed; its tools ask again on their own terms.",
      });
      close();
    },
  });

  const save = useMutation({
    mutationFn: async (value: Record<string, string>) => {
      const saved = await setConnectionCredential(connection.id, value);
      // The client secret is the first half; the consent is the second, started right after.
      return oauth ? startOAuthConsent(connection.id) : { ...saved, authorizeUrl: undefined };
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: connectionKeys.all });
      queryClient.invalidateQueries({ queryKey: toolKeys.all });
      queryClient.invalidateQueries({ queryKey: agentKeys.all });
      if ("authorizeUrl" in result && result.authorizeUrl) {
        toast.message(`${connection.displayName}'s client secret is saved`, {
          description: "Complete the consent in the popup to finish.",
        });
        void consent.run(result.authorizeUrl, result.connection);
        return;
      }
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
      consent.reset();
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

  const consenting = consent.state.phase === "running" || consent.state.phase === "blocked";
  const busy = save.isPending || consenting;

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
              {reconnecting
                ? "Reconnect"
                : oauth
                  ? "Re-enter the client secret for"
                  : "Re-enter the credential for"}{" "}
              {connection.displayName}
            </DialogTitle>
            <DialogDescription>
              Scheme <code className="font-mono">{connection.scheme}</code>, sent to{" "}
              {connection.hosts.join(", ")}.{" "}
              {oauth
                ? "The client secret is stored, then the vendor's consent runs in a popup; the tokens it yields are stored encrypted and never shown."
                : reconnecting
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
              disabled={busy}
              autoFocus
            />
          </FieldGroup>
          <ConsentStatus state={consent.state} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {save.isPending
                ? "Saving…"
                : consenting
                  ? "Waiting for the consent…"
                  : oauth
                    ? "Save and connect"
                    : reconnecting
                      ? "Reconnect"
                      : "Save credential"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
