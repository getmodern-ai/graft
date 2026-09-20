import { Link } from "@tanstack/react-router";
import { useRef, useState } from "react";

import { AgentConnectionDialog } from "@/components/agent/agent-connection-dialog";
import { ArchiveAgentDialog } from "@/components/agent/archive-agent-dialog";
import { EditAgentDialog } from "@/components/agent/edit-agent-dialog";
import { MoreHorizIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { Agent } from "@/lib/agent-queries";

export function AgentActions({ agent }: { agent: Agent }) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [editing, setEditing] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const active = !agent.revokedAt && !agent.archivedAt;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          ref={trigger}
          render={<Button variant="ghost" size="icon-sm" />}
          aria-label={`Actions for ${agent.name}`}
        >
          <MoreHorizIcon />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-max min-w-44 whitespace-nowrap">
          <DropdownMenuItem render={<Link to="/agents/$agentId" params={{ agentId: agent.id }} />}>
            View agent
          </DropdownMenuItem>
          {active ? (
            <DropdownMenuItem onClick={() => setConnecting(true)}>
              Connection details
            </DropdownMenuItem>
          ) : null}
          {!agent.archivedAt ? (
            <>
              <DropdownMenuItem disabled={!active} onClick={() => setEditing(true)}>
                Edit
              </DropdownMenuItem>
              <DropdownMenuItem variant="destructive" onClick={() => setArchiving(true)}>
                Archive
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      {connecting && active ? (
        <AgentConnectionDialog
          agent={agent}
          onClose={() => setConnecting(false)}
          returnFocus={trigger}
        />
      ) : null}
      {editing ? (
        <EditAgentDialog agent={agent} onClose={() => setEditing(false)} returnFocus={trigger} />
      ) : null}
      <ArchiveAgentDialog
        agent={agent}
        open={archiving}
        onOpenChange={setArchiving}
        returnFocus={trigger}
      />
    </>
  );
}
