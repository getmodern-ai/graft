import {
  type AgentScope,
  type ConnectionOutput,
  consumePendingAction,
  createPendingAction,
  decideToolCall,
  getAgent,
  getApproval,
  getBuildApproval,
  getConnection,
  grantBuildApproval,
  type ServiceContext,
  ServiceError,
  setApproval,
} from "@graft/core";
import type { PendingActionRow } from "@graft/db/repo/pending-action";
import type { AuthoredToolRow } from "@graft/db/repo/tool";
import type { ElicitRequestFormParams, ElicitResult } from "@modelcontextprotocol/sdk/types.js";

import type { McpDeps } from "./deps";
import { handoffUrl, signHandoffToken } from "./handoff";
import { refusal } from "./result";
import { authoredToolName } from "./tool-names";

/**
 * The **approval** on a tool call (CONTEXT.md, *Approval*; ADR 0008), as the MCP server applies
 * it. The rule itself is `@graft/core`'s `approvalDecision`, reached through `decideToolCall`; this
 * file is what happens when the rule says *ask* — the two channels ADR 0006 gives a server to reach
 * a person, and the recording of what they said.
 *
 * **The channel is the client's to choose.** A harness that advertised form elicitation is asked in
 * place, and its accept records the approval and lets the call proceed. One that did not is handed
 * a durable pending action and a signed handoff URL (`handoff.ts`), and the call waits a bounded
 * time for the answer before returning `awaiting_approval` — a result the agent can relay, not a
 * transport error. The pending action stays answerable in the console after the call has returned;
 * a later identical call finds the answer and proceeds without asking again. Elicitation is used for
 * approvals and for nothing else, and never for a secret (ADR 0006).
 *
 * **Two asks, two records.** A tool's ask ends in an `approval` row per agent per tool. `acquire`'s
 * and the execute tool's ask — running code against a connection at all, the moment Graft's model
 * starts reading the person's data — ends in a `build_approval` row per agent per connection, once
 * (`requireBuildApproval`, exported for GRA-29's `acquire`).
 *
 * **A decline holds; a dismissal falls through to the handoff.** The person saying no is an answer,
 * and ADR 0008 says the answer holds — so a decline is recorded as `deny` and every later call is
 * refused `tool_denied` until the console revokes it. A `cancel` is not an answer: nothing is
 * recorded, and the ask goes to the handoff exactly as if the client had advertised no elicitation
 * (ADR 0006, amendment of 2026-09-16). A client can advertise forms it never shows, and what it
 * answers then is its own: Claude Code's non-interactive mode cancels every one, and under the
 * earlier rule, which asked again, such a client never got the person a link (GRA-55). Hermes 0.21.1
 * declines instead, when its own approval surface fails inside (a gateway without a `notify_cb`) and
 * when it runs with no terminal (`hermes chat --oneshot`) and takes its default, Deny; read as the
 * person's no, that refused `acquire` with no link and would have held a `deny` nobody chose against
 * a write tool (GRA-43). So **a decline that arrives faster than a person could read the prompt is
 * read as a dismissal**: the round trip is measured on the clock this module is given, and one under
 * `AUTOMATIC_ANSWER_MS` falls through to the handoff exactly as a `cancel` does, with the handoff
 * saying the client answered on its own (ADR 0006, amendment of 2026-09-18). An accept is taken at
 * any speed. The fall-through is per ask, not per session: the next ask offers the form again,
 * unless the console has answered the earlier one meanwhile — a waiting console answer is taken
 * before any form is offered (`askApproval`). A build ask has no deny row (the schema's reason: a
 * declined `acquire` leaves nothing behind), so a build decline simply refuses.
 *
 * **A destructive tool asks once, like a write; asking every call is the person's opt-in** (ADR
 * 0008, amendment of 2026-09-15). The annotation changes what the ask says — the message names the
 * tool destructive — not how often it comes. The person may set any non-read tool to ask every call,
 * from the ask itself (`askEveryCall` in the answer or the form) or from the agent's page, and back;
 * while it is on, the standing row says `allow` and the rule still says *ask*, so each call's yes is
 * the pending action's or the elicitation's, taken once.
 *
 * **An accept is the yes, with or without the form's fields.** Hermes 0.21.1 renders a form
 * elicitation as its own approval card — Allow Once, Allow Session, Always Allow, Deny — and answers
 * every allow button with `accept` and empty content (GRA-42; `_consent` in its
 * `tools/approval_prompt.py`). So `allow` is optional in the requested schema and its absence reads
 * as true; an `accept` carrying `allow: false` is a form client's no in place, and stays a deny. The
 * three allow buttons reach this file as one `accept`, so every one of them records a standing
 * allow, destructive tool or write, and none touches the ask-every-call setting — Hermes cannot carry
 * the switch, so the message says where it is. The SDK validates the content against the schema
 * before this file sees the result (`Server.elicitInput` in `@modelcontextprotocol/sdk`), so any
 * other mismatch — a wrong-typed field — throws there and falls back to the handoff.
 */

/** A form elicitation the client will answer — the SDK's `Server.elicitInput`, bound. */
export type ElicitForm = (params: ElicitRequestFormParams) => Promise<ElicitResult>;

/**
 * How a session reaches its person in place, if it can. A thunk rather than a value because the
 * client's capabilities arrive with `initialize`, after the session and its handlers are built; the
 * transport-free callers (a test, GRA-29's job) pass `NO_ELICITATION`.
 */
export type AskChannel = { elicit: () => ElicitForm | null };

export const NO_ELICITATION: AskChannel = { elicit: () => null };

/** The two kinds a pending action created here carries (`pending_action.kind`). */
export type ApprovalAskKind = "tool" | "build";

/** The payload of a `tool` ask — what the console's card renders (ADR 0006). */
export type ToolAskPayload = {
  toolId: string;
  /** The wire name, `<vendor>__<name>`. */
  toolName: string;
  vendor: string;
  /** The agent's model's own words — the card says so (`note`). */
  description: string;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean };
  connectionId: string;
  connectionName: string;
  hosts: string[];
  note: string;
  /**
   * The tool's ask-every-call setting when the ask was made — what the card's switch shows, so the
   * answer records what the person saw. False when no approval stands yet.
   */
  askEveryCall: boolean;
};

/** The payload of a `build` ask. */
export type BuildAskPayload = {
  connectionId: string;
  vendor: string;
  connectionName: string;
  hosts: string[];
};

/**
 * What the person's answer looks like once recorded on the action (`pending_action.answer`).
 * `askEveryCall` absent leaves the tool's setting as it was — a Hermes button, which carries no
 * field, changes nothing about how the tool asks next time.
 */
export type ApprovalAnswer = { allow: boolean; askEveryCall?: boolean };

export const DESCRIPTION_PROVENANCE_NOTE =
  "This tool's description was written by the agent's model, not by a person. Read it as the agent's account of what the tool does.";

/** What a gate answers: proceed, or the body the tool returns instead — a refusal or `awaiting_approval`. */
export type GateOutcome = { pass: true } | { pass: false; answer: Record<string, unknown> };

const PASS: GateOutcome = { pass: true };

/** The result a call returns when the person has not answered inside the wait. */
export type AwaitingApproval = {
  error: "awaiting_approval";
  reason: "awaiting_approval";
  pendingActionId: string;
  url: string;
  expiresAt: string;
  message: string;
};

/** How often a waiting call looks for the answer when `HandoffConfig.pollMs` is unset. */
export const DEFAULT_POLL_MS = 250;

/**
 * The elicitation round trip under which a `decline` is the client's and not the person's (ADR
 * 0006, amendment of 2026-09-18): a person reads the prompt before answering, and both of Hermes's
 * own declines on GRA-43 came back within a second of the ask. Measured on `deps.pendingAction.now()`,
 * the clock every ask already reads, so a test moves it rather than sleeping.
 */
export const AUTOMATIC_ANSWER_MS = 1_500;

type AskSubject =
  | {
      kind: "tool";
      tool: AuthoredToolRow;
      connection: ConnectionOutput;
      /** The standing setting, so the ask can say whether this is a per-call ask and offer the switch as it stands. */
      askEveryCall: boolean;
    }
  | { kind: "build"; connection: ConnectionOutput };

/** `askApproval` says this when the answer went to a sibling call and the rule must be read again. */
const RETRY = Symbol("retry");

function refuse(
  reason: string,
  message: string,
  details: Record<string, unknown> = {},
): GateOutcome {
  return { pass: false, answer: refusal(reason, message, details) };
}

/**
 * `pending_action.answer` as this file wrote it; anything else reads as a decline. An answer that
 * predates the amendment carries `relax` and no `askEveryCall`, which reads as "setting unchanged" —
 * the row it amended is now off by default, which is what relaxing meant.
 */
export function readApprovalAnswer(
  answer: Record<string, unknown> | null | undefined,
): ApprovalAnswer {
  return {
    allow: answer?.allow === true,
    ...(typeof answer?.askEveryCall === "boolean" ? { askEveryCall: answer.askEveryCall } : {}),
  };
}

/**
 * ADR 0008 on one authored-tool call, between the scope check and the mint (`run.ts`). `pass`
 * proceeds; `deny` is the person's standing no; `ask` goes to the person through the channel.
 */
export async function gateToolCall(
  ctx: ServiceContext,
  scope: AgentScope,
  args: { tool: AuthoredToolRow; connectionId: string },
  deps: McpDeps,
  channel: AskChannel,
): Promise<GateOutcome> {
  const { tool } = args;
  const wire = authoredToolName(tool.vendor, tool.name);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const verdict = await decideToolCall(ctx, scope, tool.id, deps.approval);
    if (verdict === "pass") return PASS;
    if (verdict === "deny") {
      return refuse(
        "tool_denied",
        `The person declined ${wire} for this agent, and that answer holds. Ask them to change it in the console rather than retrying.`,
      );
    }
    const connection = await getConnection(
      ctx,
      { personId: scope.personId },
      args.connectionId,
      deps.connection,
    );
    if (!connection) {
      return refuse(
        "connection_not_found",
        `${wire} is bound to connection ${args.connectionId}, which no longer exists.`,
      );
    }
    // Read only on the ask path: whether this ask is the person's own per-call setting at work, so
    // the message can say so and the form's switch can show where it stands.
    const standing = await getApproval(ctx, scope, tool.id, deps.approval);
    const outcome = await askApproval(
      ctx,
      scope,
      { kind: "tool", tool, connection, askEveryCall: standing?.askEveryCall === true },
      deps,
      channel,
    );
    if (outcome !== RETRY) return outcome;
  }
  return refuse(
    "approval_declined",
    `The answer to ${wire}'s ask was taken by another call of this agent. Call again.`,
  );
}

/**
 * The build approval (ADR 0008: `acquire` against a connection asks once per agent per connection),
 * for the execute tool and for GRA-29's `acquire`: present, pass; absent, the ask. The connection's
 * place in the agent's scope is the caller's check, made before this one.
 */
export async function requireBuildApproval(
  ctx: ServiceContext,
  scope: AgentScope,
  connectionId: string,
  deps: McpDeps,
  channel: AskChannel = NO_ELICITATION,
): Promise<GateOutcome> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (await getBuildApproval(ctx, scope, connectionId, deps.approval)) return PASS;
    const connection = await getConnection(
      ctx,
      { personId: scope.personId },
      connectionId,
      deps.connection,
    );
    if (!connection) {
      return refuse("connection_not_found", `Connection ${connectionId} does not exist.`);
    }
    const outcome = await askApproval(ctx, scope, { kind: "build", connection }, deps, channel);
    if (outcome !== RETRY) return outcome;
  }
  return refuse(
    "approval_declined",
    "The answer to this connection's build ask was taken by another call of this agent. Call again.",
  );
}

async function askApproval(
  ctx: ServiceContext,
  scope: AgentScope,
  subject: AskSubject,
  deps: McpDeps,
  channel: AskChannel,
): Promise<GateOutcome | typeof RETRY> {
  const agent = await getAgent(ctx, { personId: scope.personId }, scope.agentId, deps.agent);
  const agentName = agent?.name ?? scope.agentId;
  const waiting = await findWaitingAsk(ctx, scope, subject, deps);
  const elicit = channel.elicit();
  // A console answer already waiting for this ask is taken before any form is offered: it is the
  // person's answer to this very ask, and a form answered first would overtake it and leave it to be
  // spent on a later call it was never given for (Greptile on #34). An ask still open is offered in
  // place; the handoff reuses its row when the form carries no answer.
  if (elicit && !waiting?.answeredAt) {
    const outcome = await askByElicitation(ctx, scope, subject, agentName, deps, elicit);
    if (!("unanswered" in outcome)) return outcome;
    // The client advertised elicitation and then carried no answer — the request failed, the form
    // came back `cancel`, or a `decline` came back faster than a person could read it — so fall
    // through to the channel that works for every harness (ADR 0006, amendments of 2026-09-16 and
    // 2026-09-18), and the person is still asked.
    return askByHandoff(ctx, scope, subject, deps, waiting, outcome.unanswered === "automatic");
  }
  return askByHandoff(ctx, scope, subject, deps, waiting, false);
}

/**
 * The action a previous call left for this ask, if any — answered while the agent was away, or still
 * open; never one consumed or expired (`listPendingActionsByKind`).
 */
async function findWaitingAsk(
  ctx: ServiceContext,
  scope: AgentScope,
  subject: AskSubject,
  deps: McpDeps,
): Promise<PendingActionRow | null> {
  const targetId = subject.kind === "tool" ? subject.tool.id : subject.connection.id;
  const rows = await deps.listPendingActionsByKind(
    ctx.db,
    scope,
    subject.kind,
    deps.pendingAction.now(),
  );
  return rows.find((row) => targetOf(row) === targetId) ?? null;
}

/** How the form came back, in the log line's words; `automatic` is a decline the rule set aside. */
function describeOutcome(action: ElicitResult["action"], automatic: boolean): string {
  if (automatic) return "declined by the client on its own";
  if (action === "cancel") return "cancelled by the client";
  return action === "decline" ? "declined" : "accepted";
}

/** What the ask is about, in one clause, for the message and the card. */
function whatIsAsked(subject: AskSubject): string {
  const where = `${subject.connection.displayName} (${subject.connection.vendor})`;
  return subject.kind === "tool"
    ? `${authoredToolName(subject.tool.vendor, subject.tool.name)} runs against ${where}`
    : `code runs against ${where} for this agent`;
}

/** The elicitation's message: the agent, the tool or connection, the vendor, and whose words the description is. */
export function describeAsk(subject: AskSubject, agentName: string): string {
  const { connection } = subject;
  const where = `${connection.displayName} (${connection.vendor}: ${connection.hosts.join(", ")})`;
  if (subject.kind === "build") {
    return (
      `Your agent "${agentName}" wants Graft to run code against ${where} — the moment Graft's model starts reading your data there through dry-run reads. ` +
      "Allow it once, for this agent and this connection?"
    );
  }
  const { tool } = subject;
  const wire = authoredToolName(tool.vendor, tool.name);
  const nature = tool.destructive
    ? "This tool is destructive — it can delete or overwrite data."
    : "This tool can change data at the vendor.";
  const holds = subject.askEveryCall
    ? 'You have set this tool to ask every time, so this answer is for this call only. To let an answer hold instead, turn "Ask every time for this tool" off on the agent\'s page in the console.'
    : 'Your answer holds for this agent from now on. To be asked before every call instead, turn on "Ask every time for this tool" on the agent\'s page in the console.';
  return (
    `Your agent "${agentName}" wants to run ${wire} against ${where}. ${nature} ${holds} ` +
    `Its description, in the agent's model's own words: "${tool.description}"`
  );
}

/**
 * The form: a boolean `allow`, optional because an `accept` without it is the yes (the header, on
 * Hermes 0.21.1), and for a tool ask a second boolean `askEveryCall`, defaulting to where the
 * setting stands. Nothing is required: the SDK validates the client's content against this schema
 * before `askByElicitation` reads it.
 */
export function elicitationSchemaFor(
  subject: AskSubject,
): ElicitRequestFormParams["requestedSchema"] {
  return {
    type: "object",
    properties: {
      allow: {
        type: "boolean",
        title: "Allow",
        description: `${
          subject.kind === "tool"
            ? "Let this agent run this tool."
            : "Let Graft run code against this connection for this agent."
        } Accepting without this field counts as allow.`,
      },
      ...(subject.kind === "tool"
        ? {
            askEveryCall: {
              type: "boolean",
              title: "Ask every time for this tool",
              description:
                "Only with Allow: ask before every call of this tool for this agent, until turned off. Off, your answer holds.",
              default: subject.askEveryCall,
            },
          }
        : {}),
    },
  };
}

/**
 * The elicitation's result as an answer: `null` for a dismissal (`cancel`), a no for `decline`, and
 * for `accept` a yes unless the content says `allow: false` — absent reads as true (the header, on
 * Hermes 0.21.1). `askEveryCall` rides along only when the client set it; Hermes never does, so a
 * button leaves the setting alone. Only a boolean or nothing can stand under either field here: the
 * SDK has validated the content against `elicitationSchemaFor`'s schema and thrown on anything else.
 */
function readElicitationAnswer(result: ElicitResult): ApprovalAnswer | null {
  if (result.action === "cancel") return null;
  if (result.action !== "accept") return { allow: false };
  const content = result.content ?? {};
  return {
    allow: content.allow === undefined || content.allow === true,
    ...(typeof content.askEveryCall === "boolean" ? { askEveryCall: content.askEveryCall } : {}),
  };
}

/**
 * Why the form carried no answer, when it did not: the request `failed`, the person or the client
 * `cancelled` it, or the client declined it on its own — `automatic`, the one the handoff says out
 * loud. The caller goes to the handoff on all three.
 */
type Unanswered = { unanswered: "failed" | "cancelled" | "automatic" };

/**
 * The ask through the client's form, and the one log line per elicitation an operator reads: the
 * outcome, the round trip in milliseconds and whether the client answered for the person, so a
 * client that cannot render forms can be told from one that never had them, and either from a
 * person who read the card. Measured on the clock the module is given, never `Date.now()`.
 */
async function askByElicitation(
  ctx: ServiceContext,
  scope: AgentScope,
  subject: AskSubject,
  agentName: string,
  deps: McpDeps,
  elicit: ElicitForm,
): Promise<GateOutcome | Unanswered> {
  const askedAt = deps.pendingAction.now().getTime();
  let result: ElicitResult;
  try {
    result = await elicit({
      mode: "form",
      message: describeAsk(subject, agentName),
      requestedSchema: elicitationSchemaFor(subject),
    });
  } catch (error) {
    console.warn("mcp: elicitation failed, falling back to a handoff", error);
    return { unanswered: "failed" };
  }
  const roundTripMs = deps.pendingAction.now().getTime() - askedAt;
  // Only a decline is judged by its speed (the header, on GRA-43): a cancel already falls through,
  // and an accept is taken however fast — the harm the rule guards against is a no nobody chose
  // being held against the person.
  const automatic = result.action === "decline" && roundTripMs < AUTOMATIC_ANSWER_MS;
  const said = automatic ? null : readElicitationAnswer(result);
  console.info(
    `mcp: elicitation ${describeOutcome(result.action, automatic)} for ${whatIsAsked(subject)}${
      said === null ? ", falling back to a handoff" : ""
    }`,
    { action: result.action, roundTripMs, automatic },
  );
  if (said === null) {
    // The form closed without an answer — by the person, by a client that never showed it (Claude
    // Code in `-p` mode, GRA-55), or by a client answering for the person (Hermes with no terminal,
    // GRA-43). Nothing is recorded; the handoff gets the person a link either way.
    return { unanswered: automatic ? "automatic" : "cancelled" };
  }
  if (said.allow) {
    await recordAllow(ctx, scope, subject, said.askEveryCall, deps);
    return PASS;
  }
  await recordDeny(ctx, scope, subject, deps);
  return refuse(
    "approval_declined",
    subject.kind === "tool"
      ? `The person declined ${whatIsAsked(subject)}. That answer holds for this agent; they can change it in the console.`
      : `The person declined ${whatIsAsked(subject)}. The next call asks again.`,
  );
}

/** The action a previous call left for this target, if any — answered or still open, not expired. */
function targetOf(row: PendingActionRow): string | null {
  const payload = row.payload;
  const target = row.kind === "tool" ? payload.toolId : payload.connectionId;
  return typeof target === "string" ? target : null;
}

function payloadFor(subject: AskSubject): ToolAskPayload | BuildAskPayload {
  const { connection } = subject;
  if (subject.kind === "build") {
    return {
      connectionId: connection.id,
      vendor: connection.vendor,
      connectionName: connection.displayName,
      hosts: connection.hosts,
    };
  }
  const { tool } = subject;
  return {
    toolId: tool.id,
    toolName: authoredToolName(tool.vendor, tool.name),
    vendor: tool.vendor,
    description: tool.description,
    annotations: { readOnlyHint: tool.readOnly, destructiveHint: tool.destructive },
    connectionId: connection.id,
    connectionName: connection.displayName,
    hosts: connection.hosts,
    note: DESCRIPTION_PROVENANCE_NOTE,
    askEveryCall: subject.askEveryCall,
  };
}

/**
 * The ask through the console: the waiting action or a new one, and a bounded wait for its answer.
 * `automatic` is the elicitation branch saying the client declined for the person, so the message
 * can say why the agent is being handed a link it might not expect (GRA-43).
 */
async function askByHandoff(
  ctx: ServiceContext,
  scope: AgentScope,
  subject: AskSubject,
  deps: McpDeps,
  waiting: PendingActionRow | null,
  automatic: boolean,
): Promise<GateOutcome | typeof RETRY> {
  const action =
    waiting ??
    (await createPendingAction(
      ctx,
      scope,
      {
        kind: subject.kind,
        payload: payloadFor(subject),
        ttlMs: deps.handoff.ttlMs,
        connectionId: subject.connection.id,
      },
      deps.pendingAction,
    ));
  const url = handoffUrl(
    deps.handoff.consoleUrl,
    action.id,
    signHandoffToken(action, deps.handoff.secret),
  );

  const deadline = Date.now() + Math.max(0, deps.handoff.waitMs);
  const poll = deps.handoff.pollMs ?? DEFAULT_POLL_MS;
  for (;;) {
    let taken: PendingActionRow | null;
    try {
      taken = await consumePendingAction(ctx, scope, action.id, deps.pendingAction);
    } catch (error) {
      if (error instanceof ServiceError && error.code === "GONE") {
        return refuse(
          "approval_expired",
          `The ask for ${whatIsAsked(subject)} expired before the person answered. Calling again asks afresh.`,
          { pendingActionId: action.id },
        );
      }
      // The answer went to a sibling call of this agent between the lookup and the take: the rule is
      // read again, and a tool set to ask every call then asks afresh as it should.
      if (error instanceof ServiceError && error.code === "CONFLICT") return RETRY;
      throw error;
    }
    if (taken) return applyAnswer(ctx, scope, subject, taken, deps);
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(poll, remaining)));
  }

  // What the answer will mean to the next call: a tool set to ask every time takes one yes per call.
  const afterAnswer =
    subject.kind === "tool" && subject.askEveryCall
      ? "Call again once they have answered — the person has set this tool to ask every time, so their yes is for that one call and the call after it asks again."
      : "Call again once they have answered — the answer is kept, and the call then proceeds without asking.";
  // A client that declined the prompt for the person is told so, or the agent reads a link where it
  // saw its own client say no and may not relay it.
  const byTheClient = automatic
    ? "Your client answered the approval prompt on its own, faster than a person could read it, so Graft set that answer aside; the person can answer in the console instead. "
    : "";
  const awaiting: AwaitingApproval = {
    error: "awaiting_approval",
    reason: "awaiting_approval",
    pendingActionId: action.id,
    url,
    expiresAt: action.expiresAt.toISOString(),
    message:
      `Graft needs the person's approval before ${whatIsAsked(subject)}. ${byTheClient}Relay this link so they can answer in the console: ${url} ` +
      `It expires at ${action.expiresAt.toISOString()}. ${afterAnswer}`,
  };
  return { pass: false, answer: awaiting };
}

async function applyAnswer(
  ctx: ServiceContext,
  scope: AgentScope,
  subject: AskSubject,
  taken: PendingActionRow,
  deps: McpDeps,
): Promise<GateOutcome> {
  const answer = readApprovalAnswer(taken.answer);
  if (answer.allow) {
    await recordAllow(ctx, scope, subject, answer.askEveryCall, deps);
    return PASS;
  }
  await recordDeny(ctx, scope, subject, deps);
  return refuse(
    "approval_declined",
    subject.kind === "tool"
      ? `The person declined ${whatIsAsked(subject)} in the console. That answer holds for this agent; they can change it there.`
      : `The person declined ${whatIsAsked(subject)} in the console. The next call asks again.`,
    { pendingActionId: taken.id },
  );
}

/**
 * The yes, recorded so it holds (ADR 0008). The console's answer endpoint records the same rows when
 * the person answers there (`apps/server/src/api.ts`); this repeats it only where nothing stands,
 * so a consumed answer is never a yes that the next call cannot see. `askEveryCall` undefined leaves
 * the setting where it was — the header, on Hermes's buttons.
 */
async function recordAllow(
  ctx: ServiceContext,
  scope: AgentScope,
  subject: AskSubject,
  askEveryCall: boolean | undefined,
  deps: McpDeps,
): Promise<void> {
  if (subject.kind === "build") {
    await grantBuildApproval(ctx, scope, subject.connection.id, deps.approval);
    return;
  }
  const standing = await getApproval(ctx, scope, subject.tool.id, deps.approval);
  const settingChanges = askEveryCall !== undefined && standing?.askEveryCall !== askEveryCall;
  if (!standing || standing.decision !== "allow" || settingChanges) {
    // One write for the answer and the setting it carried; `setAskEveryCall` is the console's act
    // and spends waiting answers, which must not happen to the one being applied here.
    await setApproval(ctx, scope, subject.tool.id, "allow", deps.approval, { askEveryCall });
  }
}

/** The no, recorded for a tool (a build ask has no deny row — see the header). */
async function recordDeny(
  ctx: ServiceContext,
  scope: AgentScope,
  subject: AskSubject,
  deps: McpDeps,
): Promise<void> {
  if (subject.kind !== "tool") return;
  const standing = await getApproval(ctx, scope, subject.tool.id, deps.approval);
  if (!standing || standing.decision !== "deny") {
    await setApproval(ctx, scope, subject.tool.id, "deny", deps.approval);
  }
}
