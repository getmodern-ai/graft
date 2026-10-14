import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type * as React from "react";
import { useId, useState } from "react";

import { ConnectItsAgent } from "@/components/agent/agent-card";
import { CreateAgentDialog } from "@/components/agent/create-agent-dialog";
import { SetupPromptBlock } from "@/components/agent/setup-prompt-block";
import { AddIcon, ArrowForwardIcon, CheckIcon } from "@/components/icons";
import { HarnessMark, IntegrationMark } from "@/components/marks";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { agentsQuery } from "@/lib/agent-queries";
import { connectionsQuery } from "@/lib/connection-queries";
import {
  agentStepAction,
  askPromptTarget,
  checklistProgress,
  type HomeChecklist,
  type HomeChecklistStep,
  INTEGRATION_STEP_MARKS,
  offersResumeSetup,
} from "@/lib/home-checklist";
import { integrationsQuery } from "@/lib/integration-queries";
import type { HarnessMarkId } from "@/lib/marks";
import { setupQuery, setupVendorsQuery } from "@/lib/setup-queries";
import { cn } from "@/lib/utils";

/** The agents the first step's marks name, in the sentence's order. */
const AGENT_MARKS: readonly HarnessMarkId[] = [
  "claude",
  "chatgpt",
  "claude-code",
  "codex",
  "hermes",
  "openclaw",
];

/**
 * *Get started* (GRA-328; Figma 2099:10107): the three steps of `homeChecklist`, numbered, each
 * with its action until it is done, in any order. *Resume Setup* rides beside the count while a
 * skipped Setup could pick up where it left off (ADR 0024); each step here is also one the console
 * offers on its own, so nothing here needs Setup.
 */
export function GetStartedPanel({
  checklist,
  emphasis = true,
}: {
  checklist: HomeChecklist;
  /** False above the panels, where the header's *Connect an integration* is the screen's primary. */
  emphasis?: boolean;
}) {
  const id = useId();
  const setup = useQuery(setupQuery);
  const step = (row: HomeChecklistStep, index: number) => {
    const Body = STEP_BODIES[row.id];
    return (
      <ChecklistRow key={row.id} number={index + 1} done={row.done}>
        <Body step={{ ...row, primary: emphasis && row.primary }} />
      </ChecklistRow>
    );
  };

  return (
    <section aria-labelledby={id} className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h2 id={id} className="font-heading font-medium text-lg tracking-tight">
            Get started
          </h2>
          <p className="text-muted-foreground text-sm">
            Three steps, about five minutes. Do them in any order.
          </p>
        </div>
        <span className="shrink-0 text-muted-foreground text-sm">
          {checklistProgress(checklist)}
        </span>
        {offersResumeSetup(setup.data) ? (
          <Button
            variant="ghost"
            size="sm"
            className="shrink-0"
            nativeButton={false}
            render={<Link to="/setup" />}
          >
            Resume Setup
            <ArrowForwardIcon />
          </Button>
        ) : null}
      </div>
      {/* `RequestList`'s card, as an ordered list: the steps are numbered. */}
      <ol
        aria-label="Get started"
        className="flex flex-col overflow-hidden rounded-lg border border-border bg-card"
      >
        {checklist.steps.map(step)}
      </ol>
    </section>
  );
}

function ChecklistRow({
  number,
  done,
  children,
}: {
  number: number;
  done: boolean;
  children: React.ReactNode;
}) {
  return (
    <li className="flex items-start gap-4 border-border border-b px-5 py-4 last:border-b-0">
      <span
        className={cn(
          "flex size-7 shrink-0 items-center justify-center rounded-full border text-xs",
          done
            ? "border-transparent bg-success-foreground text-success"
            : "border-border text-muted-foreground",
        )}
      >
        {done ? <CheckIcon aria-hidden="true" className="size-4" /> : number}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-3">{children}</div>
    </li>
  );
}

/** A step's title, its sentence, and its action on the right; "Done" in its place once it is. */
function StepHeading({
  step,
  title,
  description,
  action,
}: {
  step: HomeChecklistStep;
  title: string;
  description: string;
  action: React.ReactNode;
}) {
  return (
    // Below `sm` the action drops under the sentence, which would otherwise be a word wide.
    <div className="flex flex-col items-start gap-3 sm:flex-row">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <h3 className="font-medium text-sm">
          {title}
          {step.done ? <span className="sr-only"> (done)</span> : null}
        </h3>
        <p className="text-muted-foreground text-sm">{description}</p>
      </div>
      {step.done ? (
        <Badge variant="success" aria-hidden="true">
          Done
        </Badge>
      ) : (
        action
      )}
    </div>
  );
}

function MarkRow({ children }: { children: React.ReactNode }) {
  return (
    <div aria-hidden="true" className="flex flex-wrap items-center gap-2">
      {children}
    </div>
  );
}

function AgentStep({ step }: { step: HomeChecklistStep }) {
  const agents = useQuery(agentsQuery);
  const setup = useQuery(setupQuery);
  const [creating, setCreating] = useState(false);
  // The create dialog's scope; read only once it is opened, as *Your agents* reads it.
  const connections = useQuery({ ...connectionsQuery, enabled: creating });
  const action = agentStepAction(agents.data?.agents ?? [], setup.data);
  const variant = step.primary ? "default" : "outline";

  return (
    <>
      <StepHeading
        step={step}
        title="Add Graft to your agent"
        description="Works with Claude, ChatGPT, Claude Code, Codex, Hermes, OpenClaw and any MCP client."
        action={
          action.kind === "setup" ? (
            <Button
              variant={variant}
              size="sm"
              nativeButton={false}
              render={<Link to="/setup" search={{ agent: action.agentId }} />}
            >
              Connect its agent
            </Button>
          ) : action.kind === "dialog" ? (
            <ConnectItsAgent agent={action.agent} variant={variant} />
          ) : (
            <Button variant={variant} size="sm" onClick={() => setCreating(true)}>
              <AddIcon />
              Add to an agent
            </Button>
          )
        }
      />
      {step.done ? null : (
        <MarkRow>
          {AGENT_MARKS.map((mark) => (
            <HarnessMark key={mark} mark={mark} tile="none" className="size-5" />
          ))}
        </MarkRow>
      )}
      <CreateAgentDialog
        open={creating}
        onOpenChange={setCreating}
        connections={connections.data?.connections}
        connectionsFailed={
          connections.isError
            ? {
                error: connections.error,
                onRetry: () => void connections.refetch(),
                retrying: connections.isFetching,
              }
            : undefined
        }
      />
    </>
  );
}

function IntegrationStep({ step }: { step: HomeChecklistStep }) {
  // Only the marks need it, and a step already done draws none.
  const vendors = useQuery({ ...setupVendorsQuery, enabled: !step.done });
  const marks = (vendors.data?.vendors ?? []).slice(0, INTEGRATION_STEP_MARKS);
  return (
    <>
      <StepHeading
        step={step}
        title="Connect an integration"
        description="Sign in once. Graft keeps your login, and your agents never see it."
        action={
          <Button
            variant={step.primary ? "default" : "outline"}
            size="sm"
            nativeButton={false}
            render={<Link to="/integrations" search={{ tab: "discover" }} />}
          >
            Connect an integration
          </Button>
        }
      />
      {step.done || marks.length === 0 ? null : (
        <MarkRow>
          {marks.map(({ starter }) => (
            <IntegrationMark
              key={starter.id}
              slug={starter.id}
              name={starter.displayName}
              tile="none"
              className="size-5"
            />
          ))}
        </MarkRow>
      )}
    </>
  );
}

function AskStep({ step }: { step: HomeChecklistStep }) {
  const agents = useQuery(agentsQuery);
  const setup = useQuery(setupQuery);
  const integrations = useQuery(integrationsQuery);
  const target = askPromptTarget(
    agents.data?.agents ?? [],
    setup.data,
    integrations.data?.integrations ?? [],
  );
  return (
    <>
      <StepHeading
        step={step}
        title="Ask your agent for something"
        description="If it needs a tool it doesn't have, Graft builds one. Anything that changes data asks you first."
        action={null}
      />
      {step.done ? null : (
        <SetupPromptBlock
          harness={target.harness}
          agentName={target.agentName}
          connection={target.connection}
        />
      )}
    </>
  );
}

const STEP_BODIES: Record<
  HomeChecklistStep["id"],
  (props: { step: HomeChecklistStep }) => React.ReactNode
> = {
  agent: AgentStep,
  integration: IntegrationStep,
  ask: AskStep,
};
