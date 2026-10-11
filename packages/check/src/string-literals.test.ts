import { describe, expect, it } from "vitest";

import { stringLiteralsOf } from "./string-literals";

/**
 * The strings a module spells, read by a parse (Greptile on #192): a hand-rolled reader turned `\n`
 * into `n` and missed a literal inside a template's `${…}`, so the scrub drew a module's own
 * constant again and the second run took another branch.
 */
describe("stringLiteralsOf", () => {
  it("reads string and template literals with their escapes decoded, and those inside a substitution", () => {
    const content = [
      '// a comment\'s "quoted" text is not a literal',
      'const re = /"not-a-literal"/;',
      'const a = "line\\nbreak";',
      "const b = 'it\\'s';",
      "const c = `plain`;",
      // `$` and `{` apart, so this file's own string holds no template placeholder.
      [
        "const d = `head-$",
        '{x.kind === "message" ? `inner-$',
        "{y}` : 'other'}-middle-$",
        "{z}-tail`;",
      ].join(""),
      'const e = "\\u0041\\x42";',
    ].join("\n");
    const found = stringLiteralsOf([{ path: "index.ts", content }]);
    expect(found).toEqual(
      expect.arrayContaining([
        "line\nbreak",
        "it's",
        "plain",
        "head-",
        "message",
        "inner-",
        "other",
        "-middle-",
        "-tail",
        "AB",
      ]),
    );
    expect(found).not.toContain("quoted");
    expect(found).not.toContain("not-a-literal");
    expect(found).not.toContain("n");
  });

  it("reads a JavaScript file and skips a file that is not a script", () => {
    expect(
      stringLiteralsOf([
        { path: "lib/util.mjs", content: 'export const k = "from-js";' },
        { path: "README.md", content: 'say "not code"' },
      ]),
    ).toEqual(["from-js"]);
  });
});
