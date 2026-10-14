import { useMutation, useQueries, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type * as React from "react";
import { useState } from "react";
import { toast } from "sonner";

import { HarnessMark } from "@/components/marks";
import { RetryNotice } from "@/components/retry-notice";
import { StatusChip } from "@/components/status-chip";
import { TableBodyNote, TableLoadingRows } from "@/components/table-body-states";
import { Time } from "@/components/time";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DataTable, DataTableRow } from "@/components/ui/data-table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { agentAccessSummary } from "@/lib/agent-access";
import { agentKeys, grantConnectionToAgent, removeConnectionFromAgent } from "@/lib/agent-queries";
import {
  approvalKeys,
  setApprovalAskEveryCall,
  setApprovalDecision,
  setVendorApprovalDestructive,
  withdrawApproval,
  withdrawBuildApproval,
  withdrawVendorApproval,
} from "@/lib/approval-queries";
import { connectionAccessQuery, connectionKeys } from "@/lib/connection-queries";
import {
  type AgentConnectionSwitch,
  type IntegrationAgentRow,
  type IntegrationAnswer,
  integrationAgentRows,
  integrationAnswers,
  type TabConnection,
  type ToolAnswerChoice,
  toolAnswerChoice,
  toolAnswerWrites,
} from "@/lib/integration-agents";
import { harnessMark } from "@/lib/marks";
import { pendingKeys } from "@/lib/pending-action-queries";
import { turnConnection } from "@/lib/scope-toggles";

const AGENT_COLUMNS = 4;
const ANSWER_COLUMNS = 5;

/**
 * The integration page's Agents tab (GRA-318; Figma 2094:10189, the Change menus 2112:14420 and
 * 2112:14859): which agents can use the integration and what each runs without asking, then every
 * answer the person has given them for it, each with a Change menu offering only what a route
 * exists for (ADR 0008 as amended 2026-10-14). Rows come from GRA-296's access read, one per live
 * connection, folded by `lib/integration-agents.ts`; the read lists active agents only, so a
 * revoked agent never appears. With several connections the Access column holds a switch per
 * connection, since scope is per connection (ADR 0007).
 */
export function AgentsTab({
  vendor,
  integrationName,
  connections,
}: {
  vendor: string;
  integrationName: string;
  /** The vendor's live connections; a revoked one is no agent's to use. */
  connections: readonly TabConnection[];
}) {
  const reads = useQueries({
    queries: connections.map((connection) => connectionAccessQuery(connection.id)),
  });
  const isPending = reads.some((read) => read.isPending);
  const failed = reads.find((read) => read.isError);
  const retry = {
    error: failed?.error,
    retrying: reads.some((read) => read.isFetching),
    onRetry: () => {
      for (const read of reads) if (read.isError) void read.refetch();
    },
  };
  const rows = integrationAgentRows(
    connections,
    reads.flatMap((read) => (read.data ? [read.data.access] : [])),
  );
  const answers = integrationAnswers(rows, integrationName, connections.length > 1);

  if (connections.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        No connection to {integrationName} is live, so no agent can use it. Reconnect it from the
        Connection tab.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-10">
      <TabSection
        title={`Agents that can use ${integrationName}`}
        description={`Turn one off and it can't see or run any ${integrationName} tool.`}
      >
        <Card className="gap-0 py-0">
          <DataTable layout="grid">
            <TableHeader>
              <TableRow>
                <TableHead className="w-40 md:w-60">Agent</TableHead>
                <TableHead className="hidden md:table-cell">
                  What it can run without asking
                </TableHead>
                <TableHead className="hidden md:table-cell md:w-32">Last used</TableHead>
                <TableHead className="text-right">Access</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isPending ? (
                <TableLoadingRows colSpan={AGENT_COLUMNS} />
              ) : failed ? (
                <TableBodyNote colSpan={AGENT_COLUMNS}>
                  <RetryNotice message="Could not load your agents." {...retry} />
                </TableBodyNote>
              ) : rows.length === 0 ? (
                <TableBodyNote colSpan={AGENT_COLUMNS}>
                  No agents yet. Connect one from the Agents screen.
                </TableBodyNote>
              ) : (
                rows.map((row) => (
                  <AgentRow
                    key={row.agent.id}
                    row={row}
                    integrationName={integrationName}
                    several={connections.length > 1}
                  />
                ))
              )}
            </TableBody>
          </DataTable>
        </Card>
      </TabSection>

      <TabSection
        title={`Your answers for ${integrationName}`}
        description={`Every yes or no you've given an agent for a ${integrationName} tool. Change or forget any of them here.`}
      >
        <Card className="gap-0 py-0">
          <DataTable layout="grid">
            <TableHeader>
              <TableRow>
                <TableHead>What</TableHead>
                <TableHead className="hidden md:table-cell md:w-36">Agent</TableHead>
                <TableHead className="w-32 md:w-36">Your answer</TableHead>
                <TableHead className="hidden md:table-cell md:w-36">When</TableHead>
                <TableHead className="w-20 md:w-22">
                  <span className="sr-only">Change</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isPending ? (
                <TableLoadingRows colSpan={ANSWER_COLUMNS} />
              ) : failed ? (
                <TableBodyNote colSpan={ANSWER_COLUMNS}>
                  <RetryNotice message="Could not load your answers." {...retry} />
                </TableBodyNote>
              ) : answers.length === 0 ? (
                <TableBodyNote colSpan={ANSWER_COLUMNS}>
                  None yet. An agent asks the first time it needs a {integrationName} tool that
                  changes data.
                </TableBodyNote>
              ) : (
                answers.map((answer) => (
                  <AnswerRow
                    key={answer.key}
                    answer={answer}
                    vendor={vendor}
                    integrationName={integrationName}
                    connectionIds={connections.map((connection) => connection.id)}
                  />
                ))
              )}
            </TableBody>
          </DataTable>
        </Card>
      </TabSection>
    </div>
  );
}

function TabSection({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-col gap-0.5">
        <h2 className="font-medium text-lg">{title}</h2>
        <p className="text-muted-foreground text-sm">{description}</p>
      </div>
      {children}
    </section>
  );
}

function AgentRow({
  row,
  integrationName,
  several,
}: {
  row: IntegrationAgentRow;
  integrationName: string;
  several: boolean;
}) {
  const { summary, detail } = agentAccessSummary(row.access, integrationName);
  const client = row.agent.connectedViaClientName;
  return (
    <DataTableRow>
      <TableCell className="py-2">
        <div className="flex min-w-0 items-center gap-3">
          <HarnessMark mark={harnessMark(client)} tile="outline" tileSize={32} size={18} />
          <div className="flex min-w-0 flex-col">
            <Link
              to="/agents/$agentId"
              params={{ agentId: row.agent.id }}
              className="truncate rounded-sm underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              {row.agent.name}
            </Link>
            <span className="truncate text-muted-foreground text-xs">
              {client ?? "Not recorded"}
            </span>
            {/* Below `md` the summary column steps out, and its line follows the name. */}
            <span className="truncate text-muted-foreground text-xs md:hidden">{summary}</span>
          </div>
        </div>
      </TableCell>
      <TableCell className="hidden whitespace-normal py-2 md:table-cell">
        <div className={row.access.inScope ? undefined : "text-muted-foreground"}>{summary}</div>
        {detail ? <div className="text-muted-foreground text-xs">{detail}</div> : null}
      </TableCell>
      <TableCell className="hidden truncate text-muted-foreground md:table-cell">
        {row.lastUsedAt ? <Time iso={row.lastUsedAt} /> : "Never"}
      </TableCell>
      <TableCell className="py-2">
        <div className="flex flex-col items-end gap-1.5">
          {row.switches.map((entry) => (
            <AccessSwitch
              key={entry.connectionId}
              row={row}
              entry={entry}
              integrationName={integrationName}
              labelled={several}
            />
          ))}
        </div>
      </TableCell>
    </DataTableRow>
  );
}

/**
 * One connection on or off for one agent (GRA-294). Turning it off for an agent on `all` narrows
 * the agent to `listed` (`turnConnection`'s `stopsLater`), so integrations connected later stop
 * reaching it; that is asked first, in an `AlertDialog`, since nothing on this page turns it back.
 */
function AccessSwitch({
  row,
  entry,
  integrationName,
  labelled,
}: {
  row: IntegrationAgentRow;
  entry: AgentConnectionSwitch;
  integrationName: string;
  labelled: boolean;
}) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const agent = row.agent;
  const state = {
    mode: agent.scopeMode,
    connectionIds: new Set(entry.inScope ? [entry.connectionId] : []),
  };
  const toggle = useMutation({
    mutationFn: async (on: boolean) => {
      const { write } = turnConnection(state, entry.connectionId, on);
      if (write.kind === "grant") return grantConnectionToAgent(write.connectionId, agent.id);
      if (write.kind === "remove") return removeConnectionFromAgent(write.connectionId, agent.id);
      return null;
    },
    onSuccess: async (answer, on) => {
      setConfirming(false);
      // The access read and the integrations row's agent count are both under the connections key.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: connectionKeys.all }),
        queryClient.invalidateQueries({ queryKey: agentKeys.one(agent.id) }),
        queryClient.invalidateQueries({ queryKey: agentKeys.all }),
      ]);
      if (!answer) return;
      toast.success(on ? `${agent.name} can use ${entry.displayName}` : "Turned off", {
        description: on
          ? "In effect on its next call."
          : answer.materialised
            ? `${agent.name} can't use ${entry.displayName}, and no longer gets integrations you connect later.`
            : `${agent.name} can't use ${entry.displayName}.`,
      });
    },
  });
  const name = labelled ? entry.displayName : integrationName;

  const turn = (on: boolean) => {
    if (!on && turnConnection(state, entry.connectionId, false).stopsLater) {
      setConfirming(true);
      return;
    }
    toggle.mutate(on);
  };

  return (
    <>
      <span className="flex items-center gap-2">
        {labelled ? (
          <span className="truncate text-muted-foreground text-xs">{entry.displayName}</span>
        ) : null}
        <Switch
          checked={entry.inScope}
          disabled={toggle.isPending}
          onCheckedChange={turn}
          aria-label={`Let ${agent.name} use ${name}`}
        />
      </span>
      <AlertDialog
        open={confirming}
        onOpenChange={(next) => {
          if (next || !toggle.isPending) setConfirming(next);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Turn off {name} for {agent.name}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {agent.name} gets every integration you connect today, and every one you connect
              later. Turning off {name} keeps the others it has now, but integrations you connect
              later will no longer reach it. You can give it those again from its page.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={toggle.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={toggle.isPending}
              onClick={() => toggle.mutate(false)}
            >
              {toggle.isPending ? "Turning off…" : "Turn off"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function AnswerRow({
  answer,
  vendor,
  integrationName,
  connectionIds,
}: {
  answer: IntegrationAnswer;
  vendor: string;
  integrationName: string;
  connectionIds: readonly string[];
}) {
  return (
    <DataTableRow>
      <TableCell className="py-2">
        <div className="truncate">{answer.what}</div>
        {answer.detail ? (
          <div className="truncate text-muted-foreground text-xs">{answer.detail}</div>
        ) : null}
        <div className="truncate text-muted-foreground text-xs md:hidden">{answer.agent.name}</div>
      </TableCell>
      <TableCell className="hidden truncate md:table-cell">{answer.agent.name}</TableCell>
      <TableCell>
        <StatusChip chip={answer.chip} />
      </TableCell>
      <TableCell className="hidden truncate text-muted-foreground md:table-cell">
        <Time iso={answer.at} />
      </TableCell>
      {/* `py-0`: a 28px button in `TableCell`'s `p-2` is 44px, past the row's 40. */}
      <TableCell className="py-0 text-right">
        {answer.change.kind === "none" ? null : (
          <ChangeMenu
            answer={answer}
            vendor={vendor}
            integrationName={integrationName}
            connectionIds={connectionIds}
          />
        )}
      </TableCell>
    </DataTableRow>
  );
}

/** A menu entry: the choice, and what it does in a line under it, as the Figma menus draw them. */
function Choice({
  title,
  detail,
  destructive = false,
}: {
  title: string;
  detail: string;
  /** The choice widens what runs without asking to tools that delete. */
  destructive?: boolean;
}) {
  return (
    <span className="flex flex-col gap-0.5 py-0.5">
      <span className={destructive ? "text-destructive" : undefined}>{title}</span>
      <span className="whitespace-normal text-muted-foreground text-xs">{detail}</span>
    </span>
  );
}

type ChangeAction =
  | { kind: "tool"; target: Exclude<ToolAnswerChoice, "stale"> }
  | { kind: "forget_tool"; runsUnasked: boolean }
  | { kind: "vendor_destructive"; on: boolean }
  | { kind: "remove_vendor" }
  | { kind: "withdraw_build" };

/**
 * The Change menu for one answer, by its kind (GRA-318's table): a tool's answer is Always allow,
 * Ask every time and Deny (GRA-302's `PUT`, then the ask-every-call route as
 * `toolAnswerWrites` orders them) and Forget; *Every <integration> tool* is whether ones that
 * delete are included (GRA-302's `PATCH`) and Remove; a build approval is Withdraw (GRA-295).
 */
function ChangeMenu({
  answer,
  vendor,
  integrationName,
  connectionIds,
}: {
  answer: IntegrationAnswer;
  vendor: string;
  integrationName: string;
  connectionIds: readonly string[];
}) {
  const queryClient = useQueryClient();
  const agent = answer.agent;
  const [open, setOpen] = useState(false);
  const change = useMutation({
    mutationFn: async (action: ChangeAction) => {
      const { change: kind } = answer;
      if (kind.kind === "tool") {
        const toolId = kind.approval.tool.id;
        if (action.kind === "forget_tool") return withdrawApproval(agent.id, toolId);
        if (action.kind !== "tool") return;
        for (const write of toolAnswerWrites(kind.approval, action.target)) {
          if (write.kind === "decision") {
            await setApprovalDecision(agent.id, toolId, write.decision);
          } else {
            await setApprovalAskEveryCall(agent.id, toolId, write.on);
          }
        }
        return;
      }
      if (kind.kind === "vendor") {
        if (action.kind === "remove_vendor") return withdrawVendorApproval(agent.id, vendor);
        if (action.kind === "vendor_destructive") {
          return setVendorApprovalDestructive(agent.id, vendor, action.on);
        }
        return;
      }
      if (kind.kind === "build" && action.kind === "withdraw_build") {
        return withdrawBuildApproval(agent.id, kind.connectionId);
      }
    },
    onSettled: () =>
      Promise.all([
        ...connectionIds.map((id) =>
          queryClient.invalidateQueries({ queryKey: connectionKeys.access(id) }),
        ),
        queryClient.invalidateQueries({ queryKey: approvalKeys.ofAgent(agent.id) }),
        queryClient.invalidateQueries({ queryKey: approvalKeys.vendorsOfAgent(agent.id) }),
        queryClient.invalidateQueries({ queryKey: approvalKeys.builds }),
        // An answer set outright answers the tool's open asks (GRA-302), so the Requests list and
        // the sidebar's count refresh. `exact`: a handoff link's own read is never re-read.
        queryClient.invalidateQueries({ queryKey: pendingKeys.all, exact: true }),
      ]),
    onSuccess: (_result, action) => {
      toast.success(changedToast(action, agent.name, integrationName));
    },
  });

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            disabled={change.isPending}
            aria-label={`Change ${agent.name}'s answer for ${answer.what}`}
          />
        }
      >
        Change
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <ChangeMenuItems
          answer={answer}
          integrationName={integrationName}
          onAction={(action) => {
            // Closed here rather than by the item: a radio item keeps its menu open by default.
            setOpen(false);
            change.mutate(action);
          }}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ChangeMenuItems({
  answer,
  integrationName,
  onAction,
}: {
  answer: IntegrationAnswer;
  integrationName: string;
  onAction: (action: ChangeAction) => void;
}) {
  const agent = answer.agent.name;
  const heading = `${agent} · ${answer.what}`;
  switch (answer.change.kind) {
    case "tool": {
      const current = toolAnswerChoice(answer.change.approval);
      const runsUnasked = answer.change.forgetRunsUnasked;
      return (
        <>
          <DropdownMenuRadioGroup
            value={current}
            onValueChange={(value) => {
              if (value === "always" || value === "ask" || value === "deny") {
                onAction({ kind: "tool", target: value });
              }
            }}
          >
            <DropdownMenuLabel>{heading}</DropdownMenuLabel>
            <DropdownMenuRadioItem value="always">
              <Choice title="Always allow" detail="Won't ask again for this tool." />
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="ask">
              <Choice title="Ask every time" detail="Asks you before each time it runs." />
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="deny">
              <Choice title="Deny" detail={`${agent} can't use this tool.`} />
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => onAction({ kind: "forget_tool", runsUnasked })}>
            <Choice
              title="Forget this answer"
              detail={
                runsUnasked
                  ? `Every ${integrationName} tool covers it then, so ${agent} runs it without asking.`
                  : `${agent} asks you again the next time it needs it.`
              }
            />
          </DropdownMenuItem>
        </>
      );
    }
    case "vendor":
      return (
        <>
          <DropdownMenuRadioGroup
            value={answer.change.includesDestructive ? "including" : "except"}
            onValueChange={(value) => {
              if (value === "including" || value === "except") {
                onAction({ kind: "vendor_destructive", on: value === "including" });
              }
            }}
          >
            <DropdownMenuLabel>{heading}</DropdownMenuLabel>
            <DropdownMenuRadioItem value="except">
              <Choice
                title="Except ones that delete"
                detail="Tools that can delete ask first, unless you answered one on its own."
              />
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="including">
              <Choice
                destructive
                title="Including ones that delete"
                detail={`${agent} won't ask for anything in ${integrationName}, even deleting. A tool you denied or set to ask every time still does that.`}
              />
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => onAction({ kind: "remove_vendor" })}>
            <Choice
              title="Remove"
              detail={`Each ${integrationName} tool asks on its own again. Single answers you've given stay.`}
            />
          </DropdownMenuItem>
        </>
      );
    case "build":
      return (
        <DropdownMenuGroup>
          <DropdownMenuLabel>{heading}</DropdownMenuLabel>
          <DropdownMenuItem onClick={() => onAction({ kind: "withdraw_build" })}>
            <Choice
              title="Withdraw"
              detail={`${agent} asks you again before it builds a ${integrationName} tool.`}
            />
          </DropdownMenuItem>
        </DropdownMenuGroup>
      );
    case "none":
      return null;
  }
}

function changedToast(action: ChangeAction, agent: string, integrationName: string): string {
  switch (action.kind) {
    case "tool":
      return action.target === "always"
        ? `${agent} runs it without asking`
        : action.target === "ask"
          ? `${agent} asks every time`
          : `${agent} can't use it`;
    case "forget_tool":
      return action.runsUnasked
        ? `${agent} runs it under Every ${integrationName} tool`
        : `${agent} asks next time`;
    case "vendor_destructive":
      return action.on
        ? `${agent} no longer asks for ${integrationName} tools that delete, except ones you denied or set to ask every time`
        : `${integrationName} tools that delete ask ${agent} first, unless you answered one on its own`;
    case "remove_vendor":
      return `Each ${integrationName} tool asks ${agent} on its own again`;
    case "withdraw_build":
      return `${agent} asks before it builds a ${integrationName} tool`;
  }
}
