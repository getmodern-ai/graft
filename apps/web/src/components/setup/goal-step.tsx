import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { WarningIcon } from "@/components/icons";
import { RetryNotice } from "@/components/retry-notice";
import { GoalSuggestions } from "@/components/setup/goal-suggestions";
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
  type SetupGoal,
  type SetupStateData,
  setupGoalDraftKey,
  setupGoalQuery,
} from "@/lib/setup-queries";

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
        description="Say what the first tool should read. Graft's model builds it against the connection, and nothing is written at the vendor."
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
        <GoalForm context={goal.data} agentName={state.agent?.name ?? "your agent"} />
      )}
    </div>
  );
}

function GoalForm({ context, agentName }: { context: SetupGoal; agentName: string }) {
  const queryClient = useQueryClient();
  // What the person last built with, so *Change the goal* comes back to their words.
  const [text, setText] = useState(
    () => queryClient.getQueryData<string>(setupGoalDraftKey) ?? context.goal,
  );
  const build = useSetupMutation(buildSetup);
  const trimmed = text.trim();
  const available = context.build.available;

  return (
    <form
      className="flex flex-col gap-6"
      onSubmit={(event) => {
        event.preventDefault();
        if (!available || !trimmed) return;
        queryClient.setQueryData(setupGoalDraftKey, trimmed);
        build.mutate({ goal: trimmed });
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
          <AlertTitle>Building a tool needs a model</AlertTitle>
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
          disabled={build.isPending}
          onChange={(event) => setText(event.target.value)}
        />
        <FieldDescription>
          A sentence or two on what to read. Pressing Build allows {agentName} to build against this
          connection, so no approval is asked for it later.
        </FieldDescription>
      </Field>

      <div className="flex justify-end">
        <Button type="submit" disabled={!available || !trimmed || build.isPending}>
          {build.isPending ? "Starting the build…" : "Build"}
        </Button>
      </div>
    </form>
  );
}
