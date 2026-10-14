import { ChevronRightIcon, KeyboardArrowDownIcon } from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { Ask, PendingAnswer } from "@/lib/pending-action-queries";
import { requestAgentName, toolActionWords } from "@/lib/request-row";
import {
  toolAllowAnswer,
  toolAllowMenuLabel,
  toolAllowMenuOptions,
  toolLabel,
} from "@/lib/tool-allow-choice";
import { toolAskIntegrationName } from "@/lib/tool-ask-copy";

/**
 * A tool ask's Allow, as a menu of how much (GRA-311; frames 2107:12561 and 2107:13052; ADR 0008 as
 * amended 2026-10-14): the choices `toolAllowMenuOptions` lists, each answering on the spot with
 * `toolAllowAnswer`'s body and no ask-every-call key, then *Open request*, which hands the ask to
 * the request dialog where the tick and the line that includes destructive tools are. The caller
 * owns the answer, so Requests and Home's *Needs you* (GRA-327) post it through their own mutation.
 */
export function ToolAllowMenu({
  ask,
  pending,
  onAnswer,
  onOpenRequest,
}: {
  ask: Extract<Ask, { kind: "tool" }>;
  pending: boolean;
  onAnswer: (body: PendingAnswer) => void;
  onOpenRequest: () => void;
}) {
  const { payload } = ask;
  const agentName = requestAgentName(ask.action);
  const integrationName = toolAskIntegrationName(payload);
  const options = toolAllowMenuOptions({
    agentName,
    integrationName,
    tool: toolLabel(payload.toolName, payload.vendor),
    destructive: payload.annotations.destructiveHint === true,
  });

  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button size="sm" disabled={pending} />}>
        Allow
        <KeyboardArrowDownIcon data-icon="inline-end" />
      </DropdownMenuTrigger>
      {/* The frame's 340px, never past the screen at 390px. */}
      <DropdownMenuContent align="end" className="w-[min(340px,calc(100vw-2rem))]">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="px-2.5 pt-2 pb-1 font-medium leading-4">
            {toolAllowMenuLabel({
              agentName,
              action: toolActionWords(payload.toolName),
              integrationName,
            })}
          </DropdownMenuLabel>
          {options.map((option) => (
            <DropdownMenuItem
              key={option.value}
              variant={option.destructive ? "destructive" : "default"}
              className="flex-col items-start gap-0.5 px-2.5 py-2"
              onClick={() => onAnswer(toolAllowAnswer(option.value))}
            >
              <span className="flex items-center gap-2 font-medium">
                {option.title}
                {option.recommended ? <Badge variant="secondary">Recommended</Badge> : null}
              </span>
              <span className="text-muted-foreground text-xs">{option.description}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem className="gap-2.5 px-2.5 py-2" onClick={onOpenRequest}>
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="font-medium">Open request</span>
            <span className="text-muted-foreground text-xs">
              See what it does and where data goes.
            </span>
          </span>
          <ChevronRightIcon className="text-muted-foreground" />
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
