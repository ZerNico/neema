import { Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { cn } from "~/ui/utils";

/** How long a Save button says "Saved". */
const SAVED_FOR_MS = 3000;

/** Pairs `SaveLabel` and `SaveStatus`: call `markSaved` when a save lands. */
export function useSaveStatus() {
  const [justSaved, setJustSaved] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const markSaved = useCallback(() => {
    clearTimeout(timer.current);
    setJustSaved(true);
    timer.current = setTimeout(() => setJustSaved(false), SAVED_FOR_MS);
  }, []);
  return { justSaved, markSaved };
}

/**
 * A Save button's label that turns into "✓ Saved" for a moment after a save.
 * Both labels share one grid cell, so the button is always as wide as the
 * longer one and nothing beside it moves when it switches. An enabled Save
 * button already says there are unsaved changes, so there is no separate hint.
 */
export function SaveLabel({
  justSaved,
  savedLabel = "Saved",
  children,
}: {
  justSaved: boolean;
  savedLabel?: string;
  children: ReactNode;
}) {
  return (
    <span className="grid">
      <span
        aria-hidden={justSaved || undefined}
        className={cn(
          "col-start-1 row-start-1 text-center transition-opacity",
          justSaved && "opacity-0",
        )}
      >
        {children}
      </span>
      <span
        aria-hidden={!justSaved || undefined}
        className={cn(
          "col-start-1 row-start-1 inline-flex items-center justify-center gap-[inherit] transition-opacity",
          !justSaved && "opacity-0",
        )}
      >
        <HugeiconsIcon icon={Tick02Icon} strokeWidth={2} />
        {savedLabel}
      </span>
    </span>
  );
}

/**
 * Says "Saved" to screen readers. A live region inside a button is ignored,
 * so this sits beside it; it takes no space.
 */
export function SaveStatus({
  justSaved,
  savedLabel = "Saved",
}: {
  justSaved: boolean;
  savedLabel?: string;
}) {
  return (
    <span data-slot="save-status" role="status" aria-live="polite" className="sr-only">
      {justSaved ? savedLabel : null}
    </span>
  );
}
