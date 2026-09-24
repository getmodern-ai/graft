import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { CodeBlock } from "@/components/code-block";
import { WarningIcon } from "@/components/icons";
import { Loader } from "@/components/loader";
import { RetryNotice } from "@/components/retry-notice";
import { SetupDisclosure } from "@/components/setup/setup-disclosure";
import { SetupFooter } from "@/components/setup/setup-footer";
import { SetupStepHeader } from "@/components/setup/setup-step-header";
import { useSetupMutation } from "@/components/setup/use-setup-mutation";
import { StatusChip } from "@/components/status-chip";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Item, ItemContent, ItemDescription, ItemTitle } from "@/components/ui/item";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  completeSetupResult,
  runAgentTool,
  type SetupStateData,
  type SetupTool,
  setupToolQuery,
} from "@/lib/setup-queries";
import { resultToolOf } from "@/lib/setup-result";
import {
  canRun,
  initialValues,
  type RunField,
  type RunInputView,
  runInputOf,
  runInputView,
  runResultText,
} from "@/lib/setup-run-input";
import { runFailure, type ShortFailure, shortFailure } from "@/lib/short-failure";
import { TOOL_ANNOTATION_CHIP } from "@/lib/status-chips";

/**
 * The result step (GRA-208; GRA-202, *Building and result*, user stories 20 and 21): the tool the
 * job acquired, run as the setup's agent through the agent's run route, and its answer shown in the
 * console's code block. The input is drawn from the tool's own schema (GRA-217,
 * `lib/setup-run-input.ts`): a field per input, starting at the starter's default where the names
 * match (the city for Open-Meteo) or the schema's default or example, nothing for a tool that
 * takes none, and JSON only for a schema too complex to draw. The run starts once on arrival when
 * nothing required is missing, so the answer is on screen before the person does anything; a
 * required field with no value says what the tool needs and Run waits for it. A refusal or a
 * failure is one sentence, with the raw text behind *Details* (`lib/short-failure.ts`). The server
 * runs read-only tools in the agent's working set only, so nothing here can raise an approval.
 * *Continue* moves on to the finish step.
 */
export function ResultStep({ state }: { state: SetupStateData }) {
  const context = useQuery(setupToolQuery);
  const agentName = state.agent?.name ?? "your agent";
  const recordToolId = state.setup?.toolId ?? null;
  const tool = resultToolOf(recordToolId, context.data?.tool);
  // A cached context naming an earlier job's tool is read again, once per tool the record names,
  // and nothing runs until the record's own tool is here (`lib/setup-result.ts`).
  const refetchedFor = useRef<string | null>(null);
  const { data, isFetching, refetch } = context;
  useEffect(() => {
    if (!data?.tool || tool || isFetching || refetchedFor.current === recordToolId) return;
    refetchedFor.current = recordToolId;
    void refetch();
  }, [data, tool, isFetching, recordToolId, refetch]);
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
      ) : tool && context.data.agent ? (
        <ToolRun
          key={tool.id}
          state={state}
          context={context.data}
          agentId={context.data.agent.id}
          tool={tool}
        />
      ) : (
        <Loader />
      )}
    </div>
  );
}

function ToolRun({
  state,
  context,
  agentId,
  tool,
}: {
  state: SetupStateData;
  context: SetupTool;
  agentId: string;
  tool: NonNullable<SetupTool["tool"]>;
}) {
  const view: RunInputView = runInputView(tool.inputSchema, context.runInput);
  const [values, setValues] = useState(() => initialValues(view));
  const [text, setText] = useState(() => (view.kind === "json" ? view.initial : ""));
  const [inputProblem, setInputProblem] = useState<string | null>(null);
  const run = useMutation({ mutationFn: runAgentTool });
  const onward = useSetupMutation(completeSetupResult);
  const ready = canRun(view, values, text);

  const start = () => {
    const input = runInputOf(view, values, text);
    if (!input.ok) {
      setInputProblem(input.message);
      return;
    }
    setInputProblem(null);
    run.mutate({ agentId, vendor: tool.vendor, name: tool.name, body: { input: input.input } });
  };

  // Run once on arrival when nothing required is missing, so the answer is the first thing shown.
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (ready) start();
  });

  const answer = run.data;
  const failure: ShortFailure | null =
    answer && !answer.ok
      ? runFailure(answer)
      : run.isError
        ? shortFailure(run.error instanceof Error ? run.error.message : null)
        : null;
  const setValue = (name: string, value: string) => setValues((was) => ({ ...was, [name]: value }));

  return (
    <form
      className="flex flex-col gap-6"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) start();
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

      {view.kind === "form" ? (
        <div className="flex flex-col gap-4">
          {view.fields.map((field) => (
            <RunFieldInput
              key={field.name}
              field={field}
              value={values[field.name] ?? ""}
              disabled={run.isPending}
              onChange={(value) => setValue(field.name, value)}
            />
          ))}
          {inputProblem ? <FieldError>{inputProblem}</FieldError> : null}
        </div>
      ) : view.kind === "json" ? (
        <Field>
          <FieldLabel htmlFor="setup-run-input">Input</FieldLabel>
          <Textarea
            id="setup-run-input"
            className="font-mono text-xs"
            rows={5}
            value={text}
            disabled={run.isPending}
            onChange={(event) => setText(event.target.value)}
          />
          <FieldDescription>
            {view.required.length > 0
              ? `The tool's fields as JSON. It needs ${view.required.join(", ")} before it runs.`
              : "The tool's fields as JSON. Fill them in and run it."}
          </FieldDescription>
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
          hint="This is what the integration answered, as your harness will see it."
        />
      ) : failure ? (
        <FailureNotice
          title={answer ? "The run did not answer" : "The console cannot run this tool"}
          failure={failure}
        />
      ) : null}

      <SetupFooter state={state} disabled={run.isPending || onward.isPending}>
        {view.kind === "none" && !answer ? null : (
          <Button type="submit" variant="outline" disabled={run.isPending || !ready}>
            {run.isPending ? "Running…" : answer || failure ? "Run again" : "Run"}
          </Button>
        )}
        <Button type="button" disabled={onward.isPending} onClick={() => onward.mutate(undefined)}>
          {onward.isPending ? "Continuing…" : "Continue"}
        </Button>
      </SetupFooter>
    </form>
  );
}

/**
 * One input drawn from the tool's schema: a text field for a string, a number or a list, a checkbox
 * for a boolean, a select for an enum. An optional field says so beside its label, as the
 * connection form's do; a required field with no value says what the tool needs under it.
 */
function RunFieldInput({
  field,
  value,
  disabled,
  onChange,
}: {
  field: RunField;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const id = `setup-run-${field.name}`;
  const optional = field.required ? null : (
    <span className="font-normal text-muted-foreground">(optional)</span>
  );
  const missing = field.required && field.kind !== "boolean" && value.trim() === "";
  const hint = missing
    ? field.needs
    : (field.description ?? (field.kind === "list" ? "Separate the values with commas." : null));

  if (field.kind === "boolean") {
    return (
      <Field orientation="horizontal">
        <Checkbox
          id={id}
          checked={value === "true"}
          disabled={disabled}
          onCheckedChange={(checked) => onChange(checked ? "true" : "false")}
        />
        <FieldLabel htmlFor={id}>
          {field.label}
          {optional}
        </FieldLabel>
      </Field>
    );
  }

  return (
    <Field>
      <FieldLabel htmlFor={id}>
        {field.label}
        {optional}
      </FieldLabel>
      {field.kind === "enum" ? (
        <Select
          value={value === "" ? null : value}
          items={field.options.map((option) => ({ value: option.label, label: option.label }))}
          disabled={disabled}
          onValueChange={(next) => onChange(next ?? "")}
        >
          <SelectTrigger id={id} className="w-full">
            <SelectValue placeholder="Choose a value" />
          </SelectTrigger>
          <SelectContent>
            {field.options.map((option) => (
              <SelectItem key={option.label} value={option.label}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <Input
          id={id}
          value={value}
          disabled={disabled}
          inputMode={field.kind === "number" || field.kind === "integer" ? "decimal" : undefined}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
      {hint ? <FieldDescription>{hint}</FieldDescription> : null}
    </Field>
  );
}

/** A refusal or a failure: one sentence, and the raw text, trimmed, behind *Details*. */
function FailureNotice({ title, failure }: { title: string; failure: ShortFailure }) {
  return (
    <div className="flex flex-col gap-3">
      <Alert variant="destructive">
        <WarningIcon />
        <AlertTitle>{title}</AlertTitle>
        <AlertDescription>{failure.sentence}</AlertDescription>
      </Alert>
      {failure.details ? (
        <SetupDisclosure label="Details">
          <CodeBlock
            label="What the run reported"
            code={failure.details}
            copyLabel="Copy details"
            wrap
          />
        </SetupDisclosure>
      ) : null}
    </div>
  );
}
