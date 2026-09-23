import { useMutation, useQueryClient } from "@tanstack/react-query";

import { agentKeys } from "@/lib/agent-queries";
import { type SetupStateData, setupKeys } from "@/lib/setup-queries";

/**
 * A Setup verb as a mutation: every one answers the whole state (`apps/server/src/api.ts`,
 * "Setup"), which is written straight into the one cache entry the page, the shell's intercept and
 * the agents table read, and the agents list is refetched, since a start may have minted one. A
 * failure toasts the server's sentence through the mutation cache, as every mutation does.
 */
export function useSetupMutation<TInput>(verb: (input: TInput) => Promise<SetupStateData>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: verb,
    onSuccess: (state) => {
      queryClient.setQueryData(setupKeys.current, state);
      void queryClient.invalidateQueries({ queryKey: agentKeys.all });
    },
  });
}
