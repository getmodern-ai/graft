import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { RetryNotice } from "@/components/retry-notice";
import { TableBodyNote, TableLoadingRows } from "@/components/table-body-states";
import { Time } from "@/components/time";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DataTable, DataTableRow } from "@/components/ui/data-table";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { Agent } from "@/lib/agent-queries";
import {
  approvalKeys,
  type BuildApproval,
  buildApprovalsQuery,
  withdrawBuildApproval,
} from "@/lib/approval-queries";
import {
  buildApprovalConnectionName,
  buildApprovalTitle,
  buildApprovalWithdrawnSentence,
} from "@/lib/build-approval-copy";

const COLUMNS = 3;

/**
 * The agent's build approvals (ADR 0008 as amended 2026-09-18; GRA-295): each row is the person's
 * yes to `acquire` working against one connection, given on the build ask, a connection's card or
 * Setup's Build. Withdraw removes it, and the agent's next build against that connection asks
 * again; tools it already built keep their own answers in the cards above. Composed as
 * `integration-approvals-card.tsx` is: the card owns its read, the states are rows inside the body,
 * and Withdraw is the row's one visible action. Below `md` the granted-at column steps out.
 */
export function BuildApprovalsCard({ agent }: { agent: Agent }) {
  const queryClient = useQueryClient();
  const approvals = useQuery(buildApprovalsQuery(agent.id));

  const withdraw = useMutation({
    mutationFn: (row: BuildApproval) => withdrawBuildApproval(agent.id, row.connectionId),
    onSuccess: async (_result, row) => {
      await queryClient.invalidateQueries({ queryKey: approvalKeys.buildsOfAgent(agent.id) });
      toast.success("Withdrawn", { description: buildApprovalWithdrawnSentence(row) });
    },
  });
  const busy = withdraw.isPending || agent.revokedAt !== null;
  const rows: readonly BuildApproval[] = approvals.data?.buildApprovals ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Building allowed</CardTitle>
        <CardDescription>
          This agent builds its own tools for these integrations without asking first. Building
          reads your data there to check its work.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <DataTable layout="grid">
          <TableHeader>
            <TableRow>
              <TableHead>Integration</TableHead>
              <TableHead className="hidden md:table-cell md:w-36">Allowed</TableHead>
              <TableHead className="w-22 md:w-28">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {approvals.isPending ? (
              <TableLoadingRows colSpan={COLUMNS} />
            ) : approvals.isError ? (
              <TableBodyNote colSpan={COLUMNS}>
                <RetryNotice
                  error={approvals.error}
                  message="Could not load what this agent may build."
                  onRetry={() => void approvals.refetch()}
                  retrying={approvals.isFetching}
                />
              </TableBodyNote>
            ) : rows.length === 0 ? (
              <TableBodyNote colSpan={COLUMNS}>
                None yet. The agent asks before it builds its first tool for an integration.
              </TableBodyNote>
            ) : (
              rows.map((row) => {
                const title = buildApprovalTitle(row);
                const connectionName = buildApprovalConnectionName(row);
                return (
                  <DataTableRow key={row.connectionId}>
                    <TableCell className="truncate" title={row.displayName}>
                      {title}
                      {connectionName ? (
                        <span className="text-muted-foreground"> · {connectionName}</span>
                      ) : null}
                    </TableCell>
                    <TableCell className="hidden truncate text-muted-foreground md:table-cell">
                      <Time iso={row.grantedAt} />
                    </TableCell>
                    {/* `py-0`: a 28px button in `TableCell`'s `p-2` is 44px, past the row's 40. */}
                    <TableCell className="py-0 text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() => withdraw.mutate(row)}
                        aria-label={`Withdraw ${title}${connectionName ? `, ${connectionName}` : ""}`}
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
