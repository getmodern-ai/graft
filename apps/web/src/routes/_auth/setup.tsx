import { setupCompletedMessage } from "@graft/core/connection/card.rules";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";

import { GraftWordmark } from "@/components/graft-wordmark";
import { CheckCircleIcon, InfoIcon } from "@/components/icons";
import { Loader } from "@/components/loader";
import { RetryNotice } from "@/components/retry-notice";
import { useSetupBack } from "@/components/setup/setup-footer";
import { SetupProgress, SetupRail } from "@/components/setup/setup-rail";
import { SetupStepView } from "@/components/setup/setup-step";
import { useSetupMutation } from "@/components/setup/use-setup-mutation";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { announceConsent } from "@/lib/oauth-consent";
import { DEFAULT_SIGNED_IN_PATH } from "@/lib/safe-redirect";
import {
  afterSetupFinish,
  readSetupSearch,
  SETUP_CLOSE_CHECK_MS,
  SETUP_CLOSE_MS,
  SETUP_FROM_CARD,
  setupFinishedToast,
} from "@/lib/setup-page";
import { type SetupFinish, setupQuery, skipSetup } from "@/lib/setup-queries";

/**
 * **Setup** (CONTEXT.md; ADR 0024): the console's guided first run, full screen. Under the guard
 * (`_auth`), so a signed-out visit signs in and comes back, and outside the shell (`_auth/_shell`),
 * as the handoff page is: the shell is what sends a new person here (`_shell/route.tsx`, the show
 * rule), and a page the shell redirects to cannot wear the shell without redirecting to itself.
 *
 * The layout is GRA-202's: the steps down the left at `md` and up (`SetupRail`), collapsing to a
 * progress line above the step below it (`SetupProgress`), and the step itself in a column of the
 * create dialog's width. The step on screen is the server's `state.step`, so a reload resumes where
 * the record stands. *Skip for now* is in the band at the top on every step but the last, and
 * returns to the console for good: the show rule never answers yes after a skip.
 *
 * **Opened from the chat** (GRA-210): `find_tool`'s offer links here as `/setup?agent=<id>`, so the
 * harness step starts as that agent even among several, and the ask card's button adds `from=card`.
 * A page the card opened says so above the step and, once Setup is finished, tells its opener
 * (`graft:ask`) and closes itself as the handoff page does; `lib/setup-page.ts` decides. A browser
 * that refuses to close the window leaves the finished step with a sentence saying it is done.
 */
export const Route = createFileRoute("/_auth/setup")({
  validateSearch: readSetupSearch,
  head: () => ({ meta: [{ title: "Set up Graft" }] }),
  loader: ({ context }) => {
    void context.queryClient.prefetchQuery(setupQuery);
  },
  component: SetupRoute,
});

function SetupRoute() {
  const setup = useQuery(setupQuery);
  const search = Route.useSearch();
  const navigate = useNavigate();
  const skip = useSetupMutation(skipSetup);
  const back = useSetupBack();
  // The finish's answer, token included, for as long as this page is open (`finish-step.tsx`).
  const [finished, setFinished] = useState<SetupFinish | null>(null);
  // A token harness's token, issued on the finish step before Finish Setup (GRA-215), held here
  // so it outlives the step's own reads; shown once, never cached.
  const [issuedToken, setIssuedToken] = useState<string | null>(null);
  // Finish Setup succeeded and the page is on its way to the agent: the finish step stays drawn,
  // its button held, rather than the completed state flashing before the navigation lands.
  const [leaving, setLeaving] = useState(false);
  const [closeRefused, setCloseRefused] = useState(false);
  const state = setup.data;
  const step = finished ? "completed" : leaving ? "finish" : (state?.step ?? "harness");
  const fromCard = search.from === "card";

  // Completion is the finish succeeding (GRA-215): a visit the console opened lands on the agent's
  // page with a toast; a page the card opened tells its opener and closes; a token the finish
  // itself issued keeps the page, since it is shown once.
  const onFinished = (answer: SetupFinish, tool: Parameters<typeof setupFinishedToast>[1]) => {
    const after = afterSetupFinish(search, answer);
    if (after.kind === "leave") {
      setLeaving(true);
      const message = setupFinishedToast(answer.agent?.name ?? "Your agent", tool);
      toast.success(message.title, { description: message.description });
      if (after.to === "/agents") void navigate({ to: "/agents" });
      else void navigate({ to: after.to, params: { agentId: after.agentId } });
      return;
    }
    setFinished(answer);
    if (after.kind !== "close") return;
    announceConsent(setupCompletedMessage(), {
      opener: window.opener,
      origin: window.location.origin,
      channel: null,
    });
    setTimeout(() => {
      window.close();
      setTimeout(() => {
        if (!window.closed) setCloseRefused(true);
      }, SETUP_CLOSE_CHECK_MS);
    }, SETUP_CLOSE_MS);
  };

  return (
    <main className="flex min-h-svh flex-col">
      <header className="mt-4 flex h-9 shrink-0 items-center justify-between gap-4 px-4 md:mt-6 md:px-8">
        <GraftWordmark />
        {step !== "completed" && !leaving ? (
          <Button
            variant="ghost"
            disabled={skip.isPending}
            onClick={() =>
              skip.mutate(undefined, {
                onSuccess: () => void navigate({ to: DEFAULT_SIGNED_IN_PATH }),
              })
            }
          >
            {skip.isPending ? "Skipping…" : "Skip for now"}
          </Button>
        ) : null}
      </header>
      <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 p-4 md:flex-row md:gap-12 md:p-8">
        <aside className="hidden w-48 shrink-0 md:block">
          <SetupRail
            step={step}
            record={finished ? null : state?.setup}
            onBack={(to) => back.mutate(to)}
            pending={back.isPending}
          />
        </aside>
        <div className="md:hidden">
          <SetupProgress
            step={step}
            record={finished ? null : state?.setup}
            onBack={(to) => back.mutate(to)}
            pending={back.isPending}
          />
        </div>
        <section className="flex min-w-0 max-w-2xl flex-1 flex-col gap-6">
          {fromCard && closeRefused ? (
            <Alert>
              <CheckCircleIcon />
              <AlertTitle>{SETUP_FROM_CARD.doneTitle}</AlertTitle>
              <AlertDescription>{SETUP_FROM_CARD.doneMessage}</AlertDescription>
            </Alert>
          ) : fromCard && step !== "completed" ? (
            <Alert>
              <InfoIcon />
              <AlertTitle>{SETUP_FROM_CARD.title}</AlertTitle>
              <AlertDescription>{SETUP_FROM_CARD.message}</AlertDescription>
            </Alert>
          ) : null}
          {state ? (
            <SetupStepView
              state={state}
              finished={finished}
              leaving={leaving}
              onFinished={onFinished}
              issuedToken={issuedToken}
              onTokenIssued={setIssuedToken}
              agentId={search.agent}
            />
          ) : setup.isError ? (
            <p className="text-muted-foreground text-sm">
              <RetryNotice
                error={setup.error}
                message="Could not load Setup."
                onRetry={() => void setup.refetch()}
                retrying={setup.isFetching}
              />
            </p>
          ) : (
            <Loader />
          )}
        </section>
      </div>
    </main>
  );
}
