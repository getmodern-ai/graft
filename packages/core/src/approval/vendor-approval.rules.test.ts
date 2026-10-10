import { describe, expect, it } from "vitest";

import {
  ALLOW_VENDOR_DESTRUCTIVE_LABEL,
  allowVendorDestructiveDescription,
  allowVendorLabel,
  allowVendorOffer,
  integrationNameFor,
  VENDOR_TOOLS_DESCRIPTION,
  vendorApprovalSentence,
  vendorToolsLabel,
  vendorToolsOffer,
  vendorToolsSentence,
} from "./vendor-approval.rules";

/** ADR 0008 as amended 2026-10-09 (GRA-237): the words the console's card and the ask card share. */

describe("integrationNameFor", () => {
  it("names a starter integration by its own name, whatever the connection was called", () => {
    expect(integrationNameFor("hubspot", "HubSpot (work)")).toBe("HubSpot");
  });

  it("names any other integration by the connection's name", () => {
    expect(integrationNameFor("demo", "Demo Orders")).toBe("Demo Orders");
  });
});

describe("the offer beside Allow", () => {
  it("says what it allows, for whom", () => {
    expect(allowVendorLabel("HubSpot")).toBe("Allow every HubSpot tool for this agent");
  });

  it("puts destructive tools behind a separate tick that says what leaving it off means", () => {
    expect(ALLOW_VENDOR_DESTRUCTIVE_LABEL).toBe("Include destructive tools");
    expect(allowVendorDestructiveDescription("HubSpot")).toBe(
      "Off, a HubSpot tool that can delete or overwrite data still asks you first.",
    );
  });

  it("is one object the ask card carries", () => {
    expect(allowVendorOffer("demo", "Demo Orders")).toEqual({
      integrationName: "Demo Orders",
      label: "Allow every Demo Orders tool for this agent",
      destructiveLabel: "Include destructive tools",
      destructiveDescription:
        "Off, a Demo Orders tool that can delete or overwrite data still asks you first.",
    });
  });
});

describe("vendorApprovalSentence", () => {
  it("says destructive tools still ask when the tick was left off", () => {
    expect(vendorApprovalSentence("HubSpot", false)).toBe(
      "Every HubSpot tool now runs for this agent without asking; destructive ones still ask. Withdraw it on the agent's page.",
    );
  });

  it("says destructive tools are included when ticked", () => {
    expect(vendorApprovalSentence("HubSpot", true)).toBe(
      "Every HubSpot tool now runs for this agent without asking, destructive ones included. Withdraw it on the agent's page.",
    );
  });
});

/** The second line under the build approval on a connection's confirmation (GRA-239). */
describe("the line when connecting", () => {
  it("offers the integration's tools without asking each time", () => {
    expect(vendorToolsLabel("HubSpot")).toBe("Use HubSpot's tools without asking each time");
  });

  it("writes a name ending in s with the apostrophe alone", () => {
    expect(vendorToolsLabel("Demo Orders")).toBe("Use Demo Orders' tools without asking each time");
  });

  it("says destructive tools are never part of it", () => {
    expect(VENDOR_TOOLS_DESCRIPTION).toBe(
      "A tool that can delete or overwrite data still asks you first.",
    );
  });

  it("is one object the ask card carries, named for the starter integration", () => {
    expect(vendorToolsOffer("hubspot", "HubSpot (work)")).toEqual({
      integrationName: "HubSpot",
      label: "Use HubSpot's tools without asking each time",
      description: "A tool that can delete or overwrite data still asks you first.",
    });
  });

  it("says what was recorded once connected", () => {
    expect(vendorToolsSentence("HubSpot")).toBe(
      "HubSpot's tools run for this agent without asking; destructive ones still ask.",
    );
  });
});
