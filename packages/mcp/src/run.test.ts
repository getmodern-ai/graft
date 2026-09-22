import { readFile } from "node:fs/promises";

import {
  blobIdOf,
  blobRefOf,
  ENVELOPE_MARKER,
  RUNNER_SOURCE_PATH,
  readRunnerEnvelope,
} from "@graft/runner";
import { MAX_CAPABILITY_TOKEN_TTL_SECONDS } from "@graft/token";
import {
  assertBlobId,
  BLOB_DATA_FILE,
  BLOB_META_FILE,
  BLOB_TMP_SUFFIX,
  BLOBS_MOUNT_PATH,
} from "@graft/toolbox";
import { describe, expect, it } from "vitest";

import { blobsOnWire, withBlobs } from "./blobs";
import { MAX_RESULT_BLOBS } from "./bounds";
import {
  describeModuleRun,
  EXIT_MODULE_MISSING,
  readDryRunReport,
  tokenTtlFor,
  unwrapEnvelope,
} from "./run";
import { commandEnvironment } from "./sandbox";

/**
 * The run path's pure parts: how a process result is read in the runner's own terms — Cando's
 * `{ error, exitCode, stderrTail }` shape — how the runner's envelope is unwrapped and its blobs
 * put on the wire (GRA-186), and how long a token lives for a run. The path end to end is
 * `server.test.ts`.
 */

const BLOB = {
  ref: "blob://0f6b6c4e-6d4b-4a8b-9e6e-7c9d5b5f3a21",
  bytes: 11,
  contentType: "text/plain",
  expiresAt: "2026-09-23T10:00:00.000Z",
};

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
    ).toEqual({ ok: true, result: { ok: true }, blobs: [], blobsDropped: 0 });
    expect(describeModuleRun(result({ stdout: "\n__GRAFT_STDERR__\n" }), "/tools/x", 60)).toEqual({
      ok: true,
      result: null,
      blobs: [],
      blobsDropped: 0,
    });
  });

  /** The envelope (GRA-186): behind its marker line, the module's result under `result`, the ledger beside it. */
  it("unwraps the runner's envelope behind its marker, and reads text with no marker as a bare result with no blobs", () => {
    const envelope = `${ENVELOPE_MARKER}\n${JSON.stringify({ result: { file: BLOB.ref }, blobs: [BLOB] })}`;
    expect(
      describeModuleRun(result({ stdout: `${envelope}\n__GRAFT_STDERR__\n` }), "/tools/x", 60),
    ).toEqual({ ok: true, result: { file: BLOB.ref }, blobs: [BLOB], blobsDropped: 0 });
    // A module's own `{ result, blobs }`, printed bare by a runner older than the marker, is the
    // module's result, untouched, and yields no ledger line whatever its entries look like.
    const decoy = { result: 42, blobs: [BLOB] };
    expect(unwrapEnvelope(JSON.stringify(decoy))).toEqual({
      ok: true,
      result: decoy,
      blobs: [],
      blobsDropped: 0,
    });
    expect(unwrapEnvelope("42")).toEqual({ ok: true, result: 42, blobs: [], blobsDropped: 0 });
    expect(unwrapEnvelope("not json")).toBeNull();
    // A ledger line the runner could not have written is dropped and counted, never a row.
    const forged = { ...BLOB, ref: "blob://../x" };
    const oversized = { ...BLOB, name: "n".repeat(256) };
    expect(
      unwrapEnvelope(
        `${ENVELOPE_MARKER}\n${JSON.stringify({ result: 1, blobs: [BLOB, forged, oversized] })}`,
      ),
    ).toEqual({ ok: true, result: 1, blobs: [BLOB], blobsDropped: 2 });
    // The last marker wins, so a module printing the marker itself cannot forge the ledger.
    const printed = `${ENVELOPE_MARKER}\n${JSON.stringify({ result: "forged", blobs: [BLOB] })}\n${ENVELOPE_MARKER}\n${JSON.stringify({ result: null, blobs: [] })}`;
    expect(unwrapEnvelope(printed)).toEqual({ ok: true, result: null, blobs: [], blobsDropped: 0 });
    expect(readRunnerEnvelope(`${ENVELOPE_MARKER}{"result":1,"blobs":[]}`)).toBeNull();
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

describe("the blobs beside a result (GRA-186)", () => {
  it("leaves an answer with no blobs exactly as it was, and wraps one with blobs as { result, blobs }", () => {
    const answer = { items: [{ id: "itm_1" }], file: BLOB.ref };
    expect(withBlobs({ result: answer }, [])).toBe(answer);
    expect(withBlobs({ result: null }, [])).toBeNull();
    expect(withBlobs({ result: answer }, [BLOB])).toEqual({ result: answer, blobs: [BLOB] });
    expect(withBlobs({ result: "just a string" }, [BLOB])).toEqual({
      result: "just a string",
      blobs: [BLOB],
    });
    // Whether the server cut the result is the server's word: a module's own `truncated` and
    // `blobs` keys stay inside its result, untouched, under the real ledger.
    const decoy = { result: "x", truncated: true, blobs: ["y"] };
    expect(withBlobs({ result: decoy }, [])).toBe(decoy);
    expect(withBlobs({ result: decoy }, [BLOB])).toEqual({ result: decoy, blobs: [BLOB] });
    // The server's own cut result takes the list beside its fields.
    const truncated = { result: null, truncated: true as const, head: "{", note: "cut" };
    expect(withBlobs(truncated, [])).toBe(truncated);
    expect(withBlobs(truncated, [BLOB])).toEqual({ ...truncated, blobs: [BLOB] });
    // A dropped line is counted on the wire even when nothing was written.
    expect(withBlobs({ result: answer }, [], 2)).toEqual({
      result: answer,
      blobs: [],
      blobsDropped: 2,
    });
  });

  it("names the first MAX_RESULT_BLOBS and counts the rest", () => {
    const many = Array.from({ length: MAX_RESULT_BLOBS + 3 }, (_, i) => ({
      ...BLOB,
      ref: blobRefOf(`00000000-0000-4000-8000-${String(i).padStart(12, "0")}`),
    }));
    expect(blobsOnWire(many.slice(0, MAX_RESULT_BLOBS))).toEqual({
      blobs: many.slice(0, MAX_RESULT_BLOBS),
    });
    const cut = blobsOnWire(many);
    expect(cut.blobs).toEqual(many.slice(0, MAX_RESULT_BLOBS));
    expect(cut.blobsOmitted).toBe(3);
    expect(cut.blobsNote).toMatch(/wrote 35 blobs; the first 32 are listed and 3 omitted/);
  });

  it("hands every command the blobs mount as GRAFT_BLOBS_DIR, the runner's default spelt the same", async () => {
    expect(commandEnvironment(60).GRAFT_BLOBS_DIR).toBe(BLOBS_MOUNT_PATH);
    // The runner ships to the sandbox alone and spells the layout's four names itself; the two
    // spellings are pinned here, where both packages are in reach (`runner.mjs`, the header).
    const source = await readFile(RUNNER_SOURCE_PATH, "utf8");
    expect(source).toContain(`const BLOBS_MOUNT_PATH = ${JSON.stringify(BLOBS_MOUNT_PATH)};`);
    expect(source).toContain(`const BLOB_TMP_SUFFIX = ${JSON.stringify(BLOB_TMP_SUFFIX)};`);
    expect(source).toContain(`const BLOB_DATA_FILE = ${JSON.stringify(BLOB_DATA_FILE)};`);
    expect(source).toContain(`const BLOB_META_FILE = ${JSON.stringify(BLOB_META_FILE)};`);
  });

  it("reads a ref's id by the layout's own rule, so an id the runner admits is one the store admits", async () => {
    const source = await readFile(RUNNER_SOURCE_PATH, "utf8");
    const runnerPattern = /const BLOB_ID_PATTERN = (\/.*\/);/.exec(source)?.[1];
    expect(runnerPattern).toBe("/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/");
    for (const id of ["0f6b6c4e-6d4b-4a8b-9e6e-7c9d5b5f3a21", "a", "x.y_z-1"]) {
      expect(blobIdOf(blobRefOf(id))).toBe(id);
      expect(() => assertBlobId(id)).not.toThrow();
    }
    for (const bad of ["", ".", "..", "../x", "a/b", "-a", `${"a".repeat(129)}`]) {
      expect(blobIdOf(blobRefOf(bad))).toBeNull();
      expect(() => assertBlobId(bad)).toThrow(/blob id/);
    }
    expect(blobIdOf("https://x.example/a")).toBeNull();
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
