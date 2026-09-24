import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./auth-client", () => ({
  authClient: { signOut: vi.fn() },
}));

const { authClient } = await import("./auth-client");
const { sessionKeys } = await import("./session-queries");
const { signOutAndForget } = await import("./sign-out");

const signOut = vi.mocked(authClient.signOut);

/** A cache holding the departing person's session and one of their reads. */
function seededClient() {
  const client = new QueryClient();
  client.setQueryData(sessionKeys.current, { user: { id: "p_1" } });
  client.setQueryData(["pending-actions"], { pendingActions: [] });
  return client;
}

beforeEach(() => {
  signOut.mockReset();
});

describe("signOutAndForget", () => {
  /**
   * The order is the fix for the toast on sign-out: readers still on screen re-ask for whatever
   * `clear()` removes, so the clear waits until `leave` has taken them off the screen. The session
   * entry alone goes before `leave`, so no guard reads the departed session meanwhile.
   */
  it("drops the session entry, leaves, and only then clears the rest", async () => {
    signOut.mockResolvedValue({ data: { success: true }, error: null } as never);
    const client = seededClient();
    const seenWhileLeaving: { session: unknown; pending: unknown } = { session: 1, pending: 1 };
    const leave = vi.fn(async () => {
      seenWhileLeaving.session = client.getQueryData(sessionKeys.current);
      seenWhileLeaving.pending = client.getQueryData(["pending-actions"]);
    });

    await expect(signOutAndForget(client, leave)).resolves.toEqual({ ok: true });

    expect(leave).toHaveBeenCalledOnce();
    expect(seenWhileLeaving.session).toBeUndefined();
    expect(seenWhileLeaving.pending).toEqual({ pendingActions: [] });
    expect(client.getQueryCache().getAll()).toHaveLength(0);
  });

  it("keeps the cache and stays put when Better Auth refuses", async () => {
    signOut.mockResolvedValue({
      data: null,
      error: { message: "Session already ended", status: 400 },
    } as never);
    const client = seededClient();
    const leave = vi.fn(async () => {});

    await expect(signOutAndForget(client, leave)).resolves.toEqual({
      ok: false,
      reason: "refused",
      message: "Session already ended",
    });
    expect(leave).not.toHaveBeenCalled();
    expect(client.getQueryCache().getAll()).toHaveLength(2);
  });

  it("keeps the cache and stays put when the server is unreachable", async () => {
    signOut.mockRejectedValue(new TypeError("Failed to fetch"));
    const client = seededClient();
    const leave = vi.fn(async () => {});

    await expect(signOutAndForget(client, leave)).resolves.toEqual({
      ok: false,
      reason: "unreachable",
    });
    expect(leave).not.toHaveBeenCalled();
    expect(client.getQueryCache().getAll()).toHaveLength(2);
  });
});
