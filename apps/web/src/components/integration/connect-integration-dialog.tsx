import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { OpenInNewIcon, WarningIcon } from "@/components/icons";
import { IntegrationMark } from "@/components/marks";
import { SetupChoice } from "@/components/setup/setup-choice";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FieldLegend, FieldSet } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { ApiError } from "@/lib/api";
import { connectionKeys, fetchConnection } from "@/lib/connection-queries";
import { type ConsoleConnect, connectIntegration } from "@/lib/integration-queries";
import {
  accessOptions,
  type ConnectAccess,
  connectButtonLabel,
  connectStepSentence,
} from "@/lib/integrations-discover";
import { openConsentPopup } from "@/lib/oauth-consent";
import { awaitLink, type LinkOutcome, type LinkSettled } from "@/lib/provider-link";
import type { DirectoryEntry } from "@/lib/setup-queries";

/**
 * What the dialog connects: a directory entry, as Discover's tiles hold one, or a suggestion,
 * which names a vendor and not how it connects (`connect` absent), so the server's answer decides.
 */
export type ConnectTarget = Pick<DirectoryEntry, "slug" | "name" | "logoUrl"> & {
  connect?: DirectoryEntry["connect"] | null;
  starterId?: string | null;
};

/** The keyring's form, handed back to the caller to open pre-filled (`AddConnectionDialog`). */
export type ConnectForm = Extract<ConsoleConnect, { kind: "form" }>;

type LinkPhase =
  | { phase: "idle" }
  | { phase: "running" }
  | { phase: "blocked"; url: string; connectId: string; expiresAt: string }
  | { phase: "done"; outcome: Exclude<LinkOutcome, "connected">; message: string };

/**
 * Discover's connect step (GRA-322; Figma 2043:7028's Connect, composed as Flow B's dialog
 * 11b/11c draws it): the integration's mark, what connecting takes, and the access choice ADR 0008
 * as amended 2026-10-14 offers when the person connects with no agent asking, Full access
 * pre-selected as the connection confirmation pre-ticks it. Connect is `POST /api/connect`
 * (GRA-304) by slug, and the answer decides the rest:
 *
 * - `connected`: a toast, and the integration's page.
 * - `form`: the keyring's form, handed to the caller (`onForm`) to open pre-filled with the access.
 * - `link`: the provider's sign-in in a popup, waited on as an ask's link is (`awaitLink`) but by
 *   the record's `connectId`, which `/link/callback` posts back. The connection the return makes
 *   carries that id, so the poll reads it by id.
 */
export function ConnectIntegrationDialog({
  target,
  onOpenChange,
  onForm,
  onNotFound,
}: {
  /** The integration to connect; null when the dialog is closed. */
  target: ConnectTarget | null;
  onOpenChange: (open: boolean) => void;
  onForm: (form: ConnectForm, name: string) => void;
  /** The directory holds no such integration (a suggestion's vendor): the caller hands it to Flow C. */
  onNotFound?: (target: ConnectTarget) => void;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [access, setAccess] = useState<ConnectAccess>("full");
  const [link, setLink] = useState<LinkPhase>({ phase: "idle" });
  const stop = useRef<AbortController | null>(null);
  // The attempt the dialog stands on: a reply to one closed or replaced since is ignored.
  const attempt = useRef(0);
  // The last integration shown, so the closing animation does not draw an empty dialog.
  const [shown, setShown] = useState<ConnectTarget | null>(target);
  if (target && target !== shown) setShown(target);
  const entry = target ?? shown;

  useEffect(() => () => stop.current?.abort(), []);

  const connected = (vendor: string, name: string, chosen: ConnectAccess) => {
    void queryClient.invalidateQueries({ queryKey: connectionKeys.all });
    toast.success(`${name} is connected`, {
      description:
        chosen === "full"
          ? "Your agents can build its tools and use them without asking."
          : "Each agent asks before it builds or uses a tool.",
    });
    close(false);
    void navigate({ to: "/integrations/$vendor", params: { vendor } });
  };

  const wait = async (
    popup: Window,
    started: { connectId: string; expiresAt: string; access: ConnectAccess },
    vendor: string,
    name: string,
  ) => {
    const { connectId } = started;
    stop.current?.abort();
    const controller = new AbortController();
    stop.current = controller;
    setLink({ phase: "running" });
    const ended = await awaitLink({
      popup,
      match: { connectId },
      isSettled: () => readSettled(connectId),
      signal: controller.signal,
      // The provider's own lifetime for the link, which may be shorter than the default.
      deadlineMs: Math.max(0, Date.parse(started.expiresAt) - Date.now()),
    });
    if (stop.current === controller) stop.current = null;
    if (ended.outcome === "connected") {
      setLink({ phase: "idle" });
      connected(vendor, name, started.access);
    } else {
      setLink({ phase: "done", outcome: ended.outcome, message: ended.message });
    }
  };

  const connect = useMutation({
    // A slug the directory lacks (a suggestion's vendor) is Flow C's, not a failure to toast.
    mutationFn: (input: { target: ConnectTarget; access: ConnectAccess; attempt: number }) =>
      connectIntegration({ slug: input.target.slug, access: input.access }).catch((error) => {
        if (onNotFound && error instanceof ApiError && error.status === 404) {
          return { kind: "missing" as const };
        }
        throw error;
      }),
    onSuccess: (result, { target: chosen, access: chose, attempt: made }) => {
      if (made !== attempt.current) return;
      if (result.kind === "missing") {
        close(false);
        onNotFound?.(chosen);
        return;
      }
      if (result.kind === "connected") {
        connected(result.connection.vendor, result.connection.displayName, chose);
        return;
      }
      if (result.kind === "form") {
        if (result.fallback) toast.message(result.fallback.message);
        close(false);
        onForm(result, chosen.name);
        return;
      }
      const popup = openConsentPopup(result.url);
      if (!popup) {
        setLink({
          phase: "blocked",
          url: result.url,
          connectId: result.connectId,
          expiresAt: result.expiresAt,
        });
        return;
      }
      void wait(popup, { ...result, access: chose }, chosen.slug, chosen.name);
    },
  });

  const close = (open: boolean) => {
    if (open) return;
    attempt.current += 1;
    stop.current?.abort();
    onOpenChange(false);
    setTimeout(() => {
      setLink({ phase: "idle" });
      setAccess("full");
      connect.reset();
    }, 200);
  };

  if (!entry) return null;
  // A blocked popup's link carries the access it was minted with, so the choice stays as it was.
  const running = connect.isPending || link.phase === "running" || link.phase === "blocked";
  const options = accessOptions(entry.name).map((option) => ({
    ...option,
    aside: option.value === "full" ? <Badge variant="secondary">Recommended</Badge> : undefined,
  }));

  return (
    <Dialog open={target !== null} onOpenChange={close}>
      <DialogContent className="sm:max-w-md">
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            attempt.current += 1;
            connect.mutate({ target: entry, access, attempt: attempt.current });
          }}
        >
          <DialogHeader className="items-center text-center">
            <IntegrationMark
              slug={entry.starterId ?? entry.slug}
              name={entry.name}
              logoUrl={entry.logoUrl}
              tile="outline"
              tileSize={40}
              size={22}
            />
            <DialogTitle>Connect {entry.name}?</DialogTitle>
            <DialogDescription>{connectStepSentence(entry)}</DialogDescription>
          </DialogHeader>
          <FieldSet>
            <FieldLegend variant="label">What can your agents do with it?</FieldLegend>
            <SetupChoice
              name="connect-access"
              legend="Access"
              className="gap-2 sm:grid-cols-1 lg:grid-cols-1"
              options={options}
              value={access}
              onChange={setAccess}
              disabled={running}
            />
          </FieldSet>
          <LinkStatus
            state={link}
            name={entry.name}
            onCancel={() => stop.current?.abort()}
            onOpen={(blocked) => {
              // A press is a gesture, so the browser lets this one open.
              const popup = openConsentPopup(blocked.url);
              if (popup) void wait(popup, { ...blocked, access }, entry.slug, entry.name);
            }}
          />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => close(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={running}>
              {connect.isPending
                ? "Connecting…"
                : link.phase === "running"
                  ? "Waiting for the sign-in…"
                  : link.phase === "done"
                    ? "Try again"
                    : connectButtonLabel(entry)}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** The poll's read: the connection the return route made under the record's id, once it stands. */
async function readSettled(connectId: string): Promise<LinkSettled> {
  try {
    const { connection } = await fetchConnection(connectId);
    return connection.revokedAt === null
      ? { settled: true, connectionId: connection.id }
      : { settled: false };
  } catch {
    // A 404 until the return route has made it.
    return { settled: false };
  }
}

function LinkStatus({
  state,
  name,
  onCancel,
  onOpen,
}: {
  state: LinkPhase;
  name: string;
  onCancel: () => void;
  onOpen: (blocked: Extract<LinkPhase, { phase: "blocked" }>) => void;
}) {
  switch (state.phase) {
    case "idle":
      return null;
    case "running":
      return (
        <div className="flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
          <Spinner className="size-3.5" />
          <span>Sign in with {name} in the popup. This closes once you are sent back.</span>
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            Stop waiting
          </Button>
        </div>
      );
    case "blocked":
      return (
        <Alert>
          <WarningIcon />
          <AlertTitle>The browser blocked the popup</AlertTitle>
          <AlertDescription>
            <Button
              type="button"
              variant="link"
              className="h-auto p-0"
              onClick={() => onOpen(state)}
            >
              Open {name}'s sign-in
              <OpenInNewIcon className="size-3" />
            </Button>
          </AlertDescription>
        </Alert>
      );
    case "done":
      return (
        <Alert variant={state.outcome === "failed" ? "destructive" : "default"}>
          <WarningIcon />
          <AlertTitle>
            {state.outcome === "declined"
              ? "The sign-in was declined"
              : state.outcome === "stopped"
                ? "Stopped waiting for the sign-in"
                : state.outcome === "expired"
                  ? "The sign-in took too long"
                  : "The sign-in did not complete"}
          </AlertTitle>
          <AlertDescription>
            {state.message || `Nothing was connected. Try again to sign in with ${name}.`}
          </AlertDescription>
        </Alert>
      );
  }
}
