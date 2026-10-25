import { m } from "~/paraglide/messages.js";
import { ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { useDraftPanel } from "~/modules/drafts/ui/draft-panel-context.ts";
import type { DraftKind } from "~/modules/drafts/draft-schema.ts";
import { m } from "~/paraglide/messages.js";
import { Button } from "~/ui/primitives/button";
import { cn } from "~/ui/utils";
import { activityCardClassName, activityCardInteractiveClassName } from "./activity-row.ts";

/**
 * The transcript card for a draft reference; also the inline recovery entry
 * if a retry removed the original tool row. A branch keeps the originating
 * reference: its draft belongs to the other conversation, so it is absent
 * from this owner and stays inert.
 */
export function DraftWidget({
  kind,
  draftId,
  icon,
  title,
  openLabel,
}: {
  kind: DraftKind;
  draftId: string;
  icon: IconSvgElement;
  /** "Agent draft". */
  title: string;
  /** The button's accessible name for a draft of that name. */
  openLabel: (name: string) => string;
}) {
  const { owned, entry } = useDraftPanel(kind, draftId);
  const contents = (
    <>
      <HugeiconsIcon icon={icon} strokeWidth={2} className="size-4 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1 text-left">
        <span className="block text-sm font-medium">{title}</span>
        <span className="text-muted-foreground block truncate text-xs">
          {entry
            ? [entry.name, entry.status].filter(Boolean).join(" · ")
            : owned
              ? m.drafts_widget_loading()
              : m.drafts_widget_other_chat()}
        </span>
      </span>
      {entry?.open ? (
        <HugeiconsIcon
          icon={ArrowRight01Icon}
          strokeWidth={2}
          className="size-4 shrink-0"
          aria-hidden
        />
      ) : null}
    </>
  );
  if (entry?.open)
    return (
      <button
        type="button"
        className={cn(activityCardClassName, activityCardInteractiveClassName)}
        aria-label={openLabel(entry.name ?? "")}
        aria-expanded={entry.expanded}
        onClick={entry.open}
      >
        {contents}
      </button>
    );
  return (
    <div className={activityCardClassName}>
      {contents}
      {entry?.retry ? (
        <Button size="sm" variant="ghost" onClick={entry.retry}>
          {m.drafts_widget_retry()}
        </Button>
      ) : null}
    </div>
  );
}
