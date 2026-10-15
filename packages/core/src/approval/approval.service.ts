import type {
  ApprovalRow,
  BuildApprovalListing,
  BuildApprovalRow,
  VendorApprovalRow,
} from "@graft/db/repo/approval";
import type { ApprovalDecision } from "@graft/db/schema/approval";
import type { ApprovalEventVia } from "@graft/db/schema/approval-event";

import type { ServiceContext } from "../context";
import { orNotFound, ServiceError } from "../errors";
import type { AgentScope } from "../tenancy";
import {
  type ApprovalVerdict,
  answerCarriesTo,
  approvalDecision,
  type ToolAnnotations,
} from "./approval.decision";
import type { ApprovalDeps } from "./approval.deps";

/**
 * Approvals (CONTEXT.md; ADR 0008): get and set the standing answer per agent per tool, turn a
 * tool's ask-every-call setting on or off, get and grant the once-per-agent-per-connection build
 * approval, and decide a call. The rule itself is `approvalDecision`, pure; this file reads the
 * rows it needs and applies it.
 */

/**
 * The door an answer came through, for its approval event (GRA-341), and the ask it answered when
 * it answered one. Null where the event was already written by the door the person answered at: an
 * agent taking an answer off a pending action writes the row again but answers nothing new. Every
 * write that records an answer takes one, so a new caller has to say which.
 */
export type ApprovalEventOrigin = { via: ApprovalEventVia; pendingActionId?: string | null };

/** The console's own acts (withdraw, widen, narrow, the ask-every-call switch) come through it alone. */
const CONSOLE: ApprovalEventOrigin = { via: "console" };

export async function getApproval(
  ctx: ServiceContext,
  scope: AgentScope,
  toolId: string,
  deps: ApprovalDeps,
): Promise<ApprovalRow | null> {
  return deps.findApproval(ctx.db, scope, toolId);
}

export async function listApprovals(
  ctx: ServiceContext,
  scope: AgentScope,
  deps: ApprovalDeps,
): Promise<ApprovalRow[]> {
  return deps.listApprovals(ctx.db, scope);
}

/**
 * The version an ask was about, as the ask showed it (GRA-245, Greptile on #190): the id the ask's
 * payload or the gate's subject names, and the annotations the person read. `versionId` is null on
 * an ask made before asks named one, which records an answer that holds for no version, so the
 * tool asks once more.
 */
export type AskedVersion = {
  versionId: string | null;
  annotations: ToolAnnotations;
};

/**
 * The person's answer to a tool's ask, recorded so it holds (ADR 0008: any tool that is not
 * read-only asks once). The tool must be the person's. A second answer replaces the first. The
 * ask-every-call setting rides the same write when the answer carried one (the console card's
 * switch, the form's field) and is kept as it stood when it did not — a Hermes button carries
 * none. One upsert, so the answer path never has to touch the setting on its own.
 *
 * **An answer is for the version the person was shown** (`options.asked`; GRA-245, Greptile on
 * #190), never the tool's version when the answer arrives: an ask about v1 answered after v2
 * became current records for v1, and v2 still asks. Two exceptions, both under the tool row's lock
 * a stock advance takes, so an answer and an advance serialise:
 *
 * - an allow on a stock copy whose later versions were all advances that do not widen what the ask
 *   showed lands on the current version, as `advanceStockCopy` would have carried it had the answer
 *   come first (`answerCarriesTo`; ADR 0008 as amended 2026-10-09);
 * - an allow for an older version leaves an allow already standing for the current one where it
 *   is, so a late answer to an old ask never takes a standing yes back; an ask-every-call setting
 *   the answer carried is still written onto that row, since the setting is the tool's.
 */
export async function setApproval(
  ctx: ServiceContext,
  scope: AgentScope,
  toolId: string,
  decision: ApprovalDecision,
  deps: ApprovalDeps,
  options: {
    asked: AskedVersion;
    askEveryCall?: boolean;
    event: ApprovalEventOrigin | null;
    /**
     * When the person gave the answer, where it was given earlier than it is written: an agent
     * taking an answer off an ask passes the ask's `answeredAt`, so the row keeps the moment its
     * event records and the activity read never shows it a second time (GRA-341).
     */
    decidedAt?: Date;
  },
): Promise<ApprovalRow> {
  return ctx.db.transaction(async (tx) => {
    const tool = orNotFound(
      await deps.findAuthoredToolForUpdate(tx, scope.personId, toolId),
      "Tool not found",
    );
    const now = deps.now();
    // The answer is the person's whether or not it moves the row (a late yes beside a standing
    // one), so it is recorded either way.
    if (options.event) {
      await deps.insertApprovalEvent(tx, {
        personId: scope.personId,
        agentId: scope.agentId,
        kind: "tool",
        action: decision === "allow" ? "allowed" : "denied",
        via: options.event.via,
        toolId,
        vendor: tool.vendor,
        pendingActionId: options.event.pendingActionId ?? null,
        at: now,
      });
    }
    const asked = options.asked.versionId;
    let toolVersionId = asked;
    if (decision === "allow" && asked !== tool.currentVersionId) {
      const current = tool.currentVersionId;
      const carries =
        asked !== null &&
        current !== null &&
        answerCarriesTo({
          versions: await deps.listToolVersionOrigins(tx, scope.personId, toolId),
          fromVersionId: asked,
          toVersionId: current,
          shown: options.asked.annotations,
          to: { readOnly: tool.readOnly, destructive: tool.destructive },
        });
      if (carries) {
        toolVersionId = current;
      } else {
        const standing = await deps.findApproval(tx, scope, toolId);
        if (standing?.decision === "allow" && isForVersion(standing, current)) {
          // The yes stays on the current version; the ask-every-call setting is the tool's, not
          // the version's, so a setting the answer carried still lands (Greptile on #190).
          if (
            options.askEveryCall === undefined ||
            options.askEveryCall === standing.askEveryCall
          ) {
            return standing;
          }
          toolVersionId = current;
        }
      }
    }
    return deps.upsertApproval(tx, {
      agentId: scope.agentId,
      toolId,
      decision,
      decidedAt: options.decidedAt ?? now,
      toolVersionId,
      ...(options.askEveryCall === undefined ? {} : { askEveryCall: options.askEveryCall }),
    });
  });
}

/**
 * Turn a tool's ask-every-call setting on or off for one agent, from the agent's page (ADR 0008,
 * amendment of 2026-09-15: asking on every call is the person's opt-in per tool, both ways).
 * Refused as `BAD_REQUEST` for a read-only tool — it never asks, so there is nothing to set — and
 * `NOT_FOUND` when no approval stands yet: the setting is an amendment to an answer, not an answer.
 *
 * A yes the person gave while the setting was on may still be waiting, answered and unconsumed,
 * for the agent's next call to take. It was given under the setting as it stood, so it is spent
 * here rather than carried into the new state — otherwise it would be found by a later call and
 * applied as if the person had just said it. The answer path does not come through here: it
 * writes the setting with the answer (`setApproval`), because the answer it is recording is the
 * one that must stay for the agent.
 */
export async function setAskEveryCall(
  ctx: ServiceContext,
  scope: AgentScope,
  toolId: string,
  on: boolean,
  deps: ApprovalDeps,
): Promise<ApprovalRow> {
  const tool = orNotFound(
    await deps.findAuthoredToolById(ctx.db, scope.personId, toolId),
    "Tool not found",
  );
  if (tool.readOnly) {
    throw new ServiceError(
      "BAD_REQUEST",
      "A read-only tool never asks, so it cannot ask every call",
    );
  }
  return ctx.db.transaction(async (tx) => {
    // The tool row's lock first, the order an answer takes (`setApproval`), so a switch and an
    // answer at once queue on it rather than each holding a row the other's event needs; then
    // the approval, so two switches at once each judge the setting the other left.
    await deps.findAuthoredToolForUpdate(tx, scope.personId, toolId);
    const before = await deps.findApproval(tx, scope, toolId, { forUpdate: true });
    const row = orNotFound(
      await deps.updateAskEveryCall(tx, scope, toolId, on),
      "No approval stands for this tool yet — answer its first ask before changing how it asks",
    );
    const now = deps.now();
    await deps.settleAnsweredToolActions(tx, scope, toolId, now);
    // A repeat of the setting as it stood changes nothing, so it records nothing.
    if (before?.askEveryCall !== on) {
      await deps.insertApprovalEvent(tx, {
        personId: scope.personId,
        agentId: scope.agentId,
        kind: "tool",
        action: on ? "ask_every_call_on" : "ask_every_call_off",
        via: CONSOLE.via,
        toolId,
        vendor: tool.vendor,
        at: now,
      });
    }
    return row;
  });
}

/**
 * Withdraw the standing answer, from the console (ADR 0008: the record is the person's to revisit).
 * The tool asks again on its next call, as if never answered — the one way back from a `deny`.
 * The ask-every-call setting goes with the row; the next answer starts it off again. A per-call
 * yes still waiting for the agent is spent with it, for the reason `setAskEveryCall` gives: left
 * behind, it would re-create the row the person just removed. Null when nothing stood.
 */
export async function revokeApproval(
  ctx: ServiceContext,
  scope: AgentScope,
  toolId: string,
  deps: ApprovalDeps,
): Promise<ApprovalRow | null> {
  const tool = orNotFound(
    await deps.findAuthoredToolById(ctx.db, scope.personId, toolId),
    "Tool not found",
  );
  return ctx.db.transaction(async (tx) => {
    // The tool row's lock before the approval's, as an answer and the switch take them.
    await deps.findAuthoredToolForUpdate(tx, scope.personId, toolId);
    const row = await deps.deleteApproval(tx, scope, toolId);
    const now = deps.now();
    await deps.settleAnsweredToolActions(tx, scope, toolId, now);
    if (row) {
      await deps.insertApprovalEvent(tx, {
        personId: scope.personId,
        agentId: scope.agentId,
        kind: "tool",
        action: "withdrew",
        via: CONSOLE.via,
        toolId,
        vendor: tool.vendor,
        at: now,
      });
    }
    return row;
  });
}

/** How an ask answered by an answer set outright says so on its `answer` (`setApprovalFromConsole`). */
export const SETTING_ANSWER_VIA = "setting";

/** What an answer set from the console recorded: the row, and the open asks it answered. */
export type ConsoleApprovalResult = {
  approval: ApprovalRow;
  answeredPendingActionIds: string[];
};

/**
 * The person sets a tool's answer outright for one agent, from the console: allow or deny for the
 * version the tool runs now (ADR 0008 as amended 2026-10-14; GRA-302). It is the person's answer,
 * given on Graft's page, so it **may create an answer where none stood** as well as replace one;
 * the ask-every-call setting stays as it stood, since setting it is a separate act. Recorded
 * through `setApproval` for the tool's current version, read under the tool row's lock, so an
 * advance in flight either lands first and the answer is for its version, or waits.
 *
 * **Locked as answering an ask is, and in its order** (`recordApprovalAnswer`: connection, action,
 * tool): first every connection whose revoke would sweep this answer (the tool's vendor's,
 * `revokeConnection` sweeping by vendor) with the tool's default and every connection an open ask
 * names, in id order; then the open asks; then the tool row. A revoke that overlaps therefore
 * either commits first, and the answer is refused below, or waits and sweeps the answer this
 * wrote, so an allow never outlives a revoke and passes a write after a reconnect (ADR 0007, ADR
 * 0008); and an answer to an ask that overlaps queues on the same connection rather than each
 * holding a row the other wants.
 *
 * Refused: another person's agent or tool (`NOT_FOUND`), a revoked agent (`CONFLICT`, since this
 * can write a row a revoked agent's record would then carry), a read-only tool (`BAD_REQUEST`:
 * reads never ask), no live connection among those locked (`CONFLICT`, `connection_revoked`: the
 * revoke's fresh start stands until the person reconnects), and a tool with no current version
 * (`CONFLICT`, `tool_has_no_version`: there is no version for the answer to be for).
 *
 * **The open asks it answers are closed with it.** Every open ask about the tool for this agent,
 * on a deny, and those naming the current version, on an allow, are answered with the same
 * decision (`via: "setting"`) and taken at once, as an answer the standing row carries in full is:
 * the inbox stops offering an answer already given, and a call waiting on one judges the rule
 * again. Not on an allow while the tool asks every call: each call's ask is still the person's to
 * answer. A yes left answered for the agent's next call is spent, as `setAskEveryCall` spends one,
 * since it was given under the state this replaces.
 */
export async function setApprovalFromConsole(
  ctx: ServiceContext,
  scope: AgentScope,
  toolId: string,
  decision: ApprovalDecision,
  deps: ApprovalDeps,
): Promise<ConsoleApprovalResult> {
  return ctx.db.transaction(async (tx) => {
    const agent = orNotFound(
      await deps.findAgent(tx, scope.personId, scope.agentId),
      "Agent not found",
    );
    if (agent.revokedAt !== null) {
      throw new ServiceError(
        "CONFLICT",
        `${agent.name} is revoked, so its answers stay as they are`,
        {
          details: { reason: "agent_revoked" },
        },
      );
    }
    // Read unlocked for the vendor and the default binding, as the ask path reads its action
    // unlocked for the connection it names; the row is read again under its lock below.
    const seen = orNotFound(
      await deps.findAuthoredToolById(tx, scope.personId, toolId),
      "Tool not found",
    );
    if (seen.readOnly) {
      throw new ServiceError("BAD_REQUEST", "A read-only tool never asks, so it takes no answer");
    }
    const now = deps.now();
    const asked = await deps.listOpenToolActions(tx, scope, toolId, now);
    const named = [
      ...new Set(
        [seen.defaultConnectionId, ...asked.map((row) => row.connectionId)].filter(
          (id): id is string => typeof id === "string",
        ),
      ),
    ];
    const connections = await deps.findVendorConnectionsForUpdate(
      tx,
      scope.personId,
      seen.vendor,
      named,
    );
    if (!connections.some((row) => row.revokedAt === null)) {
      throw new ServiceError(
        "CONFLICT",
        "This tool's integration is not connected, so no answer is recorded. Reconnect it and the agent asks again.",
        { details: { reason: "connection_revoked" } },
      );
    }
    const open = await deps.listOpenToolActions(tx, scope, toolId, now, { forUpdate: true });
    const tool = orNotFound(
      await deps.findAuthoredToolForUpdate(tx, scope.personId, toolId),
      "Tool not found",
    );
    if (tool.readOnly) {
      throw new ServiceError("BAD_REQUEST", "A read-only tool never asks, so it takes no answer");
    }
    const versionId = tool.currentVersionId;
    if (versionId === null) {
      throw new ServiceError(
        "CONFLICT",
        "This tool has no version that passed its dry run yet, so there is no version to answer for",
        { details: { reason: "tool_has_no_version" } },
      );
    }
    const approval = await setApproval({ db: tx }, scope, toolId, decision, deps, {
      asked: { versionId, annotations: { readOnly: tool.readOnly, destructive: tool.destructive } },
      event: CONSOLE,
    });
    await deps.settleAnsweredToolActions(tx, scope, toolId, now);
    const closing =
      decision === "allow" && approval.askEveryCall
        ? []
        : open.filter((row) => decision === "deny" || row.payload.toolVersionId === versionId);
    const answered =
      closing.length === 0
        ? []
        : await deps.answerOpenToolActions(tx, scope, {
            ids: closing.map((row) => row.id),
            answer: { allow: decision === "allow", via: SETTING_ANSWER_VIA },
            at: now,
          });
    return { approval, answeredPendingActionIds: answered.map((row) => row.id) };
  });
}

/**
 * Whether a standing answer was given for this version (ADR 0008: a republished write tool asks
 * again once; GRA-245). Null on either side is no version, which asks.
 */
export function isForVersion(
  approval: Pick<ApprovalRow, "toolVersionId">,
  versionId: string | null,
): boolean {
  return approval.toolVersionId !== null && approval.toolVersionId === versionId;
}

/**
 * ADR 0008 applied to one call, judged on **the version the call runs** (GRA-245, Greptile on
 * #190): the caller pins the version before the gate and passes its id and annotations, and the
 * standing answer counts only when it was given for that version, so a version made current and
 * approved meanwhile never lets an earlier one run on its approval. Beside it, the agent's standing
 * approval for the tool's integration (the amendment of 2026-10-09). A read passes before any row is
 * read; the integration's row is read only when the tool's own says nothing for this version (no
 * answer, or an `allow` for another), since a tool's own `deny` and ask-every-call setting win.
 */
export async function decideToolCall(
  ctx: ServiceContext,
  scope: AgentScope,
  target: { toolId: string; versionId: string; annotations: ToolAnnotations },
  deps: ApprovalDeps,
): Promise<ApprovalVerdict> {
  const tool = orNotFound(
    await deps.findAuthoredToolById(ctx.db, scope.personId, target.toolId),
    "Tool not found",
  );
  const { annotations } = target;
  if (annotations.readOnly) return approvalDecision({ annotations, approval: null });
  const approval = await deps.findApproval(ctx.db, scope, target.toolId);
  const state = approval
    ? {
        decision: approval.decision,
        askEveryCall: approval.askEveryCall,
        forThisVersion: isForVersion(approval, target.versionId),
      }
    : null;
  const ownSays =
    state !== null && (state.decision === "deny" || state.askEveryCall || state.forThisVersion);
  const vendorApproval = ownSays ? null : await deps.findVendorApproval(ctx.db, scope, tool.vendor);
  return approvalDecision({
    annotations,
    approval: state,
    vendorApproval: vendorApproval
      ? { includesDestructive: vendorApproval.includesDestructive }
      : null,
  });
}

/** The agent's standing approval for every tool of one integration (GRA-237), or null. */
export async function getVendorApproval(
  ctx: ServiceContext,
  scope: AgentScope,
  vendor: string,
  deps: ApprovalDeps,
): Promise<VendorApprovalRow | null> {
  return deps.findVendorApproval(ctx.db, scope, vendor);
}

/** What the agent's page lists beside the per-tool approvals: one row per integration allowed. */
export async function listVendorApprovals(
  ctx: ServiceContext,
  scope: AgentScope,
  deps: ApprovalDeps,
): Promise<VendorApprovalRow[]> {
  return deps.listVendorApprovals(ctx.db, scope);
}

/**
 * The person's "Allow every <integration> tool for this agent" (ADR 0008 as amended 2026-10-09;
 * GRA-237), recorded so it holds: one row per agent and vendor, a later answer replacing the
 * destructive choice of an earlier one. Only ever the person's answer, from the console's card or
 * the ask card's `answer_ask` (ADR 0004, ADR 0006); no agent argument reaches here. The write
 * inserts only for an agent of the person's, so a scope naming another person's agent is
 * `NOT_FOUND`.
 */
export async function allowVendor(
  ctx: ServiceContext,
  scope: AgentScope,
  vendor: string,
  options: { includesDestructive: boolean; event: ApprovalEventOrigin | null },
  deps: ApprovalDeps,
): Promise<VendorApprovalRow> {
  return ctx.db.transaction(async (tx) => {
    const now = deps.now();
    const row = orNotFound(
      await deps.upsertVendorApproval(tx, scope, {
        vendor,
        includesDestructive: options.includesDestructive,
        grantedAt: now,
      }),
      "Agent not found",
    );
    await recordVendorEvent(tx, scope, row, "allowed", options.event, now, deps);
    return row;
  });
}

/** A `vendor` event for the approval as it now stands, or as it stood when withdrawn. */
async function recordVendorEvent(
  db: ServiceContext["db"],
  scope: AgentScope,
  row: Pick<VendorApprovalRow, "vendor" | "includesDestructive">,
  action: "allowed" | "withdrew" | "widened" | "narrowed",
  event: ApprovalEventOrigin | null,
  at: Date,
  deps: ApprovalDeps,
): Promise<void> {
  if (!event) return;
  await deps.insertApprovalEvent(db, {
    personId: scope.personId,
    agentId: scope.agentId,
    kind: "vendor",
    action,
    via: event.via,
    vendor: row.vendor,
    includesDestructive: row.includesDestructive,
    pendingActionId: event.pendingActionId ?? null,
    at,
  });
}

/**
 * The line on a connection's confirmation, "Use <integration>'s tools without asking each time"
 * (ADR 0008 as amended 2026-10-09; GRA-239): the standing approval without destructive tools,
 * recorded by the caller in the transaction that makes the connection. It never narrows: an
 * approval already standing for the vendor, destructive tools included or not, is answered as it
 * stands, since connecting a second account of an integration is not an answer about deleting.
 */
export async function allowVendorWhenConnecting(
  ctx: ServiceContext,
  scope: AgentScope,
  vendor: string,
  deps: ApprovalDeps,
  event: ApprovalEventOrigin | null,
): Promise<VendorApprovalRow> {
  return ctx.db.transaction(async (tx) => {
    const standing = await deps.findVendorApproval(tx, scope, vendor);
    if (standing) return standing;
    // Inserted only where none stands, in the statement: a tool's ask answered meanwhile, with
    // destructive tools in, is never written over by this line's narrower yes (Greptile on #182).
    // Recorded only when it inserted, since an approval that already stood was not this answer's.
    const now = deps.now();
    const inserted = await deps.upsertVendorApproval(
      tx,
      scope,
      { vendor, includesDestructive: false, grantedAt: now },
      { keep: true },
    );
    if (inserted) {
      await recordVendorEvent(tx, scope, inserted, "allowed", event, now, deps);
      return inserted;
    }
    return orNotFound(await deps.findVendorApproval(tx, scope, vendor), "Agent not found");
  });
}

/**
 * Withdraw the agent's standing approval for an integration, from the agent's page. Its tools ask
 * again on their next call, each once, unless a tool's own answer stands. Null when none stood.
 */
export async function withdrawVendorApproval(
  ctx: ServiceContext,
  scope: AgentScope,
  vendor: string,
  deps: ApprovalDeps,
): Promise<VendorApprovalRow | null> {
  return ctx.db.transaction(async (tx) => {
    const row = await deps.deleteVendorApproval(tx, scope, vendor);
    if (row) await recordVendorEvent(tx, scope, row, "withdrew", CONSOLE, deps.now(), deps);
    return row;
  });
}

/**
 * Widen an agent's standing approval for an integration to its destructive tools, or narrow it
 * back, from the console (ADR 0008 as amended 2026-10-14; GRA-302). Only one that stands: the
 * console amends an integration's allow, and recording one is an answer's (`allowVendor`). A tool's
 * own `deny` and ask-every-call setting still win over it (`decideToolCall`). Null when none stood.
 */
export async function setVendorApprovalDestructive(
  ctx: ServiceContext,
  scope: AgentScope,
  vendor: string,
  includesDestructive: boolean,
  deps: ApprovalDeps,
): Promise<VendorApprovalRow | null> {
  return ctx.db.transaction(async (tx) => {
    // Read under the row's lock, so a widen and a narrow at once each judge what the other left.
    const before = await deps.findVendorApproval(tx, scope, vendor, { forUpdate: true });
    if (!before) return null;
    // A widen of one already wide, or a narrow of one already narrow, is no change: the row and
    // its moment stay, so the activity read never shows the approval as a second answer.
    if (before.includesDestructive === includesDestructive) return before;
    const now = deps.now();
    const row = await deps.updateVendorApprovalDestructive(tx, scope, vendor, {
      includesDestructive,
      grantedAt: now,
    });
    if (row) {
      const action = includesDestructive ? "widened" : "narrowed";
      await recordVendorEvent(tx, scope, row, action, CONSOLE, now, deps);
    }
    return row;
  });
}

export async function getBuildApproval(
  ctx: ServiceContext,
  scope: AgentScope,
  connectionId: string,
  deps: ApprovalDeps,
): Promise<BuildApprovalRow | null> {
  return deps.findBuildApproval(ctx.db, scope, connectionId);
}

/**
 * What the agent's page lists of the agent's build approvals: one row per connection `acquire` may
 * work against without asking, with the integration it names (ADR 0008 as amended 2026-09-18).
 */
export async function listBuildApprovals(
  ctx: ServiceContext,
  scope: AgentScope,
  deps: ApprovalDeps,
): Promise<BuildApprovalListing[]> {
  return deps.listBuildApprovals(ctx.db, scope);
}

/**
 * Withdraw the agent's build approval for a connection, from the agent's page: the next `acquire`
 * against it asks again, as if never granted. Tools already built are untouched; their own
 * approvals are a separate answer. Null when none stood.
 */
export async function withdrawBuildApproval(
  ctx: ServiceContext,
  scope: AgentScope,
  connectionId: string,
  deps: ApprovalDeps,
): Promise<BuildApprovalRow | null> {
  return ctx.db.transaction(async (tx) => {
    // The connection first, in the order a revoke takes it and then its build approvals, so a
    // withdraw and a revoke at once queue on it: the event's key on the connection would otherwise
    // wait on the revoke's lock while the revoke waits on this row (GRA-341).
    const connection = await deps.findConnectionForNoKeyUpdate(tx, scope.personId, connectionId);
    const row = await deps.deleteBuildApproval(tx, scope, connectionId);
    if (row) {
      await recordBuildEvent(
        tx,
        scope,
        { id: connectionId, vendor: connection?.vendor ?? null },
        "withdrew",
        CONSOLE,
        deps.now(),
        deps,
      );
    }
    return row;
  });
}

/**
 * Grant `acquire` against a connection, once per agent per connection (ADR 0008). The connection
 * must be the person's; whether it is in the agent's *scope* is `acquire`'s own check, made before
 * it asks. Idempotent: a repeated grant answers the standing row.
 */
export async function grantBuildApproval(
  ctx: ServiceContext,
  scope: AgentScope,
  connectionId: string,
  deps: ApprovalDeps,
  event: ApprovalEventOrigin | null,
): Promise<BuildApprovalRow> {
  const connection = orNotFound(
    await deps.findConnection(ctx.db, scope.personId, connectionId),
    "Connection not found",
  );
  return ctx.db.transaction(async (tx) => {
    const now = deps.now();
    const inserted = await deps.insertBuildApproval(tx, {
      agentId: scope.agentId,
      connectionId,
      grantedAt: now,
    });
    if (inserted) {
      // Only a grant that inserted is recorded: a repeat answers the standing row unchanged.
      await recordBuildEvent(tx, scope, connection, "allowed", event, now, deps);
      return inserted;
    }
    return orNotFound(
      await deps.findBuildApproval(tx, scope, connectionId),
      "Connection not found",
    );
  });
}

/**
 * A `build` event: a grant, a withdraw, or a declined build ask, which leaves no row of its own
 * (ADR 0008) but is still the person's answer.
 */
export async function recordBuildEvent(
  db: ServiceContext["db"],
  scope: AgentScope,
  connection: { id: string; vendor: string | null },
  action: "allowed" | "denied" | "withdrew",
  event: ApprovalEventOrigin | null,
  at: Date,
  deps: Pick<ApprovalDeps, "insertApprovalEvent">,
): Promise<void> {
  if (!event) return;
  await deps.insertApprovalEvent(db, {
    personId: scope.personId,
    agentId: scope.agentId,
    kind: "build",
    action,
    via: event.via,
    connectionId: connection.id,
    vendor: connection.vendor,
    pendingActionId: event.pendingActionId ?? null,
    at,
  });
}
