import { ComputerIcon, Moon02Icon, Sun03Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { IconSvgElement } from "@hugeicons/react";
import { type Theme, setTheme, useTheme } from "./theme.tsx";
import { cn } from "./utils";

const OPTIONS: Array<{ value: Theme; label: string; icon: IconSvgElement }> = [
  { value: "light", label: "Light", icon: Sun03Icon },
  { value: "system", label: "System", icon: ComputerIcon },
  { value: "dark", label: "Dark", icon: Moon02Icon },
];

// Three-way segmented theme control (light / system / dark).
export function ThemeSwitch({ className }: { className?: string }) {
  const theme = useTheme();

  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      className={cn("bg-muted flex items-center gap-0.5 rounded-full p-0.5", className)}
    >
      {OPTIONS.map((option) => {
        const active = option.value === theme;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={option.label}
            title={option.label}
            onClick={() => setTheme(option.value)}
            className={cn(
              "flex h-7 min-w-7 flex-1 items-center justify-center rounded-full transition-colors",
              active
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <HugeiconsIcon icon={option.icon} className="size-4" />
          </button>
        );
      })}
    </div>
  );
}
