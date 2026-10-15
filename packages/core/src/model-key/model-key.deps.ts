import {
  deletePersonModelKey,
  findPersonModelKey,
  upsertPersonModelKey,
} from "@graft/db/repo/person-model-key";
import type { ModelKeyProvider } from "@graft/db/schema/person-model-key";
import type { EncryptOnlyVault } from "@graft/vault";

/**
 * What one bounded call to the provider said of a key (GRA-340): the shape `@graft/model`'s
 * `checkModelKey` answers, restated here because this package does not import the model package.
 */
export type ModelKeyCheck =
  | { outcome: "accepted" }
  | { outcome: "refused"; status: number }
  | { outcome: "not_public" }
  | { outcome: "unchecked"; reason: "timeout" | "unreachable" | "status"; status?: number };

export type ModelKeyCheckInput = {
  provider: ModelKeyProvider;
  apiKey: string;
  baseUrl: string | null;
};

/**
 * The model-key module's test seam: the three statements on `person_model_key`, and the vault's
 * **encrypt half only** — the same shape as `ConnectionDeps`, for the same reason: a `decrypt` from
 * a person's request path does not compile. The one place a key becomes plaintext is the model
 * resolver in `apps/server` (`model.ts`), which is handed the vault's decrypt and this module's
 * `findPersonModelKey` and nothing of the request.
 */
export type ModelKeyDeps = {
  findPersonModelKey: typeof findPersonModelKey;
  upsertPersonModelKey: typeof upsertPersonModelKey;
  deletePersonModelKey: typeof deletePersonModelKey;
  vault: EncryptOnlyVault;
  now: () => Date;
  /**
   * Whether a base URL must be https: the server's `NODE_ENV=production`. Absent means it must, so
   * a laptop opts into plain http; nothing opts out of the public-host rule (GRA-338).
   */
  requireHttps?: boolean;
  /**
   * Asks the provider whether it takes the key before it is saved (GRA-340); the server's goes
   * through the proxy's address-guarded fetch. Absent, as in a suite with no network, the key is
   * saved unchecked and no warning is given.
   */
  checkKey?: (input: ModelKeyCheckInput) => Promise<ModelKeyCheck>;
};

/** The real deps, given the vault — the server calls this once, as it does `createConnectionDeps`. */
export function createModelKeyDeps(
  vault: EncryptOnlyVault,
  options: {
    requireHttps?: boolean;
    checkKey?: (input: ModelKeyCheckInput) => Promise<ModelKeyCheck>;
  } = {},
): ModelKeyDeps {
  return {
    findPersonModelKey,
    upsertPersonModelKey,
    deletePersonModelKey,
    vault,
    now: () => new Date(),
    requireHttps: options.requireHttps ?? true,
    ...(options.checkKey ? { checkKey: options.checkKey } : {}),
  };
}
