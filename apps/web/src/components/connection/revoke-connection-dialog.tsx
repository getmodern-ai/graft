import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { agentKeys } from "@/lib/agent-queries";
import {
  type Connection,
  connectionKeys,
  revokeConnection,
  toolKeys,
} from "@/lib/connection-queries";
import { count } from "@/lib/format";

/**
 * Revoke a connection (ADR 0007): the credential and every OAuth secret are cleared, every approval
 * for the vendor's tools and every build approval for this connection are deleted, and every open
 * ask about it is closed — for all agents at once — and the tools stay, awaiting reconnection.
 * Re-entering the credential (`reenter-credential-dialog.tsx`) is the reconnection.
 *
 * The same `AlertDialog` shape as `agent/revoke-agent-dialog.tsx`, whose comment says why the
 * close requests are ignored while the revoke is in flight (GRA-45).
 */
export function RevokeConnectionDialog({
  connection,
  open,
  onOpenChange,
}: {
  connection: Connection;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const revoke = useMutation({
    mutationFn: () => revokeConnection(connection.id),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: connectionKeys.all });
      queryClient.invalidateQueries({ queryKey: toolKeys.all });
      queryClient.invalidateQueries({ queryKey: agentKeys.all });
      toast.success(`${connection.displayName} is revoked`, {
        description: `Credential cleared; ${count(result.approvalsDeleted, "tool approval")}, ${count(
          result.buildApprovalsDeleted,
          "build approval",
        )} and ${count(result.pendingActionsExpired, "open ask")} removed. Its tools stay and ask again after reconnection.`,
      });
      // The revoke stands; what the provider held outside Graft did not let go (ADR 0019). Revoking
      // again re-runs the release, which is why the card keeps offering Revoke on a revoked row.
      if (!result.providerRelease.released) {
        toast.warning(`${result.providerRelease.provider} did not release the connection`, {
          description:
            "Everything in Graft is revoked. The provider could not be reached to release what it holds; revoke again to retry.",
        });
      }
      onOpenChange(false);
    },
  });

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (next || !revoke.isPending) onOpenChange(next);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Revoke {connection.displayName}?</AlertDialogTitle>
          <AlertDialogDescription>
            The credential is cleared, every agent loses its approvals for {connection.vendor} tools
            at once, and any open ask about this connection is closed. The tools themselves stay in
            the toolbox and ask again once a credential is re-entered.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={revoke.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={revoke.isPending}
            onClick={() => revoke.mutate()}
          >
            {revoke.isPending ? "Revoking…" : "Revoke connection"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
