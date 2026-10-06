import type * as React from "react";
import { useId, useState } from "react";

import { KeyboardArrowDownIcon, KeyboardArrowUpIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Setup's disclosure: a ghost `Button` with the arrow glyph, `aria-expanded` and `aria-controls`,
 * over a region drawn only while open. The harness step's *Advanced options* shape (GRA-204),
 * lifted out so the progress card's *Details* and the finish's *Set it up by hand* (GRA-215) use
 * the same one; the console has no collapsible primitive, and Cando's disclosures are this.
 */
export function SetupDisclosure({
  label,
  children,
  className,
  defaultOpen = false,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  return (
    <div className={cn("flex flex-col gap-4", className)}>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="self-start"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((was) => !was)}
      >
        {open ? <KeyboardArrowUpIcon /> : <KeyboardArrowDownIcon />}
        {label}
      </Button>
      {open ? (
        <div id={id} className="flex min-w-0 flex-col gap-4">
          {children}
        </div>
      ) : null}
    </div>
  );
}
