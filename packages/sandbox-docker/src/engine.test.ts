import { describe, expect, it } from "vitest";

import { createDemuxer, DEFAULT_DOCKER_SOCKET, resolveDockerHost } from "./engine";
import { filesUnder, packTree, readTar } from "./tar";

/**
 * The parts of the transport that need no daemon: how `DOCKER_HOST` is read, how a multiplexed
 * stream comes apart however the socket chunked it, and that a tree survives the trip through tar.
 */

describe("resolveDockerHost", () => {
  it("defaults to the local socket", () => {
    expect(resolveDockerHost(undefined)).toEqual({ socketPath: DEFAULT_DOCKER_SOCKET });
    expect(resolveDockerHost("")).toEqual({ socketPath: DEFAULT_DOCKER_SOCKET });
  });

  it("reads unix:// and tcp:// as the CLI does", () => {
    expect(resolveDockerHost("unix:///run/user/1000/docker.sock")).toEqual({
      socketPath: "/run/user/1000/docker.sock",
    });
    expect(resolveDockerHost("tcp://docker:2375")).toEqual({ host: "docker", port: 2375 });
    expect(resolveDockerHost("tcp://10.0.0.5")).toEqual({ host: "10.0.0.5", port: 2375 });
  });

  it("refuses what it cannot speak rather than half-speaking it", () => {
    expect(() => resolveDockerHost("https://docker:2376")).toThrow(/not supported/);
    expect(() => resolveDockerHost("ssh://user@host")).toThrow(/not supported/);
    expect(() => resolveDockerHost("docker.sock")).toThrow(/unix:\/\/ or tcp:\/\//);
  });
});

function frame(type: 1 | 2, text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  const header = Buffer.alloc(8);
  header[0] = type;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

describe("createDemuxer", () => {
  it("separates stdout from stderr and keeps the arrival order in logs", () => {
    const demuxer = createDemuxer();
    demuxer.push(Buffer.concat([frame(1, "out 1\n"), frame(2, "err 1\n"), frame(1, "out 2\n")]));

    expect(demuxer.result()).toEqual({
      stdout: "out 1\nout 2\n",
      stderr: "err 1\n",
      logs: "out 1\nerr 1\nout 2\n",
    });
  });

  it("reassembles frames split across chunks, header included", () => {
    const whole = Buffer.concat([frame(1, "hello "), frame(2, "world")]);
    const demuxer = createDemuxer();
    for (let i = 0; i < whole.length; i += 3) demuxer.push(whole.subarray(i, i + 3));

    expect(demuxer.result()).toEqual({ stdout: "hello ", stderr: "world", logs: "hello world" });
  });

  it("handles a multi-byte character split across chunks inside one frame", () => {
    const whole = frame(1, "café");
    const demuxer = createDemuxer();
    demuxer.push(whole.subarray(0, 11));
    demuxer.push(whole.subarray(11));

    expect(demuxer.result().stdout).toBe("café");
  });
});

describe("tar", () => {
  it("packs a tree with its directories and reads the files back", async () => {
    const files = [
      { path: "a.txt", content: "alpha" },
      { path: "sub/deeper/c.json", content: '{"c":3}' },
      { path: `${"long-".repeat(30)}name.txt`, content: "long" },
    ];

    const entries = await readTar(packTree(files, { uid: 10001, gid: 10001 }));

    expect(entries.map((entry) => [entry.path, entry.type])).toEqual([
      ["sub/", "directory"],
      ["sub/deeper/", "directory"],
      ["a.txt", "file"],
      ["sub/deeper/c.json", "file"],
      [`${"long-".repeat(30)}name.txt`, "file"],
    ]);
    expect(entries[3]?.content.toString()).toBe('{"c":3}');
  });

  it("filesUnder strips the directory's own name and sorts", () => {
    const files = filesUnder([
      { path: "tree/", type: "directory", content: Buffer.alloc(0) },
      { path: "tree/sub/", type: "directory", content: Buffer.alloc(0) },
      { path: "tree/sub/b.txt", type: "file", content: Buffer.from("b") },
      { path: "tree/a.txt", type: "file", content: Buffer.from("a") },
    ]);

    expect(files).toEqual([
      { path: "a.txt", content: "a" },
      { path: "sub/b.txt", content: "b" },
    ]);
  });
});
