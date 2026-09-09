import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createToolListChangedNotifier } from "./notifier";

/**
 * The per-agent rate limit on `tools/list_changed` (ADR 0003), under fake timers: leading edge at
 * once, everything inside the window coalesced into one trailing send, nothing when nothing
 * changed, and one agent's changes never reaching another agent's sessions.
 */

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function sink() {
  const calls: number[] = [];
  const send = vi.fn(async () => {
    calls.push(Date.now());
  });
  return { send, calls };
}

describe("the list-changed notifier", () => {
  it("announces the first change at once and coalesces the rest into one trailing send", () => {
    const notifier = createToolListChangedNotifier({ windowMs: 2_000 });
    const a = sink();
    notifier.attach("agent_a", a.send);

    for (let i = 0; i < 10; i += 1) notifier.changed("agent_a");
    expect(a.send).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1_999);
    expect(a.send).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(a.send).toHaveBeenCalledTimes(2);

    // A quiet window sends nothing more and disarms.
    vi.advanceTimersByTime(2_000);
    expect(a.send).toHaveBeenCalledTimes(2);
    notifier.changed("agent_a");
    expect(a.send).toHaveBeenCalledTimes(3);
    notifier.close();
  });

  it("reaches every session of the agent and none of another agent's", () => {
    const notifier = createToolListChangedNotifier({ windowMs: 100 });
    const a1 = sink();
    const a2 = sink();
    const b = sink();
    notifier.attach("agent_a", a1.send);
    const detach = notifier.attach("agent_a", a2.send);
    notifier.attach("agent_b", b.send);

    notifier.changed("agent_a");
    expect(a1.send).toHaveBeenCalledTimes(1);
    expect(a2.send).toHaveBeenCalledTimes(1);
    expect(b.send).not.toHaveBeenCalled();

    detach();
    vi.advanceTimersByTime(100);
    notifier.changed("agent_a");
    expect(a1.send).toHaveBeenCalledTimes(2);
    expect(a2.send).toHaveBeenCalledTimes(1);
    notifier.close();
  });

  it("drops a send that fails rather than throwing into the change", async () => {
    const notifier = createToolListChangedNotifier({ windowMs: 100 });
    notifier.attach("agent_a", async () => {
      throw new Error("session closed");
    });
    expect(() => notifier.changed("agent_a")).not.toThrow();
    await vi.runAllTimersAsync();
    notifier.close();
  });
});
