import {
  deletePersonModelKey,
  findPersonModelKey,
  upsertPersonModelKey,
} from "@graft/db/repo/person-model-key";
import type { EncryptOnlyVault } from "@graft/vault";

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
};

/** The real deps, given the vault — the server calls this once, as it does `createConnectionDeps`. */
export function createModelKeyDeps(
  vault: EncryptOnlyVault,
  options: { requireHttps?: boolean } = {},
): ModelKeyDeps {
  return {
    findPersonModelKey,
    upsertPersonModelKey,
    deletePersonModelKey,
    vault,
    now: () => new Date(),
    requireHttps: options.requireHttps ?? true,
  };
}
