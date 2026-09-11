import type * as React from "react";

import { CopyButton } from "@/components/copy-button";
import { cn } from "@/lib/utils";

/**
 * Text meant to be taken whole — an agent's token, the shell line that exports it, the
 * `mcpServers` block, an ask's raw payload — with its name and the copy control on one row, the
 * text itself in the mono stack on the muted band, and room for one sentence about where it goes.
 *
 * One component rather than a `<pre>` per screen: the three places that drew this by hand had
 * already drifted from one another in radius and padding, and a copy control that one of them
 * lacked is what a person reaching for a token wants first (GRA-45). Not a Cando primitive — Cando
 * has no code block, so this is composed from its tokens the way ADR 0017 asks: the band is the
 * one its `CardFooter` and `DialogFooter` use, the radius is its control radius.
 */
export function CodeBlock({
  label,
  code,
  copyLabel = "Copy",
  hint,
  className,
}: {
  /** What the block holds, in the person's words — "The agent's token". */
  label: React.ReactNode;
  /** Exactly what the copy control puts on the clipboard. */
  code: string;
  copyLabel?: string;
  /** One sentence under the block about what to do with it, if the label is not enough. */
  hint?: React.ReactNode;
  className?: string;
}) {
  return (
    <div data-slot="code-block" className={cn("flex flex-col gap-1.5", className)}>
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium text-sm">{label}</span>
        <CopyButton text={code} label={copyLabel} />
      </div>
      <pre className="overflow-x-auto rounded-lg border bg-muted/50 p-3 font-mono text-xs leading-relaxed">
        <code>{code}</code>
      </pre>
      {hint ? <p className="text-muted-foreground text-xs">{hint}</p> : null}
    </div>
  );
}
