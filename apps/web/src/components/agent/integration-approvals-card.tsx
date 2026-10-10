import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { RetryNotice } from "@/components/retry-notice";
import { StatusChip } from "@/components/status-chip";
import { TableBodyNote, TableLoadingRows } from "@/components/table-body-states";
import { Time } from "@/components/time";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DataTable, DataTableRow } from "@/components/ui/data-table";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { Agent } from "@/lib/agent-queries";
import {
  approvalKeys,
  type VendorApproval,
  vendorApprovalsQuery,
  withdrawVendorApproval,
} from "@/lib/approval-queries";
import { connectionsQuery } from "@/lib/connection-queries";
import { VENDOR_APPROVAL_DESTRUCTIVE_CHIP } from "@/lib/status-chips";
import { integrationNameOfVendor } from "@/lib/tool-ask-copy";

const COLUMNS = 4;

/**
 * The agent's standing approvals per integration (ADR 0008 as amended 2026-10-09; GRA-237): each
 * row is a person's "Allow every <integration> tool for this agent", given on a tool's ask, with
 * whether destructive tools were included. Withdraw removes it, and the integration's tools ask
 * again, each once, unless a tool's own answer stands in the card above. Composed as
 * `approvals-card.tsx` is: the card owns its reads, the states are rows inside the body, and
 * Withdraw is the row's one visible action. The integration is named from the person's
 * connections (`integrationNameOfVendor`); below `md` the granted-at column steps out.
 */
export function IntegrationApprovalsCard({ agent }: { agent: Agent }) {
  const queryClient = useQueryClient();
  const approvals = useQuery(vendorApprovalsQuery(agent.id));
  const connections = useQuery(connectionsQuery);
  const named = connections.data?.connections ?? [];

  const withdraw = useMutation({
    mutationFn: (vendor: string) => withdrawVendorApproval(agent.id, vendor),
    onSuccess: async (_result, vendor) => {
      await queryClient.invalidateQueries({ queryKey: approvalKeys.vendorsOfAgent(agent.id) });
      toast.success("Withdrawn", {
        description: `${integrationNameOfVendor(vendor, named)} tools ask again, each once, unless a tool's own answer stands.`,
      });
    },
  });
  const busy = withdraw.isPending || agent.revokedAt !== null;

  const isPending = approvals.isPending || connections.isPending;
  const isError = approvals.isError || connections.isError;
  const rows: readonly VendorApproval[] = approvals.data?.vendorApprovals ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Integrations allowed</CardTitle>
        <CardDescription>
          Every tool of these integrations runs for this agent without asking. A tool you answered
          on its own, or set to ask every time, keeps that answer.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <DataTable layout="grid">
          <TableHeader>
            <TableRow>
              <TableHead>Integration</TableHead>
              <TableHead className="w-24 md:w-36">Destructive tools</TableHead>
              <TableHead className="hidden md:table-cell md:w-36">Allowed</TableHead>
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
                  error={approvals.error ?? connections.error}
                  message="Could not load the integrations allowed."
                  onRetry={() => {
                    void approvals.refetch();
                    void connections.refetch();
                  }}
                  retrying={approvals.isFetching || connections.isFetching}
                />
              </TableBodyNote>
            ) : rows.length === 0 ? (
              <TableBodyNote colSpan={COLUMNS}>
                None yet. A tool's ask offers to allow every tool of its integration at once.
              </TableBodyNote>
            ) : (
              rows.map((row) => {
                const name = integrationNameOfVendor(row.vendor, named);
                return (
                  <DataTableRow key={row.vendor}>
                    <TableCell className="truncate" title={row.vendor}>
                      {name}
                    </TableCell>
                    <TableCell>
                      <StatusChip
                        chip={
                          VENDOR_APPROVAL_DESTRUCTIVE_CHIP[
                            row.includesDestructive ? "included" : "excluded"
                          ]
                        }
                      />
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
                        onClick={() => withdraw.mutate(row.vendor)}
                        aria-label={`Withdraw ${name}`}
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
