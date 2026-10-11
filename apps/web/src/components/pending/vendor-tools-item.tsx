import {
  VENDOR_TOOLS_DESCRIPTION,
  vendorToolsLabel,
} from "@graft/core/approval/vendor-approval.rules";
import { Checkbox } from "@/components/ui/checkbox";
import { Item, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "@/components/ui/item";
import { Label } from "@/components/ui/label";

/**
 * The second line under the build approval on a connection confirmation (GRA-239; ADR 0008 as
 * amended 2026-10-09): on by default, it records the asking agent's standing approval for the
 * integration with the connection the page makes, destructive tools left out, so the integration's
 * writes run without an ask of their own. Both connection cards draw it under
 * `BuildApprovalItem`, in its shape; the words are `@graft/core`'s, which the ask card carries too.
 */
export function VendorToolsItem({
  id,
  integrationName,
  checked,
  onCheckedChange,
  disabled,
}: {
  id: string;
  /** The integration as the person reads it (`integrationNameFor`), never the vendor slug. */
  integrationName: string;
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
            {vendorToolsLabel(integrationName)}
          </Label>
        </ItemTitle>
        <ItemDescription className="line-clamp-none">{VENDOR_TOOLS_DESCRIPTION}</ItemDescription>
      </ItemContent>
    </Item>
  );
}
