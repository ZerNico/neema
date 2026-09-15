import { CodeIcon, EyeIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/ui/primitives/tooltip";
import { ToggleGroup, ToggleGroupItem } from "~/ui/primitives/toggle-group";
import { cn } from "~/ui/utils";

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
    <ToggleGroup
      aria-label="View"
      value={[preview ? "preview" : "source"]}
      multiple={false}
      onValueChange={(value) => {
        if (value[0]) onChange(value[0] === "preview");
      }}
      spacing={0}
      className="bg-muted relative rounded-full p-0.5"
    >
      <span
        aria-hidden
        className={cn(
          "bg-background pointer-events-none absolute top-0.5 left-0.5 size-7 rounded-full shadow-sm",
          "transition-transform duration-200 ease-out motion-reduce:transition-none",
          preview && "translate-x-7",
        )}
      />
      {options.map((option) => (
        <Tooltip key={option.value}>
          <TooltipTrigger
            render={
              <ToggleGroupItem
                value={option.value}
                aria-label={option.label}
                className={cn(
                  "relative z-10 size-7 min-w-0 rounded-full bg-transparent px-0 transition-colors",
                  "text-muted-foreground hover:bg-transparent aria-pressed:bg-transparent",
                  "aria-pressed:text-foreground hover:text-foreground",
                )}
              />
            }
          >
            <HugeiconsIcon icon={option.icon} strokeWidth={2} className="size-4" />
          </TooltipTrigger>
          <TooltipContent>{option.label}</TooltipContent>
        </Tooltip>
      ))}
    </ToggleGroup>
  );
}
