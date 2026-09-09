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
import { type Agent, agentKeys, revokeAgent } from "@/lib/agent-queries";

/**
 * Revoke an agent's token (ADR 0007: one leak revokes one agent). The token stops resolving at the
 * MCP endpoint at once; the row, its working set and its history stay as the person's records.
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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Revoke {agent.name}?</DialogTitle>
          <DialogDescription>
            The token <code className="font-mono">{agent.tokenPrefix}…</code> stops working
            immediately and cannot be restored. The agent's working set and history stay here; to
            reconnect the harness, create a new agent.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Keep it
          </Button>
          <Button variant="destructive" disabled={revoke.isPending} onClick={() => revoke.mutate()}>
            {revoke.isPending ? "Revoking…" : "Revoke token"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
