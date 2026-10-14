import { starterTasks, starterVendorOf } from "@graft/core/setup/starter-vendors";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { WarningIcon } from "@/components/icons";
import { IntegrationMark } from "@/components/marks";
import { RetryNotice } from "@/components/retry-notice";
import { DiscardJobDialog } from "@/components/setup/discard-job-dialog";
import { ReadyMadePicker } from "@/components/setup/ready-made-picker";
import { SetupFooter } from "@/components/setup/setup-footer";
import { SetupStepHeader } from "@/components/setup/setup-step-header";
import { TaskPicker } from "@/components/setup/task-picker";
import { useSetupMutation } from "@/components/setup/use-setup-mutation";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  buildSetup,
  chooseSetupStock,
  nextSetup,
  type SetupGoal,
  type SetupReadyMadeTool,
  type SetupStateData,
  setupGoalDraftKey,
  setupGoalQuery,
  setupGoalSuggestionsQuery,
  setupReadyMadeQuery,
} from "@/lib/setup-queries";
import {
  choiceSummary,
  initialToolChoice,
  type ToolChoice,
  tasksBesideReadyMade,
  toolStepDescription,
} from "@/lib/setup-ready-made";
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
 *
 * A starter's **ready-made tools** come first (GRA-276; `ReadyMadePicker`): *Use this tool* takes
 * one at once (`POST /api/setup/stock`), copied into the toolbox, and the record moves straight to
 * the result. It needs no model, so it stays available where Build is not.
 */
export function GoalStep({ state }: { state: SetupStateData }) {
  const goal = useQuery(setupGoalQuery);
  const starterId = goal.data?.starterId ?? null;
  const readyMade = useQuery({
    ...setupReadyMadeQuery(starterId ?? ""),
    enabled: starterId !== null,
  });
  const name = goal.data?.connection?.displayName ?? "the integration";
  const offered = readyMade.data?.tools ?? [];
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-8">
      <SetupStepHeader
        media={
          goal.data?.starterId ? (
            <IntegrationMark slug={goal.data.starterId} tile="none" className="size-9" />
          ) : null
        }
        title={`What should your first tool do in ${name}?`}
        description={toolStepDescription({ readyMade: offered.length > 0, connected: true })}
      />
      {goal.isPending || (starterId !== null && readyMade.isPending) ? (
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
        <GoalForm state={state} context={goal.data} readyMade={offered} />
      )}
    </div>
  );
}

function GoalForm({
  state,
  context,
  readyMade,
}: {
  state: SetupStateData;
  context: SetupGoal;
  readyMade: readonly SetupReadyMadeTool[];
}) {
  const queryClient = useQueryClient();
  // Returned to with a job still held (GRA-215), the field shows the task that job was started
  // with; otherwise the task the person last pressed Build with, so *Change the task* comes back
  // to their words, or the curated one.
  const held = context.job;
  const draftKey = setupGoalDraftKey(context.connection?.id ?? null);
  const [choice, setChoice] = useState<ToolChoice>(() =>
    held
      ? { kind: "task", text: held.goal }
      : initialToolChoice(
          state.setup,
          readyMade,
          queryClient.getQueryData<string>(draftKey) ?? context.goal,
        ),
  );
  const [confirming, setConfirming] = useState(false);
  const build = useSetupMutation(buildSetup);
  const take = useSetupMutation(chooseSetupStock);
  const next = useSetupMutation(nextSetup);
  const ready = choice.kind === "ready";
  const text = choice.kind === "task" ? choice.text : "";
  const trimmed = choiceSummary(choice, readyMade);
  const available = context.build.available;
  // A starter's own tasks; for another integration, the model's suggestions (GRA-209), if any.
  const starter = context.starterId ? starterVendorOf(context.starterId) : null;
  const suggestions = useQuery({
    ...setupGoalSuggestionsQuery(context.connection?.id ?? ""),
    enabled: !starter && context.connection !== null && available,
  });
  const tasks = tasksBesideReadyMade(
    starter
      ? starterTasks(starter).map((task) => task.goal)
      : (suggestions.data?.suggestions ?? []),
    readyMade,
  );
  // The held job's own task, unchanged: Continue returns to it rather than building again.
  const returning = !ready && held !== null && trimmed === held.goal;
  const busy = build.isPending || take.isPending || next.isPending;
  const start = (discardJob: boolean) => {
    const settled = { onSettled: () => setConfirming(false) };
    const flag = discardJob ? { discardJob: true } : {};
    if (choice.kind === "ready") {
      take.mutate({ tool: choice.tool, ...flag }, settled);
      return;
    }
    queryClient.setQueryData(draftKey, trimmed);
    build.mutate({ goal: trimmed, ...flag }, settled);
  };
  // A ready-made tool needs no model; a task to build does.
  const canStart = trimmed !== "" && (ready || available) && !busy;

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
          if (!canStart) return;
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

        {readyMade.length > 0 ? (
          <ReadyMadePicker
            tools={readyMade}
            value={ready ? choice.tool : null}
            onChange={(tool) => setChoice({ kind: "ready", tool })}
            integrationName={context.connection?.displayName ?? "the integration"}
            disabled={busy}
          />
        ) : null}
        <TaskPicker
          tasks={tasks}
          value={text}
          onChange={(typed) => setChoice({ kind: "task", text: typed })}
          integrationName={context.connection?.displayName ?? "the integration"}
          disabled={busy}
          heading={readyMade.length > 0 ? "Or have Graft build one" : undefined}
          emptyNote={readyMade.length === 0}
        />

        <SetupFooter state={state} disabled={busy}>
          {returning ? (
            <Button type="submit" disabled={busy}>
              {next.isPending ? "Continuing…" : "Continue"}
            </Button>
          ) : (
            <Button type="submit" disabled={!canStart}>
              {ready
                ? take.isPending
                  ? "Adding…"
                  : "Use this tool"
                : build.isPending
                  ? "Starting the job…"
                  : "Build this tool"}
            </Button>
          )}
        </SetupFooter>
      </form>
      <DiscardJobDialog
        open={confirming}
        onOpenChange={setConfirming}
        onConfirm={() => start(true)}
        pending={build.isPending || take.isPending}
        action={
          ready
            ? { label: "Use this one instead", pending: "Adding…" }
            : { label: "Build again", pending: "Starting the job…" }
        }
        consequence={
          ready
            ? "Using this tool leaves the one still being built behind."
            : "Building with this task starts a new job."
        }
      />
    </>
  );
}
