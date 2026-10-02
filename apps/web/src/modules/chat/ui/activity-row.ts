/**
 * The one-line summary row a transcript activity renders when it has nothing to
 * disclose (memory, skills, an empty checklist, a collapsed compaction). It sits
 * beside `disclosureTriggerClassName`, which is the same row with a hover
 * affordance, so keeping both in one place stops the two from drifting
 * apart, since a message shows them stacked.
 */
export const activityRowClassName =
  "text-muted-foreground flex max-w-full min-w-0 items-center gap-1.5 text-sm";

/**
 * The card an activity renders when it names a document or draft: icon, two
 * lines, optional chevron. Button cannot express it, owning one line at a fixed
 * height, and the surface must also work inert. It sits beside the row it
 * stacks with.
 */
export const activityCardClassName =
  "border-border bg-background mb-3 flex w-full max-w-sm items-center gap-3 rounded-2xl border px-3 py-3 text-left";

/** Mirrors what the outline button variant gave these cards before they stopped being buttons. */
export const activityCardInteractiveClassName =
  "hover:bg-muted hover:text-foreground focus-visible:border-ring focus-visible:ring-ring/30 aria-expanded:bg-muted aria-expanded:text-foreground dark:bg-transparent dark:hover:bg-input/30 transition-all outline-none focus-visible:ring-3";
