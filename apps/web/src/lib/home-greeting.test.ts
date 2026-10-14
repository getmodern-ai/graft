import { describe, expect, it } from "vitest";

import { homeGreeting } from "./home-greeting";

const at = (hour: number) => new Date(2026, 9, 14, hour, 30);

describe("homeGreeting", () => {
  it("names the part of the day by the local hour", () => {
    expect(homeGreeting(at(3), "Seb")).toBe("Good evening, Seb");
    expect(homeGreeting(at(5), "Seb")).toBe("Good morning, Seb");
    expect(homeGreeting(at(11), "Seb")).toBe("Good morning, Seb");
    expect(homeGreeting(at(12), "Seb")).toBe("Good afternoon, Seb");
    expect(homeGreeting(at(17), "Seb")).toBe("Good afternoon, Seb");
    expect(homeGreeting(at(18), "Seb")).toBe("Good evening, Seb");
  });

  it("greets by the first name", () => {
    expect(homeGreeting(at(14), "  Seb Poole ")).toBe("Good afternoon, Seb");
  });

  it("stands alone with no name", () => {
    expect(homeGreeting(at(14), "")).toBe("Good afternoon");
    expect(homeGreeting(at(14), null)).toBe("Good afternoon");
  });
});
