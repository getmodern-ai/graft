// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Agent, Tool } from "@/lib/agent-queries";
import type { Approval } from "@/lib/approval-queries";
import type { Connection } from "@/lib/connection-queries";
import { routeTree } from "@/routeTree.gen";

// Keep the real routes and controls; only auth and shell chrome are outside this regression.
vi.mock("@/routes/__root", async () => {
  const { createRootRouteWithContext, Outlet } = await import("@tanstack/react-router");
  const { RouteError } = await import("@/components/route-error");
  return {
    Route: createRootRouteWithContext<{ queryClient: QueryClient }>()({
      component: Outlet,
      errorComponent: RouteError,
    }),
  };
});
vi.mock("@/routes/_auth/route", async () => {
  const { createFileRoute, Outlet } = await import("@tanstack/react-router");
  return { Route: createFileRoute("/_auth")({ component: Outlet }) };
});
vi.mock("@/routes/_auth/_shell/route", async () => {
  const { createFileRoute, Outlet } = await import("@tanstack/react-router");
  return { Route: createFileRoute("/_auth/_shell")({ component: Outlet }) };
});
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const at = "2026-09-20T00:00:00Z";
const agent: Agent = {
  id: "agent_1",
  name: "Laptop",
  tokenPrefix: "grft_abc",
  connectedVia: null,
  scopeMode: "listed",
  workingSetCap: 20,
  idleWindowDays: 21,
  revokedAt: null,
  archivedAt: null,
  createdAt: at,
  updatedAt: at,
};
const connection: Connection = {
  id: "conn_1",
  provider: "keyring",
  vendor: "example",
  displayName: "Work account",
  scheme: "none",
  schemeConfig: {},
  primaryHost: "https://api.example.com",
  hosts: ["api.example.com"],
  credentialSetAt: null,
  oauth: null,
  providerReleaseFailedAt: null,
  revokedAt: null,
  createdAt: at,
  updatedAt: at,
};
const tool: Tool = {
  id: "tool_1",
  vendor: "example",
  name: "create-item",
  description: "Creates an item",
  readOnly: false,
  destructive: false,
  defaultConnectionId: connection.id,
  currentVersionId: "version_1",
  createdAt: at,
  updatedAt: at,
};
let root: Root;
let client: QueryClient;
let current: Agent;
let scope: string[];
let approvals: Approval[];
let requests: { url: string; method: string; body: unknown }[];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
      mutations: { retry: false },
    },
  });
  current = { ...agent };
  scope = [connection.id];
  approvals = [
    {
      agentId: agent.id,
      toolId: tool.id,
      decision: "allow",
      askEveryCall: false,
      decidedAt: at,
      createdAt: at,
      updatedAt: at,
      owner: "person",
    },
  ];
  requests = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, options?: RequestInit) => {
      const method = options?.method ?? "GET";
      const body = options?.body ? JSON.parse(String(options.body)) : undefined;
      requests.push({ url, method, body });
      if (url === "/api/agents?includeArchived=true") {
        return Response.json({ agents: [{ ...current, workingSetCount: 1 }] });
      }
      if (url === "/api/connections") {
        return Response.json({
          connections: [
            connection,
            { ...connection, id: "conn_2", displayName: "Personal account" },
          ],
        });
      }
      if (url === "/api/tools") return Response.json({ tools: [tool] });
      if (url === "/api/approvals?agentId=agent_1") return Response.json({ approvals });
      if (url === "/api/agents/agent_1/working-set") {
        return Response.json({
          workingSet: [
            { toolId: tool.id, tool, promotedAt: at, lastUsedAt: null, promotedBy: "agent" },
          ],
        });
      }
      if (url.startsWith("/api/agents/agent_1/working-set/changes")) {
        return Response.json({
          changes: [{ id: "change_1", change: "promote", cause: "agent", createdAt: at, tool }],
        });
      }
      if (url === "/api/agents/agent_1/scope" && method === "PUT") {
        scope = body.connectionIds;
        return Response.json({ agent: current, connectionIds: scope });
      }
      if (url === "/api/approvals/tool_1/ask-every-call?agentId=agent_1" && method === "PUT") {
        approvals = approvals.map((value) => ({ ...value, askEveryCall: body.on }));
        return Response.json({ approval: approvals[0] });
      }
      if (url === "/api/approvals/tool_1?agentId=agent_1" && method === "DELETE") {
        approvals = [];
        return new Response(null, { status: 204 });
      }
      if (url === "/api/agents/agent_1/revoke" && method === "POST") {
        current = { ...current, revokedAt: at };
        return Response.json({ agent: current });
      }
      if (url === "/api/agents/agent_1")
        return Response.json({ agent: current, connectionIds: scope });
      return Response.json({ error: "NOT_FOUND", message: "Agent not found" }, { status: 404 });
    }),
  );
});

afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function mount(path = "/agents") {
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [path] }),
    context: { queryClient: client },
    defaultPendingMinMs: 0,
  });
  await act(async () => {
    await router.load();
    root.render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
  });
  return router;
}

async function waitFor(check: () => void) {
  await vi.waitFor(async () => {
    await act(async () => {});
    check();
  });
}

function control(label: string, within: ParentNode = document): HTMLElement {
  const result = [
    ...within.querySelectorAll<HTMLElement>("button, [role=menuitem], [role=switch]"),
  ].find(
    (element) =>
      element.textContent?.trim() === label || element.getAttribute("aria-label") === label,
  );
  if (!result) throw new Error(`Missing control: ${label}`);
  return result;
}

async function click(label: string, within: ParentNode = document) {
  await act(async () => control(label, within).click());
}

describe("standalone agent management", () => {
  it("opens View agent from the table and supports browser back and forward without a drawer", async () => {
    const router = await mount();
    await waitFor(() => expect(document.body.textContent).toContain("Laptop"));
    await click("Actions for Laptop");
    expect(control("View agent").getAttribute("href")).toBe("/agents/agent_1");
    await click("View agent");
    await waitFor(() => expect(document.getElementById("limits-name")).not.toBeNull());
    expect(router.state.location.pathname).toBe("/agents/agent_1");
    for (const label of [
      "Scope",
      "Working set",
      "Approvals",
      "History",
      "example__create-item",
      "The agent asked",
    ]) {
      expect(document.body.textContent).toContain(label);
    }
    expect(document.body.textContent).not.toContain("—");
    expect(document.querySelector("[role=dialog]")).toBeNull();
    expect(document.getElementById("new-agent")).toBeNull();
    await act(async () => router.history.back());
    await waitFor(() => expect(document.getElementById("new-agent")).not.toBeNull());
    await act(async () => router.history.forward());
    await waitFor(() => expect(document.getElementById("limits-name")).not.toBeNull());
  });

  it("keeps scope, approval controls and revocation reachable on a direct visit", async () => {
    const router = await mount("/agents/agent_1");
    await waitFor(() => expect(document.getElementById("scope-conn_2")).not.toBeNull());
    await act(async () => document.getElementById("scope-conn_2")?.click());
    await click("Save scope");
    await waitFor(() =>
      expect(requests).toContainEqual({
        url: "/api/agents/agent_1/scope",
        method: "PUT",
        body: { mode: "listed", connectionIds: ["conn_1", "conn_2"] },
      }),
    );
    await click("Ask every time for example__create-item");
    await waitFor(() =>
      expect(requests).toContainEqual({
        url: "/api/approvals/tool_1/ask-every-call?agentId=agent_1",
        method: "PUT",
        body: { on: true },
      }),
    );
    await waitFor(() => expect((control("Withdraw") as HTMLButtonElement).disabled).toBe(false));
    await click("Withdraw");
    await waitFor(() => expect(document.body.textContent).toContain("Nothing answered yet."));
    await click("Revoke token");
    const confirmation = document.querySelector("[role=alertdialog]");
    if (!confirmation) throw new Error("Missing revocation confirmation");
    await click("Revoke token", confirmation);
    await waitFor(() =>
      expect((document.getElementById("limits-name") as HTMLInputElement)?.disabled).toBe(true),
    );
    expect(requests).toContainEqual({
      url: "/api/agents/agent_1/revoke",
      method: "POST",
      body: undefined,
    });
    expect(router.state.location.pathname).toBe("/agents/agent_1");
    expect(document.body.textContent).toContain("History");
  });

  it.each(["revoked", "archived"])(
    "keeps a %s agent's records reachable and read-only",
    async (state) => {
      current = { ...agent, revokedAt: at, archivedAt: state === "archived" ? at : null };
      await mount();
      await waitFor(() => expect(document.body.textContent).toContain("Laptop"));
      await click("Actions for Laptop");
      await click("View agent");
      await waitFor(() => expect(document.getElementById("limits-name")).not.toBeNull());
      expect(document.body.textContent).toContain("Work account");
      expect(document.body.textContent).toContain("example__create-item");
      expect(document.body.textContent).toContain("The agent asked");
      for (const id of [
        "limits-name",
        "limits-cap",
        "limits-idle",
        "scope-mode",
        "scope-conn_1",
        "scope-conn_2",
      ]) {
        expect(document.getElementById(id)?.hasAttribute("disabled")).toBe(true);
      }
      expect((control("Withdraw") as HTMLButtonElement).disabled).toBe(true);
      expect(document.body.textContent).not.toContain("Revoke token");
      expect(document.body.textContent).not.toContain("Save scope");
    },
  );

  it("keeps a missing or foreign agent on its error page instead of redirecting to the table", async () => {
    const router = await mount("/agents/missing");
    await waitFor(() => expect(document.body.textContent).toContain("Agent not found"));
    expect(router.state.location.pathname).toBe("/agents/missing");
    expect(document.getElementById("limits-name")).toBeNull();
  });
});
