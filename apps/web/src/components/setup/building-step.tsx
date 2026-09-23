import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import { CheckCircleIcon, WarningIcon } from "@/components/icons";
import { Loader } from "@/components/loader";
import { RetryNotice } from "@/components/retry-notice";
import { SetupStepHeader } from "@/components/setup/setup-step-header";
import { useSetupMutation } from "@/components/setup/use-setup-mutation";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { buildingView, explainProgress } from "@/lib/setup-progress";
import {
  acquireJobQuery,
  continueSetupBuild,
  retrySetupGoal,
  type SetupStateData,
  setupKeys,
} from "@/lib/setup-queries";

/** How often the step reads the job while it works. */
const JOB_POLL_MS = 2_000;

/**
 * The building step (GRA-207; GRA-202, *Building and result*): the acquire job Build started, read
 * through the agent's job route every two seconds while it works. Each progress line is the job's
 * own, and the first line of each stage carries one sentence saying what that stage is for
 * (`explainProgress`), so the wait teaches the loop once. *Continue while it builds* goes on to
 * the finish step with the job still running. On a pass the state is read again and the server
 * moves the record to the result; on a failure the job's own sentence is shown with *Change the
 * goal*, which goes back to the goal step, where Build starts a new job.
 */
export function BuildingStep({ state }: { state: SetupStateData }) {
  const agentId = state.agent?.id;
  const jobId = state.setup?.acquireJobId;
  if (!agentId || !jobId) return <Loader />;
  return (
    <BuildingJob agentId={agentId} jobId={jobId} agentName={state.agent?.name ?? "the agent"} />
  );
}

function BuildingJob({
  agentId,
  jobId,
  agentName,
}: {
  agentId: string;
  jobId: string;
  agentName: string;
}) {
  const queryClient = useQueryClient();
  const job = useQuery({
    ...acquireJobQuery(agentId, jobId),
    refetchInterval: (query) =>
      buildingView(query.state.data).kind === "working" ? JOB_POLL_MS : false,
  });
  const view = buildingView(job.data);
  const retry = useSetupMutation(retrySetupGoal);
  const onward = useSetupMutation(continueSetupBuild);

  // The pass is the server's to record: the next state read names the tool and moves to the result.
  useEffect(() => {
    if (view.kind === "passed") {
      void queryClient.invalidateQueries({ queryKey: setupKeys.current });
    }
  }, [view.kind, queryClient]);

  const lines = explainProgress(job.data?.progress ?? []);
  const attempts = job.data?.attempts ?? 0;

  return (
    <div className="flex flex-col gap-6">
      <SetupStepHeader
        title="Building the tool"
        description={`Graft's model is building a read-only tool for ${agentName}. These are the job's own lines, with what each stage is for.`}
      />

      {view.kind === "failed" ? (
        <Alert variant="destructive">
          <WarningIcon />
          <AlertTitle>The build did not pass</AlertTitle>
          <AlertDescription>{view.message}</AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            {view.kind === "working" ? (
              <Spinner className="size-4" />
            ) : view.kind === "passed" ? (
              <CheckCircleIcon className="size-4" />
            ) : null}
            {view.kind === "working"
              ? "Working"
              : view.kind === "passed"
                ? "The tool passed"
                : "Stopped"}
          </CardTitle>
          <CardDescription>
            {attempts === 0
              ? "No draft yet."
              : `${attempts} ${attempts === 1 ? "draft" : "drafts"} so far.`}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {job.isPending ? (
            <Loader />
          ) : job.isError ? (
            <p className="text-muted-foreground text-sm">
              <RetryNotice
                error={job.error}
                message="Could not read the build."
                onRetry={() => void job.refetch()}
                retrying={job.isFetching}
              />
            </p>
          ) : (
            <ol className="flex flex-col gap-3" aria-live="polite">
              {lines.map((entry, index) => (
                // The lines only ever grow at the end, so the position is the line's identity.
                <li key={index} className="flex flex-col gap-0.5">
                  <span className="text-sm">{entry.line}</span>
                  {entry.explanation ? (
                    <span className="text-muted-foreground text-xs">{entry.explanation}</span>
                  ) : null}
                </li>
              ))}
            </ol>
          )}
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-center justify-end gap-2">
        {view.kind === "failed" ? (
          <Button onClick={() => retry.mutate(undefined)} disabled={retry.isPending}>
            {retry.isPending ? "Going back…" : "Change the goal"}
          </Button>
        ) : view.kind === "working" ? (
          <Button
            variant="outline"
            onClick={() => onward.mutate(undefined)}
            disabled={onward.isPending}
          >
            {onward.isPending ? "Continuing…" : "Continue while it builds"}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
