import type { AuthScheme } from "@graft/proxy/types";
import { useEffect, useState } from "react";

import { ConnectionField } from "@/components/connection/connection-field";
import { CredentialFields } from "@/components/connection/credential-fields";
import { OAuthClientNotice } from "@/components/connection/oauth-client-notice";
import { KeyboardArrowDownIcon, LanguageIcon } from "@/components/icons";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
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
  credentialFieldsFor,
  type DraftErrors,
  hostsNoticeTitle,
  hostsOf,
  isScheme,
  parametersFor,
  SCHEME_LABELS,
  SCHEMES,
  withScheme,
} from "@/lib/connection-form";
import { cn } from "@/lib/utils";

/** What a scheme is called in the picker: the person's words, then the wire name it maps to. */
const schemeOption = (scheme: AuthScheme) => `${SCHEME_LABELS[scheme]} · ${scheme}`;
const SCHEME_ITEMS = SCHEMES.map((scheme) => ({ value: scheme, label: schemeOption(scheme) }));

type ConnectionFormProps = {
  draft: ConnectionDraft;
  onChange: (next: ConnectionDraft) => void;
  errors: DraftErrors;
  idPrefix: string;
  disabled?: boolean;
};

function groupFields(fields: { name: string; value: string; required: boolean }[]) {
  const groups: { required: string[]; prefilled: string[]; optional: string[] } = {
    required: [],
    prefilled: [],
    optional: [],
  };
  for (const field of fields) {
    const group = field.value.trim() ? "prefilled" : field.required ? "required" : "optional";
    groups[group].push(field.name);
  }
  return groups;
}

function groupParameters(draft: ConnectionDraft) {
  return {
    scheme: draft.scheme,
    ...groupFields(
      parametersFor(draft.scheme).map((field) => ({
        ...field,
        name: `schemeConfig.${field.name}`,
        value: draft.schemeConfig[field.name] ?? "",
      })),
    ),
  };
}

/** Required entry comes first; the opening values determine each detail's section (ADR 0006). */
export function ConnectionForm(props: ConnectionFormProps) {
  const { draft, onChange, errors, idPrefix, disabled } = props;
  // Hold only field names, so typing never moves a field or copies a credential into this state.
  const [details] = useState(() =>
    groupFields([
      { name: "vendor", value: draft.vendor, required: true },
      {
        name: "primaryHost",
        value: draft.primaryHost.trim() === "https://" ? "" : draft.primaryHost,
        required: true,
      },
      { name: "hosts", value: draft.hosts, required: false },
      { name: "scheme", value: draft.scheme, required: true },
    ]),
  );
  const [parameters, setParameters] = useState(() => groupParameters(draft));
  // A different scheme has fresh parameters; the other details keep their original sections.
  if (parameters.scheme !== draft.scheme) setParameters(groupParameters(draft));

  const required = ["displayName", ...details.required, ...parameters.required];
  const prefilled = [...details.prefilled, ...parameters.prefilled];
  const optional = [...details.optional, ...parameters.optional];
  const credentials = credentialFieldsFor(draft.scheme);
  const hasOptional = optional.length > 0 || credentials.some((field) => !field.required);
  const [showPrefilled, setShowPrefilled] = useState(false);
  useEffect(() => {
    const hasPrefilledErrors = [...details.prefilled, ...parameters.prefilled].some(
      (name) => errors[name] || (name.startsWith("schemeConfig.") && errors.schemeConfig),
    );
    if (hasPrefilledErrors) setShowPrefilled(true);
  }, [errors, details.prefilled, parameters.prefilled]);
  const credentialProps = {
    scheme: draft.scheme,
    value: draft.credential,
    onChange: (credential: Record<string, string>) => onChange({ ...draft, credential }),
    errors,
    idPrefix,
    disabled,
  };

  return (
    <>
      <HostsNotice draft={draft} />
      <FieldDescription>
        Complete the required fields. Expand prefilled details to review or edit them.
      </FieldDescription>
      <FieldSet>
        <FieldLegend className="w-full border-border border-b pb-2">Required fields</FieldLegend>
        <FieldGroup>
          <OAuthClientNotice draft={draft} />
          <ConnectionFormFields {...props} fieldNames={required} />
          <CredentialFields {...credentialProps} include="required" />
        </FieldGroup>
      </FieldSet>
      {credentials.length === 0 ? <CredentialFields {...credentialProps} /> : null}
      {prefilled.length > 0 ? (
        <FieldSet>
          <FieldLegend className="mb-0 w-full">
            <Button
              type="button"
              variant="ghost"
              className="-ml-2.5 h-auto justify-start py-1 aria-expanded:bg-transparent"
              aria-expanded={showPrefilled}
              aria-controls={`${idPrefix}-prefilled-details`}
              onClick={() => setShowPrefilled((open) => !open)}
            >
              <KeyboardArrowDownIcon className={showPrefilled ? undefined : "-rotate-90"} />
              Prefilled details
            </Button>
          </FieldLegend>
          {/* Keep controls mounted so collapsing preserves each field's editing state. */}
          <FieldGroup
            id={`${idPrefix}-prefilled-details`}
            hidden={!showPrefilled}
            className={cn("pt-4", !showPrefilled && "hidden")}
          >
            <ConnectionFormFields {...props} fieldNames={prefilled} />
          </FieldGroup>
        </FieldSet>
      ) : null}
      {hasOptional ? (
        <FieldSet>
          <FieldLegend className="w-full border-border border-b pb-2">Optional fields</FieldLegend>
          <FieldGroup>
            <ConnectionFormFields {...props} fieldNames={optional} />
            <CredentialFields {...credentialProps} include="optional" />
          </FieldGroup>
        </FieldSet>
      ) : null}
      {errors.schemeConfig ? <FieldError>{errors.schemeConfig}</FieldError> : null}
    </>
  );
}

/**
 * The non-secret half of a connection (ADR 0006: everything the handoff carries): the vendor slug,
 * the name, the primary host and the additional hosts, the scheme and its parameters — each input
 * judged by the service's own rule as the person types (`lib/connection-form.ts`). The secret half
 * is `credential-fields.tsx`, kept apart so the credential ask can show it alone.
 */
function ConnectionFormFields({
  draft,
  onChange,
  errors,
  idPrefix,
  disabled,
  fieldNames,
}: ConnectionFormProps & { fieldNames: string[] }) {
  const id = (name: string) => `${idPrefix}-${name}`;
  const show = (name: string) => fieldNames.includes(name);
  const parameters = parametersFor(draft.scheme).filter((field) =>
    show(`schemeConfig.${field.name}`),
  );

  return (
    <>
      {show("vendor") || show("displayName") ? (
        <div
          className={cn("grid gap-4", show("vendor") && show("displayName") && "sm:grid-cols-2")}
        >
          {show("displayName") ? (
            <ConnectionField
              id={id("displayName")}
              label="Name"
              value={draft.displayName}
              required
              alwaysEditable
              disabled={disabled}
              error={errors.displayName}
              hint="What you and your agents will see."
            >
              {(props) => (
                <Input
                  {...props}
                  value={draft.displayName}
                  placeholder="Name this connection"
                  autoComplete="off"
                  onChange={(event) => onChange({ ...draft, displayName: event.target.value })}
                />
              )}
            </ConnectionField>
          ) : null}
          {show("vendor") ? (
            <ConnectionField
              id={id("vendor")}
              label="Vendor"
              value={draft.vendor}
              required
              disabled={disabled}
              error={errors.vendor}
              hint="A kebab-case slug. Tools authored against this connection are bound to it."
            >
              {(props) => (
                <Input
                  {...props}
                  value={draft.vendor}
                  placeholder="Enter the vendor slug"
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => onChange({ ...draft, vendor: event.target.value })}
                />
              )}
            </ConnectionField>
          ) : null}
        </div>
      ) : null}

      {show("primaryHost") ? (
        <ConnectionField
          id={id("primaryHost")}
          label="Primary host"
          value={draft.primaryHost}
          incomplete={!draft.primaryHost.trim() || draft.primaryHost.trim() === "https://"}
          required
          disabled={disabled}
          error={errors.primaryHost}
          hint="The https base URL vendor paths resolve against. Private, loopback, link-local and cloud-metadata hosts are refused here and again by the proxy."
        >
          {(props) => (
            <Input
              {...props}
              value={draft.primaryHost}
              placeholder="Enter the API base URL"
              autoComplete="off"
              spellCheck={false}
              inputMode="url"
              className={cn(props.className, "font-mono")}
              onChange={(event) => onChange({ ...draft, primaryHost: event.target.value })}
            />
          )}
        </ConnectionField>
      ) : null}

      {show("hosts") ? (
        <ConnectionField
          id={id("hosts")}
          label="Additional hosts"
          value={draft.hosts}
          disabled={disabled}
          error={errors.hosts}
          hint="One hostname per line, for a vendor whose API spans several. The primary's own host is always included."
        >
          {(props) => (
            <Textarea
              {...props}
              value={draft.hosts}
              placeholder="Add any other API hosts"
              autoComplete="off"
              spellCheck={false}
              className={cn(props.className, "min-h-12 font-mono")}
              onChange={(event) => onChange({ ...draft, hosts: event.target.value })}
            />
          )}
        </ConnectionField>
      ) : null}

      {show("scheme") ? (
        <ConnectionField
          id={id("scheme")}
          label="Auth scheme"
          value={draft.scheme}
          required
          disabled={disabled}
          hint="How the proxy presents the credential to the vendor. Changing it updates the required fields."
        >
          {({ readOnly, ...props }) =>
            readOnly ? (
              <Input {...props} readOnly value={SCHEME_LABELS[draft.scheme]} />
            ) : (
              <Select
                value={draft.scheme}
                items={SCHEME_ITEMS}
                disabled={disabled}
                onValueChange={(next) => {
                  if (next !== null && isScheme(next) && next !== draft.scheme) {
                    onChange(withScheme(draft, next));
                  }
                }}
              >
                <SelectTrigger {...props} className={cn(props.className, "w-full")}>
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
            )
          }
        </ConnectionField>
      ) : null}

      {parameters.length > 0 ? (
        <div className="grid gap-4 sm:grid-cols-2">
          {parameters.map((parameter) => {
            const key = `schemeConfig.${parameter.name}`;
            return (
              <ConnectionField
                key={`${draft.scheme}-${parameter.name}`}
                id={id(key)}
                label={parameter.presentation.label}
                value={draft.schemeConfig[parameter.name] ?? ""}
                required={parameter.required}
                disabled={disabled}
                error={errors[key]}
                hint={parameter.presentation.hint}
              >
                {(props) => (
                  <Input
                    {...props}
                    value={draft.schemeConfig[parameter.name] ?? ""}
                    autoComplete="off"
                    spellCheck={false}
                    className={cn(props.className, "font-mono")}
                    onChange={(event) =>
                      onChange({
                        ...draft,
                        schemeConfig: {
                          ...draft.schemeConfig,
                          [parameter.name]: event.target.value,
                        },
                      })
                    }
                  />
                )}
              </ConnectionField>
            );
          })}
        </div>
      ) : null}
    </>
  );
}

/**
 * Where the credential will go, as the form stands — every host the proxy will pin the connection
 * to (ADR 0010), named beside the secret inputs so the person reads them before typing (ADR 0006).
 * The title follows the scheme (`hostsNoticeTitle`): a keyless scheme has no credential to send, so
 * it says the vendor is reached there. An `Alert`, the primitive's own frame, as every notice in
 * this form is.
 */
export function HostsNotice({ draft }: { draft: ConnectionDraft }) {
  const hosts = hostsOf(draft);
  return (
    <Alert>
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
