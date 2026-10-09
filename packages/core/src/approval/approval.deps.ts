import {
  deleteApproval,
  deleteVendorApproval,
  findApproval,
  findBuildApproval,
  findVendorApproval,
  insertBuildApproval,
  listApprovals,
  listVendorApprovals,
  updateAskEveryCall,
  upsertApproval,
  upsertVendorApproval,
} from "@graft/db/repo/approval";
import { findConnection } from "@graft/db/repo/connection";
import { settleAnsweredToolActions } from "@graft/db/repo/pending-action";
import { findAuthoredToolById } from "@graft/db/repo/tool";

/** The approval module's test seam. */
export type ApprovalDeps = {
  findApproval: typeof findApproval;
  listApprovals: typeof listApprovals;
  upsertApproval: typeof upsertApproval;
  updateAskEveryCall: typeof updateAskEveryCall;
  deleteApproval: typeof deleteApproval;
  findBuildApproval: typeof findBuildApproval;
  insertBuildApproval: typeof insertBuildApproval;
  /** The agent's standing approvals per integration (ADR 0008 as amended 2026-10-09; GRA-237). */
  findVendorApproval: typeof findVendorApproval;
  listVendorApprovals: typeof listVendorApprovals;
  upsertVendorApproval: typeof upsertVendorApproval;
  deleteVendorApproval: typeof deleteVendorApproval;
  /**
   * A per-call yes left for the agent's next call is spent when the console changes the state it
   * was given under — the setting, or the row itself (`setAskEveryCall`, `revokeApproval`).
   */
  settleAnsweredToolActions: typeof settleAnsweredToolActions;
  /** The tool and the connection an approval names must be the person's. */
  findAuthoredToolById: typeof findAuthoredToolById;
  findConnection: typeof findConnection;
  now: () => Date;
};

export const defaultApprovalDeps: ApprovalDeps = {
  findApproval,
  listApprovals,
  upsertApproval,
  updateAskEveryCall,
  deleteApproval,
  findBuildApproval,
  insertBuildApproval,
  findVendorApproval,
  listVendorApprovals,
  upsertVendorApproval,
  deleteVendorApproval,
  settleAnsweredToolActions,
  findAuthoredToolById,
  findConnection,
  now: () => new Date(),
};
