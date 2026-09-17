import type { CloudBackings, CloudBackingsInput } from "../backings";
import { createCloudBackings as fake, fakeCloudProvider } from "./cloud-backings-fake";

/**
 * A factory that answers a provider named `keyring` — the shadowing `providerListProblem` exists to
 * refuse (ADR 0019): the hosted package must not stand in for today's behaviour under its name.
 */
export function createCloudBackings(input: CloudBackingsInput): CloudBackings {
  return { ...fake(input), providers: [{ ...fakeCloudProvider, name: "keyring" }] };
}
