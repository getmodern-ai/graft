import { useRef, useState } from "react";

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
        <DropdownMenuContent align="end">
          <DropdownMenuItem disabled={agent.revokedAt !== null} onClick={() => setEditing(true)}>
            Edit
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {editing ? (
        <EditAgentDialog agent={agent} onClose={() => setEditing(false)} returnFocus={trigger} />
      ) : null}
    </>
  );
}
