import { GlobeIcon } from "lucide-react";

import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  type ConnectionDraft,
  type DraftErrors,
  hostsOf,
  isScheme,
  parametersFor,
  SCHEME_LABELS,
  SCHEMES,
  withScheme,
} from "@/lib/connection-form";
import { cn } from "@/lib/utils";

/**
 * The non-secret half of a connection (ADR 0006: everything the handoff carries): the vendor slug,
 * the name, the primary host and the additional hosts, the scheme and its parameters — each input
 * judged by the service's own rule as the person types (`lib/connection-form.ts`). The secret half
 * is `credential-fields.tsx`, kept apart so the credential ask can show it alone.
 */
export function ConnectionFormFields({
  draft,
  onChange,
  errors,
  idPrefix,
  disabled,
}: {
  draft: ConnectionDraft;
  onChange: (next: ConnectionDraft) => void;
  errors: DraftErrors;
  idPrefix: string;
  disabled?: boolean;
}) {
  const id = (name: string) => `${idPrefix}-${name}`;
  const invalid = (key: string) => (errors[key] ? true : undefined);
  const parameters = parametersFor(draft.scheme);

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field data-invalid={invalid("vendor")}>
          <FieldLabel htmlFor={id("vendor")}>Vendor</FieldLabel>
          <Input
            id={id("vendor")}
            value={draft.vendor}
            disabled={disabled}
            placeholder="unleashed"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={invalid("vendor")}
            onChange={(event) => onChange({ ...draft, vendor: event.target.value })}
          />
          <FieldDescription>
            A kebab-case slug. Tools authored against this connection are bound to it.
          </FieldDescription>
          {errors.vendor ? <FieldError>{errors.vendor}</FieldError> : null}
        </Field>
        <Field data-invalid={invalid("displayName")}>
          <FieldLabel htmlFor={id("displayName")}>Name</FieldLabel>
          <Input
            id={id("displayName")}
            value={draft.displayName}
            disabled={disabled}
            placeholder="Acme Unleashed (production)"
            autoComplete="off"
            aria-invalid={invalid("displayName")}
            onChange={(event) => onChange({ ...draft, displayName: event.target.value })}
          />
          <FieldDescription>What you and your agents will see.</FieldDescription>
          {errors.displayName ? <FieldError>{errors.displayName}</FieldError> : null}
        </Field>
      </div>

      <Field data-invalid={invalid("primaryHost")}>
        <FieldLabel htmlFor={id("primaryHost")}>Primary host</FieldLabel>
        <Input
          id={id("primaryHost")}
          value={draft.primaryHost}
          disabled={disabled}
          placeholder="https://api.vendor.example/v1"
          autoComplete="off"
          spellCheck={false}
          inputMode="url"
          className="font-mono"
          aria-invalid={invalid("primaryHost")}
          onChange={(event) => onChange({ ...draft, primaryHost: event.target.value })}
        />
        <FieldDescription>
          The https base URL vendor paths resolve against. Private, loopback, link-local and
          cloud-metadata hosts are refused here and again by the proxy.
        </FieldDescription>
        {errors.primaryHost ? <FieldError>{errors.primaryHost}</FieldError> : null}
      </Field>

      <Field data-invalid={invalid("hosts")}>
        <FieldLabel htmlFor={id("hosts")}>
          Additional hosts
          <span className="font-normal text-muted-foreground">(optional)</span>
        </FieldLabel>
        <Textarea
          id={id("hosts")}
          value={draft.hosts}
          disabled={disabled}
          placeholder={"files.vendor.example\nupload.vendor.example"}
          autoComplete="off"
          spellCheck={false}
          className="min-h-12 font-mono"
          aria-invalid={invalid("hosts")}
          onChange={(event) => onChange({ ...draft, hosts: event.target.value })}
        />
        <FieldDescription>
          One hostname per line, for a vendor whose API spans several. The primary's own host is
          always included.
        </FieldDescription>
        {errors.hosts ? <FieldError>{errors.hosts}</FieldError> : null}
      </Field>

      <Field>
        <FieldLabel htmlFor={id("scheme")}>Auth scheme</FieldLabel>
        <select
          id={id("scheme")}
          value={draft.scheme}
          disabled={disabled}
          className={cn(
            "h-8 w-full min-w-0 rounded-none border border-input bg-transparent px-2 py-1 text-xs outline-none transition-colors focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30",
          )}
          onChange={(event) => {
            const next = event.target.value;
            if (isScheme(next)) onChange(withScheme(draft, next));
          }}
        >
          {SCHEMES.map((scheme) => (
            <option key={scheme} value={scheme}>
              {SCHEME_LABELS[scheme]} · {scheme}
            </option>
          ))}
        </select>
        <FieldDescription>
          How the proxy presents the credential to the vendor. The secret fields below follow it.
        </FieldDescription>
      </Field>

      {parameters.length > 0 ? (
        <div className="grid gap-4 sm:grid-cols-2">
          {parameters.map((parameter) => {
            const key = `schemeConfig.${parameter.name}`;
            return (
              <Field key={parameter.name} data-invalid={invalid(key)}>
                <FieldLabel htmlFor={id(key)}>
                  {parameter.presentation.label}
                  {parameter.required ? null : (
                    <span className="font-normal text-muted-foreground">(optional)</span>
                  )}
                </FieldLabel>
                <Input
                  id={id(key)}
                  value={draft.schemeConfig[parameter.name] ?? ""}
                  disabled={disabled}
                  autoComplete="off"
                  spellCheck={false}
                  className="font-mono"
                  aria-invalid={invalid(key)}
                  onChange={(event) =>
                    onChange({
                      ...draft,
                      schemeConfig: { ...draft.schemeConfig, [parameter.name]: event.target.value },
                    })
                  }
                />
                {parameter.presentation.hint ? (
                  <FieldDescription>{parameter.presentation.hint}</FieldDescription>
                ) : null}
                {errors[key] ? <FieldError>{errors[key]}</FieldError> : null}
              </Field>
            );
          })}
        </div>
      ) : null}
      {errors.schemeConfig ? <FieldError>{errors.schemeConfig}</FieldError> : null}
    </>
  );
}

/**
 * Where the credential will go, as the form stands — every host the proxy will pin the connection
 * to (ADR 0010), named beside the secret inputs so the person reads them before typing (ADR 0006).
 */
export function HostsNotice({ draft }: { draft: ConnectionDraft }) {
  const hosts = hostsOf(draft);
  return (
    <div className="flex items-start gap-2 rounded-md border bg-muted/40 p-3 text-xs">
      <GlobeIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="flex flex-col gap-1">
        <p className="font-medium">
          {hosts
            ? "The credential will be sent to these hosts and to nothing else:"
            : "Fix the hosts above to see where the credential will be sent."}
        </p>
        {hosts ? (
          <ul className="flex flex-wrap gap-1.5">
            {hosts.map((host) => (
              <li key={host}>
                <code className="rounded bg-background px-1.5 py-0.5 font-mono">{host}</code>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}
