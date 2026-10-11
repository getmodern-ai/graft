import {
  integrationNameFor,
  vendorApprovalSentence,
} from "@graft/core/approval/vendor-approval.rules";

/**
 * A tool ask's words in the console (ADR 0008; GRA-237): the integration the card offers to allow
 * at once, the settled line once answered and the toast. The integration's own sentences are
 * `@graft/core`'s `vendor-approval.rules.ts`, which the ask card reads too, so the two doors say
 * the same.
 */

/** What a tool ask's answer may carry, as the console posts it and reads it back. */
export type ToolAnswer = {
  allow?: unknown;
  askEveryCall?: unknown;
  allowVendor?: unknown;
  includesDestructive?: unknown;
} | null;

/** The integration a tool ask is about, as the person reads it; an older ask carries no name. */
export function toolAskIntegrationName(payload: {
  vendor: string;
  connectionName: string;
  integrationName?: string;
}): string {
  return payload.integrationName ?? integrationNameFor(payload.vendor, payload.connectionName);
}

/**
 * The integration a standing approval names, on the agent's page: by a connection of its vendor,
 * else by the slug, the one name left when no connection of the vendor is listed.
 */
export function integrationNameOfVendor(
  vendor: string,
  connections: readonly { vendor: string; displayName: string }[],
): string {
  const connection = connections.find((candidate) => candidate.vendor === vendor);
  return integrationNameFor(vendor, connection?.displayName ?? vendor);
}

function integrationSentence(answer: ToolAnswer, integrationName: string): string | null {
  if (answer?.allow !== true || answer.allowVendor !== true) return null;
  return vendorApprovalSentence(integrationName, answer.includesDestructive === true);
}

export function toolAskSettledSentence(answer: ToolAnswer, integrationName: string): string {
  if (answer?.allow !== true) {
    return "Declined. The no holds for this agent until withdrawn on its page.";
  }
  const own =
    answer.askEveryCall === true
      ? "Approved for this call. The tool asks again next time; turn that off on the agent's page."
      : "Approved. The answer holds for this agent's next calls until withdrawn on its page.";
  const integration = integrationSentence(answer, integrationName);
  return integration ? `${own} ${integration}` : own;
}

export function toolAskToast(
  answer: ToolAnswer,
  integrationName: string,
): { title: string; description: string } {
  const integration = integrationSentence(answer, integrationName);
  if (integration) {
    return {
      title: `Every ${integrationName} tool allowed`,
      description: `The agent's waiting call resumes. ${integration}`,
    };
  }
  return {
    title: "Approved",
    description:
      answer?.askEveryCall === true
        ? "The agent's waiting call resumes, and the tool asks again next time."
        : "The agent's waiting call resumes, and the answer holds for its next calls.",
  };
}
