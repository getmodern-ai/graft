import type { AgentScopeMode } from "@graft/core";
import type { ScopeBody } from "@graft/server/api";

/**
 * The agent page's switches over its scope (GRA-294; CONTEXT.md, *Scope*; ADR 0007 as amended
 * 2026-09-19): *Give X integrations I connect later*, and one switch per connection. They are a
 * view of the mode and the list and hold nothing of their own, so no position of the switches
 * exists that the scope cannot: under `all` the later switch and every connection's are on; under
 * `listed` the later switch is off and a connection's is on when the list names it.
 *
 * Each turn answers the one write that makes it true and the scope it leaves, which the page shows
 * until the server's answer replaces it (`scopeStateOf`). Turning the later switch on writes `all`
 * (every connection on, since `all` holds no list); turning it off writes `listed` with no list,
 * which the server materialises as the scope stood; turning one connection off under `all` is the
 * one-connection removal, which narrows the agent to `listed`, and `stopsLater` says so.
 */

/** The scope as the page holds it: the mode, and the ids it resolves to (`GET /agents/:id`). */
export type ScopeState = { mode: AgentScopeMode; connectionIds: ReadonlySet<string> };

/** The request a turn makes, or none when the switch is already where it was turned. */
export type ScopeToggleWrite =
  | { kind: "none" }
  /** `PUT /api/agents/:id/scope`. */
  | { kind: "scope"; body: ScopeBody }
  /** `PUT /api/connections/:id/agents/:agentId`. */
  | { kind: "grant"; connectionId: string }
  /** `DELETE /api/connections/:id/agents/:agentId`. */
  | { kind: "remove"; connectionId: string };

export type ScopeToggleOutcome = {
  write: ScopeToggleWrite;
  next: ScopeState;
  /** The turn takes the agent off `all`: integrations connected later no longer reach it. */
  stopsLater: boolean;
};

/** Whether *Give X integrations I connect later* is on. */
export function laterOn(state: ScopeState): boolean {
  return state.mode === "all";
}

/** Whether one connection's switch is on. */
export function connectionOn(state: ScopeState, connectionId: string): boolean {
  return state.mode === "all" || state.connectionIds.has(connectionId);
}

const unchanged = (state: ScopeState): ScopeToggleOutcome => ({
  write: { kind: "none" },
  next: state,
  stopsLater: false,
});

/**
 * The later switch turned. On writes `all`, so `everyConnectionId` (the person's connections, as
 * the connections list reads them) is what the agent then reaches. Off keeps every connection it
 * reaches now and stops the ones to come.
 */
export function turnLater(
  state: ScopeState,
  on: boolean,
  everyConnectionId: Iterable<string>,
): ScopeToggleOutcome {
  if (on === laterOn(state)) return unchanged(state);
  if (on) {
    return {
      write: { kind: "scope", body: { mode: "all" } },
      next: { mode: "all", connectionIds: new Set([...state.connectionIds, ...everyConnectionId]) },
      stopsLater: false,
    };
  }
  return {
    write: { kind: "scope", body: { mode: "listed" } },
    next: { mode: "listed", connectionIds: state.connectionIds },
    stopsLater: true,
  };
}

/** One connection's switch turned. */
export function turnConnection(
  state: ScopeState,
  connectionId: string,
  on: boolean,
): ScopeToggleOutcome {
  if (on === connectionOn(state, connectionId)) return unchanged(state);
  if (on) {
    return {
      write: { kind: "grant", connectionId },
      next: { mode: "listed", connectionIds: new Set([...state.connectionIds, connectionId]) },
      stopsLater: false,
    };
  }
  const rest = new Set(state.connectionIds);
  rest.delete(connectionId);
  return {
    write: { kind: "remove", connectionId },
    next: { mode: "listed", connectionIds: rest },
    stopsLater: state.mode === "all",
  };
}

/** The server's answer to any of the three writes, as the page holds it. */
export function scopeStateOf(answer: {
  agent: { scopeMode: AgentScopeMode };
  connectionIds: readonly string[];
}): ScopeState {
  return { mode: answer.agent.scopeMode, connectionIds: new Set(answer.connectionIds) };
}
