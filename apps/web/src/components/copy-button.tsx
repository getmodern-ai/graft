import { useEffect, useState } from "react";
import { CheckIcon, ContentCopyIcon } from "@/components/icons";

import { Button } from "@/components/ui/button";

/** Copies `text` to the clipboard and says so for a moment. */
export function CopyButton({
  text,
  label = "Copy",
  variant = "outline",
}: {
  text: string;
  label?: string;
  /** `default` where copying is the card's primary action (Setup's prompt card). */
  variant?: "outline" | "default";
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <Button
      type="button"
      variant={variant}
      size="sm"
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
      }}
    >
      {copied ? <CheckIcon /> : <ContentCopyIcon />}
      {copied ? "Copied" : label}
    </Button>
  );
}
