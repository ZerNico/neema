import { CodeIcon, EyeIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/ui/primitives/tooltip";
import { SegmentedControl, SegmentedControlItem } from "~/ui/segmented-control.tsx";

export function ViewToggle({
  preview,
  sourceLabel,
  onChange,
}: {
  preview: boolean;
  sourceLabel: string;
  onChange: (preview: boolean) => void;
}) {
  const options = [
    { value: "source", icon: CodeIcon, label: sourceLabel },
    { value: "preview", icon: EyeIcon, label: "Preview" },
  ] as const;
  return (
    <SegmentedControl
      aria-label="View"
      value={[preview ? "preview" : "source"]}
      multiple={false}
      onValueChange={(value) => {
        if (value[0]) onChange(value[0] === "preview");
      }}
      spacing={0}
    >
      {options.map((option) => (
        <Tooltip key={option.value}>
          <TooltipTrigger
            render={
              <SegmentedControlItem
                value={option.value}
                aria-label={option.label}
                className="size-7 min-w-0 px-0"
              />
            }
          >
            <HugeiconsIcon icon={option.icon} strokeWidth={2} className="size-4" />
          </TooltipTrigger>
          <TooltipContent>{option.label}</TooltipContent>
        </Tooltip>
      ))}
    </SegmentedControl>
  );
}
