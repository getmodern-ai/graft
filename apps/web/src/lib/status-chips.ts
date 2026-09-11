import type { Agent, WorkingSetChange } from "./agent-queries";
import type { Approval } from "./approval-queries";
import type { Connection, ConnectionCall, ConnectionStatus } from "./connection-queries";

/**
 * Every status chip the console draws, from one place (GRA-47).
 *
 * A chip is a `Badge` variant and the words in it. Until this file each screen chose both inline —
 * six sites, four of them agreeing by coincidence — so a tone decided once for "connected" had to
 * be re-decided for "allowed" and "ok", and the AGENTS.md sentence that says which tone means what
 * had nothing in the code to point at. The rule the map encodes: `success` for a state in which the
 * thing works — connected, allowed, an ok call, an active agent, a key that is set; `destructive`
 * for one in which it does not and will not until someone acts — revoked, denied, an error, a
 * refused re-consent; `outline` for waiting on something — a credential, a consent, a
 * reconnection, a refused call that changed nothing; `secondary` for the neutral rest.
 *
 * Labels are sentence case, as every label in the console is, and are the chip's whole vocabulary
 * — a call site never composes one. `ToolAnnotations` reads its three from here too, so read-only,
 * write and destructive stay visually distinct by the same rule that keeps a revoked agent red.
 */
export type StatusChip = {
  variant: "success" | "destructive" | "outline" | "secondary";
  label: string;
};

export const AGENT_STATUS_CHIP = {
  active: { variant: "success", label: "Active" },
  revoked: { variant: "destructive", label: "Revoked" },
} as const satisfies Record<"active" | "revoked", StatusChip>;

export function agentStatusChip(agent: Pick<Agent, "revokedAt">): StatusChip {
  return agent.revokedAt ? AGENT_STATUS_CHIP.revoked : AGENT_STATUS_CHIP.active;
}

export const CONNECTION_STATUS_CHIP = {
  connected: { variant: "success", label: "Connected" },
  awaiting_credential: { variant: "outline", label: "Awaiting credential" },
  awaiting_consent: { variant: "outline", label: "Awaiting consent" },
  consent_required: { variant: "destructive", label: "Needs re-consent" },
  revoked: { variant: "destructive", label: "Revoked" },
} as const satisfies Record<ConnectionStatus, StatusChip>;

/** An OAuth connection's missing credential is its client secret, and the chip says so (ADR 0005). */
export const AWAITING_CLIENT_SECRET_CHIP: StatusChip = {
  variant: "outline",
  label: "Awaiting client secret",
};

/**
 * Beside `revoked`, on the connection and on each of its tools: the row is still the person's and
 * comes back when a credential is re-entered (ADR 0007), which is what the second chip promises.
 */
export const AWAITING_RECONNECTION_CHIP: StatusChip = {
  variant: "outline",
  label: "Awaiting reconnection",
};

/**
 * The chips a connection's card wears for its status — one, or two for a revoked connection, whose
 * second chip is the way back (`AWAITING_RECONNECTION_CHIP`).
 */
export function connectionStatusChips(
  connection: Pick<Connection, "oauth">,
  status: ConnectionStatus,
): StatusChip[] {
  if (status === "revoked") {
    return [CONNECTION_STATUS_CHIP.revoked, AWAITING_RECONNECTION_CHIP];
  }
  if (status === "awaiting_credential" && connection.oauth) {
    return [AWAITING_CLIENT_SECRET_CHIP];
  }
  return [CONNECTION_STATUS_CHIP[status]];
}

export const CALL_OUTCOME_CHIP = {
  ok: { variant: "success", label: "OK" },
  error: { variant: "destructive", label: "Error" },
  refused: { variant: "outline", label: "Refused" },
} as const satisfies Record<ConnectionCall["outcome"], StatusChip>;

/** A dry run reached the vendor for reads only (CONTEXT.md, *Dry run*); the chip rides beside the tool name. */
export const DRY_RUN_CHIP: StatusChip = { variant: "outline", label: "Dry run" };

export const APPROVAL_DECISION_CHIP = {
  allow: { variant: "success", label: "Allowed" },
  deny: { variant: "destructive", label: "Denied" },
} as const satisfies Record<Approval["decision"], StatusChip>;

/**
 * `secondary` for a promotion rather than the filled `default`: the history is a list of events,
 * not of states, and a primary-filled chip on every other row read as a call to action. Demotion
 * stays `outline` — the quieter of the pair, as the tool is still one `find_tool` away (ADR 0009).
 */
export const WORKING_SET_CHANGE_CHIP = {
  promote: { variant: "secondary", label: "Promoted" },
  demote: { variant: "outline", label: "Demoted" },
} as const satisfies Record<WorkingSetChange["change"], StatusChip>;

export const MODEL_KEY_STATUS_CHIP = {
  set: { variant: "success", label: "Set" },
  unset: { variant: "outline", label: "Not set" },
} as const satisfies Record<"set" | "unset", StatusChip>;

/**
 * A tool's annotations as the check derived them (ADR 0008): read-only passes without asking, a
 * write asks once, destructive asks every call until relaxed. Three distinct tones because the
 * annotation is what decides whether the person will hear from the tool.
 */
export const TOOL_ANNOTATION_CHIP = {
  "read-only": { variant: "secondary", label: "Read-only" },
  write: { variant: "outline", label: "Write" },
  destructive: { variant: "destructive", label: "Destructive" },
} as const satisfies Record<"read-only" | "write" | "destructive", StatusChip>;

export function toolAnnotationChip(readOnly: boolean, destructive: boolean): StatusChip {
  if (readOnly) return TOOL_ANNOTATION_CHIP["read-only"];
  if (destructive) return TOOL_ANNOTATION_CHIP.destructive;
  return TOOL_ANNOTATION_CHIP.write;
}
