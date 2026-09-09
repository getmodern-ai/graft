import { randomBytes } from "node:crypto";

import { sandboxConformance } from "@graft/sandbox/conformance";
import { describe } from "vitest";

import { createDockerSandboxBackend } from "./backend";

/**
 * The conformance suite against a running compose deployment (GRA-33, acceptance criterion: "from
 * inside a sandbox container, the proxy is reachable and no other host is"). `docker.test.ts` proves
 * the backing on a network the fixture made, with a stub standing in for the proxy; this proves the
 * network `docker-compose.yml` declares, with the real server answering under the alias `proxy` —
 * the arrangement a self-hoster actually runs. The egress cases are the point: the proxy answers,
 * an external address does not route, an external name does not resolve.
 *
 * Opt-in by environment, because it needs the compose project up:
 *
 *   docker compose up -d
 *   GRAFT_COMPOSE_NETWORK=graft_sandbox GRAFT_SANDBOX_IMAGE=ghcr.io/getmodern-ai/graft-sandbox:latest \
 *     pnpm --filter @graft/sandbox-docker test -- compose
 *
 * `GRAFT_COMPOSE_NETWORK` is the sandbox network as compose named it (`<project>_sandbox`), and the
 * image is the one the compose file built. Unset, the file is skipped and says so; it is not part
 * of `pnpm run test` and CI does not run it — the result is recorded on the pull request instead.
 */

const network = process.env.GRAFT_COMPOSE_NETWORK;
const image = process.env.GRAFT_SANDBOX_IMAGE;
/** `GRAFT_PROXY_PUBLIC_URL` in the compose file, less its path: any 200 from the server proves the route. */
const proxyUrl = process.env.GRAFT_COMPOSE_PROXY_URL ?? "http://proxy:3000/api/health";

if (!network || !image) {
  process.stderr.write(
    "skipped: GRAFT_COMPOSE_NETWORK and GRAFT_SANDBOX_IMAGE name the compose network and image to test against\n",
  );
}

describe.skipIf(!network || !image)("docker sandbox backing on the compose network", () => {
  sandboxConformance("docker on the compose network", async () => {
    const run = `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
    const prefix = `graft-compose-${run}`;
    const backend = createDockerSandboxBackend({
      image: image ?? "",
      network: network ?? "",
      prefix,
      toolboxVolumePrefix: `${prefix}-toolbox`,
    });
    return {
      backend,
      proxyUrl,
      close: async () => {
        for (const sandbox of await backend.list()) await backend.destroy(sandbox.name);
        await backend.removeToolboxVolumes();
      },
    };
  });
});
