import { Alert02Icon, ArrowDown01Icon, Search01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import type { ReactNode } from "react";
import { disclosureChevronMotionClassName } from "~/ui/disclosure-classes.ts";
import { MotionSwap } from "~/ui/motion.tsx";
import { Badge } from "~/ui/primitives/badge";
import { cn } from "~/ui/utils";

/**
 * - `running`: the label shimmers.
 * - `waiting`: on the person, so it holds still.
 * - `failed`: the icon becomes a warning, never red text.
 */
export type ActivityStatus = "running" | "waiting" | "done" | "failed";

/**
 * What every tool row shows, whatever wraps it (a disclosure trigger, a plain
 * row, a button): its icon, a label that rolls when it changes, and an
 * optional detail after a dot. One face keeps the families from drifting apart
 * in icon size, motion, running state and how a failure reads.
 */
export function ActivityFace({
  icon,
  glyph,
  label,
  detail,
  status,
  title,
}: {
  icon?: IconSvgElement;
  /** Drawn instead of `icon`, such as a stack of site icons. */
  glyph?: ReactNode;
  label: string;
  detail?: string | null | undefined;
  status: ActivityStatus;
  /** The label in full, on hover, where it is a shortened path or name. */
  title?: string | undefined;
}) {
  const failed = status === "failed";
  // Thinking is no tool: it reads as words alone, with no empty icon slot.
  const mark = failed ? (
    <HugeiconsIcon icon={Alert02Icon} strokeWidth={2} className="text-warning size-4" aria-hidden />
  ) : (
    (glyph ??
    (icon ? <HugeiconsIcon icon={icon} strokeWidth={2} className="size-4" aria-hidden /> : null))
  );
  return (
    <>
      {mark ? (
        <MotionSwap value={failed ? "failed" : "ok"} kind="icon" className="shrink-0">
          {mark}
        </MotionSwap>
      ) : null}
      <MotionSwap value={label} kind="rolling-text" className="min-w-0">
        <span className={cn(status === "running" && "text-shimmer")} title={title}>
          {label}
        </span>
      </MotionSwap>
      {detail ? (
        // Reads exactly like a dot written into a label ("Searched the web · 3
        // sources"): same colour, and about a space either side of the dot.
        <span className="-ml-0.5 flex min-w-0 items-center gap-1">
          <span className="shrink-0">·</span>
          <MotionSwap value={detail} kind="rolling-text" className="min-w-0">
            {detail}
          </MotionSwap>
        </span>
      ) : null}
    </>
  );
}

export function ActivityChevron({ open }: { open: boolean }) {
  return (
    <HugeiconsIcon
      icon={ArrowDown01Icon}
      strokeWidth={2}
      className={cn(disclosureChevronMotionClassName, "size-3.5 shrink-0", open && "rotate-180")}
      aria-hidden
    />
  );
}

/** A line inside a row's body that something went wrong, worded for the reader. */
export function ActivityNote({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-start gap-1.5 text-xs">
      <HugeiconsIcon
        icon={Alert02Icon}
        strokeWidth={2}
        className="text-warning mt-px size-3.5 shrink-0"
        aria-hidden
      />
      <span className="min-w-0 [overflow-wrap:anywhere]">{children}</span>
    </p>
  );
}

/** What a row searched for, as chips: the first few, then how many more. */
export function ActivityQueries({
  queries,
  limit = 4,
  label = "Searches",
}: {
  queries: ReadonlyArray<string>;
  limit?: number;
  label?: string;
}) {
  if (queries.length === 0) return null;
  const hidden = queries.length - limit;
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label={label}>
      {queries.slice(0, limit).map((query) => (
        <li key={query} className="max-w-full">
          <Badge variant="secondary" className="max-w-full">
            <HugeiconsIcon icon={Search01Icon} strokeWidth={2} data-icon="inline-start" />
            <span className="truncate">{query}</span>
          </Badge>
        </li>
      ))}
      {hidden > 0 ? (
        <li>
          <Badge variant="outline">+{hidden} more</Badge>
        </li>
      ) : null}
    </ul>
  );
}
