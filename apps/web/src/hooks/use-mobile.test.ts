import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { MOBILE_BREAKPOINT } from "./use-mobile";

/**
 * Pins `MOBILE_BREAKPOINT` to Tailwind's stock `md` — the agreement `use-mobile.ts`'s doc comment
 * requires. Two independent breakpoint definitions (this constant, and every `md:` class in the
 * CSS) agreeing today by coincidence is exactly what lets them drift silently; this reads the real
 * CSS sources rather than trusting a comment, so a `--breakpoint-md` override or a root
 * `font-size` change — either of which would move `md` away from 768px without touching this
 * file — fails here instead of shipping a torn shell where JS says mobile and CSS says desktop.
 *
 * Cando's `packages/ui/src/hooks/use-mobile.test.ts` (its CAN-351), pointed at the console's one
 * stylesheet tree (GRA-45): there is no `packages/ui` here, so `apps/web/src` is the whole scan.
 * A scan of first-party *source* — `node_modules` and generated files (`*.gen.*`) are excluded —
 * not of Tailwind's compiled output, so an override arriving through a dependency's own CSS would
 * not be caught here.
 */
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

function findCssFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...findCssFiles(full));
    } else if (entry.name.endsWith(".css") && !entry.name.includes(".gen.")) {
      files.push(full);
    }
  }
  return files;
}

const CSS_SOURCES = findCssFiles(join(REPO_ROOT, "apps/web/src"));

describe("MOBILE_BREAKPOINT agrees with Tailwind's md", () => {
  it("is 768 — 48rem at the default 16px root font size", () => {
    expect(MOBILE_BREAKPOINT).toBe(48 * 16);
  });

  it("has at least one CSS source to scan, so an empty glob cannot pass silently", () => {
    expect(CSS_SOURCES.length).toBeGreaterThan(0);
  });

  it("finds no --breakpoint-md override anywhere, which is what would move md off 48rem", () => {
    const offenders = CSS_SOURCES.filter((file) =>
      /--breakpoint-md\s*:/.test(readFileSync(file, "utf8")),
    );
    expect(offenders).toEqual([]);
  });

  it("finds no root font-size override anywhere, which is what would move 48rem off 768px", () => {
    const offenders = CSS_SOURCES.filter((file) =>
      /(?:html|:root)\s*\{[^}]*font-size\s*:/.test(readFileSync(file, "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});
