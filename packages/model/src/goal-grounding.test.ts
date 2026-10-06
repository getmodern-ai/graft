import { describe, expect, it } from "vitest";

import { bareHost, usableGoals } from "./goal-grounding";

/**
 * The grounding's string handling over the model's own answer (CodeQL's polynomial-ReDoS on #172):
 * the host and the task are the model's, so each is read in linear time, pinned here on a hundred
 * thousand repeated characters of the kind that made the regular expressions they replaced
 * quadratic. The behaviour on real values is `propose-goals.test.ts`'s.
 */

const LONG = 100_000;

/** Run `work` and answer how long it took, in milliseconds. */
function timed(work: () => void): number {
  const started = performance.now();
  work();
  return performance.now() - started;
}

describe("bareHost", () => {
  it("strips the scheme, the path, the query, the fragment and the port", () => {
    expect(bareHost(" HTTPS://Geocoding-API.open-meteo.com:443/v1/search?name=x ")).toBe(
      "geocoding-api.open-meteo.com",
    );
    expect(bareHost("www.googleapis.com:443")).toBe("www.googleapis.com");
    expect(bareHost("api.open-meteo.com#frag")).toBe("api.open-meteo.com");
    expect(bareHost("api.open-meteo.com?x=1")).toBe("api.open-meteo.com");
    // Not a scheme: the part before `://` holds a character no scheme has.
    expect(bareHost("a b://host")).toBe("a b:");
    // A colon not followed by digits alone is not a port.
    expect(bareHost("host:abc")).toBe("host:abc");
  });

  it("reads a hundred thousand repeated characters in linear time", () => {
    for (const input of [
      "#".repeat(LONG),
      `a${"#".repeat(LONG)}`,
      // The regular expression's `.*$` stopped at the line break and failed from every `#`.
      `${"#".repeat(LONG)}\nx`,
      "/".repeat(LONG),
      ":".repeat(LONG),
      `${":1".repeat(LONG / 2)}x`,
      `a${"a".repeat(LONG)}:/`,
    ]) {
      expect(timed(() => bareHost(input))).toBeLessThan(250);
    }
    expect(bareHost("#".repeat(LONG))).toBe("");
  });
});

describe("usableGoals' cleaning", () => {
  it("strips the quotes wrapping a goal and nothing inside it", () => {
    expect(usableGoals(['""Show my inbox"', "“List my labels”", 'Say "hi" to me'], null)).toEqual([
      "Show my inbox",
      "List my labels",
      'Say "hi" to me',
    ]);
    expect(usableGoals(['"""'], null)).toEqual([]);
  });

  it("reads a hundred thousand repeated quotes in linear time", () => {
    for (const input of [
      '"'.repeat(LONG),
      `${'"'.repeat(LONG)}x`,
      // The regular expression's `["'”]+$` failed from every quote before the last character.
      `x${'"'.repeat(LONG)}x`,
      `${"'".repeat(LONG)}a`,
    ]) {
      expect(timed(() => usableGoals([input], null))).toBeLessThan(250);
    }
    expect(usableGoals([`${'"'.repeat(LONG)}x`], null)).toEqual(["x"]);
  });
});
