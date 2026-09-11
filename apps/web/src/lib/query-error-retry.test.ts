import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "./api";

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), dismiss: vi.fn() },
}));

const { toast } = await import("sonner");
const { createQueryClient } = await import("./query-client");

type ToastOptions = { id: string; action: { label: string; onClick: () => void } };

function lastToast(): ToastOptions {
  const call = vi.mocked(toast.error).mock.calls.at(-1);
  if (!call) throw new Error("no toast was shown");
  return call[1] as ToastOptions;
}

/** A query that fails on demand: `fail` decides each fetch, `settle` releases a hanging one. */
function failingQuery() {
  let fail = true;
  let release: (() => void) | null = null;
  const queryFn = vi.fn(async () => {
    if (release !== null) {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    }
    if (fail) throw new ApiError(500, "INTERNAL", "The toolbox is unavailable");
    return "ok";
  });
  return {
    queryFn,
    succeedNext: () => {
      fail = false;
    },
    hangNext: () => {
      release = () => {};
    },
    settle: () => {
      release?.();
      release = null;
    },
  };
}

describe("the query-error toast", () => {
  beforeEach(() => {
    vi.mocked(toast.error).mockClear();
    vi.mocked(toast.dismiss).mockClear();
  });

  it("toasts the server's sentence, keyed to the query, with a Retry action", async () => {
    const client = createQueryClient();
    const { queryFn } = failingQuery();

    await client.fetchQuery({ queryKey: ["agents"], queryFn }).catch(() => {});

    const query = client.getQueryCache().find({ queryKey: ["agents"] });
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalledWith(
      "The toolbox is unavailable",
      expect.objectContaining({ id: query?.queryHash, action: expect.anything() }),
    );
    expect(lastToast().action.label).toBe("Retry");
  });

  it("says the server could not be reached when the request never arrived", async () => {
    const client = createQueryClient();
    await client
      .fetchQuery({
        queryKey: ["offline"],
        queryFn: async () => {
          throw new TypeError("Failed to fetch");
        },
        retry: false,
      })
      .catch(() => {});

    expect(toast.error).toHaveBeenCalledWith("Could not reach the server", expect.anything());
  });

  it("refetches on Retry and dismisses the toast once the query succeeds", async () => {
    const client = createQueryClient();
    const { queryFn, succeedNext } = failingQuery();
    await client.fetchQuery({ queryKey: ["agents"], queryFn }).catch(() => {});
    const { id, action } = lastToast();

    succeedNext();
    action.onClick();

    await vi.waitFor(() => expect(queryFn).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(toast.dismiss).toHaveBeenCalledWith(id));
    expect(client.getQueryData(["agents"])).toBe("ok");
  });

  it("replaces the toast rather than stacking one when the retry fails again", async () => {
    const client = createQueryClient();
    const { queryFn } = failingQuery();
    await client.fetchQuery({ queryKey: ["agents"], queryFn }).catch(() => {});
    const first = lastToast();

    first.action.onClick();

    await vi.waitFor(() => expect(toast.error).toHaveBeenCalledTimes(2));
    expect(lastToast().id).toBe(first.id);
    expect(toast.dismiss).not.toHaveBeenCalled();
  });

  it("ignores Retry while the query is already fetching", async () => {
    const client = createQueryClient();
    const { queryFn, hangNext, settle, succeedNext } = failingQuery();
    await client.fetchQuery({ queryKey: ["agents"], queryFn }).catch(() => {});
    const { action } = lastToast();

    hangNext();
    succeedNext();
    action.onClick();
    await vi.waitFor(() => expect(queryFn).toHaveBeenCalledTimes(2));
    action.onClick();
    action.onClick();
    settle();

    await vi.waitFor(() => expect(client.getQueryData(["agents"])).toBe("ok"));
    expect(queryFn).toHaveBeenCalledTimes(2);
  });

  it("never dismisses for a query that did not fail", async () => {
    const client = createQueryClient();
    await client.fetchQuery({ queryKey: ["fine"], queryFn: async () => "ok" });

    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.dismiss).not.toHaveBeenCalled();
  });
});
