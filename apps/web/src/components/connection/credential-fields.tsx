import type { AuthScheme } from "@graft/proxy/types";

import { ConnectionField } from "@/components/connection/connection-field";
import { FieldDescription, FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { credentialFieldsFor, type DraftErrors } from "@/lib/connection-form";
import { cn } from "@/lib/utils";

/**
 * A scheme's secret inputs, rendered from the proxy's table (`credentialFieldsFor`) and nowhere
 * else (GRA-28): a key, a token, a username and password, a client id and secret. Every input is a
 * password field with autocomplete off, and what is typed goes to the server's submit and to
 * nothing else — the console never reads a credential back (CONTEXT.md, *Connection*: write-only
 * after entry).
 */
export function CredentialFields({
  scheme,
  value,
  onChange,
  errors,
  idPrefix,
  disabled,
  autoFocus,
  include,
}: {
  scheme: AuthScheme;
  value: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
  errors: DraftErrors;
  idPrefix: string;
  disabled?: boolean;
  autoFocus?: boolean;
  include?: "required" | "optional";
}) {
  const fields = credentialFieldsFor(scheme);
  // A scheme with no secret fields is `none` (GRA-66): say so where the inputs would be, so the
  // form does not look like it forgot them.
  if (fields.length === 0) {
    if (include) return null;
    return (
      <FieldDescription id={`${idPrefix}-credential-none`}>
        This scheme sends no credential. The vendor is called as the tool makes the request, through
        the proxy, at the hosts above and nowhere else.
      </FieldDescription>
    );
  }
  return (
    <>
      {fields
        .filter((field) => !include || field.required === (include === "required"))
        .map((field, index) => {
          const id = `${idPrefix}-credential-${field.name}`;
          const error = errors[`credential.${field.name}`];
          const props = {
            id,
            value: value[field.name] ?? "",
            disabled,
            autoComplete: "off",
            spellCheck: false,
            required: field.required,
            autoFocus: autoFocus && index === 0,
            "aria-invalid": error ? true : undefined,
          };
          return (
            <ConnectionField
              key={`${scheme}-${field.name}`}
              id={id}
              label={field.presentation.label}
              value={value[field.name] ?? ""}
              required={field.required}
              secret
              disabled={disabled}
              error={error}
              hint={field.presentation.hint}
            >
              {(control) =>
                field.presentation.multiline ? (
                  <Textarea
                    {...props}
                    {...control}
                    rows={6}
                    className={cn(control.className, "font-mono")}
                    onChange={(event) => onChange({ ...value, [field.name]: event.target.value })}
                  />
                ) : (
                  <Input
                    {...props}
                    {...control}
                    type="password"
                    onChange={(event) => onChange({ ...value, [field.name]: event.target.value })}
                  />
                )
              }
            </ConnectionField>
          );
        })}
      {errors.credential && include !== "optional" ? (
        <FieldError>{errors.credential}</FieldError>
      ) : null}
    </>
  );
}
