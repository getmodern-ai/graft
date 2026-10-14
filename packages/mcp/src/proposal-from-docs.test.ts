import { createScriptedModel, type ModelAdapter, type RawConnectionProposal } from "@graft/model";
import { describe, expect, it } from "vitest";

import {
  type DocsProposalFound,
  type DocsProposalStage,
  PROPOSAL_DOC_WINDOWS,
  PROPOSAL_ERROR_MAX_CHARS,
  proposeConnectionFromDocs,
  readDocsProposalInput,
  vendorSlugOf,
} from "./proposal-from-docs";
import type { ReadWebPage, ResolvedAddress, WebPageResult } from "./web-page";

/**
 * A connection proposal from an API's docs (GRA-299), from the pasted URL to a proposal the
 * connection rules accept, over a scripted model and a fake `readWebPage`: the stages in order,
 * the pages bounded, the rules `request_connection` applies (a private host is `host_not_public`),
 * the address resolved once, and every way it ends without one.
 */

const DOCS_URL = "https://apidocs.unleashed.example/authentication";
const UNLEASHED: RawConnectionProposal = {
  vendor: "unleashed",
  primaryHost: "https://api.unleashed.example/",
  hosts: [],
  scheme: "api_key_header",
  schemeConfig: { headerName: "api-auth-id" },
};

/** A page served in windows of `size` characters, as `readWebPage` pages through `offset`. */
function pagedDocs(text: string, size: number): { read: ReadWebPage; offsets: number[] } {
  const offsets: number[] = [];
  const read: ReadWebPage = async ({ url, offset = 0 }) => {
    offsets.push(offset);
    const content = text.slice(offset, offset + size);
    const end = offset + content.length;
    const truncated = end < text.length;
    return {
      ok: true,
      url,
      title: "Authentication",
      content,
      offset,
      totalCharacters: text.length,
      truncated,
      nextOffset: truncated ? end : null,
      note: "untrusted",
    } satisfies WebPageResult;
  };
  return { read, offsets };
}

const PUBLIC: ResolvedAddress[] = [{ address: "93.184.215.14", family: 4 }];
const publicDns = async () => PUBLIC;

async function run(
  proposal: RawConnectionProposal | null | undefined,
  overrides: {
    read?: ReadWebPage;
    resolveHost?: (host: string) => Promise<ResolvedAddress[]>;
    addressCheckTimeoutMs?: number;
    model?: ModelAdapter;
  } = {},
) {
  const scripted = createScriptedModel(
    [],
    proposal === undefined ? {} : { connectionProposal: proposal },
  );
  const model = overrides.model ?? scripted;
  const stages: DocsProposalStage[] = [];
  const snapshots: DocsProposalFound[] = [];
  const result = await proposeConnectionFromDocs(
    { personId: "person_a", name: "Acme Unleashed", docsUrl: DOCS_URL },
    {
      model,
      readWebPage: overrides.read ?? pagedDocs("Use the api-auth-id header.", 1000).read,
      resolveHost: overrides.resolveHost ?? publicDns,
      ...(overrides.addressCheckTimeoutMs
        ? { addressCheckTimeoutMs: overrides.addressCheckTimeoutMs }
        : {}),
    },
    (stage, found) => {
      stages.push(stage);
      snapshots.push(found);
    },
  );
  return { result, stages, snapshots, model: scripted };
}

describe("proposeConnectionFromDocs", () => {
  it("goes from the URL to a proposal the connection rules accept, through the four stages", async () => {
    const { result, stages, snapshots, model } = await run(UNLEASHED);
    // The address check is announced twice: once with the address, again once the rules took the
    // scheme, so a poll during the lookups shows the sign-in line done.
    expect(stages).toEqual([
      "reading_docs",
      "finding_sign_in",
      "checking_address",
      "checking_address",
      "preparing",
    ]);
    expect(snapshots[3]).toEqual({
      docsHost: "apidocs.unleashed.example",
      scheme: "api_key_header",
      primaryHost: "api.unleashed.example",
    });
    expect(result).toEqual({
      ok: true,
      proposal: {
        vendor: "unleashed",
        displayName: "Acme Unleashed",
        scheme: "api_key_header",
        schemeConfig: { headerName: "api-auth-id" },
        primaryHost: "https://api.unleashed.example",
        hosts: ["api.unleashed.example"],
        docsUrl: DOCS_URL,
        hostsSetAside: [],
      },
      found: {
        docsHost: "apidocs.unleashed.example",
        scheme: "api_key_header",
        primaryHost: "api.unleashed.example",
      },
      unresolvedHosts: [],
      stats: {
        pages: 1,
        characters: 27,
        outcome: "proposed",
        usage: { inputTokens: 500, outputTokens: 100 },
      },
    });
    const [request] = model.connectionProposals;
    expect(request).toMatchObject({
      personId: "person_a",
      traceId: "connect:person_a",
      name: "Acme Unleashed",
      docsUrl: DOCS_URL,
      pages: [{ url: DOCS_URL, content: "Use the api-auth-id header." }],
    });
    expect(request?.schemes.map((s) => s.scheme)).toContain("api_key_header");
    expect(request?.schemes.find((s) => s.scheme === "api_key_header")).toMatchObject({
      required: ["headerName"],
      optional: ["prefix"],
    });
  });

  it("reads at most the bounded windows of the pasted page", async () => {
    const docs = pagedDocs("x".repeat(10_000), 100);
    const { result } = await run(UNLEASHED, { read: docs.read });
    expect(docs.offsets).toEqual([0, 100, 200].slice(0, PROPOSAL_DOC_WINDOWS));
    expect(result.stats).toMatchObject({ pages: PROPOSAL_DOC_WINDOWS, characters: 300 });
  });

  it("refuses a private address as host_not_public, as request_connection does", async () => {
    const { result, stages } = await run({ ...UNLEASHED, primaryHost: "https://10.0.0.5" });
    expect(result).toMatchObject({
      ok: false,
      failure: { reason: "host_not_public", host: "10.0.0.5" },
    });
    expect(stages).not.toContain("preparing");
    const metadata = await run({ ...UNLEASHED, hosts: ["metadata.google.internal"] });
    expect(metadata.result).toMatchObject({ ok: false, failure: { reason: "host_not_public" } });
  });

  it("refuses a public name that resolves to a private address", async () => {
    const { result } = await run(UNLEASHED, {
      resolveHost: async () => [{ address: "169.254.169.254", family: 4 }],
    });
    expect(result).toMatchObject({
      ok: false,
      failure: { reason: "host_not_public", host: "api.unleashed.example" },
    });
  });

  it("keeps a proposal whose host does not resolve, and lists the host for the person", async () => {
    const { result } = await run(UNLEASHED, {
      resolveHost: async () => {
        throw new Error("ENOTFOUND");
      },
    });
    expect(result).toMatchObject({ ok: true, unresolvedHosts: ["api.unleashed.example"] });
  });

  it("lists a host whose lookup outlasts the bound as unresolved, and does not wait on it", async () => {
    const { result } = await run(
      { ...UNLEASHED, hosts: ["files.unleashed.example"] },
      {
        addressCheckTimeoutMs: 20,
        resolveHost: async (host) =>
          host === "files.unleashed.example" ? new Promise(() => {}) : PUBLIC,
      },
    );
    expect(result).toMatchObject({ ok: true, unresolvedHosts: ["files.unleashed.example"] });
  });

  it("judges a bracketed IPv6 address as a literal, never a name to look up", async () => {
    const looked: string[] = [];
    const { result } = await run(
      { ...UNLEASHED, primaryHost: "https://[2606:4700:4700::1111]" },
      {
        resolveHost: async (host) => {
          looked.push(host);
          throw new Error("ENOTFOUND");
        },
      },
    );
    expect(result).toMatchObject({ ok: true, unresolvedHosts: [] });
    expect(looked).toEqual([]);
  });

  it("starts no model call once the caller's deadline has passed", async () => {
    const model = createScriptedModel([], { connectionProposal: UNLEASHED });
    const abandon = new AbortController();
    const result = await proposeConnectionFromDocs(
      { personId: "p", name: "Acme", docsUrl: DOCS_URL, signal: abandon.signal },
      {
        model,
        readWebPage: async (args) => {
          abandon.abort();
          return pagedDocs("docs", 100).read(args);
        },
        resolveHost: publicDns,
      },
    );
    expect(result).toMatchObject({ ok: false, failure: { reason: "proposal_timeout" } });
    expect(model.connectionProposals).toEqual([]);
  });

  it("keeps the provider's failure message, bounded, for the log", async () => {
    const failing: ModelAdapter = {
      name: "failing",
      open: () => {
        throw new Error("never opened");
      },
      proposeConnection: async () => ({
        proposal: null,
        outcome: "failed",
        usage: { inputTokens: 0, outputTokens: 0 },
        error: `529 overloaded ${"x".repeat(1000)}`,
      }),
    };
    const { result } = await run(undefined, { model: failing });
    expect(result).toMatchObject({ ok: false, failure: { reason: "model_failed" } });
    expect(result.stats.error?.startsWith("529 overloaded")).toBe(true);
    expect(result.stats.error?.length).toBe(PROPOSAL_ERROR_MAX_CHARS);
    if (!result.ok) expect(result.failure.message).not.toContain("529");
  });

  it("refuses a proposal that breaks a scheme rule, naming it", async () => {
    const { result } = await run({ ...UNLEASHED, schemeConfig: { headerName: "not a header" } });
    expect(result).toMatchObject({
      ok: false,
      failure: { reason: "input_invalid", message: expect.stringContaining("header name") },
    });
  });

  it("falls back to the person's name for the vendor slug when the model's is not one", async () => {
    const { result } = await run({ ...UNLEASHED, vendor: "Not A Slug!" });
    expect(result).toMatchObject({ ok: true, proposal: { vendor: "acme-unleashed" } });
    expect(vendorSlugOf("  Ünleashed (Prod) ")).toBe("unleashed-prod");
    expect(vendorSlugOf("!!!")).toBe("integration");
  });

  it("ends docs_unreadable when the page cannot be read, before any model call", async () => {
    const { result, model } = await run(UNLEASHED, {
      read: async ({ url }) => ({ ok: false, url, error: "HTTP 404" }),
    });
    expect(result).toMatchObject({
      ok: false,
      failure: { reason: "docs_unreadable", message: expect.stringContaining("HTTP 404") },
    });
    expect(model.connectionProposals).toEqual([]);
  });

  it("ends not_found on the model's decline, and model_unavailable with no model", async () => {
    expect((await run(null)).result).toMatchObject({
      ok: false,
      failure: { reason: "not_found" },
      stats: { outcome: "declined" },
    });
    const none = await proposeConnectionFromDocs(
      { personId: "p", name: "Acme", docsUrl: DOCS_URL },
      { model: null, readWebPage: pagedDocs("docs", 100).read, resolveHost: publicDns },
    );
    expect(none).toMatchObject({ ok: false, failure: { reason: "model_unavailable" } });
  });
});

describe("readDocsProposalInput", () => {
  it("takes a name and a public https link", () => {
    expect(readDocsProposalInput({ name: " Acme ", docsUrl: DOCS_URL })).toEqual({
      ok: true,
      name: "Acme",
      docsUrl: DOCS_URL,
    });
  });

  it("refuses a private documentation host as host_not_public, and a link that is not https", () => {
    expect(
      readDocsProposalInput({ name: "Acme", docsUrl: "https://192.168.1.10/docs" }),
    ).toMatchObject({ ok: false, reason: "host_not_public", field: "docsUrl" });
    expect(
      readDocsProposalInput({ name: "Acme", docsUrl: "http://docs.acme.example" }),
    ).toMatchObject({ ok: false, reason: "input_invalid", field: "docsUrl" });
    expect(readDocsProposalInput({ name: "  ", docsUrl: DOCS_URL })).toMatchObject({
      ok: false,
      field: "name",
    });
  });
});
