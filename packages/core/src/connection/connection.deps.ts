import {
  deleteApprovalsForVendor,
  deleteBuildApprovalsForConnection,
} from "@graft/db/repo/approval";
import {
  findConnection,
  findConnectionByIdUnscoped,
  insertConnection,
  listConnections,
  revokeConnection,
  setConnectionCredential,
  setConnectionOAuthState,
} from "@graft/db/repo/connection";
import { expirePendingActionsForConnection } from "@graft/db/repo/pending-action";
import type { EncryptOnlyVault } from "@graft/vault";

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
  revokeConnection: typeof revokeConnection;
  /** A revoke's three sweeps (ADR 0007): every approval for the vendor's tools, every build approval, every open ask about the connection. */
  deleteApprovalsForVendor: typeof deleteApprovalsForVendor;
  deleteBuildApprovalsForConnection: typeof deleteBuildApprovalsForConnection;
  expirePendingActionsForConnection: typeof expirePendingActionsForConnection;
  vault: EncryptOnlyVault;
  newId: () => string;
  now: () => Date;
};

/**
 * The real deps, given the vault. A factory rather than a constant because the vault is built from
 * the keyring secret, which only `apps/server` reads (`@graft/env`); the server calls this once
 * and hands the result to every connection call.
 */
export function createConnectionDeps(vault: EncryptOnlyVault): ConnectionDeps {
  return {
    insertConnection,
    findConnection,
    findConnectionByIdUnscoped,
    listConnections,
    setConnectionCredential,
    setConnectionOAuthState,
    revokeConnection,
    deleteApprovalsForVendor,
    deleteBuildApprovalsForConnection,
    expirePendingActionsForConnection,
    vault,
    newId: () => crypto.randomUUID(),
    now: () => new Date(),
  };
}
