import { providerDisplayName } from "@graft/core/connection/provider";

/**
 * A connection provider's name as a person reads it: the provider's `name` is a kebab-case id
 * (`ProviderDescription.name`), and a sentence names it as a proper noun, so the first letter is
 * capitalised and a hyphen reads as a space ("pipedream" reads "Pipedream"). The rule is
 * `@graft/core`'s `providerDisplayName`, which the ask card's sentences use too (GRA-273); every
 * console sentence, toast and badge that names a provider goes through this.
 */
export function providerLabel(name: string): string {
  return providerDisplayName(name);
}
