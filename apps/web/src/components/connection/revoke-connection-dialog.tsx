import { useMutation, useQueryClient } from "@tanstack/react-query";
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
 * for the vendor's tools and every build approval for this connection are deleted — for all agents
 * at once — and the tools stay, awaiting reconnection. Re-entering the credential is the
 * reconnection; that form arrives with GRA-28.
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
        description: `Credential cleared; ${count(result.approvalsDeleted, "tool approval")} and ${count(
          result.buildApprovalsDeleted,
          "build approval",
        )} removed. Its tools stay and ask again after reconnection.`,
      });
      onOpenChange(false);
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Revoke {connection.displayName}?</DialogTitle>
          <DialogDescription>
            The credential is cleared and every agent loses its approvals for {connection.vendor}{" "}
            tools at once. The tools themselves stay in the toolbox and ask again once a credential
            is re-entered.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Keep it
          </Button>
          <Button variant="destructive" disabled={revoke.isPending} onClick={() => revoke.mutate()}>
            {revoke.isPending ? "Revoking…" : "Revoke connection"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
