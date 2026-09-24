import { useMutation, useQueryClient } from "@tanstack/react-query";

import { agentKeys } from "@/lib/agent-queries";
import { installSetupState, type SetupStateData, setupKeys } from "@/lib/setup-queries";

/**
 * A Setup verb as a mutation: every one answers the whole state (`apps/server/src/api.ts`,
 * "Setup"), which is written straight into the one cache entry the page, the shell's intercept and
 * the agents table read, after cancelling a read of it still in flight (`installSetupState`), and
 * the agents list is refetched, since a start may have minted one. A failure toasts the server's
 * sentence through the mutation cache, as every mutation does, and re-reads the state: a refusal
 * (a Build on a connection revoked meanwhile, a tab that moved on) means the record is not where
 * this page thought, and the read is what moves it on.
 */
export function useSetupMutation<TInput>(verb: (input: TInput) => Promise<SetupStateData>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: verb,
    onSuccess: async (state) => {
      await installSetupState(queryClient, state);
      void queryClient.invalidateQueries({ queryKey: agentKeys.all });
    },
    onError: () => {
      void queryClient.invalidateQueries({ queryKey: setupKeys.current, exact: true });
    },
  });
}
