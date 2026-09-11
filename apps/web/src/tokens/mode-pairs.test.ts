import { describe, expect, it } from "vitest";

import {
  checkModePairs,
  isDerivedFrom,
  isModeIdentical,
  type ModeException,
  type ModePair,
  parseModePairs,
  withoutAlpha,
} from "./mode-pairs";

/**
 * Rule B, against fixtures — Cando's suite for the same module, kept whole (ADR 0017).
 *
 * The failure it was written for is a real one from Cando's history: before its CAN-130 fix,
 * `--destructive` was `oklch(0.531 0.1933 25.14)` in *both* modes while every token derived from
 * it carried brand red/500 in dark. The console's `index.css` carries the fixed values, copied;
 * restoring the old one there makes this rule report it and leaves `biome ci`, `tsc` and the
 * token-utility check green — which is the only evidence that the rule is not redundant.
 *
 * The fixtures below are that shape, plus the four shapes that must stay *silent* and which are
 * the real difficulty: identity across modes is correct fifteen times out of sixteen in this
 * theme, so a rule that forbade it would be switched off in a week.
 */

const pair = (name: string, light: string, dark: string): ModePair => ({ name, light, dark });

/** `--destructive` and its family, exactly as they stood before Cando's CAN-130 fix. */
const beforeFix: ModePair[] = [
  pair("destructive", "oklch(0.531 0.1933 25.14)", "oklch(0.531 0.1933 25.14)"),
  pair(
    "custom-bg-destructive-10",
    "oklch(0.531 0.1933 25.14 / 10%)",
    "oklch(0.63 0.2294 25.06 / 10%)",
  ),
  pair(
    "custom-destructive-70",
    "oklch(0.531 0.1933 25.14 / 70%)",
    "oklch(0.63 0.2294 25.06 / 70%)",
  ),
  pair("destructive-foreground", "oklch(1 0 0)", "oklch(1 0 0)"),
];

/**
 * `--primary` with the family the source really gives it. The tints sit on a *different* hue from
 * the solid — recorded in `index.css`'s managed-block comment as a faithfully imported source
 * oddity — and dark tunes two of their alphas. Neither is a flip, and reading them as one would
 * report `--primary`, which is correct in both modes.
 */
const primaryFamily: ModePair[] = [
  pair("primary", "oklch(0.701 0.1885 36.31)", "oklch(0.701 0.1885 36.31)"),
  pair("custom-bg-primary-5", "oklch(0.68 0.2071 36.25 / 5%)", "oklch(0.68 0.2071 36.25 / 10%)"),
  pair("custom-bg-primary-80", "oklch(0.68 0.2071 36.25 / 80%)", "oklch(0.68 0.2071 36.25 / 80%)"),
  pair(
    "custom-border-primary-30",
    "oklch(0.68 0.2071 36.25 / 30%)",
    "oklch(0.68 0.2071 36.25 / 20%)",
  ),
  pair("primary-foreground", "oklch(0.157 0.0066 55.82)", "oklch(0.157 0.0066 55.82)"),
  pair("sidebar-primary", "oklch(0.68 0.2071 36.25)", "oklch(0.68 0.2071 36.25)"),
  pair("sidebar-primary-foreground", "oklch(0.157 0.0066 55.82)", "oklch(0.157 0.0066 55.82)"),
];

describe("parsing the two mode blocks", () => {
  it("pairs a token declared in both", () => {
    const css = ":root { --a: oklch(1 0 0); --b: red; }\n.dark { --a: oklch(0 0 0); }";
    expect(parseModePairs(css)).toEqual([pair("a", "oklch(1 0 0)", "oklch(0 0 0)")]);
  });

  it("keeps a multi-part value whose commas and parentheses contain no top-level semicolon", () => {
    const css = [
      ":root { --s: inset 0 -2px 0 0 oklch(0 0 0 / 20%), 0 1px 2px 0 oklch(0 0 0 / 5%); }",
      ".dark { --s: inset 0 -2px 0 0 oklch(0 0 0 / 20%), 0 1px 2px 0 oklch(0 0 0 / 55%); }",
    ].join("\n");
    expect(parseModePairs(css)[0]?.dark).toContain("0 1px 2px 0 oklch(0 0 0 / 55%)");
  });

  it("survives a semicolon inside a comment", () => {
    // The first version split declarations before stripping comments, and the token file's
    // comments are prose: `A scrim dims what is behind it; --foreground would invert…` silently
    // dropped `--scrim` altogether.
    const css = [
      ":root {",
      "  /* One thing; then another. */",
      "  --scrim: oklch(0 0 0 / 10%);",
      "}",
      ".dark { --scrim: oklch(0 0 0 / 60%); }",
    ].join("\n");
    expect(parseModePairs(css).map((p) => p.name)).toEqual(["scrim"]);
  });

  it("ignores a token that only one mode declares", () => {
    const css = ":root { --only-light: oklch(1 0 0); }\n.dark { --other: oklch(0 0 0); }";
    expect(parseModePairs(css)).toEqual([]);
  });

  it("ignores @theme, which holds namespace aliases rather than mode values", () => {
    const css = ":root { --a: red; }\n.dark { --a: blue; }\n@theme inline { --color-a: var(--a); }";
    expect(parseModePairs(css).map((p) => p.name)).toEqual(["a"]);
  });
});

describe("comparing colours without their alpha", () => {
  it("drops the slash form", () => {
    expect(withoutAlpha("oklch(0.531 0.1933 25.14 / 10%)")).toBe("oklch(0.531 0.1933 25.14)");
  });

  it("drops the legacy fourth argument", () => {
    expect(withoutAlpha("rgba(15, 12, 10, 0.1)")).toBe("rgba(15, 12, 10)");
  });

  it("leaves a colour with no alpha alone", () => {
    expect(withoutAlpha("oklch(1 0 0)")).toBe("oklch(1 0 0)");
  });

  it("drops the alpha of every colour in a multi-shadow value", () => {
    expect(withoutAlpha("inset 0 -2px 0 0 oklch(0 0 0 / 20%), 0 1px 2px 0 oklch(0 0 0 / 5%)")).toBe(
      "inset 0 -2px 0 0 oklch(0 0 0), 0 1px 2px 0 oklch(0 0 0)",
    );
  });

  it("makes two alpha-only variants compare as the same colour", () => {
    expect(
      isModeIdentical(pair("t", "oklch(0.68 0.2071 36.25 / 5%)", "oklch(0.68 0.2071 36.25 / 10%)")),
    ).toBe(true);
  });

  it("still separates two different colours at the same alpha", () => {
    expect(
      isModeIdentical(
        pair("t", "oklch(0.531 0.1933 25.14 / 10%)", "oklch(0.63 0.2294 25.06 / 10%)"),
      ),
    ).toBe(false);
  });
});

describe("what counts as derived from a base", () => {
  it("matches a base that appears as whole segments anywhere in the name", () => {
    expect(isDerivedFrom("custom-bg-destructive-10", "destructive")).toBe(true);
    expect(isDerivedFrom("custom-border-primary-checked", "primary")).toBe(true);
    expect(isDerivedFrom("sidebar-primary-foreground", "primary-foreground")).toBe(true);
  });

  it("does not match a name that merely contains the letters", () => {
    // `destructive-foreground` is not derived from `destructive-fore`, and nothing is derived
    // from a base whose segments it does not carry whole.
    expect(isDerivedFrom("custom-bg-destructive-10", "destructive-foreground")).toBe(false);
    expect(isDerivedFrom("primary", "primary-foreground")).toBe(false);
  });

  it("is not reflexive, so a base is never its own family member", () => {
    expect(isDerivedFrom("destructive", "destructive")).toBe(false);
  });
});

describe("the rule", () => {
  it("reports the pre-fix --destructive, naming the tokens that flipped", () => {
    const problems = checkModePairs(beforeFix, []);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("--destructive is oklch(0.531 0.1933 25.14) in both modes");
    expect(problems[0]).toContain("--custom-bg-destructive-10");
    expect(problems[0]).toContain("--custom-destructive-70");
    // The one family member that is *correctly* identical must not be listed as a flip.
    expect(problems[0]).not.toContain("--destructive-foreground");
  });

  it("says nothing once the base moves with its family", () => {
    const fixed = beforeFix.map((p) =>
      p.name === "destructive" ? pair(p.name, p.light, "oklch(0.63 0.2294 25.06)") : p,
    );
    expect(checkModePairs(fixed, [])).toEqual([]);
  });

  it("says nothing about --primary, whose family only tunes its alphas", () => {
    expect(checkModePairs(primaryFamily, [])).toEqual([]);
  });

  it("says nothing about a brand token with no family at all", () => {
    const brand = [
      pair("custom-brand-red", "oklch(0.63 0.2294 25.06)", "oklch(0.63 0.2294 25.06)"),
    ];
    expect(checkModePairs(brand, [])).toEqual([]);
  });

  it("says nothing about a base that flips, however its family behaves", () => {
    const muted = [
      pair("muted", "oklch(0.977 0.0034 67.78)", "oklch(0.295 0.0069 67.56)"),
      pair("muted-foreground", "oklch(0.524 0.0078 53.34)", "oklch(0.71 0.0091 56.26)"),
    ];
    expect(checkModePairs(muted, [])).toEqual([]);
  });

  it("honours an exception, so the mechanism is not waiting for a first user to be tested", () => {
    const allowed: ModeException[] = [{ token: "destructive", reason: "deliberate, somehow" }];
    expect(checkModePairs(beforeFix, allowed)).toEqual([]);
  });
});
