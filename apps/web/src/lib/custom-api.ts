import { validateDisplayName, vendorSlugOf } from "@graft/core/connection/connection.rules";
import { isPublicHost } from "@graft/proxy/public-host";
import type { ConnectAccess, ConnectBody, ConnectionProposalState } from "@graft/server/api";

import { ApiError, type Jsonified } from "./api";
import {
  type ConnectionDraft,
  type ConnectionRegistration,
  type DraftErrors,
  draftFromProposal,
  emptyDraft,
  SCHEME_LABELS,
} from "./connection-form";

/**
 * Flow C, *Add a custom API* (GRA-323; Figma 2120:15303 to 2121:16111): the person names an
 * integration and links its API docs, Graft works out the connection (GRA-299's job, polled), and
 * the person checks it, adds their key and connects (GRA-304's `POST /connect`). Pure, so the
 * dialog's decisions have tests: the name step's checks, what a refused start means, the four
 * checklist lines, the form a proposal or a refusal opens, and the words around the key.
 */

export type ProposalState = Jsonified<ConnectionProposalState>;
/** The job's stage and failure reason (`@graft/mcp`'s `proposal-from-docs.ts`), off the wire type. */
type DocsProposalStage = ProposalState["stage"];
type DocsProposalFailureReason = NonNullable<ProposalState["failure"]>["reason"];

/** The checklist's order: the job's stages (`DOCS_PROPOSAL_STAGES`, pinned in the test). */
export const PROPOSAL_STAGES = [
  "reading_docs",
  "finding_sign_in",
  "checking_address",
  "preparing",
] as const satisfies readonly DocsProposalStage[];

/**
 * The Figma's four lines (2120:15596), as the job's stages name them: what a passed stage did, and
 * what a stage still to come or under way is doing.
 */
export const STAGE_LABELS: Record<DocsProposalStage, { done: string; doing: string }> = {
  reading_docs: { done: "Found the API docs", doing: "Reading the API docs" },
  finding_sign_in: { done: "Worked out how it signs in", doing: "Working out how it signs in" },
  checking_address: { done: "Checked the address", doing: "Checking the address" },
  preparing: { done: "Ready for you to check", doing: "Getting it ready for you to check" },
};

export type ChecklistStatus = "done" | "active" | "pending" | "failed";

export type ChecklistLine = {
  stage: DocsProposalStage;
  label: string;
  /** What the stage found, under its label: the docs host, the sign-in, the address. */
  detail: string | null;
  status: ChecklistStatus;
};

function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/**
 * The four lines as the job stands: the stages before the current one done, the current one
 * active while the job runs (failed where it ended without a proposal), the rest pending; every
 * line done once the proposal is ready. A line's detail appears once its stage has found it.
 */
export function proposalChecklist(state: ProposalState): ChecklistLine[] {
  const current = PROPOSAL_STAGES.indexOf(state.stage);
  const details: Record<DocsProposalStage, string | null> = {
    reading_docs: state.found.docsHost ?? (current > 0 ? hostnameOf(state.docsUrl) : null),
    finding_sign_in: state.found.scheme ? SCHEME_LABELS[state.found.scheme] : null,
    checking_address: state.found.primaryHost,
    preparing: null,
  };
  return PROPOSAL_STAGES.map((stage, index) => {
    const status: ChecklistStatus =
      state.status === "ready" || index < current
        ? "done"
        : index > current
          ? "pending"
          : state.status === "failed"
            ? "failed"
            : "active";
    const label = STAGE_LABELS[stage][status === "done" ? "done" : "doing"];
    return { stage, label, detail: details[stage], status };
  });
}

/** The bar under the checklist, 0 to 100: a done line counts whole, the active one half. */
export function checklistProgress(lines: readonly ChecklistLine[]): number {
  const done = lines.filter((line) => line.status === "done").length;
  const active = lines.some((line) => line.status === "active") ? 0.5 : 0;
  return Math.round(((done + active) / lines.length) * 100);
}

export type NameStepInput = { name: string; docsUrl: string };
export type NameStepErrors = Partial<Record<keyof NameStepInput, string>>;

/**
 * The name step before anything is sent, as the job's own door judges it (`readDocsProposalInput`):
 * a name a connection may carry and a link to the docs, required (the ticket: no web search),
 * https and on a public host, since that is all Graft reads. The server judges both again.
 */
export function validateNameStep(input: NameStepInput): NameStepErrors {
  const errors: NameStepErrors = {};
  const name = input.name.trim();
  if (name.length === 0) errors.name = "Name the integration";
  else {
    const problem = validateDisplayName(name);
    if (problem) errors.name = problem.replace("A connection's display name", "A name");
  }
  const link = input.docsUrl.trim();
  if (link.length === 0) {
    errors.docsUrl = "Paste a link to its API docs. Graft reads that page and no other.";
    return errors;
  }
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    errors.docsUrl = "This is not a link. Paste the docs page's address, starting https://";
    return errors;
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    errors.docsUrl = "The link starts https:// and has no password in it";
  } else if (!isPublicHost(url.hostname.replace(/\.$/, "").toLowerCase())) {
    errors.docsUrl = `${url.hostname} is not a public address, so Graft does not read it`;
  }
  return errors;
}

/** What a refused `POST /api/connection-proposals` means for the dialog. */
export type StartRefusal =
  /** The person's own job still runs (another tab, an earlier try): follow it rather than wait. */
  | { kind: "running"; id: string }
  /** No model reads docs here: the plain form, with the operator's sentence. */
  | { kind: "unconfigured"; message: string }
  /** The server judged a field: its sentence under the input. */
  | { kind: "field"; field: keyof NameStepInput; message: string }
  /** `proposals_busy`, or anything else: the sentence, and the way to set it up by hand. */
  | { kind: "other"; message: string };

export function readStartRefusal(error: unknown): StartRefusal {
  if (!(error instanceof ApiError)) {
    return { kind: "other", message: "Graft could not be reached. Try again." };
  }
  const details = (error.details ?? {}) as { reason?: unknown; id?: unknown; field?: unknown };
  if (details.reason === "proposal_running" && typeof details.id === "string") {
    return { kind: "running", id: details.id };
  }
  if (details.reason === "acquire_unconfigured") {
    return { kind: "unconfigured", message: error.message };
  }
  if (error.status === 400 && (details.field === "name" || details.field === "docsUrl")) {
    return { kind: "field", field: details.field, message: error.message };
  }
  return { kind: "other", message: error.message };
}

/**
 * Whether a failed read of the job means it is gone: a 404 (a restart forgot it, another replica
 * answered, its window passed). Any other failure is the read's, and the same job is read again.
 */
export function isLostProposal(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

/**
 * The refusals a person fixes on the form (ADR 0010: a private address is never sent a key): the
 * sentence above it, the form open with what the job found. Every other failure (the docs could not
 * be read or did not say, the model failed or ran long) offers Try again and the form by hand.
 */
export function failureOpensForm(reason: DocsProposalFailureReason): boolean {
  return reason === "host_not_public" || reason === "input_invalid";
}

/** The form a proposal opens: everything Graft found, nothing secret, every field editable. */
export function draftFromProposalState(state: ProposalState): ConnectionDraft | null {
  return state.proposal ? draftFromProposal(state.proposal) : null;
}

/**
 * The form a refused proposal opens: the person's name, its slug, what the job found of the
 * address and the sign-in, and the refusal's sentence under the input it is about.
 */
export function draftFromFailure(state: ProposalState): {
  draft: ConnectionDraft;
  errors: DraftErrors;
} {
  const base = emptyDraft(state.found.scheme ?? "api_key_header");
  const failure = state.failure;
  const refused = failure?.host ?? null;
  // A refused host is kept in the form, under its sentence, for the person to correct: the
  // address when it is the one refused (or the only one known), else the additional hosts.
  const primary = state.found.primaryHost ?? refused;
  const additional = refused && primary && refused !== primary ? refused : null;
  const draft: ConnectionDraft = {
    ...base,
    vendor: vendorSlugOf(state.name),
    displayName: state.name,
    primaryHost: primary ? `https://${primary}` : base.primaryHost,
    hosts: additional ?? "",
  };
  if (!failure || !failureOpensForm(failure.reason)) return { draft, errors: {} };
  return { draft, errors: { [additional ? "hosts" : "primaryHost"]: failure.message } };
}

/** The plain form, for a deployment with no model or a person who would rather type it. */
export function draftByHand(input: NameStepInput): ConnectionDraft {
  const name = input.name.trim();
  return {
    ...emptyDraft(),
    vendor: name ? vendorSlugOf(name) : "",
    displayName: name,
  };
}

/** "a", "a and b", "a, b and c". */
export function listInWords(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** The line under the key (Figma 2121:15654), naming every host the key goes to (ADR 0010). */
export function onlySentToLine(hosts: readonly string[] | null): string {
  if (!hosts || hosts.length === 0) {
    return "Fix the address below to see where your key is sent. Your agents never see it.";
  }
  return `Only sent to ${listInWords(hosts)}. Your agents never see it.`;
}

/** The folded details' summary: the address, the sign-in, and whose docs it came from. */
export function proposalSummary(draft: ConnectionDraft, docsHost: string | null): string {
  const address = hostnameOf(draft.primaryHost.trim()) ?? "No address yet";
  const parts = [address, SCHEME_LABELS[draft.scheme]];
  if (docsHost) parts.push(`from ${docsHost}`);
  return parts.join(" · ");
}

export type AccessOption = {
  value: ConnectAccess;
  label: string;
  description: string;
  recommended: boolean;
};

/**
 * What the person's agents may do with the integration once it connects (ADR 0008 as amended
 * 2026-10-14): *Full access* records the build approval and the integration's non-destructive tools
 * for the agents whose scope reaches it now; *Ask me first* records nothing.
 */
export function accessOptions(integrationName: string): AccessOption[] {
  return [
    {
      value: "full",
      label: "Full access",
      description: `Your agents can build ${integrationName} tools and use them without asking. Tools that can delete still ask.`,
      recommended: true,
    },
    {
      value: "ask",
      label: "Ask me first",
      description: "Agents ask before they build or use each tool.",
      recommended: false,
    },
  ];
}

/** The proposal `POST /api/connect` routes, as the person checked it, with no secret in it. */
export function connectBodyOf(
  registration: ConnectionRegistration,
  docsUrl: string | null,
  access: ConnectAccess,
): ConnectBody {
  return {
    proposal: {
      vendor: registration.vendor,
      displayName: registration.displayName,
      primaryHost: registration.primaryHost,
      hosts: registration.hosts,
      scheme: registration.scheme,
      schemeConfig: registration.schemeConfig,
      ...(docsUrl ? { docsUrl } : {}),
    },
    access,
  };
}

/** The toast on the integration's page (Figma 2121:16111). */
export function connectedToast(
  displayName: string,
  access: ConnectAccess,
): { title: string; description: string } {
  return {
    title: `${displayName} connected`,
    description:
      access === "full"
        ? "Your agents can use it now."
        : "Your agents can use it now, and ask before they build or use each tool.",
  };
}
