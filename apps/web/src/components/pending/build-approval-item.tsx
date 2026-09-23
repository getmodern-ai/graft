import { Checkbox } from "@/components/ui/checkbox";
import { Item, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "@/components/ui/item";
import { Label } from "@/components/ui/label";

/**
 * The build approval offered on a connection confirmation (GRA-75; ADR 0008, amendment of
 * 2026-09-18): one control, on by default, that records `acquire`'s once-per-agent-per-connection
 * approval for the asking agent with the connection the page is about to make, so the agent's
 * first `acquire` needs no second link. Both connection cards draw it — the form's
 * (`connection-ask-card.tsx`) and the link provider's (`provider-link-ask-card.tsx`) — so the label
 * and the sentence are written once.
 *
 * Composed as the scope picker composes a connection (`connection-picker.tsx`): an `Item` in its
 * outline frame with the checkbox as its media, the label as its title and the consequence as its
 * description, the line clamps lifted as `tool-ask-card.tsx` lifts them for its switch — a sentence
 * and its consequence, not a row. No frame of its own.
 */
export function BuildApprovalItem({
  id,
  agentName,
  checked,
  onCheckedChange,
  disabled,
}: {
  id: string;
  /** The asking agent's name, so the label names who is being allowed. */
  agentName: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <Item variant="outline">
      <ItemMedia>
        <Checkbox
          id={id}
          checked={checked}
          disabled={disabled}
          onCheckedChange={(next) => onCheckedChange(next === true)}
        />
      </ItemMedia>
      <ItemContent>
        <ItemTitle className="line-clamp-none">
          <Label htmlFor={id} className="cursor-pointer">
            Also allow {agentName} to build tools against this connection
          </Label>
        </ItemTitle>
        <ItemDescription className="line-clamp-none">
          Code Graft's model writes for {agentName} will run against this connection until the
          agent's first real use, which asks you once: reads only, with every write previewed and
          never sent. Off, the agent's first build asks you with a link of its own.
        </ItemDescription>
      </ItemContent>
    </Item>
  );
}
