import type { AuthorizationRequestParams, ConsentOutcome } from "@graft/core";
import { authorizationRequestSearch } from "@graft/core/mcp-oauth/mcp-oauth.rules";
import type { ConsentRequestBody, ConsentRequestDescription } from "@graft/server/mcp-oauth";
import { queryOptions } from "@tanstack/react-query";

import { api, type Jsonified } from "./api";

/**
 * The consent page's two calls (ADR 0018; `apps/server/src/mcp-oauth.ts`, "The console's two
 * routes"): describe the authorization request the browser arrived with, then decide it. The
 * shapes are the server's, jsonified. `authorizationRequestSearch` is the same writer the server
 * reads with, so the page cannot carry a parameter the authorization endpoint did not send.
 */

export type ConsentRequest = Jsonified<ConsentRequestDescription>;
export type ConsentDecisionBody = ConsentRequestBody;

export const consentKeys = {
  request: (params: AuthorizationRequestParams) =>
    ["mcp-oauth", "request", authorizationRequestSearch(params).toString()] as const,
};

export const consentRequestQuery = (params: AuthorizationRequestParams) =>
  queryOptions({
    queryKey: consentKeys.request(params),
    queryFn: () =>
      api<ConsentRequest>(`/mcp-oauth/request?${authorizationRequestSearch(params).toString()}`),
    // A refusal here is the request's own — a client or a redirect URI in doubt — and does not
    // change on retry; the toast's Retry would only repeat the refusal.
    retry: false,
  });

export function decideConsent(body: ConsentDecisionBody) {
  return api<Jsonified<ConsentOutcome>>("/mcp-oauth/consent", { method: "POST", body });
}
