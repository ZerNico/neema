/**
 * max-w-full and min-w-0: a trigger is shrink-to-fit, and a long label must
 * truncate inside the column rather than widen it.
 */
export const disclosureTriggerClassName =
  "text-muted-foreground hover:text-foreground flex max-w-full min-w-0 items-center gap-1.5 text-left text-sm transition-colors";

export const disclosureChevronMotionClassName =
  "transition-transform duration-200 ease-out motion-reduce:transition-none";

export const disclosureBodyRailClassName =
  "border-border text-muted-foreground mt-2 border-l-2 pl-3 text-sm";
