import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initLogger } from "evlog";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { API_MOUNT_PATH, createServer, MCP_MOUNT_PATH } from "./app";

/**
 * The console served by the server (GRA-26): a build directory made for the test, the app driven
 * through `app.request()`. What is asserted is the serving rule — files as files, a navigation as
 * the SPA's `index.html`, the API's and the MCP endpoint's paths never the console's — and the
 * posture when there is no build: the server is up, the API answers, and a console path says why
 * there is no page.
 */

initLogger({ silent: true });

let built: string;
let empty: string;

beforeAll(async () => {
  built = await mkdtemp(join(tmpdir(), "graft-console-"));
  await writeFile(join(built, "index.html"), "<!doctype html><title>Graft</title><div id=app>");
  await mkdir(join(built, "assets"));
  await writeFile(join(built, "assets", "app-abc123.js"), "console.log('graft')");
  empty = await mkdtemp(join(tmpdir(), "graft-console-empty-"));
});

afterAll(async () => {
  await rm(built, { recursive: true, force: true });
  await rm(empty, { recursive: true, force: true });
});

function harness(dir: string) {
  return createServer({
    keys: null,
    vault: { decrypt: async () => ({}) },
    connections: { get: async () => null },
    followRedirects: false,
    console: { dir },
  });
}

const navigation = {
  headers: { accept: "text/html,application/xhtml+xml,*/*;q=0.8" },
};

describe("with a build", () => {
  it("answers index.html at the root and for any deep link a browser navigates to", async () => {
    const app = harness(built);
    for (const path of ["/", "/agents", "/agents/agent_1", "/pending/pa_1?t=abc"]) {
      const res = await app.request(path, navigation);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("content-type"), path).toContain("text/html");
      expect(await res.text(), path).toContain("<div id=app>");
    }
  });

  it("answers a file as itself, and a missing asset as 404 rather than as the page", async () => {
    const app = harness(built);
    const asset = await app.request("/assets/app-abc123.js");
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toContain("javascript");
    expect(await asset.text()).toBe("console.log('graft')");

    const missing = await app.request("/assets/gone.js", {
      headers: { accept: "application/javascript" },
    });
    expect(missing.status).toBe(404);
  });

  it("never answers for the API's or the MCP endpoint's paths", async () => {
    const app = harness(built);
    // Unknown API paths stay plain 404s; the console's HTML would read as a broken JSON client.
    const api = await app.request(`${API_MOUNT_PATH}/nothing-here`, navigation);
    expect(api.status).toBe(404);
    expect(api.headers.get("content-type") ?? "").not.toContain("text/html");

    const mcp = await app.request(MCP_MOUNT_PATH, navigation);
    expect(mcp.status).toBe(404);
    expect(mcp.headers.get("content-type") ?? "").not.toContain("text/html");
  });
});

describe("without a build", () => {
  it("boots, keeps the health check, and answers a console path with a JSON 404 that says why", async () => {
    const app = harness(empty);
    const health = await app.request("/");
    expect(health.status).toBe(200);
    expect(await health.text()).toBe("OK");

    const page = await app.request("/agents", navigation);
    expect(page.status).toBe(404);
    expect(await page.json()).toMatchObject({
      error: "console_not_built",
      message: expect.stringContaining("GRAFT_CONSOLE_DIR"),
    });
  });
});
