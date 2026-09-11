import { useQuery } from "@tanstack/react-query";
import type { ConsentState } from "@/components/connection/use-oauth-consent";
import { CopyButton } from "@/components/copy-button";
import { KeyIcon, OpenInNewIcon, WarningIcon } from "@/components/icons";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { type ConnectionDraft, googleNoticeFor, isOAuthDraft } from "@/lib/connection-form";
import { redirectUriQuery } from "@/lib/oauth-consent";

/**
 * What the form says beside an OAuth consent's inputs (ADR 0005): the one redirect URI the person
 * pastes into the client they register at the vendor — fetched from the server, so it is the URI the
 * callback route serves and never one this bundle computed — and, when a host is Google's, the
 * Testing-mode sentence about refresh tokens expiring after seven days. Nothing for any other scheme.
 */
export function OAuthClientNotice({ draft }: { draft: ConnectionDraft }) {
  if (!isOAuthDraft(draft)) return null;
  return (
    <div className="flex flex-col gap-3">
      <RedirectUriNotice />
      <GoogleNotice draft={draft} />
    </div>
  );
}

function RedirectUriNotice() {
  const { data, error, isPending } = useQuery(redirectUriQuery);
  return (
    <div className="flex items-start gap-2 rounded-md border bg-muted/40 p-3 text-xs">
      <KeyIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="flex flex-col gap-1.5">
        <p className="font-medium">
          Register an OAuth client at the vendor — a web application — and paste this redirect URI
          into it:
        </p>
        {isPending ? (
          <Spinner className="size-4" />
        ) : error || !data ? (
          <p className="text-destructive">
            The redirect URI could not be fetched from the server; reload and try again.
          </p>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <code className="rounded bg-background px-1.5 py-0.5 font-mono">
              {data.redirectUri}
            </code>
            <CopyButton text={data.redirectUri} />
          </div>
        )}
        <p className="text-muted-foreground">
          Then enter the client's id above and its secret below. Connect opens the vendor's consent
          in a popup; the tokens it yields are stored encrypted and never shown.
        </p>
      </div>
    </div>
  );
}

/** The Google Testing-mode sentence, for Google hosts and no other (ADR 0005). */
export function GoogleNotice({ draft }: { draft: ConnectionDraft }) {
  const notice = googleNoticeFor(draft);
  if (!notice) return null;
  return (
    <Alert>
      <WarningIcon />
      <AlertTitle>Google project in Testing mode</AlertTitle>
      <AlertDescription>{notice}</AlertDescription>
    </Alert>
  );
}

/**
 * Where a running consent stands: the popup is open, the browser refused it (the person opens the
 * URL themselves), or how it ended. Rendered under the form once Connect has been pressed. The wait
 * ends when the connection reads as connected or the person stops it — a Google consent page
 * severs the popup from this page, so its closing is not something this page can see
 * (`lib/oauth-consent.ts`), which is why the stop is the person's.
 */
export function ConsentStatus({ state, onCancel }: { state: ConsentState; onCancel?: () => void }) {
  switch (state.phase) {
    case "idle":
      return null;
    case "running":
      return (
        <div className="flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
          <Spinner className="size-3.5" />
          <span>
            Complete the consent in the popup. This page updates once the vendor has sent you back.
          </span>
          {onCancel ? (
            <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
              Stop waiting
            </Button>
          ) : null}
        </div>
      );
    case "blocked":
      return (
        <Alert>
          <WarningIcon />
          <AlertTitle>The browser blocked the popup</AlertTitle>
          <AlertDescription>
            <a
              href={state.authorizeUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center gap-1 underline underline-offset-4"
            >
              Open the vendor's consent page
              <OpenInNewIcon className="size-3" />
            </a>{" "}
            and come back here once it says connected.
          </AlertDescription>
        </Alert>
      );
    case "done":
      return state.outcome === "connected" ? null : (
        <Alert variant={state.outcome === "failed" ? "destructive" : "default"}>
          <WarningIcon />
          <AlertTitle>
            {state.outcome === "declined"
              ? "The consent was declined"
              : state.outcome === "stopped"
                ? "Stopped waiting for the consent"
                : state.outcome === "expired"
                  ? "The consent took too long"
                  : "The consent did not complete"}
          </AlertTitle>
          <AlertDescription>
            {state.message || "The client id and secret are kept; press Connect to try again."}
          </AlertDescription>
        </Alert>
      );
  }
}
