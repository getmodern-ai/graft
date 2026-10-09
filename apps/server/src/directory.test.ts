import { type SetupVendorOption, starterVendorOf } from "@graft/core";
import { describe, expect, it } from "vitest";

import { createStarterDirectory, directoryProposal } from "./directory";

const option = (id: string, connect: SetupVendorOption["connect"]): SetupVendorOption => {
  const starter = starterVendorOf(id);
  if (!starter) throw new Error(id);
  return {
    starter,
    provider: { name: "keyring", kind: "form" },
    connect,
  } as unknown as SetupVendorOption;
};

describe("createStarterDirectory", () => {
  const directory = createStarterDirectory(async () => [
    option("open-meteo", "keyless"),
    option("gmail", "link"),
  ]);

  it("lists the starters this deployment connects, with no categories or wall", async () => {
    const home = await directory.home();
    expect(home.total).toBe(2);
    expect(home.categories).toEqual([]);
    expect(home.popular.map((entry) => [entry.slug, entry.connect])).toEqual([
      ["open-meteo", "keyless"],
      ["gmail", "link"],
    ]);
  });

  it("searches by every word, pages by offset, and finds one by slug", async () => {
    expect((await directory.search({ query: "gmail", limit: 10 })).entries).toHaveLength(1);
    expect((await directory.search({ query: "nothing here", limit: 10 })).total).toBe(0);
    const first = await directory.search({ limit: 1 });
    expect(first.nextCursor).toBe("1");
    expect((await directory.search({ limit: 1, cursor: "1" })).entries[0]?.slug).toBe("gmail");
    expect(await directory.get("gmail")).toMatchObject({ name: "Gmail" });
    expect(await directory.get("fax")).toBeNull();
  });
});

describe("directoryProposal", () => {
  it("proposes the slug as the vendor and the first host as the primary", async () => {
    const entry = await createStarterDirectory(async () => [option("gmail", "link")]).get("gmail");
    if (!entry) throw new Error("no entry");
    expect(directoryProposal(entry)).toMatchObject({
      vendor: "gmail",
      primaryHost: "https://gmail.googleapis.com",
      hosts: ["gmail.googleapis.com"],
    });
  });
});
