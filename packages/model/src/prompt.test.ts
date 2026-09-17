import { describe, expect, it } from "vitest";

import { renderProof } from "./prompt";
import type { ProofRead } from "./types";

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

describe("renderProof and the publish gate (GRA-72)", () => {
  const failed: ProofRead = {
    path: "/nope",
    ok: false,
    status: 404,
    body: '{"error":"not found"}',
    error: null,
    redirectTo: null,
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
