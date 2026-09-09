import { Time } from "@/components/time";
import { ToolAnnotations } from "@/components/tool-annotations";
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
import type { Agent, WorkingSetEntry } from "@/lib/agent-queries";
import { count } from "@/lib/format";

const PROMOTED_BY: Record<WorkingSetEntry["promotedBy"], string> = {
  agent: "the agent",
  publish: "a publish",
  rule: "the rule",
};

/**
 * The working set as the harness sees it (ADR 0003): exactly these tools are in the agent's MCP
 * list beside the meta-tools. "Last used" is the contraction rule's clock (ADR 0009).
 */
export function WorkingSetTable({
  agent,
  entries,
}: {
  agent: Agent;
  entries: readonly WorkingSetEntry[];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Working set
          <Badge variant="secondary">
            {entries.length} of {agent.workingSetCap}
          </Badge>
        </CardTitle>
        <CardDescription>
          The authored tools currently promoted for this agent — its MCP tool list, beside the
          meta-tools. Idle window {count(agent.idleWindowDays, "day")}.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {entries.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            Nothing is promoted. A tool arrives here when the agent promotes one it found with{" "}
            <code className="font-mono">find_tool</code>, or when it publishes one.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Tool</TableHead>
                <TableHead>Asks</TableHead>
                <TableHead>Promoted by</TableHead>
                <TableHead>Promoted</TableHead>
                <TableHead>Last used</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map((entry) => (
                <TableRow key={entry.toolId}>
                  <TableCell>
                    <div className="flex flex-col">
                      <code className="font-mono text-xs">
                        {entry.tool.vendor}__{entry.tool.name}
                      </code>
                      <span className="max-w-md truncate text-muted-foreground text-xs">
                        {entry.tool.description}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <ToolAnnotations
                      readOnly={entry.tool.readOnly}
                      destructive={entry.tool.destructive}
                    />
                  </TableCell>
                  <TableCell>{PROMOTED_BY[entry.promotedBy]}</TableCell>
                  <TableCell>
                    <Time iso={entry.promotedAt} />
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {entry.lastUsedAt ? <Time iso={entry.lastUsedAt} /> : "never"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
