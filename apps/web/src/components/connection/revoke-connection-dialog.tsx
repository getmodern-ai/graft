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
  type RevokeResult,
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
 *
 * A connection from another provider (ADR 0019) has one more outcome: the revoke in Graft stands,
 * and what the provider held outside Graft may not have let go. That is a warning with a **Retry**
 * beside it, the console's Retry-toast shape (`lib/query-error-retry.ts`: one toast per connection,
 * a retry that fails again replaces it, `preventDefault` keeps it up while the retry runs). Retry is
 * the same revoke on the already-revoked row, which re-runs the release. The retry lives on the
 * toast because nothing on the row records a failed release yet, so the card cannot offer it after
 * a reload — which is why Revoke stays hidden on a revoked card and why the toast is the surface.
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
  const releaseToastId = `provider-release:${connection.id}`;
  const releaseMutationKey = ["provider-release", connection.id];

  /** The provider's release, reported: a warning with Retry when it failed, a dismissal when it held. */
  const reportRelease = (result: RevokeResult) => {
    const release = result.providerRelease;
    if (release.released) {
      toast.dismiss(releaseToastId);
      return;
    }
    toast.warning(`${release.provider} did not release ${connection.displayName}`, {
      id: releaseToastId,
      duration: Number.POSITIVE_INFINITY,
      description: `Everything in Graft is revoked. ${release.provider} could not be reached to release what it holds; Retry re-runs the release.`,
      action: {
        label: "Retry",
        onClick: (event) => {
          event.preventDefault();
          // Read live through the client, not through this closure: the toast outlives the render
          // that made it, so `retryRelease.isPending` here would be the value at that render —
          // always false — and a second click mid-flight would start a second release.
          if (queryClient.isMutating({ mutationKey: releaseMutationKey }) > 0) return;
          retryRelease.mutate();
        },
      },
    });
  };

  // The same revoke on the already-revoked row: everything local is a no-op, the release runs again.
  const retryRelease = useMutation({
    mutationKey: releaseMutationKey,
    mutationFn: () => revokeConnection(connection.id),
    onSuccess: (result) => {
      reportRelease(result);
      if (result.providerRelease.released) {
        toast.success(`${result.providerRelease.provider} released ${connection.displayName}`);
      }
    },
  });

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
      reportRelease(result);
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
