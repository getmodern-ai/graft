import {
  type UseMutationResult,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { CodeBlock } from "@/components/code-block";
import {
  CheckCircleIcon,
  ErrorIcon,
  ScheduleIcon,
  StarsIcon,
  WarningIcon,
} from "@/components/icons";
import { RetryNotice } from "@/components/retry-notice";
import { SetupTaskRow } from "@/components/setup/setup-app-card";
import { SetupDisclosure } from "@/components/setup/setup-disclosure";
import { StatusChip } from "@/components/status-chip";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { agentKeys } from "@/lib/agent-queries";
import { connectionAccessQuery, connectionKeys, toolKeys } from "@/lib/connection-queries";
import { formatRelative } from "@/lib/format";
import type { IntegrationPage, PageConnection } from "@/lib/integration-page";
import {
  type NewToolJob,
  newToolJobsQuery,
  newToolKeys,
  newToolSuggestionsQuery,
  startNewTool,
} from "@/lib/integration-queries";
import {
  defaultNewToolAgentId,
  isNewToolJobWorking,
  newToolAgentChoices,
  newToolAttemptsLine,
  newToolConnectionId,
  newToolOf,
  newToolPartRows,
  newToolProgressFraction,
  newToolProgressNote,
  newToolPrompt,
  newToolReadyLine,
  newToolStep,
  runningNewToolJob,
} from "@/lib/new-tool";
import { jobPollInterval, progressCard } from "@/lib/setup-progress";
import { acquireJobQuery } from "@/lib/setup-queries";
import { toolAccessChip } from "@/lib/status-chips";
import { cn } from "@/lib/utils";

type Page = Extract<IntegrationPage, { kind: "integration" }>;

/**
 * Get a new tool on an integration's page (GRA-320, Flow D; Figma 2110:14487, 2124:16104–19043;
 * ADR 0024 as amended 2026-10-14). The header's button and the dialog behind it, with four views:
 * describe it (the goal, the Try chips, the agent picked before Create), building (Setup's
 * progress card, `progressCard`), ready (the tool and a first request to copy) and failed
 * (`shortFailure`'s sentence, *Change description* and *Try again*). Create is the picked agent's
 * build approval for the connection and starts its job (`POST /connections/:id/acquire`, GRA-303).
 *
 * **The job outlives the dialog.** This component, not the dialog, holds the job it follows and
 * polls it, so closing mid-build keeps it; a toast says how it ended when the dialog is closed
 * then, and the dialog opens on that ending until the person closes it. A reload finds the job
 * again through each live connection's jobs read (`runningNewToolJob`). The ending refreshes the
 * toolbox and the integrations, so the Tools tab and the header's count show the new tool.
 *
 * The start (Create and Try again) is this component's too, so a dialog closed and reopened while
 * the request is in flight cannot send it twice; and each open reads the jobs again, with Create
 * waiting on that read, so a job started elsewhere is followed rather than started anew. The
 * header mounts it keyed by vendor, so nothing carries from one integration's page to another's.
 */
export function GetNewTool({ page }: { page: Page }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [followed, setFollowed] = useState<NewToolJob | null>(null);
  // The goal as typed, kept across *Change description* and a close mid-description.
  const [goal, setGoal] = useState("");
  const dismissed = useRef(new Set<string>());
  const openRef = useRef(open);
  openRef.current = open;

  const live = page.connections.filter((connection) => connection.state !== "revoked");
  const jobReads = useQueries({
    queries: live.map((connection) => newToolJobsQuery(connection.id)),
  });
  const running = runningNewToolJob(jobReads.flatMap((read) => read.data?.jobs ?? []));

  // A job still being built that this page is not following yet (a reload, another tab) is
  // picked up, unless the person already closed the dialog on it.
  useEffect(() => {
    if (!followed && running && !dismissed.current.has(running.jobId)) setFollowed(running);
  }, [followed, running]);

  const start = useMutation({
    mutationFn: (args: StartArgs) =>
      startNewTool(args.connectionId, { agentId: args.agentId, goal: args.goal }),
    onSuccess: (job, args) => {
      if (args.replaces) dismissed.current.add(args.replaces);
      setFollowed(job);
      void queryClient.invalidateQueries({ queryKey: newToolKeys.jobs(job.connectionId) });
      // The build approval is on the agent's access row now.
      void queryClient.invalidateQueries({ queryKey: connectionKeys.access(job.connectionId) });
    },
  });

  const openDialog = () => {
    setOpen(true);
    if (!followed) for (const read of jobReads) void read.refetch();
  };
  const checkingJobs = jobReads.some((read) => read.isFetching);

  const poll = useQuery({
    ...acquireJobQuery(followed?.agent.id ?? "", followed?.jobId ?? ""),
    enabled: followed !== null,
    refetchInterval: (query) => jobPollInterval(query.state),
  });
  const current: NewToolJob | null =
    followed && poll.data?.jobId === followed.jobId ? { ...followed, ...poll.data } : followed;

  // The ending, once per job: refresh what shows the tool, and say so when the dialog is closed.
  const settled = useRef<string | null>(null);
  useEffect(() => {
    if (!current || isNewToolJobWorking(current) || settled.current === current.jobId) return;
    settled.current = current.jobId;
    void queryClient.invalidateQueries({ queryKey: toolKeys.all });
    void queryClient.invalidateQueries({ queryKey: connectionKeys.all });
    void queryClient.invalidateQueries({ queryKey: agentKeys.workingSet(current.agent.id) });
    if (openRef.current) return;
    const tool = newToolOf(current);
    if (tool) {
      toast.success(`${current.goal} is ready`, {
        description: `${current.agent.name} can use it now.`,
        duration: 15_000,
        action: {
          label: "Copy prompt",
          onClick: () => void navigator.clipboard.writeText(newToolPrompt(current.goal, tool.tool)),
        },
      });
    } else {
      toast.error("Graft couldn't build this one", {
        description: "Nothing was added to your tools.",
        duration: 15_000,
        action: { label: "Open", onClick: () => setOpen(true) },
      });
    }
  }, [current, queryClient]);

  const close = () => {
    setOpen(false);
    if (!current || isNewToolJobWorking(current)) return;
    // A finished job is closed for good; the next open is a fresh description.
    dismissed.current.add(current.jobId);
    if (newToolStep(current) === "ready") setGoal("");
    setFollowed(null);
    start.reset();
  };

  const step = newToolStep(current);

  return (
    <>
      {/* The glyph alone below `sm`, where the label would squeeze the integration's name. */}
      <Button variant="outline" aria-label="Get a new tool" onClick={openDialog}>
        <StarsIcon />
        <span className="hidden sm:inline">Get a new tool</span>
      </Button>
      <Dialog open={open} onOpenChange={(next) => (next ? openDialog() : close())}>
        <DialogContent className="sm:max-w-lg">
          {step === "describe" || !current ? (
            <DescribeView
              page={page}
              open={open}
              goal={goal}
              onGoalChange={setGoal}
              start={start}
              checkingJobs={checkingJobs}
              onCancel={close}
            />
          ) : step === "building" ? (
            <BuildingView page={page} job={current} pollFailed={poll} onClose={close} />
          ) : step === "ready" ? (
            <ReadyView page={page} job={current} onClose={close} />
          ) : (
            <FailedView
              page={page}
              job={current}
              start={start}
              onChangeDescription={() => {
                dismissed.current.add(current.jobId);
                setGoal(current.goal);
                setFollowed(null);
                start.reset();
              }}
              onClose={close}
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

type StartArgs = {
  connectionId: string;
  agentId: string;
  goal: string;
  /** The failed job a Try again replaces, closed for good once the new one starts. */
  replaces?: string;
};
type Start = UseMutationResult<NewToolJob, Error, StartArgs>;

/** "Gmail, connected 3 days ago": a connection told apart from the vendor's others. */
function connectionLabel(connection: PageConnection): string {
  return `${connection.displayName}, connected ${formatRelative(connection.createdAt)}`;
}

function DescribeView({
  page,
  open,
  goal,
  onGoalChange,
  start,
  checkingJobs,
  onCancel,
}: {
  page: Page;
  open: boolean;
  goal: string;
  onGoalChange: (goal: string) => void;
  start: Start;
  /** Set while the jobs are read again on open: Create waits, so a running job is followed. */
  checkingJobs: boolean;
  onCancel: () => void;
}) {
  const connected = page.connections.filter((connection) => connection.state === "connected");
  const accessReads = useQueries({
    queries: connected.map((connection) => ({
      ...connectionAccessQuery(connection.id),
      enabled: open,
    })),
  });
  const choices = newToolAgentChoices(
    connected.map((connection) => connection.id),
    accessReads.map((read) => read.data?.access),
  );
  const [pickedAgent, setPickedAgent] = useState<string | null>(null);
  const [pickedConnection, setPickedConnection] = useState<string | null>(null);
  const agentId = choices.some((choice) => choice.agent.id === pickedAgent)
    ? pickedAgent
    : defaultNewToolAgentId(choices);
  const choice = choices.find((entry) => entry.agent.id === agentId);
  const connectionId = newToolConnectionId(choice, pickedConnection);
  const agentItems = choices.map((entry) => ({ value: entry.agent.id, label: entry.agent.name }));
  const connectionItems = (choice?.connectionIds ?? []).flatMap((id) => {
    const connection = connected.find((entry) => entry.id === id);
    return connection ? [{ value: id, label: connectionLabel(connection) }] : [];
  });

  // The chips and the model check come from the connection the job will use, or the oldest.
  const suggestionsFor = connectionId ?? connected[0]?.id ?? null;
  const suggestions = useQuery({
    ...newToolSuggestionsQuery(suggestionsFor ?? ""),
    enabled: open && suggestionsFor !== null,
  });
  const unavailable =
    suggestions.data && !suggestions.data.build.available ? suggestions.data.build : null;

  const accessPending = accessReads.some((read) => read.isPending);
  const accessFailed = accessReads.find((read) => read.isError);
  const nobody = !accessPending && !accessFailed && choices.length === 0;
  // Every access read answered: the picker shows the agent Create approves, never a default
  // drawn from part of them behind a skeleton or a retry.
  const canCreate =
    !start.isPending &&
    !checkingJobs &&
    !accessPending &&
    !accessFailed &&
    !unavailable &&
    goal.trim().length > 0 &&
    agentId !== null &&
    connectionId !== null;

  return (
    <form
      className="contents"
      onSubmit={(event) => {
        event.preventDefault();
        if (!canCreate || !agentId || !connectionId) return;
        start.mutate({ connectionId, agentId, goal: goal.trim() });
      }}
    >
      <DialogHeader>
        <DialogTitle>Get a new {page.displayName} tool</DialogTitle>
        <DialogDescription>
          Describe what it should do. Graft writes it, checks it and tries it against{" "}
          {page.displayName}.
        </DialogDescription>
      </DialogHeader>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="new-tool-goal">What should it do?</FieldLabel>
          <Textarea
            id="new-tool-goal"
            autoFocus
            rows={3}
            placeholder="Describe the tool in a sentence"
            value={goal}
            onChange={(event) => onGoalChange(event.target.value)}
          />
          {suggestions.data && suggestions.data.suggestions.length > 0 ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-muted-foreground text-xs">Try:</span>
              {suggestions.data.suggestions.map((suggestion) => (
                <Button
                  key={suggestion}
                  type="button"
                  variant="outline"
                  size="xs"
                  className="rounded-full"
                  onClick={() => onGoalChange(suggestion)}
                >
                  {suggestion}
                </Button>
              ))}
            </div>
          ) : null}
        </Field>
        <Field>
          <FieldLabel htmlFor="new-tool-agent">For agent</FieldLabel>
          {accessPending && open ? (
            <Skeleton className="h-8 w-full" />
          ) : accessFailed ? (
            <p className="text-muted-foreground text-sm">
              <RetryNotice
                error={accessFailed.error}
                message="Could not read your agents."
                onRetry={() => {
                  for (const read of accessReads) if (read.isError) void read.refetch();
                }}
                retrying={accessReads.some((read) => read.isFetching)}
              />
            </p>
          ) : nobody ? (
            <p className="text-muted-foreground text-sm">
              No agent can use {page.displayName} yet. Add it to an agent's connections first.
            </p>
          ) : (
            <Select
              value={agentId}
              items={agentItems}
              onValueChange={(next) => setPickedAgent(typeof next === "string" ? next : null)}
            >
              <SelectTrigger id="new-tool-agent" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {agentItems.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {!nobody && !accessFailed ? (
            <FieldDescription>
              Creating the tool lets this agent build {page.displayName} tools, and the tool joins
              its working set.
            </FieldDescription>
          ) : null}
        </Field>
        {connectionItems.length > 1 ? (
          <Field>
            <FieldLabel htmlFor="new-tool-connection">Connection</FieldLabel>
            <Select
              value={connectionId}
              items={connectionItems}
              onValueChange={(next) => setPickedConnection(typeof next === "string" ? next : null)}
            >
              <SelectTrigger id="new-tool-connection" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {connectionItems.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldDescription>
              The account Graft tries the tool against while it builds. This agent reaches more than
              one.
            </FieldDescription>
          </Field>
        ) : null}
        {unavailable ? (
          <Alert variant="destructive">
            <WarningIcon />
            <AlertDescription>{unavailable.message}</AlertDescription>
          </Alert>
        ) : null}
        {start.isError ? (
          <Alert variant="destructive">
            <ErrorIcon />
            <AlertDescription>{start.error.message}</AlertDescription>
          </Alert>
        ) : null}
      </FieldGroup>
      <DialogFooter className="sm:items-center">
        <p className="flex items-center gap-1.5 text-muted-foreground text-xs sm:mr-auto">
          <ScheduleIcon className="size-4 shrink-0" />
          Usually 1–3 minutes.
        </p>
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={!canCreate}>
          <StarsIcon />
          {start.isPending ? "Creating…" : "Create tool"}
        </Button>
      </DialogFooter>
    </form>
  );
}

/** The job's goal with where it stands, Setup's task row (`SetupTaskRow`). */
function JobRow({ job }: { job: NewToolJob }) {
  const card = progressCard(job);
  return (
    <SetupTaskRow
      icon={
        card.kind === "working" ? (
          <Spinner className="size-5 text-primary" />
        ) : card.kind === "passed" ? (
          <CheckCircleIcon className="size-5 text-success" />
        ) : (
          <WarningIcon className="size-5 text-destructive" />
        )
      }
      task={job.goal}
      note={newToolProgressNote(job)}
      progress={card.kind === "passed" ? null : newToolProgressFraction(job)}
    />
  );
}

function BuildingView({
  page,
  job,
  pollFailed,
  onClose,
}: {
  page: Page;
  job: NewToolJob;
  pollFailed: { isError: boolean; error: unknown; isFetching: boolean; refetch: () => unknown };
  onClose: () => void;
}) {
  const card = progressCard(job);
  return (
    <>
      <DialogHeader>
        <DialogTitle>Building your tool</DialogTitle>
        <DialogDescription>
          Graft's model is writing it for {job.agent.name}, checking it and trying it against{" "}
          {page.displayName}.
        </DialogDescription>
      </DialogHeader>
      {pollFailed.isError ? (
        <p className="text-muted-foreground text-sm">
          <RetryNotice
            error={pollFailed.error}
            message="Could not read the job."
            onRetry={() => void pollFailed.refetch()}
            retrying={pollFailed.isFetching}
          />
        </p>
      ) : null}
      <JobRow job={job} />
      <ul className="flex flex-col gap-2">
        {newToolPartRows(job).map((part) => (
          <li
            key={part.label}
            className={cn(
              "flex items-center gap-2 text-sm",
              part.state === "pending" && "text-muted-foreground",
            )}
          >
            {part.state === "done" ? (
              <CheckCircleIcon className="size-4 text-success" />
            ) : part.state === "current" ? (
              <Spinner className="size-4 text-primary" />
            ) : (
              <span aria-hidden className="size-4 rounded-full border border-border" />
            )}
            {part.label}
          </li>
        ))}
      </ul>
      {card.attempt ? (
        <p className="text-muted-foreground text-xs">Attempt {card.attempt}</p>
      ) : null}
      <DialogFooter className="sm:items-center">
        <p className="flex items-center gap-1.5 text-muted-foreground text-xs sm:mr-auto">
          <ScheduleIcon className="size-4 shrink-0" />
          You can close this. Graft keeps building and tells you when it's ready.
        </p>
        <Button variant="outline" onClick={onClose}>
          Close
        </Button>
      </DialogFooter>
    </>
  );
}

function ReadyView({ page, job, onClose }: { page: Page; job: NewToolJob; onClose: () => void }) {
  const tool = newToolOf(job);
  if (!tool) return null;
  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <CheckCircleIcon className="size-5 text-success" />
          {job.goal} is ready
        </DialogTitle>
        <DialogDescription>{newToolReadyLine(job.agent.name, tool.annotations)}</DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-1 rounded-md border bg-card px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <p className="font-medium text-sm">{job.goal}</p>
          <StatusChip chip={toolAccessChip(tool.annotations)} />
        </div>
        <p className="font-mono text-muted-foreground text-xs">{tool.tool}</p>
      </div>
      <CodeBlock
        label={`Try it in ${job.agent.name}`}
        code={newToolPrompt(job.goal, tool.tool)}
        copyLabel="Copy prompt"
        wrap
        hint="Paste it into your agent's chat."
      />
      <DialogFooter>
        <Button
          variant="outline"
          nativeButton={false}
          render={<Link to="/integrations/$vendor" params={{ vendor: page.vendor }} />}
          onClick={onClose}
        >
          View tool
        </Button>
        <Button onClick={onClose}>Done</Button>
      </DialogFooter>
    </>
  );
}

function FailedView({
  page,
  job,
  start,
  onChangeDescription,
  onClose,
}: {
  page: Page;
  job: NewToolJob;
  start: Start;
  onChangeDescription: () => void;
  onClose: () => void;
}) {
  const card = progressCard(job);
  const retry = start;
  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <WarningIcon className="size-5 text-destructive" />
          Graft couldn't build this one
        </DialogTitle>
        <DialogDescription>
          {[newToolAttemptsLine(job.attempts), card.message].filter(Boolean).join(" ")}
        </DialogDescription>
      </DialogHeader>
      <JobRow job={job} />
      <p className="text-muted-foreground text-sm">
        Try describing it a different way, for example naming what to look for in {page.displayName}
        . Nothing was added to your tools.
      </p>
      {card.failureDetails ? (
        <SetupDisclosure label="Details">
          <CodeBlock
            label="What the job reported"
            code={card.failureDetails}
            copyLabel="Copy details"
            wrap
          />
        </SetupDisclosure>
      ) : null}
      {retry.isError ? (
        <Alert variant="destructive">
          <ErrorIcon />
          <AlertDescription>{retry.error.message}</AlertDescription>
        </Alert>
      ) : null}
      <DialogFooter>
        <Button variant="ghost" onClick={onClose} disabled={retry.isPending}>
          Close
        </Button>
        <Button variant="outline" onClick={onChangeDescription} disabled={retry.isPending}>
          Change description
        </Button>
        <Button
          onClick={() =>
            retry.mutate({
              connectionId: job.connectionId,
              agentId: job.agent.id,
              goal: job.goal,
              replaces: job.jobId,
            })
          }
          disabled={retry.isPending || job.agent.revoked}
        >
          {retry.isPending ? "Starting…" : "Try again"}
        </Button>
      </DialogFooter>
    </>
  );
}
