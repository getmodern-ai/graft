import { describe, expect, it } from "vitest";

import { routeEvent, setupHarnessProperty, TRACKED_ROUTES, trackedRoute } from "./analytics-routes";

describe("routeEvent", () => {
  it("maps a tracked mutation, with or without the /api mount and a query string", () => {
    expect(routeEvent("POST", "/api/agents")).toBe("agent_created");
    expect(routeEvent("POST", "/agents")).toBe("agent_created");
    expect(routeEvent("POST", "/api/agents/ag_1/revoke")).toBe("agent_revoked");
    expect(routeEvent("PUT", "/api/agents/ag_1/scope")).toBe("scope_changed");
    expect(routeEvent("POST", "/api/pending-actions/pa_1/answer?x=1")).toBe("approval_answered");
    expect(routeEvent("PUT", "/api/me/model-key")).toBe("model_key_set");
    expect(routeEvent("DELETE", "/api/me/model-key")).toBe("model_key_removed");
    expect(routeEvent("POST", "/api/mcp-oauth/consent")).toBe("mcp_client_consented");
    expect(routeEvent("POST", "/api/setup/start")).toBe("setup_started");
    expect(routeEvent("POST", "/api/setup/skip")).toBe("setup_skipped");
  });

  it("reads Setup's harness off the answer, and null for none or a shape it does not know", () => {
    const start = trackedRoute("POST", "/api/setup/start");
    expect(start?.properties?.({ setup: { harness: "claude" } })).toEqual({ harness: "claude" });
    expect(setupHarnessProperty({ setup: { harness: null } })).toEqual({ harness: null });
    expect(setupHarnessProperty({ setup: null })).toEqual({ harness: null });
    expect(setupHarnessProperty(null)).toEqual({ harness: null });
    expect(trackedRoute("POST", "/api/agents")?.properties).toBeUndefined();
  });

  it("is null for a read, an unlisted mutation and a near miss", () => {
    expect(routeEvent("GET", "/api/agents")).toBeNull();
    expect(routeEvent("PATCH", "/api/agents/ag_1")).toBeNull();
    expect(routeEvent("POST", "/api/agents/ag_1/revoke/extra")).toBeNull();
    expect(routeEvent("POST", "/api/connections/c_1/reconnect")).toBeNull();
    expect(routeEvent("POST", "/api/auth/sign-in/email")).toBeNull();
    expect(routeEvent("GET", "/api/setup")).toBeNull();
  });

  it("spells every event noun_verbed in snake case", () => {
    for (const route of TRACKED_ROUTES) {
      expect(route.event).toMatch(/^[a-z]+(_[a-z]+)+$/);
    }
  });
});
