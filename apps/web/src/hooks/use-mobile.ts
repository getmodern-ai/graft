import * as React from "react";

/**
 * MUST equal Tailwind's stock `md` breakpoint — 48rem, 768px at the unoverridden default root
 * font size. `components/ui/sidebar.tsx` (`hidden md:block`, the mobile `Sheet` switch) draws
 * the mobile/desktop split in CSS that this hook computes in JS, and Tailwind v4 is CSS-first —
 * there is no `tailwind.config` to import the number from, so this is the one place it is
 * written down (Cando's ADR 0008, "Viewports", covers what the two-width gate this constant
 * draws the line for covers, and what is still fluid on either side of it). A value that
 * drifts from `md` tears the shell: JS renders one layout, CSS the other.
 * `use-mobile.test.ts` pins this constant against `index.css` so a drift fails a test instead
 * of shipping. Change this only together with a `--breakpoint-md` override there.
 *
 * Cando's `packages/ui/src/hooks/use-mobile.ts`, copied for its `sidebar.tsx` (GRA-45).
 */
export const MOBILE_BREAKPOINT = 768;

function getIsMobile() {
  // No SSR in this app today, but the hook is written for whatever imports it, and reading
  // `matchMedia` where there is no `window` throws rather than merely reading wrong. (Cando's
  // suite runs under jsdom and exercises the branch below; the console's colocated test pins
  // only the constant.)
  if (typeof window === "undefined") {
    return false;
  }
  return window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`).matches;
}

export function useIsMobile() {
  // Computed eagerly rather than started `undefined`: every consumer used to render the desktop
  // layout for one paint on mobile while this waited for the effect below to run (CAN-351).
  const [isMobile, setIsMobile] = React.useState(getIsMobile);

  React.useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
    const onChange = () => {
      setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
    };
    mql.addEventListener("change", onChange);
    // The lazy initializer above already read matchMedia once, at first render — but the
    // viewport can cross MOBILE_BREAKPOINT in the gap between that read and this effect
    // attaching the listener, and nothing would notify a listener that was not registered yet.
    // Re-syncing from `mql`'s own current match closes that gap; a `set` with an unchanged
    // value is a no-op re-render, so this costs nothing on the common path (CAN-351).
    setIsMobile(mql.matches);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return isMobile;
}
