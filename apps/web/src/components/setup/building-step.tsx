import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import { CheckCircleIcon, WarningIcon } from "@/components/icons";
import { Loader } from "@/components/loader";
import { RetryNotice } from "@/components/retry-notice";
import { SetupDisclosure } from "@/components/setup/setup-disclosure";
import { SetupFooter } from "@/components/setup/setup-footer";
import { SetupStepHeader } from "@/components/setup/setup-step-header";
import { useSetupMutation } from "@/components/setup/use-setup-mutation";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { jobPollInterval, type ProgressCard, progressCard } from "@/lib/setup-progress";
import {
  acquireJobQuery,
  continueSetupBuild,
  nextSetup,
  retrySetupGoal,
  type SetupStateData,
  setupKeys,
} from "@/lib/setup-queries";

/**
 * The building step (GRA-207; GRA-202, *Building and result*), drawn since GRA-215 as a **progress
 * card** in the shape a chat product draws a tool call: one compact card with a spinner and the
 * stage's plain label, a one-line current message under it that changes with each progress line,
 * the attempt count once past the first, and a *Details* disclosure holding the job's own lines
 * with what each stage is for (`progressCard` over `explainProgress`, the loop taught once). The
 * job is read through the agent's job route every two seconds while it works.
 *
 * A pass turns the spinner into a check, and the state is read again so the server moves the
 * record to the result. A failure shows the job's sentence in the card, and the footer's primary is
 * *Change the task*. *Continue while it runs* goes on to the finish with the job running.
 * Returned to after the tool landed (GRA-215), the card shows the pass and Continue walks on to the
 * result (`POST /api/setup/next`).
 */
export function BuildingStep({ state }: { state: SetupStateData }) {
  const agentId = state.agent?.id;
  const jobId = state.setup?.acquireJobId;
  if (!agentId || !jobId) return <Loader />;
  return <BuildingJob state={state} agentId={agentId} jobId={jobId} />;
}

function BuildingJob({
  state,
  agentId,
  jobId,
}: {
  state: SetupStateData;
  agentId: string;
  jobId: string;
}) {
  const queryClient = useQueryClient();
  const job = useQuery({
    ...acquireJobQuery(agentId, jobId),
    refetchInterval: (query) => jobPollInterval(query.state),
  });
  const card = progressCard(job.data);
  const retry = useSetupMutation(retrySetupGoal);
  const onward = useSetupMutation(continueSetupBuild);
  const next = useSetupMutation(nextSetup);
  // The record already names the tool: the person came back to look at a job that passed.
  const reviewing = state.setup?.toolId != null;

  // The pass is the server's to record: the next state read names the tool and moves to the result.
  useEffect(() => {
    if (card.kind === "passed" && !reviewing) {
      void queryClient.invalidateQueries({ queryKey: setupKeys.current });
    }
  }, [card.kind, reviewing, queryClient]);

  const busy = retry.isPending || onward.isPending || next.isPending;

  return (
    <div className="flex flex-col gap-6">
      <SetupStepHeader
        title="Acquiring the tool"
        description={`Graft's model is authoring a read-only tool for ${state.agent?.name ?? "the agent"}.`}
      />

      {job.isError ? (
        <p className="text-muted-foreground text-sm">
          <RetryNotice
            error={job.error}
            message="Could not read the job."
            onRetry={() => void job.refetch()}
            retrying={job.isFetching}
          />
        </p>
      ) : (
        <ProgressCardView card={card} pending={job.isPending} />
      )}

      <SetupFooter state={state} disabled={busy}>
        {card.kind === "failed" ? (
          <Button onClick={() => retry.mutate(undefined)} disabled={busy}>
            {retry.isPending ? "Going back…" : "Change the task"}
          </Button>
        ) : card.kind === "working" ? (
          <Button variant="outline" onClick={() => onward.mutate(undefined)} disabled={busy}>
            {onward.isPending ? "Continuing…" : "Continue while it runs"}
          </Button>
        ) : (
          <Button onClick={() => next.mutate({ from: "building" })} disabled={busy || !reviewing}>
            {next.isPending ? "Continuing…" : "Continue"}
          </Button>
        )}
      </SetupFooter>
    </div>
  );
}

/**
 * The card itself. Composed for Setup (ADR 0017's delta): the `Card` primitive at its `sm` size,
 * one row of a 16px status glyph (`Spinner`, `CheckCircleIcon`, `WarningIcon` in the destructive
 * token) beside the label in `CardTitle`'s weight, the message under it in `text-muted-foreground
 * text-sm` clamped to one line, the attempt count at the end of the row, and the *Details*
 * disclosure beneath, the setup disclosure over an `ol` of the job's lines and their teaching.
 * The row is `aria-live="polite"`, so the label and the message are read as they change.
 */
function ProgressCardView({ card, pending }: { card: ProgressCard; pending: boolean }) {
  return (
    <Card size="sm">
      <CardContent className="flex flex-col gap-3">
        <div className="flex items-start gap-3" aria-live="polite">
          <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center">
            {card.kind === "working" ? (
              <Spinner />
            ) : card.kind === "passed" ? (
              <CheckCircleIcon className="size-4" />
            ) : (
              <WarningIcon className="size-4 text-destructive" />
            )}
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <p className="font-medium text-sm">{card.label}</p>
            {pending ? (
              <p className="text-muted-foreground text-sm">Reading the job…</p>
            ) : card.message ? (
              <p
                className={
                  card.kind === "failed"
                    ? "text-muted-foreground text-sm"
                    : "truncate text-muted-foreground text-sm"
                }
                title={card.message}
              >
                {card.message}
              </p>
            ) : null}
          </div>
          {card.attempt ? (
            <span className="shrink-0 text-muted-foreground text-xs tabular-nums">
              Attempt {card.attempt}
            </span>
          ) : null}
        </div>
        {card.lines.length > 0 ? (
          <SetupDisclosure label="Details">
            <ol className="flex flex-col gap-3">
              {card.lines.map((entry, index) => (
                // The lines only ever grow at the end, so the position is the line's identity.
                <li key={index} className="flex flex-col gap-0.5">
                  <span className="text-sm">{entry.line}</span>
                  {entry.explanation ? (
                    <span className="text-muted-foreground text-xs">{entry.explanation}</span>
                  ) : null}
                </li>
              ))}
            </ol>
          </SetupDisclosure>
        ) : null}
      </CardContent>
    </Card>
  );
}
