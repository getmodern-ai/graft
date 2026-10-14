import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { LimitsForm } from "@/components/agent/limits-form";
import { RevokeAgentDialog } from "@/components/agent/revoke-agent-dialog";
import { RotateTokenDialog } from "@/components/agent/rotate-token-dialog";
import { EditIcon } from "@/components/icons";
import { SettingsCard, SettingsRowGroup } from "@/components/settings/settings-card";
import { SettingsRow } from "@/components/settings/settings-row";
import { Button } from "@/components/ui/button";
import {
  agentSignInLine,
  agentSignInOf,
  toolsKeptReadyLine,
  unusedToolsLine,
} from "@/lib/agent-advanced";
import { type Agent, workingSetQuery } from "@/lib/agent-queries";
import { tokenRotatable } from "@/lib/agent-token";

/**
 * The agent page's Advanced card (GRA-326; Figma 2047:7614): how many tools it keeps ready, when
 * unused ones are put away (ADR 0009), how it signs in (ADR 0018), and Revoke on its own card
 * below (GRA-282's word). Edit swaps the rows for `LimitsForm`, which saves the name and both
 * knobs; Rotate token is GRA-306's dialog, offered only where `tokenRotatable` says the server
 * would take it. A revoked agent's card reads and offers nothing.
 */
export function AgentAdvanced({ agent }: { agent: Agent }) {
  const [editing, setEditing] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const workingSet = useQuery(workingSetQuery(agent.id));
  const frozen = agent.revokedAt !== null;
  const signIn = agentSignInOf(agent);

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <section className="flex flex-col gap-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 flex-col gap-0.5">
            <h2 className="font-heading font-medium text-lg">Advanced</h2>
            <p className="text-muted-foreground text-sm">
              How {agent.name} keeps tools ready and signs in.
            </p>
          </div>
          {frozen || editing ? null : (
            <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
              <EditIcon data-icon="inline-start" />
              Edit
            </Button>
          )}
        </div>
        {editing && !frozen ? (
          <LimitsForm
            key={`${agent.name}:${agent.workingSetCap}:${agent.idleWindowDays}`}
            agent={agent}
            onDone={() => setEditing(false)}
          />
        ) : (
          <SettingsCard>
            <SettingsRowGroup>
              <SettingsRow
                title="Tools kept ready"
                description={toolsKeptReadyLine(
                  agent,
                  workingSet.data ? workingSet.data.workingSet.length : null,
                )}
              />
              <SettingsRow title="Unused tools" description={unusedToolsLine(agent)} />
              <SettingsRow
                title="How it signs in"
                description={agentSignInLine(signIn)}
                action={
                  tokenRotatable(agent) ? (
                    <Button variant="outline" size="sm" onClick={() => setRotating(true)}>
                      Rotate token
                    </Button>
                  ) : undefined
                }
              />
            </SettingsRowGroup>
          </SettingsCard>
        )}
      </section>

      {frozen ? null : (
        <SettingsCard>
          <SettingsRow
            title="Revoke this agent"
            description={`${agent.name} loses access to every integration straight away.`}
            action={
              <Button variant="destructive" size="sm" onClick={() => setRevoking(true)}>
                Revoke
              </Button>
            }
          />
        </SettingsCard>
      )}

      <RevokeAgentDialog agent={agent} open={revoking} onOpenChange={setRevoking} />
      <RotateTokenDialog agent={agent} open={rotating} onOpenChange={setRotating} />
    </div>
  );
}
