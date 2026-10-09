import { setupHarnessOf } from "@graft/core/setup/harness";
import { starterTasks, starterVendorOf } from "@graft/core/setup/starter-vendors";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { CloseIcon, StarsIcon, WarningIcon } from "@/components/icons";
import { SetupFooter } from "@/components/setup/setup-footer";
import { SetupLogo } from "@/components/setup/setup-logo";
import { SetupStepHeader } from "@/components/setup/setup-step-header";
import { TaskPicker } from "@/components/setup/task-picker";
import { useSetupMutation } from "@/components/setup/use-setup-mutation";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  chooseSetupStarter,
  chooseSetupTask,
  type DirectoryEntry,
  type SetupStateData,
  setupGoalQuery,
} from "@/lib/setup-queries";

/**
 * Setup v2's tool screen for a starter (the frames' *3 Tools*): what the person's harness should be
 * able to do in the integration, picked before anything is connected. The starter's tasks are the
 * cards (`starterTasks`: its curated task first, each a read that needs nothing looked up), with a
 * row to describe one's own. *Build this tool* saves the task and connects the starter
 * (`POST /api/setup/task`); the build starts the moment the connection lands. Back clears the
 * starter, which is the integration screen.
 *
 * Where no model can author, the screen says what the operator sets, in the server's words, and the
 * button is disabled: the same check `acquire` refuses `acquire_unconfigured` on.
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
  const starter = starterId ? starterVendorOf(starterId) : null;
  const tasks = starter ? starterTasks(starter).map((task) => task.goal) : [];
  const [task, setTask] = useState(state.setup?.goal ?? "");
  const goal = useQuery(setupGoalQuery);
  const choose = useSetupMutation(chooseSetupTask);
  const back = useSetupMutation(chooseSetupStarter);
  const name = starter?.displayName ?? app?.name ?? "the integration";
  const logo = (className: string) => (
    <SetupLogo starterId={starterId} url={app?.logoUrl} tile={false} className={className} />
  );
  const harness = state.setup?.harness ? setupHarnessOf(state.setup.harness).label : null;
  const who = harness ?? state.agent?.name ?? "your agent";
  const available = goal.data?.build.available ?? true;
  const trimmed = task.trim();
  const busy = choose.isPending || back.isPending;
  const custom = trimmed !== "" && !tasks.includes(trimmed);

  return (
    <form
      className="mx-auto flex w-full max-w-4xl flex-col gap-8"
      onSubmit={(event) => {
        event.preventDefault();
        if (trimmed && available) {
          choose.mutate({ goal: trimmed, ...(app ? { slug: app.slug } : {}) });
        }
      }}
    >
      <SetupStepHeader
        media={logo("size-9")}
        title={`What should ${who} be able to do in ${name}?`}
        description={
          tasks.length > 0
            ? "Pick one read-only tool to build first. You can add more from the console after."
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
      <TaskPicker
        tasks={tasks}
        value={task}
        onChange={setTask}
        integrationName={name}
        disabled={busy}
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
          trimmed ? (
            <>
              <span className="hidden sm:inline">Your first tool</span>
              <span className="flex min-w-0 items-center gap-2 rounded-full border bg-background py-1 pr-1.5 pl-2 text-foreground">
                {logo("size-4")}
                <span className="truncate">{trimmed}</span>
                {custom ? (
                  <span className="rounded-full bg-muted px-1.5 text-muted-foreground text-xs">
                    Custom
                  </span>
                ) : null}
                <button
                  type="button"
                  aria-label="Clear the task"
                  className="rounded-full p-0.5 hover:bg-muted"
                  onClick={() => setTask("")}
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
        <Button type="submit" disabled={!trimmed || !available || busy}>
          {choose.isPending ? "Starting…" : "Build this tool"}
        </Button>
      </SetupFooter>
    </form>
  );
}
