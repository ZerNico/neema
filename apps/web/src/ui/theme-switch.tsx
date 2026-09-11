import { ComputerIcon, Moon02Icon, Sun03Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { IconSvgElement } from "@hugeicons/react";
import { ToggleGroup, ToggleGroupItem } from "~/ui/primitives/toggle-group";
import { type Theme, setTheme, useTheme } from "./theme.tsx";
import { cn } from "./utils";

const OPTIONS: Array<{ value: Theme; label: string; icon: IconSvgElement }> = [
  { value: "light", label: "Light", icon: Sun03Icon },
  { value: "system", label: "System", icon: ComputerIcon },
  { value: "dark", label: "Dark", icon: Moon02Icon },
];

// Three-way segmented theme control (light / system / dark). Base UI's toggle
// group supplies arrow-key navigation and the focus ring; single-select so one
// option is always pressed.
export function ThemeSwitch({ className }: { className?: string }) {
  const theme = useTheme();

  return (
    <ToggleGroup
      aria-label="Theme"
      value={[theme]}
      multiple={false}
      onValueChange={(value) => {
        // Pressing the active item again yields [] — keep the current theme.
        const next = OPTIONS.find((option) => option.value === value[0]);
        if (next) setTheme(next.value);
      }}
      size="sm"
      spacing={0.5}
      className={cn("bg-muted rounded-full p-0.5", className)}
    >
      {OPTIONS.map((option) => (
        <ToggleGroupItem
          key={option.value}
          value={option.value}
          aria-label={option.label}
          title={option.label}
          className="text-muted-foreground hover:text-foreground h-7 min-w-7 flex-1 rounded-full px-0 hover:bg-transparent aria-pressed:bg-background aria-pressed:text-foreground aria-pressed:shadow-sm"
        >
          <HugeiconsIcon icon={option.icon} strokeWidth={2} />
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
