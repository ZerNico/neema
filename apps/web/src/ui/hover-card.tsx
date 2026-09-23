import type { ComponentProps } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/ui/primitives/tooltip";
import { cn } from "~/ui/utils";

/**
 * A preview shown on hover. Base UI's tooltip provides the behaviour, but its
 * popup is a small inverted label, so every call site that wanted a card was
 * rewriting the surface. That surface belongs here instead.
 */
export function HoverCardContent({ className, ...props }: ComponentProps<typeof TooltipContent>) {
  return (
    <TooltipContent
      showArrow={false}
      className={cn(
        "bg-popover text-popover-foreground block w-80 max-w-[calc(100vw-2rem)] rounded-2xl border p-3.5 shadow-md duration-100 motion-reduce:animate-none",
        className,
      )}
      {...props}
    />
  );
}

export { Tooltip as HoverCard, TooltipTrigger as HoverCardTrigger };
