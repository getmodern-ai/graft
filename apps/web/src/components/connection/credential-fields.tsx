import type { AuthScheme } from "@graft/proxy/types";

import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { credentialFieldsFor, type DraftErrors } from "@/lib/connection-form";

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
}: {
  scheme: AuthScheme;
  value: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
  errors: DraftErrors;
  idPrefix: string;
  disabled?: boolean;
  autoFocus?: boolean;
}) {
  const fields = credentialFieldsFor(scheme);
  // A scheme with no secret fields is `none` (GRA-66): say so where the inputs would be, so the
  // form does not look like it forgot them.
  if (fields.length === 0) {
    return (
      <FieldDescription id={`${idPrefix}-credential-none`}>
        This scheme sends no credential. The integration is called as the tool makes the request,
        through the proxy, at the hosts above and nowhere else.
      </FieldDescription>
    );
  }
  return (
    <>
      {fields.map((field, index) => {
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
          <Field key={field.name} data-invalid={error ? true : undefined}>
            <FieldLabel htmlFor={id}>
              {field.presentation.label}
              {field.required ? null : (
                <span className="font-normal text-muted-foreground">(optional)</span>
              )}
            </FieldLabel>
            {field.presentation.multiline ? (
              <Textarea
                {...props}
                rows={6}
                className="font-mono"
                onChange={(event) => onChange({ ...value, [field.name]: event.target.value })}
              />
            ) : (
              <Input
                {...props}
                type="password"
                onChange={(event) => onChange({ ...value, [field.name]: event.target.value })}
              />
            )}
            {field.presentation.hint ? (
              <FieldDescription>{field.presentation.hint}</FieldDescription>
            ) : null}
            {error ? <FieldError>{error}</FieldError> : null}
          </Field>
        );
      })}
      {errors.credential ? <FieldError>{errors.credential}</FieldError> : null}
    </>
  );
}
