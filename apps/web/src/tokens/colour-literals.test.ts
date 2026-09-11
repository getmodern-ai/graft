import { describe, expect, it } from "vitest";

import {
  blankNonCode,
  blankSelectorValues,
  type ColourException,
  checkColourLiterals,
  findColourLiterals,
  findStaleExceptions,
  findThemeColourLiterals,
} from "./colour-literals";

/**
 * Rule A, against fixtures — Cando's suite for the same module, kept whole (ADR 0017).
 *
 * The findings the rule was written for were planted in Cando's real tree once — four
 * `bg-black/10` scrims and an inlined gradient — and the guard reported all five while `biome ci`,
 * `tsc` and `check-token-utilities.mjs` stayed green on the same tree. That run is what proved the
 * rule is not redundant, and the console reproduced the first finding on its own: `dialog.tsx`
 * carried `bg-black/10` until GRA-44 replaced it with `bg-scrim`.
 *
 * So the cases below are the same cases, plus the ones a planted run cannot show: the prose false
 * positives comment-blanking has to remove, the token-derived `color-mix` and `oklch(from …)` that
 * must stay legal, and both halves of the exception mechanism. Each one fails on exactly one
 * omission from the implementation, because a guard's own suite is the one place where a test that
 * passes for the wrong reason is indistinguishable from no guard at all.
 */

const texts = (source: string) => findColourLiterals(source).map((l) => l.text);

describe("blanking what is not code", () => {
  it("removes a line comment but keeps the line count", () => {
    const blanked = blankNonCode('const a = 1; // #fd6a41 is the brand\nconst b = "bg-black/10";');
    expect(blanked).not.toContain("#fd6a41");
    expect(blanked.split("\n")).toHaveLength(2);
    expect(blanked).toContain("bg-black/10");
  });

  it("removes a block comment across lines and preserves the newlines inside it", () => {
    const blanked = blankNonCode("/* #fff\n * #000\n */\nconst x = 1;");
    expect(blanked).not.toContain("#fff");
    expect(blanked).not.toContain("#000");
    // Four lines in, four lines out, so a finding on the last one still says line 4.
    expect(blanked.split("\n")).toHaveLength(4);
  });

  it("keeps strings, because a class name is a string", () => {
    expect(blankNonCode('cn("bg-black/10 text-white")')).toContain("bg-black/10 text-white");
  });

  it("does not mistake a URL's slashes for a comment", () => {
    const source = 'const u = "https://example.com/#fff";';
    expect(blankNonCode(source)).toBe(source);
  });

  it("keeps the code inside a template literal's interpolation", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the string *is* a template literal's source text, which is the input under test
    const blanked = blankNonCode('const c = `a ${cond ? "bg-white" : "bg-black"} b`;');
    expect(blanked).toContain("bg-white");
    expect(blanked).toContain("bg-black");
  });

  it("blanks a regex literal, which is a pattern rather than a declaration", () => {
    expect(blankNonCode("const re = /#[0-9a-f]{6}/g;")).not.toContain("#[0-9a-f]");
  });

  it("treats a slash after an identifier as division rather than a regex", () => {
    const source = "const half = width / 2; const q = other / 4;";
    expect(blankNonCode(source)).toBe(source);
  });
});

describe("blanking attribute-selector values", () => {
  it("blanks a hex that is being matched rather than set", () => {
    // A chart primitive overrides its library's own hardcoded output with exactly this shape.
    const blanked = blankSelectorValues("[&_.recharts-dot[stroke='#fff']]:stroke-transparent");
    expect(blanked).not.toContain("#fff");
    expect(blanked).toContain("stroke-transparent");
  });

  it("leaves a JSX attribute alone, which is a colour being set", () => {
    expect(blankSelectorValues('<path fill="#fff" />')).toContain("#fff");
  });
});

describe("what counts as a colour literal", () => {
  it("reports a Tailwind palette utility with an opacity modifier", () => {
    // The dialog backdrop as the console shipped it before GRA-44.
    expect(texts('"fixed inset-0 z-50 bg-black/10 backdrop-blur-xs"')).toEqual(["bg-black/10"]);
  });

  it("reports a numbered palette shade", () => {
    expect(texts('"border-gray-200 text-red-500"')).toEqual(["border-gray-200", "text-red-500"]);
  });

  it("reports an inlined gradient once per literal in it", () => {
    // Cando's agent disc sheen as it was inlined before its CAN-179, verbatim.
    const source =
      'const SHEEN = "bg-[linear-gradient(180deg,rgb(0_0_0/5%)_0%,rgb(0_0_0/0%)_25%),linear-gradient(180deg,rgb(255_255_255/0%)_50%,rgb(255_255_255/20%)_100%)]";';
    expect(findColourLiterals(source)).toHaveLength(4);
    expect(findColourLiterals(source).every((l) => l.kind === "function")).toBe(true);
  });

  it("does not report transparent, current or inherit, which are keywords not colours", () => {
    expect(texts('"bg-transparent border-transparent text-current text-inherit"')).toEqual([]);
  });

  it("does not report a colour function that derives from a token", () => {
    // `button.tsx`'s secondary hover — it responds to the theme, which is the thing being protected.
    expect(texts('"bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)]"')).toEqual([]);
    expect(texts('"bg-[oklch(from_var(--primary)_0.93_calc(c*0.4)_h)]"')).toEqual([]);
  });

  it("does report a colour function that derives from nothing", () => {
    expect(texts('"shadow-[0_1px_2px_oklch(0_0_0/5%)]"')).toEqual(["oklch(0_0_0/5%)"]);
  });

  it("does not report a pull-request number, which is valid three-digit hex", () => {
    expect(texts("// raised by Greptile on PR #139, see also #109\nconst x = 1;")).toEqual([]);
  });

  it("reports the right line number after a long comment block", () => {
    const source = ["/*", " * prose", " * more prose", " */", 'cn("bg-white")'].join("\n");
    expect(findColourLiterals(source)).toEqual([{ line: 5, text: "bg-white", kind: "palette" }]);
  });

  it("does not treat a longer word ending in a colour name as one", () => {
    expect(texts('"bg-sidebar-border text-muted-foreground shadow-button"')).toEqual([]);
  });
});

describe("a colour literal inside @theme", () => {
  it("reports shadow tokens declared as literals there", () => {
    // Verbatim from Cando's `globals.css` before its CAN-179, where they sat inside `@theme` and
    // so had no `.dark` counterpart at all — which is also why Rule B could never see them.
    const css = [
      "@theme inline {",
      "  --shadow-button: inset 0 -2px 0 0 oklch(0 0 0 / 20%), 0 1px 2px 0 oklch(0 0 0 / 5%);",
      "  --shadow-chat-input: 0 4px 16px 0 oklch(0 0 0 / 6%);",
      "}",
    ].join("\n");
    expect(findThemeColourLiterals(css).map((l) => `${l.line}:${l.text}`)).toEqual([
      "2:oklch(0 0 0 / 20%)",
      "2:oklch(0 0 0 / 5%)",
      "3:oklch(0 0 0 / 6%)",
    ]);
  });

  it("says nothing about an entry that holds a var(), which is the shape of the fix", () => {
    const css = "@theme inline {\n  --shadow-button: var(--button-shadow);\n}";
    expect(findThemeColourLiterals(css)).toEqual([]);
  });

  it("says nothing about the font stacks, which are the only other literals in there", () => {
    const css = '@theme inline {\n  --font-serif: Georgia, "Times New Roman", serif;\n}';
    expect(findThemeColourLiterals(css)).toEqual([]);
  });

  it("leaves :root and .dark alone, which is where a literal is allowed to live", () => {
    const css = ":root { --scrim: oklch(0 0 0 / 10%); }\n.dark { --scrim: oklch(0 0 0 / 60%); }";
    expect(findThemeColourLiterals(css)).toEqual([]);
  });

  it("does not report a colour quoted in a comment inside the block", () => {
    const css = "@theme inline {\n  /* Figma draws #fd6a41 here. */\n  --color-a: var(--a);\n}";
    expect(findThemeColourLiterals(css)).toEqual([]);
  });
});

describe("the exception mechanism", () => {
  const file = {
    path: "apps/web/src/components/thing.tsx",
    source: 'cn("bg-white border-black")',
  };

  it("reports both literals with no exception", () => {
    expect(checkColourLiterals([file], [])).toHaveLength(2);
  });

  it("exempts a whole file when no literals are named", () => {
    const whole: ColourException[] = [{ file: "components/thing.tsx", reason: "generated art" }];
    expect(checkColourLiterals([file], whole)).toEqual([]);
  });

  it("exempts only the literals it names, so a new one in the same file is still reported", () => {
    const narrow: ColourException[] = [
      { file: "components/thing.tsx", literals: ["bg-white"], reason: "deliberate" },
    ];
    const problems = checkColourLiterals([file], narrow);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("border-black");
  });

  it("does not let an exception for one file cover another", () => {
    const other: ColourException[] = [
      { file: "components/elsewhere.tsx", literals: ["bg-white"], reason: "deliberate" },
    ];
    expect(checkColourLiterals([file], other)).toHaveLength(2);
  });

  it("reports an exception that no longer matches anything", () => {
    const stale: ColourException[] = [
      { file: "components/thing.tsx", literals: ["bg-white"], reason: "still here" },
      { file: "components/gone.tsx", reason: "file deleted" },
      { file: "components/thing.tsx", literals: ["bg-red-500"], reason: "literal fixed" },
    ];
    expect(findStaleExceptions([file], stale)).toEqual([
      "components/gone.tsx",
      "components/thing.tsx  bg-red-500",
    ]);
  });
});
