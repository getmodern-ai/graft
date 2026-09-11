import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";

import { agentKeys } from "@/lib/agent-queries";
import {
  type Connection,
  connectionKeys,
  connectionStatus,
  fetchConnection,
} from "@/lib/connection-queries";
import { awaitConsent, type ConsentOutcome, openConsentPopup } from "@/lib/oauth-consent";
import { pendingKeys } from "@/lib/pending-action-queries";

/**
 * The consent as a component runs it (ADR 0005): open the authorize URL in a popup, wait for the
 * connection to read as connected (or the callback's message, or the person to stop waiting), then
 * refresh what the consent changed — the connection, the pending actions it answered, the agent's
 * scope. One hook for the four places a consent starts: the agent's proposal card, Add connection,
 * Connect and Reconnect on the card, and a credential ask. The page that posts the message is the
 * console's own `/oauth/callback` route (GRA-48), so the filter reads this page's origin and nothing
 * has to be fetched before the popup opens. `lib/oauth-consent.ts` says why the popup's own state
 * is never read.
 */

export type ConsentState =
  | { phase: "idle" }
  | { phase: "running"; connectionId: string }
  /** The browser refused the popup; the person opens the URL themselves. */
  | { phase: "blocked"; connectionId: string; authorizeUrl: string }
  | { phase: "done"; connectionId: string; outcome: ConsentOutcome; message: string };

export function useOAuthConsent(options: { onConnected?: (connectionId: string) => void } = {}) {
  const queryClient = useQueryClient();
  const [state, setState] = useState<ConsentState>({ phase: "idle" });
  const stop = useRef<AbortController | null>(null);

  const run = useCallback(
    async (authorizeUrl: string, connection: Pick<Connection, "id" | "oauth">) => {
      const before = connection.oauth?.consentedAt ?? null;
      // Connected means a consent completed *after* this one started, not one that already stood.
      const isConnected = async () => {
        const { connection: fresh } = await fetchConnection(connection.id);
        return (
          connectionStatus(fresh) === "connected" && (fresh.oauth?.consentedAt ?? null) !== before
        );
      };
      const popup = openConsentPopup(authorizeUrl);
      if (!popup) {
        setState({ phase: "blocked", connectionId: connection.id, authorizeUrl });
        return;
      }
      stop.current?.abort();
      const controller = new AbortController();
      stop.current = controller;
      setState({ phase: "running", connectionId: connection.id });
      const { outcome, message } = await awaitConsent({
        popup,
        connectionId: connection.id,
        isConnected,
        signal: controller.signal,
      });
      if (stop.current === controller) stop.current = null;
      setState({ phase: "done", connectionId: connection.id, outcome, message });
      queryClient.invalidateQueries({ queryKey: connectionKeys.all });
      queryClient.invalidateQueries({ queryKey: pendingKeys.all });
      queryClient.invalidateQueries({ queryKey: agentKeys.all });
      if (outcome === "connected") options.onConnected?.(connection.id);
    },
    [queryClient, options.onConnected],
  );

  /** The person gives up on this consent — the card offers Connect again. */
  const cancel = useCallback(() => stop.current?.abort(), []);

  const reset = useCallback(() => {
    stop.current?.abort();
    setState({ phase: "idle" });
  }, []);

  return { state, run, cancel, reset, running: state.phase === "running" };
}
