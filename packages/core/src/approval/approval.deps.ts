import {
  deleteApproval,
  findApproval,
  findBuildApproval,
  insertBuildApproval,
  listApprovals,
  relaxApproval,
  upsertApproval,
} from "@graft/db/repo/approval";
import { findConnection } from "@graft/db/repo/connection";
import { findAuthoredToolById } from "@graft/db/repo/tool";

/** The approval module's test seam. */
export type ApprovalDeps = {
  findApproval: typeof findApproval;
  listApprovals: typeof listApprovals;
  upsertApproval: typeof upsertApproval;
  relaxApproval: typeof relaxApproval;
  deleteApproval: typeof deleteApproval;
  findBuildApproval: typeof findBuildApproval;
  insertBuildApproval: typeof insertBuildApproval;
  /** The tool and the connection an approval names must be the person's. */
  findAuthoredToolById: typeof findAuthoredToolById;
  findConnection: typeof findConnection;
  now: () => Date;
};

export const defaultApprovalDeps: ApprovalDeps = {
  findApproval,
  listApprovals,
  upsertApproval,
  relaxApproval,
  deleteApproval,
  findBuildApproval,
  insertBuildApproval,
  findAuthoredToolById,
  findConnection,
  now: () => new Date(),
};
