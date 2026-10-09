import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { CodeBlock } from "@/components/code-block";
import { CheckCircleIcon, ErrorIcon, RefreshIcon, WarningIcon } from "@/components/icons";
import { Loader } from "@/components/loader";
import { SetupAppCard } from "@/components/setup/setup-app-card";
import { SetupDisclosure } from "@/components/setup/setup-disclosure";
import { SetupFooter } from "@/components/setup/setup-footer";
import { SetupLogo } from "@/components/setup/setup-logo";
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
import { resultToolOf, runsOnArrival } from "@/lib/setup-result";
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

function ToolRun({
  state,
  context,
  agentId,
  tool,
  embedded = false,
}: {
  state: SetupStateData;
  context: SetupTool;
  agentId: string;
  tool: NonNullable<SetupTool["tool"]>;
  /** Drawn as the done screen's tool card (Setup v2): no footer, the answer behind *Show result*. */
  embedded?: boolean;
}) {
  const view: RunInputView = runInputView(tool.inputSchema, context.runInput);
  const [values, setValues] = useState(() => initialValues(view));
  const [text, setText] = useState(() => (view.kind === "json" ? view.initial : ""));
  const [inputProblem, setInputProblem] = useState<string | null>(null);
  // The run's wall-clock time, for the done card's "Ran just now · 1.2s".
  const [tookMs, setTookMs] = useState<number | null>(null);
  const run = useMutation({
    mutationFn: async (args: Parameters<typeof runAgentTool>[0]) => {
      const began = performance.now();
      const answer = await runAgentTool(args);
      setTookMs(performance.now() - began);
      return answer;
    },
  });
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

  // Run once on arrival only for a tool that takes no input (`runsOnArrival`); a tool with inputs
  // waits for Run, so its first answer is for the values the person chose.
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (runsOnArrival(view)) start();
  });

  const answer = run.data;
  const failure: ShortFailure | null =
    answer && !answer.ok
      ? runFailure(answer)
      : run.isError
        ? shortFailure(run.error instanceof Error ? run.error.message : null)
        : null;
  const setValue = (name: string, value: string) => setValues((was) => ({ ...was, [name]: value }));

  const inputs =
    view.kind === "form" ? (
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
        {inputProblem ? <FieldError>{inputProblem}</FieldError> : null}
      </Field>
    ) : null;

  if (embedded) {
    return (
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (ready) start();
        }}
      >
        <SetupAppCard
          media={<SetupLogo starterId={tool.vendor} />}
          name={<code className="font-mono font-normal text-base">{tool.wireName}</code>}
          chip={tool.readOnly ? <StatusChip chip={TOOL_ANNOTATION_CHIP["read-only"]} /> : null}
          subline={tool.description}
        >
          <p className="flex flex-wrap items-center gap-2 text-sm">
            {run.isPending ? (
              <span className="text-muted-foreground">Running…</span>
            ) : answer?.ok ? (
              <>
                <CheckCircleIcon className="size-4 text-success" />
                <span className="font-medium text-success">Ran just now</span>
                {tookMs !== null ? (
                  <span className="text-muted-foreground">· {(tookMs / 1000).toFixed(1)}s</span>
                ) : null}
              </>
            ) : failure ? (
              <>
                <ErrorIcon className="size-4 text-destructive" />
                <span className="text-destructive">Did not run · {failure.sentence}</span>
              </>
            ) : (
              <span className="text-muted-foreground">
                Not run yet. Give it what it needs and run it.
              </span>
            )}
          </p>
          {inputs}
          {view.kind === "none" && !answer && !failure ? null : (
            <div className="flex flex-wrap gap-2">
              <Button type="submit" variant="outline" size="sm" disabled={run.isPending || !ready}>
                <RefreshIcon />
                {run.isPending ? "Running…" : answer || failure ? "Run again" : "Run"}
              </Button>
            </div>
          )}
          {answer?.ok ? (
            <SetupDisclosure label="Show result">
              <CodeBlock
                label="The tool's answer"
                code={runResultText(answer.result)}
                copyLabel="Copy answer"
                wrap
                hint="This is what the integration answered, as your harness will see it."
              />
            </SetupDisclosure>
          ) : failure?.details ? (
            <SetupDisclosure label="Details">
              <CodeBlock
                label="What the run reported"
                code={failure.details}
                copyLabel="Copy details"
                wrap
              />
            </SetupDisclosure>
          ) : null}
        </SetupAppCard>
      </form>
    );
  }

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
          {onward.isPending ? "Continuing…" : "Connect your harness"}
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

/**
 * The done screen's tool card (Setup v2): the tool the record names, run once on arrival as the
 * result step runs it, drawn as an app card with its answer behind *Show result*. Nothing while
 * the tool has not landed, so the finish step can draw it whenever the record names one.
 */
export function ToolResultCard({ state }: { state: SetupStateData }) {
  const context = useQuery(setupToolQuery);
  const recordToolId = state.setup?.toolId ?? null;
  const tool = resultToolOf(recordToolId, context.data?.tool);
  if (!tool || !context.data?.agent) return null;
  return (
    <ToolRun
      key={tool.id}
      state={state}
      context={context.data}
      agentId={context.data.agent.id}
      tool={tool}
      embedded
    />
  );
}
