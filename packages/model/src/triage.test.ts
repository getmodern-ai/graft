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
    const hostile = `https://docs.example/${",".repeat(1_000_000)}`;
    const started = performance.now();
    expect(urlsIn(hostile)).toEqual(["https://docs.example/"]);
    expect(performance.now() - started).toBeLessThan(500);
  });
});
