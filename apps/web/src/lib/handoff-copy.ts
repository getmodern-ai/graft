import type { AuthScheme } from "@graft/proxy/types";

import { SCHEME_LABELS } from "./connection-form";

/**
 * The handoff page's words for a connection ask (GRA-314; frames 03d, 03e): the line under the
 * question, saying who set the proposal up and what is left to do, and the summary above *Edit
 * details*, saying where the connection goes, how it signs in and where the proposal came from.
 */

const possessive = (name: string) => (name.endsWith("s") ? `${name}'` : `${name}'s`);

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** What the person does to finish, by how the connection signs in. */
export type ProposalFinish = "key" | "consent" | "link" | "keyless" | "widen";

export function proposalLead(input: {
  agentName: string;
  integrationName: string;
  docsUrl: string | null;
  finish: ProposalFinish;
  provider?: string;
  addedHosts?: readonly string[];
  /** The card's `askedCount` (GRA-300): past one, the lead ends saying how often the agent asked. */
  askedCount?: number;
}): string {
  const asked =
    typeof input.askedCount === "number" &&
    Number.isInteger(input.askedCount) &&
    input.askedCount > 1
      ? ` ${input.agentName} has asked ${input.askedCount} times.`
      : "";
  return `${leadSentences(input)}${asked}`;
}

function leadSentences(input: {
  agentName: string;
  integrationName: string;
  docsUrl: string | null;
  finish: ProposalFinish;
  provider?: string;
  addedHosts?: readonly string[];
}): string {
  const { agentName, integrationName, docsUrl, finish } = input;
  if (finish === "widen") {
    return `${agentName} needs ${integrationName} to reach ${(input.addedHosts ?? []).join(", ")} as well. No key is involved.`;
  }
  const from = docsUrl ? ` from ${possessive(integrationName)} docs` : "";
  const then: Record<Exclude<ProposalFinish, "widen">, string> = {
    key: `Add your ${integrationName} key to finish.`,
    consent: `Sign in to ${integrationName} to finish.`,
    link: `Sign in to ${integrationName} through ${input.provider ?? "the provider"} to finish.`,
    keyless: "It needs no key.",
  };
  return `${agentName} set this up${from}. ${then[finish]}`;
}

const TOKEN_SCHEMES = new Set<string>(["oauth_authorization_code", "oauth2_client_credentials"]);

/**
 * The line under a secret's input: where the secret goes. An OAuth scheme's client secret goes to
 * the token endpoint, never to the API's hosts (ADR 0005; Greptile on #250), so it names that
 * host, or the integration's sign-in where the page does not hold the endpoint (a re-entry).
 */
export function secretHint(input: {
  scheme: AuthScheme | string;
  hosts: readonly string[];
  schemeConfig?: Record<string, unknown> | null;
  agentName: string;
  integrationName: string;
}): string {
  const never = `${input.agentName} never sees it.`;
  if (!TOKEN_SCHEMES.has(input.scheme)) return `Only sent to ${input.hosts.join(", ")}. ${never}`;
  const tokenUrl = input.schemeConfig?.tokenUrl;
  const tokenHost = typeof tokenUrl === "string" ? hostOrNull(tokenUrl) : null;
  return tokenHost
    ? `Only sent to ${tokenHost}, when Graft signs in. ${never}`
    : `Only sent to ${input.integrationName} when Graft signs in. ${never}`;
}

function hostOrNull(url: string): string | null {
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

export function proposalSummary(input: {
  primaryHost: string;
  scheme: AuthScheme | string;
  integrationName: string;
  docsUrl: string | null;
  provider?: string;
}): string {
  const how = input.provider
    ? `signs in through ${input.provider}`
    : (SCHEME_LABELS[input.scheme as AuthScheme] ?? input.scheme);
  return [
    hostOf(input.primaryHost),
    how,
    input.docsUrl ? `from ${possessive(input.integrationName)} docs` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");
}
