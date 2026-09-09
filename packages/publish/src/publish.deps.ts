import { checkModule } from "@graft/check";
import { defaultToolDeps } from "@graft/core";

import type { PublishDeps } from "./publish.service";

/**
 * The publish's deps with the defaults a deployment wants filled in: the real check, the real tool
 * repositories, the clock, and a reporter that says so on stderr when a mirror fails — the one
 * outcome that would otherwise vanish, since the publish has already answered. The five that cannot
 * default — the database, the store, the mirror, the sandbox backend and the metadata source — are
 * the seams (ADR 0002) and the configuration, and the server binds them from its environment.
 */
export function createPublishDeps(
  options: Pick<PublishDeps, "db" | "store" | "mirror" | "sandbox" | "metadata" | "policy"> &
    Partial<Pick<PublishDeps, "tool" | "check" | "now" | "onMirror">>,
): PublishDeps {
  return {
    ...options,
    tool: options.tool ?? defaultToolDeps,
    check: options.check ?? checkModule,
    now: options.now ?? (() => new Date()),
    onMirror:
      options.onMirror ??
      ((event) => {
        if (event.outcome === "failed") {
          console.error(
            `toolbox mirror failed for ${event.toolboxId}/${event.versionPath}: ${event.cause ?? "unknown"}`,
          );
        }
      }),
  };
}
