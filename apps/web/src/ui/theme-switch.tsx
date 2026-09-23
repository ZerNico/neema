import { ComputerIcon, Moon02Icon, Sun03Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { IconSvgElement } from "@hugeicons/react";
import { SegmentedControl, SegmentedControlItem } from "~/ui/segmented-control.tsx";
import { type Theme, setTheme, useTheme } from "./theme.tsx";

const OPTIONS: Array<{ value: Theme; label: string; icon: IconSvgElement }> = [
  { value: "light", label: "Light", icon: Sun03Icon },
  { value: "system", label: "System", icon: ComputerIcon },
  { value: "dark", label: "Dark", icon: Moon02Icon },
];

/**
 * Three-way segmented theme control (light / system / dark). Base UI's toggle
 * group supplies arrow-key navigation and the focus ring; single-select so one
 * option is always pressed.
 */
export function ThemeSwitch({ className }: { className?: string }) {
  const theme = useTheme();

  return (
    <SegmentedControl
      aria-label="Theme"
      value={[theme]}
      multiple={false}
      onValueChange={(value) => {
        // Pressing the active item again yields [], so keep the current theme.
        const next = OPTIONS.find((option) => option.value === value[0]);
        if (next) setTheme(next.value);
      }}
      className={className}
    >
      {OPTIONS.map((option) => (
        <SegmentedControlItem
          key={option.value}
          value={option.value}
          aria-label={option.label}
          title={option.label}
          className="min-w-7 flex-1 px-0"
        >
          <HugeiconsIcon icon={option.icon} strokeWidth={2} />
        </SegmentedControlItem>
      ))}
    </SegmentedControl>
  );
}
