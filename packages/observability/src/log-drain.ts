import type { DrainFn } from "evlog";

/**
 * The log drain seam (GRA-100; ADR 0002 as amended 2026-09-19): where a wide event goes after
 * stdout. evlog itself — the logger, one wide event per request or per job event — is the open
 * core's and vendor-neutral; *where the events are shipped* is a backing. The open form has none:
 * the events stay on stdout, which is the container's log, and `initLogger` is handed no drain.
 * The hosted form's backing lives in the private package, answered as `Backings.logDrain`, and
 * the server hands its `drain` to `initLogger({ drain })` — on the logger rather than on the Hono
 * middleware, so the acquire runner's and the sweep's own `log` lines drain beside the requests'
 * (the middleware's events reach the global drain too).
 */
export type LogDrain = {
  /** The name the boot line carries — the vendor's. */
  name: string;
  /** evlog's drain callback; batching and retry are the backing's to arrange. */
  drain: DrainFn;
  /** Deliver everything buffered. Call before the process exits, or the last batch is lost. */
  flush(): Promise<void>;
};
