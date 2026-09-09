import { Time } from "@/components/time";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { WorkingSetChange } from "@/lib/agent-queries";

/**
 * Why the working set changed, in the person's words (ADR 0009: expansion has an author, and
 * contraction now has two — the agent, and the rule). The cause is the record's own word; this is
 * the sentence beside it.
 */
const CAUSE: Record<WorkingSetChange["cause"], string> = {
  agent: "the agent asked",
  publish: "published by the agent",
  idle: "unused past the idle window",
  cap: "over the working-set cap",
  revoke: "its connection was revoked",
};

/** Every promotion and demotion, newest first — tool-list churn is a first-class event (ADR 0003). */
export function WorkingSetHistory({ changes }: { changes: readonly WorkingSetChange[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>History</CardTitle>
        <CardDescription>
          Every promotion and demotion with its cause, newest first. A demoted tool is still in the
          toolbox and one <code className="font-mono">find_tool</code> away.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {changes.length === 0 ? (
          <p className="text-muted-foreground text-sm">No changes yet.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>Change</TableHead>
                <TableHead>Tool</TableHead>
                <TableHead>Cause</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {changes.map((change) => (
                <TableRow key={change.id}>
                  <TableCell>
                    <Time iso={change.createdAt} />
                  </TableCell>
                  <TableCell>
                    <Badge variant={change.change === "promote" ? "default" : "outline"}>
                      {change.change === "promote" ? "promoted" : "demoted"}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {change.tool ? (
                      <code className="font-mono text-xs">
                        {change.tool.vendor}__{change.tool.name}
                      </code>
                    ) : (
                      <span className="text-muted-foreground">a tool no longer in the toolbox</span>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{CAUSE[change.cause]}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
