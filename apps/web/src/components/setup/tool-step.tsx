import { setupHarnessOf } from "@graft/core/setup/harness";
import { starterTasks, starterVendorOf } from "@graft/core/setup/starter-vendors";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { CloseIcon, StarsIcon, WarningIcon } from "@/components/icons";
import { IntegrationMark } from "@/components/marks";
import { DiscardJobDialog } from "@/components/setup/discard-job-dialog";
import { ReadyMadePicker } from "@/components/setup/ready-made-picker";
import { SetupFooter } from "@/components/setup/setup-footer";
import { SetupStepHeader } from "@/components/setup/setup-step-header";
import { TaskPicker } from "@/components/setup/task-picker";
import { useSetupMutation } from "@/components/setup/use-setup-mutation";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useIsMobile } from "@/hooks/use-mobile";
import { ApiError } from "@/lib/api";
import {
  chooseSetupStarter,
  chooseSetupStock,
  chooseSetupTask,
  type DirectoryEntry,
  type SetupReadyMadeTool,
  type SetupStateData,
  setupGoalQuery,
  setupReadyMadeQuery,
} from "@/lib/setup-queries";
import {
  choiceSummary,
  initialToolChoice,
  type ToolChoice,
  tasksBesideReadyMade,
  toolStepDescription,
} from "@/lib/setup-ready-made";

/**
 * Setup v2's tool screen for a starter (the frames' *3 Tools*): what the person's harness should be
 * able to do in the integration, picked before anything is connected. The integration's
 * **ready-made tools** come first (GRA-276; `ReadyMadePicker`, from `GET /api/setup/stock`), then
 * the starter's tasks to build (`starterTasks`, less any a ready-made tool already does), with a row
 * to describe one's own: one choice across all three. *Use this tool* saves the ready-made tool and
 * connects the starter (`POST /api/setup/stock`), and the tool is copied in the moment the
 * connection lands; *Build this tool* saves the task (`POST /api/setup/task`), and the build starts
 * then. Back clears the starter, which is the integration screen.
 *
 * Where no model can author, the screen says what the operator sets, in the server's words, and
 * *Build this tool* is disabled: the same check `acquire` refuses `acquire_unconfigured` on. A
 * ready-made tool needs no model, so it stays available.
 */
export function ToolStep({
  state,
  starterId,
  app,
  onBack,
}: {
  state: SetupStateData;
  /** A starter the record names: its curated tasks, and Back clears it. */
  starterId?: string;
  /** Another directory integration the page holds: no curated tasks, and Back is `onBack`. */
  app?: DirectoryEntry;
  onBack?: () => void;
}) {
  const readyMade = useQuery({
    ...setupReadyMadeQuery(starterId ?? ""),
    enabled: Boolean(starterId),
  });
  // The step's choice starts from the list, so it waits for it; a failed read offers none.
  if (starterId && readyMade.isPending) {
    return (
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-8" aria-busy="true">
        <Skeleton className="h-16 rounded-md" />
        <Skeleton className="h-24 rounded-md" />
      </div>
    );
  }
  return (
    <ToolChoiceForm
      state={state}
      starterId={starterId}
      app={app}
      onBack={onBack}
      readyMade={readyMade.data?.tools ?? []}
    />
  );
}

function ToolChoiceForm({
  state,
  starterId,
  app,
  onBack,
  readyMade,
}: {
  state: SetupStateData;
  starterId?: string;
  app?: DirectoryEntry;
  onBack?: () => void;
  readyMade: readonly SetupReadyMadeTool[];
}) {
  const starter = starterId ? starterVendorOf(starterId) : null;
  const tasks = tasksBesideReadyMade(
    starter ? starterTasks(starter).map((task) => task.goal) : [],
    readyMade,
  );
  const [choice, setChoice] = useState<ToolChoice>(() =>
    initialToolChoice(state.setup, readyMade, ""),
  );
  const goal = useQuery(setupGoalQuery);
  const choose = useSetupMutation(chooseSetupTask);
  const take = useSetupMutation(chooseSetupStock);
  // A build the record still holds while it runs (GRA-215): the server refuses `job_running`, and
  // the person is asked before it is left behind (Greptile on #201).
  const [confirming, setConfirming] = useState(false);
  const isMobile = useIsMobile();
  const settle = {
    onError: (error: unknown) => {
      if (jobRunningRefusal(error)) setConfirming(true);
    },
    onSettled: (_answer: unknown, error: unknown) => {
      if (!error) setConfirming(false);
    },
  };
  const submit = (discardJob: boolean, picked: ToolChoice = choice) => {
    if (picked.kind === "ready") {
      take.mutate({ tool: picked.tool, ...(discardJob ? { discardJob: true } : {}) }, settle);
      return;
    }
    choose.mutate(
      {
        goal: picked.text.trim(),
        ...(app ? { slug: app.slug } : {}),
        ...(discardJob ? { discardJob: true } : {}),
      },
      settle,
    );
  };
  const back = useSetupMutation(chooseSetupStarter);
  const name = starter?.displayName ?? app?.name ?? "the integration";
  const logo = (className: string) => (
    <IntegrationMark
      slug={starterId ?? app?.slug}
      name={starter?.displayName ?? app?.name}
      logoUrl={app?.logoUrl}
      tile="none"
      className={className}
    />
  );
  const harness = state.setup?.harness ? setupHarnessOf(state.setup.harness).label : null;
  const who = harness ?? state.agent?.name ?? "your agent";
  const available = goal.data?.build.available ?? true;
  const summary = choiceSummary(choice, readyMade);
  const ready = choice.kind === "ready";
  const busy = choose.isPending || take.isPending || back.isPending;
  const custom = choice.kind === "task" && summary !== "" && !tasks.includes(summary);
  // A ready-made tool needs no model; a task to build does.
  const canSubmit = summary !== "" && (ready || available) && !busy;
  const task = choice.kind === "task" ? choice.text : "";

  return (
    <>
      <form
        className="mx-auto flex w-full max-w-4xl flex-col gap-8"
        onSubmit={(event) => {
          event.preventDefault();
          if (canSubmit) submit(false);
        }}
      >
        <SetupStepHeader
          media={logo("size-9")}
          title={`What should ${who} be able to do in ${name}?`}
          description={
            tasks.length > 0 || readyMade.length > 0
              ? toolStepDescription({ readyMade: readyMade.length > 0, connected: false })
              : "Say what it should read. Graft builds one read-only tool for it; you can add more from the console after."
          }
        />
        {goal.data && !goal.data.build.available ? (
          <Alert variant="destructive">
            <WarningIcon />
            <AlertTitle>Building a tool needs a model</AlertTitle>
            <AlertDescription>{goal.data.build.message}</AlertDescription>
          </Alert>
        ) : null}
        {readyMade.length > 0 ? (
          <ReadyMadePicker
            tools={readyMade}
            value={ready ? choice.tool : null}
            onChange={(tool) => setChoice({ kind: "ready", tool })}
            integrationName={name}
            disabled={busy}
            // A tapped ready-made tool is taken at once on a phone, as a tapped task is built.
            onPickCard={isMobile ? (tool) => submit(false, { kind: "ready", tool }) : undefined}
          />
        ) : null}
        <TaskPicker
          tasks={tasks}
          value={task}
          onChange={(text) => setChoice({ kind: "task", text })}
          integrationName={name}
          disabled={busy}
          heading={readyMade.length > 0 ? "Or have Graft build one" : undefined}
          emptyNote={readyMade.length === 0}
          // A tapped task builds at once on a phone (GRA-267), where a model can build it.
          onPickCard={
            isMobile && available
              ? (picked) => submit(false, { kind: "task", text: picked })
              : undefined
          }
        />
        <SetupFooter
          state={state}
          disabled={busy}
          onBack={
            onBack
              ? { run: onBack, pending: false }
              : { run: () => back.mutate({ starterId: null }), pending: back.isPending }
          }
          summary={
            summary ? (
              <>
                <span className="hidden sm:inline">Your first tool</span>
                <span className="flex min-w-0 items-center gap-2 rounded-full border bg-background py-1 pr-1.5 pl-2 text-foreground">
                  {logo("size-4")}
                  <span className="truncate">{summary}</span>
                  {ready || custom ? (
                    <span className="rounded-full bg-muted px-1.5 text-muted-foreground text-xs">
                      {ready ? "Ready-made" : "Custom"}
                    </span>
                  ) : null}
                  <button
                    type="button"
                    aria-label="Clear the choice"
                    className="rounded-full p-0.5 hover:bg-muted"
                    onClick={() => setChoice({ kind: "task", text: "" })}
                  >
                    <CloseIcon className="size-3.5" />
                  </button>
                </span>
              </>
            ) : (
              <>
                <StarsIcon className="size-4 shrink-0" />
                Pick one tool or describe one to continue
              </>
            )
          }
        >
          <Button type="submit" disabled={!canSubmit}>
            {ready
              ? take.isPending
                ? "Adding…"
                : "Use this tool"
              : choose.isPending
                ? "Starting…"
                : "Build this tool"}
          </Button>
        </SetupFooter>
      </form>
      <DiscardJobDialog
        open={confirming}
        onOpenChange={setConfirming}
        onConfirm={() => submit(true)}
        pending={choose.isPending || take.isPending}
        action={
          ready
            ? { label: "Use this one instead", pending: "Adding…" }
            : { label: "Build this one instead", pending: "Starting…" }
        }
        consequence={
          ready
            ? "Using this tool leaves the one still being built behind."
            : "Building this tool leaves the one still being built behind."
        }
      />
    </>
  );
}

function jobRunningRefusal(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.details as { reason?: unknown } | undefined)?.reason === "job_running"
  );
}
