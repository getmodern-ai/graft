import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { RetryNotice } from "@/components/retry-notice";
import { StatusChip } from "@/components/status-chip";
import { TableBodyNote, TableLoadingRows } from "@/components/table-body-states";
import { Time } from "@/components/time";
import { ToolAnnotations } from "@/components/tool-annotations";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DataTable, DataTableRow } from "@/components/ui/data-table";
import { Switch } from "@/components/ui/switch";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { Agent } from "@/lib/agent-queries";
import {
  type Approval,
  approvalKeys,
  approvalsQuery,
  relaxApproval,
  withdrawApproval,
} from "@/lib/approval-queries";
import { toolsQuery } from "@/lib/connection-queries";
import { APPROVAL_DECISION_CHIP } from "@/lib/status-chips";

const COLUMNS = 5;

/**
 * The agent's standing approvals (ADR 0008): what the person has said about each tool, per agent.
 * The relax switch lifts a destructive tool's per-call ask — and cannot be switched back except by
 * withdrawing, which is the server's rule (`relaxDestructiveApproval` has no inverse; `revokeApproval`
 * does): withdrawn, the tool asks again on its next call, which is also the one way back from a no.
 *
 * Two reads, both the card's own for the reason `working-set-table.tsx` gives: the approvals, and
 * the toolbox that names them — an approval carries a tool id, and the name and annotations beside
 * it are the toolbox row's. The table waits for both; a row with an id where a name should be is
 * not a state worth painting first.
 *
 * Withdraw stays a visible button in its own column rather than going behind a row menu: it is the
 * row's one action, and a menu of one item is a click for nothing. The column's header is for a
 * screen reader alone (Cando's `connections-table.tsx`). Below `md` the decided-at column steps
 * out; the answer and the switch keep their room.
 */
export function ApprovalsCard({ agent }: { agent: Agent }) {
  const queryClient = useQueryClient();
  const approvals = useQuery(approvalsQuery(agent.id));
  const toolbox = useQuery(toolsQuery);
  const toolsById = new Map((toolbox.data?.tools ?? []).map((tool) => [tool.id, tool]));
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: approvalKeys.ofAgent(agent.id) });

  const relax = useMutation({
    mutationFn: (toolId: string) => relaxApproval(agent.id, toolId),
    onSuccess: async () => {
      await invalidate();
      toast.success("Relaxed", { description: "Its next calls pass without asking." });
    },
  });
  const withdraw = useMutation({
    mutationFn: (toolId: string) => withdrawApproval(agent.id, toolId),
    onSuccess: async () => {
      await invalidate();
      toast.success("Withdrawn", { description: "The tool asks again on its next call." });
    },
  });
  const busy = relax.isPending || withdraw.isPending || agent.revokedAt !== null;

  const isPending = approvals.isPending || toolbox.isPending;
  const isError = approvals.isError || toolbox.isError;
  const rows: readonly Approval[] = approvals.data?.approvals ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Approvals</CardTitle>
        <CardDescription>
          Your standing answers for this agent, per tool. Reads never ask; a write asks once and the
          answer holds; a destructive tool asks every call until relaxed here or in the ask itself.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <DataTable layout="grid">
          <TableHeader>
            <TableRow>
              <TableHead>Tool</TableHead>
              <TableHead className="w-20 md:w-24">Answer</TableHead>
              <TableHead className="hidden md:table-cell md:w-36">Decided</TableHead>
              <TableHead className="w-24 md:w-36">Asks every call</TableHead>
              <TableHead className="w-22 md:w-28">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isPending ? (
              <TableLoadingRows colSpan={COLUMNS} />
            ) : isError ? (
              <TableBodyNote colSpan={COLUMNS}>
                <RetryNotice
                  error={approvals.error ?? toolbox.error}
                  message="Could not load the approvals."
                  onRetry={() => {
                    void approvals.refetch();
                    void toolbox.refetch();
                  }}
                  retrying={approvals.isFetching || toolbox.isFetching}
                />
              </TableBodyNote>
            ) : rows.length === 0 ? (
              <TableBodyNote colSpan={COLUMNS}>
                Nothing answered yet — the first write this agent runs will ask.
              </TableBodyNote>
            ) : (
              rows.map((approval) => {
                const tool = toolsById.get(approval.toolId);
                const name = tool ? `${tool.vendor}__${tool.name}` : approval.toolId;
                return (
                  <DataTableRow key={approval.toolId}>
                    <TableCell className="truncate">
                      <span className="flex min-w-0 items-center gap-2">
                        <code className="truncate font-mono text-xs" title={name}>
                          {name}
                        </code>
                        {tool ? (
                          <ToolAnnotations
                            readOnly={tool.readOnly}
                            destructive={tool.destructive}
                          />
                        ) : null}
                      </span>
                    </TableCell>
                    <TableCell>
                      <StatusChip chip={APPROVAL_DECISION_CHIP[approval.decision]} />
                    </TableCell>
                    <TableCell className="hidden truncate text-muted-foreground md:table-cell">
                      <Time iso={approval.decidedAt} />
                    </TableCell>
                    <TableCell>
                      {tool?.destructive ? (
                        <span className="flex items-center gap-2">
                          <Switch
                            checked={!approval.perCallRelaxed}
                            disabled={
                              busy || approval.perCallRelaxed || approval.decision !== "allow"
                            }
                            onCheckedChange={(checked) => {
                              if (!checked) relax.mutate(approval.toolId);
                            }}
                            aria-label={`Ask on every call of ${name}`}
                          />
                          <span className="text-muted-foreground text-xs">
                            {approval.perCallRelaxed ? "Relaxed" : "Yes"}
                          </span>
                        </span>
                      ) : (
                        <span className="text-muted-foreground text-xs">
                          {tool?.readOnly ? "Never" : "Once"}
                        </span>
                      )}
                    </TableCell>
                    {/* `py-0`: a 28px button in `TableCell`'s `p-2` is 44px, past the row's 40. */}
                    <TableCell className="py-0 text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() => withdraw.mutate(approval.toolId)}
                      >
                        Withdraw
                      </Button>
                    </TableCell>
                  </DataTableRow>
                );
              })
            )}
          </TableBody>
        </DataTable>
      </CardContent>
    </Card>
  );
}
