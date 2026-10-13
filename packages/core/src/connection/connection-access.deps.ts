import { findConnection } from "@graft/db/repo/connection";
import {
  lastVendorUseByAgent,
  listAgentAccessForConnection,
  listBuildApprovalsForConnection,
  listVendorApprovalsForVendor,
  listVendorToolApprovals,
} from "@graft/db/repo/connection-access";

/** The access view's test seam (GRA-296): the connection, then one read per kind of record. */
export type ConnectionAccessDeps = {
  findConnection: typeof findConnection;
  listAgentAccessForConnection: typeof listAgentAccessForConnection;
  lastVendorUseByAgent: typeof lastVendorUseByAgent;
  listVendorToolApprovals: typeof listVendorToolApprovals;
  listVendorApprovalsForVendor: typeof listVendorApprovalsForVendor;
  listBuildApprovalsForConnection: typeof listBuildApprovalsForConnection;
};

export const defaultConnectionAccessDeps: ConnectionAccessDeps = {
  findConnection,
  listAgentAccessForConnection,
  lastVendorUseByAgent,
  listVendorToolApprovals,
  listVendorApprovalsForVendor,
  listBuildApprovalsForConnection,
};
