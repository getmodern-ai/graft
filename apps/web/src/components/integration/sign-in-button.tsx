import { useMutation } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { ReenterCredentialDialog } from "@/components/connection/reenter-credential-dialog";
import { useOAuthConsent } from "@/components/connection/use-oauth-consent";
import { Button } from "@/components/ui/button";
import { isKeyringConnection } from "@/lib/connection-queries";
import type { IntegrationConnection } from "@/lib/integration-queries";
import { startOAuthConsent } from "@/lib/oauth-consent";

/**
 * Sign in, the way the integration page's Connection tab does it (`reconnectActionsOf`): the
 * consent in a popup where the client secret is in place, the credential dialog otherwise. The
 * integrations table's rows and the sign-in rows in Requests (GRA-313) both draw it.
 */
export function SignInButton({
  connection,
  kind,
  variant = "outline",
}: {
  connection: IntegrationConnection;
  kind: "consent" | "credential";
  /** Outline in the integrations table; the filled primary on a request row (GRA-313). */
  variant?: "outline" | "default";
}) {
  const [entering, setEntering] = useState(false);
  const consent = useOAuthConsent({
    onConnected: () => toast.success(`${connection.displayName} is connected`),
  });
  const reconsent = useMutation({
    mutationFn: () => startOAuthConsent(connection.id),
    onSuccess: ({ authorizeUrl }) => void consent.run(authorizeUrl, connection),
    onError: (error) => toast.error("Could not start the sign-in", { description: error.message }),
  });
  const { state } = consent;
  // A row has no room for the Connection tab's status block, so what it would say is a toast.
  useEffect(() => {
    if (state.phase === "blocked") {
      toast.warning("The browser blocked the popup", {
        description: `Allow popups for this page, or open the sign-in for ${connection.displayName} yourself.`,
        action: { label: "Open", onClick: () => window.open(state.authorizeUrl, "_blank") },
      });
    } else if (
      state.phase === "done" &&
      state.outcome !== "connected" &&
      state.outcome !== "stopped"
    ) {
      toast.error(`${connection.displayName} is not connected`, { description: state.message });
    }
  }, [state, connection.displayName]);
  return (
    <>
      {consent.running ? (
        // Closing the popup does not end the wait (`awaitConsent`), so the row offers to stop it,
        // as `ConsentStatus` does on the Connection tab, and Sign in comes back.
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Stop waiting for ${connection.displayName}`}
          onClick={consent.cancel}
        >
          Stop waiting
        </Button>
      ) : (
        <Button
          variant={variant}
          size="sm"
          disabled={reconsent.isPending}
          aria-label={`Sign in to ${connection.displayName}`}
          onClick={() => (kind === "consent" ? reconsent.mutate() : setEntering(true))}
        >
          Sign in
        </Button>
      )}
      {kind === "credential" && isKeyringConnection(connection) ? (
        <ReenterCredentialDialog
          key={`${connection.id}:${connection.credentialSetAt ?? "none"}`}
          connection={connection}
          open={entering}
          onOpenChange={setEntering}
        />
      ) : null}
    </>
  );
}
