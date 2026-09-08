/**
 * Lowercase ASCII letters and digits in segments joined by single hyphens: no leading, trailing or
 * doubled hyphen, and nothing outside that alphabet. This is the form an authored tool's name is
 * stored in, where it is one third of the tool's uniqueness beside the person and the vendor slug
 * (the spec, GRA-1, "Tenancy and the schema").
 */
const KEBAB_CASE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isKebabCase(value: string): boolean {
  return KEBAB_CASE.test(value);
}
