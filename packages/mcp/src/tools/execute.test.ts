import { describe, expect, it } from "vitest";

import { executeReason } from "./execute";

/**
 * The ledger's word for an execute call's end (GRA-301), over the shapes `describeProcess` answers:
 * the status decides before the exit code, and only a numeric code other than 0 is `exit_nonzero`
 * (Greptile on #244).
 */
describe("executeReason", () => {
  it("records no reason on ok, and a refusal's own", () => {
    expect(executeReason({ exitCode: 0, output: "" }, false, true)).toBeNull();
    expect(
      executeReason({ error: "refused", reason: "blob_quota", message: "…" }, true, false),
    ).toBe("blob_quota");
  });

  it("names a numeric non-zero exit, and a failure with no code apart from it", () => {
    expect(executeReason({ exitCode: 3, output: "x" }, false, false)).toBe("exit_nonzero");
    expect(executeReason({ exitCode: null, output: "x" }, false, false)).toBe("exit_unknown");
  });

  it("reads a killed process and one still running by status, whatever the code says", () => {
    expect(executeReason({ exitCode: 137, status: "killed", output: "" }, false, false)).toBe(
      "killed",
    );
    expect(executeReason({ exitCode: null, status: "running", output: "" }, false, false)).toBe(
      "still_running",
    );
  });

  it("names no process at all, and a record past the quota", () => {
    expect(executeReason({ error: "The sandbox is unavailable" }, false, false)).toBe(
      "sandbox_unavailable",
    );
    expect(
      executeReason({ exitCode: 0, error: "blob_quota: …", blobsRemoved: 1 }, false, false),
    ).toBe("blob_quota");
  });
});
