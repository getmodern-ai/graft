import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type RefObject, useRef } from "react";
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
  const archived = useRef(false);
  const archive = useMutation({
    mutationFn: () => archiveAgent(agent.id),
    onSuccess: () => {
      archived.current = true;
      onOpenChange(false);
      void queryClient.invalidateQueries({ queryKey: agentKeys.all });
      toast.success(`${agent.name} is archived`, {
        description: "Its working set and history are available in the Archived section.",
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
          !archived.current && returnFocus.current?.isConnected && !returnFocus.current.disabled
            ? returnFocus.current
            : document.getElementById("new-agent")
        }
      >
        <AlertDialogHeader>
          <AlertDialogTitle>Archive {agent.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            This agent will move to the Archived section and its tokens will stop working. Its
            working set and history stay available. To connect the harness again, create a new
            agent.
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
