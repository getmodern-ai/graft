import { ThemeProvider as NextThemesProvider, useTheme } from "next-themes";
import type * as React from "react";
import { useLayoutEffect } from "react";

/**
 * The `--background` token for each mode (`apps/web/src/index.css`: `oklch(1 0 0)` /
 * `oklch(0.157 0.0066 55.82)`), converted to sRGB hex because `<meta name="theme-color">` takes a
 * flat CSS color and cannot read a custom property or an `oklch()` function. Keep this in step with
 * those two tokens if either one ever moves — it is a sanctioned exception in
 * `apps/web/src/tokens/colour-literals.ts`'s `COLOUR_EXCEPTIONS` rather than a token, for the
 * reason recorded there (ADR 0017).
 */
const THEME_COLOR: Record<"light" | "dark", string> = {
  light: "#ffffff",
  dark: "#0f0c0a",
};

/**
 * Cando's provider (`apps/web/src/components/theme-provider.tsx` there), unchanged in behaviour:
 * `next-themes` puts `.dark` on `<html>` — the class `@custom-variant dark` in `index.css` matches —
 * and remembers a choice under the same storage key Cando uses, so a person with both products open
 * sees one theme. `__root.tsx` passes the four settings.
 */
export function ThemeProvider({
  children,
  ...props
}: React.ComponentProps<typeof NextThemesProvider>) {
  return (
    <NextThemesProvider {...props}>
      <ThemeColorMeta />
      {children}
    </NextThemesProvider>
  );
}

/**
 * Keeps `<meta name="theme-color">` — the color a mobile browser paints its own chrome, the address
 * bar and status bar — in step with the resolved theme.
 *
 * `useLayoutEffect` rather than `useEffect`: it flushes synchronously right after React commits the
 * DOM and before the browser's next paint, on the initial mount as much as on every update after
 * it — which is what lets this run with no visible flash of the wrong color. A plain `useEffect`
 * would still get there, just one paint later. `index.html` carries one media-gated
 * `<meta name="theme-color">` per scheme for the instant before this component has mounted at all —
 * the OS picks between them, which under `defaultTheme="system"` in `__root.tsx` is already the
 * answer, so only an explicit stored override is visibly fixed up here.
 *
 * Every matching meta gets the resolved color, not just the first: the browser applies whichever
 * tag's `media` matches the OS, so writing one tag would let the OS scheme beat an explicit choice
 * for the other.
 */
function ThemeColorMeta() {
  const { resolvedTheme } = useTheme();

  useLayoutEffect(() => {
    if (resolvedTheme !== "light" && resolvedTheme !== "dark") {
      return;
    }

    const metas = document.querySelectorAll('meta[name="theme-color"]');
    if (metas.length === 0) {
      const meta = document.createElement("meta");
      meta.setAttribute("name", "theme-color");
      meta.setAttribute("content", THEME_COLOR[resolvedTheme]);
      document.head.appendChild(meta);
      return;
    }
    for (const meta of metas) {
      meta.setAttribute("content", THEME_COLOR[resolvedTheme]);
    }
  }, [resolvedTheme]);

  return null;
}

export { useTheme } from "next-themes";
