import { describe, expect, it } from "vitest";

import { proposalLead, proposalSummary } from "./handoff-copy";

describe("proposalLead (GRA-314)", () => {
  const base = { agentName: "Hermes", integrationName: "Unleashed" };

  it("says who set the proposal up, from whose docs, and what is left to do", () => {
    expect(proposalLead({ ...base, docsUrl: "https://apidocs.example", finish: "key" })).toBe(
      "Hermes set this up from Unleashed's docs. Add your Unleashed key to finish.",
    );
    expect(proposalLead({ ...base, docsUrl: null, finish: "keyless" })).toBe(
      "Hermes set this up. It needs no key.",
    );
    expect(
      proposalLead({
        agentName: "Hermes",
        integrationName: "Notion",
        docsUrl: null,
        finish: "link",
        provider: "Acme Connect",
      }),
    ).toBe("Hermes set this up. Sign in to Notion through Acme Connect to finish.");
  });

  it("names the added hosts of a widening", () => {
    expect(
      proposalLead({
        ...base,
        docsUrl: null,
        finish: "widen",
        addedHosts: ["files.example.com"],
      }),
    ).toBe("Hermes needs Unleashed to reach files.example.com as well. No key is involved.");
  });
});

describe("proposalSummary", () => {
  it("reads host, sign-in and source as the frame does", () => {
    expect(
      proposalSummary({
        primaryHost: "https://api.unleashedsoftware.com/v1",
        scheme: "api_key_header",
        integrationName: "Unleashed",
        docsUrl: "https://apidocs.unleashedsoftware.com",
      }),
    ).toBe("api.unleashedsoftware.com · API key in a header · from Unleashed's docs");
    expect(
      proposalSummary({
        primaryHost: "https://api.notion.com",
        scheme: "relay",
        integrationName: "Notion",
        docsUrl: null,
        provider: "Acme Connect",
      }),
    ).toBe("api.notion.com · signs in through Acme Connect");
  });
});
