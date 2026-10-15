import { listActiveAgentReach } from "@graft/db/repo/agent";
import { listConnections } from "@graft/db/repo/connection";
import { countToolsByVendor } from "@graft/db/repo/tool";
import { lastUsedAtByVendor } from "@graft/db/repo/usage";

import { DEFAULT_PROVIDERS, type ProviderDescription } from "../connection/provider";

/**
 * The integrations list's test seam (GRA-291): four person-scoped reads, one statement each, and
 * the providers a connection's state is judged against.
 */
export type IntegrationDeps = {
  listConnections: typeof listConnections;
  listActiveAgentReach: typeof listActiveAgentReach;
  countToolsByVendor: typeof countToolsByVendor;
  lastUsedAtByVendor: typeof lastUsedAtByVendor;
  /** The deployment's providers (`ConnectionDeps.providers`): a row of one it no longer enables is not usable. */
  providers: readonly ProviderDescription[];
};

export function createIntegrationDeps(
  providers: readonly ProviderDescription[] = DEFAULT_PROVIDERS,
): IntegrationDeps {
  return {
    listConnections,
    listActiveAgentReach,
    countToolsByVendor,
    lastUsedAtByVendor,
    providers,
  };
}
