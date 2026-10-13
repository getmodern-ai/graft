import type { ReadWebPage, ResolvedAddress } from "@graft/mcp";
import { createScriptedModel, type ModelAdapter, type RawConnectionProposal } from "@graft/model";
import { initLogger } from "evlog";
import { afterEach, describe, expect, it } from "vitest";

import type { ApiOptions, ConnectionProposalState } from "./api";
import { createServer } from "./app";
import {
  CONNECTION_PROPOSAL_UNCONFIGURED_MESSAGE,
  type ConnectionProposalSettled,
  createConnectionProposalStore,
} from "./connection-proposals";

/**
 * A connection proposal from an API's docs over the API (GRA-299, Flow C): started, polled
 * through its stages to a proposal, one in flight per person, another person's job a 404, and the
 * unavailable state naming the variables. A scripted model and a fake page reader; no database,
 * since the jobs are held in the process.
 */

initLogger({ silent: true });

const ORIGIN = "http://localhost:3000";
const DOCS_URL = "https://apidocs.unleashed.example/authentication";
const UNLEASHED: RawConnectionProposal = {
  vendor: "unleashed",
  primaryHost: "https://api.unleashed.example",
  hosts: [],
  scheme: "api_key_header",
  schemeConfig: { headerName: "api-auth-id" },
};
const PUBLIC: ResolvedAddress[] = [{ address: "93.184.215.14", family: 4 }];

let person = "person_a";

/** A page reader that waits on `release` before it answers, so a poll can see the job running. */
function gatedReader() {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const read: ReadWebPage = async ({ url }) => {
    await gate;
    return {
      ok: true,
      url,
      title: "Authentication",
      content: "Send requests to https://api.unleashed.example with the api-auth-id header.",
      offset: 0,
      totalCharacters: 75,
      truncated: false,
      nextOffset: null,
      note: "untrusted",
    };
  };
  return { read, release };
}

function server(deps: ApiOptions["connectionProposal"]) {
  const api: ApiOptions = {
    auth: {
      handler: async () => new Response("auth"),
      getSession: async () => ({ user: { id: person } }),
    },
    // No route here touches a repository: the jobs are the process's.
    deps: {} as ApiOptions["deps"],
    corsOrigins: [],
    authUrl: ORIGIN,
    handoff: { consoleUrl: "http://console.example", secret: "s".repeat(32) },
    ...(deps ? { connectionProposal: deps } : {}),
  };
  return createServer({
    keys: null,
    vault: { decrypt: async () => ({}) },
    connections: { get: async () => null },
    followRedirects: false,
    api,
  });
}

const start = (app: ReturnType<typeof server>, body: unknown) =>
  app.request("/api/connection-proposals", {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify(body),
  });

async function poll(app: ReturnType<typeof server>, id: string): Promise<Response> {
  return app.request(`/api/connection-proposals/${id}`);
}

async function settled(app: ReturnType<typeof server>, id: string) {
  for (let i = 0; i < 50; i += 1) {
    const state = (await (await poll(app, id)).json()) as ConnectionProposalState;
    if (state.status !== "running") return state;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("the proposal never settled");
}

afterEach(() => {
  person = "person_a";
});

describe("the connection proposal routes", () => {
  it("starts a job and is polled through its stages to a proposal", async () => {
    const reader = gatedReader();
    const model = createScriptedModel([], { connectionProposal: UNLEASHED });
    const app = server({ model, readWebPage: reader.read, resolveHost: async () => PUBLIC });

    expect(await (await app.request("/api/connection-proposals")).json()).toEqual({
      available: true,
      running: null,
    });
    const res = await start(app, { name: "Acme Unleashed", docsUrl: DOCS_URL });
    expect(res.status).toBe(200);
    const { id } = (await res.json()) as { id: string };

    const running = (await (await poll(app, id)).json()) as ConnectionProposalState;
    expect(running).toMatchObject({
      id,
      status: "running",
      stage: "reading_docs",
      name: "Acme Unleashed",
      docsUrl: DOCS_URL,
      proposal: null,
      failure: null,
      settledAt: null,
    });
    expect(await (await app.request("/api/connection-proposals")).json()).toEqual({
      available: true,
      running: id,
    });

    reader.release();
    const ready = await settled(app, id);
    expect(ready).toMatchObject({
      status: "ready",
      stage: "preparing",
      found: {
        docsHost: "apidocs.unleashed.example",
        scheme: "api_key_header",
        primaryHost: "api.unleashed.example",
      },
      proposal: {
        vendor: "unleashed",
        displayName: "Acme Unleashed",
        scheme: "api_key_header",
        schemeConfig: { headerName: "api-auth-id" },
        primaryHost: "https://api.unleashed.example",
        hosts: ["api.unleashed.example"],
        docsUrl: DOCS_URL,
        hostsSetAside: [],
      },
      unresolvedHosts: [],
      failure: null,
    });
    expect(model.connectionProposals.map((r) => r.traceId)).toEqual(["connect:person_a"]);
  });

  it("keeps one proposal in flight per person, and answers another person's id as not found", async () => {
    const reader = gatedReader();
    const app = server({
      model: createScriptedModel([], { connectionProposal: UNLEASHED }),
      readWebPage: reader.read,
      resolveHost: async () => PUBLIC,
    });
    const { id } = (await (await start(app, { name: "Acme", docsUrl: DOCS_URL })).json()) as {
      id: string;
    };

    const again = await start(app, { name: "Acme", docsUrl: DOCS_URL });
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({
      error: "CONFLICT",
      details: { reason: "proposal_running", id },
    });

    person = "person_b";
    expect((await poll(app, id)).status).toBe(404);
    expect((await poll(app, "cprop_nothing")).status).toBe(404);
    // Another person's job in flight does not hold this person's start.
    expect((await start(app, { name: "Other", docsUrl: DOCS_URL })).status).toBe(200);

    reader.release();
    person = "person_a";
    expect((await settled(app, id)).status).toBe("ready");
    expect((await start(app, { name: "Acme", docsUrl: DOCS_URL })).status).toBe(200);
  });

  it("fails the job host_not_public when the proposed address is private", async () => {
    const app = server({
      model: createScriptedModel([], {
        connectionProposal: { ...UNLEASHED, primaryHost: "https://169.254.169.254" },
      }),
      readWebPage: gatedReaderReleased(),
      resolveHost: async () => PUBLIC,
    });
    const { id } = (await (await start(app, { name: "Acme", docsUrl: DOCS_URL })).json()) as {
      id: string;
    };
    expect(await settled(app, id)).toMatchObject({
      status: "failed",
      stage: "checking_address",
      proposal: null,
      failure: { reason: "host_not_public", host: "169.254.169.254" },
    });
  });

  it("refuses a private documentation link, and a body that is not the two fields", async () => {
    const app = server({
      model: createScriptedModel([]),
      readWebPage: gatedReaderReleased(),
      resolveHost: async () => PUBLIC,
    });
    const privateDocs = await start(app, { name: "Acme", docsUrl: "https://10.1.2.3/docs" });
    expect(privateDocs.status).toBe(400);
    expect(await privateDocs.json()).toMatchObject({
      details: { reason: "host_not_public", field: "docsUrl" },
    });
    expect((await start(app, { name: "Acme" })).status).toBe(400);
    expect((await start(app, { name: "Acme", docsUrl: DOCS_URL, query: "x" })).status).toBe(400);
  });

  it("answers unavailable, naming the variables, when no model is configured", async () => {
    for (const app of [
      server(undefined),
      server({ model: null, readWebPage: gatedReaderReleased() }),
    ]) {
      expect(await (await app.request("/api/connection-proposals")).json()).toEqual({
        available: false,
        reason: "acquire_unconfigured",
        message: CONNECTION_PROPOSAL_UNCONFIGURED_MESSAGE,
      });
      const res = await start(app, { name: "Acme", docsUrl: DOCS_URL });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { message: string; details: { reason: string } };
      expect(body.details.reason).toBe("acquire_unconfigured");
      expect(body.message).toContain("GRAFT_MODEL_BACKEND=provider");
      expect(body.message).toContain("GRAFT_MODEL_API_KEY");
    }
  });
});

/** A page reader that answers at once. */
function gatedReaderReleased(): ReadWebPage {
  const reader = gatedReader();
  reader.release();
  return reader.read;
}

describe("createConnectionProposalStore", () => {
  const deps = (model: ModelAdapter) => ({
    model,
    readWebPage: gatedReaderReleased(),
    resolveHost: async () => PUBLIC,
  });

  it("forgets a job once its window has passed", async () => {
    let now = new Date("2026-10-14T00:00:00Z");
    const store = createConnectionProposalStore({
      deps: deps(createScriptedModel([], { connectionProposal: UNLEASHED })),
      ttlMs: 1000,
      now: () => now,
    });
    const { id } = store.start("person_a", { name: "Acme", docsUrl: DOCS_URL });
    await store.idle();
    expect(store.get("person_a", id).status).toBe("ready");
    now = new Date(now.getTime() + 1000);
    expect(() => store.get("person_a", id)).toThrow("No such connection proposal");
  });

  it("reports a settled job as counts and kinds, never the name, the link or the proposal", async () => {
    const events: ConnectionProposalSettled[] = [];
    const store = createConnectionProposalStore({
      deps: deps(createScriptedModel([], { connectionProposal: UNLEASHED })),
      onSettled: (event) => events.push(event),
    });
    const { id } = store.start("person_a", { name: "Acme Secretive", docsUrl: DOCS_URL });
    await store.idle();
    expect(events).toEqual([
      {
        id,
        personId: "person_a",
        status: "ready",
        stage: "preparing",
        reason: null,
        unresolvedHosts: 0,
        durationMs: expect.any(Number),
        pages: 1,
        characters: 75,
        outcome: "proposed",
        usage: { inputTokens: 500, outputTokens: 100 },
      },
    ]);
    const logged = JSON.stringify(events);
    for (const word of ["Acme Secretive", "apidocs", "api-auth-id", "unleashed"]) {
      expect(logged).not.toContain(word);
    }
  });

  it("fails the job, with the throw for the log alone, when the model throws", async () => {
    const events: ConnectionProposalSettled[] = [];
    const throwing: ModelAdapter = {
      name: "throwing",
      open: () => {
        throw new Error("never opened");
      },
      proposeConnection: async () => {
        throw new Error("boom");
      },
    };
    const store = createConnectionProposalStore({
      deps: deps(throwing),
      onSettled: (event) => events.push(event),
    });
    const { id } = store.start("person_a", { name: "Acme", docsUrl: DOCS_URL });
    await store.idle();
    expect(store.get("person_a", id)).toMatchObject({
      status: "failed",
      failure: { reason: "model_failed" },
    });
    expect(events[0]).toMatchObject({ status: "failed", error: "boom" });
  });
});
