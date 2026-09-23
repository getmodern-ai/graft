import type { SetupConnectKind } from "@graft/core/setup/starter-vendors";

import type { PendingAction } from "./pending-action-queries";

/**
 * The vendor and connect steps' pure halves (GRA-206). The list itself is the server's
 * (`GET /api/setup/vendors`); these name what the console draws for it.
 */

/** The chip beside a starter: what connecting it takes on this deployment. */
export const SETUP_CONNECT_LABEL: Record<SetupConnectKind, string> = {
  link: "One click",
  none: "Connects at once",
  keyless: "No key needed",
  form: "Paste a key",
};

/** The value the vendor step's radio group holds for *Another vendor*, beside the starters' ids. */
export const ANOTHER_VENDOR = "another";

/**
 * What the connect step draws for the ask the record waits on: the ask's card while it is open in
 * the inbox's list, a wait while the list has not loaded, and a check once the ask has left the
 * list, since then it was answered or expired and the next read of the state moves the record.
 */
export type ConnectAskView =
  | { kind: "card"; action: PendingAction }
  | { kind: "loading" }
  | { kind: "settling" };

export function connectAskView(
  askId: string | null,
  openAsks: readonly PendingAction[] | undefined,
): ConnectAskView {
  if (openAsks === undefined) return { kind: "loading" };
  const action = askId ? openAsks.find((candidate) => candidate.id === askId) : undefined;
  return action ? { kind: "card", action } : { kind: "settling" };
}
