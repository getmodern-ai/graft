import { findAgent } from "@graft/db/repo/agent";
import {
  deleteApproval,
  deleteBuildApproval,
  deleteVendorApproval,
  findApproval,
  findBuildApproval,
  findVendorApproval,
  insertBuildApproval,
  listApprovals,
  listBuildApprovals,
  listVendorApprovals,
  updateAskEveryCall,
  updateVendorApprovalDestructive,
  upsertApproval,
  upsertVendorApproval,
} from "@graft/db/repo/approval";
import { insertApprovalEvent } from "@graft/db/repo/approval-event";
import { findConnection, findVendorConnectionsForUpdate } from "@graft/db/repo/connection";
import {
  answerOpenToolActions,
  listOpenToolActions,
  settleAnsweredToolActions,
} from "@graft/db/repo/pending-action";
import {
  findAuthoredToolById,
  findAuthoredToolForUpdate,
  listToolVersionOrigins,
} from "@graft/db/repo/tool";

/** The approval module's test seam. */
export type ApprovalDeps = {
  findApproval: typeof findApproval;
  listApprovals: typeof listApprovals;
  upsertApproval: typeof upsertApproval;
  updateAskEveryCall: typeof updateAskEveryCall;
  deleteApproval: typeof deleteApproval;
  findBuildApproval: typeof findBuildApproval;
  insertBuildApproval: typeof insertBuildApproval;
  /** The agent's page lists and withdraws them (ADR 0008 as amended 2026-09-18; GRA-295). */
  listBuildApprovals: typeof listBuildApprovals;
  deleteBuildApproval: typeof deleteBuildApproval;
  /** The agent's standing approvals per integration (ADR 0008 as amended 2026-10-09; GRA-237). */
  findVendorApproval: typeof findVendorApproval;
  listVendorApprovals: typeof listVendorApprovals;
  upsertVendorApproval: typeof upsertVendorApproval;
  deleteVendorApproval: typeof deleteVendorApproval;
  /** The console widens or narrows one that stands (ADR 0008 as amended 2026-10-14; GRA-302). */
  updateVendorApprovalDestructive: typeof updateVendorApprovalDestructive;
  /**
   * A per-call yes left for the agent's next call is spent when the console changes the state it
   * was given under — the setting, or the row itself (`setAskEveryCall`, `revokeApproval`).
   */
  settleAnsweredToolActions: typeof settleAnsweredToolActions;
  /** An answer the console sets outright closes the open asks it answers (`setApprovalFromConsole`). */
  answerOpenToolActions: typeof answerOpenToolActions;
  /** Read plain for the connections the asks name, then locked after them (`setApprovalFromConsole`). */
  listOpenToolActions: typeof listOpenToolActions;
  /**
   * The connections whose revoke would sweep the answer, and those the open asks name, locked
   * first, as a revoke and an answer to an ask lock theirs (`setApprovalFromConsole`).
   */
  findVendorConnectionsForUpdate: typeof findVendorConnectionsForUpdate;
  /** The agent an answer set from the console is for must be the person's, and not revoked. */
  findAgent: typeof findAgent;
  /** The tool and the connection an approval names must be the person's. */
  findAuthoredToolById: typeof findAuthoredToolById;
  /**
   * An answer is recorded under the tool row's lock, the one a stock advance takes, so an answer
   * and an advance serialise and the answer lands on the version it holds for (`setApproval`).
   */
  findAuthoredToolForUpdate: typeof findAuthoredToolForUpdate;
  /** The tool's versions by origin, which say whether a late answer carries (`answerCarriesTo`). */
  listToolVersionOrigins: typeof listToolVersionOrigins;
  findConnection: typeof findConnection;
  /** Every answer, withdraw and change is appended to the record in its own transaction (GRA-341). */
  insertApprovalEvent: typeof insertApprovalEvent;
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
  listBuildApprovals,
  deleteBuildApproval,
  findVendorApproval,
  listVendorApprovals,
  upsertVendorApproval,
  deleteVendorApproval,
  updateVendorApprovalDestructive,
  settleAnsweredToolActions,
  answerOpenToolActions,
  listOpenToolActions,
  findVendorConnectionsForUpdate,
  findAgent,
  findAuthoredToolById,
  findAuthoredToolForUpdate,
  listToolVersionOrigins,
  findConnection,
  insertApprovalEvent,
  now: () => new Date(),
};
