import type { UpstreamRequest } from "@graft/proxy";

/**
 * A GitHub-shaped vendor for the SDK scenario: the module is expected to reach it through the
 * official `@octokit/rest` client bound to the proxy (ADR 0010: an SDK reaches a vendor through
 * the proxy or not at all), and what the vendor sees is asserted — the real bearer token the proxy
 * injected, never the capability token, and paths with the proxy's connection segment stripped.
 */

export const GITHUB_VENDOR = "github";
export const GITHUB_DISPLAY_NAME = "GitHub";
export const GITHUB_PRIMARY_HOST = "https://api.github.com";
export const GITHUB_HOSTNAME = "api.github.com";
export const GITHUB_DOCS_URL = "https://docs.github.example/rest/issues";
/** The planted token; GitHub's own prefix, so a leak would read as a real one. */
export const GITHUB_TOKEN = "ghp_evalFakeToken0123456789abcdefghijkl";
export const OCTOKIT_PACKAGE = "@octokit/rest";
/** The exact version the model is told to declare — what `packages/evals` itself installs. */
export const OCTOKIT_VERSION = "22.0.1";

export const GITHUB_ISSUES = [
  {
    number: 31,
    title: "A real model authors, the evals score it",
    state: "open",
    html_url: "https://github.com/getmodern-ai/graft/issues/31",
    user: { login: "aleks" },
  },
  {
    number: 29,
    title: "acquire builds a tool with a scripted model",
    state: "open",
    html_url: "https://github.com/getmodern-ai/graft/issues/29",
    user: { login: "aleks" },
  },
];

export const GITHUB_DOCS_PAGE = `GitHub REST API — Issues

Base URL: https://api.github.com

Authentication
Send a personal access token as a bearer token: Authorization: Bearer <token>.
Requests without a valid token are answered 401 { "message": "Bad credentials" }.

List repository issues

GET /repos/{owner}/{repo}/issues
Query parameters: state (open | closed | all, default open), per_page (1-100, default 30), page.
Response 200: an array of issues, each with number (integer), title (string), state (string),
html_url (string), user ({ login }). Pull requests are issues too and appear in this list with a
pull_request key.

Using the official JavaScript SDK (@octokit/rest)
  import { Octokit } from "@octokit/rest";
  const octokit = new Octokit({ auth: "<token>", baseUrl: "https://api.github.com" });
  const { data } = await octokit.rest.issues.listForRepo({ owner, repo, state: "open", per_page: 30 });
The client takes the token as the auth option and the API's base URL as baseUrl; every method under
octokit.rest.* maps to one REST endpoint.

Errors
404 { "message": "Not Found" } when the repository does not exist or the token cannot see it.
`;

export function respondGithub(request: UpstreamRequest): Response {
  const url = new URL(request.url);
  if (request.headers.get("authorization") !== `Bearer ${GITHUB_TOKEN}`) {
    return Response.json({ message: "Bad credentials" }, { status: 401 });
  }
  const issues = /^\/repos\/([^/]+)\/([^/]+)\/issues$/.exec(url.pathname);
  if (request.method === "GET" && issues) {
    if (issues[1] !== "getmodern-ai" || issues[2] !== "graft") {
      return Response.json({ message: "Not Found" }, { status: 404 });
    }
    const perPage = Math.min(Number(url.searchParams.get("per_page") ?? 30) || 30, 100);
    return Response.json(GITHUB_ISSUES.slice(0, perPage));
  }
  return Response.json({ message: "Not Found" }, { status: 404 });
}
