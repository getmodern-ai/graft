import { describe, expect, it } from "vitest";

import { createNoopToolboxMirror } from "./mirror";

describe("the recording no-op mirror", () => {
  it("copies nothing and remembers every call in order", async () => {
    const mirror = createNoopToolboxMirror();
    await mirror.mirrorVersion("person-1", "tools/acme/list/v1");
    await mirror.mirrorVersion("person-1", "tools/acme/list/v2");
    expect(mirror.calls).toEqual([
      { toolboxId: "person-1", versionPath: "tools/acme/list/v1" },
      { toolboxId: "person-1", versionPath: "tools/acme/list/v2" },
    ]);
  });
});
