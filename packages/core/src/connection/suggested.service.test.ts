import type { SuggestedConnectionAskRow } from "@graft/db/repo/pending-action";
import { describe, expect, it } from "vitest";

import type { ServiceContext } from "../context";
import type { DirectoryEntry, IntegrationDirectory } from "./directory";
import {
  listSuggestedIntegrations,
  SUGGESTED_INTEGRATIONS_LIMIT,
  type SuggestedIntegrationDeps,
} from "./suggested.service";

const NOW = new Date("2026-10-14T12:00:00Z");
const ctx = { db: {} } as ServiceContext;
const PRINCIPAL = { personId: "person_1" };

const ask = (over: Partial<SuggestedConnectionAskRow>): SuggestedConnectionAskRow => ({
  id: "pa_1",
  agentId: "agent_1",
  agentName: "Hermes",
  vendor: "acme-crm",
  displayName: "Acme CRM",
  docsUrl: "https://docs.acme-crm.com",
  createdAt: new Date("2026-10-14T11:00:00Z"),
  expiresAt: new Date("2026-10-15T11:00:00Z"),
  answeredAt: null,
  consumedAt: null,
  ...over,
});

function deps(rows: SuggestedConnectionAskRow[]) {
  const calls: { personId: string; limit: number }[] = [];
  const value: SuggestedIntegrationDeps = {
    listSuggestedConnectionAsks: async (_db, personId, limit) => {
      calls.push({ personId, limit });
      return rows;
    },
    now: () => NOW,
  };
  return { value, calls };
}

const entry = (slug: string, logoUrl: string | null): DirectoryEntry => ({
  slug,
  name: slug,
  description: null,
  logoUrl,
  categories: [],
  hosts: [`api.${slug}.com`],
  docsUrl: null,
  connect: "link",
  scheme: "bearer",
});

const directoryOf = (name: string, entries: DirectoryEntry[]): IntegrationDirectory => ({
  name,
  home: async () => ({ total: entries.length, categories: [], popular: entries, wall: [] }),
  search: async () => ({ entries, nextCursor: null, total: entries.length }),
  get: async (slug) => entries.find((e) => e.slug === slug) ?? null,
});

describe("listSuggestedIntegrations", () => {
  it("reads the person's own asks, bounded, and says where each stands", async () => {
    const d = deps([
      ask({ id: "pa_open" }),
      ask({ id: "pa_declined", vendor: "beta", answeredAt: new Date("2026-10-14T11:30:00Z") }),
      ask({ id: "pa_expired", vendor: "gamma", expiresAt: new Date("2026-10-14T11:59:00Z") }),
      // A revoke's closing: both clocks stamped and no answer, which reads as expired.
      ask({ id: "pa_closed", vendor: "delta", consumedAt: new Date("2026-10-14T11:10:00Z") }),
    ]);
    const found = await listSuggestedIntegrations(ctx, PRINCIPAL, null, d.value);
    expect(d.calls).toEqual([{ personId: "person_1", limit: SUGGESTED_INTEGRATIONS_LIMIT }]);
    expect(found.map((s) => [s.ask.pendingActionId, s.ask.state])).toEqual([
      ["pa_open", "open"],
      ["pa_declined", "declined"],
      ["pa_expired", "expired"],
      ["pa_closed", "expired"],
    ]);
    expect(found[0]).toEqual({
      vendor: "acme-crm",
      displayName: "Acme CRM",
      docsUrl: "https://docs.acme-crm.com",
      logoUrl: null,
      agent: { id: "agent_1", name: "Hermes" },
      ask: {
        pendingActionId: "pa_open",
        state: "open",
        askedAt: new Date("2026-10-14T11:00:00Z"),
        ageSeconds: 3600,
      },
    });
  });

  it("falls back to the slug for a missing name and to null for missing documentation", async () => {
    const d = deps([ask({ displayName: null, docsUrl: null })]);
    const [found] = await listSuggestedIntegrations(ctx, PRINCIPAL, null, d.value);
    expect(found).toMatchObject({ displayName: "acme-crm", docsUrl: null });
  });

  it("under the open form's starter directory has no marks to give", async () => {
    // The starter directory's entries carry no logo (`apps/server/src/directory.ts`).
    const starters = directoryOf("starters", [entry("acme-crm", null)]);
    const d = deps([ask({})]);
    const [found] = await listSuggestedIntegrations(ctx, PRINCIPAL, starters, d.value);
    expect(found?.logoUrl).toBeNull();
  });

  it("takes the mark from a hosted directory's entry, and none for a vendor it lacks", async () => {
    const hosted = directoryOf("hosted", [entry("acme-crm", "https://logos.example/acme.png")]);
    const d = deps([ask({}), ask({ id: "pa_2", vendor: "unlisted" })]);
    const found = await listSuggestedIntegrations(ctx, PRINCIPAL, hosted, d.value);
    expect(found.map((s) => s.logoUrl)).toEqual(["https://logos.example/acme.png", null]);
  });

  it("answers without a mark when the directory throws", async () => {
    const broken: IntegrationDirectory = {
      ...directoryOf("broken", []),
      get: async () => {
        throw new Error("catalogue down");
      },
    };
    const d = deps([ask({})]);
    const [found] = await listSuggestedIntegrations(ctx, PRINCIPAL, broken, d.value);
    expect(found).toMatchObject({ vendor: "acme-crm", logoUrl: null });
  });
});
