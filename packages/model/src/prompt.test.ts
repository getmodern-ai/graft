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
  reason: null,
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
      reason: null,
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

describe("renderProof and the publish gate (GRA-72)", () => {
  const failed: ProofRead = {
    path: "/nope",
    ok: false,
    status: 404,
    body: '{"error":"not found"}',
    error: null,
    redirectTo: null,
    reason: null,
  };

  it("offers proceed only when every read passed", () => {
    expect(renderProof(1, [answered])).toContain("Answer `proceed` to publish");
    const text = renderProof(1, [answered, failed]);
    expect(text).not.toContain("Answer `proceed`");
    expect(text).toContain("`proceed` is admitted only when every read passed");
    expect(text).toContain("Answer `write_module` with the module or the proof reads changed");
  });

  it("puts the job's refusal before the closing sentence when a proceed was refused", () => {
    const refused = "Your `proceed` was refused: 1 of 2 proof read(s) failed (GET /nope 404).";
    const text = renderProof(1, [answered, failed], refused);
    expect(text.indexOf(refused)).toBeGreaterThan(text.indexOf("### GET /nope"));
    expect(text.indexOf(refused)).toBeLessThan(text.indexOf("`proceed` is admitted only"));
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

  /**
   * GRA-140: on 2026-09-20 every module that listed and then fetched each item named one proof read,
   * the list, and the path whose fields it parsed was never proven before the publish.
   */
  it("asks for a proof read of every distinct path the module reads, not the first alone", () => {
    const prose = systemPrompt(context).replace(/\s+/g, " ");
    expect(prose).toContain(
      "`proofReads` the GET paths that prove the credential and the shape: one for every distinct path the module reads, not the first alone",
    );
    expect(prose).toContain("a path built from another's answer (a record's id from a list)");
  });
});
