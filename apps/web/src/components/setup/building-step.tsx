import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import { CodeBlock } from "@/components/code-block";
import { CheckCircleIcon, ErrorIcon, ScheduleIcon } from "@/components/icons";
import { Loader } from "@/components/loader";
import { RetryNotice } from "@/components/retry-notice";
import { SetupAppCard, SetupTaskRow } from "@/components/setup/setup-app-card";
import { SetupDisclosure } from "@/components/setup/setup-disclosure";
import { SetupFooter } from "@/components/setup/setup-footer";
import { SetupLogo } from "@/components/setup/setup-logo";
import { SetupStepHeader } from "@/components/setup/setup-step-header";
import { useSetupMutation } from "@/components/setup/use-setup-mutation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
  jobPollInterval,
  type ProgressCard,
  progressCard,
  progressPart,
  SETUP_BUILD_PARTS,
} from "@/lib/setup-progress";
import {
  acquireJobQuery,
  cachedDirectoryLogo,
  chooseSetupTask,
  continueSetupBuild,
  nextSetup,
  retrySetupGoal,
  type SetupStateData,
  setupGoalQuery,
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

  // Retry: back to the task with the job cleared, then the same task again, which builds at once.
  const again = useSetupMutation(async (goal: string) => {
    await retrySetupGoal();
    return chooseSetupTask({ goal });
  });
  const goal = useQuery(setupGoalQuery);
  const connection = goal.data?.connection ?? null;
  const name = connection?.displayName ?? "The integration";
  const task = state.setup?.goal ?? null;

  const busy = retry.isPending || onward.isPending || next.isPending || again.isPending;
  const failed = card.kind === "failed";
  const part = progressPart(card);

  return (
    <div className="mx-auto flex w-full max-w-[880px] flex-col gap-6">
      <SetupStepHeader
        title={failed ? "Your tool needs another try" : "Building your tool"}
        description={
          failed
            ? "It did not pass its run, so nothing was added yet."
            : `${name} is connected. Graft's model is writing, checking and trying the tool against the real service.`
        }
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
        <SetupAppCard
          media={
            <SetupLogo
              starterId={goal.data?.starterId}
              url={connection ? cachedDirectoryLogo(queryClient, connection.vendor) : null}
              tile={false}
              className="size-8"
            />
          }
          name={connection?.displayName ?? "Your integration"}
          chip={<Badge variant="success">Connected</Badge>}
          subline="Connected · read-only"
          action={<CheckCircleIcon className="size-6 text-success" />}
        >
          <SetupTaskRow
            icon={
              card.kind === "working" ? (
                <Spinner className="size-5 text-primary" />
              ) : card.kind === "passed" ? (
                <CheckCircleIcon className="size-5 text-success" />
              ) : (
                <ErrorIcon className="size-5 text-destructive" />
              )
            }
            task={task ?? "Your first tool"}
            note={
              job.isPending
                ? "Reading the job…"
                : card.kind === "working"
                  ? part > 0
                    ? `${card.label} · ${part} of ${SETUP_BUILD_PARTS}`
                    : card.label
                  : card.label
            }
            progress={card.kind === "working" ? part / SETUP_BUILD_PARTS : null}
          />
          {failed && card.message ? (
            <div className="flex flex-col gap-3">
              <p className="flex items-center gap-2 text-destructive text-sm">
                <ErrorIcon className="size-4 shrink-0" />
                {card.message}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => retry.mutate(undefined)}
                  disabled={busy}
                >
                  {retry.isPending ? "Going back…" : "Change the tool"}
                </Button>
              </div>
            </div>
          ) : card.kind === "working" && card.message ? (
            <p className="truncate text-muted-foreground text-xs" title={card.message}>
              {card.attempt ? `Attempt ${card.attempt} · ` : ""}
              {card.message}
            </p>
          ) : null}
          <BuildDetails card={card} />
        </SetupAppCard>
      )}

      <SetupFooter
        state={state}
        disabled={busy}
        summary={
          failed ? (
            <>
              <ErrorIcon className="size-4 shrink-0 text-destructive" />
              Nothing added yet
            </>
          ) : card.kind === "working" ? (
            <>
              <ScheduleIcon className="size-4 shrink-0" />
              Usually one to three minutes. You can leave; Graft keeps building.
            </>
          ) : null
        }
      >
        {failed ? (
          <>
            <Button variant="outline" onClick={() => onward.mutate(undefined)} disabled={busy}>
              {onward.isPending ? "Finishing…" : "Finish without a tool"}
            </Button>
            {task ? (
              <Button onClick={() => again.mutate(task)} disabled={busy}>
                {again.isPending ? "Starting…" : "Retry"}
              </Button>
            ) : null}
          </>
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

/** The job's own lines, with what each stage is for, behind *Details*; the failure's raw text first. */
function BuildDetails({ card }: { card: ProgressCard }) {
  if (card.lines.length === 0 && !card.failureDetails) return null;
  return (
    <SetupDisclosure label="Details">
      {card.failureDetails ? (
        <CodeBlock
          label="What the job reported"
          code={card.failureDetails}
          copyLabel="Copy details"
          wrap
        />
      ) : null}
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
  );
}
