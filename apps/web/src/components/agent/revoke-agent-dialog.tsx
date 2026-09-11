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
import { type Agent, agentKeys, revokeAgent } from "@/lib/agent-queries";

/**
 * Revoke an agent's token (ADR 0007: one leak revokes one agent). The token stops resolving at the
 * MCP endpoint at once; the row, its working set and its history stay as the person's records.
 *
 * An `AlertDialog` in Cando's shape (GRA-45): the title asks, the description names what goes and
 * what stays, Cancel is first in the DOM and the destructive action last, its label a present
 * participle while the revoke is in flight and both controls disabled until it settles. Close
 * requests are ignored meanwhile — `AlertDialogAction` is a plain button, so pressing it never
 * closes this itself, but Escape still would, and a confirmation dismissed mid-revoke leaves a
 * refusal with nowhere to land. Success closes it in the mutation's own handler.
 */
export function RevokeAgentDialog({
  agent,
  open,
  onOpenChange,
}: {
  agent: Agent;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const revoke = useMutation({
    mutationFn: () => revokeAgent(agent.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: agentKeys.all });
      toast.success(`${agent.name}'s token is revoked`, {
        description: "Its harness is refused at the MCP endpoint from now on.",
      });
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
          <AlertDialogTitle>Revoke {agent.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            The token <code className="font-mono">{agent.tokenPrefix}…</code> stops working
            immediately and cannot be restored. The agent's working set and history stay here; to
            reconnect the harness, create a new agent.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={revoke.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={revoke.isPending}
            onClick={() => revoke.mutate()}
          >
            {revoke.isPending ? "Revoking…" : "Revoke token"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
