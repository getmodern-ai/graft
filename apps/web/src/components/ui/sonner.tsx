"use client";

import { useTheme } from "next-themes";
import type * as React from "react";
import { Toaster as Sonner, type ToasterProps } from "sonner";

import {
  CheckCircleIcon,
  DangerousIcon,
  InfoIcon,
  ProgressActivityIcon,
  WarningIcon,
} from "@/components/icons";

/**
 * Cando's `Toaster` (`packages/ui/src/components/sonner.tsx` there), the one primitive copied ahead
 * of GRA-45 because it belongs to the theme rather than to the primitives: sonner does not read the
 * `.dark` class, so without the theme passed in a toast over the dark console renders in sonner's
 * light styling (raised by Greptile on #25). The icons are the design system's Material Symbols and
 * the surface takes the popover tokens, so a toast is drawn like a popover in both modes.
 *
 * Cando's copy also names a `cn-toast` class in `toastOptions`, a registry leftover nothing
 * defines; left out rather than carried inert.
 */
const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme();

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      icons={{
        success: <CheckCircleIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <WarningIcon className="size-4" />,
        error: <DangerousIcon className="size-4" />,
        loading: <ProgressActivityIcon className="size-4 animate-spin" />,
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          // radius/2xl. Spelled as calc() because `@theme inline` does not emit `--radius-2xl` as a
          // custom property, so `var(--radius-2xl)` is undefined here.
          "--border-radius": "calc(var(--radius) + 8px)",
        } as React.CSSProperties
      }
      {...props}
    />
  );
};

export { Toaster };
