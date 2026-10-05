import type { ComponentProps } from "react";
import { CollapsibleContent } from "~/ui/primitives/collapsible";
import { cn } from "~/ui/utils";

export {
  Collapsible as Disclosure,
  CollapsibleTrigger as DisclosureTrigger,
} from "~/ui/primitives/collapsible";

const contentClassName =
  "h-[var(--collapsible-panel-height)] overflow-hidden opacity-100 transition-[height,opacity] duration-200 ease-out data-ending-style:h-0 data-ending-style:opacity-0 data-starting-style:h-0 data-starting-style:opacity-0 motion-reduce:transition-none [&[hidden]:not([hidden='until-found'])]:hidden";

/**
 * Presentation only: Base UI and the caller retain ownership of state, refs,
 * render props, and mounting behavior, including state-dependent class names.
 */
export function DisclosureContent({
  className,
  ...props
}: ComponentProps<typeof CollapsibleContent>) {
  return (
    <CollapsibleContent
      {...props}
      className={
        typeof className === "function"
          ? (state) => cn(contentClassName, className(state))
          : cn(contentClassName, className)
      }
    />
  );
}
