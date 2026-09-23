import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import { installSetupState, type SetupStateData, setupKeys } from "./setup-queries";

/** Two states the connect step can see: the one a poll left with, and the one a verb answered. */
const connect = { step: "connect" } as SetupStateData;
const goal = { step: "goal" } as SetupStateData;

describe("installSetupState", () => {
  it("keeps a verb's answer when a read that left before it lands after it", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let land: (state: SetupStateData) => void = () => {};
    queryClient.setQueryData(setupKeys.current, connect);
    // A poll in flight, holding the state as it stood before the verb committed.
    const polled = queryClient
      .fetchQuery({
        queryKey: setupKeys.current,
        queryFn: () =>
          new Promise<SetupStateData>((resolve) => {
            land = resolve;
          }),
        staleTime: 0,
      })
      .catch(() => null);
    await installSetupState(queryClient, goal);
    land(connect);
    await polled;
    expect(queryClient.getQueryData(setupKeys.current)).toEqual(goal);
  });

  it("leaves the vendors list alone", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(setupKeys.vendors, { vendors: [] });
    await installSetupState(queryClient, goal);
    expect(queryClient.getQueryData(setupKeys.vendors)).toEqual({ vendors: [] });
  });
});
