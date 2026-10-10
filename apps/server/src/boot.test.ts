import type { MigrationChain } from "@graft/db/migration-chain";
import { describe, expect, it, vi } from "vitest";

import {
  ADMIN_NAME,
  bootstrapAdmin,
  loadStockOnStart,
  MigrationChainBrokenError,
  migrateOnStart,
} from "./boot";

/**
 * The boot's two steps with fakes: the chain check gates the migrator, and the admin is opened
 * once, through the sign-up handed in, into an empty database only.
 */

const chain: MigrationChain = {
  entries: [
    { idx: 0, tag: "0000_persons_agents_connections_toolbox" },
    { idx: 1, tag: "0001_more" },
  ],
  sqlFiles: ["0000_persons_agents_connections_toolbox.sql", "0001_more.sql"],
  snapshots: [],
};

describe("migrateOnStart", () => {
  it("checks the chain, applies it, and reports the tip", async () => {
    const apply = vi.fn(async () => {});
    const log = vi.fn();

    const result = await migrateOnStart({
      readChain: () => chain,
      checkChain: () => [],
      apply,
      log,
    });

    expect(apply).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ migrations: 2 });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("through 0001_more"));
  });

  it("refuses a broken chain before applying anything, listing every hole", async () => {
    const apply = vi.fn(async () => {});

    const attempt = migrateOnStart({
      readChain: () => chain,
      checkChain: () => [
        "0001_more.sql is in the journal but not on disk",
        "prevId points at nothing",
      ],
      apply,
      log: () => {},
    });

    await expect(attempt).rejects.toBeInstanceOf(MigrationChainBrokenError);
    await expect(attempt).rejects.toThrow(/broken in 2 way\(s\)[\s\S]*not on disk[\s\S]*prevId/);
    expect(apply).not.toHaveBeenCalled();
  });
});

describe("bootstrapAdmin", () => {
  const admin = { email: "admin@example.com", password: "change-me-please" };

  it("opens the admin through the sign-up when the database holds nobody, and says so once", async () => {
    const signUp = vi.fn(async () => {});
    const log = vi.fn();

    const outcome = await bootstrapAdmin(admin, { countPersons: async () => 0, signUp, log });

    expect(outcome).toBe("created");
    expect(signUp).toHaveBeenCalledWith({ ...admin, name: ADMIN_NAME });
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toContain("admin@example.com");
    expect(log.mock.calls[0]?.[0]).not.toContain(admin.password);
  });

  it("never touches a database that already holds a person, and says why", async () => {
    const signUp = vi.fn(async () => {});
    const log = vi.fn();

    const outcome = await bootstrapAdmin(admin, { countPersons: async () => 3, signUp, log });

    expect(outcome).toBe("skipped: persons exist");
    expect(signUp).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/already holds 3 person/));
  });

  it("is silent and does nothing when the variables are not set", async () => {
    const countPersons = vi.fn(async () => 0);
    const signUp = vi.fn(async () => {});
    const log = vi.fn();

    expect(await bootstrapAdmin(null, { countPersons, signUp, log })).toBe("skipped: unconfigured");
    expect(countPersons).not.toHaveBeenCalled();
    expect(signUp).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });
});

describe("loadStockOnStart", () => {
  it("reads the workspace, loads it, and says what was appended", async () => {
    const log = vi.fn();
    const load = vi.fn(async () => ({
      tools: 1,
      appended: [{ vendor: "open-meteo", name: "current-weather", versionNumber: 1 }],
      refused: [],
    }));
    const report = await loadStockOnStart({ read: async () => [], load, log });
    expect(load).toHaveBeenCalledWith([]);
    expect(report.tools).toBe(1);
    expect(log).toHaveBeenCalledWith(
      "stock: 1 tool(s) in the workspace; appended open-meteo__current-weather v1",
    );
  });

  it("says when nothing changed, and names a refused tool with its problems without failing the boot", async () => {
    const log = vi.fn();
    await loadStockOnStart({
      read: async () => [],
      load: async () => ({
        tools: 2,
        appended: [],
        refused: [{ vendor: "open-meteo", name: "broken", problems: ["global-fetch"] }],
      }),
      log,
    });
    expect(log).toHaveBeenCalledWith(
      "stock: 2 tool(s) in the workspace; the catalogue is current; refused open-meteo__broken (global-fetch)",
    );
  });
});
