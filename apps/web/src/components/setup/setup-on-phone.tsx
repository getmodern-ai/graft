import { SETUP_PATH } from "@graft/core/setup/setup.rules";
import { useState } from "react";
import { CheckIcon, ContentCopyIcon, OpenInNewIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";

/**
 * Setup on a phone (GRA-267): both sign-ups of 2026-10-10 arrived on Android, and a harness is
 * mostly connected from a computer (Claude Code, Codex, Hermes, OpenClaw; Claude and ChatGPT on
 * the web). One quiet row offering to send this page to themselves: the system share sheet where
 * the browser has one (`navigator.share`), else a copy of the link. Setup resumes where the record
 * stands on any device, so the link is the page itself.
 */
export function SetupOnPhone() {
  const [copied, setCopied] = useState(false);
  // Neither the share sheet nor the clipboard worked: the link itself, to copy by hand.
  const [showUrl, setShowUrl] = useState(false);
  const url = `${window.location.origin}${SETUP_PATH}`;
  const canShare = typeof navigator.share === "function";
  return (
    <div className="flex items-center gap-3 rounded-lg border bg-muted/50 px-3 py-2 text-sm md:hidden">
      <p className="min-w-0 flex-1 text-muted-foreground">
        On your phone? Send yourself this link and finish on your computer.
        {showUrl ? (
          <span className="mt-1 block break-all font-mono text-foreground text-xs">{url}</span>
        ) : null}
      </p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={async () => {
          if (canShare) {
            try {
              await navigator.share({ title: "Set up Graft", url });
              return;
            } catch (error) {
              // The person closing the sheet is an answer; anything else falls back to the copy.
              if (error instanceof DOMException && error.name === "AbortError") return;
            }
          }
          try {
            await navigator.clipboard.writeText(url);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          } catch {
            setShowUrl(true);
          }
        }}
      >
        {canShare ? <OpenInNewIcon /> : copied ? <CheckIcon /> : <ContentCopyIcon />}
        {canShare ? "Send link" : copied ? "Copied" : "Copy link"}
      </Button>
    </div>
  );
}
