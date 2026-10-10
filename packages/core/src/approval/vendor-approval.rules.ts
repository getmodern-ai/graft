import { starterVendorFor } from "../setup/starter-vendors";

/**
 * The words of the standing approval for an integration (ADR 0008 as amended 2026-10-09; GRA-237),
 * shared by the console's tool card and the ask card so the two say the same: the offer beside
 * Allow, the separate destructive tick (off by default) and the sentence once it is recorded. The
 * ask card is import-free, so the server writes the offer onto the card's data (`allowVendorOffer`)
 * rather than the card spelling it a second time.
 *
 * **Browser-safe**: the console imports this file by path, and it imports only the starter list,
 * which is browser-safe itself.
 */

/**
 * The integration's name as the person reads it: a starter integration's own name (`HubSpot`, not
 * the connection's `HubSpot (work)`), else the connection's display name, which the person or the
 * agent's proposal gave it. Code keeps the vendor slug.
 */
export function integrationNameFor(vendor: string, connectionName: string): string {
  return starterVendorFor(vendor)?.displayName ?? connectionName;
}

export function allowVendorLabel(integrationName: string): string {
  return `Allow every ${integrationName} tool for this agent`;
}

export const ALLOW_VENDOR_DESTRUCTIVE_LABEL = "Include destructive tools";

export function allowVendorDestructiveDescription(integrationName: string): string {
  return `Off, a ${integrationName} tool that can delete or overwrite data still asks you first.`;
}

/** What the ask card draws beside Allow: the offer's words, written by the server. */
export type AllowVendorOffer = {
  integrationName: string;
  label: string;
  destructiveLabel: string;
  destructiveDescription: string;
};

export function allowVendorOffer(vendor: string, connectionName: string): AllowVendorOffer {
  const integrationName = integrationNameFor(vendor, connectionName);
  return {
    integrationName,
    label: allowVendorLabel(integrationName),
    destructiveLabel: ALLOW_VENDOR_DESTRUCTIVE_LABEL,
    destructiveDescription: allowVendorDestructiveDescription(integrationName),
  };
}

/** The sentence once the standing approval is recorded, after the tool's own "Allowed." */
export function vendorApprovalSentence(
  integrationName: string,
  includesDestructive: boolean,
): string {
  return `Every ${integrationName} tool now runs for this agent without asking${
    includesDestructive ? ", destructive ones included" : "; destructive ones still ask"
  }. Withdraw it on the agent's page.`;
}

/**
 * The line under the build approval on a connection's confirmation (ADR 0008 as amended
 * 2026-10-09; GRA-239): the same standing approval, never with destructive tools, pre-ticked on
 * every surface that confirms a connection. The console's cards read these; the ask card carries
 * `vendorToolsOffer` as the server wrote it.
 */
function possessive(name: string): string {
  return name.endsWith("s") ? `${name}'` : `${name}'s`;
}

export function vendorToolsLabel(integrationName: string): string {
  return `Use ${possessive(integrationName)} tools without asking each time`;
}

export const VENDOR_TOOLS_DESCRIPTION =
  "A tool that can delete or overwrite data still asks you first.";

/** What the ask card draws as the second line on a connection's confirmation. */
export type VendorToolsOffer = {
  integrationName: string;
  label: string;
  description: string;
};

export function vendorToolsOffer(vendor: string, connectionName: string): VendorToolsOffer {
  const integrationName = integrationNameFor(vendor, connectionName);
  return {
    integrationName,
    label: vendorToolsLabel(integrationName),
    description: VENDOR_TOOLS_DESCRIPTION,
  };
}

/** The clause once the line was left on and the connection made. */
export function vendorToolsSentence(integrationName: string): string {
  return `${possessive(integrationName)} tools run for this agent without asking; destructive ones still ask.`;
}
