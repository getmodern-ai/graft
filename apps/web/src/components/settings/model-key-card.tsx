import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { KeyRoundIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Time } from "@/components/time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ApiError } from "@/lib/api";
import {
  MODEL_KEY_PROVIDERS,
  type ModelKeyProvider,
  modelKeyKeys,
  modelKeyQuery,
  removeModelKey,
  setModelKey,
} from "@/lib/model-key-queries";

/**
 * Bring your own model key (ADR 0014): the one setting a person has today. The card shows what is
 * set — the provider, the model ids, when the key was entered — and never the key; entering one is
 * a form whose value goes to the server once and is then gone from the page. Removing it sends the
 * person's jobs back to the deployment's fixed model.
 */
export function ModelKeyCard() {
  const { data } = useSuspenseQuery(modelKeyQuery);
  const [editing, setEditing] = useState(false);
  const current = data.modelKey;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <KeyRoundIcon className="size-4" />
          Your own model key
          {current ? (
            <Badge variant="secondary">set</Badge>
          ) : (
            <Badge variant="outline">not set</Badge>
          )}
        </CardTitle>
        <CardDescription>
          When set, every <code className="font-mono">acquire</code> job of yours runs on your
          provider with this key, and the vendor documentation those jobs read goes to your provider
          rather than Graft's. Without one, Graft's fixed model authors for you. The key is never
          shown again after you enter it.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {current && !editing ? (
          <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
            <dt className="text-muted-foreground">Provider</dt>
            <dd>{MODEL_KEY_PROVIDERS.find((p) => p.value === current.provider)?.label}</dd>
            <dt className="text-muted-foreground">Authoring model</dt>
            <dd className="font-mono">{current.authoringModel ?? "provider default"}</dd>
            <dt className="text-muted-foreground">Triage model</dt>
            <dd className="font-mono">{current.triageModel ?? "provider default"}</dd>
            {current.baseUrl ? (
              <>
                <dt className="text-muted-foreground">Base URL</dt>
                <dd className="font-mono">{current.baseUrl}</dd>
              </>
            ) : null}
            <dt className="text-muted-foreground">Key set</dt>
            <dd>
              <Time iso={current.setAt} />
            </dd>
          </dl>
        ) : (
          <ModelKeyForm
            initialProvider={current?.provider ?? "anthropic"}
            initialAuthoring={current?.authoringModel ?? ""}
            initialTriage={current?.triageModel ?? ""}
            initialBaseUrl={current?.baseUrl ?? ""}
            replacing={current !== null}
            onDone={() => setEditing(false)}
          />
        )}
      </CardContent>
      {current && !editing ? (
        <CardFooter className="gap-2">
          <Button variant="outline" onClick={() => setEditing(true)}>
            Replace key
          </Button>
          <RemoveKeyButton />
        </CardFooter>
      ) : null}
    </Card>
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

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="model-key-provider">Provider</FieldLabel>
          <select
            id="model-key-provider"
            className="h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
            value={provider}
            onChange={(event) => setProvider(event.target.value as ModelKeyProvider)}
            disabled={save.isPending}
          >
            {MODEL_KEY_PROVIDERS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          {errorFor("provider") ? <FieldError>{errorFor("provider")}</FieldError> : null}
        </Field>
        <Field data-invalid={errorFor("apiKey") ? true : undefined}>
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
        <div className="grid gap-4 sm:grid-cols-2">
          <Field data-invalid={errorFor("authoringModel") ? true : undefined}>
            <FieldLabel htmlFor="model-key-authoring">Authoring model</FieldLabel>
            <Input
              id="model-key-authoring"
              placeholder="provider default"
              value={authoringModel}
              onChange={(event) => setAuthoringModel(event.target.value)}
              disabled={save.isPending}
            />
            <FieldDescription>
              The model that writes the tool. Blank keeps the default.
            </FieldDescription>
            {errorFor("authoringModel") ? (
              <FieldError>{errorFor("authoringModel")}</FieldError>
            ) : null}
          </Field>
          <Field data-invalid={errorFor("triageModel") ? true : undefined}>
            <FieldLabel htmlFor="model-key-triage">Triage model</FieldLabel>
            <Input
              id="model-key-triage"
              placeholder="provider default"
              value={triageModel}
              onChange={(event) => setTriageModel(event.target.value)}
              disabled={save.isPending}
            />
            <FieldDescription>The cheap model that reads documentation first.</FieldDescription>
            {errorFor("triageModel") ? <FieldError>{errorFor("triageModel")}</FieldError> : null}
          </Field>
        </div>
        {provider === "openai" ? (
          <Field data-invalid={errorFor("baseUrl") ? true : undefined}>
            <FieldLabel htmlFor="model-key-base-url">Base URL</FieldLabel>
            <Input
              id="model-key-base-url"
              placeholder="https://… — only for an OpenAI-compatible gateway"
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              disabled={save.isPending}
            />
            <FieldDescription>Leave blank for OpenAI itself.</FieldDescription>
            {errorFor("baseUrl") ? <FieldError>{errorFor("baseUrl")}</FieldError> : null}
          </Field>
        ) : null}
        {error && !error.field ? <FieldError>{error.message}</FieldError> : null}
      </FieldGroup>
      <div className="flex gap-2">
        <Button type="submit" disabled={save.isPending}>
          {replacing ? "Replace key" : "Set key"}
        </Button>
        {replacing ? (
          <Button type="button" variant="ghost" onClick={onDone} disabled={save.isPending}>
            Cancel
          </Button>
        ) : null}
      </div>
    </form>
  );
}

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
    onError: (failure) => toast.error(failure.message),
  });
  return (
    <Button variant="ghost" onClick={() => remove.mutate()} disabled={remove.isPending}>
      Remove key
    </Button>
  );
}
