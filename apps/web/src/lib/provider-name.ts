/**
 * A connection provider's name as a person reads it: the provider's `name` is an id in lower case
 * (`ProviderDescription.name`), and a sentence names it as a proper noun, so the first letter is
 * capitalised and the rest kept ("pipedream" reads "Pipedream").
 */
export function providerLabel(name: string): string {
  return name.length > 0 ? name.charAt(0).toUpperCase() + name.slice(1) : name;
}
