import { useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";

import { AgentDetailsSection } from "@/components/agent/agent-details-section";
import { ApprovalsCard } from "@/components/agent/approvals-card";
import { HarnessSnippet } from "@/components/agent/harness-snippet";
import { LimitsForm } from "@/components/agent/limits-form";
import { RevokeAgentDialog } from "@/components/agent/revoke-agent-dialog";
import { ScopeEditor } from "@/components/agent/scope-editor";
import { WorkingSetHistory } from "@/components/agent/working-set-history";
import { WorkingSetTable } from "@/components/agent/working-set-table";
import { CloseIcon } from "@/components/icons";
import { PageContainer } from "@/components/page/page-container";
import { RetryNotice } from "@/components/retry-notice";
import { StatusChip } from "@/components/status-chip";
import { Time } from "@/components/time";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { agentQuery } from "@/lib/agent-queries";
import { connectionsQuery } from "@/lib/connection-queries";
import { agentStatusChip } from "@/lib/status-chips";

/** Each route id mounts a fresh drawer, so unsaved fields cannot follow another agent. */
export function AgentDetailsDrawer({ agentId, onClose }: { agentId: string; onClose: () => void }) {
  const [open, setOpen] = useState(true);
  const [revoking, setRevoking] = useState(false);
  const title = useRef<HTMLHeadingElement>(null);
  const details = useQuery(agentQuery(agentId));
  const connections = useQuery(connectionsQuery);
  const agent = details.data?.agent;

  return (
    <Sheet
      open={open}
      onOpenChange={setOpen}
      onOpenChangeComplete={(next) => {
        if (!next) onClose();
      }}
    >
      <SheetContent
        side="right"
        showCloseButton={false}
        className="right-0 left-auto gap-2.5 overflow-hidden bg-background py-px shadow-none data-[side=right]:w-full data-[side=right]:sm:max-w-[685px]"
        overlayClassName="bg-transparent supports-backdrop-filter:backdrop-blur-none"
        initialFocus={title}
        finalFocus={() =>
          document.getElementById(`agent-link-${agentId}`) ?? document.getElementById("new-agent")
        }
      >
        <SheetHeader className="shrink-0 flex-row items-start gap-4 px-6 py-2">
          <div className="flex min-w-0 flex-1 flex-col gap-3">
            <div>
              <SheetTitle
                ref={title}
                tabIndex={-1}
                className="break-words text-lg leading-7 outline-none"
              >
                {agent?.name ?? "Agent details"}
              </SheetTitle>
              <SheetDescription>Harness, connections, working set and history.</SheetDescription>
            </div>
            {agent ? (
              <div className="flex items-center gap-1">
                <StatusChip chip={agentStatusChip(agent)} />
              </div>
            ) : null}
          </div>
          <SheetClose render={<Button variant="ghost" size="icon" aria-label="Close" />}>
            <CloseIcon />
            <span className="sr-only">Close</span>
          </SheetClose>
        </SheetHeader>
        {/* The scrollport is a block; its auto-height column never shrinks the detail cards. */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          <PageContainer size="small" className="mx-0 gap-4 pt-0">
            {details.isPending ? (
              <DetailsLoading />
            ) : details.isError ? (
              <RetryNotice
                error={details.error}
                message="Could not load this agent."
                onRetry={() => void details.refetch()}
                retrying={details.isFetching}
              />
            ) : agent ? (
              <>
                <AgentDetailsSection
                  title="Details"
                  description={
                    agent.connectedVia
                      ? "The harness recorded when this agent connected to Graft."
                      : "Graft has not recorded which harness uses this agent's token."
                  }
                >
                  <dl className="grid grid-cols-2 gap-4 text-sm">
                    <div>
                      <dt className="text-muted-foreground">Harness</dt>
                      <dd className="break-words">
                        {agent.connectedVia?.clientName ?? "Not recorded"}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Token</dt>
                      <dd>
                        {agent.tokenPrefix ? (
                          <code className="font-mono text-xs">{agent.tokenPrefix}…</code>
                        ) : (
                          "OAuth"
                        )}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Created</dt>
                      <dd>
                        <Time iso={agent.createdAt} />
                      </dd>
                    </div>
                    {agent.revokedAt ? (
                      <div>
                        <dt className="text-muted-foreground">Revoked</dt>
                        <dd>
                          <Time iso={agent.revokedAt} />
                        </dd>
                      </div>
                    ) : null}
                    {agent.archivedAt ? (
                      <div>
                        <dt className="text-muted-foreground">Archived</dt>
                        <dd>
                          <Time iso={agent.archivedAt} />
                        </dd>
                      </div>
                    ) : null}
                  </dl>
                </AgentDetailsSection>
                {connections.isPending ? (
                  <DetailsLoading />
                ) : connections.isError ? (
                  <RetryNotice
                    error={connections.error}
                    message="Could not load the connections."
                    onRetry={() => void connections.refetch()}
                    retrying={connections.isFetching}
                  />
                ) : (
                  <ScopeEditor
                    key={`${agent.scopeMode}:${details.data.connectionIds.join(",")}`}
                    agent={agent}
                    connectionIds={details.data.connectionIds}
                    connections={connections.data.connections}
                  />
                )}
                <LimitsForm
                  key={`${agent.name}:${agent.workingSetCap}:${agent.idleWindowDays}`}
                  agent={agent}
                />
                <WorkingSetTable agent={agent} />
                <ApprovalsCard agent={agent} />
                <WorkingSetHistory agentId={agent.id} />
                {agent.revokedAt ? null : (
                  <>
                    <HarnessSnippet agent={agent} />
                    <div className="flex justify-end">
                      <Button variant="destructive" onClick={() => setRevoking(true)}>
                        {agent.tokenPrefix === null ? "Revoke agent" : "Revoke token"}
                      </Button>
                    </div>
                  </>
                )}
                <RevokeAgentDialog agent={agent} open={revoking} onOpenChange={setRevoking} />
              </>
            ) : null}
          </PageContainer>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function DetailsLoading() {
  return (
    <div role="status" className="flex flex-col gap-4">
      <span className="sr-only">Loading details</span>
      <Skeleton className="h-20 w-full" />
      <Skeleton className="h-40 w-full" />
    </div>
  );
}
