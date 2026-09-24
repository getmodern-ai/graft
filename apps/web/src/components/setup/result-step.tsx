import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { CodeBlock } from "@/components/code-block";
import { WarningIcon } from "@/components/icons";
import { Loader } from "@/components/loader";
import { RetryNotice } from "@/components/retry-notice";
import { SetupStepHeader } from "@/components/setup/setup-step-header";
import { useSetupMutation } from "@/components/setup/use-setup-mutation";
import { StatusChip } from "@/components/status-chip";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Item, ItemContent, ItemDescription, ItemTitle } from "@/components/ui/item";
import { Textarea } from "@/components/ui/textarea";
import {
  completeSetupResult,
  runAgentTool,
  type SetupStateData,
  type SetupTool,
  setupToolQuery,
} from "@/lib/setup-queries";
import { type RunInputView, runInputOf, runInputView, runResultText } from "@/lib/setup-run-input";
import { TOOL_ANNOTATION_CHIP } from "@/lib/status-chips";

/**
 * The result step (GRA-208; GRA-202, *Building and result*, user stories 20 and 21): the tool the
 * job acquired, run as the setup's agent through the agent's run route, and its answer shown in the
 * console's code block. The input is the starter's with its default (the city for Open-Meteo),
 * editable, or nothing for a tool that takes none, or the schema's fields as JSON for another
 * vendor's tool. The run starts once on arrival with that input, so the answer is on screen before
 * the person does anything, and *Run again* takes what they typed. A refusal or a failure shows the
 * run's own sentence. The server runs read-only tools in the agent's working set only, so nothing
 * here can raise an approval. *Continue* moves on to the finish step.
 */
export function ResultStep({ state }: { state: SetupStateData }) {
  const context = useQuery(setupToolQuery);
  const agentName = state.agent?.name ?? "your agent";
  return (
    <div className="flex flex-col gap-6">
      <SetupStepHeader
        title="See it work"
        description={`Graft runs the new tool as ${agentName}, the way your harness will call it.`}
      />
      {context.isPending ? (
        <Loader />
      ) : context.isError ? (
        <p className="text-muted-foreground text-sm">
          <RetryNotice
            error={context.error}
            message="Could not load the tool."
            onRetry={() => void context.refetch()}
            retrying={context.isFetching}
          />
        </p>
      ) : context.data.tool && context.data.agent ? (
        <ToolRun context={context.data} agentId={context.data.agent.id} tool={context.data.tool} />
      ) : (
        <Loader />
      )}
    </div>
  );
}

function ToolRun({
  context,
  agentId,
  tool,
}: {
  context: SetupTool;
  agentId: string;
  tool: NonNullable<SetupTool["tool"]>;
}) {
  const view: RunInputView = runInputView(tool.inputSchema, context.runInput);
  const [value, setValue] = useState(() =>
    view.kind === "field" ? view.defaultValue : view.kind === "json" ? view.initial : "",
  );
  const [inputProblem, setInputProblem] = useState<string | null>(null);
  const run = useMutation({ mutationFn: runAgentTool });
  const onward = useSetupMutation(completeSetupResult);

  const start = (typed: string) => {
    const input = runInputOf(view, typed);
    if (!input.ok) {
      setInputProblem(input.message);
      return;
    }
    setInputProblem(null);
    run.mutate({ agentId, vendor: tool.vendor, name: tool.name, body: { input: input.input } });
  };

  // Run once on arrival with the default, so the answer is the first thing the step shows.
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    start(value);
  });

  const answer = run.data;
  const refused = run.isError ? (run.error instanceof Error ? run.error.message : null) : null;

  return (
    <form
      className="flex flex-col gap-6"
      onSubmit={(event) => {
        event.preventDefault();
        start(value);
      }}
    >
      <Item variant="outline">
        <ItemContent>
          <ItemTitle>
            {tool.wireName}
            {tool.readOnly ? <StatusChip chip={TOOL_ANNOTATION_CHIP["read-only"]} /> : null}
          </ItemTitle>
          <ItemDescription>{tool.description}</ItemDescription>
        </ItemContent>
      </Item>

      {view.kind === "field" ? (
        <Field>
          <FieldLabel htmlFor="setup-run-input">{view.label}</FieldLabel>
          <Input
            id="setup-run-input"
            value={value}
            disabled={run.isPending}
            onChange={(event) => setValue(event.target.value)}
          />
          <FieldDescription>Change it and run again to see a different answer.</FieldDescription>
        </Field>
      ) : view.kind === "json" ? (
        <Field>
          <FieldLabel htmlFor="setup-run-input">Input</FieldLabel>
          <Textarea
            id="setup-run-input"
            className="font-mono text-xs"
            rows={5}
            value={value}
            disabled={run.isPending}
            onChange={(event) => setValue(event.target.value)}
          />
          <FieldDescription>The tool's fields as JSON. Fill them in and run it.</FieldDescription>
          {inputProblem ? <FieldError>{inputProblem}</FieldError> : null}
        </Field>
      ) : null}

      {run.isPending ? (
        <Loader />
      ) : answer?.ok ? (
        <CodeBlock
          label="The tool's answer"
          code={runResultText(answer.result)}
          copyLabel="Copy answer"
          wrap
          hint="This is what the vendor answered, as your harness will see it."
        />
      ) : answer && !answer.ok ? (
        <Alert variant="destructive">
          <WarningIcon />
          <AlertTitle>The run did not answer</AlertTitle>
          <AlertDescription>{answer.message}</AlertDescription>
        </Alert>
      ) : refused ? (
        <Alert variant="destructive">
          <WarningIcon />
          <AlertTitle>The console cannot run this tool</AlertTitle>
          <AlertDescription>{refused}</AlertDescription>
        </Alert>
      ) : null}

      <div className="flex flex-wrap items-center justify-end gap-2">
        {view.kind === "none" && !answer ? null : (
          <Button type="submit" variant="outline" disabled={run.isPending}>
            {run.isPending ? "Running…" : "Run again"}
          </Button>
        )}
        <Button type="button" disabled={onward.isPending} onClick={() => onward.mutate(undefined)}>
          {onward.isPending ? "Continuing…" : "Continue"}
        </Button>
      </div>
    </form>
  );
}
