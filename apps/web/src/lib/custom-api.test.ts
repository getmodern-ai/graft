import { DOCS_PROPOSAL_STAGES } from "@graft/mcp/proposal-from-docs";
import { describe, expect, it } from "vitest";

import { ApiError } from "./api";
import {
  accessOptions,
  checklistProgress,
  connectBodyOf,
  connectedToast,
  draftByHand,
  draftFromFailure,
  draftFromProposalState,
  failureOpensForm,
  isLostProposal,
  listInWords,
  onlySentToLine,
  PROPOSAL_STAGES,
  type ProposalState,
  proposalChecklist,
  proposalSummary,
  readStartRefusal,
  usableDocsUrl,
  validateNameStep,
} from "./custom-api";

const running = (patch: Partial<ProposalState> = {}): ProposalState => ({
  id: "cprop_1",
  status: "running",
  stage: "reading_docs",
  name: "Acme Unleashed",
  docsUrl: "https://apidocs.unleashedsoftware.com/auth",
  found: { docsHost: null, scheme: null, primaryHost: null },
  proposal: null,
  unresolvedHosts: [],
  failure: null,
  startedAt: "2026-10-14T00:00:00.000Z",
  settledAt: null,
  ...patch,
});

const PROPOSAL = {
  vendor: "unleashed",
  displayName: "Acme Unleashed",
  scheme: "api_key_header" as const,
  schemeConfig: { headerName: "api-auth-id" },
  primaryHost: "https://api.unleashedsoftware.com",
  hosts: ["api.unleashedsoftware.com", "files.unleashedsoftware.com"],
  docsUrl: "https://apidocs.unleashedsoftware.com/auth",
  hostsSetAside: [],
};

describe("the checklist", () => {
  it("keeps the job's own stage order", () => {
    expect(PROPOSAL_STAGES).toEqual(DOCS_PROPOSAL_STAGES);
  });

  it("marks the stages before the current one done, the current active and the rest pending", () => {
    const lines = proposalChecklist(
      running({
        stage: "checking_address",
        found: {
          docsHost: "apidocs.unleashedsoftware.com",
          scheme: "api_key_header",
          primaryHost: "api.unleashedsoftware.com",
        },
      }),
    );
    expect(lines.map((line) => [line.label, line.status, line.detail])).toEqual([
      ["Found the API docs", "done", "apidocs.unleashedsoftware.com"],
      ["Worked out how it signs in", "done", "API key in a header"],
      ["Checking the address", "active", "api.unleashedsoftware.com"],
      ["Getting it ready for you to check", "pending", null],
    ]);
    expect(proposalChecklist(running())[0]?.label).toBe("Reading the API docs");
    expect(checklistProgress(lines)).toBe(63);
  });

  it("is all done once ready, and marks the stage a failure ended on", () => {
    const ready = proposalChecklist(running({ status: "ready", stage: "preparing" }));
    expect(ready.every((line) => line.status === "done")).toBe(true);
    expect(checklistProgress(ready)).toBe(100);
    const failed = proposalChecklist(running({ status: "failed", stage: "finding_sign_in" }));
    expect(failed.map((line) => line.status)).toEqual(["done", "failed", "pending", "pending"]);
    // The docs line names the pasted link's host once passed, before the job reported its own.
    expect(failed[0]?.detail).toBe("apidocs.unleashedsoftware.com");
  });

  it("names nothing on the first line before the docs are read", () => {
    expect(proposalChecklist(running())[0]?.detail).toBeNull();
  });
});

describe("validateNameStep", () => {
  it("requires a name and a docs link", () => {
    expect(validateNameStep({ name: " ", docsUrl: "" })).toEqual({
      name: "Name the integration",
      docsUrl: "Paste a link to its API docs. Graft reads that page and no other.",
    });
  });

  it("takes an https link on a public host", () => {
    expect(
      validateNameStep({ name: "Acme", docsUrl: "https://apidocs.unleashedsoftware.com" }),
    ).toEqual({});
    expect(validateNameStep({ name: "Acme", docsUrl: "apidocs" }).docsUrl).toMatch(/not a link/);
    expect(validateNameStep({ name: "Acme", docsUrl: "http://example.com" }).docsUrl).toMatch(
      /https/,
    );
    expect(validateNameStep({ name: "Acme", docsUrl: "https://10.0.0.1/docs" }).docsUrl).toBe(
      "10.0.0.1 is not a public address, so Graft does not read it",
    );
  });

  it("holds the name to the connection's length rule, in the field's words", () => {
    expect(validateNameStep({ name: "x".repeat(121), docsUrl: "https://a.com" }).name).toMatch(
      /^A name is 1 to 120 characters/,
    );
  });
});

describe("readStartRefusal", () => {
  it("follows the person's running job rather than showing it", () => {
    const error = new ApiError(409, "CONFLICT", "Already reading", {
      reason: "proposal_running",
      id: "cprop_9",
    });
    expect(readStartRefusal(error)).toEqual({ kind: "running", id: "cprop_9" });
  });

  it("reads the unconfigured state, a field refusal and anything else", () => {
    expect(
      readStartRefusal(
        new ApiError(409, "CONFLICT", "No model", { reason: "acquire_unconfigured" }),
      ),
    ).toEqual({ kind: "unconfigured", message: "No model" });
    expect(
      readStartRefusal(
        new ApiError(400, "BAD_REQUEST", "Not public", {
          reason: "host_not_public",
          field: "docsUrl",
        }),
      ),
    ).toEqual({ kind: "field", field: "docsUrl", message: "Not public" });
    expect(
      readStartRefusal(new ApiError(409, "CONFLICT", "Busy", { reason: "proposals_busy" })),
    ).toEqual({ kind: "other", message: "Busy" });
    expect(readStartRefusal(new TypeError("fetch failed")).kind).toBe("other");
  });
});

describe("usableDocsUrl", () => {
  it("carries a link that passes the docs checks, and drops one the form cannot fix", () => {
    expect(usableDocsUrl(" https://docs.acme.com/auth ")).toBe("https://docs.acme.com/auth");
    expect(usableDocsUrl("docs.acme.com")).toBeNull();
    expect(usableDocsUrl("https://10.0.0.1/docs")).toBeNull();
    expect(usableDocsUrl("")).toBeNull();
  });
});

describe("isLostProposal", () => {
  it("reads only a 404 as a job that is gone", () => {
    expect(isLostProposal(new ApiError(404, "NOT_FOUND", "No such connection proposal"))).toBe(
      true,
    );
    expect(isLostProposal(new ApiError(500, "INTERNAL", "Boom"))).toBe(false);
    expect(isLostProposal(new TypeError("fetch failed"))).toBe(false);
    expect(isLostProposal(null)).toBe(false);
  });
});

describe("the form a job opens", () => {
  it("prefills the proposal, the primary's host out of the additional list", () => {
    const draft = draftFromProposalState(running({ status: "ready", proposal: PROPOSAL }));
    expect(draft).toMatchObject({
      vendor: "unleashed",
      displayName: "Acme Unleashed",
      scheme: "api_key_header",
      primaryHost: "https://api.unleashedsoftware.com",
      hosts: "files.unleashedsoftware.com",
      schemeConfig: { headerName: "api-auth-id", prefix: "" },
      credential: { apiKey: "" },
    });
    expect(draftFromProposalState(running())).toBeNull();
  });

  it("opens a refused proposal as the form, its sentence under the address", () => {
    const state = running({
      status: "failed",
      stage: "checking_address",
      found: { docsHost: "docs.acme.com", scheme: "bearer", primaryHost: null },
      failure: {
        reason: "host_not_public",
        message: "10.0.0.1 is not a public host",
        host: "10.0.0.1",
      },
    });
    expect(failureOpensForm("host_not_public")).toBe(true);
    expect(failureOpensForm("docs_unreadable")).toBe(false);
    const { draft, errors } = draftFromFailure(state);
    expect(draft).toMatchObject({
      vendor: "acme-unleashed",
      displayName: "Acme Unleashed",
      scheme: "bearer",
      primaryHost: "https://10.0.0.1",
      credential: { token: "" },
    });
    expect(errors).toEqual({ primaryHost: "10.0.0.1 is not a public host" });
  });

  it("keeps a refused additional host in the hosts, its sentence there, the address as found", () => {
    const { draft, errors } = draftFromFailure(
      running({
        status: "failed",
        stage: "checking_address",
        found: { docsHost: "docs.acme.com", scheme: "bearer", primaryHost: "api.acme.com" },
        failure: {
          reason: "host_not_public",
          message: "files.acme.com resolves to 10.0.0.5",
          host: "files.acme.com",
        },
      }),
    );
    expect(draft).toMatchObject({ primaryHost: "https://api.acme.com", hosts: "files.acme.com" });
    expect(errors).toEqual({ hosts: "files.acme.com resolves to 10.0.0.5" });
  });

  it("starts the plain form from the name typed", () => {
    expect(draftByHand({ name: " Acme Unleashed ", docsUrl: "" })).toMatchObject({
      vendor: "acme-unleashed",
      displayName: "Acme Unleashed",
      primaryHost: "https://",
    });
    expect(draftByHand({ name: "", docsUrl: "" }).vendor).toBe("");
  });
});

describe("the words around the key", () => {
  it("names every host the key is sent to", () => {
    expect(listInWords(["a"])).toBe("a");
    expect(listInWords(["a", "b", "c"])).toBe("a, b and c");
    expect(onlySentToLine(["api.acme.com", "files.acme.com"])).toBe(
      "Only sent to api.acme.com and files.acme.com. Your agents never see it.",
    );
    expect(onlySentToLine(null)).toMatch(/^Fix the address/);
  });

  it("summarises the folded details", () => {
    const draft = draftFromProposalState(running({ status: "ready", proposal: PROPOSAL }));
    if (!draft) throw new Error("no draft");
    expect(proposalSummary(draft, "apidocs.unleashedsoftware.com")).toBe(
      "api.unleashedsoftware.com · API key in a header · from apidocs.unleashedsoftware.com",
    );
    expect(proposalSummary({ ...draft, primaryHost: "https://" }, null)).toBe(
      "No address yet · API key in a header",
    );
  });

  it("offers Full access first, recommended, and Ask me first", () => {
    const [full, ask] = accessOptions("Unleashed");
    expect(full).toMatchObject({ value: "full", label: "Full access", recommended: true });
    expect(full?.description).toContain("build Unleashed tools");
    expect(ask).toMatchObject({ value: "ask", label: "Ask me first", recommended: false });
  });

  it("toasts by the access chosen", () => {
    expect(connectedToast("Acme", "full")).toEqual({
      title: "Acme connected",
      description: "Your agents can use it now.",
    });
    expect(connectedToast("Acme", "ask").description).toMatch(/ask before/);
  });
});

describe("connectBodyOf", () => {
  it("posts the checked proposal and the access, never a secret", () => {
    const body = connectBodyOf(
      {
        vendor: "unleashed",
        displayName: "Acme",
        scheme: "api_key_header",
        schemeConfig: { headerName: "api-auth-id" },
        primaryHost: "https://api.unleashedsoftware.com",
        hosts: ["api.unleashedsoftware.com"],
      },
      "https://apidocs.unleashedsoftware.com",
      "ask",
    );
    expect(body).toEqual({
      proposal: {
        vendor: "unleashed",
        displayName: "Acme",
        scheme: "api_key_header",
        schemeConfig: { headerName: "api-auth-id" },
        primaryHost: "https://api.unleashedsoftware.com",
        hosts: ["api.unleashedsoftware.com"],
        docsUrl: "https://apidocs.unleashedsoftware.com",
      },
      access: "ask",
    });
    expect(JSON.stringify(body)).not.toContain("credential");
  });
});
