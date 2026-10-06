import { afterEach, describe, expect, it } from "vitest";

import { sandboxConformance } from "./conformance";
import {
  createFakeSandboxBackend,
  type FakeSandboxBackend,
  refuseCommand,
  rewriteSandboxPaths,
} from "./fake";

/**
 * The fake runs the whole conformance suite, less the egress assertions it declares not applicable.
 * Below it, what is pinned is the fake's own machinery: the sandbox's paths land under the root, and
 * a command that reaches past it is refused rather than run.
 */
sandboxConformance("fake", async () => {
  const backend = createFakeSandboxBackend();
  return { backend, noNetwork: true, close: backend.close };
});

const ROOT = "/host/root";

describe("rewriteSandboxPaths", () => {
  it("maps the sandbox's own directories under the root, quoted or bare", () => {
    expect(rewriteSandboxPaths("node /graft/runner.mjs /tools/.drafts/x/index.mjs", ROOT)).toBe(
      `node ${ROOT}/graft/runner.mjs ${ROOT}/tools/.drafts/x/index.mjs`,
    );
    expect(rewriteSandboxPaths("cp '/tools/a b' '/tools/c' < '/tmp/runs/1.json'", ROOT)).toBe(
      `cp '${ROOT}/tools/a b' '${ROOT}/tools/c' < '${ROOT}/tmp/runs/1.json'`,
    );
    expect(rewriteSandboxPaths("ls /blobs", ROOT)).toBe(`ls ${ROOT}/blobs`);
  });

  it("leaves words that merely contain a root alone", () => {
    expect(rewriteSandboxPaths("node probe.mjs https://example.com/tools/a", ROOT)).toBe(
      "node probe.mjs https://example.com/tools/a",
    );
    expect(rewriteSandboxPaths("cat a/tools/b /toolsx", ROOT)).toBe("cat a/tools/b /toolsx");
  });

  it("maps a mount path it is told about", () => {
    expect(rewriteSandboxPaths("ls /mnt/toolbox/x", ROOT, ["/mnt/toolbox"])).toBe(
      `ls ${ROOT}/mnt/toolbox/x`,
    );
  });
});

describe("refuseCommand", () => {
  const rewritten = (command: string) => rewriteSandboxPaths(command, ROOT);

  it("allows a command that names only the sandbox", () => {
    expect(
      refuseCommand(rewritten("echo '{}' | node /graft/runner.mjs /tools/x/index.mjs"), ROOT),
    ).toBeNull();
    expect(refuseCommand(rewritten("cat /tools/a 2> /dev/null"), ROOT)).toBeNull();
  });

  /** A vendor path inside a JSON argument names nothing on this machine, so it is not a reach. */
  it("allows an absolute-looking token that exists nowhere on the host", () => {
    expect(
      refuseCommand(rewritten(`echo '{"path":"/items","next":"/v1/orders"}'`), ROOT),
    ).toBeNull();
  });

  it("refuses a path that is real on the host", () => {
    expect(refuseCommand(rewritten("cat /etc/passwd"), ROOT)).toContain("outside the sandbox");
    expect(refuseCommand(rewritten("ls /usr"), ROOT)).toContain("outside the sandbox");
  });

  it("refuses climbing out with ..", () => {
    expect(refuseCommand(rewritten("cd /tools/.. && ls"), ROOT)).toContain("..");
  });

  it("refuses programs the sandbox image does not have", () => {
    expect(refuseCommand(rewritten("curl https://example.com"), ROOT)).toContain("curl");
    expect(refuseCommand(rewritten("cd /tools && npm install zod"), ROOT)).toContain("npm");
  });
});

describe("createFakeSandboxBackend", () => {
  let backend: FakeSandboxBackend;

  afterEach(async () => {
    await backend?.close();
  });

  it("answers a refused command as a failed process rather than running it", async () => {
    backend = createFakeSandboxBackend();
    const { handle } = await backend.ensure({ name: "refused" });

    expect(await handle.exec("cat /etc/passwd")).toContain("outside the sandbox");

    await handle.execDetached("curl https://example.com", { name: "curl" });
    const result = await handle.waitForProcess("curl", { maxWaitSeconds: 1 });

    expect(result.status).toBe("failed");
    expect(result.exitCode).toBe(127);
    expect(result.logs).toContain("curl is not on this computer");
  });

  /** Nothing of the developer's environment reaches a process; only what the caller passed. */
  it("gives a process a clean environment plus what the caller passed", async () => {
    backend = createFakeSandboxBackend();
    const { handle } = await backend.ensure({ name: "clean" });
    process.env.GRAFT_FAKE_LEAK = "leaked";
    try {
      expect(
        await handle.exec('echo "[$GRAFT_FAKE_LEAK][$GRAFT_X]"', { env: { GRAFT_X: "x" } }),
      ).toBe("[][x]");
      expect(await handle.exec("echo $HOME")).toBe(`${backend.sandboxRoot("clean")}/home`);
    } finally {
      delete process.env.GRAFT_FAKE_LEAK;
    }
  });

  it("keeps each sandbox and each toolbox in its own directory under the root", async () => {
    backend = createFakeSandboxBackend();
    const { handle } = await backend.ensure({ name: "layout" });
    await handle.mountToolbox({ toolboxId: "tb", mountPath: "/tools" });
    await handle.writeTree([{ path: "t.txt", content: "t" }], "/tools");
    await handle.writeTree([{ path: "w.txt", content: "w" }], "/workspace");

    expect(backend.sandboxRoot("layout").startsWith(backend.root)).toBe(true);
    expect(backend.toolboxRoot("tb").startsWith(backend.root)).toBe(true);
    expect(await handle.read("/tools/t.txt")).toBe("t");
    expect(await handle.read("/workspace/w.txt")).toBe("w");
  });

  it("close removes everything", async () => {
    backend = createFakeSandboxBackend();
    await backend.ensure({ name: "closing" });
    const root = backend.root;

    await backend.close();

    const { existsSync } = await import("node:fs");
    expect(existsSync(root)).toBe(false);
  });
});
