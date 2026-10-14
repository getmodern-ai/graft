import { useMutation, useQueryClient } from "@tanstack/react-query";
import type * as React from "react";
import { useState } from "react";
import { toast } from "sonner";

import { IntegrationHarnessMark } from "@/components/marks";
import { useAnswerAsk } from "@/components/pending/ask-card";
import { RequestDialog } from "@/components/pending/request-dialog";
import { ToolAllowMenu } from "@/components/pending/tool-allow-menu";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { agentKeys } from "@/lib/agent-queries";
import { approvalKeys } from "@/lib/approval-queries";
import { connectedToastDescription, scopeAllowedToastDescription } from "@/lib/ask-answered-copy";
import { connectionKeys, submitConnectionProposal } from "@/lib/connection-queries";
import { formatDateTime } from "@/lib/format";
import type { HarnessMarkId } from "@/lib/marks";
import { type PendingAction, pendingKeys, readAsk } from "@/lib/pending-action-queries";
import {
  requestAgentName,
  requestRowAnswer,
  requestRowCopy,
  requestRowWhen,
} from "@/lib/request-row";
import { cachedDirectoryLogo } from "@/lib/setup-queries";
import { toolAskIntegrationName, toolAskToast } from "@/lib/tool-ask-copy";
import { cn } from "@/lib/utils";

/**
 * One open request as a row (GRA-310; "Graft / Request row" in the Figma file): the integration's
 * mark with the asking agent's on its corner, the sentence, the "Can delete" chip, the sub-line,
 * then the decline and the primary. The words are `lib/request-row.ts`'s. A primary that needs no
 * input answers here through the answer routes the cards use (`requestRowAnswer`); a tool's Allow
 * is the how-much menu (`ToolAllowMenu`, GRA-311), and every other primary, like the menu's *Open
 * request*, opens the ask's focused layout in `RequestDialog`.
 * Requests and Home's *Needs you* (GRA-327) draw this row inside `RequestList`.
 */
export function RequestRow({ action, harness }: { action: PendingAction; harness: HarnessMarkId }) {
  const queryClient = useQueryClient();
  const [opened, setOpened] = useState(false);
  const ask = readAsk(action);
  const copy = requestRowCopy(ask);
  const direct = requestRowAnswer(ask);
  const when = requestRowWhen(action);
  const agentName = requestAgentName(action);

  const answer = useAnswerAsk(action, undefined, "agent", (said) =>
    ask.kind === "tool"
      ? toolAskToast(said, toolAskIntegrationName(ask.payload))
      : ask.kind === "scope"
        ? {
            title: `${ask.payload.displayName} is in ${agentName}'s scope`,
            description: scopeAllowedToastDescription({
              origin: "agent",
              approveBuild: said.approveBuild === true,
            }),
          }
        : {
            title: "Approved",
            description:
              "The agent's waiting call resumes, and the answer holds for its next calls.",
          },
  );
  const confirm = useMutation({
    mutationFn: (body: Parameters<typeof submitConnectionProposal>[1]) =>
      submitConnectionProposal(action.id, body),
    onSuccess: ({ connection }) => {
      queryClient.invalidateQueries({ queryKey: pendingKeys.all });
      queryClient.invalidateQueries({ queryKey: connectionKeys.all });
      queryClient.invalidateQueries({ queryKey: agentKeys.all });
      queryClient.invalidateQueries({ queryKey: approvalKeys.vendorsOfAgent(action.agentId) });
      queryClient.invalidateQueries({ queryKey: approvalKeys.buildsOfAgent(action.agentId) });
      toast.success(`${connection.displayName} is connected`, {
        description: connectedToastDescription({ origin: "agent", agentName }),
      });
    },
  });
  const pending = answer.isPending || confirm.isPending;

  const onPrimary = () => {
    if (!direct) {
      setOpened(true);
      return;
    }
    if (direct.route === "answer") answer.mutate(direct.body);
    else confirm.mutate(direct.body);
  };

  return (
    // `py-2.5` around the 44px mark is the frame's 64px row; below `md` the buttons wrap under it.
    <li className="flex flex-wrap items-center gap-3 border-border border-b px-5 py-2.5 last:border-b-0">
      <IntegrationHarnessMark
        slug={copy.vendor}
        name={copy.integrationName}
        logoUrl={copy.vendor ? cachedDirectoryLogo(queryClient, copy.vendor) : null}
        harness={harness}
      />
      <div className="flex min-w-0 flex-1 basis-56 flex-col gap-0.5">
        <div className="flex flex-wrap items-center gap-2">
          <p className="font-medium text-base text-foreground">{copy.title}</p>
          {copy.destructive ? <Badge variant="destructive">Can delete</Badge> : null}
        </div>
        <p className="text-muted-foreground text-xs">
          {copy.detail}
          {copy.detail && when ? " · " : null}
          {when ? (
            <time dateTime={when.iso} title={formatDateTime(when.iso)}>
              {when.label}
            </time>
          ) : null}
        </p>
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          disabled={pending}
          onClick={() => answer.mutate({ allow: false })}
        >
          {copy.decline}
        </Button>
        {ask.kind === "tool" ? (
          <ToolAllowMenu
            ask={ask}
            pending={pending}
            onAnswer={(body) => answer.mutate(body)}
            onOpenRequest={() => setOpened(true)}
          />
        ) : (
          <Button size="sm" disabled={pending} onClick={onPrimary}>
            {copy.primary.label}
          </Button>
        )}
      </div>

      <RequestDialog action={action} title={copy.title} open={opened} onOpenChange={setOpened} />
    </li>
  );
}

/** The bordered card the rows sit in; its last row draws no divider. */
export function RequestList({ className, ...props }: React.ComponentProps<"ul">) {
  return (
    <ul
      className={cn(
        "flex flex-col overflow-hidden rounded-lg border border-border bg-card",
        className,
      )}
      {...props}
    />
  );
}

/**
 * A whole-width sentence in place of rows (GRA-47): the empty state, or the failed one with a
 * `RetryNotice` inside it. A row of the list, so the card stays where the rows will be.
 */
export function RequestListNote({ children }: { children: React.ReactNode }) {
  return <li className="px-5 py-4 text-center text-muted-foreground text-sm">{children}</li>;
}

/** Rows at the list's own rhythm while its read is pending. */
export function RequestListLoading({ rows = 3 }: { rows?: number }) {
  return (
    <>
      {Array.from({ length: rows }, (_, row) => (
        <li
          // biome-ignore lint/suspicious/noArrayIndexKey: placeholders with no identity of their own.
          key={row}
          className="flex items-center gap-3 border-border border-b px-5 py-2.5 last:border-b-0"
        >
          <Skeleton className="size-11 shrink-0 rounded-md" />
          <div className="flex flex-1 flex-col gap-1.5">
            <Skeleton className="h-5 w-2/3" />
            <Skeleton className="h-3 w-1/3" />
          </div>
        </li>
      ))}
    </>
  );
}
