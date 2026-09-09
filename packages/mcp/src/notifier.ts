/**
 * `notifications/tools/list_changed`, rate-limited per agent (ADR 0003: tool-list churn is a
 * first-class event, and the notification is rate-limited per agent).
 *
 * One agent may hold several sessions — a harness that reconnected, two processes with one token —
 * so the unit is the agent, not the session: every change to an agent's working set is announced
 * to every live session of that agent. The limit is one notification per window, leading edge
 * first: the first change after a quiet period is announced at once, because the turn in which a
 * tool was just published wants its list now, and every change inside the window is coalesced into
 * one trailing notification when the window closes, so the client's last fetch always sees the last
 * state. Ten promotes in a second are one notification now and at most one more later.
 *
 * A send that fails is dropped: a session that closed between the change and the timer is not an
 * error anyone can act on, and the next session lists afresh.
 */

export const DEFAULT_LIST_CHANGED_WINDOW_MS = 2_000;

export type ToolListChangedNotifier = {
  /** Add a live session's send; the returned function removes it. */
  attach(agentId: string, send: () => Promise<void>): () => void;
  /** The agent's working set changed — announce it, within the window's limit. */
  changed(agentId: string): void;
  /** Cancel every pending timer. For tests and shutdown. */
  close(): void;
};

type AgentState = {
  sinks: Set<() => Promise<void>>;
  timer: ReturnType<typeof setTimeout> | null;
  pending: boolean;
};

export function createToolListChangedNotifier(
  options: { windowMs?: number } = {},
): ToolListChangedNotifier {
  const windowMs = options.windowMs ?? DEFAULT_LIST_CHANGED_WINDOW_MS;
  const agents = new Map<string, AgentState>();

  const stateOf = (agentId: string): AgentState => {
    let state = agents.get(agentId);
    if (!state) {
      state = { sinks: new Set(), timer: null, pending: false };
      agents.set(agentId, state);
    }
    return state;
  };

  const fire = (state: AgentState) => {
    for (const send of state.sinks) {
      send().catch(() => undefined);
    }
  };

  const arm = (agentId: string, state: AgentState) => {
    const timer = setTimeout(() => {
      state.timer = null;
      if (state.pending) {
        state.pending = false;
        fire(state);
        arm(agentId, state);
      } else if (state.sinks.size === 0) {
        agents.delete(agentId);
      }
    }, windowMs);
    // A pending notification must not hold the process open past its last session.
    timer.unref?.();
    state.timer = timer;
  };

  return {
    attach(agentId, send) {
      const state = stateOf(agentId);
      state.sinks.add(send);
      return () => {
        state.sinks.delete(send);
        if (state.sinks.size === 0 && state.timer === null) agents.delete(agentId);
      };
    },
    changed(agentId) {
      const state = stateOf(agentId);
      if (state.timer !== null) {
        state.pending = true;
        return;
      }
      fire(state);
      arm(agentId, state);
    },
    close() {
      for (const state of agents.values()) {
        if (state.timer !== null) clearTimeout(state.timer);
        state.timer = null;
        state.pending = false;
      }
    },
  };
}
