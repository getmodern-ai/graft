import { StatusChip } from "@/components/status-chip";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Item, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "@/components/ui/item";
import type { Connection } from "@/lib/connection-queries";
import { CONNECTION_STATUS_CHIP } from "@/lib/status-chips";

/**
 * The scope as a set of the person's connections (CONTEXT.md, *Scope*): every connection listed,
 * the agent's ticked. A revoked connection stays in the list — it is still the person's, and a tool
 * bound to its vendor re-asks after reconnection (ADR 0007) — and says so.
 *
 * Each connection is an `Item` in its outline frame: a checkbox for the media, the name and its
 * chips for the title, the primary host for the description. A `<ul>` of `<li>` items rather than
 * the primitive's `ItemGroup`, which is a `div[role=list]` and would want a `listitem` role on
 * each child that the real elements carry for free — the group's only other contribution, its
 * 10px gap for `size="sm"`, is one class. The name is the checkbox's label; the checkbox itself is
 * a button plus a hidden input, so wrapping the whole item in a `<label>` would give one label two
 * controls.
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
        No connections yet. Once you add a connection, you can select it here.
      </p>
    );
  }

  return (
    <ul className="flex flex-col gap-2.5">
      {connections.map((connection) => {
        const id = `scope-${connection.id}`;
        return (
          <Item key={connection.id} variant="outline" size="sm" render={<li />}>
            <ItemMedia>
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
            </ItemMedia>
            <ItemContent>
              <ItemTitle>
                <label htmlFor={id} className="cursor-pointer">
                  {connection.displayName}
                </label>
                <Badge variant="outline">{connection.vendor}</Badge>
                {connection.revokedAt ? <StatusChip chip={CONNECTION_STATUS_CHIP.revoked} /> : null}
              </ItemTitle>
              <ItemDescription className="truncate">{connection.primaryHost}</ItemDescription>
            </ItemContent>
          </Item>
        );
      })}
    </ul>
  );
}
