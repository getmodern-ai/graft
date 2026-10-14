import { Badge } from "@/components/ui/badge";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
  FieldLegend,
  FieldSet,
  FieldTitle,
} from "@/components/ui/field";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";

/**
 * One choice among a few, each a sentence and its consequence: the handoff page's *Full access /
 * Ask me first* (`lib/access-choice.ts`) and a tool ask's *how much* (`lib/tool-allow-choice.ts`;
 * GRA-314). Composed as the system's choice card: a `FieldLabel` around a horizontal `Field`, the
 * radio as its control, the title (with *Recommended* where the option is) and the description as
 * its content; the label's own checked state draws the selected frame. No frame of its own.
 */
export function ChoiceCards<V extends string>({
  id,
  legend,
  options,
  value,
  onValueChange,
  disabled,
}: {
  id: string;
  legend: string;
  options: readonly { value: V; title: string; description: string; recommended: boolean }[];
  value: V;
  onValueChange: (value: V) => void;
  disabled?: boolean;
}) {
  return (
    <FieldSet className="gap-2">
      <FieldLegend variant="label" className="mb-0 font-normal text-muted-foreground">
        {legend}
      </FieldLegend>
      <RadioGroup
        value={value}
        onValueChange={(next) => onValueChange(next as V)}
        disabled={disabled}
      >
        {options.map((option) => (
          <FieldLabel key={option.value} htmlFor={`${id}-${option.value}`}>
            <Field orientation="horizontal" className="gap-3 px-3.5! py-3!">
              <RadioGroupItem value={option.value} id={`${id}-${option.value}`} />
              <FieldContent>
                <FieldTitle className="font-medium text-sm">
                  {option.title}
                  {option.recommended ? <Badge variant="secondary">Recommended</Badge> : null}
                </FieldTitle>
                <FieldDescription>{option.description}</FieldDescription>
              </FieldContent>
            </Field>
          </FieldLabel>
        ))}
      </RadioGroup>
    </FieldSet>
  );
}
