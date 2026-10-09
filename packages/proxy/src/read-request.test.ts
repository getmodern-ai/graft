import { describe, expect, it } from "vitest";

import { READ_ENDPOINTS } from "./read-endpoints";
import { classifyRequest, parseJsonBody, type RequestToClassify } from "./read-request";

const graphql = (body: unknown, over: Partial<RequestToClassify> = {}): RequestToClassify => ({
  method: "POST",
  host: "api.linear.app",
  path: "/graphql",
  hasQuery: false,
  body: { json: body },
  ...over,
});

describe("classifyRequest: the method", () => {
  it("calls GET and HEAD reads, whatever the host, path or body", () => {
    for (const method of ["GET", "get", "HEAD"]) {
      expect(
        classifyRequest({ method, host: null, path: "/anything", hasQuery: true, body: null }),
      ).toEqual({ read: true, by: "method" });
    }
  });

  it("calls every other method a write when nothing else says read", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      expect(
        classifyRequest({
          method,
          host: "api.example.com",
          path: "/x",
          hasQuery: false,
          body: null,
        }),
      ).toEqual({ read: false });
    }
  });
});

describe("classifyRequest: GraphQL", () => {
  it("calls a POST whose document holds only queries a read", () => {
    expect(classifyRequest(graphql({ query: "query Viewer { viewer { id name } }" }))).toEqual({
      read: true,
      by: "graphql",
    });
    expect(classifyRequest(graphql({ query: "{ issues { nodes { id } } }" }))).toEqual({
      read: true,
      by: "graphql",
    });
  });

  it("admits variables, operationName and fragments beside the queries", () => {
    const query = `
      query A($id: String!) { issue(id: $id) { ...F } }
      query B { viewer { id } }
      fragment F on Issue { id title }
    `;
    expect(classifyRequest(graphql({ query, variables: { id: "x" }, operationName: "A" }))).toEqual(
      { read: true, by: "graphql" },
    );
  });

  it("calls a mutation a write", () => {
    expect(
      classifyRequest(
        graphql({ query: 'mutation { issueCreate(input: {title: "x"}) { success } }' }),
      ),
    ).toEqual({ read: false });
  });

  it("calls a mixed document a write, even with operationName naming the query", () => {
    const query = 'query A { viewer { id } } mutation B { issueDelete(id: "x") { success } }';
    expect(classifyRequest(graphql({ query, operationName: "A" }))).toEqual({ read: false });
  });

  it("calls a subscription a write", () => {
    expect(classifyRequest(graphql({ query: "subscription { issueUpdated { id } }" }))).toEqual({
      read: false,
    });
  });

  it("calls a malformed body a write: not JSON, not an object, no query, a document that does not parse", () => {
    expect(classifyRequest({ ...graphql(null), body: null })).toEqual({ read: false });
    expect(classifyRequest(graphql([{ query: "{ a }" }]))).toEqual({ read: false });
    expect(classifyRequest(graphql("{ a }"))).toEqual({ read: false });
    expect(classifyRequest(graphql({ variables: {} }))).toEqual({ read: false });
    expect(classifyRequest(graphql({ query: 42 }))).toEqual({ read: false });
    expect(classifyRequest(graphql({ query: "query { a " }))).toEqual({ read: false });
    expect(classifyRequest(graphql({ query: "" }))).toEqual({ read: false });
    expect(classifyRequest(graphql({ query: "fragment F on X { a }" }))).toEqual({ read: false });
    expect(classifyRequest(graphql({ query: "type Query { a: Int }" }))).toEqual({ read: false });
  });

  it("calls a persisted query a write, with or without a document beside the hash", () => {
    const extensions = { persistedQuery: { version: 1, sha256Hash: "abc" } };
    expect(classifyRequest(graphql({ extensions }))).toEqual({ read: false });
    expect(classifyRequest(graphql({ query: "{ a }", extensions }))).toEqual({ read: false });
    expect(classifyRequest(graphql({ id: "abc" }))).toEqual({ read: false });
  });

  it("calls a body with a key GraphQL does not define a write, since a REST write may carry a query field", () => {
    expect(classifyRequest(graphql({ query: "{ a }", text: "hello" }))).toEqual({ read: false });
  });

  it("reads GraphQL only at a GraphQL endpoint, with no query string", () => {
    const body = { query: "{ a }" };
    expect(classifyRequest(graphql(body, { path: "/v1/messages" }))).toEqual({ read: false });
    expect(classifyRequest(graphql(body, { path: "/graphql/x" }))).toEqual({ read: false });
    expect(classifyRequest(graphql(body, { hasQuery: true }))).toEqual({ read: false });
    expect(classifyRequest(graphql(body, { path: "/admin/api/2025-01/graphql.json" }))).toEqual({
      read: true,
      by: "graphql",
    });
    // The host is not needed: the operation is in the body.
    expect(classifyRequest(graphql(body, { host: null }))).toEqual({ read: true, by: "graphql" });
  });

  it("reads GraphQL over POST only", () => {
    expect(classifyRequest(graphql({ query: "{ a }" }, { method: "PUT" }))).toEqual({
      read: false,
    });
  });
});

describe("classifyRequest: the reviewed table", () => {
  const search = (over: Partial<RequestToClassify>): RequestToClassify => ({
    method: "POST",
    host: "api.hubapi.com",
    path: "/crm/v3/objects/contacts/search",
    hasQuery: false,
    body: null,
    ...over,
  });

  it("calls a table hit a read, whatever the body", () => {
    expect(classifyRequest(search({}))).toEqual({ read: true, by: "endpoint" });
    expect(classifyRequest(search({ path: "/crm/v3/objects/companies/search" }))).toEqual({
      read: true,
      by: "endpoint",
    });
    expect(
      classifyRequest(search({ host: "api.apollo.io", path: "/api/v1/mixed_people/api_search" })),
    ).toEqual({ read: true, by: "endpoint" });
  });

  it("calls a miss on the host, the method or the path a write", () => {
    expect(classifyRequest(search({ host: "api.example.com" }))).toEqual({ read: false });
    expect(classifyRequest(search({ host: null }))).toEqual({ read: false });
    expect(classifyRequest(search({ method: "PUT" }))).toEqual({ read: false });
    expect(classifyRequest(search({ path: "/crm/v3/objects/contacts" }))).toEqual({ read: false });
    expect(classifyRequest(search({ path: "/crm/v3/objects/contacts/batch/search" }))).toEqual({
      read: false,
    });
    expect(classifyRequest(search({ path: "/crm/v3/objects/contacts/search/" }))).toEqual({
      read: false,
    });
  });

  it("matches a wildcard segment only to a plain name, never an encoded slash or a dot segment", () => {
    expect(classifyRequest(search({ path: "/crm/v3/objects/contacts%2Fbatch/search" }))).toEqual({
      read: false,
    });
    expect(classifyRequest(search({ path: "/crm/v3/objects/../search" }))).toEqual({ read: false });
    expect(classifyRequest(search({ path: "/crm/v3/objects//search" }))).toEqual({ read: false });
  });

  it("is data alone: every entry is a POST on a lower-case host with an absolute path", () => {
    for (const entry of READ_ENDPOINTS) {
      expect(entry.method).toBe("POST");
      expect(entry.host).toBe(entry.host.toLowerCase());
      expect(entry.path.startsWith("/")).toBe(true);
      expect(entry.reason.length).toBeGreaterThan(0);
    }
  });
});

describe("parseJsonBody", () => {
  it("parses a UTF-8 JSON body and answers null for anything else", () => {
    const encode = (text: string) => new TextEncoder().encode(text);
    expect(parseJsonBody(encode('{"query":"{ a }"}'))).toEqual({ json: { query: "{ a }" } });
    expect(parseJsonBody(encode("not json"))).toBeNull();
    expect(parseJsonBody(new Uint8Array([0xff, 0xfe]))).toBeNull();
    expect(parseJsonBody(null)).toBeNull();
  });
});
