import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import type { Connection } from "@/lib/connection-queries";

/**
 * The scope as a set of the person's connections (CONTEXT.md, *Scope*): every connection listed,
 * the agent's ticked. A revoked connection stays in the list — it is still the person's, and a tool
 * bound to its vendor re-asks after reconnection (ADR 0007) — and says so.
 */
export function ConnectionPicker({
  connections,
  selected,
  onChange,
  disabled,
}: {
  connections: readonly Connection[];
  selected: ReadonlySet<string>;
  onChange: (next: Set<string>) => void;
  disabled?: boolean;
}) {
  if (connections.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        No connections yet. An agent proposes one and you enter its secret here; until then the
        scope is empty and the agent can only author against nothing.
      </p>
    );
  }

  return (
    <ul className="flex flex-col divide-y rounded-md border">
      {connections.map((connection) => {
        const id = `scope-${connection.id}`;
        return (
          <li key={connection.id} className="flex items-center gap-3 px-3 py-2">
            <Checkbox
              id={id}
              disabled={disabled}
              checked={selected.has(connection.id)}
              onCheckedChange={(checked) => {
                const next = new Set(selected);
                if (checked) next.add(connection.id);
                else next.delete(connection.id);
                onChange(next);
              }}
            />
            <label htmlFor={id} className="flex min-w-0 flex-1 cursor-pointer flex-col text-sm">
              <span className="flex items-center gap-2">
                <span className="font-medium">{connection.displayName}</span>
                <Badge variant="outline">{connection.vendor}</Badge>
                {connection.revokedAt ? <Badge variant="destructive">revoked</Badge> : null}
              </span>
              <span className="truncate text-muted-foreground text-xs">
                {connection.primaryHost}
              </span>
            </label>
          </li>
        );
      })}
    </ul>
  );
}
