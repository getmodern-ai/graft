import { useQuery } from "@tanstack/react-query";

import { Time } from "@/components/time";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { type ConnectionCall, connectionCallsQuery } from "@/lib/connection-queries";

const OUTCOME_VARIANT: Record<ConnectionCall["outcome"], "success" | "destructive" | "outline"> = {
  ok: "success",
  error: "destructive",
  refused: "outline",
};

/**
 * A connection's recent vendor calls — the ledger's lines for the vendor's tools and the connection's
 * own execute tool, across every agent (GRA-26). The proxy's wide events are not persisted, so what
 * is shown is the invocation the MCP server recorded, not the HTTP exchange; the route comment in
 * `apps/server/src/api.ts` records the gap.
 */
export function ConnectionCalls({ connectionId }: { connectionId: string }) {
  const { data, isPending } = useQuery(connectionCallsQuery(connectionId));

  if (isPending) {
    return <Skeleton className="h-16 w-full" />;
  }
  const calls = data?.calls ?? [];
  if (calls.length === 0) {
    return <p className="text-muted-foreground text-sm">No calls against this vendor yet.</p>;
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>When</TableHead>
          <TableHead>Agent</TableHead>
          <TableHead>Tool</TableHead>
          <TableHead>Outcome</TableHead>
          <TableHead className="text-right">Latency</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {calls.map((call) => (
          <TableRow key={call.id}>
            <TableCell>
              <Time iso={call.createdAt} />
            </TableCell>
            <TableCell>{call.agentName}</TableCell>
            <TableCell>
              <code className="font-mono text-xs">{call.toolName}</code>
              {call.dryRun ? (
                <Badge variant="outline" className="ml-2">
                  dry run
                </Badge>
              ) : null}
            </TableCell>
            <TableCell>
              <Badge variant={OUTCOME_VARIANT[call.outcome]}>{call.outcome}</Badge>
            </TableCell>
            <TableCell className="text-right text-muted-foreground">{call.latencyMs} ms</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
