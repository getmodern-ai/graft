import {
  isSetupPromptHarness,
  mcpResourceUrl,
  SETUP_PROMPT_HARNESSES,
  ServiceError,
  setupPrompt,
} from "@graft/core";
import { Hono } from "hono";
import { cors } from "hono/cors";

/**
 * `GET /api/setup-prompt` (GRA-205): the setup prompt's generic form for this deployment, public, so
 * the marketing site and the docs quickstart read the text the product owns instead of carrying a
 * copy (GRA-211). `?harness=<id>` answers the prompt as `text/plain`; without the parameter, the
 * harnesses as JSON, `{ harnesses: [{ id, label, description }] }`, in the order a picker shows them.
 * An unknown id is refused in the API's shape, `{ error: "BAD_REQUEST", message, details }`.
 *
 * No session and no personalisation: the agent, the connection and the tool are the console's to
 * add (`@graft/core`'s `setupPrompt`), never a public reader's. The MCP URL is `GRAFT_AUTH_URL`'s
 * origin plus `/mcp`, the same URI the protected resource metadata names, so a self-host's prompt
 * names its own server; the sign-in URL is `GRAFT_CONSOLE_URL`.
 *
 * **The origin check does not apply, and nothing is weakened by that**: the route is a read, which
 * `origin-guard.ts` exempts wholesale, it reads no cookie, and it answers the same text to anyone.
 * For the same reason it is CORS-open (`*`, no credentials), which is what lets a page on another
 * origin fetch it; `api.ts` mounts this ahead of the console's credentialed `cors()` and keeps that
 * one off the path, so the two never write headers over each other.
 */
export const SETUP_PROMPT_PATH = "/setup-prompt";

export type SetupPromptRouteOptions = {
  /** `GRAFT_AUTH_URL`: the MCP URL is its origin plus `/mcp`. */
  authUrl: string;
  /** `GRAFT_CONSOLE_URL`: where the prompt tells a person to sign in. */
  consoleUrl: string;
};

/**
 * Whether a request's path is this route's, as the API app sees it: `c.req.path` is the whole path
 * under a mounted app, and the pattern takes the mount as optional as `rate-limit.ts`'s auth door does.
 */
export function isSetupPromptPath(path: string): boolean {
  return /^(\/api)?\/setup-prompt\/?$/.test(path);
}

/** The open CORS policy, mounted on the path by `api.ts` before the console's. */
export const setupPromptCors = cors({ origin: "*", allowMethods: ["GET", "OPTIONS"], maxAge: 600 });

export function createSetupPromptRoutes(options: SetupPromptRouteOptions): Hono {
  const routes = new Hono();
  const mcpUrl = mcpResourceUrl(options.authUrl);
  const harnesses = SETUP_PROMPT_HARNESSES.map(({ id, label, description }) => ({
    id,
    label,
    description,
  }));

  routes.get("/", (c) => {
    const harness = c.req.query("harness");
    if (harness === undefined) return c.json({ harnesses });
    if (!isSetupPromptHarness(harness)) {
      throw new ServiceError(
        "BAD_REQUEST",
        `There is no setup prompt for the harness "${harness}"; the harnesses are ${harnesses
          .map((entry) => entry.id)
          .join(", ")}`,
        { details: { harnesses: harnesses.map((entry) => entry.id) } },
      );
    }
    return c.text(setupPrompt({ harness, mcpUrl, consoleUrl: options.consoleUrl }));
  });

  return routes;
}
