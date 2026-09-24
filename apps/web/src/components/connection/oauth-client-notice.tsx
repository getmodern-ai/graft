import { useQuery } from "@tanstack/react-query";
import type { ConsentState } from "@/components/connection/use-oauth-consent";
import { CopyButton } from "@/components/copy-button";
import { KeyIcon, OpenInNewIcon, WarningIcon } from "@/components/icons";
import { RetryNotice } from "@/components/retry-notice";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
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

/**
 * An `Alert`, like every other notice in this form: the primitive's frame rather than a box of
 * this file's own. The URI is a skeleton while it loads and a `RetryNotice` if it does not —
 * the same two states a table body draws, since a URI that failed to arrive is the one thing
 * the person cannot proceed without.
 */
function RedirectUriNotice() {
  const { data, error, isPending, isError, isFetching, refetch } = useQuery(redirectUriQuery);
  return (
    <Alert>
      <KeyIcon />
      <AlertTitle>
        Register an OAuth client of the web application type with the integration, and paste this
        redirect URI into it
      </AlertTitle>
      <AlertDescription>
        {isPending ? (
          <Skeleton className="h-6 w-72 max-w-full" />
        ) : isError || !data ? (
          <p>
            <RetryNotice
              error={error}
              message="The redirect URI could not be fetched from the server."
              onRetry={() => void refetch()}
              retrying={isFetching}
            />
          </p>
        ) : (
          <p className="flex flex-wrap items-center gap-2">
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
              {data.redirectUri}
            </code>
            <CopyButton text={data.redirectUri} />
          </p>
        )}
        <p>
          Then enter the client's id above and its secret below. Connect opens the integration's
          consent in a popup; the tokens it yields are stored encrypted and never shown.
        </p>
      </AlertDescription>
    </Alert>
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
            Complete the consent in the popup. This page updates once the integration has sent you
            back.
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
              Open the integration's consent page
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
