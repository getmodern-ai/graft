import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, HeadContent, Outlet } from "@tanstack/react-router";
import { Toaster } from "sonner";

import { RouteError } from "@/components/route-error";
import { ThemeProvider } from "@/components/theme-provider";

import "../index.css";

export interface RouterAppContext {
  queryClient: QueryClient;
}

/**
 * The root renders no chrome. Whether a screen wears the shell is decided by where its file sits —
 * `_auth/_shell/` — and whether it needs a session one level up, in `_auth/`. Cando arrived at the
 * same split after a list of "bare" paths kept needing edits (its `apps/web/src/routes/__root.tsx`).
 */
export const Route = createRootRouteWithContext<RouterAppContext>()({
  component: RootComponent,
  errorComponent: RouteError,
  head: () => ({
    meta: [{ title: "Graft" }],
  }),
});

function RootComponent() {
  return (
    <>
      <HeadContent />
      {/* Cando's four settings, unchanged (ADR 0017): the theme is a class on `<html>`, a fresh
          visitor follows the OS, and a choice is remembered under the key Cando's console uses.
          `index.html`'s media-gated `theme-color` metas cover the instant before this mounts. */}
      <ThemeProvider
        attribute="class"
        defaultTheme="system"
        disableTransitionOnChange
        storageKey="vite-ui-theme"
      >
        <Outlet />
        <Toaster richColors position="top-right" />
      </ThemeProvider>
    </>
  );
}
