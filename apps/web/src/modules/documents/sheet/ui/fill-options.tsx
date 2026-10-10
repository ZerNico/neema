import { MagicWand01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "~/ui/primitives/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "~/ui/primitives/dropdown-menu";

/** Excel's Auto Fill Options, each a way to redo the fill just made. */
const FILL_CHOICES = [
  { value: "series", label: "Fill series" },
  { value: "copy", label: "Copy cells" },
  { value: "formats", label: "Fill formatting only" },
  { value: "values", label: "Fill without formatting" },
] as const;
export type FillChoice = (typeof FILL_CHOICES)[number]["value"];

/** The button beside a fill that redoes it another way. */
export function FillOptions({
  chosen,
  onChoose,
}: {
  chosen: FillChoice | null;
  onChoose: (choice: FillChoice) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button size="icon-xs" variant="outline" aria-label="Auto fill options" />}
      >
        <HugeiconsIcon icon={MagicWand01Icon} strokeWidth={2} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-52">
        <DropdownMenuRadioGroup
          value={chosen ?? ""}
          onValueChange={(value) => {
            const choice = FILL_CHOICES.find((each) => each.value === value);
            if (choice) onChoose(choice.value);
          }}
        >
          {FILL_CHOICES.map((choice) => (
            <DropdownMenuRadioItem key={choice.value} value={choice.value}>
              {choice.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
