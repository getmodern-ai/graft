import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { CodeBlock } from "@/components/code-block";
import { KeyIcon } from "@/components/icons";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { type Agent, agentKeys, rotateAgentToken } from "@/lib/agent-queries";

/**
 * Rotate an agent's static token (GRA-306; ADR 0007 as amended 2026-10-14). The old token is
 * refused from the next request on, a session already open included, so the confirmation says so
 * before anything is minted; the new token is then shown once in the same dialog, the only time
 * anyone sees it, as at creation.
 *
 * `revoke-agent-dialog.tsx`'s shape: Cancel first in the DOM, the destructive action last with a
 * present participle while pending, both disabled and close requests ignored until the mutation
 * settles. The token is held here, not read off the agent query the success invalidates.
 */
export function RotateTokenDialog({
  agent,
  open,
  onOpenChange,
}: {
  agent: Agent;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [token, setToken] = useState<string | null>(null);
  const rotate = useMutation({
    mutationFn: () => rotateAgentToken(agent.id),
    onSuccess: (rotated) => {
      setToken(rotated.token);
      void queryClient.invalidateQueries({ queryKey: agentKeys.all });
    },
  });

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (next || !rotate.isPending) onOpenChange(next);
      }}
      onOpenChangeComplete={(next) => {
        // Closed: the token is gone from the page, and the next opening asks again.
        if (!next) {
          setToken(null);
          rotate.reset();
        }
      }}
    >
      <AlertDialogContent>
        {token ? (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle>{agent.name} has a new token</AlertDialogTitle>
              <AlertDialogDescription>
                Replace the old token wherever {agent.name} keeps it. Until then, {agent.name} is
                refused at Graft.
              </AlertDialogDescription>
            </AlertDialogHeader>
            {/* `min-w-0`: a grid item of the dialog, as in `token-once.tsx`, so the `pre` scrolls. */}
            <div className="flex min-w-0 flex-col gap-4">
              <Alert>
                <KeyIcon />
                <AlertTitle>This token is shown once</AlertTitle>
                <AlertDescription>
                  Copy and save it now. If you lose it, rotate the token again.
                </AlertDescription>
              </Alert>
              <CodeBlock label="The agent's token" code={token} copyLabel="Copy token" />
            </div>
            <AlertDialogFooter>
              <AlertDialogAction onClick={() => onOpenChange(false)}>Done</AlertDialogAction>
            </AlertDialogFooter>
          </>
        ) : (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle>Rotate {agent.name}'s token?</AlertDialogTitle>
              <AlertDialogDescription>
                {agent.tokenPrefix ? (
                  <>
                    The token <code className="font-mono">{agent.tokenPrefix}…</code>
                  </>
                ) : (
                  "The current token"
                )}{" "}
                stops working immediately, including for a session {agent.name} already has open,
                and cannot be restored. A new token is shown once. The agent's working set,
                approvals and history stay as they are.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={rotate.isPending}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                disabled={rotate.isPending}
                onClick={() => rotate.mutate()}
              >
                {rotate.isPending ? "Rotating…" : "Rotate token"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </>
        )}
      </AlertDialogContent>
    </AlertDialog>
  );
}
