import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";

/**
 * The console (`apps/web`, GRA-26) served by the server itself, **same-origin with the API**: the
 * browser talks to one origin, so the session cookie never crosses one and `GRAFT_CORS_ORIGIN` is
 * for the split-origin form alone. A single-page app — files under the build directory answer as
 * files, and any other `GET` that wants HTML answers `index.html`, so a deep link such as a handoff
 * URL (ADR 0006) lands on the router rather than on a 404.
 *
 * Mounted **last** by `createServer`, after the proxy, the MCP endpoint and the API: those have
 * matched by the time a request reaches this app, and the two mount paths are excluded here besides,
 * so an unknown `/api/*` path stays a plain 404 rather than becoming the console's HTML.
 *
 * A directory with no build in it is not a failure at boot. The API is whole without the console, and
 * a deployment may serve the console from elsewhere; so the server starts, and every console path
 * answers a JSON 404 that says where it looked and how to put a build there.
 */

export type ConsoleOptions = {
  /** `GRAFT_CONSOLE_DIR` — where `vite build` wrote the app; relative to the working directory. */
  dir: string;
  /** Path prefixes that are never the console's, whatever the build holds. */
  exclude: readonly string[];
};

export type ConsoleApp = {
  app: Hono;
  /** Whether `index.html` was found under `dir` when the app was built. */
  built: boolean;
  /** The directory as resolved, for the boot line. */
  dir: string;
};

export function createConsoleApp(options: ConsoleOptions): ConsoleApp {
  const dir = resolve(options.dir);
  const built = existsSync(join(dir, "index.html"));
  const app = new Hono();

  const excluded = (path: string) =>
    options.exclude.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));

  if (!built) {
    app.all("*", (c, next) => {
      if (excluded(c.req.path)) return next();
      return c.json(
        {
          error: "console_not_built",
          message: `The console's build is not at ${dir} — run \`pnpm --filter @graft/web build\`, or point GRAFT_CONSOLE_DIR at a directory that holds one`,
        },
        404,
      );
    });
    return { app, built, dir };
  }

  // Files first: hashed assets, the favicon, `index.html` itself at `/`.
  app.use("*", (c, next) => (excluded(c.req.path) ? next() : serveStatic({ root: dir })(c, next)));

  // Then the SPA fallback, for a navigation and nothing else: a missing asset is a 404, not a page.
  app.get("*", (c, next) => {
    if (excluded(c.req.path)) return next();
    const accepts = c.req.header("accept") ?? "";
    if (!accepts.includes("text/html") && !accepts.includes("*/*")) return next();
    return serveStatic({ root: dir, path: "index.html" })(c, next);
  });

  return { app, built, dir };
}
