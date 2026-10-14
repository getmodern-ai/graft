import { useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";

import { AgentConnectionDialog } from "@/components/agent/agent-connection-dialog";
import { EditAgentDialog } from "@/components/agent/edit-agent-dialog";
import { RevokeAgentDialog } from "@/components/agent/revoke-agent-dialog";
import { RotateTokenDialog } from "@/components/agent/rotate-token-dialog";
import { DescriptionIcon, MoreHorizIcon } from "@/components/icons";
import { HarnessMark } from "@/components/marks";
import {
  PageHeader,
  PageHeaderActions,
  PageHeaderContent,
  PageHeaderTitle,
} from "@/components/page/page-header";
import { StatusChip } from "@/components/status-chip";
import { Time } from "@/components/time";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { agentMark } from "@/lib/agent-cards";
import { agentHeaderFacts } from "@/lib/agent-page";
import type { Agent } from "@/lib/agent-queries";
import { tokenRotatable } from "@/lib/agent-token";
import { setupQuery } from "@/lib/setup-queries";
import { agentStatusChip } from "@/lib/status-chips";

/**
 * The agent page's header (GRA-325; Figma 2047:7614): the harness mark in a 56px tile, the name,
 * the status chip and one line of facts, then *Setup instructions* (`AgentConnectionDialog`) and
 * the ⋯ menu: Edit (name, cap, idle window), *Rotate token* for a static-token agent (GRA-306) and
 * Revoke. A revoked agent's header is read-only: the facts gain when, and nothing is offered.
 */
export function AgentHeader({ agent }: { agent: Agent }) {
  const setup = useQuery(setupQuery);
  const instructionsTrigger = useRef<HTMLButtonElement>(null);
  const menuTrigger = useRef<HTMLButtonElement>(null);
  // Which door opened the instructions, so focus returns to it when they close.
  const [connecting, setConnecting] = useState<"button" | "menu" | null>(null);
  const [editing, setEditing] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const facts = agentHeaderFacts(agent);
  const active = !agent.revokedAt;

  return (
    <PageHeader className="items-center gap-4">
      <span className="flex size-14 shrink-0 items-center justify-center rounded-lg bg-secondary">
        <HarnessMark mark={agentMark(agent, setup.data)} tile="none" className="size-5" />
      </span>
      <PageHeaderContent>
        <div className="flex min-w-0 items-center gap-2">
          <PageHeaderTitle className="truncate text-3xl tracking-tight">
            {agent.name}
          </PageHeaderTitle>
          <StatusChip chip={agentStatusChip(agent)} className="shrink-0" />
        </div>
        <p className="text-muted-foreground text-sm">
          {facts.client} · created <Time iso={facts.created} /> · {facts.signsIn}
          {agent.tokenPrefix ? (
            <>
              {" "}
              (<code className="font-mono">{agent.tokenPrefix}…</code>)
            </>
          ) : null}
          {agent.revokedAt ? (
            <>
              {" "}
              · revoked <Time iso={agent.revokedAt} />
            </>
          ) : null}
        </p>
      </PageHeaderContent>
      {active ? (
        <PageHeaderActions>
          <Button
            ref={instructionsTrigger}
            variant="outline"
            onClick={() => setConnecting("button")}
            className="hidden sm:inline-flex"
          >
            <DescriptionIcon />
            Setup instructions
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger
              ref={menuTrigger}
              render={<Button variant="outline" size="icon" />}
              aria-label={`Actions for ${agent.name}`}
            >
              <MoreHorizIcon />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-max min-w-44 whitespace-nowrap">
              {/* Below `sm` the button steps out of the row and the menu carries it. */}
              <DropdownMenuItem className="sm:hidden" onClick={() => setConnecting("menu")}>
                Setup instructions
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setEditing(true)}>Edit</DropdownMenuItem>
              {tokenRotatable(agent) ? (
                <DropdownMenuItem onClick={() => setRotating(true)}>Rotate token</DropdownMenuItem>
              ) : null}
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={() => setRevoking(true)}>
                Revoke
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </PageHeaderActions>
      ) : null}

      {connecting && active ? (
        <AgentConnectionDialog
          agent={agent}
          onClose={() => setConnecting(null)}
          returnFocus={connecting === "button" ? instructionsTrigger : menuTrigger}
        />
      ) : null}
      {editing && active ? (
        <EditAgentDialog
          agent={agent}
          onClose={() => setEditing(false)}
          returnFocus={menuTrigger}
        />
      ) : null}
      {active ? (
        <>
          <RotateTokenDialog agent={agent} open={rotating} onOpenChange={setRotating} />
          <RevokeAgentDialog agent={agent} open={revoking} onOpenChange={setRevoking} />
        </>
      ) : null}
    </PageHeader>
  );
}
