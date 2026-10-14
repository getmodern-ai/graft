import type * as React from "react";
import { useState } from "react";

import {
  ChevronRightIcon,
  KeyboardArrowDownIcon,
  KeyboardArrowUpIcon,
  LockIcon,
} from "@/components/icons";
import { HarnessMark, IntegrationMark } from "@/components/marks";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { handoffFootnote } from "@/lib/handoff-page";
import { harnessMark } from "@/lib/marks";
import { isOpen, type PendingAction } from "@/lib/pending-action-queries";

/**
 * How a kind's card draws itself on the handoff page: `card`, the inbox's, or `focused`, the page
 * an agent links to (GRA-314; frames 03c, 03d, 03e). The ask, its answer and its writes are the
 * same either way; only the layout and the access choice differ.
 */
export type AskLayout = "card" | "focused";

/** What a kind's card says in the focused layout; `AskCard` passes the rest. */
export type FocusedAsk = {
  /** The vendor slug, for the integration's mark. */
  vendor: string;
  integrationName: string;
  /** The title, a question: "Connect Acme Unleashed for Hermes?" */
  question: React.ReactNode;
  /** The line under it: where the ask came from and the account or hosts it reaches. */
  lead?: React.ReactNode;
  /** The muted line above the disclosure: the hosts, the scheme, where the proposal came from. */
  summary?: React.ReactNode;
  /** What the disclosure opens: the proposal editor, or the facts the inbox card shows. */
  details?: {
    /** "Details", or "Edit details" where the content is the proposal editor. */
    label: string;
    content: React.ReactNode;
    /** Controlled by the card when a refusal must open it; uncontrolled otherwise. */
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
  };
  /** The no's verb: "Decline", or "Deny" for a tool. */
  declineLabel?: string;
  /** Whether the person types a secret here, which the footnote then speaks to. */
  secret?: boolean;
};

/** The line under a secret's input on the focused layout: where it goes, and who never sees it. */
export function SecretHint({ hosts, agentName }: { hosts: readonly string[]; agentName: string }) {
  return (
    <p className="flex items-center gap-1.5 text-muted-foreground text-xs">
      <LockIcon className="size-3.5 shrink-0" />
      Only sent to {hosts.join(", ")}. {agentName} never sees it.
    </p>
  );
}

/**
 * The focused layout:the agent's mark, an arrow and the integration's, the question and its lead,
 * the kind's inputs, the two answers side by side, then the summary with its disclosure; under the
 * card, how long it stays answerable. Composed from `Card` and the marks; once answered or expired
 * the answers give way to the settled sentence, as the inbox card's footer does.
 */
export function FocusedAskCard({
  action,
  focused,
  children,
  settled,
  onAnswer,
  pending,
  approveLabel,
  logoUrl,
}: {
  action: PendingAction;
  focused: FocusedAsk;
  children?: React.ReactNode;
  settled: (answer: PendingAction["answer"]) => React.ReactNode;
  onAnswer: (allow: boolean) => void;
  pending: boolean;
  approveLabel: string;
  logoUrl: string | null;
}) {
  const open = isOpen(action);
  const [shown, setShown] = useState(false);
  const details = focused.details;
  const detailsOpen = details?.open ?? shown;
  const toggle = () => {
    const next = !detailsOpen;
    if (details?.onOpenChange) details.onOpenChange(next);
    else setShown(next);
  };
  const agentName = action.agent?.name ?? null;

  return (
    <div className="flex w-full flex-col items-center gap-4">
      <Card className="w-full gap-5 p-6 md:p-8">
        <CardHeader className="flex flex-col items-center gap-5 px-0 text-center">
          <div aria-hidden="true" className="flex items-center gap-3">
            <HarnessMark
              mark={harnessMark(action.agent?.clientName ?? agentName)}
              tile="outline"
              size={22}
              className="size-14 rounded-lg"
            />
            <ChevronRightIcon className="size-4 text-muted-foreground" />
            <IntegrationMark
              slug={focused.vendor}
              name={focused.integrationName}
              logoUrl={logoUrl}
              tile="outline"
              size={22}
              className="size-14 rounded-lg"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <CardTitle className="text-balance text-lg">{focused.question}</CardTitle>
            {focused.lead ? (
              <CardDescription className="text-balance text-sm">{focused.lead}</CardDescription>
            ) : null}
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-5 px-0 text-sm">
          {open ? children : null}
          {open ? (
            <div className="flex gap-2">
              <Button
                variant="outline"
                className="flex-1"
                disabled={pending}
                onClick={() => onAnswer(false)}
              >
                {focused.declineLabel ?? "Decline"}
              </Button>
              <Button className="flex-1" disabled={pending} onClick={() => onAnswer(true)}>
                {approveLabel}
              </Button>
            </div>
          ) : (
            <p className="text-balance text-center text-muted-foreground">
              {action.answeredAt
                ? settled(action.answer)
                : "This request expired without an answer. Your agent will ask again if it still needs to."}
            </p>
          )}
          {focused.summary || details ? (
            <div className="flex flex-col gap-3 border-t pt-3">
              <div className="flex items-center gap-2">
                <p className="min-w-0 flex-1 text-muted-foreground text-xs">{focused.summary}</p>
                {details ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-expanded={detailsOpen}
                    onClick={toggle}
                  >
                    {detailsOpen ? "Hide details" : details.label}
                    {detailsOpen ? <KeyboardArrowUpIcon /> : <KeyboardArrowDownIcon />}
                  </Button>
                ) : null}
              </div>
              {details && detailsOpen ? (
                <div className="flex flex-col gap-4 rounded-lg bg-muted/50 p-3">
                  {details.content}
                </div>
              ) : null}
            </div>
          ) : null}
        </CardContent>
      </Card>
      {open ? (
        <p className="text-center text-muted-foreground text-xs">
          {handoffFootnote({
            expiresAt: action.expiresAt,
            agentName,
            secret: focused.secret === true,
          })}
        </p>
      ) : null}
    </div>
  );
}
