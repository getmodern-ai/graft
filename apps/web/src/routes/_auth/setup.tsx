import { setupCompletedMessage } from "@graft/core/connection/card.rules";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { GraftWordmark } from "@/components/graft-wordmark";
import { CheckCircleIcon, InfoIcon } from "@/components/icons";
import { Loader } from "@/components/loader";
import { RetryNotice } from "@/components/retry-notice";
import { useSetupBack } from "@/components/setup/setup-footer";
import { SetupStepView } from "@/components/setup/setup-step";
import { SetupEyebrowContext } from "@/components/setup/setup-step-header";
import { SetupStepper, SetupStepperCompact } from "@/components/setup/setup-stepper";
import { useSetupMutation } from "@/components/setup/use-setup-mutation";
import { SetupAppContext } from "@/components/setup/vendor-step";
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
import {
  chooseSetupStarter,
  type DirectoryEntry,
  type SetupFinish,
  type SetupStateData,
  setupQuery,
  skipSetup,
} from "@/lib/setup-queries";
import { setupEyebrow, setupStageOf, setupStages, stageHistoryMove } from "@/lib/setup-stages";
import { backTargetOf } from "@/lib/setup-steps";

/**
 * **Setup** (CONTEXT.md; ADR 0024): the console's guided first run, full screen. Under the guard
 * (`_auth`), so a signed-out visit signs in and comes back, and outside the shell (`_auth/_shell`),
 * as the handoff page is: the shell is what sends a new person here (`_shell/route.tsx`, the show
 * rule), and a page the shell redirects to cannot wear the shell without redirecting to itself.
 *
 * The layout is Setup v2's (the Figma "Console / Setup v2" frames): a top bar with the wordmark, the
 * four-stage stepper centred (`setupStages`; a compact progress below `md`) and *Skip for now*;
 * each step's centred hero with its eyebrow (`SetupEyebrowContext`), its content, and its sticky
 * footer (`SetupFooter`). The step on screen is the server's `state.step`, so a reload resumes where
 * the record stands. *Skip for now* returns to the console for good: the show rule never answers
 * yes after a skip.
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

  // A directory integration chosen on this page and not yet tasked (`SetupAppContext`): the tool
  // screen, read as the *Tool* stage while the record still stands on `vendor`. Dropped once the
  // record leaves the vendor step.
  const [app, setApp] = useState<DirectoryEntry | null>(null);
  const holdsApp = app !== null && state?.step === "vendor";
  // Once the record leaves the vendor step the held entry is spent: Back from the connect step
  // lands on the directory, not on the old tool screen (Greptile on #201).
  useEffect(() => {
    if (app && state && state.step !== "vendor") setApp(null);
  }, [app, state]);
  const starterId = finished ? null : (state?.setup?.starterId ?? (holdsApp ? app.slug : null));
  const stages = setupStages(step, starterId);
  useStageHistory(state, finished !== null || leaving, holdsApp ? () => setApp(null) : null);
  const eyebrow = setupEyebrow(step, starterId);
  const skipButton =
    step !== "completed" && !leaving ? (
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
    ) : null;

  return (
    <main className="flex min-h-svh flex-col">
      <header className="grid shrink-0 grid-cols-[1fr_auto] items-center gap-4 px-4 pt-4 md:grid-cols-[1fr_auto_1fr] md:px-8 md:py-5">
        <GraftWordmark />
        <div className="hidden md:block">
          <SetupStepper stages={stages} />
        </div>
        <div className="flex justify-end">{skipButton}</div>
        <div className="col-span-2 md:hidden">
          <SetupStepperCompact stages={stages} eyebrow={eyebrow} />
        </div>
      </header>
      <SetupAppContext.Provider value={{ app: holdsApp ? app : null, setApp }}>
        <SetupEyebrowContext.Provider value={eyebrow}>
          <section className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-8 px-4 pt-6 md:px-8 md:pt-8">
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
        </SetupEyebrowContext.Provider>
      </SetupAppContext.Provider>
    </main>
  );
}

/**
 * **Browser Back moves between Setup's stages and never leaves the app**: the stage rides in the
 * URL (`?stage=`), one history entry per stage reached, read by `stageHistoryMove`. A browser Back
 * onto an earlier stage runs the footer's own Back (the tool screen's clears the starter, every
 * other is the record's back move); Back onto the guard entry under the first stage pushes the
 * stage again, so the entry before Setup, a sign-in's provider page, is never replayed. *Skip for
 * now* is the way out.
 */
function useStageHistory(
  state: SetupStateData | undefined,
  done: boolean,
  /** The tool screen of a directory integration the page holds: Back drops it. */
  dropApp: (() => void) | null,
) {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const back = useSetupBack();
  const clear = useSetupMutation(chooseSetupStarter);
  const stage = state
    ? setupStageOf(state.step, state.setup?.starterId ?? (dropApp ? "app" : null))
    : null;
  const previousUrlStage = useRef<number | undefined>(undefined);
  const urlStage = search.stage;
  // What the effect acts with, read at the time it runs: the moves are the URL's and the stage's.
  const latest = useRef({ state, back, clear, navigate, dropApp });
  latest.current = { state, back, clear, navigate, dropApp };

  useEffect(() => {
    if (stage === null || done) return;
    const move = stageHistoryMove({ stage, urlStage, previousUrlStage: previousUrlStage.current });
    previousUrlStage.current = urlStage;
    const {
      state: now,
      back: goBack,
      clear: clearStarter,
      navigate: go,
      dropApp: drop,
    } = latest.current;
    const to = (next: number, replace: boolean) =>
      void go({ to: "/setup", search: (prev) => ({ ...prev, stage: next }), replace });
    switch (move) {
      case "guard":
        to(0, true);
        break;
      case "push":
      case "stay":
        to(stage, false);
        break;
      case "replace":
        to(stage, true);
        break;
      case "back":
        if (drop) {
          drop();
        } else if (now?.step === "vendor" && now.setup?.starterId) {
          clearStarter.mutate({ starterId: null });
        } else if (now) {
          const target = backTargetOf(now);
          if (target) goBack.mutate(target);
        }
        break;
      case "none":
        break;
    }
  }, [stage, urlStage, done]);
}
