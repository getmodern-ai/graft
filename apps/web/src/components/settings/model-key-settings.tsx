import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type * as React from "react";
import { useState } from "react";
import { toast } from "sonner";

import { RetryNotice } from "@/components/retry-notice";
import { SettingsCard, SettingsRowGroup } from "@/components/settings/settings-card";
import {
  SettingsButtonRow,
  SettingsEmptyRow,
  SettingsRow,
} from "@/components/settings/settings-row";
import { SettingsSection } from "@/components/settings/settings-section";
import { StatusChip } from "@/components/status-chip";
import { Time } from "@/components/time";
import { Button } from "@/components/ui/button";
import { FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError } from "@/lib/api";
import {
  MODEL_KEY_PROVIDERS,
  type ModelKey,
  type ModelKeyProvider,
  modelKeyKeys,
  modelKeyQuery,
  removeModelKey,
  setModelKey,
} from "@/lib/model-key-queries";
import { MODEL_KEY_STATUS_CHIP } from "@/lib/status-chips";

/**
 * Bring your own model key (ADR 0014): the one setting a person has today, as a section of
 * Cando's settings row family (GRA-47) — a heading, one card, and a row per fact or field.
 *
 * The card shows what is set — the provider, the model ids, when the key was entered — and never
 * the key; entering one is a form whose value goes to the server once and is then gone from the
 * page. Removing it sends the person's jobs back to the deployment's fixed model. Set, replace and
 * remove, and the server's field errors, are the behaviour `model-key-card.tsx` had before the
 * rows; only the frame changed.
 *
 * The read is the section's own, so a pending key is skeleton rows and a failed read is a
 * `RetryNotice` in the section's place — pending is its own state, as it is for every table.
 */
export function ModelKeySettings() {
  const read = useQuery(modelKeyQuery);
  const [editing, setEditing] = useState(false);

  let content: React.ReactNode;
  if (read.isPending) {
    content = (
      <SettingsCard>
        <SettingsRowGroup>
          {[0, 1].map((row) => (
            <SettingsEmptyRow key={row}>
              <Skeleton className="h-5 w-40" />
              <Skeleton className="h-5 w-16" />
            </SettingsEmptyRow>
          ))}
        </SettingsRowGroup>
      </SettingsCard>
    );
  } else if (read.isError) {
    content = (
      <p className="text-muted-foreground text-sm">
        <RetryNotice
          error={read.error}
          message="Could not load your model key."
          onRetry={() => void read.refetch()}
          retrying={read.isFetching}
        />
      </p>
    );
  } else if (read.data.modelKey && !editing) {
    content = <ModelKeyView current={read.data.modelKey} onReplace={() => setEditing(true)} />;
  } else {
    const current = read.data.modelKey;
    content = (
      <ModelKeyForm
        initialProvider={current?.provider ?? "anthropic"}
        initialAuthoring={current?.authoringModel ?? ""}
        initialTriage={current?.triageModel ?? ""}
        initialBaseUrl={current?.baseUrl ?? ""}
        replacing={current !== null}
        onDone={() => setEditing(false)}
      />
    );
  }

  return <SettingsSection heading="Model">{content}</SettingsSection>;
}

/** The two-sentence account of what the key does, above whichever rows follow it. */
const KEY_DESCRIPTION =
  "Your acquire jobs run on your provider with this key, and the documentation they read goes to it rather than to Graft's model. Never shown again once entered.";

function ModelKeyView({ current, onReplace }: { current: ModelKey; onReplace: () => void }) {
  const provider = MODEL_KEY_PROVIDERS.find((p) => p.value === current.provider);
  return (
    <SettingsCard>
      <SettingsRowGroup>
        <SettingsRow
          title="Your own model key"
          description={KEY_DESCRIPTION}
          action={<StatusChip chip={MODEL_KEY_STATUS_CHIP.set} />}
        />
        <SettingsRow title="Provider" action={<Value>{provider?.label}</Value>} />
        <SettingsRow
          title="Authoring model"
          description="The model that writes the tool."
          action={
            <Value mono={current.authoringModel !== null}>
              {current.authoringModel ?? "Provider default"}
            </Value>
          }
        />
        <SettingsRow
          title="Triage model"
          description="The cheap model that reads documentation first."
          action={
            <Value mono={current.triageModel !== null}>
              {current.triageModel ?? "Provider default"}
            </Value>
          }
        />
        {current.baseUrl ? (
          <SettingsRow
            title="Base URL"
            description="The OpenAI-compatible gateway the key is for."
            action={<Value mono>{current.baseUrl}</Value>}
          />
        ) : null}
        <SettingsRow
          title="Key set"
          action={
            <Value>
              <Time iso={current.setAt} />
            </Value>
          }
        />
        <SettingsButtonRow
          stacked
          title="Replace or remove the key"
          description="A new key is sent once, like the first; removing it sends your acquire jobs back to Graft's fixed model."
          action={
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={onReplace}>
                Replace key
              </Button>
              <RemoveKeyButton />
            </div>
          }
        />
      </SettingsRowGroup>
    </SettingsCard>
  );
}

/** A fact on the row's right, in the row's own size; mono for a model id or a URL. */
function Value({ mono, children }: { mono?: boolean; children: React.ReactNode }) {
  return <span className={mono ? "font-mono text-sm" : "text-sm"}>{children}</span>;
}

/** The id the row's title carries, which every control in that row names itself by. */
const labelId = (id: string) => `${id}-label`;

/**
 * A field as a settings row: the label and its sentence on the left, the control — 240px from
 * `md`, full width below — and the server's error for it on the right. `SettingsRow` with
 * `stacked` rather than `SettingsFieldRow`, because these rows carry a description and an error
 * line, and a fixed 64px row has room for neither. The control names itself by the title's id
 * (`labelId`); a `<div>` beside a control is proximity, not a label.
 */
function KeyFieldRow({
  id,
  title,
  description,
  error,
  children,
}: {
  id: string;
  title: string;
  description?: React.ReactNode;
  error: string | null;
  children: React.ReactNode;
}) {
  return (
    <SettingsRow
      stacked
      title={<span id={labelId(id)}>{title}</span>}
      description={description}
      action={
        <div className="flex w-full flex-col gap-1.5 md:w-60">
          {children}
          {error ? <FieldError>{error}</FieldError> : null}
        </div>
      }
    />
  );
}

function ModelKeyForm({
  initialProvider,
  initialAuthoring,
  initialTriage,
  initialBaseUrl,
  replacing,
  onDone,
}: {
  initialProvider: ModelKeyProvider;
  initialAuthoring: string;
  initialTriage: string;
  initialBaseUrl: string;
  replacing: boolean;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const [provider, setProvider] = useState<ModelKeyProvider>(initialProvider);
  const [apiKey, setApiKey] = useState("");
  const [authoringModel, setAuthoringModel] = useState(initialAuthoring);
  const [triageModel, setTriageModel] = useState(initialTriage);
  const [baseUrl, setBaseUrl] = useState(initialBaseUrl);
  const [error, setError] = useState<{ field?: string; message: string } | null>(null);

  const save = useMutation({
    mutationFn: setModelKey,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: modelKeyKeys.current });
      toast.success(replacing ? "Your model key is replaced" : "Your model key is set", {
        description: "Your next acquire job runs on your provider.",
      });
      setApiKey("");
      onDone();
    },
    onError: (failure) => {
      const details =
        failure instanceof ApiError && failure.details && typeof failure.details === "object"
          ? (failure.details as { field?: string })
          : {};
      setError({ field: details.field, message: failure.message });
    },
  });

  const submit = () => {
    const trimmed = apiKey.trim();
    if (trimmed.length === 0) {
      setError({ field: "apiKey", message: "Enter the key." });
      return;
    }
    setError(null);
    save.mutate({
      provider,
      apiKey: trimmed,
      authoringModel: authoringModel.trim() || null,
      triageModel: triageModel.trim() || null,
      baseUrl: baseUrl.trim() || null,
    });
  };

  const hint = MODEL_KEY_PROVIDERS.find((p) => p.value === provider)?.keyHint;
  const errorFor = (field: string) => (error?.field === field ? error.message : null);
  const control = "w-full md:w-60";

  return (
    <SettingsCard>
      {/* The form wraps the group rather than sitting inside it: the group's inset dividers are
          drawn between its direct children, and a `<form>` among the rows would take one divider
          for itself and leave the rows inside it undivided. */}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <SettingsRowGroup>
          <SettingsRow
            title="Your own model key"
            description={KEY_DESCRIPTION}
            action={<StatusChip chip={MODEL_KEY_STATUS_CHIP[replacing ? "set" : "unset"]} />}
          />
          <KeyFieldRow id="model-key-provider" title="Provider" error={errorFor("provider")}>
            <Select
              value={provider}
              items={MODEL_KEY_PROVIDERS}
              disabled={save.isPending}
              onValueChange={(next) => {
                const option = MODEL_KEY_PROVIDERS.find((candidate) => candidate.value === next);
                if (option) setProvider(option.value);
              }}
            >
              <SelectTrigger
                id="model-key-provider"
                className={control}
                aria-labelledby={labelId("model-key-provider")}
                aria-invalid={errorFor("provider") ? true : undefined}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MODEL_KEY_PROVIDERS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </KeyFieldRow>
          <KeyFieldRow
            id="model-key-api-key"
            title="API key"
            description={`${hint} Sent once, encrypted at rest, never shown again.`}
            error={errorFor("apiKey")}
          >
            <Input
              id="model-key-api-key"
              className={control}
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              disabled={save.isPending}
              aria-labelledby={labelId("model-key-api-key")}
              aria-invalid={errorFor("apiKey") ? true : undefined}
            />
          </KeyFieldRow>
          <KeyFieldRow
            id="model-key-authoring"
            title="Authoring model"
            description="The model that writes the tool. Blank keeps the provider's default."
            error={errorFor("authoringModel")}
          >
            <Input
              id="model-key-authoring"
              className={control}
              placeholder="Provider default"
              value={authoringModel}
              onChange={(event) => setAuthoringModel(event.target.value)}
              disabled={save.isPending}
              aria-labelledby={labelId("model-key-authoring")}
              aria-invalid={errorFor("authoringModel") ? true : undefined}
            />
          </KeyFieldRow>
          <KeyFieldRow
            id="model-key-triage"
            title="Triage model"
            description="The cheap model that reads documentation first. Blank keeps the provider's default."
            error={errorFor("triageModel")}
          >
            <Input
              id="model-key-triage"
              className={control}
              placeholder="Provider default"
              value={triageModel}
              onChange={(event) => setTriageModel(event.target.value)}
              disabled={save.isPending}
              aria-labelledby={labelId("model-key-triage")}
              aria-invalid={errorFor("triageModel") ? true : undefined}
            />
          </KeyFieldRow>
          {provider === "openai" ? (
            <KeyFieldRow
              id="model-key-base-url"
              title="Base URL"
              description="Only for an OpenAI-compatible gateway; blank for OpenAI itself."
              error={errorFor("baseUrl")}
            >
              <Input
                id="model-key-base-url"
                className={control}
                placeholder="https://…"
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
                disabled={save.isPending}
                aria-labelledby={labelId("model-key-base-url")}
                aria-invalid={errorFor("baseUrl") ? true : undefined}
              />
            </KeyFieldRow>
          ) : null}
          <SettingsEmptyRow className="flex-wrap justify-end gap-2">
            {error && !error.field ? (
              <FieldError className="mr-auto">{error.message}</FieldError>
            ) : null}
            {replacing ? (
              <Button type="button" variant="ghost" onClick={onDone} disabled={save.isPending}>
                Cancel
              </Button>
            ) : null}
            <Button type="submit" disabled={save.isPending}>
              {save.isPending
                ? replacing
                  ? "Replacing…"
                  : "Setting…"
                : replacing
                  ? "Replace key"
                  : "Set key"}
            </Button>
          </SettingsEmptyRow>
        </SettingsRowGroup>
      </form>
    </SettingsCard>
  );
}

/**
 * No `onError` of its own: the mutation cache already toasts a failed mutation's sentence
 * (`lib/query-client.ts`), and the card used to toast it a second time on top.
 */
function RemoveKeyButton() {
  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: removeModelKey,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: modelKeyKeys.current });
      toast.success("Your model key is removed", {
        description: "Your acquire jobs run on Graft's fixed model again.",
      });
    },
  });
  return (
    <Button variant="ghost" onClick={() => remove.mutate()} disabled={remove.isPending}>
      {remove.isPending ? "Removing…" : "Remove key"}
    </Button>
  );
}
