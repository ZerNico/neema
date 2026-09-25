import { useLayoutEffect, useRef, useState } from "react";
import type { ComponentProps } from "react";
import { ToggleGroup, ToggleGroupItem } from "~/ui/primitives/toggle-group";
import { cn } from "~/ui/utils";

type Indicator = { x: number; y: number; width: number; height: number; moved: boolean };

// Follows the pressed segment rather than the value prop, so controlled and
// uncontrolled groups both slide. Segments differ in width, hence measuring.
function usePressedIndicator() {
  const ref = useRef<HTMLDivElement>(null);
  const [indicator, setIndicator] = useState<Indicator | null>(null);

  useLayoutEffect(() => {
    const group = ref.current;
    if (!group) return;
    const measure = () => {
      const pressed = group.querySelector<HTMLElement>(':scope > [aria-pressed="true"]');
      if (!pressed || pressed.offsetWidth === 0) return setIndicator(null);
      const next = {
        x: pressed.offsetLeft,
        y: pressed.offsetTop,
        width: pressed.offsetWidth,
        height: pressed.offsetHeight,
      };
      // The first placement lands without a transition; sliding in from the
      // track's corner on mount would read as a glitch.
      setIndicator((current) => ({ ...next, moved: current !== null }));
    };
    measure();
    const mutations = new MutationObserver(measure);
    mutations.observe(group, { subtree: true, attributeFilter: ["aria-pressed"] });
    // Absent in jsdom; the pressed segment then keeps its own background.
    const resizes = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    resizes?.observe(group);
    return () => {
      mutations.disconnect();
      resizes?.disconnect();
    };
  }, []);

  return { ref, indicator };
}

/**
 * The pill form of a toggle group: a muted track holding rounded segments. The
 * primitive's own shape is a joined bar with square inner corners, so each place
 * that wanted the pill was restating the track from scratch.
 */
export function SegmentedControl({
  className,
  size = "sm",
  spacing = 0.5,
  children,
  ...props
}: ComponentProps<typeof ToggleGroup>) {
  const { ref, indicator } = usePressedIndicator();
  return (
    <ToggleGroup
      ref={ref}
      size={size}
      spacing={spacing}
      data-indicator={indicator ? "" : undefined}
      // Colours ease over the theme crossfade's 250ms, so a control kept live
      // through it (view-transition-live) fades with the page instead of popping.
      className={cn(
        "bg-muted relative rounded-full p-0.5 transition-colors duration-250 motion-reduce:transition-none",
        className,
      )}
      {...props}
    >
      {indicator ? (
        <span
          aria-hidden
          className={cn(
            "bg-background pointer-events-none absolute top-0 left-0 rounded-full shadow-sm",
            "ease-out motion-reduce:transition-none",
            // The first placement lands without sliding; colours always ease.
            indicator.moved
              ? "transition-[translate,width,background-color,box-shadow] [transition-duration:200ms,200ms,250ms,250ms]"
              : "transition-[background-color,box-shadow] duration-250",
          )}
          style={{
            translate: `${indicator.x}px ${indicator.y}px`,
            width: indicator.width,
            height: indicator.height,
          }}
        />
      ) : null}
      {children}
    </ToggleGroup>
  );
}

/**
 * A segment. The primitive presses to `bg-muted`, the track's own colour, so the chosen
 * segment is raised onto the background instead: by the group's sliding indicator once
 * measured, by the segment itself before that. Icon-only segments size themselves and pass `px-0`.
 */
export function SegmentedControlItem({
  className,
  ...props
}: ComponentProps<typeof ToggleGroupItem>) {
  return (
    <ToggleGroupItem
      className={cn(
        "text-muted-foreground hover:text-foreground relative h-7 rounded-full px-2.5 text-xs transition-colors hover:bg-transparent",
        "aria-pressed:bg-background aria-pressed:text-foreground aria-pressed:shadow-sm",
        "group-data-indicator/toggle-group:aria-pressed:bg-transparent group-data-indicator/toggle-group:aria-pressed:shadow-none",
        className,
      )}
      {...props}
    />
  );
}
