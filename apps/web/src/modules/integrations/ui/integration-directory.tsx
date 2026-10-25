import { Add01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import * as motion from "motion/react-m";
import { getLocale } from "~/paraglide/runtime.js";
import { m } from "~/paraglide/messages.js";
import { useCallback, useState, type ReactNode } from "react";
import { cardSurfaceClassName } from "~/ui/card-surface.ts";
import { DialogContent } from "~/ui/primitives/dialog";
import { SearchInput } from "~/ui/search-input.tsx";
import { SegmentedControl, SegmentedControlItem } from "~/ui/segmented-control.tsx";
import { motionEase } from "~/ui/motion-presets.ts";
import { cn } from "~/ui/utils";
import type { IntegrationCategory } from "../manifest.ts";
import { findKnownMcpServer } from "../mcp/known-servers.ts";
import { searchable, type DirectoryEntry } from "./directory-entries.ts";

const CATEGORIES: ReadonlyArray<{ value: IntegrationCategory; label: () => string }> = [
  { value: "projects", label: m.integrations_category_projects },
  { value: "docs", label: m.integrations_category_docs },
  { value: "developer", label: m.integrations_category_developer },
  { value: "productivity", label: m.integrations_category_productivity },
];

const tileClassName = cn(
  cardSurfaceClassName,
  "hover:bg-accent/50 focus-visible:ring-ring/30 flex items-start gap-3 p-3 text-left transition-colors outline-none focus-visible:ring-[3px]",
);

function Tile({
  logo,
  name,
  description,
  dashed = false,
  onClick,
}: {
  logo: ReactNode;
  name: string;
  description: string;
  dashed?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={cn(tileClassName, dashed && "border-dashed")}
      onClick={onClick}
    >
      <span className="bg-muted flex size-9 shrink-0 items-center justify-center rounded-2xl">
        {logo}
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="font-medium">{name}</span>
        <span className="text-muted-foreground line-clamp-2 text-xs">{description}</span>
      </span>
    </button>
  );
}

/**
 * A grid of services, with search and categories once it is long enough to
 * need them. Picking one hands it back; the way in by address comes last.
 */
export function IntegrationDirectory({
  entries,
  custom,
  onPick,
}: {
  entries: ReadonlyArray<DirectoryEntry>;
  /** Any server by its address; null when this person may not add one. */
  custom: { label: string; onPick: () => void } | null;
  onPick: (entry: DirectoryEntry) => void;
}) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<IntegrationCategory | "all">("all");
  const needle = query.trim().toLowerCase();
  const shown = entries.filter(
    (entry) =>
      (category === "all" || entry.category === category) &&
      `${entry.name} ${entry.description(getLocale())}`.toLowerCase().includes(needle),
  );
  const categories = CATEGORIES.filter((option) =>
    entries.some((entry) => entry.category === option.value),
  );

  return (
    <div className="flex min-h-0 flex-col gap-3">
      {searchable(entries) ? (
        <>
          <SearchInput
            aria-label={m.integrations_directory_search()}
            placeholder={m.common_search()}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            autoFocus
          />
          <SegmentedControl
            aria-label={m.integrations_directory_category()}
            value={[category]}
            multiple={false}
            onValueChange={(value) => {
              if (value[0])
                setCategory(CATEGORIES.find((option) => option.value === value[0])?.value ?? "all");
            }}
          >
            <SegmentedControlItem value="all">
              {m.integrations_directory_all()}
            </SegmentedControlItem>
            {categories.map((option) => (
              <SegmentedControlItem key={option.value} value={option.value}>
                {option.label()}
              </SegmentedControlItem>
            ))}
          </SegmentedControl>
        </>
      ) : null}
      <div className="-mx-1 min-h-0 overflow-y-auto px-1 py-1">
        <div className="grid gap-2 sm:grid-cols-2">
          {shown.map((entry) => (
            <Tile
              key={entry.key}
              logo={<entry.logo className="size-4" />}
              name={entry.name}
              description={entry.description(getLocale())}
              onClick={() => onPick(entry)}
            />
          ))}
          {custom ? (
            <Tile
              logo={<HugeiconsIcon icon={Add01Icon} strokeWidth={2} className="size-4" />}
              name={custom.label}
              description={m.integrations_directory_custom_description()}
              dashed
              onClick={custom.onPick}
            />
          ) : null}
        </div>
        {shown.length === 0 ? (
          <p className="text-muted-foreground px-1 pt-3 text-sm">
            {m.integrations_directory_no_match()}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/** The picked service above its setup: logo, name, what it does, and what it needs first. */
export function DirectoryEntryHeader({ entry }: { entry: DirectoryEntry }) {
  const setup = findKnownMcpServer(entry.server)?.setup?.(window.location.origin)(getLocale());
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <span className="bg-muted flex size-11 shrink-0 items-center justify-center rounded-2xl">
          <entry.logo className="size-5" />
        </span>
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="font-medium">{entry.name}</span>
          <span className="text-muted-foreground text-xs">{entry.description(getLocale())}</span>
        </span>
      </div>
      {setup ? <p className="text-muted-foreground text-xs">{setup}</p> : null}
    </div>
  );
}

/**
 * The dialog around a directory and the step after it. Both keep one width,
 * so text never rewraps while it moves. The height eases to what the step
 * measures, in both directions: CSS cannot ease to a height the content sets.
 * A searchable directory keeps one height while it filters.
 */
export function DirectoryDialogContent({
  browsing = null,
  children,
}: {
  /** The directory shown, when this is the step that picks from it. */
  browsing?: ReadonlyArray<DirectoryEntry> | null;
  children: ReactNode;
}) {
  const [height, setHeight] = useState<number | "auto">("auto");
  // A callback ref, not an effect: the portal mounts the popup's contents after
  // this component, so an effect on mount would find no element to observe.
  const measure = useCallback((node: HTMLDivElement | null) => {
    // Absent in jsdom, where the height simply stays as drawn.
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setHeight(node.offsetHeight));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return (
    <DialogContent scrollable={false} className="sm:max-w-2xl">
      {/* Pulled out by the ring width, so focus rings at the edge are not clipped. */}
      <motion.div
        initial={false}
        animate={{ height }}
        transition={{ duration: 0.2, ease: motionEase }}
        className="-m-1 overflow-hidden"
      >
        <div
          ref={measure}
          className={cn(
            // The ring-width padding lives here, inside what is measured; on the
            // wrapper, whose height is set, it would come off the bottom.
            "grid gap-6 p-1",
            // The viewport less the popup's own padding and margin, so nothing is cut off.
            "max-h-[calc(var(--dialog-viewport-height,100dvh)-5rem)]",
            browsing ? "grid-rows-[auto_minmax(0,1fr)]" : "overflow-y-auto",
            browsing && searchable(browsing) && "h-[35rem]",
          )}
        >
          {children}
        </div>
      </motion.div>
    </DialogContent>
  );
}
