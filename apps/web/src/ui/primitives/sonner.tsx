import {
  Alert02Icon,
  CheckmarkCircle02Icon,
  InformationCircleIcon,
  MultiplicationSignCircleIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Toaster as Sonner, type ToasterProps } from "sonner";

import { Spinner } from "~/ui/primitives/spinner";
import { useTheme } from "~/ui/theme.tsx";

// shadcn's generated Toaster reads the theme from next-themes; this app owns
// its theme store (src/ui/theme.tsx), so the hook is swapped and next-themes
// is not a dependency.
const Toaster = ({ ...props }: ToasterProps) => {
  const theme = useTheme();

  return (
    <Sonner
      theme={theme}
      className="toaster group"
      icons={{
        success: <HugeiconsIcon icon={CheckmarkCircle02Icon} strokeWidth={2} className="size-4" />,
        info: <HugeiconsIcon icon={InformationCircleIcon} strokeWidth={2} className="size-4" />,
        warning: <HugeiconsIcon icon={Alert02Icon} strokeWidth={2} className="size-4" />,
        error: (
          <HugeiconsIcon icon={MultiplicationSignCircleIcon} strokeWidth={2} className="size-4" />
        ),
        loading: <Spinner aria-hidden />,
      }}
      toastOptions={{
        classNames: {
          // Sonner's own button is a small square chip; ours is the secondary pill. Its
          // stylesheet selects by three attributes, so each override needs `!` to win.
          actionButton:
            "h-7! rounded-4xl! px-3! text-xs! bg-secondary! text-secondary-foreground! hover:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)]! focus-visible:ring-3! focus-visible:ring-ring/30! transition-colors",
        },
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "1rem",
        } as React.CSSProperties
      }
      {...props}
    />
  );
};

export { Toaster };
