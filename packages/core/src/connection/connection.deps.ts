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
} from "@graft/db/repo/connection";
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
  revokeConnection: typeof revokeConnection;
  /** A revoke's two sweeps (ADR 0007): every approval for the vendor's tools, every build approval. */
  deleteApprovalsForVendor: typeof deleteApprovalsForVendor;
  deleteBuildApprovalsForConnection: typeof deleteBuildApprovalsForConnection;
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
    revokeConnection,
    deleteApprovalsForVendor,
    deleteBuildApprovalsForConnection,
    vault,
    newId: () => crypto.randomUUID(),
    now: () => new Date(),
  };
}
