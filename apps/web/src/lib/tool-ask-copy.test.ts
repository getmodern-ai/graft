import { describe, expect, it } from "vitest";

import {
  integrationNameOfVendor,
  toolAskIntegrationName,
  toolAskSettledSentence,
  toolAskToast,
} from "./tool-ask-copy";

/** A tool ask's words once answered, and the integration it offers (GRA-237; ADR 0008 as amended 2026-10-09). */

describe("toolAskIntegrationName", () => {
  it("takes the name the ask carries", () => {
    expect(
      toolAskIntegrationName({
        vendor: "hubspot",
        connectionName: "HubSpot (work)",
        integrationName: "HubSpot",
      }),
    ).toBe("HubSpot");
  });

  it("falls back for an ask made before the name rode on it", () => {
    expect(toolAskIntegrationName({ vendor: "hubspot", connectionName: "HubSpot (work)" })).toBe(
      "HubSpot",
    );
    expect(toolAskIntegrationName({ vendor: "demo", connectionName: "Demo Orders" })).toBe(
      "Demo Orders",
    );
  });
});

describe("integrationNameOfVendor", () => {
  it("names a standing approval's integration on the agent's page", () => {
    const connections = [
      { vendor: "demo", displayName: "Demo Orders" },
      { vendor: "hubspot", displayName: "HubSpot (work)" },
    ];
    expect(integrationNameOfVendor("hubspot", connections)).toBe("HubSpot");
    expect(integrationNameOfVendor("demo", connections)).toBe("Demo Orders");
    // No connection of the vendor left: the slug is all there is.
    expect(integrationNameOfVendor("acme", connections)).toBe("acme");
  });
});

describe("toolAskSettledSentence", () => {
  it("says a no holds", () => {
    expect(toolAskSettledSentence({ allow: false }, "HubSpot")).toBe(
      "Declined. The no holds for this agent until withdrawn on its page.",
    );
  });

  it("says a yes holds, or is for this call when the tool asks every time", () => {
    expect(toolAskSettledSentence({ allow: true }, "HubSpot")).toBe(
      "Approved. The answer holds for this agent's next calls until withdrawn on its page.",
    );
    expect(toolAskSettledSentence({ allow: true, askEveryCall: true }, "HubSpot")).toBe(
      "Approved for this call. The tool asks again next time; turn that off on the agent's page.",
    );
  });

  it("adds the integration's standing approval when the person allowed every tool", () => {
    expect(
      toolAskSettledSentence(
        { allow: true, allowVendor: true, includesDestructive: false },
        "HubSpot",
      ),
    ).toBe(
      "Approved. The answer holds for this agent's next calls until withdrawn on its page. Every HubSpot tool now runs for this agent without asking; destructive ones still ask. Withdraw it on the agent's page.",
    );
  });

  it("ignores the integration beside a no", () => {
    expect(toolAskSettledSentence({ allow: false, allowVendor: true }, "HubSpot")).toBe(
      "Declined. The no holds for this agent until withdrawn on its page.",
    );
  });
});

describe("toolAskToast", () => {
  it("titles the integration's yes as such", () => {
    expect(
      toolAskToast({ allow: true, allowVendor: true, includesDestructive: true }, "HubSpot"),
    ).toEqual({
      title: "Every HubSpot tool allowed",
      description:
        "The agent's waiting call resumes. Every HubSpot tool now runs for this agent without asking, destructive ones included. Withdraw it on the agent's page.",
    });
  });

  it("keeps the tool's own toasts", () => {
    expect(toolAskToast({ allow: true }, "HubSpot")).toEqual({
      title: "Approved",
      description: "The agent's waiting call resumes, and the answer holds for its next calls.",
    });
    expect(toolAskToast({ allow: true, askEveryCall: true }, "HubSpot")).toEqual({
      title: "Approved",
      description: "The agent's waiting call resumes, and the tool asks again next time.",
    });
  });
});
