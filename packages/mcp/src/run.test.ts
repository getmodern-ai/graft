import { MAX_CAPABILITY_TOKEN_TTL_SECONDS } from "@graft/token";
import { describe, expect, it } from "vitest";

import { describeModuleRun, EXIT_MODULE_MISSING, readDryRunReport, tokenTtlFor } from "./run";

/**
 * The run path's pure parts: how a process result is read in the runner's own terms — Cando's
 * `{ error, exitCode, stderrTail }` shape — and how long a token lives for a run. The path end to
 * end is `server.test.ts`.
 */

const result = (overrides: Partial<Parameters<typeof describeModuleRun>[0]>) => ({
  status: "completed" as const,
  exitCode: 0,
  logs: "",
  stdout: "",
  stderr: "",
  ...overrides,
});

describe("describeModuleRun", () => {
  it("reads the result off stdout before the stderr marker", () => {
    expect(
      describeModuleRun(
        result({ stdout: '{"ok":true}\n__GRAFT_STDERR__\nsome warning\n' }),
        "/tools/demo/x/v1",
        60,
      ),
    ).toEqual({ ok: true, result: { ok: true } });
    expect(describeModuleRun(result({ stdout: "\n__GRAFT_STDERR__\n" }), "/tools/x", 60)).toEqual({
      ok: true,
      result: null,
    });
  });

  it("maps each exit code to a sentence, with the code and the tail of stderr", () => {
    const cases: [number, RegExp][] = [
      [1, /failed \(exit code 1\)/],
      [2, /timed out inside the runner/],
      [64, /refused the invocation/],
      [EXIT_MODULE_MISSING, /not on the toolbox/],
    ];
    for (const [exitCode, pattern] of cases) {
      const outcome = describeModuleRun(
        result({
          status: "failed",
          exitCode,
          stdout: "\n__GRAFT_STDERR__\nError: boom\n",
        }),
        "/tools/demo/x/v1",
        60,
      );
      expect(outcome.ok).toBe(false);
      if (outcome.ok) throw new Error("unreachable");
      expect(outcome.failure).toMatchObject({ exitCode, stderrTail: "Error: boom" });
      expect(outcome.failure.error).toMatch(pattern);
    }
  });

  it("names a killed process and one still running, and a result that is not JSON", () => {
    const killed = describeModuleRun(result({ status: "killed", exitCode: 137 }), "/tools/x", 30);
    expect(killed).toMatchObject({
      ok: false,
      failure: { error: expect.stringMatching(/killed/) },
    });
    const running = describeModuleRun(
      result({ status: "running", exitCode: null, stdout: "partial" }),
      "/tools/x",
      30,
    );
    expect(running).toMatchObject({
      ok: false,
      failure: { exitCode: null, error: expect.stringMatching(/still running/) },
    });
    const junk = describeModuleRun(result({ stdout: "hello\n__GRAFT_STDERR__\n" }), "/tools/x", 30);
    expect(junk).toMatchObject({
      ok: false,
      failure: { error: expect.stringMatching(/not JSON/) },
    });
  });
});

describe("tokenTtlFor", () => {
  it("adds the slack and never passes the token library's ceiling", () => {
    expect(tokenTtlFor(60)).toBe(120);
    expect(tokenTtlFor(3600)).toBe(3660);
    expect(tokenTtlFor(MAX_CAPABILITY_TOKEN_TTL_SECONDS)).toBe(MAX_CAPABILITY_TOKEN_TTL_SECONDS);
  });
});

describe("readDryRunReport", () => {
  it("accepts the runner's shape and nothing else", () => {
    const report = {
      dryRun: true,
      passed: true,
      reads: [],
      writesPreviewed: [],
      writesRefused: [],
      verified: { reads: true, writeRequests: true },
      unverified: [],
    };
    expect(readDryRunReport(report)).toEqual(report);
    expect(readDryRunReport({ ...report, dryRun: false })).toBeNull();
    expect(readDryRunReport({ items: [] })).toBeNull();
    expect(readDryRunReport(null)).toBeNull();
  });
});
