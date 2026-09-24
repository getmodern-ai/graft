import type { AuthScheme } from "@graft/proxy/types";

import { LanguageIcon } from "@/components/icons";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  type ConnectionDraft,
  type DraftErrors,
  hostsNoticeTitle,
  hostsOf,
  isScheme,
  parametersFor,
  SCHEME_LABELS,
  SCHEMES,
  withScheme,
} from "@/lib/connection-form";

/** What a scheme is called in the picker: the person's words, then the wire name it maps to. */
const schemeOption = (scheme: AuthScheme) => `${SCHEME_LABELS[scheme]} · ${scheme}`;
const SCHEME_ITEMS = SCHEMES.map((scheme) => ({ value: scheme, label: schemeOption(scheme) }));

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
        <Select
          value={draft.scheme}
          items={SCHEME_ITEMS}
          disabled={disabled}
          onValueChange={(next) => {
            if (next !== null && isScheme(next)) onChange(withScheme(draft, next));
          }}
        >
          <SelectTrigger id={id("scheme")} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SCHEMES.map((scheme) => (
              <SelectItem key={scheme} value={scheme}>
                {schemeOption(scheme)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
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
 * The title follows the scheme (`hostsNoticeTitle`): a keyless scheme has no credential to send, so
 * it says the vendor is reached there. An `Alert`, the primitive's own frame, as every notice in
 * this form is, but a `note` rather than the primitive's `alert` (GRA-212): it is standing
 * information that re-renders as the hosts are typed, and an assertive live region would
 * interrupt a screen reader on every render.
 */
export function HostsNotice({ draft }: { draft: ConnectionDraft }) {
  const hosts = hostsOf(draft);
  return (
    <Alert role="note">
      <LanguageIcon />
      <AlertTitle>{hostsNoticeTitle(draft)}</AlertTitle>
      {hosts ? (
        <AlertDescription>
          <ul className="flex flex-wrap gap-1.5">
            {hosts.map((host) => (
              <li key={host}>
                <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{host}</code>
              </li>
            ))}
          </ul>
        </AlertDescription>
      ) : null}
    </Alert>
  );
}
