/**
 * The reviewed table of endpoints that are reads despite their method (ADR 0008 as amended
 * 2026-10-10): a request matching an entry cannot change the vendor's state, so the check
 * annotates a tool that calls only reads as read-only and a dry run lets the call reach the vendor.
 *
 * Data alone, read by `read-request.ts`'s `classifyRequest`. **Adding an entry is a reviewed
 * change**: name the vendor's documentation in `reason` and say why the endpoint changes nothing.
 * `host` is matched exactly and in lower case; `path` segment by segment, where `*` matches one
 * plain segment (letters, digits, `_` and `-`) and nothing else, so an encoded slash or a dot
 * segment never reaches a write route behind it.
 */
export type ReadEndpoint = {
  host: string;
  method: "POST";
  path: string;
  reason: string;
};

export const READ_ENDPOINTS: readonly ReadEndpoint[] = [
  {
    host: "api.hubapi.com",
    method: "POST",
    path: "/crm/v3/objects/*/search",
    reason:
      "HubSpot CRM search (developers.hubspot.com/docs/api/crm/search): filters, sorts and pages records, writes nothing.",
  },
  {
    host: "api.apollo.io",
    method: "POST",
    path: "/api/v1/mixed_people/api_search",
    reason:
      "Apollo People API Search (docs.apollo.io/reference/people-api-search): no credits, writes nothing.",
  },
  {
    host: "api.apollo.io",
    method: "POST",
    path: "/api/v1/mixed_people/search",
    reason:
      "Apollo's paid people search, the older path of the above: bills credits per request, writes nothing in the account.",
  },
  {
    host: "api.apollo.io",
    method: "POST",
    path: "/api/v1/mixed_companies/search",
    reason:
      "Apollo Organization Search (docs.apollo.io/reference/organization-search): may bill credits, writes nothing in the account.",
  },
  {
    host: "api.apollo.io",
    method: "POST",
    path: "/api/v1/accounts/search",
    reason:
      "Apollo Search for Accounts (docs.apollo.io/reference/search-for-accounts): writes nothing.",
  },
  {
    host: "api.apollo.io",
    method: "POST",
    path: "/api/v1/contacts/search",
    reason:
      "Apollo Search for Contacts (docs.apollo.io/reference/search-for-contacts): writes nothing.",
  },
];
