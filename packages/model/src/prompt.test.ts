import { describe, expect, it } from "vitest";

import { renderProof, systemPrompt } from "./prompt";
import type { ModelJobContext, ProofRead } from "./types";

const answered: ProofRead = {
  path: "/items?limit=1",
  ok: true,
  status: 200,
  body: '{"items":[]}',
  error: null,
  redirectTo: null,
};

describe("renderProof", () => {
  it("renders an answered read with its status and body, and no host advice", () => {
    const text = renderProof(1, [answered]);
    expect(text).toContain("### GET /items?limit=1 → HTTP 200");
    expect(text).not.toContain("Redirected to");
    expect(text).not.toContain("connection's hosts");
  });

  it("renders a redirected read with the host and the job's note, and says a redirect is a host question", () => {
    const redirected: ProofRead = {
      path: "/v1/forecast",
      ok: false,
      status: 303,
      body: null,
      error:
        "The vendor redirected GET /v1/forecast to customer-api.open-meteo.com, which this connection does not declare (it declares api.open-meteo.com).",
      redirectTo: "customer-api.open-meteo.com",
    };
    const text = renderProof(2, [redirected]);
    expect(text).toContain("### GET /v1/forecast → HTTP 303 (failed)");
    expect(text).toContain("Redirected to `customer-api.open-meteo.com`.");
    expect(text).toContain(
      "_The vendor redirected GET /v1/forecast to customer-api.open-meteo.com",
    );
    expect(text).toContain("a question about the connection's hosts, not about the code");
    expect(text).toContain("`ctx.proxyBase(host)`");
  });
});

const context: ModelJobContext = {
  jobId: "job_1",
  personId: "person_1",
  goal: "Return the caller's public IP",
  hints: null,
  connection: {
    id: "conn_1",
    vendor: "httpbin",
    displayName: "httpbin",
    scheme: "none",
    primaryHost: "httpbin.org",
    hosts: ["httpbin.org"],
  },
  skill: "# Authoring a tool\n",
  budget: { maxAttempts: 4, tokenCeiling: 400_000 },
};

describe("systemPrompt", () => {
  /**
   * GRA-73: a tool acquired on 2026-09-17 described itself as returning "the caller's public IP" and
   * returned the proxy's. The rule lives in the paragraph the model reads for every job, and the
   * constant wraps across lines, so the assertion collapses whitespace first.
   */
  it("says a request leaves from Graft's proxy, so the vendor's view of the network is not the person's", () => {
    const prose = systemPrompt(context).replace(/\s+/g, " ");
    expect(prose).toContain("Rules that hold whatever the docs say:");
    expect(prose).toContain(
      "Every request reaches the vendor from Graft's proxy, never from the person's machine, so whatever the vendor infers from the connection — the source address, its geolocation, a rate limit keyed on it, a \"your IP\" or \"your location\" answer — is the proxy's and not the person's, and the tool's description and its output names say so or leave it out.",
    );
  });
});
