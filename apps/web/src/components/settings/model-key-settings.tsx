import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type * as React from "react";
import { useState } from "react";
import { toast } from "sonner";

import { RetryNotice } from "@/components/retry-notice";
import { SettingsCard, SettingsRowGroup } from "@/components/settings/settings-card";
import { SettingsEmptyRow, SettingsRow } from "@/components/settings/settings-row";
import { SettingsSection } from "@/components/settings/settings-section";
import { StatusChip } from "@/components/status-chip";
import { Time } from "@/components/time";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
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
  modelQuery,
  removeModelKey,
  setModelKey,
} from "@/lib/model-key-queries";
import { MODEL_ROW_COPY, modelStatusOf, OWN_KEY_ROW, ownKeyModels } from "@/lib/model-status";
import { MODEL_KEY_STATUS_CHIP, MODEL_STATUS_CHIP } from "@/lib/status-chips";

/**
 * Settings › Building tools (GRA-331; Figma 2100:10414): one card holding the Model row (GRA-297)
 * and *Use your own key* (ADR 0014), in the settings row family.
 *
 * The key row shows what is set (the provider, the models, when it was entered) and never the key;
 * entering one is a dialog whose value goes to the server once and is then gone from the page.
 * Removing it sends the person's jobs back to the deployment's fixed model. Set, replace and
 * remove, and the server's field errors, are the behaviour the card had before (GRA-47); only the
 * frame moved, from a card of rows to one row and a dialog.
 *
 * Each row owns its read, so a failed read of one leaves the other drawn, and pending is a
 * skeleton row in its place.
 */
export function ModelKeySettings() {
  return (
    <SettingsSection
      heading="Building tools"
      description="When an agent needs a tool it doesn't have, a model reads the integration's docs and writes one."
    >
      <SettingsCard>
        <SettingsRowGroup>
          <ModelRow />
          <OwnKeyRow />
        </SettingsRowGroup>
      </SettingsCard>
    </SettingsSection>
  );
}

function RowSkeleton() {
  return (
    <SettingsEmptyRow>
      <Skeleton className="h-5 w-40" />
      <Skeleton className="h-7 w-24" />
    </SettingsEmptyRow>
  );
}

function ReadFailure({
  read,
  message,
}: {
  read: { error: unknown; refetch: () => unknown; isFetching: boolean };
  message: string;
}) {
  return (
    <SettingsEmptyRow>
      <p className="text-muted-foreground text-sm">
        <RetryNotice
          error={read.error}
          message={message}
          onRetry={() => void read.refetch()}
          retrying={read.isFetching}
        />
      </p>
    </SettingsEmptyRow>
  );
}

/** What answers the person's jobs, from `GET /me/model`, as `lib/model-status.ts` decides it. */
function ModelRow() {
  const read = useQuery(modelQuery);
  if (read.isPending) return <RowSkeleton />;
  if (read.isError)
    return <ReadFailure read={read} message="Could not load what writes your tools." />;
  const status = modelStatusOf(read.data.model);
  const copy = MODEL_ROW_COPY[status];
  return (
    <SettingsRow
      title="Model"
      description={copy.description}
      action={
        <div className="flex shrink-0 items-center gap-2">
          {copy.value ? <span className="text-sm">{copy.value}</span> : null}
          <StatusChip chip={MODEL_STATUS_CHIP[status]} />
        </div>
      }
    />
  );
}

function OwnKeyRow() {
  const read = useQuery(modelKeyQuery);
  // The dialog is mounted per opening, beside the row rather than inside its branches, so a
  // refetch after the save never unmounts it mid-close (the password row's reason, Greptile on #230).
  const [editing, setEditing] = useState<ModelKey | "new" | null>(null);

  let row: React.ReactNode;
  if (read.isPending) row = <RowSkeleton />;
  else if (read.isError) row = <ReadFailure read={read} message="Could not load your model key." />;
  else {
    const current = read.data.modelKey;
    row = current ? (
      <SettingsRow
        stacked
        title={OWN_KEY_ROW.title}
        description={
          <>
            {MODEL_KEY_PROVIDERS.find((p) => p.value === current.provider)?.label} key, set{" "}
            <Time iso={current.setAt} />. {ownKeyModels(current)}
          </>
        }
        action={
          <div className="flex flex-wrap items-center gap-2">
            <StatusChip chip={MODEL_KEY_STATUS_CHIP.set} />
            <Button variant="outline" size="sm" onClick={() => setEditing(current)}>
              Replace
            </Button>
            <RemoveKeyButton />
          </div>
        }
      />
    ) : (
      <SettingsRow
        stacked
        title={OWN_KEY_ROW.title}
        description={OWN_KEY_ROW.description}
        action={
          <Button variant="outline" size="sm" onClick={() => setEditing("new")}>
            Add a key
          </Button>
        }
      />
    );
  }

  return (
    <>
      {row}
      {editing ? (
        <ModelKeyDialog
          current={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </>
  );
}

function ModelKeyDialog({ current, onClose }: { current: ModelKey | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const replacing = current !== null;
  const [open, setOpen] = useState(true);
  const [provider, setProvider] = useState<ModelKeyProvider>(current?.provider ?? "anthropic");
  const [apiKey, setApiKey] = useState("");
  const [authoringModel, setAuthoringModel] = useState(current?.authoringModel ?? "");
  const [triageModel, setTriageModel] = useState(current?.triageModel ?? "");
  const [baseUrl, setBaseUrl] = useState(current?.baseUrl ?? "");
  const [error, setError] = useState<{ field?: string; message: string } | null>(null);

  const save = useMutation({
    mutationFn: setModelKey,
    onSuccess: ({ warning }) => {
      queryClient.invalidateQueries({ queryKey: modelKeyKeys.current });
      queryClient.invalidateQueries({ queryKey: modelKeyKeys.model });
      const title = replacing ? "Your model key is replaced" : "Your model key is set";
      // The provider could not be asked, so the key is saved unchecked (GRA-340).
      if (warning) toast.warning(title, { description: warning });
      else {
        toast.success(title, { description: "Your next acquire job runs on your provider." });
      }
      setApiKey("");
      setOpen(false);
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
  const text = (
    id: string,
    label: string,
    value: string,
    onChange: (value: string) => void,
    options: { description?: string; placeholder?: string; field: string },
  ) => (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        placeholder={options.placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={save.isPending}
        aria-invalid={errorFor(options.field) ? true : undefined}
      />
      {options.description ? <FieldDescription>{options.description}</FieldDescription> : null}
      {errorFor(options.field) ? <FieldError>{errorFor(options.field)}</FieldError> : null}
    </Field>
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!save.isPending) setOpen(next);
      }}
      onOpenChangeComplete={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="sm:max-w-md" showCloseButton={!save.isPending}>
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>{replacing ? "Replace your key" : "Add your own key"}</DialogTitle>
            <DialogDescription>
              Your acquire jobs run on your provider with this key, and the documentation they read
              goes to it rather than to Graft's model. Never shown again once entered.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="model-key-provider">Provider</FieldLabel>
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
                  className="w-full"
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
              {errorFor("provider") ? <FieldError>{errorFor("provider")}</FieldError> : null}
            </Field>
            <Field>
              <FieldLabel htmlFor="model-key-api-key">API key</FieldLabel>
              <Input
                id="model-key-api-key"
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                disabled={save.isPending}
                aria-invalid={errorFor("apiKey") ? true : undefined}
              />
              <FieldDescription>
                {hint} Sent once, encrypted at rest, never shown again.
              </FieldDescription>
              {errorFor("apiKey") ? <FieldError>{errorFor("apiKey")}</FieldError> : null}
            </Field>
            {text("model-key-authoring", "Authoring model", authoringModel, setAuthoringModel, {
              field: "authoringModel",
              placeholder: "Provider default",
              description: "The model that writes the tool. Blank keeps the provider's default.",
            })}
            {text("model-key-triage", "Triage model", triageModel, setTriageModel, {
              field: "triageModel",
              placeholder: "Provider default",
              description:
                "The cheap model that reads documentation first. Blank keeps the provider's default.",
            })}
            {provider === "openai"
              ? text("model-key-base-url", "Base URL", baseUrl, setBaseUrl, {
                  field: "baseUrl",
                  placeholder: "https://…",
                  description: "Only for an OpenAI-compatible gateway; blank for OpenAI itself.",
                })
              : null}
            {error && !error.field ? <FieldError>{error.message}</FieldError> : null}
          </FieldGroup>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={save.isPending}
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending
                ? replacing
                  ? "Replacing…"
                  : "Saving…"
                : replacing
                  ? "Replace key"
                  : "Save key"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * No `onError` of its own: the mutation cache already toasts a failed mutation's sentence
 * (`lib/query-client.ts`).
 */
function RemoveKeyButton() {
  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: removeModelKey,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: modelKeyKeys.current });
      queryClient.invalidateQueries({ queryKey: modelKeyKeys.model });
      toast.success("Your model key is removed", {
        description: "Your acquire jobs run on Graft's fixed model again.",
      });
    },
  });
  return (
    <Button variant="ghost" size="sm" onClick={() => remove.mutate()} disabled={remove.isPending}>
      {remove.isPending ? "Removing…" : "Remove"}
    </Button>
  );
}
