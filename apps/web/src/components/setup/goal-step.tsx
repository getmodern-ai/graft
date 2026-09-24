import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { WarningIcon } from "@/components/icons";
import { RetryNotice } from "@/components/retry-notice";
import { DiscardJobDialog } from "@/components/setup/discard-job-dialog";
import { GoalSuggestions } from "@/components/setup/goal-suggestions";
import { SetupFooter } from "@/components/setup/setup-footer";
import { SetupStepHeader } from "@/components/setup/setup-step-header";
import { useSetupMutation } from "@/components/setup/use-setup-mutation";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Item, ItemContent, ItemDescription, ItemTitle } from "@/components/ui/item";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  buildSetup,
  nextSetup,
  type SetupGoal,
  type SetupStateData,
  setupGoalDraftKey,
  setupGoalQuery,
} from "@/lib/setup-queries";
import { jobRunning } from "@/lib/setup-vendors";

/**
 * The goal step (GRA-207; GRA-202, *The goal step* and *Build is the build approval*): what the
 * first tool should read, pre-filled with the starter's curated read-only goal and editable, or
 * empty for another vendor. Above the field sits the suggestions row (GRA-209). **Build** is the
 * build approval for this agent and connection, pressed here rather than asked in the inbox, and
 * starts the job (`POST /api/setup/build`); the record moves to the building step.
 *
 * Where no model can author, the step says what the operator sets, in the server's words, and
 * Build is disabled: the same check `acquire` refuses `acquire_unconfigured` on.
 */
export function GoalStep({ state }: { state: SetupStateData }) {
  const goal = useQuery(setupGoalQuery);
  return (
    <div className="flex flex-col gap-6">
      <SetupStepHeader
        title="Choose a goal"
        description="Say what the first tool should read. Graft's model authors it against the connection, and nothing is written at the vendor."
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
            message="Could not load the goal."
            onRetry={() => void goal.refetch()}
            retrying={goal.isFetching}
          />
        </p>
      ) : (
        <GoalForm state={state} context={goal.data} agentName={state.agent?.name ?? "your agent"} />
      )}
    </div>
  );
}

function GoalForm({
  state,
  context,
  agentName,
}: {
  state: SetupStateData;
  context: SetupGoal;
  agentName: string;
}) {
  const queryClient = useQueryClient();
  // Returned to with a job still held (GRA-215), the field shows the task that job was started
  // with; otherwise the task the person last pressed Build with, so *Change the task* comes back
  // to their words, or the curated one.
  const held = context.job;
  const [text, setText] = useState(
    () => held?.goal ?? queryClient.getQueryData<string>(setupGoalDraftKey) ?? context.goal,
  );
  const [confirming, setConfirming] = useState(false);
  const build = useSetupMutation(buildSetup);
  const next = useSetupMutation(nextSetup);
  const trimmed = text.trim();
  const available = context.build.available;
  // The held job's own task, unchanged: Continue returns to it rather than building again.
  const returning = held !== null && trimmed === held.goal;
  const busy = build.isPending || next.isPending;
  const start = (discardJob: boolean) => {
    queryClient.setQueryData(setupGoalDraftKey, trimmed);
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
        {context.connection ? (
          <Item variant="outline">
            <ItemContent>
              <ItemTitle>
                {context.connection.displayName}
                <Badge variant="outline">{context.connection.vendor}</Badge>
              </ItemTitle>
              <ItemDescription>Connected, and in {agentName}'s scope.</ItemDescription>
            </ItemContent>
          </Item>
        ) : null}

        {context.build.available ? null : (
          <Alert variant="destructive">
            <WarningIcon />
            <AlertTitle>Acquiring a tool needs a model</AlertTitle>
            <AlertDescription>{context.build.message}</AlertDescription>
          </Alert>
        )}

        <GoalSuggestions onPick={setText} />

        <Field>
          <FieldLabel htmlFor="setup-goal">Goal</FieldLabel>
          <Textarea
            id="setup-goal"
            value={text}
            rows={4}
            placeholder="Describe one read the tool should make"
            disabled={busy}
            onChange={(event) => setText(event.target.value)}
          />
          <FieldDescription>
            A sentence or two on what to read. Pressing Build gives {agentName} the build approval
            for this connection, so it is not asked for later.
          </FieldDescription>
        </Field>

        <SetupFooter state={state} disabled={busy}>
          {returning ? (
            <Button type="submit" disabled={busy}>
              {next.isPending ? "Continuing…" : "Continue"}
            </Button>
          ) : (
            <Button type="submit" disabled={!available || !trimmed || busy}>
              {build.isPending ? "Starting the job…" : "Build"}
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
