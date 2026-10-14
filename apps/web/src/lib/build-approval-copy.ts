import { integrationNameFor } from "@graft/core/approval/vendor-approval.rules";

/**
 * A build approval's words on the agent's page (ADR 0008 as amended 2026-09-18; GRA-295). The row
 * reads as what the agent may do, "Build its own Gmail tools", as App v2 draws it; the connection's
 * own name rides beside it only where it says more than the integration's, so two accounts of one
 * integration stay apart.
 */

type Row = { vendor: string; displayName: string };

export function buildApprovalTitle(row: Row): string {
  return `Build its own ${integrationNameFor(row.vendor, row.displayName)} tools`;
}

/** The connection's name, or null where it is the integration's name and adds nothing. */
export function buildApprovalConnectionName(row: Row): string | null {
  return integrationNameFor(row.vendor, row.displayName) === row.displayName
    ? null
    : row.displayName;
}

export function buildApprovalWithdrawnSentence(row: Row): string {
  return `The next tool it builds with ${row.displayName} asks you first.`;
}
