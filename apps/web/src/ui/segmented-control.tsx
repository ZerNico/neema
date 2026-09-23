import type { ComponentProps } from "react";
import { ToggleGroup, ToggleGroupItem } from "~/ui/primitives/toggle-group";
import { cn } from "~/ui/utils";

/**
 * The pill form of a toggle group: a muted track holding rounded segments. The
 * primitive's own shape is a joined bar with square inner corners, so each place
 * that wanted the pill was restating the track from scratch.
 */
export function SegmentedControl({
  className,
  size = "sm",
  spacing = 0.5,
  ...props
}: ComponentProps<typeof ToggleGroup>) {
  return (
    <ToggleGroup
      size={size}
      spacing={spacing}
      className={cn("bg-muted rounded-full p-0.5", className)}
      {...props}
    />
  );
}

/**
 * A segment. The primitive presses to `bg-muted`, the track's own colour, so the chosen
 * segment is raised onto the background instead. Icon-only segments size themselves and pass `px-0`.
 */
export function SegmentedControlItem({
  className,
  ...props
}: ComponentProps<typeof ToggleGroupItem>) {
  return (
    <ToggleGroupItem
      className={cn(
        "text-muted-foreground hover:text-foreground h-7 rounded-full px-2.5 text-xs hover:bg-transparent",
        "aria-pressed:bg-background aria-pressed:text-foreground aria-pressed:shadow-sm",
        className,
      )}
      {...props}
    />
  );
}
