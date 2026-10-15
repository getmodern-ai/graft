import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DETACHED_POLL_SCRIPT } from "./backend";

/**
 * The detached poll's verdict, run by the host's `sh` over a record directory with no daemon, so
 * the moment that raced in CI (GRA-337) is played on purpose: `kill` is shadowed by a function
 * that does what the subshell does when it finishes between the poll's two looks, renaming `code`
 * into place and exiting, before it answers "gone".
 */

const run = promisify(execFile);

/** A `kill` the script calls instead of the builtin; `$d` is the script's record directory. */
const KILL_FINISHES_FIRST = `kill() { echo 137 > "$d/code"; return 1; }\n`;
const KILL_GONE = "kill() { return 1; }\n";
const KILL_ALIVE = "kill() { return 0; }\n";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "graft-detached-poll-"));
  await writeFile(join(dir, "stdout"), "alive\n");
  await writeFile(join(dir, "stderr"), "");
  await writeFile(join(dir, "pid"), "4242\n");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const poll = async (kill: string) => {
  const { stdout } = await run("sh", ["-c", `${kill}${DETACHED_POLL_SCRIPT}`, dir]);
  return stdout.split("\n")[0];
};

describe("the detached poll script", () => {
  it("reports the exit a subshell recorded as it finished between the poll's two looks", async () => {
    expect(await poll(KILL_FINISHES_FIRST)).toBe("EXITED 137");
  });

  it("reports LOST only for a subshell gone with no exit recorded", async () => {
    expect(await poll(KILL_GONE)).toBe("LOST");
  });

  it("reports RUNNING while the subshell is there", async () => {
    expect(await poll(KILL_ALIVE)).toBe("RUNNING");
  });

  it("reads a recorded exit without asking after the subshell", async () => {
    await writeFile(join(dir, "code"), "0\n");
    expect(await poll(KILL_ALIVE)).toBe("EXITED 0");
  });
});
