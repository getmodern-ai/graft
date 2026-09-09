import { describe, expect, it } from "vitest";

import { createDerivedCredentialCache } from "./cache";

/** The derived-credential cache against an injected clock: present until its lifetime, then gone. */
describe("createDerivedCredentialCache", () => {
  it("answers an entry until its lifetime is up, then forgets it", () => {
    let clock = 1_000;
    const cache = createDerivedCredentialCache(() => clock);
    cache.set("k", { accessToken: "t" }, 500);

    expect(cache.get("k")).toEqual({ accessToken: "t" });
    clock += 499;
    expect(cache.get("k")).toEqual({ accessToken: "t" });
    clock += 1;
    expect(cache.get("k")).toBeUndefined();
  });

  it("does not store an entry with no lifetime left, and forgets one on delete", () => {
    const cache = createDerivedCredentialCache(() => 0);
    cache.set("k", { accessToken: "t" }, 0);
    expect(cache.get("k")).toBeUndefined();

    cache.set("k", { accessToken: "t" }, 1_000);
    cache.delete("k");
    expect(cache.get("k")).toBeUndefined();
  });

  it("keeps keys apart", () => {
    const cache = createDerivedCredentialCache(() => 0);
    cache.set("a", { accessToken: "ta" }, 1_000);
    cache.set("b", { accessToken: "tb" }, 1_000);
    expect(cache.get("a")).toEqual({ accessToken: "ta" });
    expect(cache.get("b")).toEqual({ accessToken: "tb" });
  });
});
