import { describe, expect, it } from "vitest";

import {
  connectionOn,
  laterOn,
  type ScopeState,
  type ScopeToggleWrite,
  scopeStateOf,
  turnConnection,
  turnLater,
} from "./scope-toggles";

const EVERY = ["conn_1", "conn_2", "conn_3"];
const all: ScopeState = { mode: "all", connectionIds: new Set(EVERY) };
const listed = (...ids: string[]): ScopeState => ({ mode: "listed", connectionIds: new Set(ids) });
const ids = (state: ScopeState) => [...state.connectionIds].sort();

/**
 * The server as GRA-294 and ADR 0007's amendment describe it, over the person's three connections:
 * what each write leaves. The helper's `next` must be exactly this, so the page never shows a
 * position the server would not answer.
 */
function serverAfter(state: ScopeState, write: ScopeToggleWrite): ScopeState {
  switch (write.kind) {
    case "none":
      return state;
    case "scope":
      if (write.body.mode === "all") return all;
      return listed(...(write.body.connectionIds ?? [...state.connectionIds]));
    case "grant":
      return state.mode === "all" ? state : listed(...state.connectionIds, write.connectionId);
    case "remove":
      return listed(...[...state.connectionIds].filter((id) => id !== write.connectionId));
  }
}

describe("the switches read off the scope", () => {
  it("under all: the later switch and every connection's are on", () => {
    expect(laterOn(all)).toBe(true);
    for (const id of EVERY) expect(connectionOn(all, id)).toBe(true);
  });

  it("under listed: the later switch is off and a connection is on when the list names it", () => {
    const state = listed("conn_2");
    expect(laterOn(state)).toBe(false);
    expect(EVERY.map((id) => connectionOn(state, id))).toEqual([false, true, false]);
  });
});

describe("turnLater", () => {
  it("on from listed writes all, and every connection comes on", () => {
    const outcome = turnLater(listed("conn_1"), true, EVERY);
    expect(outcome.write).toEqual({ kind: "scope", body: { mode: "all" } });
    expect(outcome.next.mode).toBe("all");
    expect(ids(outcome.next)).toEqual(EVERY);
    expect(outcome.stopsLater).toBe(false);
  });

  it("off from all writes listed with no list, so the server keeps what the agent reaches now", () => {
    const outcome = turnLater(all, false, EVERY);
    expect(outcome.write).toEqual({ kind: "scope", body: { mode: "listed" } });
    expect(outcome.next.mode).toBe("listed");
    expect(ids(outcome.next)).toEqual(EVERY);
    expect(outcome.stopsLater).toBe(true);
  });

  it("writes nothing when the switch is already where it was turned", () => {
    expect(turnLater(all, true, EVERY).write).toEqual({ kind: "none" });
    expect(turnLater(listed("conn_1"), false, EVERY).write).toEqual({ kind: "none" });
  });
});

describe("turnConnection", () => {
  it("off under all is the one-connection removal, which narrows the agent and says so", () => {
    const outcome = turnConnection(all, "conn_2", false);
    expect(outcome.write).toEqual({ kind: "remove", connectionId: "conn_2" });
    expect(outcome.next.mode).toBe("listed");
    expect(ids(outcome.next)).toEqual(["conn_1", "conn_3"]);
    expect(outcome.stopsLater).toBe(true);
  });

  it("on and off under listed are the grant and the removal, and the agent stays listed", () => {
    const on = turnConnection(listed("conn_1"), "conn_3", true);
    expect(on.write).toEqual({ kind: "grant", connectionId: "conn_3" });
    expect(ids(on.next)).toEqual(["conn_1", "conn_3"]);
    expect(on.stopsLater).toBe(false);

    const off = turnConnection(on.next, "conn_1", false);
    expect(off.write).toEqual({ kind: "remove", connectionId: "conn_1" });
    expect(off.next).toEqual(listed("conn_3"));
    expect(off.stopsLater).toBe(false);
  });

  it("writes nothing for a connection already on (every one under all) or already off", () => {
    expect(turnConnection(all, "conn_1", true).write).toEqual({ kind: "none" });
    expect(turnConnection(listed("conn_1"), "conn_2", false).write).toEqual({ kind: "none" });
  });
});

describe("no sequence of turns reaches a position the scope cannot hold", () => {
  type Turn = { later: boolean } | { connectionId: string; on: boolean };
  const turns: Turn[] = [
    { later: true },
    { later: false },
    ...EVERY.flatMap((connectionId) => [
      { connectionId, on: true },
      { connectionId, on: false },
    ]),
  ];

  const apply = (state: ScopeState, turn: Turn) =>
    "later" in turn
      ? turnLater(state, turn.later, EVERY)
      : turnConnection(state, turn.connectionId, turn.on);

  /** Every sequence of three turns from each starting scope: 8^3 paths over four starts. */
  it("each turn's next is what the server leaves, and the later switch on means every connection on", () => {
    const starts = [all, listed(), listed("conn_1"), listed(...EVERY)];
    let paths = 0;
    for (const start of starts) {
      for (const a of turns) {
        for (const b of turns) {
          for (const c of turns) {
            let state = start;
            for (const turn of [a, b, c]) {
              const outcome = apply(state, turn);
              const server = serverAfter(state, outcome.write);
              expect(outcome.next.mode).toBe(server.mode);
              expect(ids(outcome.next)).toEqual(ids(server));
              // The turned switch ends where it was turned.
              if ("later" in turn) expect(laterOn(outcome.next)).toBe(turn.later);
              else expect(connectionOn(outcome.next, turn.connectionId)).toBe(turn.on);
              // The position the model cannot hold: later on with a connection off.
              if (laterOn(outcome.next)) {
                for (const id of EVERY) expect(connectionOn(outcome.next, id)).toBe(true);
              }
              state = outcome.next;
            }
            paths++;
          }
        }
      }
    }
    expect(paths).toBe(4 * turns.length ** 3);
  });
});

describe("scopeStateOf", () => {
  it("reads a write's answer as the page holds it", () => {
    const state = scopeStateOf({
      agent: { scopeMode: "listed" },
      connectionIds: ["conn_1", "conn_3"],
    });
    expect(state).toEqual(listed("conn_1", "conn_3"));
  });
});
