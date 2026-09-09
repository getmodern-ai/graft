import { describe, expect, it } from "vitest";

import { acquireTraceAttributes } from "./langfuse";

/**
 * What a model call's trace is called and what it carries — decided in one pure function so the
 * live Langfuse check (deferred until a Graft Langfuse project exists; the PR body records it) has
 * a fixed shape to look for: the job id on every span, the person as the user, the job as the
 * session.
 */
describe("acquireTraceAttributes", () => {
  const trace = {
    role: "authoring" as const,
    jobId: "job_1",
    personId: "person_1",
    attempt: 2,
    situation: "dry_run_failed" as const,
    provider: "openai",
    modelId: "gpt-test",
  };

  it("names the trace by role, groups by job as the session and by person as the user, and carries the job id in metadata", () => {
    expect(acquireTraceAttributes(trace)).toEqual({
      traceName: "acquire-authoring",
      sessionId: "job_1",
      userId: "person_1",
      tags: ["openai", "authoring", "dry_run_failed"],
      metadata: {
        jobId: "job_1",
        personId: "person_1",
        attempt: "2",
        situation: "dry_run_failed",
        role: "authoring",
        provider: "openai",
        modelId: "gpt-test",
      },
    });
    expect(acquireTraceAttributes({ ...trace, role: "triage" }).traceName).toBe("acquire-triage");
  });

  it("carries only strings in metadata — propagateAttributes drops anything else", () => {
    for (const value of Object.values(acquireTraceAttributes(trace).metadata)) {
      expect(typeof value).toBe("string");
    }
  });
});
