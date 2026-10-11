import { describe, expect, it } from "vitest";

import { urlsIn } from "./triage";

describe("urlsIn", () => {
  it("finds every http(s) URL once, with the sentence's punctuation after it left off", () => {
    expect(
      urlsIn(
        "Read https://docs.example/api, then https://docs.example/api. Also ftp://no.example and http://x.test/a:b;",
      ),
    ).toEqual(["https://docs.example/api", "http://x.test/a:b"]);
  });

  it("trims a long run of trailing punctuation in linear time", () => {
    // The run is followed by a character the trim keeps: the case `/[.,;:]+$/` was quadratic on,
    // since a run that ends the string matched on its first try (Greptile on #212).
    const hostile = `https://docs.example/${",".repeat(1_000_000)}x`;
    const started = performance.now();
    expect(urlsIn(`see ${hostile}, then ${hostile}.`)).toEqual([hostile]);
    expect(performance.now() - started).toBeLessThan(500);
  });
});
