import { findConnection } from "@graft/db/repo/connection";
import {
  lastVendorUseByAgent,
  listAgentAccessForConnection,
  listBuildApprovalsForConnection,
  listVendorApprovalsForVendor,
  listVendorConnectionIds,
  listVendorToolApprovals,
} from "@graft/db/repo/connection-access";

/** The access view's test seam (GRA-296): the connection, then one read per kind of record. */
export type ConnectionAccessDeps = {
  findConnection: typeof findConnection;
  listAgentAccessForConnection: typeof listAgentAccessForConnection;
  /** The person's connections to the vendor, whose execute tools count as the vendor's use. */
  listVendorConnectionIds: typeof listVendorConnectionIds;
  lastVendorUseByAgent: typeof lastVendorUseByAgent;
  listVendorToolApprovals: typeof listVendorToolApprovals;
  listVendorApprovalsForVendor: typeof listVendorApprovalsForVendor;
  listBuildApprovalsForConnection: typeof listBuildApprovalsForConnection;
};

export const defaultConnectionAccessDeps: ConnectionAccessDeps = {
  findConnection,
  listAgentAccessForConnection,
  listVendorConnectionIds,
  lastVendorUseByAgent,
  listVendorToolApprovals,
  listVendorApprovalsForVendor,
  listBuildApprovalsForConnection,
};
