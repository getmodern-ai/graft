import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { RefObject } from "react";
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
import { type Agent, agentKeys, archiveAgent } from "@/lib/agent-queries";

export function ArchiveAgentDialog({
  agent,
  open,
  onOpenChange,
  returnFocus,
}: {
  agent: Agent;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  returnFocus: RefObject<HTMLButtonElement | null>;
}) {
  const queryClient = useQueryClient();
  const archive = useMutation({
    mutationFn: () => archiveAgent(agent.id),
    onSuccess: () => {
      onOpenChange(false);
      void queryClient.invalidateQueries({ queryKey: agentKeys.all });
      toast.success(`${agent.name} is archived`, {
        description: "Use Show archived to view its working set and history.",
      });
    },
  });

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!archive.isPending) onOpenChange(next);
      }}
    >
      <AlertDialogContent
        finalFocus={() =>
          returnFocus.current?.isConnected && !returnFocus.current.disabled
            ? returnFocus.current
            : document.getElementById("show-archived-agents")
        }
      >
        <AlertDialogHeader>
          <AlertDialogTitle>Archive {agent.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            This agent will be hidden from the default list and its tokens will stop working. Its
            working set and history stay available under Show archived. To connect the harness
            again, create a new agent.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={archive.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={archive.isPending}
            onClick={() => {
              if (!archive.isPending) archive.mutate();
            }}
          >
            {archive.isPending ? "Archiving…" : "Archive agent"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
