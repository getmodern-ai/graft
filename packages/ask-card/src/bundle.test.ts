import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { ASK_CARD_HTML_PATH } from "./index";
import { SETUP_TITLE } from "./render";

/**
 * The built page, as a host will receive it from `resources/read`. Three properties, each one a
 * host would break silently: everything is inlined (a host's content-security policy blocks an
 * external script or stylesheet, and the frame would mount blank — anthropics/claude-ai-mcp#61
 * collects exactly that); no colour is written as a literal outside the token block (ADR 0017:
 * dark mode is correct only through the tokens, and the console's `check-colours` does not reach
 * this package); and the page is one document with the mount the entry expects.
 *
 * The minifier strips comments, so the `cando:tokens` sentinels are asserted on the source
 * stylesheet, and the built CSS is held to the rule they mark: a literal belongs in a custom
 * property declared under `:root` or `.dark`, and nowhere else.
 *
 * Needs the build: `pnpm --filter @graft/ask-card build`. `turbo.json` runs it before this
 * package's `test`, and `check-types` runs it too, so CI never reaches this file without one.
 */

const STYLES_SOURCE = fileURLToPath(new URL("./styles.css", import.meta.url));

/** A colour written as a value: hex, or one of the functional notations. */
const COLOUR_LITERAL =
  /(?:^|[\s:,(])(#[0-9a-fA-F]{3,8}\b|(?:rgba?|hsla?|oklch|oklab|lab|lch|color)\()/g;

function html(): string {
  if (!existsSync(ASK_CARD_HTML_PATH)) {
    throw new Error(`no build at ${ASK_CARD_HTML_PATH}: run pnpm --filter @graft/ask-card build`);
  }
  return readFileSync(ASK_CARD_HTML_PATH, "utf8");
}

function css(page: string): string {
  return [...page.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1] ?? "").join("\n");
}

/** The CSS with the `:root{…}` and `.dark{…}` rules cut out — where a literal is allowed. */
function outsideTokenRules(stylesheet: string): string {
  return stylesheet.replace(/(?<=^|[{}\s])(?::root|\.dark)\s*\{[^}]*\}/g, " ");
}

describe("dist/ask.html", () => {
  it("is one document with no external script or stylesheet", () => {
    const page = html();
    expect(page).toMatch(/^<!doctype html>/i);
    expect(page).not.toMatch(/<script[^>]*\ssrc=/i);
    expect(page).not.toMatch(/<link[^>]*\shref=/i);
    expect(page).toContain('id="ask"');
    expect(page).toContain('name="color-scheme"');
    expect(page.match(/<script/g)?.length).toBe(1);
  });

  it("carries the Setup offer's kind and words in the one script (GRA-210)", () => {
    const page = html();
    expect(page).toContain(SETUP_TITLE);
    expect(page).toMatch(/[`"']setup[`"']/);
  });

  it("copies the console's token block whole, between its sentinels, in the source stylesheet", () => {
    const source = readFileSync(STYLES_SOURCE, "utf8");
    const consoleCss = readFileSync(
      fileURLToPath(new URL("../../../apps/web/src/index.css", import.meta.url)),
      "utf8",
    );
    const block = (text: string) => {
      const start = text.indexOf("/* cando:tokens:start");
      const end = text.indexOf("/* cando:tokens:end */");
      expect(start).toBeGreaterThanOrEqual(0);
      expect(end).toBeGreaterThan(start);
      return text.slice(start, end);
    };
    expect(block(source)).toBe(block(consoleCss));
  });

  it("writes no colour literal outside the :root and .dark token rules, and no inline style", () => {
    const page = html();
    const outside = outsideTokenRules(css(page));
    const literals = [...outside.matchAll(COLOUR_LITERAL)].map((m) => m[1]);
    expect(literals, `colour literals outside the token rules: ${literals.join(", ")}`).toEqual([]);
    // A custom property declared outside the two rules is where a literal would next hide.
    expect(outside.match(/--[a-z0-9-]+\s*:/g) ?? []).toEqual([]);
    expect(page).not.toMatch(/<[a-z][^>]*\sstyle="/i);
  });

  it("uses only tokens the block declares, or the host's two font variables", () => {
    const stylesheet = css(html());
    const declared = new Set([...stylesheet.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
    const hostVariables = new Set(["--font-sans", "--font-mono"]);
    const used = [...outsideTokenRules(stylesheet).matchAll(/var\((--[a-z0-9-]+)/g)].map(
      (m) => m[1] ?? "",
    );
    expect(used.length).toBeGreaterThan(0);
    expect(used.filter((name) => !declared.has(name) && !hostVariables.has(name))).toEqual([]);
  });
});
