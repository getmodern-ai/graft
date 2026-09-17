import {
  deleteApprovalsForVendor,
  deleteBuildApprovalsForConnection,
} from "@graft/db/repo/approval";
import {
  addConnectionHosts,
  findConnection,
  findConnectionByIdUnscoped,
  insertConnection,
  listConnections,
  reconnectConnection,
  recordProviderRelease,
  revokeConnection,
  setConnectionCredential,
  setConnectionOAuthState,
  setConnectionProviderRef,
} from "@graft/db/repo/connection";
import { expirePendingActionsForConnection } from "@graft/db/repo/pending-action";
import type { EncryptOnlyVault } from "@graft/vault";

import { type ConnectionProvider, DEFAULT_PROVIDERS } from "./provider";

/**
 * The connection module's test seam. The one file here that imports repo functions, and the one
 * place the vault enters the module — as its **encrypt half only**. The type is what keeps it so: a
 * `deps.vault.decrypt` in the service does not compile. Decrypt is the proxy's, bound in
 * `apps/server` (GRA-1, "decrypted in exactly one component").
 */
export type ConnectionDeps = {
  insertConnection: typeof insertConnection;
  findConnection: typeof findConnection;
  /** Unscoped, for the proxy's binding only — see the repo comment. */
  findConnectionByIdUnscoped: typeof findConnectionByIdUnscoped;
  listConnections: typeof listConnections;
  setConnectionCredential: typeof setConnectionCredential;
  /** The consent's non-secret state alone — a verifier written, a refusal marked (ADR 0005). */
  setConnectionOAuthState: typeof setConnectionOAuthState;
  /** A relay provider's row reconnected in place — its reference written, `revoked_at` cleared (ADR 0019). */
  setConnectionProviderRef: typeof setConnectionProviderRef;
  /** What the provider's release answered after a revoke: the reference gone, or the failure stamped (ADR 0019). */
  recordProviderRelease: typeof recordProviderRelease;
  revokeConnection: typeof revokeConnection;
  /** The way back for a revoked row that holds no credential — a `none` provider's (GRA-58). */
  reconnectConnection: typeof reconnectConnection;
  /** A `none` provider's row widened to a later proposal's hosts, within the provider's coverage — one appending statement (GRA-58). */
  addConnectionHosts: typeof addConnectionHosts;
  /** A revoke's three sweeps (ADR 0007): every approval for the vendor's tools, every build approval, every open ask about the connection. */
  deleteApprovalsForVendor: typeof deleteApprovalsForVendor;
  deleteBuildApprovalsForConnection: typeof deleteBuildApprovalsForConnection;
  expirePendingActionsForConnection: typeof expirePendingActionsForConnection;
  vault: EncryptOnlyVault;
  /**
   * The deployment's connection providers, in routing order, the keyring last (ADR 0019;
   * `apps/server/src/backings.ts` selects them). What a registration's `provider` is checked
   * against, what a proposal is routed through, and whose `revoke` a revoke calls.
   */
  providers: readonly ConnectionProvider[];
  newId: () => string;
  now: () => Date;
};

/**
 * The real deps, given the vault and the providers the backings selected. A factory rather than a
 * constant because the vault is built from the keyring secret, which only `apps/server` reads
 * (`@graft/env`); the server calls this once and hands the result to every connection call. The
 * providers default to the keyring alone, which is every deployment's floor.
 */
export function createConnectionDeps(
  vault: EncryptOnlyVault,
  providers: readonly ConnectionProvider[] = DEFAULT_PROVIDERS,
): ConnectionDeps {
  return {
    insertConnection,
    findConnection,
    findConnectionByIdUnscoped,
    listConnections,
    setConnectionCredential,
    setConnectionOAuthState,
    setConnectionProviderRef,
    recordProviderRelease,
    revokeConnection,
    reconnectConnection,
    addConnectionHosts,
    deleteApprovalsForVendor,
    deleteBuildApprovalsForConnection,
    expirePendingActionsForConnection,
    vault,
    providers,
    newId: () => crypto.randomUUID(),
    now: () => new Date(),
  };
}
