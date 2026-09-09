import type { ToolboxMirror } from "./types";

/**
 * The mirror this repository ships: it copies nothing and remembers being asked. Standing where the
 * S3 mirror of the hosted form will (ADR 0002; GRA-20 brings it in the private package), so the
 * publish has one code path in both forms and a test can assert the mirror was called after the
 * publish answered, and that a mirror which throws changes nothing the publish returned.
 */
export type RecordingToolboxMirror = ToolboxMirror & {
  /** Every call, in order. */
  readonly calls: { toolboxId: string; versionPath: string }[];
};

export function createNoopToolboxMirror(): RecordingToolboxMirror {
  const calls: { toolboxId: string; versionPath: string }[] = [];
  return {
    calls,
    mirrorVersion: async (toolboxId, versionPath) => {
      calls.push({ toolboxId, versionPath });
    },
  };
}
