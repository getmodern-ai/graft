import { starterTasks, starterVendorOf } from "@graft/core/setup/starter-vendors";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { WarningIcon } from "@/components/icons";
import { RetryNotice } from "@/components/retry-notice";
import { DiscardJobDialog } from "@/components/setup/discard-job-dialog";
import { SetupFooter } from "@/components/setup/setup-footer";
import { SetupLogo } from "@/components/setup/setup-logo";
import { SetupStepHeader } from "@/components/setup/setup-step-header";
import { TaskPicker } from "@/components/setup/task-picker";
import { useSetupMutation } from "@/components/setup/use-setup-mutation";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  buildSetup,
  nextSetup,
  type SetupGoal,
  type SetupStateData,
  setupGoalDraftKey,
  setupGoalQuery,
  setupGoalSuggestionsQuery,
} from "@/lib/setup-queries";
import { jobRunning } from "@/lib/setup-vendors";

/**
 * The goal step (GRA-207; GRA-202, *The goal step* and *Build is the build approval*): what the
 * first tool should read, pre-filled with the starter's curated read-only goal and editable, or
 * empty for another integration. Above the field sits the suggestions row (GRA-209). **Build** is the
 * build approval for this agent and connection, pressed here rather than asked in the inbox, and
 * starts the job (`POST /api/setup/build`); the record moves to the building step.
 *
 * Where no model can author, the step says what the operator sets, in the server's words, and
 * Build is disabled: the same check `acquire` refuses `acquire_unconfigured` on.
 */
export function GoalStep({ state }: { state: SetupStateData }) {
  const goal = useQuery(setupGoalQuery);
  const name = goal.data?.connection?.displayName ?? "the integration";
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-8">
      <SetupStepHeader
        media={
          goal.data?.starterId ? (
            <SetupLogo starterId={goal.data.starterId} tile={false} className="size-9" />
          ) : null
        }
        title={`What should your first tool do in ${name}?`}
        description="Pick one read-only tool to build. It is connected already, so the build starts now."
      />
      {goal.isPending ? (
        <div className="flex flex-col gap-4" aria-busy="true">
          <Skeleton className="h-16 rounded-md" />
          <Skeleton className="h-24 rounded-md" />
        </div>
      ) : goal.isError ? (
        <p className="text-muted-foreground text-sm">
          <RetryNotice
            error={goal.error}
            message="Could not load the task."
            onRetry={() => void goal.refetch()}
            retrying={goal.isFetching}
          />
        </p>
      ) : (
        <GoalForm state={state} context={goal.data} />
      )}
    </div>
  );
}

function GoalForm({ state, context }: { state: SetupStateData; context: SetupGoal }) {
  const queryClient = useQueryClient();
  // Returned to with a job still held (GRA-215), the field shows the task that job was started
  // with; otherwise the task the person last pressed Build with, so *Change the task* comes back
  // to their words, or the curated one.
  const held = context.job;
  const draftKey = setupGoalDraftKey(context.connection?.id ?? null);
  const [text, setText] = useState(
    () =>
      held?.goal ?? state.setup?.goal ?? queryClient.getQueryData<string>(draftKey) ?? context.goal,
  );
  const [confirming, setConfirming] = useState(false);
  const build = useSetupMutation(buildSetup);
  const next = useSetupMutation(nextSetup);
  const trimmed = text.trim();
  const available = context.build.available;
  // A starter's own tasks; for another integration, the model's suggestions (GRA-209), if any.
  const starter = context.starterId ? starterVendorOf(context.starterId) : null;
  const suggestions = useQuery({
    ...setupGoalSuggestionsQuery(context.connection?.id ?? ""),
    enabled: !starter && context.connection !== null && available,
  });
  const tasks = starter
    ? starterTasks(starter).map((task) => task.goal)
    : (suggestions.data?.suggestions ?? []);
  // The held job's own task, unchanged: Continue returns to it rather than building again.
  const returning = held !== null && trimmed === held.goal;
  const busy = build.isPending || next.isPending;
  const start = (discardJob: boolean) => {
    queryClient.setQueryData(draftKey, trimmed);
    build.mutate(
      { goal: trimmed, ...(discardJob ? { discardJob: true } : {}) },
      { onSettled: () => setConfirming(false) },
    );
  };

  return (
    <>
      <form
        className="flex flex-col gap-6"
        onSubmit={(event) => {
          event.preventDefault();
          if (returning) {
            next.mutate({ from: "goal" });
            return;
          }
          if (!available || !trimmed) return;
          if (held && jobRunning(held.status)) setConfirming(true);
          else start(false);
        }}
      >
        {context.build.available ? null : (
          <Alert variant="destructive">
            <WarningIcon />
            <AlertTitle>Building a tool needs a model</AlertTitle>
            <AlertDescription>{context.build.message}</AlertDescription>
          </Alert>
        )}

        <TaskPicker
          tasks={tasks}
          value={text}
          onChange={setText}
          integrationName={context.connection?.displayName ?? "the integration"}
          disabled={busy}
        />

        <SetupFooter state={state} disabled={busy}>
          {returning ? (
            <Button type="submit" disabled={busy}>
              {next.isPending ? "Continuing…" : "Continue"}
            </Button>
          ) : (
            <Button type="submit" disabled={!available || !trimmed || busy}>
              {build.isPending ? "Starting the job…" : "Build this tool"}
            </Button>
          )}
        </SetupFooter>
      </form>
      <DiscardJobDialog
        open={confirming}
        onOpenChange={setConfirming}
        onConfirm={() => start(true)}
        pending={build.isPending}
        action={{ label: "Build again", pending: "Starting the job…" }}
        consequence="Building with this task starts a new job."
      />
    </>
  );
}
